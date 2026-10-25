package app.corkboard

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.RingtoneManager

// The morning gate: the locked apps open once today's plan is accepted and
// 30 minutes of meditation are done, or for a while after an emergency
// unlock.
object Gate {
    fun planned(store: Store = App.store): Boolean = store.plan?.let { it.date == today() && it.accepted != null } == true

    fun meditated(store: Store = App.store): Boolean = Meditation.elapsed(store) >= Meditation.GOAL

    fun open(store: Store = App.store): Boolean =
        (planned(store) && meditated(store)) || store.emergencyUntil > System.currentTimeMillis()

    const val EMERGENCY_MINUTES = 15

    fun emergency(context: Context) {
        App.store.emergencyUntil = System.currentTimeMillis() + EMERGENCY_MINUTES * 60_000L
        Ticker.update(context)
    }
}

// The meditation timer. It runs in the app, and keeps running with the
// screen off, but stops the moment another app comes to the front (Blocker
// tells it). Seconds are banked per day; a run in progress is the time
// since medRunningSince.
object Meditation {
    const val GOAL = 30 * 60

    private fun rollover(store: Store) {
        if (store.medDate != today()) {
            store.medDate = today()
            store.medSeconds = 0
            store.medRunningSince = 0
        }
    }

    fun running(store: Store = App.store) = store.medDate == today() && store.medRunningSince != 0L

    fun elapsed(store: Store = App.store): Int {
        if (store.medDate != today()) return 0
        val run = if (store.medRunningSince != 0L) ((System.currentTimeMillis() - store.medRunningSince) / 1000).toInt() else 0
        return minOf(GOAL, store.medSeconds + run)
    }

    fun start(context: Context) {
        val store = App.store
        rollover(store)
        if (running(store) || elapsed(store) >= GOAL) return
        store.medRunningSince = System.currentTimeMillis()
        val remaining = GOAL - store.medSeconds
        alarms(context).setExactAndAllowWhileIdle(
            AlarmManager.RTC_WAKEUP,
            System.currentTimeMillis() + remaining * 1000L,
            done(context),
        )
        Notifications.meditating(context, System.currentTimeMillis() + remaining * 1000L)
    }

    fun pause(context: Context) {
        val store = App.store
        if (!running(store)) return
        store.medSeconds = elapsed(store)
        store.medRunningSince = 0
        alarms(context).cancel(done(context))
        Notifications.meditationPaused(context, store.medSeconds)
    }

    // Another app came to the front.
    fun left(context: Context) {
        if (running()) pause(context)
    }

    fun finish(context: Context) {
        val store = App.store
        if (!running(store)) return
        store.medSeconds = GOAL
        store.medRunningSince = 0
        RingtoneManager.getRingtone(context, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))?.play()
        Notifications.meditationDone(context)
        Ticker.update(context)
    }

    private fun alarms(context: Context) = context.getSystemService(AlarmManager::class.java)

    private fun done(context: Context) = PendingIntent.getBroadcast(
        context, 1, Intent(context, MeditationDone::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
}

class MeditationDone : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = Meditation.finish(context)
}
