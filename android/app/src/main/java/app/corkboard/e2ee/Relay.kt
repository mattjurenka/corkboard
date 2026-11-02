package app.corkboard.e2ee

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

// The relay's API as a client calls it (lib/e2ee/relay.ts; the Worker's
// cloud/src/e2ee.ts serves it):
//
//   POST /e2ee/challenge          { account, device }: { nonce, expires }
//   POST /e2ee/token              { cert, answer }: { token, expires }
//   POST /e2ee/revoke             { revocation }; GET /e2ee/revoked
//   /e2ee/pair...                 pairing mailboxes (Pairing.kt)
//   POST /e2ee/log/:object        { ops }: { ops: [{ id, pos }] }; 409 { epoch }: another key
//   GET  /e2ee/log/:object        ?since=&limit=: { ops, head, epoch, count, bytes, snapshot? }
//   GET  /e2ee/log/:object/live   WebSocket, ?since=: { ops, snapshot? } messages, catch-up first
//   POST /e2ee/log/:object/snapshot, DELETE /e2ee/log/:object   the owner's
//   ?owner=<account>              on a log route: a log shared with this account
//   PUT/GET /e2ee/blob/:id        an encrypted attachment
//   GET  /e2ee/accounts/:id       an account's keys and their proof
//   POST /e2ee/grants, DELETE /e2ee/grants/:object/:member, GET /e2ee/grants?object=
//   GET  /e2ee/shared             every grant to this account, with its sealed key
//   POST /e2ee/rotate, POST /e2ee/rotated
//
// Everything but challenges, revocations, rotated and the new device's side
// of pairing wants a token from /e2ee/token, as a bearer. A token that's
// expired or refused is got again, once, from the device's keys.

@Serializable
data class Token(val token: String, val expires: Long)

class RelayError(val status: Int, message: String, val body: JsonObject? = null) : Exception(message)

// A grant to this account, with the box that carries the key.
class SharedGrant(val grant: Signed<Grant>, val sealed: String)

class Rotated(val rotations: List<Signed<Rotation>>, val cert: Signed<DeviceCert>, val root: String)

