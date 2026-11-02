package app.corkboard

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import app.corkboard.e2ee.AccountKeys
import app.corkboard.e2ee.CardChange
import app.corkboard.e2ee.Device
import app.corkboard.e2ee.DeviceCert
import app.corkboard.e2ee.IndexEntry
import app.corkboard.e2ee.Na
import app.corkboard.e2ee.Phrase
import app.corkboard.e2ee.Relay
import app.corkboard.e2ee.RelayError
import app.corkboard.e2ee.Replica
import app.corkboard.e2ee.ReplicaStore
import app.corkboard.e2ee.Saved
import app.corkboard.e2ee.SharedObject
import app.corkboard.e2ee.Signed
import app.corkboard.e2ee.Token
import app.corkboard.e2ee.accountKeys
import app.corkboard.e2ee.b64url
import app.corkboard.e2ee.changesOfOps
import app.corkboard.e2ee.checkRotated
import app.corkboard.e2ee.entries
import app.corkboard.e2ee.fromB64url
import app.corkboard.e2ee.fromUtf8
import app.corkboard.e2ee.indexId
import app.corkboard.e2ee.indexKey
import app.corkboard.e2ee.objectId
import app.corkboard.e2ee.objectKey
import app.corkboard.e2ee.pairNew
import app.corkboard.e2ee.remember
import app.corkboard.e2ee.sharedWithMe
import app.corkboard.e2ee.utf8
import app.corkboard.e2ee.wireJson
import com.goterl.lazysodium.LazySodiumAndroid
import com.goterl.lazysodium.SodiumAndroid
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// The phone as a device of an end-to-end encrypted account (app.corkboard.e2ee,
// .agent/plans/e2ee.md): paired from a device that's in, then reading and
// writing boards and reading brains shared with it, straight from the relay.
//
// What it keeps is under the app's files, each file sealed with an AES-GCM
// key in the Android Keystore (in StrongBox where the phone has one), which
// never leaves it: the root, this device's keys and cert, and each object's
// replica.
object Keychain {
    private const val ALIAS = "corkboard-e2ee"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        fun make(strongBox: Boolean): SecretKey {
            val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setIsStrongBoxBacked(strongBox)
                .build()
            return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(spec)
                generateKey()
            }
        }
        return try {
            make(true)
        } catch (e: StrongBoxUnavailableException) {
            make(false)
        }
    }

    // The IV (12 bytes), then the ciphertext and its tag.
    fun seal(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return c.iv + c.doFinal(plain)
    }

    fun open(sealed: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12)) }
        return c.doFinal(sealed, 12, sealed.size - 12)
    }

    fun forget() {
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS) }
    }
}

object Encrypted {
    // This phone in its account, once paired.
    class Me(
        // The account's id (its first key), which logs and grants are under.
        val account: String,
        val name: String,
        val device: Device,
        val cert: Signed<DeviceCert>,
        val root: ByteArray,
    ) {
        val keys: AccountKeys by lazy { accountKeys(root) }
    }

    val me = MutableStateFlow<Me?>(null)
    // A word on what went wrong, for the screen to show.
    val problem = MutableStateFlow<String?>(null)

    private lateinit var dir: File
    private var loaded = false

    // libsodium and the wordlist, then what's kept; on first use, not at start.
    @Synchronized
    fun load(context: Context) {
        if (loaded) return
        if (!Na.ready) Na.use(LazySodiumAndroid(SodiumAndroid()))
        if (!Phrase.ready) Phrase.load(context.assets.open("bip39-english.txt").bufferedReader().readLines().filter { it.isNotBlank() })
        dir = File(context.filesDir, "e2ee").apply { mkdirs() }
        me.value = runCatching { readMe() }.onFailure { if (File(dir, "device").exists()) problem.value = "couldn't open this phone's keys: ${it.message}" }.getOrNull()
        loaded = true
    }

    private fun write(name: String, bytes: ByteArray) {
        val f = File(dir, name)
        f.parentFile?.mkdirs()
        val part = File(f.path + ".part")
        part.writeBytes(Keychain.seal(bytes))
        part.renameTo(f)
    }

