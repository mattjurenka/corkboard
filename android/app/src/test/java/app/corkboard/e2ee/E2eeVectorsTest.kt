package app.corkboard.e2ee

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import java.io.File

// app.corkboard.e2ee against what lib/e2ee made (android/e2ee-vectors.ts
// writes the vectors): the same keys, ids, signed bytes, signatures, short
// codes, sealed records and boxes, phrases and merges, byte for byte.
class E2eeVectorsTest {
    companion object {
        lateinit var v: JsonObject

        @BeforeClass
        @JvmStatic
        fun load() {
            Na.use(LazySodiumJava(SodiumJava()))
            Phrase.load(File("src/main/assets/bip39-english.txt").readLines().filter { it.isNotBlank() })
            v = Json.parseToJsonElement(E2eeVectorsTest::class.java.getResource("/e2ee-vectors.json")!!.readText()).jsonObject
        }

        fun hex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
    }

    private fun o(k: String) = v[k]!!.jsonObject
    private fun JsonElement.s(k: String) = jsonObject[k]!!.jsonPrimitive.content
    private val root get() = hex(v["root"]!!.jsonPrimitive.content)
    private fun device() = o("device").let { Device.of(hex(it.s("signSeed")), hex(it.s("boxSecret"))) }
    private fun cert(e: JsonElement) = Signed.parse(e) { DeviceCert.from(it) }

    @Test
    fun keys() {
        for (d in v["derive"]!!.jsonArray) assertEquals(d.s("out"), hex(derive(root, d.s("label"), d.jsonObject["length"]!!.jsonPrimitive.int)))
        val a = accountKeys(root)
        assertEquals(o("account").s("signSeed"), hex(a.sign.secret))
        assertEquals(o("account").s("id"), a.id)
        assertEquals(o("account").s("boxSecret"), hex(a.box.secret))
        assertEquals(o("account").s("box"), b64url(a.box.public))
        for (x in v["objects"]!!.jsonArray) {
            assertEquals(x.s("key"), hex(objectKey(root, x.s("kind"), x.s("name"))))
            assertEquals(x.s("id"), objectId(root, x.s("kind"), x.s("name")))
        }
        assertEquals(indexId(root), v["objects"]!!.jsonArray.first { it.s("kind") == INDEX }.s("id"))
        val d = device()
        assertEquals(o("device").s("id"), d.id)
        assertEquals(o("device").s("box"), b64url(d.box.public))
    }

    @Test
    fun base64urlAndCanonicalJson() {
        for (x in v["b64"]!!.jsonArray) {
            assertEquals(x.s("b64"), b64url(hex(x.s("hex"))))
            assertEquals(x.s("hex"), hex(fromB64url(x.s("b64"))))
        }
        assertThrows(IllegalArgumentException::class.java) { fromB64url("ab+c") }
        for (x in v["canonical"]!!.jsonArray) {
            val flat = x.jsonObject["object"]!!.jsonObject.mapValues { (_, e) ->
                val p = e as JsonPrimitive
                when {
                    p is JsonNull -> null
                    p.isString -> p.content
                    else -> p.long
                }
            }
            assertEquals(x.s("text"), canonical(flat))
        }
    }

    @Test
    fun signedStatements() {
        val a = accountKeys(root)
        val d = device()
        val c = cert(o("cert"))
        assertEquals(o("cert").s("bytes"), fromUtf8(certBytes(c.body)))
        // Ed25519 is deterministic: the same signature, not only a good one.
        assertEquals(o("cert").s("sig"), certify(a, d.id, d.box.public, c.body.name, c.body.issued).sig)
        assertNull(checkCert(a.id, c))
        assertEquals("certificate isn't signed by the account", checkCert(a.id, Signed(c.body.copy(name = "other"), c.sig)))

        val r = Signed.parse(o("revocation")) { Revocation.from(it) }
        assertEquals(o("revocation").s("bytes"), fromUtf8(revocationBytes(r.body)))
        assertEquals(r.sig, revoke(a, r.body.device, r.body.at).sig)
        val revokedCert = certify(a, r.body.device, d.box.public, "gone")
        assertEquals("device is revoked", checkCert(a.id, revokedCert, listOf(r)))

        for (k in listOf("creation", "creationInvite")) {
            val cr = Signed.parse(o(k)) { Creation.from(it) }
            assertEquals(o(k).s("bytes"), fromUtf8(creationBytes(cr.body)))
            assertEquals(cr.sig, creation(a, cr.body.origin, cr.body.invite).sig)
            assertEquals(o(k)["body"]!!.jsonObject, cr.body.toJson())
        }

        val ch = o("challenge")["body"]!!.jsonObject
        val signedAnswer = answer(d, ch.s("origin"), ch.s("nonce"), ch.s("account"))
        assertEquals(o("challenge").s("bytes"), fromUtf8(challengeBytes(signedAnswer.body)))
        assertEquals(o("challenge").s("sig"), signedAnswer.sig)
    }