class Relay(
    origin: String,
    private val device: Device? = null,
    var cert: Signed<DeviceCert>? = null,
    private var current: Token? = null,
    private val onToken: (Token) -> Unit = {},
    private val http: OkHttpClient = defaultHttp,
) : PairTransport, LogTransport {
    val origin = origin.trimEnd('/')
    val account get() = cert?.body?.account

    companion object {
        val defaultHttp: OkHttpClient = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).build()
        private val JSON_TYPE = "application/json".toMediaType()
        private val BYTES_TYPE = "application/octet-stream".toMediaType()
    }

    private fun send(method: String, path: String, body: JsonElement?, bearer: String?): JsonElement {
        val req = Request.Builder().url("$origin$path")
            .method(method, body?.let { it.toString().toRequestBody(JSON_TYPE) } ?: if (method == "POST") "{}".toRequestBody(JSON_TYPE) else null)
        if (bearer != null) req.header("Authorization", "Bearer $bearer")
        http.newCall(req.build()).execute().use { res ->
            val text = res.body?.string() ?: ""
            val parsed = runCatching { wireJson.parseToJsonElement(text) }.getOrNull() ?: JsonNull
            if (!res.isSuccessful) {
                val o = parsed as? JsonObject
                val error = (o?.get("error") as? JsonPrimitive)?.content ?: res.code.toString()
                throw RelayError(res.code, "$method ${path.substringBefore('?')}: $error", o)
            }
            return parsed
        }
    }

    private suspend fun call(method: String, path: String, body: JsonElement? = null, bearer: String? = null): JsonElement =
        withContext(Dispatchers.IO) { send(method, path, body, bearer) }

    private val signingIn = Mutex()

    suspend fun token(fresh: Boolean = false): String = signingIn.withLock {
        val t = current
        if (!fresh && t != null && t.expires - 60_000 > System.currentTimeMillis()) return t.token
        signInLocked().token
    }

    suspend fun signIn(): Token = signingIn.withLock { signInLocked() }

    private suspend fun signInLocked(): Token {
        val d = device ?: throw IllegalStateException("this relay client has no device to sign in with")
        val c = cert ?: throw IllegalStateException("this relay client has no certificate to sign in with")
        val nonce = call("POST", "/e2ee/challenge", obj("account" to c.body.account, "device" to d.id)).jsonObject.str("nonce")
        val a = answer(d, origin, nonce, c.body.account)
        val t = wireJson.decodeFromJsonElement<Token>(call("POST", "/e2ee/token", JsonObject(mapOf("cert" to c.toJson(), "answer" to a.toJson()))))
        current = t
        onToken(t)
        return t
    }

    private suspend fun authed(method: String, path: String, body: JsonElement? = null): JsonElement = try {
        call(method, path, body, token())
    } catch (e: RelayError) {
        if (e.status != 401 || device == null) throw e
        call(method, path, body, token(fresh = true))
    }

    private fun obj(vararg kv: Pair<String, String>) = JsonObject(kv.associate { (k, v) -> k to JsonPrimitive(v) })

    // Accounts ---------------------------------------------------------------------

    suspend fun revoke(r: Signed<Revocation>) {
        call("POST", "/e2ee/revoke", JsonObject(mapOf("revocation" to r.toJson())))
    }

    suspend fun revoked(): List<Signed<Revocation>> =
        authed("GET", "/e2ee/revoked").jsonArray.map { e -> Signed.parse(e) { Revocation.from(it) } }

    suspend fun accountView(id: String): AccountView = AccountView.from(authed("GET", "/e2ee/accounts/$id").jsonObject)

    // Pairing ----------------------------------------------------------------------

    override suspend fun create(): NewPairing = wireJson.decodeFromJsonElement(call("POST", "/e2ee/pair"))

    override suspend fun view(code: String, secret: String?): MailboxView = wireJson.decodeFromJsonElement(
        if (secret != null) call("POST", "/e2ee/pair/$code", obj("secret" to secret)) else authed("GET", "/e2ee/pair/$code"),
    )

    override suspend fun commit(code: String, commit: String) {
        authed("POST", "/e2ee/pair/$code/commit", obj("commit" to commit))
    }

    override suspend fun join(code: String, secret: String, j: Join) {
        call("POST", "/e2ee/pair/$code/join", obj("secret" to secret, "box" to j.box, "device" to j.device, "name" to j.name))
    }

    override suspend fun reveal(code: String, approver: String) {
        authed("POST", "/e2ee/pair/$code/reveal", obj("approver" to approver))
    }

    override suspend fun deliver(code: String, d: Delivery) {
        authed("POST", "/e2ee/pair/$code/deliver", wireJson.encodeToJsonElement(d))
    }

    override suspend fun cancel(code: String, secret: String?) {
        if (secret != null) call("POST", "/e2ee/pair/$code/cancel", obj("secret" to secret))
        else authed("POST", "/e2ee/pair/$code/cancel", JsonObject(emptyMap()))
    }

    // Logs -------------------------------------------------------------------------

    private fun ownerQuery(owner: String?, first: Boolean) = owner?.let { (if (first) "?" else "&") + "owner=$it" } ?: ""

    suspend fun append(obj: String, ops: List<NewOp>, owner: String?): List<Ack> {
        val body = JsonObject(mapOf("ops" to wireJson.encodeToJsonElement(ListSerializer(NewOp.serializer()), ops)))
        val res = try {
            authed("POST", "/e2ee/log/$obj${ownerQuery(owner, true)}", body)
        } catch (e: RelayError) {
            val epoch = (e.body?.get("epoch") as? JsonPrimitive)?.content?.toIntOrNull()
            if (e.status == 409 && epoch != null) throw EpochChanged(epoch)
            throw e
        }
        return wireJson.decodeFromJsonElement(ListSerializer(Ack.serializer()), res.jsonObject["ops"]!!)
    }

    suspend fun read(obj: String, since: Long, limit: Int?, owner: String?): LogRead =
        wireJson.decodeFromJsonElement(authed("GET", "/e2ee/log/$obj?since=$since${limit?.let { "&limit=$it" } ?: ""}${ownerQuery(owner, false)}"))

    override suspend fun append(obj: String, ops: List<NewOp>) = append(obj, ops, null)
    override suspend fun read(obj: String, since: Long, limit: Int?) = read(obj, since, limit, null)

    override suspend fun snapshot(obj: String, s: Snapshot) {
        authed("POST", "/e2ee/log/$obj/snapshot", wireJson.encodeToJsonElement(s))
    }

    suspend fun deleteLog(obj: String) {
        authed("DELETE", "/e2ee/log/$obj")
    }

    private val sockets = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // Reconnects after a drop, from the last op it saw, until stopped.
    fun subscribe(obj: String, since: Long, owner: String?, on: (List<WireOp>, Snapshot?) -> Unit): () -> Unit {
        var stopped = false
        var ws: WebSocket? = null
        var cursor = since
        val job = sockets.launch {
            while (!stopped) {
                val t = runCatching { token() }.getOrNull()
                if (t == null) {
                    delay(5_000)
                    continue
                }
                val closed = kotlinx.coroutines.CompletableDeferred<Unit>()
                val url = "${origin.replaceFirst(Regex("^http"), "ws")}/e2ee/log/$obj/live?since=$cursor${ownerQuery(owner, false)}"
                val req = Request.Builder().url(url).header("Authorization", "Bearer $t").header("Sec-WebSocket-Protocol", "corkboard").build()
                ws = http.newWebSocket(
                    req,
                    object : WebSocketListener() {
                        override fun onMessage(webSocket: WebSocket, text: String) {
                            val m = runCatching { wireJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
                            val ops = (m["ops"] as? JsonArray)?.let { wireJson.decodeFromJsonElement(ListSerializer(WireOp.serializer()), it) }.orEmpty()
                            val snap = m["snapshot"]?.let { runCatching { wireJson.decodeFromJsonElement(Snapshot.serializer(), it) }.getOrNull() }
                            if (ops.isEmpty() && snap == null) return
                            cursor = maxOf(cursor, snap?.upTo ?: 0, ops.maxOfOrNull { it.pos } ?: 0)
                            on(ops, snap)
                        }
                        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                            closed.complete(Unit)
                        }
                        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                            closed.complete(Unit)
                        }
                    },
                )
                closed.await()
                if (!stopped) delay(2_000)
            }
        }
        return {
            stopped = true
            ws?.close(1000, null)
            job.cancel()
        }
    }

    override fun subscribe(obj: String, since: Long, on: (List<WireOp>, Snapshot?) -> Unit): (() -> Unit) = subscribe(obj, since, null, on)

    // A log of another account's that it shares with this one.
    fun shared(owner: String): LogTransport = object : LogTransport {
        override suspend fun append(obj: String, ops: List<NewOp>) = this@Relay.append(obj, ops, owner)
        override suspend fun read(obj: String, since: Long, limit: Int?) = this@Relay.read(obj, since, limit, owner)
        override fun subscribe(obj: String, since: Long, on: (List<WireOp>, Snapshot?) -> Unit) = this@Relay.subscribe(obj, since, owner, on)
    }

    // Blobs ------------------------------------------------------------------------

    suspend fun putBlob(id: String, bytes: ByteArray) {
        suspend fun go(fresh: Boolean) = withContext(Dispatchers.IO) {
            val req = Request.Builder().url("$origin/e2ee/blob/$id").header("Authorization", "Bearer ${token(fresh)}").put(bytes.toRequestBody(BYTES_TYPE)).build()
            http.newCall(req).execute().use { it.code to (it.body?.string() ?: "") }
        }
        var (code, text) = go(false)
        if (code == 401 && device != null) go(true).let { code = it.first; text = it.second }
        if (code !in 200..299) throw RelayError(code, "PUT blob: ${runCatching { wireJson.parseToJsonElement(text).jsonObject.str("error") }.getOrDefault(code.toString())}")
    }

    suspend fun getBlob(id: String): ByteArray {
        val t = token()
        return withContext(Dispatchers.IO) {
            http.newCall(Request.Builder().url("$origin/e2ee/blob/$id").header("Authorization", "Bearer $t").build()).execute().use { res ->
                if (!res.isSuccessful) throw RelayError(res.code, "GET blob: ${res.code}")
                res.body!!.bytes()
            }
        }
    }

    // Sharing ----------------------------------------------------------------------

    suspend fun grant(g: Signed<Grant>, sealed: String) {
        authed("POST", "/e2ee/grants", JsonObject(mapOf("grant" to g.toJson(), "sealed" to JsonPrimitive(sealed))))
    }

    suspend fun ungrant(obj: String, member: String) {
        authed("DELETE", "/e2ee/grants/$obj/$member")
    }

    private fun sharedGrants(e: JsonElement): List<SharedGrant> {
        val list = (e as? JsonArray) ?: (e.jsonObject["grants"] ?: e.jsonObject["shared"])?.jsonArray ?: JsonArray(emptyList())
        return list.mapNotNull { x ->
            runCatching {
                val o = x.jsonObject
                SharedGrant(Signed.parse(o["grant"]!!) { Grant.from(it) }, (o["sealed"] as? JsonPrimitive)?.content ?: "")
            }.getOrNull()
        }
    }

    suspend fun grants(obj: String): List<SharedGrant> = sharedGrants(authed("GET", "/e2ee/grants?object=$obj"))

    suspend fun sharedWithMe(): List<SharedGrant> = sharedGrants(authed("GET", "/e2ee/shared"))

    // Rotation ---------------------------------------------------------------------

    // roots: per device kept, the new root sealed to its box key.
    suspend fun rotate(r: Signed<Rotation>, certs: List<Signed<DeviceCert>>, roots: Map<String, String>) {
        authed(
            "POST",
            "/e2ee/rotate",
            JsonObject(
                mapOf(
                    "rotation" to r.toJson(),
                    "certs" to JsonArray(certs.map { it.toJson() }),
                    "roots" to JsonObject(roots.mapValues { JsonPrimitive(it.value) }),
                ),
            ),
        )
    }

    // For a device whose cert stopped counting: what the rotation left for it.
    suspend fun rotated(account: String, device: String): Rotated {
        val o = call("POST", "/e2ee/rotated", obj("account" to account, "device" to device)).jsonObject
        return Rotated(
            o["rotations"]!!.jsonArray.map { e -> Signed.parse(e) { Rotation.from(it) } },
            Signed.parse(o["cert"]!!) { DeviceCert.from(it) },
            o.str("root"),
        )
    }
}
