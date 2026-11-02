package app.corkboard.e2ee

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

// What the relay and its clients agree on, byte for byte: lib/e2ee/wire.ts,
// as Kotlin. Everything signed is a domain-separated line and the canonical
// JSON of a flat object of strings and integers: keys sorted, no spaces.
// Keys, nonces and ciphertext travel as unpadded base64url.
//
// The newer parts (snapshots, epochs, grants, rotations, the index) follow
// .agent/plans/e2ee.md's "Next" section as lib/e2ee has them so far; if
// their layout shifts, this file is where it changes.

const val VERSION = "corkboard-e2ee/v1"

fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)
fun fromUtf8(b: ByteArray): String = String(b, Charsets.UTF_8)

private val B64_ENCODE = java.util.Base64.getUrlEncoder().withoutPadding()
private val B64_DECODE = java.util.Base64.getUrlDecoder()
private val B64URL = Regex("[A-Za-z0-9_-]*")

fun b64url(b: ByteArray): String = B64_ENCODE.encodeToString(b)

fun fromB64url(s: String): ByteArray {
    if (!B64URL.matches(s) || s.length % 4 == 1) throw IllegalArgumentException("not base64url")
    return B64_DECODE.decode(s)
}

fun concat(vararg parts: ByteArray): ByteArray {
    val out = ByteArray(parts.sumOf { it.size })
    var at = 0
    for (p in parts) {
        p.copyInto(out, at)
        at += p.size
    }
    return out
}

// A 32-byte key as base64url is 43 characters.
val KEY = Regex("[A-Za-z0-9_-]{43}")
// What a client names an op, a blob or a log by: opaque to the relay.
val OPAQUE = Regex("[A-Za-z0-9_-]{16,64}")

// The JSON the wire is written in: unknown fields kept quiet, absent ones
// left out (an op's epoch 0 is no epoch at all).
val wireJson = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }

// A string as JSON.stringify writes it: only ", \ and controls escaped, and
// a lone surrogate as \uXXXX, so what's signed is the same bytes in both.
fun jsString(s: String): String {
    val b = StringBuilder(s.length + 2).append('"')
    var i = 0
    while (i < s.length) {
        val c = s[i]
        when {
            c == '"' -> b.append("\\\"")
            c == '\\' -> b.append("\\\\")
            c == '\b' -> b.append("\\b")
            c == '\u000C' -> b.append("\\f")
            c == '\n' -> b.append("\\n")
            c == '\r' -> b.append("\\r")
            c == '\t' -> b.append("\\t")
            c < ' ' -> b.append("\\u%04x".format(c.code))
            c.isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate() -> {
                b.append(c).append(s[i + 1])
                i++
            }
            c.isSurrogate() -> b.append("\\u%04x".format(c.code))
            else -> b.append(c)
        }
        i++
    }
    return b.append('"').toString()
}

private const val MAX_SAFE = 9007199254740991L

// Values: strings, whole numbers (Int or Long, within JS's safe range) and null.
fun canonical(o: Map<String, Any?>): String {
    val keys = o.keys.sorted()
    return keys.joinToString(",", "{", "}") { k ->
        val v = when (val x = o[k]) {
            null -> "null"
            is String -> jsString(x)
            is Int -> x.toString()
            is Long -> if (x in -MAX_SAFE..MAX_SAFE) x.toString() else throw IllegalArgumentException("$k: only strings, integers and null are signed")
            else -> throw IllegalArgumentException("$k: only strings, integers and null are signed")
        }
        "${jsString(k)}:$v"
    }
}

// The bytes a signature covers: what it is, then the statement.
fun signed(kind: String, o: Map<String, Any?>): ByteArray = utf8("$VERSION $kind\n${canonical(o)}")

// A statement that's signed: flat, so canonical() can lay it out.
interface Statement {
    fun flat(): Map<String, Any?>
}

fun Statement.toJson(): JsonObject = JsonObject(
    flat().mapValues { (_, v) ->
        when (v) {
            null -> JsonNull
            is String -> JsonPrimitive(v)
            is Number -> JsonPrimitive(v)
            else -> throw IllegalArgumentException("not flat")
        }
    },
)

internal fun JsonObject.str(k: String): String = this[k]?.jsonPrimitive?.takeIf { it.isString }?.content ?: throw IllegalArgumentException("$k must be a string")
internal fun JsonObject.strOrNull(k: String): String? = this[k]?.takeIf { it !is JsonNull }?.jsonPrimitive?.takeIf { it.isString }?.content
internal fun JsonObject.long(k: String): Long = this[k]?.jsonPrimitive?.takeIf { !it.isString }?.longOrNull ?: throw IllegalArgumentException("$k must be a whole number")
internal fun JsonObject.isV1() = this["v"]?.jsonPrimitive?.longOrNull == 1L