    @Test
    fun pairing() {
        val p = o("pairing")
        val t = p["transcript"]!!.jsonObject.let { PairTranscript(it.s("code"), it.s("approver"), it.s("box"), it.s("device")) }
        assertEquals(p.s("transcriptBytes"), fromUtf8(transcriptBytes(t)))
        assertEquals(p.s("commitBytes"), fromUtf8(commitBytes(t.approver)))
        assertEquals(p.s("commitment"), commitment(t.approver))
        assertEquals(p.s("sas"), sas(t))
        for (m in p["more"]!!.jsonArray) assertEquals(m.s("sas"), sas(t.copy(code = m.jsonObject["t"]!!.s("code"))))
        val d = device()
        assertEquals(p.s("qr"), qrPayload(t.code, d))
        assertEquals(t.code to b64url(d.box.public), parseQr(p.s("qr")))

        // What TS delivered, this device opens.
        val delivery = wireJson.decodeFromJsonElement(Delivery.serializer(), p["delivery"]!!)
        val got = receive(d, t, delivery)
        assertArrayEquals(root, got.root)
        assertEquals(o("cert").s("sig"), got.cert.sig)
        // And not under another transcript.
        assertThrows(Tampered::class.java) { receive(d, t.copy(code = "ZZZZZZZZZZ"), delivery) }

        // What this side delivers, the same device opens.
        val approver = boxPair(hex(p.s("approverSecret")))
        val mine = deliver(approver, t, root, cert(o("cert")))
        assertArrayEquals(root, receive(d, t, mine).root)

        for (c in v["codes"]!!.jsonArray) {
            val want = c.jsonObject["out"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.content }
            assertEquals(want, normalizeCode(c.s("in")))
        }
    }

    @Test
    fun recordsBlobsAndBoxes() {
        val r = o("record")
        val key = hex(r.s("key"))
        val sealed = sealedOf(r.s("nonce"), r.s("ciphertext"))
        assertEquals(r.s("aad"), fromUtf8(aad(r.s("object"), r.s("op"))))
        val body = openRecord(key, r.s("object"), r.s("op"), sealed)
        assertEquals(Json.parseToJsonElement(r.s("body")), body)
        // Sealed here with TS's nonce: the same ciphertext, so the JSON is the same bytes too.
        assertEquals(r.s("ciphertext"), b64url(sealRecord(key, r.s("object"), r.s("op"), body, sealed.nonce).ciphertext))
        assertThrows(Tampered::class.java) { openRecord(key, r.s("object"), "another-op-id-00000", sealed) }
        val bent = sealed.ciphertext.copyOf().also { it[3] = (it[3].toInt() xor 1).toByte() }
        assertThrows(Tampered::class.java) { openRecord(key, r.s("object"), r.s("op"), Sealed(sealed.nonce, bent)) }

        val b = o("blob")
        assertEquals(b.s("bytes"), hex(openBlob(hex(b.s("key")), b.s("id"), hex(b.s("sealed")))))
        assertThrows(Tampered::class.java) { openBlob(hex(b.s("key")), "another-blob-id-0000", hex(b.s("sealed"))) }
        val again = sealBlob(hex(b.s("key")), b.s("id"), hex(b.s("bytes")))
        assertEquals(b.s("bytes"), hex(openBlob(hex(b.s("key")), b.s("id"), again)))

        val x = o("box")
        val me = KeyPair(hex(x.s("secret")), hex(x.s("public")))
        assertArrayEquals(X25519.publicKey(me.secret), me.public)
        assertEquals(x.s("message"), fromUtf8(openSealed(me, hex(x.s("sealed")))))
        val mine = sealTo(me.public, utf8("from kotlin"))
        assertEquals(32 + 11 + 16, mine.size)
        assertEquals("from kotlin", fromUtf8(openSealed(me, mine)))
        assertThrows(Tampered::class.java) { openSealed(boxPair(random(32)), mine) }

        val l = o("libsodiumBox")
        assertEquals(l.s("message"), fromUtf8(openSealed(KeyPair(hex(l.s("sk")), hex(l.s("pk"))), hex(l.s("c")))))
    }

