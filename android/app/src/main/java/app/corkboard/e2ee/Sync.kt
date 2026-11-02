package app.corkboard.e2ee

import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// A replica of one object's log (lib/e2ee/sync.ts): changes are applied here
// at once, encrypted, and queued; push sends the queue, pull fetches what
// others wrote since, live follows the relay's socket. The queue holds only
// ciphertext and is saved with the rest, so a change made offline goes out
// on the next push.
//
// An op that doesn't open (the wrong key, or changed on the way) is skipped
// and its id kept in rejected.
//
// A log can be compacted: its owner seals the merged state up to a position
// as a snapshot, and the relay drops the ops it covers; a replica behind
// the snapshot takes its state and applies its own queue again on top. An
// object's key can change (sharing it, or a member leaving): each key is an
// epoch, every op says which sealed it, and the relay takes pushes only
// under the log's latest; a refused push gets the new key (keyOf), seals
// the queue again under it, and goes again.

interface LogTransport {
    suspend fun append(obj: String, ops: List<NewOp>): List<Ack>
    suspend fun read(obj: String, since: Long, limit: Int? = null): LogRead
    // Follows from since; returns the way to stop.
    fun subscribe(obj: String, since: Long, on: (List<WireOp>, Snapshot?) -> Unit): (() -> Unit)? = null
    suspend fun snapshot(obj: String, s: Snapshot): Unit = throw UnsupportedOperationException("this transport can't compact a log")
}

// What a transport throws when the log has moved to another key.
class EpochChanged(val epoch: Int) : Exception("the log is on epoch $epoch now")

