package app.corkboard

import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.content.ContextCompat

// Sees which app comes to the front, from Android's usage events (Usage
// access): which app opened when, never what's on its screen. A locked one
// while the gate is shut gets the shield over it, which Display over other
// apps lets open from the background; any other app coming to the front
// stops a meditation in progress. It runs in the foreground, the ongoing
// notification its own, and so keeps the process alive for the chimes.
class Watcher : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val poll = Runnable { poll() }
    // The last usage event read, and the app it brought to the front.
    private var seen = 0L
    private var front: String? = null
    private var shielded = 0L

    // Polled only while the screen is on.
    private val screen = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            handler.removeCallbacks(poll)
            if (intent.action == Intent.ACTION_SCREEN_ON) poll()
        }
    }

    override fun onCreate() {
        super.onCreate()
        ContextCompat.registerReceiver(
            this, screen,
            IntentFilter().apply { addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_SCREEN_OFF) },
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        // Which app is in front now, from the last hour's events.
        seen = System.currentTimeMillis() - 60 * 60_000L
        poll()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = Notifications.nowNotification(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(Notifications.ID_NOW, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(Notifications.ID_NOW, n)
        }
        return START_STICKY
    }

    private fun poll() {
        handler.removeCallbacks(poll)
        val now = System.currentTimeMillis()
        // A few seconds back, since an event can be recorded a moment after
        // it happened; ones already read are skipped.
        val events = runCatching { getSystemService(UsageStatsManager::class.java).queryEvents(seen - 3_000, now) }.getOrNull()
        val e = UsageEvents.Event()
        while (events?.hasNextEvent() == true) {
            events.getNextEvent(e)
            if (e.timeStamp <= seen || e.eventType != UsageEvents.Event.ACTIVITY_RESUMED) continue
            seen = e.timeStamp
            front = e.packageName
            if (e.packageName != packageName && e.timeStamp > App.store.medRunningSince) Meditation.left(this)
        }
        if (!Gate.open()) shield(now)
        if (!getSystemService(PowerManager::class.java).isInteractive) return
        // Twice a second while there's something to lock or time; otherwise
        // only to keep up with which app is in front.
        handler.postDelayed(poll, if (!Gate.open() || Meditation.running()) 500 else 5_000)
    }

    private fun shield(now: Long) {
        val locked = front?.takeIf { Locks.locked(this, it) } ?: return
        // Once, not again before the shield's own opening is read.
        if (now - shielded < 1500) return
        shielded = now
        startActivity(
            Intent(this, ShieldActivity::class.java)
                .putExtra(ShieldActivity.APP, locked)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION),
        )
    }

    override fun onDestroy() {
        handler.removeCallbacks(poll)
        unregisterReceiver(screen)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        // Running while it can see and shield, stopped while it can't. Android
        // may refuse a start from the background; the next tick tries again.
        fun sync(context: Context) {
            val intent = Intent(context, Watcher::class.java)
            if (Setup.locking(context)) runCatching { context.startForegroundService(intent) } else context.stopService(intent)
        }
    }
}
