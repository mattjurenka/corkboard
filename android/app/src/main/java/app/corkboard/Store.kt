package app.corkboard

import android.content.Context
import kotlinx.serialization.encodeToString
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime

// What the phone keeps between runs, in its private preferences: the
// sign-in, the last plan it saw (so the gate still knows with no network),
// today's meditation and the apps to lock.
class Store(context: Context) {
    private val p = context.getSharedPreferences("corkboard", Context.MODE_PRIVATE)

    var auth: Auth?
        get() = p.getString("auth", null)?.let { Cloud.json.decodeFromString<Auth>(it) }
        set(v) = p.edit().putString("auth", v?.let { Cloud.json.encodeToString(it) }).apply()

    var pendingSignIn: PendingSignIn?
        get() = p.getString("pendingSignIn", null)?.let { Cloud.json.decodeFromString<PendingSignIn>(it) }
        set(v) = p.edit().putString("pendingSignIn", v?.let { Cloud.json.encodeToString(it) }).apply()

    var plan: Plan?
        get() = p.getString("plan", null)?.let { runCatching { Cloud.json.decodeFromString<Plan>(it) }.getOrNull() }
        set(v) = p.edit().putString("plan", v?.let { Cloud.json.encodeToString(it) }).apply()

    // The apps left open while the gate is shut; every other app is locked
    // (Locks), so one installed later starts out locked.
    var openApps: Set<String>
        get() = p.getStringSet("openApps", null) ?: DEFAULT_OPEN
        set(v) = p.edit().putStringSet("openApps", v).apply()

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

    // How the fleet tab shows the fleet: away, project or machine.
    var fleetView: String
        get() = p.getString("fleetView", "away")!!
        set(v) = p.edit().putString("fleetView", v).apply()

    // An emergency unlock lasts until then, in epoch millis.
    var emergencyUntil: Long
        get() = p.getLong("emergencyUntil", 0)
        set(v) = p.edit().putLong("emergencyUntil", v).apply()

    companion object {
        // Email, and what a day can't do without: calls and texts (sign-in
        // codes come by text), signing in, the VPN, getting around, paying,
        // and the phone's own tools.
        val DEFAULT_OPEN = setOf(
            // Email
            "com.google.android.gm", "com.microsoft.office.outlook", "com.samsung.android.email.provider",
            // Calls and texts
            "com.samsung.android.dialer", "com.google.android.dialer", "com.samsung.android.app.contacts",
            "com.google.android.contacts", "com.samsung.android.messaging", "com.google.android.apps.messaging",
            "com.samsung.vvm",
            // Signing in
            "com.onepassword.android", "com.dashlane", "com.duosecurity.duomobile", "com.azure.authenticator",
            "com.yubico.yubioath", "com.google.android.apps.authenticator2",
            // The VPN
            "com.expressvpn.vpn",
            // Getting around
            "com.google.android.apps.maps", "com.ubercab", "com.waymo.carapp", "com.limebike", "com.pgt.veoride",
            "org.valleymetro.app", "net.sharewire.parkmobilev2", "de.kisi.android", "com.thetileapp.tile",
            "com.life360.android.safetymapd",
            // Paying
            "com.google.android.apps.walletnfcrel", "com.samsung.android.spay", "com.octopuscards.nfc_reader",
            // The phone's own
            "com.android.settings", "com.sec.android.app.clockpackage", "com.google.android.deskclock",
            "com.sec.android.app.popupcalculator", "com.google.android.calculator", "com.sec.android.app.camera",
            "com.google.android.GoogleCamera", "com.samsung.android.calendar", "com.google.android.calendar",
            "com.android.stk",
        )
    }
}

// The day turns over at 4am, not midnight, as dayplan's does on the
// laptop: until then it is still the day planned yesterday.
const val DAY_STARTS_HOUR = 4

fun today(): String = LocalDateTime.now().minusHours(DAY_STARTS_HOUR.toLong()).toLocalDate().toString()

// Minutes since the midnight that began today(), so past 1440 before 4am.
fun minuteNow(): Int = LocalTime.now().let { it.hour * 60 + it.minute + if (it.hour < DAY_STARTS_HOUR) 24 * 60 else 0 }
