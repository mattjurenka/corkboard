package app.corkboard.e2ee

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.Json

// The account's keys, all from one 32-byte root (lib/e2ee/keys.ts):
// HKDF-SHA256 under a label each, so no key is ever used for two things.
//
//   root ─┬─ account signing key (Ed25519): the account's id, signs device certs
//         ├─ account box key (X25519): what's wrapped to the account
//         └─ per object (board, brain, memory, index): its key, and its opaque id
//
// Device keys are random, one pair per device, never derived.

private val SALT = utf8("$VERSION root")

fun newRoot() = random(32)

fun derive(root: ByteArray, label: String, length: Int = 32): ByteArray {
    require(root.size == 32) { "a root is 32 bytes" }
    return hkdf(root, SALT, utf8(label), length)
}

class KeyPair(val secret: ByteArray, val public: ByteArray)

fun signPair(seed: ByteArray) = KeyPair(seed, Ed25519.publicKey(seed))
fun boxPair(secret: ByteArray) = KeyPair(secret, X25519.publicKey(secret))

// id: the account signing key's public half, base64url, what the relay knows it by.
class AccountKeys(val id: String, val sign: KeyPair, val box: KeyPair)

fun accountKeys(root: ByteArray): AccountKeys {
    val sign = signPair(derive(root, "account sign"))
    return AccountKeys(b64url(sign.public), sign, boxPair(derive(root, "account box")))
}

private fun label(kind: String, name: String): String {
    require(kind in KINDS) { "no kind $kind" }
    return "$kind\u0000$name"
}

fun objectKey(root: ByteArray, kind: String, name: String) = derive(root, "object key ${label(kind, name)}")

// 128 bits, as 22 base64url characters: the log's id on the relay.
fun objectId(root: ByteArray, kind: String, name: String) = b64url(derive(root, "object id ${label(kind, name)}", 16))

// Devices --------------------------------------------------------------------------

class Device(val id: String, val sign: KeyPair, val box: KeyPair) {
    companion object {
        fun new() = of(random(32), random(32))
        fun of(sign: ByteArray, box: ByteArray): Device {
            val s = signPair(sign)
            return Device(b64url(s.public), s, boxPair(box))
        }
    }
}

private fun sign(kp: KeyPair, bytes: ByteArray) = b64url(Ed25519.sign(kp.secret, bytes))

fun verify(public: String, bytes: ByteArray, sig: String): Boolean = try {
    Ed25519.verify(fromB64url(public), bytes, fromB64url(sig))
} catch (e: IllegalArgumentException) {
    false
}

fun certify(account: AccountKeys, device: String, box: ByteArray, name: String, issued: Long = System.currentTimeMillis()): Signed<DeviceCert> {
    val body = DeviceCert(account.id, device, b64url(box), name.take(100), issued)
    return Signed(body, sign(account.sign, certBytes(body)))
}

fun revoke(account: AccountKeys, device: String, at: Long = System.currentTimeMillis()): Signed<Revocation> {
    val body = Revocation(account.id, device, at)
    return Signed(body, sign(account.sign, revocationBytes(body)))
}

fun creation(account: AccountKeys, origin: String, invite: String?): Signed<Creation> {
    val body = Creation(origin, account.id, b64url(account.box.public), invite)
    return Signed(body, sign(account.sign, creationBytes(body)))
}

fun answer(device: Device, origin: String, nonce: String, account: String): Signed<Challenge> {
    val body = Challenge(origin, nonce, account, device.id)
    return Signed(body, sign(device.sign, challengeBytes(body)))
}

fun signGrant(account: AccountKeys, g: Grant) = Signed(g, sign(account.sign, grantBytes(g)))
fun signUngrant(account: AccountKeys, u: Ungrant) = Signed(u, sign(account.sign, ungrantBytes(u)))
// Signed by the key before: `from`'s.
fun signRotation(from: AccountKeys, r: Rotation) = Signed(r, sign(from.sign, rotationBytes(r)))

// Why a device isn't one of the account's, or null if it is. account: the
// key certs must chain to now (the id, until a rotation).
fun checkCert(account: String, cert: Signed<DeviceCert>, revoked: Iterable<Signed<Revocation>> = emptyList()): String? {
    if (!cert.body.valid) return "not a device certificate"
    if (cert.body.account != account) return "certificate is for another account"
    if (!verify(account, certBytes(cert.body), cert.sig)) return "certificate isn't signed by the account"
    for (r in revoked) if (r.body.valid && r.body.account == account && r.body.device == cert.body.device && verify(account, revocationBytes(r.body), r.sig)) return "device is revoked"
    return null
}

// Records ----------------------------------------------------------------------------
//
// XChaCha20-Poly1305 with a random 24-byte nonce, and associated data naming
// the object and the op, so the relay can't move a record to another log or
// swap two ops' bodies without the open failing.

