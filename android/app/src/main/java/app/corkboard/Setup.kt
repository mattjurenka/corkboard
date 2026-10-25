package app.corkboard

import android.app.AlarmManager
import android.content.Context
import android.os.Build
import android.os.PowerManager

// The Android settings corkboard depends on, and which of them are off.
// The setup screen shows them; a notification asks for any that are off
// (Notifications.setup), so turning one off later doesn't go unnoticed.
// Notifications themselves aren't here: with them off, nothing could ask.
object Setup {
    enum class Need(val title: String, val why: String) {
        Accessibility("Accessibility", "sees which app comes to the front, the moment it opens"),
        Battery("Unrestricted battery", "so Android doesn't stop the blocker in the background"),
        Alarms("Alarms & reminders", "so the meditation's chime and the gate's changes come on time"),
    }

    fun missing(context: Context): List<Need> = Need.entries.filter { !on(context, it) }

    fun on(context: Context, need: Need): Boolean = when (need) {
        Need.Accessibility -> Blocker.enabled(context)
        Need.Battery -> context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)
        // Granted with the app from Android 13 (USE_EXACT_ALARM), and
        // before 12 there's nothing to grant.
        Need.Alarms -> Build.VERSION.SDK_INT < Build.VERSION_CODES.S || context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
    }
}
