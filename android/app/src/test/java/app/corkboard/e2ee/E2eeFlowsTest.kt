package app.corkboard.e2ee

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

// The flows, Kotlin on both ends: pairing through a mailbox kept as the
// relay keeps one, and a log that compacts and changes key under a replica.
class E2eeFlowsTest {
    companion object {
        @BeforeClass
        @JvmStatic
        fun load() {
            if (!Na.ready) Na.use(LazySodiumJava(SodiumJava()))
        }
    }

    // A mailbox as cloud/src/mailbox.ts keeps one, its order enforced.
    open class Mailbox(val code: String = "ABCDE12345") : PairTransport {
        var box = MailboxView(code, System.currentTimeMillis() + 60_000)
        override suspend fun create() = NewPairing(code, "s3cret", box.expires)
        override suspend fun view(code: String, secret: String?) = box
        override suspend fun commit(code: String, commit: String) {
            check(box.commit == null)
            box = box.copy(commit = commit)
        }
        override suspend fun join(code: String, secret: String, j: Join) {
            check(box.commit != null && box.join == null)
            box = box.copy(join = j)
        }
        open override suspend fun reveal(code: String, approver: String) {
            check(box.join != null && box.reveal == null)
            box = box.copy(reveal = approver)
        }
        override suspend fun deliver(code: String, d: Delivery) {
            check(box.reveal != null && box.deliver == null)
            box = box.copy(deliver = d)
        }
        override suspend fun cancel(code: String, secret: String?) {
            box = box.copy(expires = 0)
        }
    }

    @Test
    fun pairingGivesTheRootAndACert() = runBlocking {
        val root = newRoot()
        val relay = Mailbox()
        val device = Device.new()
        var newSas = ""
        var oldSas = ""
        val n = async { pairNew(relay, device, "phone", { _, _ -> }, { s -> newSas = s; while (oldSas.isEmpty()) delay(1); s == oldSas }, interval = 1) }
        while (relay.box.expires == 0L) delay(1)
        val cert = approve(relay, root, "abcde-12345", { s, j -> assertEquals("phone", j.name); oldSas = s; while (newSas.isEmpty()) delay(1); s == newSas }, interval = 1)
        val got = n.await()
        assertArrayEquals(root, got.root)
        assertEquals(cert.sig, got.cert.sig)
        assertNull(checkCert(accountKeys(root).id, got.cert))
        assertEquals(device.id, got.cert.body.device)
    }

    @Test
    fun pairingRefusesAnApproverThatChangedItsKey() = runBlocking {
        val relay = object : Mailbox() {
            override suspend fun reveal(code: String, approver: String) = super.reveal(code, "A".repeat(43))
        }
        val n = async { runCatching { pairNew(relay, Device.new(), "phone", { _, _ -> }, { true }, interval = 1) } }
        val o = async { runCatching { approve(relay, newRoot(), "ABCDE12345", { _, _ -> true }, interval = 1) } }
        assertTrue(n.await().exceptionOrNull()?.message!!.contains("committed"))
        o.await()
        Unit
    }

    // A log as cloud/src/log.ts keeps one, with snapshots and epochs.
    class Log : LogTransport {
        val ops = mutableListOf<WireOp>()
        var head = 0L
        var epoch = 0
        var snap: Snapshot? = null
        override suspend fun append(obj: String, ops: List<NewOp>): List<Ack> {
            if (ops.any { (it.epoch ?: 0) != epoch }) throw EpochChanged(epoch)
            return ops.map { n ->
                this.ops.firstOrNull { it.id == n.id }?.let { return@map Ack(it.id, it.pos) }
                val w = WireOp(n.id, "dev", n.seq, ++head, n.epoch, n.nonce, n.ciphertext)
                this.ops += w
                Ack(w.id, w.pos)
            }
        }
        override suspend fun read(obj: String, since: Long, limit: Int?): LogRead {
            val s = snap?.takeIf { since < it.upTo }
            return LogRead(ops.filter { it.pos > maxOf(since, s?.upTo ?: 0) }, head, epoch, ops.size.toLong(), 0, s)
        }
        override suspend fun snapshot(obj: String, s: Snapshot) {
            if (s.upTo > head || s.epoch > epoch && s.upTo != head) throw RelayError(409, "not at the head")
            snap = s
            epoch = s.epoch
            ops.removeAll { it.pos <= s.upTo }
        }
    }

    @Test
    fun compactionAndRekeyingKeepEveryoneReading() = runBlocking {
        val log = Log()
        val k0 = random(32)
        val k1 = random(32)
        val keys = mapOf(0 to k0, 1 to k1)
        val owner = Replica.open(log, k0, "object-id-0000000000", "dev")
        owner.change(CardChange.Set("c", mapOf("title" to JsonPrimitive("one"))))
        owner.push()
        val snap = owner.compact()!!
        assertEquals(1L, snap.upTo)
        assertTrue(log.ops.isEmpty())

        // A member behind the snapshot, with a change queued.
        val member = Replica.open(log, k0, "object-id-0000000000", "dev", keyOf = { keys[it] })
        member.change(CardChange.Log("c", LogEntry("t", "m", "queued")))

        // The owner moves the log to a new key.
        owner.rekey(k1)
        assertEquals(1, owner.epoch)
        // The member's push is refused for its epoch, sealed again, and goes.
        assertEquals(1, member.push())
        member.pull()
        owner.pull()
        val c = owner.cards().single()
        assertEquals("one", c.text("title"))
        assertEquals(listOf("queued"), c.log.map { it.note })
        assertEquals(cardsJson(owner.state).toString(), cardsJson(member.state).toString())
        assertEquals(1, member.epoch)
    }
}