    private fun read(name: String): ByteArray? = File(dir, name).takeIf { it.exists() }?.let { Keychain.open(it.readBytes()) }

    private fun readMe(): Me? {
        val root = read("root") ?: return null
        val d = wireJson.parseToJsonElement(fromUtf8(read("device") ?: return null)).jsonObject
        val cert = Signed.parse(d["cert"]!!) { DeviceCert.from(it) }
        return Me(
            d["account"]!!.jsonPrimitive.content,
            d["name"]!!.jsonPrimitive.content,
            Device.of(fromB64url(d["sign"]!!.jsonPrimitive.content), fromB64url(d["box"]!!.jsonPrimitive.content)),
            cert,
            root,
        )
    }

    // The root first, so a crash between the two leaves something to resume from.
    private fun keep(m: Me) {
        write("root", m.root)
        write(
            "device",
            utf8(
                JsonObject(
                    mapOf(
                        "account" to JsonPrimitive(m.account),
                        "name" to JsonPrimitive(m.name),
                        "sign" to JsonPrimitive(b64url(m.device.sign.secret)),
                        "box" to JsonPrimitive(b64url(m.device.box.secret)),
                        "cert" to m.cert.toJson(),
                    ),
                ).toString(),
            ),
        )
        me.value = m
    }

    private var token: Token?
        get() = runCatching { read("token")?.let { wireJson.decodeFromString(Token.serializer(), fromUtf8(it)) } }.getOrNull()
        set(v) {
            if (v != null) write("token", utf8(wireJson.encodeToString(Token.serializer(), v)))
        }

    private var relayOf: Pair<Me, Relay>? = null

    fun relay(m: Me): Relay {
        relayOf?.takeIf { it.first === m }?.let { return it.second }
        val r = Relay(Cloud.ORIGIN, m.device, m.cert, token, { token = it })
        relayOf = m to r
        return r
    }

    // Pairing ---------------------------------------------------------------------------

    // This phone into the account a device that's in approves: show gets the
    // code, confirm the six digits to compare.
    suspend fun pair(name: String, show: (String) -> Unit, confirm: suspend (String) -> Boolean) {
        check(me.value == null) { "this phone is already in an account" }
        val device = withContext(Dispatchers.Default) { Device.new() }
        val got = pairNew(Relay(Cloud.ORIGIN), device, name, { code, _ -> show(code) }, confirm)
        // The id from the relay: a device paired after a rotation has a cert
        // naming the account's key now, not its id.
        val t = Relay(Cloud.ORIGIN, device, got.cert).signIn()
        val m = Me(t.account ?: got.cert.body.account, name, device, got.cert, got.root)
        token = t
        withContext(Dispatchers.IO) { keep(m) }
    }

    // Leaves the account on this phone: its keys and replicas go. The relay
    // still has the device until another revokes it.
    fun forget() {
        dir.listFiles()?.forEach { it.deleteRecursively() }
        replicas.clear()
        relayOf = null
        me.value = null
        Keychain.forget()
    }

    // After another device rotated the account's key: the new root and cert
    // the rotation left for this one, checked, and anything queued here moved
    // onto the new objects. False if there was none.
    suspend fun catchUp(m: Me): Boolean {
        val r = try {
            Relay(Cloud.ORIGIN).rotated(m.account, m.device.id)
        } catch (e: RelayError) {
            return false
        }
        val got = checkRotated(r, m.keys.id, m.device)
        val next = Me(m.account, m.name, m.device, got.cert, got.root)
        val queued = replicas.values.filter { it.first.pending > 0 && it.second.owner == null }.map { (rep, ref) -> ref to rep.queued() }
        withContext(Dispatchers.IO) { keep(next) }
        replicas.clear()
        for ((ref, ops) in queued) {
            if (ref.name == null) continue
            val rep = replica(next, Ref(ref.kind, objectId(next.root, ref.kind, ref.name), ref.name))
            val changes = changesOfOps(ops)
            if (changes.isNotEmpty()) rep.change(*changes.toTypedArray())
            runCatching { rep.push() }
        }
        return true
    }

    // Objects ---------------------------------------------------------------------------

