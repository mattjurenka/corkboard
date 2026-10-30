package app.corkboard

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.min
import kotlin.math.sin

// Soft chimes while the meditation runs, on its own clock: a low bell on
// each whole minute, a lighter one at :15, :30 and :45 in between. The 30:00
// chime is Meditation.finish's. A wake lock keeps them coming with the
// screen off; the Watcher service keeps the process alive.
object Chimes {
    private const val RATE = 44_100
    private const val QUARTER = 15_000L

    private val handler = Handler(Looper.getMainLooper())
    private val ring = Runnable { ring() }
    private var wake: PowerManager.WakeLock? = null
    private var minute: AudioTrack? = null
    private var quarter: AudioTrack? = null

    // Start or stop the chimes to match whether the meditation is running.
    fun sync(context: Context) {
        handler.removeCallbacks(ring)
        if (Meditation.running()) {
            if (wake == null) {
                wake = context.getSystemService(PowerManager::class.java)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "corkboard:chimes")
                    .apply { acquire(Meditation.GOAL * 1000L + 60_000) }
            }
            if (minute == null) minute = track(bell(392.0, listOf(1.0 to 1.0, 2.0 to 0.35, 3.01 to 0.12), 4.0, 0.28))
            if (quarter == null) quarter = track(bell(1046.5, listOf(1.0 to 1.0, 2.0 to 0.2), 1.6, 0.14))
            next()
        } else {
            wake?.takeIf { it.isHeld }?.release()
            wake = null
            minute?.release(); minute = null
            quarter?.release(); quarter = null
        }
    }

    private fun next() {
        val ms = Meditation.elapsedMillis()
        val at = (ms / QUARTER + 1) * QUARTER
        if (at < Meditation.GOAL * 1000L) handler.postDelayed(ring, at - ms)
    }

    private fun ring() {
        if (!Meditation.running()) return sync(App.instance)
        val s = ((Meditation.elapsedMillis() + 500) / 1000).toInt()
        if (s >= Meditation.GOAL) return
        (if (s % 60 == 0) minute else quarter)?.run {
            stop()
            reloadStaticData()
            play()
        }
        next()
    }

    // A struck bell: partials (frequency ratio to strength) fading
    // exponentially, the higher ones faster, after a short soft attack.
    private fun bell(freq: Double, partials: List<Pair<Double, Double>>, seconds: Double, volume: Double): ShortArray {
        val n = (RATE * seconds).toInt()
        val total = partials.sumOf { it.second }
        return ShortArray(n) { i ->
            val t = i.toDouble() / RATE
            val attack = min(1.0, t / 0.008)
            val v = partials.sumOf { (ratio, strength) ->
                strength * exp(-t * ratio * 4.0 / seconds) * sin(2 * PI * freq * ratio * t)
            }
            (v / total * attack * volume * Short.MAX_VALUE).toInt().toShort()
        }
    }

    private fun track(samples: ShortArray): AudioTrack = AudioTrack.Builder()
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
        .setTransferMode(AudioTrack.MODE_STATIC)
        .setBufferSizeInBytes(samples.size * 2)
        .build()
        .apply { write(samples, 0, samples.size) }
}
