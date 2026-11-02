package app.corkboard.e2ee

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

// The parts of .agent/plans/e2ee.md's "Next" that a client does: the
// account's index, sharing an object with another account, and the
// account key's rotation. The relay's side is cloud/src/e2ee.ts; the byte
// layouts are Wire.kt's.

// The index -----------------------------------------------------------------------
//
// One object of kind index (name ""), its id and key derived from the root
// like any other's: a record per object the account has, its id the
// object's, fields { kind, name, epoch, key? }. key is there when the
// object's key isn't derived from this root (a random one, after sharing
// or rotation).

class IndexEntry(val obj: String, val kind: String, val name: String, val epoch: Int, val key: String?) {
    // The object's key at its epoch: its own, or derived.
    fun keyFrom(root: ByteArray) = key?.let(::fromB64url) ?: objectKey(root, kind, name)

    fun change() = CardChange.Set(
        obj,
        buildMap {
            put("kind", JsonPrimitive(kind))
            put("name", JsonPrimitive(name))
            put("epoch", JsonPrimitive(epoch))
            if (key != null) put("key", JsonPrimitive(key))
        },
    )

    companion object {
        fun from(c: MergedCard): IndexEntry? {
            val kind = c.text("kind")?.takeIf { it in KINDS && it != INDEX } ?: return null
            return IndexEntry(c.id, kind, c.text("name") ?: return null, safeInt(c.fields["epoch"])?.toInt() ?: 0, c.text("key"))
        }
    }
}

fun indexId(root: ByteArray) = objectId(root, INDEX, "")
fun indexKey(root: ByteArray) = objectKey(root, INDEX, "")

fun entries(index: Replica) = index.cards().mapNotNull(IndexEntry::from)

// Written the first time an object is pushed, and when its key changes.
suspend fun remember(index: Replica, e: IndexEntry) {
    val had = entries(index).firstOrNull { it.obj == e.obj }
    if (had == null || had.epoch != e.epoch || had.key != e.key || had.name != e.name) index.change(e.change())
}

// Accounts as the relay shows them -------------------------------------------------

// The key an account signs with now, if its proof holds: its creation signed
// by its id, then each rotation by the key before it. Null if it doesn't.
fun currentKey(v: AccountView, id: String): String? {
    if (v.id != id || v.creation.body.account != id || !verify(id, creationBytes(v.creation.body), v.creation.sig)) return null
    var key = id
    var box = v.creation.body.box
    for (r in v.rotations) {
        if (!r.body.valid || r.body.account != id || r.body.from != key || !verify(key, rotationBytes(r.body), r.sig)) return null
        key = r.body.to
        box = r.body.box
    }
    return key.takeIf { it == v.key && box == v.box }
}

// Sharing: the member's side ------------------------------------------------------

// An object another account shares with this one, its key opened.
class SharedObject(val owner: String, val obj: String, val kind: String, val name: String, val role: String, val epoch: Int, val key: ByteArray)

// Opens a grant to `me` (this account's keys now), checked: signed by the
// owner's key now, the box the one signed for, and what's in it the
// grant's object and epoch.
fun openGrant(me: AccountKeys, myId: String, g: SharedGrant, owner: AccountView): SharedObject {
    val b = g.grant.body
    val ownerKey = currentKey(owner, b.owner) ?: throw IllegalStateException("${b.owner}'s keys don't chain to its id")
    if (!b.valid || b.member != myId) throw IllegalStateException("that grant isn't to this account")
    if (!verify(ownerKey, grantBytes(b), g.grant.sig)) throw IllegalStateException("that grant isn't signed by its owner")
    val sealed = fromB64url(g.sealed)
    if (b64url(sha256(sealed)) != b.wrapped) throw IllegalStateException("that grant's key isn't the one its owner signed for")
    val k = wireJson.decodeFromString(SharedKey.serializer(), fromUtf8(openSealed(me.box, sealed)))
    if (k.owner != b.owner || k.obj != b.obj || k.epoch != b.epoch || k.kind !in KINDS) throw IllegalStateException("that grant's key is for something else")
    return SharedObject(b.owner, b.obj, k.kind, k.name, b.role, b.epoch, fromB64url(k.key))
}