class Sealed(val nonce: ByteArray, val ciphertext: ByteArray)

const val NONCE = XChaCha.NONCE
const val TAG = XChaCha.TAG

fun aad(obj: String, op: String) = utf8("$VERSION record\u0000$obj\u0000$op")
private fun blobAad(blob: String) = utf8("$VERSION blob\u0000$blob")

// nonce: given only by tests, to compare bytes with lib/e2ee's.
fun seal(key: ByteArray, plaintext: ByteArray, data: ByteArray, nonce: ByteArray = random(NONCE)) =
    Sealed(nonce, XChaCha.encrypt(key, nonce, plaintext, data))

fun open(key: ByteArray, s: Sealed, data: ByteArray, what: String = "record"): ByteArray =
    XChaCha.decrypt(key, s.nonce, s.ciphertext, data) ?: throw Tampered(what)

// The JSON a record holds, written compactly as JSON.stringify would.
private val recordJson = Json { explicitNulls = true }

fun sealRecord(key: ByteArray, obj: String, op: String, body: JsonElement, nonce: ByteArray = random(NONCE)) =
    seal(key, utf8(recordJson.encodeToString(JsonElement.serializer(), body)), aad(obj, op), nonce)

fun openRecord(key: ByteArray, obj: String, op: String, s: Sealed): JsonElement =
    recordJson.parseToJsonElement(fromUtf8(open(key, s, aad(obj, op), "op $op")))

fun sealedOf(nonce: String, ciphertext: String) = Sealed(fromB64url(nonce), fromB64url(ciphertext))

// A blob is its nonce then its ciphertext, as one upload.
fun sealBlob(key: ByteArray, blob: String, bytes: ByteArray): ByteArray {
    val s = seal(key, bytes, blobAad(blob))
    return concat(s.nonce, s.ciphertext)
}

fun openBlob(key: ByteArray, blob: String, bytes: ByteArray): ByteArray {
    if (bytes.size < NONCE + TAG) throw Tampered("blob $blob")
    return open(key, Sealed(bytes.copyOfRange(0, NONCE), bytes.copyOfRange(NONCE, bytes.size)), blobAad(blob), "blob $blob")
}

// Wrapping to someone's X25519 key: libsodium's sealed box, which box.ts
// is byte for byte. Anonymous, so it's for board keys to members, not pairing.
fun sealTo(recipient: ByteArray, message: ByteArray) = SealedBox.seal(recipient, message)
fun openSealed(box: KeyPair, sealed: ByteArray) = SealedBox.open(box.secret, box.public, sealed)

// The recovery phrase ----------------------------------------------------------------
//
// The root as BIP39's 24 English words (assets/bip39-english.txt).

object Phrase {
    @Volatile
    private var words: List<String>? = null
    private var index: Map<String, Int> = emptyMap()

    fun load(list: List<String>) {
        require(list.size == 2048) { "a BIP39 wordlist is 2048 words" }
        words = list
        index = list.withIndex().associate { (i, w) -> w to i }
    }

    val ready get() = words != null

    private val list get() = words ?: throw IllegalStateException("no BIP39 wordlist loaded")

    fun of(root: ByteArray): String {
        require(root.size == 32) { "a root is 32 bytes" }
        val w = list
        val bits = concat(root, byteArrayOf(sha256(root)[0]))
        return (0 until 24).joinToString(" ") { i -> w[bitsAt(bits, i * 11, 11)] }
    }

    // Spacing and case forgiven; a wrong word or checksum isn't.
    fun root(phrase: String): ByteArray {
        val words = phrase.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        val bad = IllegalArgumentException("that isn't a recovery phrase (a word is wrong, or missing)")
        if (words.size !in listOf(12, 15, 18, 21, 24)) throw bad
        list
        val idx = words.map { index[it] ?: throw bad }
        val total = words.size * 11
        val ent = total * 32 / 33
        val bits = ByteArray((total + 7) / 8)
        for ((i, n) in idx.withIndex()) for (b in 0 until 11) if (n shr (10 - b) and 1 == 1) {
            val at = i * 11 + b
            bits[at / 8] = (bits[at / 8].toInt() or (0x80 ushr (at % 8))).toByte()
        }
        val entropy = bits.copyOfRange(0, ent / 8)
        val cs = total - ent
        if (bitsAt(bits, ent, cs) != (sha256(entropy)[0].toInt() and 0xff) ushr (8 - cs)) throw bad
        if (entropy.size != 32) throw IllegalArgumentException("a recovery phrase is 24 words")
        return entropy
    }

    private fun bitsAt(b: ByteArray, from: Int, n: Int): Int {
        var v = 0
        for (i in from until from + n) v = (v shl 1) or ((b[i / 8].toInt() ushr (7 - i % 8)) and 1)
        return v
    }
}
