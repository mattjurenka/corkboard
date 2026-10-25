package app.corkboard

import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.browser.customtabs.CustomTabsIntent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

// corkboard's Worker, as an ordinary OAuth client of it like the bridge
// (bridge/cloud.ts): it registers itself, signs in through the browser
// with PKCE, and calls /api with the owner scope.
object Cloud {
    const val ORIGIN = "https://corkboard.matthewjurenka.workers.dev"

    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }
    val http: OkHttpClient = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).build()
    private val JSON_TYPE = "application/json".toMediaType()

    class NotSignedIn : Exception("not signed in to corkboard")
    class Failed(val status: Int, message: String) : Exception(message)
    class Conflict(val plan: Plan) : Exception("the plan changed; look at it again")

    // Signing in ------------------------------------------------------------------------

    // The browser comes back to a loopback port the app listens on (RFC
    // 8252), as the bridge's does, so the Worker needs no app link or
    // private-use scheme. Blocks until the browser comes back, up to five
    // minutes.
    suspend fun signIn(context: Context) = withContext(Dispatchers.IO) {
        ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { server ->
            server.soTimeout = 5 * 60_000
            val redirect = "http://127.0.0.1:${server.localPort}/callback"
            val reg = post(
                "$ORIGIN/register",
                buildJsonObject {
                    put("client_name", "corkboard phone (${android.os.Build.MODEL})")
                    put("redirect_uris", json.encodeToJsonElement(listOf(redirect)))
                    put("token_endpoint_auth_method", "none")
                    put("grant_types", json.encodeToJsonElement(listOf("authorization_code", "refresh_token")))
                },
                token = null,
            )
            val clientId = reg.jsonObject["client_id"]!!.jsonPrimitive.content
            val verifier = random(32)
            val challenge = base64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
            val state = random(16)
            val url = Uri.parse("$ORIGIN/authorize").buildUpon()
                .appendQueryParameter("response_type", "code")
                .appendQueryParameter("client_id", clientId)
                .appendQueryParameter("redirect_uri", redirect)
                .appendQueryParameter("scope", "owner")
                .appendQueryParameter("state", state)
                .appendQueryParameter("code_challenge", challenge)
                .appendQueryParameter("code_challenge_method", "S256")
                .build()
            withContext(Dispatchers.Main) { CustomTabsIntent.Builder().build().launchUrl(context, url) }

            val params = server.accept().use { socket ->
                val line = socket.getInputStream().bufferedReader().readLine() ?: ""
                val query = line.split(" ").getOrNull(1)?.substringAfter("?", "") ?: ""
                val params = query.split("&").filter { "=" in it }.associate {
                    val (k, v) = it.split("=", limit = 2)
                    k to URLDecoder.decode(v, "UTF-8")
                }
                val ok = params["state"] == state && params["code"] != null
                val body = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
                    <body style="background:#272822;color:#f8f8f2;font:15px ui-monospace,monospace;margin:4rem 16px">
                    <p>${if (ok) "Signed in." else "Sign-in didn't finish."}</p>
                    <p><a style="color:#fd971f" href="corkboard://signed-in">Back to corkboard</a></p>""".trimIndent()
                socket.getOutputStream().write(
                    ("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n" +
                        "Content-Length: ${body.toByteArray().size}\r\n\r\n$body").toByteArray(),
                )
                params
            }
            if (params["state"] != state) throw Failed(0, "the sign-in came back for another request")
            val code = params["code"] ?: throw Failed(0, "sign-in was cancelled (${params["error"] ?: "no code"})")
            val t = tokens(
                "grant_type" to "authorization_code",
                "code" to code,
                "redirect_uri" to redirect,
                "client_id" to clientId,
                "code_verifier" to verifier,
            )
            App.store.auth = t.toAuth(clientId)
        }
    }

    fun signOut() {
        App.store.auth = null
    }

    private fun JsonObject.toAuth(clientId: String) = Auth(
        clientId = clientId,
        access = this["access_token"]!!.jsonPrimitive.content,
        refresh = this["refresh_token"]!!.jsonPrimitive.content,
        expiresAt = System.currentTimeMillis() + this["expires_in"]!!.jsonPrimitive.content.toLong() * 1000,
    )

    private fun tokens(vararg form: Pair<String, String>): JsonObject {
        val body = FormBody.Builder().apply { form.forEach { (k, v) -> add(k, v) } }.build()
        http.newCall(Request.Builder().url("$ORIGIN/token").post(body).build()).execute().use { res ->
            val text = res.body?.string() ?: ""
            if (!res.isSuccessful) throw Failed(res.code, "the Worker refused the sign-in (${res.code}): $text")
            return json.parseToJsonElement(text).jsonObject
        }
    }

    private val refreshing = Mutex()

    // A current access token, refreshed when it's within a minute of
    // expiring. Refresh tokens rotate, so each one is saved before it's
    // used again.
    suspend fun token(): String = refreshing.withLock {
        val auth = App.store.auth ?: throw NotSignedIn()
        if (auth.expiresAt - 60_000 > System.currentTimeMillis()) return auth.access
        val t = withContext(Dispatchers.IO) {
            try {
                tokens("grant_type" to "refresh_token", "refresh_token" to auth.refresh, "client_id" to auth.clientId)
            } catch (e: Failed) {
                // A refresh token the Worker no longer knows: sign in again.
                if (e.status in 400..499) App.store.auth = null
                throw if (e.status in 400..499) NotSignedIn() else e
            }
        }
        val next = t.toAuth(auth.clientId)
        App.store.auth = next
        next.access
    }

    // The API ---------------------------------------------------------------------------

    private fun post(url: String, body: JsonElement, token: String?): JsonElement = send("POST", url, body, token)

    private fun send(method: String, url: String, body: JsonElement?, token: String?): JsonElement {
        val req = Request.Builder().url(url)
            .method(method, body?.let { json.encodeToString(JsonElement.serializer(), it).toRequestBody(JSON_TYPE) })
        if (token != null) req.header("Authorization", "Bearer $token")
        http.newCall(req.build()).execute().use { res ->
            val text = res.body?.string() ?: ""
            val parsed = runCatching { json.parseToJsonElement(text) }.getOrNull() ?: JsonNull
            if (res.code == 409 && parsed is JsonObject && parsed["plan"] != null) {
                throw Conflict(json.decodeFromJsonElement(parsed["plan"]!!))
            }
            if (!res.isSuccessful) {
                val error = (parsed as? JsonObject)?.get("error")?.jsonPrimitive?.content ?: text.take(200)
                throw Failed(res.code, "$method ${Uri.parse(url).path}: ${res.code} $error")
            }
            return parsed
        }
    }

    suspend fun api(method: String, path: String, body: JsonElement? = null): JsonElement {
        val token = token()
        return withContext(Dispatchers.IO) { send(method, "$ORIGIN$path", body, token) }
    }

    suspend fun plan(date: String): Plan = json.decodeFromJsonElement(api("GET", "/api/plans/$date"))

    // The proposal as Pepper made it becomes the day.
    suspend fun accept(plan: Plan): Plan = json.decodeFromJsonElement(
        api(
            "POST",
            "/api/plans/${plan.date}/accept",
            buildJsonObject {
                put("version", plan.version)
                put("blocks", json.encodeToJsonElement(plan.proposal!!.blocks))
            },
        ),
    )

    suspend fun discard(plan: Plan): Plan = json.decodeFromJsonElement(
        api("POST", "/api/plans/${plan.date}/discard", buildJsonObject { put("version", plan.version) }),
    )

    suspend fun chat(after: Long = 0): List<ChatMessage> = json.decodeFromJsonElement(api("GET", "/api/chat?after=$after"))

    suspend fun say(text: String): ChatMessage =
        json.decodeFromJsonElement(api("POST", "/api/chat", buildJsonObject { put("text", text) }))

    // The user's live socket: a plan or chat event for every change.
    suspend fun live(listener: WebSocketListener): WebSocket {
        val token = token()
        val req = Request.Builder().url("$ORIGIN/api/live").header("Authorization", "Bearer $token").build()
        return http.newWebSocket(req, listener)
    }

    private fun random(bytes: Int) = base64url(ByteArray(bytes).also { SecureRandom().nextBytes(it) })

    private fun base64url(bytes: ByteArray) =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}