class Saved(
    var cursor: Long = 0,
    var seq: Long = 0,
    var epoch: Int = 0,
    var state: BoardState = empty(),
    var outbox: MutableList<NewOp> = mutableListOf(),
    val rejected: MutableList<String> = mutableListOf(),
) {
    fun toJson() = JsonObject(
        mapOf(
            "cursor" to JsonPrimitive(cursor),
            "seq" to JsonPrimitive(seq),
            "epoch" to JsonPrimitive(epoch),
            "state" to state.toJson(),
            "outbox" to wireJson.encodeToJsonElement(ListSerializer(NewOp.serializer()), outbox),
            "rejected" to JsonArray(rejected.map(::JsonPrimitive)),
        ),
    )

    companion object {
        fun from(e: JsonElement): Saved {
            val o = e.jsonObject
            return Saved(
                o.long("cursor"),
                o.long("seq"),
                (o["epoch"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0,
                BoardState.from(o["state"]!!) ?: empty(),
                wireJson.decodeFromJsonElement(ListSerializer(NewOp.serializer()), o["outbox"]!!).toMutableList(),
                o["rejected"]!!.jsonArray.map { it.jsonPrimitive.content }.toMutableList(),
            )
        }
    }
}

interface ReplicaStore {
    suspend fun load(): Saved?
    suspend fun save(s: Saved)
}

class MemoryStore : ReplicaStore {
    var saved: JsonElement? = null
    override suspend fun load() = saved?.let { Saved.from(it) }
    override suspend fun save(s: Saved) {
        saved = s.toJson()
    }
}

fun newOpId() = b64url(random(16))

class Replica private constructor(
    private val transport: LogTransport,
    key: ByteArray,
    epoch: Int,
    private val keyOf: (suspend (Int) -> ByteArray?)?,
    val obj: String,
    val device: String,
    private val store: ReplicaStore,
    private val s: Saved,
) {
    private val keys = HashMap<Int, ByteArray>().apply { put(epoch, key) }
    var epoch: Int = maxOf(epoch, s.epoch)
        private set
    // One change, receive or push at a time.
    private val lock = Mutex()

    companion object {
        // key: the key of the epoch given; keyOf: another epoch's, when an
        // op, a snapshot or a refused push names one this hasn't got.
        suspend fun open(
            transport: LogTransport,
            key: ByteArray,
            obj: String,
            device: String,
            store: ReplicaStore = MemoryStore(),
            epoch: Int = 0,
            keyOf: (suspend (Int) -> ByteArray?)? = null,
        ): Replica = Replica(transport, key, epoch, keyOf, obj, device, store, store.load() ?: Saved())
    }

    val cursor get() = s.cursor
    val pending get() = s.outbox.size
    val rejected: List<String> get() = s.rejected
    val state: BoardState get() = s.state

    fun cards() = cards(s.state)

    private suspend fun keyFor(epoch: Int): ByteArray? {
        keys[epoch]?.let { return it }
        val k = keyOf?.invoke(epoch) ?: return null
        keys[epoch] = k
        return k
    }

    private suspend fun useEpoch(epoch: Int): ByteArray {
        val key = keyFor(epoch) ?: throw IllegalStateException("no key for epoch $epoch of $obj")
        this.epoch = maxOf(this.epoch, epoch)
        s.epoch = this.epoch
        return key
    }

    private fun sealOp(key: ByteArray, epoch: Int, id: String, seq: Long, op: JsonElement): NewOp {
        val sealed = sealRecord(key, obj, id, op)
        if (sealed.ciphertext.size > LIMITS.op) throw IllegalArgumentException("op too big (${sealed.ciphertext.size} bytes; ${LIMITS.op} at most)")
        return NewOp(id, seq, epoch.takeIf { it != 0 }, b64url(sealed.nonce), b64url(sealed.ciphertext))
    }

    private suspend fun openOp(id: String, epoch: Int?, nonce: String, ciphertext: String): JsonElement? {
        val key = keyFor(epoch ?: 0) ?: return null
        return runCatching { openRecord(key, obj, id, sealedOf(nonce, ciphertext)) }.getOrNull()
    }

    // Several changes as one save; each is its own op.
    suspend fun change(vararg changes: CardChange): List<String> = lock.withLock {
        val key = keyFor(epoch) ?: throw IllegalStateException("no key for epoch $epoch of $obj")
        val ids = changes.map { change ->
            val id = newOpId()
            val op = opJson(s.state.clock + 1, device, change)
            apply(s.state, id, op)
            s.outbox.add(sealOp(key, epoch, id, ++s.seq, op))
            id
        }
        store.save(s)
        ids
    }

    // The queue, sealed again under the log's new epoch.
    private suspend fun reseal(epoch: Int) {
        val key = useEpoch(epoch)
        s.outbox = s.outbox.mapNotNull { n ->
            if ((n.epoch ?: 0) == epoch) n else openOp(n.id, n.epoch, n.nonce, n.ciphertext)?.let { sealOp(key, epoch, n.id, n.seq, it) }
        }.toMutableList()
        store.save(s)
    }

    // Sends the queue in batches the relay takes; what's acknowledged leaves
    // it. A failure leaves the rest queued, and throws.
    suspend fun push(): Int = lock.withLock {
        var sent = 0
        var resealed = 0
        while (s.outbox.isNotEmpty()) {
            val batch = mutableListOf<NewOp>()
            var bytes = 0
            for (op in s.outbox) {
                if (batch.size >= LIMITS.batch || (batch.isNotEmpty() && bytes + op.ciphertext.length > LIMITS.batchBytes * 0.7)) break
                batch.add(op)
                bytes += op.ciphertext.length + op.nonce.length + op.id.length
            }
            val acks = try {
                transport.append(obj, batch)
            } catch (e: EpochChanged) {
                if (resealed++ > 2) throw e
                reseal(e.epoch)
                continue
            }
            val acked = acks.map { it.id }.toSet()
            s.outbox = s.outbox.filter { it.id !in acked }.toMutableList()
            sent += acked.size
            store.save(s)
            if (acked.isEmpty()) throw IllegalStateException("relay acknowledged none of a push")
        }
        sent
    }

    // The state a snapshot holds, with this replica's queue on top again.
    private suspend fun takeSnapshot(snap: Snapshot): Boolean {
        if (snap.upTo <= s.cursor) return false
        val label = snapshotLabel(snap.epoch, snap.upTo)
        val state = keyFor(snap.epoch)?.let { key -> runCatching { BoardState.from(openRecord(key, obj, label, sealedOf(snap.nonce, snap.ciphertext))) }.getOrNull() }
        if (state == null) {
            s.rejected.add(label)
            return false
        }
        for (n in s.outbox) openOp(n.id, n.epoch, n.nonce, n.ciphertext)?.let { apply(state, n.id, it) }
        s.state = state
        s.cursor = snap.upTo
        if (snap.epoch > epoch) useEpoch(snap.epoch)
        return true
    }

    // Ops as the relay serves them, applied; how many opened (this device's
    // own included: applying one twice changes nothing).
    suspend fun receive(ops: List<WireOp>, snapshot: Snapshot? = null): Int = lock.withLock { receiveLocked(ops, snapshot) }

    private suspend fun receiveLocked(ops: List<WireOp>, snapshot: Snapshot?): Int {
        var n = 0
        if (snapshot != null && takeSnapshot(snapshot)) n++
        for (w in ops) {
            if (w.pos <= s.cursor) continue
            s.cursor = w.pos
            val op = openOp(w.id, w.epoch, w.nonce, w.ciphertext)
            // The device inside is what counts for the merge: the relay's
            // label is only what it was told.
            val inner = ((op as? JsonObject)?.get("device") as? JsonPrimitive)?.content
            if (op == null || inner != w.device || !apply(s.state, w.id, op)) s.rejected.add(w.id) else n++
        }
        return n
    }

    // What the last read said is kept since the snapshot.
    private var kept = Triple(0L, 0L, 0L)

    suspend fun pull(): Int {
        var n = 0
        while (true) {
            val r = transport.read(obj, s.cursor)
            n += lock.withLock {
                val got = receiveLocked(r.ops, r.snapshot)
                if (r.epoch != null && r.epoch > epoch) runCatching { useEpoch(r.epoch) }
                got
            }
            kept = Triple(r.count ?: 0L, r.bytes ?: 0L, r.head)
            if (r.ops.isEmpty() || s.cursor >= r.head) break
        }
        lock.withLock { store.save(s) }
        return n
    }

    suspend fun sync(): Pair<Int, Int> {
        val pushed = push()
        return pushed to pull()
    }

    // Whether the log has grown enough since its snapshot to compact it.
    val worthCompacting get() = kept.first > LIMITS.compactOps || kept.second > LIMITS.compactBytes

    private fun sealState(key: ByteArray, epoch: Int): Snapshot {
        val upTo = s.cursor
        val sealed = sealRecord(key, obj, snapshotLabel(epoch, upTo), s.state.toJson())
        if (sealed.ciphertext.size > LIMITS.snapshot) throw IllegalArgumentException("snapshot too big (${sealed.ciphertext.size} bytes; ${LIMITS.snapshot} at most)")
        return Snapshot(upTo, epoch, b64url(sealed.nonce), b64url(sealed.ciphertext))
    }

    // The log so far as one snapshot: the owner's to do, after a sync, so the
    // state holds exactly the ops up to the cursor.
    suspend fun compact(): Snapshot? {
        sync()
        val snap = lock.withLock {
            if (s.outbox.isNotEmpty() || s.cursor == 0L) return null
            sealState(keyFor(epoch)!!, epoch)
        }
        transport.snapshot(obj, snap)
        kept = Triple(0L, 0L, kept.third)
        return snap
    }

    // The object onto a new key: a snapshot under it at the head of the log,
    // which every member then needs the new key for. Tried again while
    // others write meanwhile.
    suspend fun rekey(key: ByteArray, next: Int = epoch + 1): Snapshot {
        require(next > epoch) { "epoch $next isn't after $epoch" }
        var tries = 0
        while (true) {
            sync()
            val snap = lock.withLock { sealState(key, next) }
            try {
                transport.snapshot(obj, snap)
            } catch (e: RelayError) {
                if (tries++ < 5 && e.status == 409) continue
                throw e
            }
            lock.withLock {
                keys[next] = key
                epoch = next
                s.epoch = next
                store.save(s)
            }
            return snap
        }
    }

    // Follows the relay's socket from the cursor; on: how many opened, each
    // time some come.
    fun live(scope: kotlinx.coroutines.CoroutineScope, on: (Int) -> Unit = {}): () -> Unit {
        return transport.subscribe(obj, s.cursor) { ops, snapshot ->
            scope.launch {
                val n = receive(ops, snapshot)
                lock.withLock { store.save(s) }
                on(n)
            }
        } ?: throw UnsupportedOperationException("this transport can't follow a log")
    }

    // The queue opened, for moving it to another object (rotation).
    suspend fun queued(): List<JsonElement> = lock.withLock { s.outbox.mapNotNull { openOp(it.id, it.epoch, it.nonce, it.ciphertext) } }
}

