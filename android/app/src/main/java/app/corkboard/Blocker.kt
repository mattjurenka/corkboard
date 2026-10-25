package app.corkboard

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo

// Sees which apps are on screen. A locked one while the gate is shut gets
// the shield over it at once; any other app coming to the front stops a
// meditation in progress.
class Blocker : AccessibilityService() {
    private var shielded = 0L

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val pkg = event.packageName?.toString()
            val cls = event.className?.toString()
            // Only activities: a keyboard, toast or the notification shade
            // isn't another app coming to the front.
            if (pkg != null && cls != null && pkg != packageName && isActivity(pkg, cls)) Meditation.left(this)
        }
        if (!Gate.open()) shieldLocked()
    }

    // Every app window on screen, not only the one that came to the front:
    // a locked app under a dialog of another package's (its permission
    // prompt, a share sheet) or beside another in split screen counts.
    private fun shieldLocked() {
        val apps = runCatching { windows }.getOrNull().orEmpty().filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
        val owners = apps.map { it.root?.packageName?.toString() }
        // The shield itself is up.
        if (apps.zip(owners).any { (w, pkg) -> w.isFocused && pkg == packageName }) return
        val locked = owners.firstOrNull { it in App.store.lockedApps } ?: return
        // Once, not again for the events its own opening sets off.
        if (System.currentTimeMillis() - shielded < 1000) return
        shielded = System.currentTimeMillis()
        startActivity(
            Intent(this, ShieldActivity::class.java)
                .putExtra(ShieldActivity.APP, locked)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION),
        )
    }

    private fun isActivity(pkg: String, cls: String) =
        runCatching { packageManager.getActivityInfo(ComponentName(pkg, cls), 0) }.isSuccess

    override fun onInterrupt() {}

    // On or off, the settings notification follows (Notifications.setup).
    override fun onServiceConnected() = Ticker.update(this)

    override fun onUnbind(intent: Intent?): Boolean {
        // A moment on, once the setting itself says it's off.
        val app = applicationContext
        android.os.Handler(mainLooper).postDelayed({ Notifications.setup(app) }, 1000)
        return super.onUnbind(intent)
    }

    companion object {
        fun enabled(context: Context): Boolean {
            val me = ComponentName(context, Blocker::class.java).flattenToString()
            val on = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
            return on.split(':').any { it.equals(me, ignoreCase = true) }
        }

        @Suppress("DEPRECATION") // the flags overload is API 33
        fun label(context: Context, pkg: String): String = runCatching {
            val pm = context.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        }.getOrDefault(pkg)
    }
}
