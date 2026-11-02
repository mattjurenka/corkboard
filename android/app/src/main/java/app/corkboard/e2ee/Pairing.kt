package app.corkboard.e2ee

import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

// Pairing (lib/e2ee/pairing.ts): a new device gets the root from one that
// has it, through a mailbox on the relay. The approver commits to its key
// before it sees the new device's; the new device waits for that commitment
// before joining; both show six digits hashed from the whole transcript;
// and the root travels in a record keyed by X25519 between the approver's
// key and the new device's box key, the transcript its salt and AAD. A
// relay in the middle gets one guess in a million.

fun commitment(approver: String) = b64url(sha256(commitBytes(approver)))

// Six digits, from the whole transcript.
fun sas(t: PairTranscript): String {
    val h = sha256(transcriptBytes(t))
    val n = ((h[0].toLong() and 0xff) shl 24) or ((h[1].toLong() and 0xff) shl 16) or ((h[2].toLong() and 0xff) shl 8) or (h[3].toLong() and 0xff)
    return (n % 1_000_000).toString().padStart(6, '0')
}

private fun channel(secret: ByteArray, public: ByteArray, t: PairTranscript): ByteArray =
    hkdf(X25519.shared(secret, public), sha256(transcriptBytes(t)), utf8("pair deliver"), 32)

@Serializable
data class Delivery(val nonce: String, val ciphertext: String)

@Serializable
data class Join(val box: String, val device: String, val name: String)

// The mailbox as each side sees it (GET /e2ee/pair/:code).
@Serializable
data class MailboxView(val code: String, val expires: Long, val commit: String? = null, val join: Join? = null, val reveal: String? = null, val deliver: Delivery? = null)

@Serializable
data class NewPairing(val code: String, val secret: String, val expires: Long)

fun deliver(approver: KeyPair, t: PairTranscript, root: ByteArray, cert: Signed<DeviceCert>): Delivery {
    val payload = JsonObject(mapOf("root" to JsonPrimitive(b64url(root)), "cert" to cert.toJson()))
    val s = seal(channel(approver.secret, fromB64url(t.box), t), utf8(payload.toString()), transcriptBytes(t))
    return Delivery(b64url(s.nonce), b64url(s.ciphertext))
}

class Paired(val root: ByteArray, val cert: Signed<DeviceCert>)

fun receive(device: Device, t: PairTranscript, d: Delivery): Paired {
    val plain = open(channel(device.box.secret, fromB64url(t.approver), t), sealedOf(d.nonce, d.ciphertext), transcriptBytes(t), "pairing delivery")
    val p = wireJson.parseToJsonElement(fromUtf8(plain)).jsonObject
    val root = fromB64url(p.str("root"))
    val cert = Signed.parse(p["cert"]!!) { DeviceCert.from(it) }
    // What came is only good if it's this device's, under that root's account.
    val account = accountKeys(root)
    if (cert.body.account != account.id || cert.body.device != device.id || cert.body.box != t.box) throw IllegalStateException("pairing delivery: the certificate isn't for this device")
    return Paired(root, cert)
}

// QR codes carry the box key too, so a scan needs no code compared on the approving side.
fun qrPayload(code: String, device: Device) = "corkboard-pair:1:$code:${b64url(device.box.public)}"

fun parseQr(s: String): Pair<String, String>? =
    Regex("corkboard-pair:1:([0-9A-Z]{10}):([A-Za-z0-9_-]{43})").matchEntire(s.trim())?.let { it.groupValues[1] to it.groupValues[2] }

// What the two drivers need from the relay (Relay has it).
interface PairTransport {
    suspend fun create(): NewPairing
    suspend fun view(code: String, secret: String? = null): MailboxView
    suspend fun commit(code: String, commit: String)
    suspend fun join(code: String, secret: String, j: Join)
    suspend fun reveal(code: String, approver: String)
    suspend fun deliver(code: String, d: Delivery)
    suspend fun cancel(code: String, secret: String? = null)
}

class PairingFailed(message: String) : Exception(message)

private suspend fun <T> poll(expires: Long, interval: Long, get: suspend () -> T?): T {
    while (true) {
        get()?.let { return it }
        if (System.currentTimeMillis() >= expires) throw PairingFailed("pairing timed out")
        delay(interval)
    }
}

// The new device's half. show: the code to type (and the QR); confirm: the
// person says the six digits match what the other device shows.
suspend fun pairNew(
    relay: PairTransport,
    device: Device,
    name: String,
    show: (code: String, qr: String) -> Unit,
    confirm: suspend (sas: String) -> Boolean,
    interval: Long = 1000,
): Paired {
    val p = relay.create()
    show(p.code, qrPayload(p.code, device))
    try {
        val commit = poll(p.expires, interval) { relay.view(p.code, p.secret).commit }
        val join = Join(b64url(device.box.public), device.id, name)
        relay.join(p.code, p.secret, join)
        val approver = poll(p.expires, interval) { relay.view(p.code, p.secret).reveal }
        if (commitment(approver) != commit) throw PairingFailed("pairing: the approving device's key doesn't match what it committed to; someone is in the middle")
        val t = PairTranscript(p.code, approver, join.box, join.device)
        if (!confirm(sas(t))) throw PairingFailed("pairing: the codes didn't match")
        val d = poll(p.expires, interval) { relay.view(p.code, p.secret).deliver }
        return receive(device, t, d)
    } catch (e: Throwable) {
        runCatching { kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { relay.cancel(p.code, p.secret) } }
        throw e
    }
}

// The approving device's half, holding the root. box: the new device's box
// key from its QR, when scanned. The six digits are still shown, for the
// new device's side of the check.
suspend fun approve(
    relay: PairTransport,
    root: ByteArray,
    typed: String,
    confirm: suspend (sas: String, join: Join) -> Boolean,
    box: String? = null,
    interval: Long = 1000,
): Signed<DeviceCert> {
    val code = normalizeCode(typed) ?: typed
    val me = boxPair(random(32))
    val approver = b64url(me.public)
    try {
        relay.commit(code, commitment(approver))
        val expires = relay.view(code).expires
        val join = poll(expires, interval) { relay.view(code).join }
        if (box != null && join.box != box) throw PairingFailed("pairing: the device that joined isn't the one whose code was scanned; someone is in the middle")
        relay.reveal(code, approver)
        val t = PairTranscript(code, approver, join.box, join.device)
        if (!confirm(sas(t), join)) throw PairingFailed("pairing: the codes didn't match")
        val cert = certify(accountKeys(root), join.device, fromB64url(join.box), join.name)
        relay.deliver(code, deliver(me, t, root, cert))
        return cert
    } catch (e: Throwable) {
        runCatching { kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { relay.cancel(code) } }
        throw e
    } finally {
        me.secret.fill(0)
    }
}
