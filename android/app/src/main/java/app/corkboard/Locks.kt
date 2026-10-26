package app.corkboard

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri

// Which apps the gate locks: every app in the launcher but the ones left
// open (Store.openApps), corkboard itself and the home screen. While a
// sign-in waits on the browser (Cloud.startSignIn) the browser is let
// through, for ten minutes, since the sign-in happens in it.
object Locks {
    private var launcher: Set<String> = emptySet()
    private var read = 0L

    // The launcher's apps, read again at most once a minute: the blocker
    // asks on every window change.
    fun launcherApps(context: Context): Set<String> {
        if (System.currentTimeMillis() - read > 60_000) {
            launcher = context.packageManager
                .queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
                .map { it.activityInfo.packageName }
                .toSet()
            read = System.currentTimeMillis()
        }
        return launcher
    }

    fun locked(context: Context, pkg: String): Boolean {
        if (pkg == context.packageName || pkg in App.store.openApps || pkg !in launcherApps(context)) return false
        if (pkg == handler(context, Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME))) return false
        val signIn = App.store.pendingSignIn
        if (signIn != null && System.currentTimeMillis() - signIn.at < 10 * 60_000 &&
            pkg == handler(context, Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com")))
        ) return false
        return true
    }

    fun count(context: Context) = launcherApps(context).count { locked(context, it) }

    private fun handler(context: Context, intent: Intent) =
        context.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
}