// Every object shared with this account, newest grant per object; the
// ones that don't check out are left out, with why.
suspend fun sharedWithMe(relay: Relay, me: AccountKeys, myId: String): Pair<List<SharedObject>, List<String>> {
    val views = HashMap<String, AccountView>()
    val ok = mutableListOf<SharedObject>()
    val bad = mutableListOf<String>()
    for (g in relay.sharedWithMe().groupBy { it.grant.body.obj }.values.map { gs -> gs.maxBy { it.grant.body.at } }) {
        try {
            val view = views.getOrPut(g.grant.body.owner) { relay.accountView(g.grant.body.owner) }
            ok += openGrant(me, myId, g, view)
        } catch (e: Exception) {
            bad += "${g.grant.body.obj}: ${e.message}"
        }
    }
    return ok to bad
}

// Sharing: the owner's side --------------------------------------------------------

// The grant and the sealed key for one member.
fun grantTo(owner: AccountKeys, ownerId: String, member: AccountView, obj: String, kind: String, name: String, role: String, epoch: Int, key: ByteArray, at: Long = System.currentTimeMillis()): Pair<Signed<Grant>, String> {
    val memberKey = currentKey(member, member.id) ?: throw IllegalStateException("${member.id}'s keys don't chain to its id")
    if (memberKey != member.key) throw IllegalStateException("${member.id}'s key changed")
    val payload = SharedKey(owner = ownerId, obj = obj, kind = kind, name = name, epoch = epoch, key = b64url(key))
    val sealed = sealTo(fromB64url(member.box), utf8(wireJson.encodeToString(SharedKey.serializer(), payload)))
    val g = Grant(ownerId, obj, member.id, role, epoch, b64url(sha256(sealed)), at)
    return signGrant(owner, g) to b64url(sealed)
}

// Shares an object: first onto a random key at the next epoch if it's still
// on its derived one, so the owner's rotation never has to change a shared
// object's id; then the grant.
suspend fun share(relay: Relay, root: ByteArray, ownerId: String, index: Replica, rep: Replica, kind: String, name: String, member: AccountView, role: String) {
    val had = entries(index).firstOrNull { it.obj == rep.obj }
    var entry = had ?: IndexEntry(rep.obj, kind, name, rep.epoch, null)
    if (entry.key == null) {
        val key = random(32)
        rep.rekey(key)
        entry = IndexEntry(rep.obj, kind, name, rep.epoch, b64url(key))
        remember(index, entry)
        index.push()
    }
    val (g, sealed) = grantTo(accountKeys(root), ownerId, member, rep.obj, kind, name, role, entry.epoch, fromB64url(entry.key!!))
    relay.grant(g, sealed)
}

// Ends a member's grant, then rekeys: a new random key at the next epoch,
// and fresh grants to everyone left. What the removed member had, they keep.
suspend fun unshare(relay: Relay, root: ByteArray, ownerId: String, index: Replica, rep: Replica, member: String) {
    val entry = entries(index).firstOrNull { it.obj == rep.obj } ?: throw IllegalStateException("${rep.obj} isn't in the index")
    relay.ungrant(rep.obj, member)
    val key = random(32)
    rep.rekey(key)
    val next = IndexEntry(rep.obj, entry.kind, entry.name, rep.epoch, b64url(key))
    remember(index, next)
    index.push()
    val owner = accountKeys(root)
    for (g in relay.grants(rep.obj).map { it.grant.body }.filter { it.member != member }.distinctBy { it.member }) {
        val (signed, sealed) = grantTo(owner, ownerId, relay.accountView(g.member), rep.obj, next.kind, next.name, g.role, next.epoch, key)
        relay.grant(signed, sealed)
    }
}

// Rotation --------------------------------------------------------------------------
//
// Revoking a device stops it syncing, but its root still opens everything
// and still derives the account key. Rotation ends that: a new root, every
// object's state written again under it, the relay told the new key, and
// the new root sealed to each device kept.

// For a device whose cert stopped counting: the new root and cert, checked.
// known: the key it knew the account by.
fun checkRotated(r: Rotated, known: String, device: Device): Paired {
    var key = known
    var moved = false
    for (rot in r.rotations) {
        if (rot.body.from != key) continue
        if (!rot.body.valid || !verify(key, rotationBytes(rot.body), rot.sig)) throw IllegalStateException("a rotation isn't signed by the key before it")
        key = rot.body.to
        moved = true
    }
    if (!moved) throw IllegalStateException("no rotation from the key this device knows")
    val root = openSealed(device.box, fromB64url(r.root))
    if (accountKeys(root).id != key) throw IllegalStateException("the new root isn't the rotated account's")
    checkCert(key, r.cert)?.let { throw IllegalStateException(it) }
    if (r.cert.body.device != device.id || r.cert.body.box != b64url(device.box.public)) throw IllegalStateException("the new certificate isn't this device's")
    return Paired(root, r.cert)
}