class Signed<T : Statement>(val body: T, val sig: String) {
    fun toJson(): JsonObject = JsonObject(mapOf("body" to body.toJson(), "sig" to JsonPrimitive(sig)))

    companion object {
        fun <T : Statement> parse(e: JsonElement, body: (JsonObject) -> T): Signed<T> {
            val o = e.jsonObject
            return Signed(body(o["body"]!!.jsonObject), o.str("sig"))
        }
    }
}

// A device certificate: the account's signing key vouches for a device's
// signing key (and its box key, for what's wrapped to it).
data class DeviceCert(val account: String, val device: String, val box: String, val name: String, val issued: Long) : Statement {
    override fun flat() = mapOf("v" to 1, "account" to account, "device" to device, "box" to box, "name" to name, "issued" to issued)
    val valid get() = KEY.matches(account) && KEY.matches(device) && KEY.matches(box) && name.length <= 100

    companion object {
        fun from(o: JsonObject): DeviceCert {
            require(o.isV1()) { "not a v1 certificate" }
            return DeviceCert(o.str("account"), o.str("device"), o.str("box"), o.str("name"), o.long("issued"))
        }
    }
}

// The account's word that a device is no longer one of its own.
data class Revocation(val account: String, val device: String, val at: Long) : Statement {
    override fun flat() = mapOf("v" to 1, "account" to account, "device" to device, "at" to at)
    val valid get() = KEY.matches(account) && KEY.matches(device)

    companion object {
        fun from(o: JsonObject): Revocation {
            require(o.isV1()) { "not a v1 revocation" }
            return Revocation(o.str("account"), o.str("device"), o.long("at"))
        }
    }
}

// Account creation: proof the creator holds the account key, tied to the
// relay and the invite it's spending.
data class Creation(val origin: String, val account: String, val box: String, val invite: String?) : Statement {
    override fun flat() = mapOf("v" to 1, "origin" to origin, "account" to account, "box" to box, "invite" to invite)

    companion object {
        fun from(o: JsonObject) = Creation(o.str("origin"), o.str("account"), o.str("box"), o.strOrNull("invite"))
    }
}

// Sign-in: the relay's nonce, signed by a device with a cert.
data class Challenge(val origin: String, val nonce: String, val account: String, val device: String) : Statement {
    override fun flat() = mapOf("v" to 1, "origin" to origin, "nonce" to nonce, "account" to account, "device" to device)
}

// Pairing (Pairing.kt): what both sides hash their six digits from.
data class PairTranscript(val code: String, val approver: String, val box: String, val device: String) : Statement {
    override fun flat() = mapOf("v" to 1, "code" to code, "approver" to approver, "box" to box, "device" to device)
}

fun certBytes(c: DeviceCert) = signed("device-cert", c.flat())
fun revocationBytes(r: Revocation) = signed("revocation", r.flat())
fun creationBytes(c: Creation) = signed("create-account", c.flat())
fun challengeBytes(c: Challenge) = signed("challenge", c.flat())
fun commitBytes(approver: String) = signed("pair-commit", mapOf("approver" to approver))
fun transcriptBytes(t: PairTranscript) = signed("pair-transcript", t.flat())

// A pairing code: ten characters of Crockford's base32 (50 bits), shown as
// XXXXX-XXXXX; what's typed is forgiven case, dashes, O for 0 and I/L for 1.
const val CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
private val CODE = Regex("[0-9A-HJKMNP-TV-Z]{10}")

fun normalizeCode(s: String): String? {
    val c = s.uppercase().replace(Regex("[\\s-]"), "").replace('O', '0').replace(Regex("[IL]"), "1")
    return c.takeIf { CODE.matches(it) }
}

fun showCode(c: String) = "${c.take(5)}-${c.drop(5)}"

// An op as the relay keeps and serves it. seq is the device's own count; pos
// is the relay's order, which `since` counts in; epoch, which of the
// object's keys sealed it (absent: 0).
@Serializable
data class WireOp(val id: String, val device: String, val seq: Long, val pos: Long, val epoch: Int? = null, val nonce: String, val ciphertext: String, val ts: String = "")

@Serializable
data class NewOp(val id: String, val seq: Long, val epoch: Int? = null, val nonce: String, val ciphertext: String)

