package app.corkboard

import android.content.Context
import kotlinx.serialization.encodeToString
import java.time.LocalDate
import java.time.LocalTime

// What the phone keeps between runs, in its private preferences: the
// sign-in, the last plan it saw (so the gate still knows with no network),
// today's meditation and the apps to lock.
class Store(context: Context) {
    private val p = context.getSharedPreferences("corkboard", Context.MODE_PRIVATE)

    var auth: Auth?
        get() = p.getString("auth", null)?.let { Cloud.json.decodeFromString<Auth>(it) }
        set(v) = p.edit().putString("auth", v?.let { Cloud.json.encodeToString(it) }).apply()

    var plan: Plan?
        get() = p.getString("plan", null)?.let { runCatching { Cloud.json.decodeFromString<Plan>(it) }.getOrNull() }
        set(v) = p.edit().putString("plan", v?.let { Cloud.json.encodeToString(it) }).apply()

    var lockedApps: Set<String>
        get() = p.getStringSet("lockedApps", null) ?: DEFAULT_LOCKED
        set(v) = p.edit().putStringSet("lockedApps", v).apply()

    // Meditation: seconds banked on medDate, and when the run in progress
    // started (0: none).
    var medDate: String
        get() = p.getString("medDate", "")!!
        set(v) = p.edit().putString("medDate", v).apply()
    var medSeconds: Int
        get() = p.getInt("medSeconds", 0)
        set(v) = p.edit().putInt("medSeconds", v).apply()
    var medRunningSince: Long
        get() = p.getLong("medRunningSince", 0)
        set(v) = p.edit().putLong("medRunningSince", v).apply()

    // An emergency unlock lasts until then, in epoch millis.
    var emergencyUntil: Long
        get() = p.getLong("emergencyUntil", 0)
        set(v) = p.edit().putLong("emergencyUntil", v).apply()

    companion object {
        val DEFAULT_LOCKED = setOf(
            "com.google.android.youtube",
            "com.instagram.android",
            "com.reddit.frontpage",
            "com.twitter.android",
            "com.netflix.mediaclient",
        )
    }
}

fun today(): String = LocalDate.now().toString()

fun minuteNow(): Int = LocalTime.now().let { it.hour * 60 + it.minute }