// A record's state as changes, to write it into another object.
fun changesOf(state: BoardState): List<CardChange> = cards(state).flatMap { c ->
    listOfNotNull(c.fields.takeIf { it.isNotEmpty() }?.let { CardChange.Set(c.id, it) }) + c.log.map { CardChange.Log(c.id, it) }
}

// The opened ops of a queue, as changes.
fun changesOfOps(ops: List<JsonElement>): List<CardChange> = ops.mapNotNull { op ->
    runCatching {
        val c = op.jsonObject["change"]!!.jsonObject
        val card = c.str("card")
        when (c.str("t")) {
            "card" -> CardChange.Set(card, (c["set"] as JsonObject).filterKeys { it != "log" && it != "id" })
            "log" -> c["entry"]!!.jsonObject.let { CardChange.Log(card, LogEntry(jsText(it["at"]), jsText(it["who"]), it.str("note"))) }
            else -> null
        }
    }.getOrNull()
}

// What a rotation needs from its caller: replicas by object (open, under
// the key and epoch given), and somewhere the new root is kept before
// anything else, so a crash can be resumed.
interface Rotating {
    suspend fun replica(root: ByteArray, obj: String, key: ByteArray, epoch: Int): Replica
    suspend fun keepRoot(root: ByteArray)
}

// The rotating device's half. accountId: the account's first key, which
// never changes; keep: the devices to keep (their certs), this one among
// them. Returns the new root, whose phrase is the new recovery phrase.
suspend fun rotate(relay: Relay, root: ByteArray, accountId: String, device: Device, keep: List<DeviceCert>, r: Rotating): Pair<ByteArray, Signed<DeviceCert>> {
    val old = accountKeys(root)
    val fresh = newRoot()
    r.keepRoot(fresh)
    val next = accountKeys(fresh)
    val oldIndex = r.replica(root, indexId(root), indexKey(root), 0)
    oldIndex.sync()
    val newIndex = r.replica(fresh, indexId(fresh), indexKey(fresh), 0)
    val moved = mutableListOf<Pair<Replica, IndexEntry>>()
    for (e in entries(oldIndex)) {
        val rep = r.replica(root, e.obj, e.keyFrom(root), e.epoch)
        rep.sync()
        if (e.key != null) {
            // Shared: the same id, a new random key at the next epoch, its grants sealed again.
            val key = random(32)
            rep.rekey(key)
            remember(newIndex, IndexEntry(e.obj, e.kind, e.name, rep.epoch, b64url(key)))
            for (g in relay.grants(e.obj).map { it.grant.body }.distinctBy { it.member }) {
                val (signed, sealed) = grantTo(next, accountId, relay.accountView(g.member), e.obj, e.kind, e.name, g.role, rep.epoch, key)
                relay.grant(signed, sealed)
            }
        } else {
            val obj = objectId(fresh, e.kind, e.name)
            val into = r.replica(fresh, obj, objectKey(fresh, e.kind, e.name), 0)
            val changes = changesOf(rep.state)
            if (changes.isNotEmpty()) into.change(*changes.toTypedArray())
            into.push()
            remember(newIndex, IndexEntry(obj, e.kind, e.name, 0, null))
            moved += rep to e
        }
    }
    newIndex.push()
    val rotation = signRotation(old, Rotation(accountId, old.id, next.id, b64url(next.box.public), System.currentTimeMillis()))
    val certs = keep.map { certify(next, it.device, fromB64url(it.box), it.name) }
    val roots = keep.associate { it.device to b64url(sealTo(fromB64url(it.box), fresh)) }
    relay.rotate(rotation, certs, roots)
    val mine = certs.first { it.body.device == device.id }
    // Every token ended with the old key: the next call signs in with the new cert.
    relay.cert = mine
    // Anything written meanwhile, then the old logs go.
    for ((rep, e) in moved) {
        val before = rep.cursor
        runCatching { rep.pull() }
        if (rep.cursor > before) {
            val into = r.replica(fresh, objectId(fresh, e.kind, e.name), objectKey(fresh, e.kind, e.name), 0)
            changesOf(rep.state).takeIf { it.isNotEmpty() }?.let { into.change(*it.toTypedArray()); into.push() }
        }
        runCatching { relay.deleteLog(rep.obj) }
    }
    runCatching { relay.deleteLog(oldIndex.obj) }
    return fresh to mine
}