    // An object as the screens name it: one of this account's (by kind and
    // name, its key derived or from the index), or one shared with it.
    data class Ref(val kind: String, val obj: String, val name: String?, val owner: String? = null, val epoch: Int = 0, val key: String? = null, val write: Boolean = true)

    fun board(m: Me, name: String) = Ref("board", objectId(m.root, "board", name), name)

    private val replicas = HashMap<String, Pair<Replica, Ref>>()
    private val opening = Mutex()

    private fun store(obj: String) = object : ReplicaStore {
        override suspend fun load() = withContext(Dispatchers.IO) {
            runCatching { read("replicas/$obj")?.let { Saved.from(wireJson.parseToJsonElement(fromUtf8(it))) } }.getOrNull()
        }
        override suspend fun save(s: Saved) {
            val bytes = utf8(s.toJson().toString())
            withContext(Dispatchers.IO) { write("replicas/$obj", bytes) }
        }
    }

    suspend fun replica(m: Me, ref: Ref): Replica = opening.withLock {
        replicas[ref.obj]?.let { return it.first }
        val key = ref.key?.let(::fromB64url) ?: objectKey(m.root, ref.kind, ref.name ?: "")
        val transport = if (ref.owner != null) relay(m).shared(ref.owner) else relay(m)
        // A key that changed since: the owner's grant again, or the index's entry.
        val keyOf: suspend (Int) -> ByteArray? = { epoch ->
            if (ref.owner != null) shared(m).first.firstOrNull { it.obj == ref.obj && it.epoch == epoch }?.key
            else if (ref.kind == "index") null
            else entries(replica(m, index(m)).also { runCatching { it.pull() } }).firstOrNull { it.obj == ref.obj && it.epoch == epoch }?.keyFrom(m.root)
        }
        val rep = Replica.open(transport, key, ref.obj, m.device.id, store("${ref.owner ?: "mine"}-${ref.obj}"), ref.epoch, keyOf)
        replicas[ref.obj] = rep to ref
        rep
    }

    fun index(m: Me) = Ref("index", indexId(m.root), "", key = b64url(indexKey(m.root)))

    // Every call to the relay through here: a sign-in refused because the
    // account's key was rotated catches up, once, and goes again.
    suspend fun <T> call(m: Me, f: suspend (Me) -> T): T = try {
        f(m)
    } catch (e: RelayError) {
        if (e.status != 401 && e.status != 403 || !catchUp(m)) throw e
        f(me.value!!)
    }

    // The boards: the index's, and any typed in (until the index has them).
    suspend fun boards(m: Me): List<Ref> {
        val index = replica(m, index(m))
        runCatching { index.pull() }
        val listed = entries(index).filter { it.kind == "board" }.map { Ref("board", it.obj, it.name, epoch = it.epoch, key = it.key) }
        val typed = typedBoards().map { board(m, it) }.filter { t -> listed.none { it.obj == t.obj } }
        return (listed + typed).sortedBy { it.name }
    }

    private fun typedBoards(): List<String> = runCatching { read("boards")?.let { wireJson.parseToJsonElement(fromUtf8(it)).jsonArray.map { e -> e.jsonPrimitive.content } } }.getOrNull().orEmpty()

    // A board's key typed in: kept, and written to the index once it has cards.
    suspend fun addBoard(m: Me, name: String): Ref {
        val list = (typedBoards() + name).distinct()
        withContext(Dispatchers.IO) { write("boards", utf8(JsonArray(list.map(::JsonPrimitive)).toString())) }
        val ref = board(m, name)
        val rep = replica(m, ref)
        rep.pull()
        if (rep.cards().isNotEmpty()) {
            val index = replica(m, index(m))
            remember(index, IndexEntry(ref.obj, "board", name, rep.epoch, null))
            runCatching { index.push() }
        }
        return ref
    }

    suspend fun shared(m: Me): Pair<List<SharedObject>, List<String>> = sharedWithMe(relay(m), m.keys, m.account)

    fun ref(s: SharedObject) = Ref(s.kind, s.obj, s.name, s.owner, s.epoch, b64url(s.key), s.role == "write")

    suspend fun edit(m: Me, ref: Ref, vararg changes: CardChange) {
        val rep = replica(m, ref)
        rep.change(*changes)
        rep.push()
    }
}