    @Test
    fun phrases() {
        for (p in v["phrase"]!!.jsonArray) {
            assertEquals(p.s("phrase"), Phrase.of(hex(p.s("root"))))
            assertEquals(p.s("root"), hex(Phrase.root(p.s("phrase"))))
            assertEquals(p.s("root"), hex(Phrase.root("  " + p.s("phrase").uppercase().replace(" ", "\n ") + " ")))
        }
        val words = Phrase.of(root).split(" ").toMutableList()
        words[3] = if (words[3] == "abandon") "ability" else "abandon"
        assertThrows(IllegalArgumentException::class.java) { Phrase.root(words.joinToString(" ")) }
        assertThrows(IllegalArgumentException::class.java) { Phrase.root("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about") }
    }

    @Test
    fun merges() {
        for (m in v["merge"]!!.jsonArray) {
            val ops = m.jsonObject["ops"]!!.jsonArray
            val want = Json.parseToJsonElement(m.s("cards")).toString()
            val s = empty()
            for (op in ops) apply(s, op.s("id"), op.jsonObject["op"]!!)
            assertEquals(want, cardsJson(s).toString())
            assertEquals(m.jsonObject["clock"]!!.jsonPrimitive.long, s.clock)
            // Any order, any repeats: the same.
            val shuffled = (ops + ops.take(10)).shuffled(java.util.Random(7))
            val again = empty()
            for (op in shuffled) apply(again, op.s("id"), op.jsonObject["op"]!!)
            assertEquals(want, cardsJson(again).toString())
            // And through a snapshot's JSON.
            assertEquals(want, cardsJson(BoardState.from(s.toJson())!!).toString())
        }
        // Records are generic: a brain's note:<id> is one.
        val s = empty()
        assertTrue(apply(s, "o1", opJson(1, "d", CardChange.Set("note:x", mapOf("title" to JsonPrimitive("t"))))))
        assertFalse(apply(s, "o2", opJson(1, "d", CardChange.Set("bad id", mapOf()))))
    }

    @Test
    fun replicaReadsWhatTsWrote() = runBlocking {
        val r = o("replica")
        val ops = wireJson.decodeFromJsonElement(ListSerializer(WireOp.serializer()), r["ops"]!!)
        val transport = object : LogTransport {
            override suspend fun append(obj: String, ops: List<NewOp>) = ops.map { Ack(it.id, 0) }
            override suspend fun read(obj: String, since: Long, limit: Int?) = LogRead(ops.filter { it.pos > since }, ops.size.toLong())
        }
        val rep = Replica.open(transport, hex(r.s("key")), r.s("object"), r.s("device"))
        rep.pull()
        assertEquals(Json.parseToJsonElement(r.s("cards")).toString(), cardsJson(rep.state).toString())
        assertEquals(r["rejected"]!!.jsonArray.map { it.jsonPrimitive.content }, rep.rejected)

        // A snapshot TS sealed: a new replica takes it, its own queue on top.
        val snap = o("snapshot")
        val s = Snapshot(snap["upTo"]!!.jsonPrimitive.long, 0, snap.s("nonce"), snap.s("ciphertext"))
        val empty = object : LogTransport {
            override suspend fun append(obj: String, ops: List<NewOp>) = ops.map { Ack(it.id, 0) }
            override suspend fun read(obj: String, since: Long, limit: Int?) = LogRead(emptyList(), s.upTo, 0, 0, 0, s.takeIf { since < it.upTo })
        }
        val fresh = Replica.open(empty, hex(r.s("key")), r.s("object"), "phone-device")
        fresh.change(CardChange.Log("task-2", LogEntry("now", "me", "from the phone")))
        fresh.pull()
        assertEquals(s.upTo, fresh.cursor)
        val cards = fresh.cards().associateBy { it.id }
        assertEquals("done", cards["task-1"]!!.text("status"))
        assertEquals(listOf("from the phone"), cards["task-2"]!!.log.map { it.note })
        // Without the queue, exactly TS's state.
        val plain = Replica.open(empty, hex(r.s("key")), r.s("object"), "x")
        plain.pull()
        assertEquals(Json.parseToJsonElement(snap.s("cards")).toString(), cardsJson(plain.state).toString())
        assertEquals("snapshot:2:41", snapshotLabel(2, 41))
        assertEquals(v["snapshotLabel"]!!.jsonPrimitive.content, snapshotLabel(2, 41))
    }

