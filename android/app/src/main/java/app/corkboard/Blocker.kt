package app.corkboard

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent

// Sees each app that comes to the front. A locked one while the gate is
// shut gets the shield over it at once; any other app stops a meditation
// in progress.
class Blocker : AccessibilityService() {
    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return
        val cls = event.className?.toString() ?: return
        // Only activities: a keyboard, toast or the notification shade
        // isn't another app coming to the front.
        if (!isActivity(pkg, cls)) return
        if (pkg != packageName) Meditation.left(this)
        if (pkg in App.store.lockedApps && !Gate.open()) {
            startActivity(
                Intent(this, ShieldActivity::class.java)
                    .putExtra(ShieldActivity.APP, pkg)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION),
            )
        }
    }

    private fun isActivity(pkg: String, cls: String) =
        runCatching { packageManager.getActivityInfo(ComponentName(pkg, cls), 0) }.isSuccess

    override fun onInterrupt() {}

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
