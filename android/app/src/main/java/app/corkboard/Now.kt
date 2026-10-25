package app.corkboard

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

// Where the day is: the block now and what comes next, from today's plan.
object Now {
    fun current(plan: Plan?, minute: Int = minuteNow()): Block? =
        plan?.day?.blocks?.firstOrNull { it.start <= minute && minute < it.stop }

    fun next(plan: Plan?, minute: Int = minuteNow(), count: Int = 3): List<Block> =
        plan?.day?.blocks.orEmpty().filter { it.start > minute }.take(count)

    // Epoch millis of a minute today.
    fun at(minute: Int): Long =
        LocalDate.now().atTime(LocalTime.MIDNIGHT).plusMinutes(minute.toLong()).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
}

object Notifications {
    private const val NOW = "now"
    private const val MEDITATE = "meditate"
    private const val SETUP = "setup"
    const val ID_NOW = 1
    const val ID_MEDITATE = 2
    const val ID_SETUP = 3

    fun channels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(NOW, "Now", NotificationManager.IMPORTANCE_LOW).apply {
            description = "The current block, and what's locked"
            setShowBadge(false)
        })
        nm.createNotificationChannel(NotificationChannel(MEDITATE, "Meditation", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "The timer, and when it's done"
            setSound(null, null)
        })
        nm.createNotificationChannel(NotificationChannel(SETUP, "Settings", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "A setting corkboard needs that's off"
        })
    }

    private fun allowed(context: Context) =
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun open(context: Context, screen: String? = null) = PendingIntent.getActivity(
        context,
        screen.hashCode(),
        Intent(context, MainActivity::class.java).putExtra("screen", screen).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun post(context: Context, id: Int, n: Notification) {
        if (allowed(context)) context.getSystemService(NotificationManager::class.java).notify(id, n)
    }

    // The ongoing one: what's locked in the morning, the block during the day.
    fun now(context: Context) {
        val store = App.store
        val plan = store.plan?.takeIf { it.date == today() }
        val b = Notification.Builder(context, NOW)
            .setSmallIcon(R.drawable.ic_lock)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open(context))
        if (!Gate.open(store)) {
            val plan1 = if (Gate.planned(store)) "[x]" else "[ ]"
            val med = Meditation.elapsed(store) / 60
            b.setContentTitle("${store.lockedApps.size} apps locked")
                .setContentText("$plan1 plan the day   [${if (Gate.meditated(store)) "x" else " "}] meditate $med/30m")
            if (!Gate.planned(store)) b.addAction(Notification.Action.Builder(null, "Plan", open(context, "plan")).build())
            if (!Gate.meditated(store)) b.addAction(Notification.Action.Builder(null, "Meditate", open(context, "meditate")).build())
        } else {
            val block = Now.current(plan)
            val next = Now.next(plan, count = 1).firstOrNull()
            if (block == null) {
                b.setContentTitle(if (next != null) "Free until ${clock(next.start)}" else "Nothing planned")
                if (next != null) b.setContentText("next ${clock(next.start)} · ${next.title}")
            } else {
                b.setContentTitle(block.title)
                    .setContentText(listOfNotNull(block.desc, next?.let { "next ${clock(it.start)} · ${it.title}" }).joinToString(" · "))
                    .setWhen(Now.at(block.stop))
                    .setShowWhen(true)
                    .setUsesChronometer(true)
                    .setChronometerCountDown(true)
                    .setProgress(block.stop - block.start, minuteNow() - block.start, false)
            }
        }
        post(context, ID_NOW, b.build())
    }

    // The settings corkboard needs that are off (Setup), until they're on.
    // Pinned while the app lock is off, since nothing is locked then.
    fun setup(context: Context) {
        val missing = Setup.missing(context)
        val nm = context.getSystemService(NotificationManager::class.java)
        if (missing.isEmpty()) return nm.cancel(ID_SETUP)
        val text = missing.joinToString("\n") { "[ ] ${it.title}: ${it.why}" }
        post(
            context, ID_SETUP,
            Notification.Builder(context, SETUP)
                .setSmallIcon(R.drawable.ic_lock)
                .setContentTitle(if (Setup.Need.Accessibility in missing) "The app lock is off" else "corkboard needs ${if (missing.size == 1) "a setting" else "${missing.size} settings"}")
                .setContentText(missing.joinToString(" · ") { it.title })
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setOngoing(Setup.Need.Accessibility in missing)
                .setOnlyAlertOnce(true)
                .setContentIntent(open(context, "setup"))
                .build(),
        )
    }

    fun meditating(context: Context, until: Long) = post(
        context, ID_MEDITATE,
        Notification.Builder(context, MEDITATE)
            .setSmallIcon(R.drawable.ic_lock)
            .setContentTitle("Meditating")
            .setContentText("Leaving the app pauses the timer")
            .setOngoing(true)
            .setWhen(until).setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true)
            .setContentIntent(open(context, "meditate"))
            .build(),
    )

    fun meditationPaused(context: Context, seconds: Int) = post(
        context, ID_MEDITATE,
        Notification.Builder(context, MEDITATE)
            .setSmallIcon(R.drawable.ic_lock)
            .setContentTitle("Meditation paused · ${seconds / 60}/30m")
            .setContentText("You left the app. Come back to carry on.")
            .setContentIntent(open(context, "meditate"))
            .build(),
    )

    fun meditationDone(context: Context) = post(
        context, ID_MEDITATE,
        Notification.Builder(context, MEDITATE)
            .setSmallIcon(R.drawable.ic_lock)
            .setContentTitle("30 minutes done")
            .setContentText(if (Gate.planned()) "Your apps are open." else "Plan the day to open your apps.")
            .setAutoCancel(true)
            .setContentIntent(open(context))
            .build(),
    )
}

// Keeps the ongoing notification, the settings one and the widget current:
// updates them now and sets an alarm for the next change (a block's start
// or end, the end of an emergency unlock, midnight), or in an hour.
object Ticker {
    fun update(context: Context) {
        Notifications.now(context)
        Notifications.setup(context)
        NowWidget.refresh(context)
        val plan = App.store.plan?.takeIf { it.date == today() }
        val minute = minuteNow()
        val edges = plan?.day?.blocks.orEmpty().flatMap { listOf(it.start, it.stop) }.filter { it > minute }
        // At least hourly, so a setting turned off is asked about soon.
        val hour = System.currentTimeMillis() + 60 * 60_000L
        val times = (edges.map { Now.at(it) } + Now.at(24 * 60) + App.store.emergencyUntil + hour)
            .filter { it > System.currentTimeMillis() }
        val at = times.min()
        context.getSystemService(AlarmManager::class.java).setAndAllowWhileIdle(AlarmManager.RTC, at + 1000, tick(context))
    }

    private fun tick(context: Context) = PendingIntent.getBroadcast(
        context, 0, Intent(context, Tick::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
}

// The alarm, a reboot, or the clock changing.
class Tick : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = Ticker.update(context)
}
