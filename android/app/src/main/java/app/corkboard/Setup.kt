package app.corkboard

import android.Manifest
import android.app.AlarmManager
import android.app.AppOpsManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.provider.Settings

// The Android settings corkboard depends on, and which of them are off.
// The setup screen shows them; a notification asks for any that are off
// (Notifications.setup), so turning one off later doesn't go unnoticed.
// Notifications themselves aren't here: with them off, nothing could ask.
object Setup {
    enum class Need(val title: String, val why: String) {
        Usage("Usage access", "sees which app comes to the front, never what's on its screen"),
        Overlay("Display over other apps", "puts the lock over a locked app as it opens"),
        Battery("Unrestricted battery", "so Android doesn't stop the lock in the background"),
        Alarms("Alarms & reminders", "so the meditation's chime and the gate's changes come on time"),
    }

    fun missing(context: Context): List<Need> = Need.entries.filter { !on(context, it) }

    // Whether the app lock can work at all (Watcher).
    fun locking(context: Context) = on(context, Need.Usage) && on(context, Need.Overlay)

    fun on(context: Context, need: Need): Boolean = when (need) {
        Need.Usage -> context.getSystemService(AppOpsManager::class.java)
            .unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
            .let {
                it == AppOpsManager.MODE_ALLOWED ||
                    it == AppOpsManager.MODE_DEFAULT && context.checkSelfPermission(Manifest.permission.PACKAGE_USAGE_STATS) == PackageManager.PERMISSION_GRANTED
            }
        Need.Overlay -> Settings.canDrawOverlays(context)
        Need.Battery -> context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)
        // Granted with the app from Android 13 (USE_EXACT_ALARM), and
        // before 12 there's nothing to grant.
        Need.Alarms -> Build.VERSION.SDK_INT < Build.VERSION_CODES.S || context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
    }
}
