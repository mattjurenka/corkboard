package app.corkboard.e2ee

import com.goterl.lazysodium.LazySodium
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

// The primitives, all libsodium's (through lazysodium) but SHA-256 and HMAC,
// which are the JDK's: XChaCha20-Poly1305-IETF for records, Ed25519 for
// signatures, X25519, and crypto_box_seal for wrapping. Nothing here is
// made up; lib/e2ee uses the same constructions through @noble.
//
// The library is given once (Na.use): lazysodium-android's on the phone,
// lazysodium-java's in the JVM tests.
object Na {
    @Volatile
    private var lib: LazySodium? = null

    fun use(l: LazySodium) {
        l.sodiumInit()
        lib = l
    }

    val ready get() = lib != null

    internal val s: LazySodium get() = lib ?: throw IllegalStateException("libsodium isn't loaded (Na.use)")
}

private val rng = SecureRandom()

fun random(n: Int): ByteArray = ByteArray(n).also { rng.nextBytes(it) }

fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray =
    Mac.getInstance("HmacSHA256").run {
        // An empty salt is HKDF's zeros, which SecretKeySpec won't take empty.
        init(SecretKeySpec(if (key.isEmpty()) ByteArray(32) else key, "HmacSHA256"))
        doFinal(data)
    }

// RFC 5869, as @noble/hashes' hkdf(sha256, ikm, salt, info, length).
fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
    require(length in 1..255 * 32) { "hkdf: bad length" }
    val prk = hmacSha256(salt, ikm)
    val out = ByteArray(length)
    var t = ByteArray(0)
    var at = 0
    var i = 1
    while (at < length) {
        t = hmacSha256(prk, concat(t, info, byteArrayOf(i.toByte())))
        val n = minOf(t.size, length - at)
        t.copyInto(out, at, 0, n)
        at += n
        i++
    }
    return out
}

class Tampered(what: String) : Exception("$what: doesn't decrypt (wrong key, or changed)")

object Ed25519 {
    // The public key of a 32-byte seed.
    fun publicKey(seed: ByteArray): ByteArray {
        require(seed.size == 32) { "an Ed25519 seed is 32 bytes" }
        val pk = ByteArray(32)
        val sk = ByteArray(64)
        check(Na.s.cryptoSignSeedKeypair(pk, sk, seed)) { "crypto_sign_seed_keypair failed" }
        sk.fill(0)
        return pk
    }

    fun sign(seed: ByteArray, message: ByteArray): ByteArray {
        val pk = ByteArray(32)
        val sk = ByteArray(64)
        check(Na.s.cryptoSignSeedKeypair(pk, sk, seed)) { "crypto_sign_seed_keypair failed" }
        val sig = ByteArray(64)
        check(Na.s.cryptoSignDetached(sig, message, message.size.toLong(), sk)) { "crypto_sign_detached failed" }
        sk.fill(0)
        return sig
    }

    fun verify(public: ByteArray, message: ByteArray, sig: ByteArray): Boolean =
        public.size == 32 && sig.size == 64 && Na.s.cryptoSignVerifyDetached(sig, message, message.size, public)
}

object X25519 {
    fun publicKey(secret: ByteArray): ByteArray {
        require(secret.size == 32) { "an X25519 key is 32 bytes" }
        val pk = ByteArray(32)
        check(Na.s.cryptoScalarMultBase(pk, secret)) { "crypto_scalarmult_base failed" }
        return pk
    }

    // Refuses a low-order point, as both libsodium and @noble do.
    fun shared(secret: ByteArray, public: ByteArray): ByteArray {
        require(secret.size == 32 && public.size == 32) { "an X25519 key is 32 bytes" }
        val out = ByteArray(32)
        if (!Na.s.cryptoScalarMult(out, secret, public)) throw Tampered("key exchange")
        return out
    }
}

// crypto_aead_xchacha20poly1305_ietf.
object XChaCha {
    const val NONCE = 24
    const val TAG = 16

    fun encrypt(key: ByteArray, nonce: ByteArray, plaintext: ByteArray, data: ByteArray): ByteArray {
        require(key.size == 32 && nonce.size == NONCE) { "XChaCha20-Poly1305 takes a 32-byte key and a 24-byte nonce" }
        val c = ByteArray(plaintext.size + TAG)
        val n = LongArray(1)
        check(Na.s.cryptoAeadXChaCha20Poly1305IetfEncrypt(c, n, plaintext, plaintext.size.toLong(), data, data.size.toLong(), null, nonce, key)) { "encrypt failed" }
        return c
    }

    fun decrypt(key: ByteArray, nonce: ByteArray, ciphertext: ByteArray, data: ByteArray): ByteArray? {
        if (key.size != 32 || nonce.size != NONCE || ciphertext.size < TAG) return null
        val m = ByteArray(ciphertext.size - TAG)
        val n = LongArray(1)
        return if (Na.s.cryptoAeadXChaCha20Poly1305IetfDecrypt(m, n, null, ciphertext, ciphertext.size.toLong(), data, data.size.toLong(), nonce, key)) m else null
    }
}

// crypto_box_seal: an anonymous box to an X25519 key.
object SealedBox {
    const val OVERHEAD = 32 + 16

    fun seal(recipient: ByteArray, message: ByteArray): ByteArray {
        require(recipient.size == 32) { "an X25519 key is 32 bytes" }
        val c = ByteArray(message.size + OVERHEAD)
        check(Na.s.cryptoBoxSeal(c, message, message.size.toLong(), recipient)) { "crypto_box_seal failed" }
        return c
    }

    fun open(secret: ByteArray, public: ByteArray, sealed: ByteArray): ByteArray {
        if (sealed.size < OVERHEAD) throw Tampered("sealed box")
        val m = ByteArray(sealed.size - OVERHEAD)
        if (!Na.s.cryptoBoxSealOpen(m, sealed, sealed.size.toLong(), public, secret)) throw Tampered("sealed box")
        return m
    }
}