    @Test
    fun sharing() = runBlocking {
        val sh = o("sharing")
        val owner = accountKeys(root)
        val member = accountKeys(hex(sh.s("memberRoot")))
        assertEquals(sh["member"]!!.s("id"), member.id)
        val g = Signed.parse(sh["grant"]!!) { Grant.from(it) }
        assertEquals(sh["grant"]!!.s("bytes"), fromUtf8(grantBytes(g.body)))
        assertEquals(g.sig, signGrant(owner, g.body).sig)

        // The member opens it, the owner's account proven from its id.
        val view = AccountView(owner.id, owner.id, b64url(owner.box.public), creation(owner, "https://relay.test", null), emptyList())
        val shared = openGrant(member, member.id, SharedGrant(g, sh.s("sealedKey")), view)
        assertEquals("pepper", shared.name)
        assertEquals("brain", shared.kind)
        assertEquals(1, shared.epoch)
        // A box the owner didn't sign for doesn't.
        val (_, other) = grantTo(owner, owner.id, AccountView(member.id, member.id, b64url(member.box.public), creation(member, "https://relay.test", null), emptyList()), shared.obj, "brain", "pepper", "read", 1, random(32))
        assertThrows(IllegalStateException::class.java) { openGrant(member, member.id, SharedGrant(g, other), view) }

        // The brain's records, TS-sealed at epoch 1.
        val b = sh["brain"]!!.jsonObject
        assertEquals(hex(shared.key), b.s("key"))
        val ops = wireJson.decodeFromJsonElement(ListSerializer(WireOp.serializer()), b["ops"]!!)
        val rep = Replica.open(
            object : LogTransport {
                override suspend fun append(obj: String, ops: List<NewOp>) = ops.map { Ack(it.id, 0) }
                override suspend fun read(obj: String, since: Long, limit: Int?) = LogRead(ops.filter { it.pos > since }, ops.size.toLong(), 1)
            },
            shared.key, shared.obj, "member-device", epoch = shared.epoch,
        )
        rep.pull()
        val records = rep.cards().associateBy { it.id }
        assertEquals("ship the phone app", records["note:goals"]!!.text("body"))
        assertEquals("planned the day", records["entry:1"]!!.text("text"))
        assertEquals("Pepper", records["brain"]!!.text("title"))
    }

    @Test
    fun rotation() {
        val rt = o("rotation")
        val a = accountKeys(root)
        val next = accountKeys(hex(rt.s("newRoot")))
        val body = rt["body"]!!.jsonObject.let { Rotation(it.s("account"), it.s("from"), it.s("to"), it.s("box"), it["at"]!!.jsonPrimitive.long) }
        assertEquals(rt.s("bytes"), fromUtf8(rotationBytes(body)))
        assertEquals(rt.s("sig"), signRotation(a, body).sig)
        assertEquals(next.id, body.to)
        val got = checkRotated(Rotated(listOf(Signed(body, rt.s("sig"))), cert(rt["cert"]!!), rt.s("sealedRoot")), a.id, device())
        assertArrayEquals(hex(rt.s("newRoot")), got.root)
        // A rotation someone else signed isn't followed.
        val forged = signRotation(accountKeys(random(32)), body)
        assertThrows(IllegalStateException::class.java) { checkRotated(Rotated(listOf(forged), cert(rt["cert"]!!), rt.s("sealedRoot")), a.id, device()) }
        // The account's proof chains through it.
        val view = AccountView(a.id, next.id, b64url(next.box.public), creation(a, "https://relay.test", null), listOf(Signed(body, rt.s("sig"))))
        assertEquals(next.id, currentKey(view, a.id))
        assertNull(currentKey(AccountView(a.id, next.id, b64url(next.box.public), creation(a, "https://relay.test", null), listOf(forged)), a.id))
    }

    @Test
    fun replicaRoundTripsItsState() = runBlocking {
        val log = mutableListOf<WireOp>()
        val transport = object : LogTransport {
            override suspend fun append(obj: String, ops: List<NewOp>) = ops.map { n ->
                log.firstOrNull { it.id == n.id }?.let { return@map Ack(it.id, it.pos) }
                val w = WireOp(n.id, "dev-a", n.seq, log.size + 1L, n.epoch, n.nonce, n.ciphertext)
                log += w
                Ack(w.id, w.pos)
            }
            override suspend fun read(obj: String, since: Long, limit: Int?) = LogRead(log.filter { it.pos > since }, log.size.toLong())
        }
        val key = random(32)
        val store = MemoryStore()
        val a = Replica.open(transport, key, "object-id-0000000000", "dev-a", store)
        a.change(CardChange.Set("c1", mapOf("title" to JsonPrimitive("one"), "labels" to JsonArray(listOf(JsonPrimitive("x"))))))
        a.change(CardChange.Log("c1", LogEntry("t", "me", "hi")))
        assertEquals(2, a.pending)
        assertEquals(2, a.push())
        val b = Replica.open(transport, key, "object-id-0000000000", "dev-a")
        b.pull()
        assertEquals(cardsJson(a.state).toString(), cardsJson(b.state).toString())
        val reopened = Replica.open(transport, key, "object-id-0000000000", "dev-a", store)
        assertEquals(cardsJson(a.state).toString(), cardsJson(reopened.state).toString())
        assertNotNull(Saved.from(store.saved!!))
    }
}