// A log's merged state up to pos upTo, which the ops at or before it are
// replaced by. Only the owner makes one.
@Serializable
data class Snapshot(val upTo: Long, val epoch: Int, val nonce: String, val ciphertext: String)

// A read: a relay before snapshots answers ops and head alone.
@Serializable
data class LogRead(val ops: List<WireOp>, val head: Long, val epoch: Int? = null, val count: Long? = null, val bytes: Long? = null, val snapshot: Snapshot? = null)

@Serializable
data class Ack(val id: String, val pos: Long)

// What a snapshot's record is bound to, beside its object.
fun snapshotLabel(epoch: Int, upTo: Long) = "snapshot:$epoch:$upTo"

// Sharing: the owner's word that a member may read (or write) an object,
// and the hash of the sealed box carrying its key to them, since a sealed
// box says nothing of who sealed it.
val ROLES = listOf("read", "write")

data class Grant(val owner: String, val obj: String, val member: String, val role: String, val epoch: Int, val wrapped: String, val at: Long) : Statement {
    override fun flat() = mapOf("v" to 1, "owner" to owner, "object" to obj, "member" to member, "role" to role, "epoch" to epoch, "wrapped" to wrapped, "at" to at)
    val valid get() = KEY.matches(owner) && OPAQUE.matches(obj) && KEY.matches(member) && role in ROLES && epoch >= 0 && KEY.matches(wrapped)

    companion object {
        fun from(o: JsonObject): Grant {
            require(o.isV1()) { "not a v1 grant" }
            return Grant(o.str("owner"), o.str("object"), o.str("member"), o.str("role"), o.long("epoch").toInt(), o.str("wrapped"), o.long("at"))
        }
    }
}

// A grant's end: the owner's word too.
data class Ungrant(val owner: String, val obj: String, val member: String, val at: Long) : Statement {
    override fun flat() = mapOf("v" to 1, "owner" to owner, "object" to obj, "member" to member, "at" to at)
}

// The account's key changing, signed by the key before it. account is the
// account's id (its first key), which never changes.
data class Rotation(val account: String, val from: String, val to: String, val box: String, val at: Long) : Statement {
    override fun flat() = mapOf("v" to 1, "account" to account, "from" to from, "to" to to, "box" to box, "at" to at)
    val valid get() = KEY.matches(account) && KEY.matches(from) && KEY.matches(to) && KEY.matches(box) && from != to

    companion object {
        fun from(o: JsonObject): Rotation {
            require(o.isV1()) { "not a v1 rotation" }
            return Rotation(o.str("account"), o.str("from"), o.str("to"), o.str("box"), o.long("at"))
        }
    }
}

fun grantBytes(g: Grant) = signed("grant", g.flat())
fun ungrantBytes(u: Ungrant) = signed("ungrant", u.flat())
fun rotationBytes(r: Rotation) = signed("rotation", r.flat())

// What a grant's sealed box holds: the object's key at an epoch, and what
// it is, which the relay never sees.
@Serializable
data class SharedKey(val v: Int = 1, val owner: String, @kotlinx.serialization.SerialName("object") val obj: String, val kind: String, val name: String, val epoch: Int, val key: String)

// An account as the relay shows it to anyone: its id, its key and box key
// now, and the signed statements that get from the id to them.
class AccountView(val id: String, val key: String, val box: String, val creation: Signed<Creation>, val rotations: List<Signed<Rotation>>) {
    companion object {
        fun from(o: JsonObject): AccountView {
            val proof = o["proof"]!!.jsonObject
            return AccountView(
                o.str("id"),
                o.str("key"),
                o.str("box"),
                Signed.parse(proof["creation"]!!) { Creation.from(it) },
                (proof["rotations"] as? kotlinx.serialization.json.JsonArray).orEmpty().map { e -> Signed.parse(e) { Rotation.from(it) } },
            )
        }
    }
}

// The index (Sharing.kt): a record per object the account has.
const val INDEX = "index"
val KINDS = listOf("board", "brain", "memory", INDEX)

// Limits the relay holds clients to (cloud/src/log.ts).
object LIMITS {
    const val op = 64 * 1024
    const val batch = 100
    const val batchBytes = 1024 * 1024
    const val log = 64 * 1024 * 1024
    const val read = 500
    const val blob = 25 * 1024 * 1024
    const val snapshot = 16 * 1024 * 1024
    // When a log is worth compacting: ops, or bytes, kept since its snapshot.
    const val compactOps = 2000
    const val compactBytes = 8 * 1024 * 1024
    const val members = 100
}
