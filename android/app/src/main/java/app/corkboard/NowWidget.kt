package app.corkboard

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontFamily
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import kotlinx.coroutines.launch

// The home-screen widget: the block now and the next two, or what's left
// to unlock in the morning.
class NowWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { Content() }
    }

    @Composable
    private fun Content() {
        val store = App.store
        val plan = store.plan?.takeIf { it.date == today() }
        val minute = minuteNow()
        Column(
            GlanceModifier.fillMaxSize().background(Monokai.base00).cornerRadius(24.dp).padding(16.dp)
                .clickable(actionStartActivity<MainActivity>()),
        ) {
            if (!Gate.open(store)) {
                Label("LOCKED", Monokai.orange)
                Spacer(GlanceModifier.height(6.dp))
                Line(if (Gate.planned(store)) "[x]" else "[ ]", "plan the day")
                Line(if (Gate.meditated(store)) "[x]" else "[ ]", "meditate ${Meditation.elapsed(store) / 60}/30m")
                return@Column
            }
            val block = Now.current(plan, minute)
            if (block != null) {
                Label("NOW · ${clock(block.start)}–${clock(block.stop)}", Monokai.cyan)
                Spacer(GlanceModifier.height(4.dp))
                Text(block.title, maxLines = 2, style = mono(16, Monokai.base05, bold = true))
                Text("${length(block.stop - minute)} left", style = mono(12, Monokai.base04))
            } else {
                Label("FREE", Monokai.base04)
            }
            Spacer(GlanceModifier.height(8.dp))
            for (b in Now.next(plan, minute, 2)) Line(clock(b.start), b.title)
        }
    }

    @Composable
    private fun Label(text: String, color: Color) = Text(text, style = mono(12, color))

    @Composable
    private fun Line(left: String, right: String) = Row {
        Text(left, style = mono(12, Monokai.base04))
        Spacer(GlanceModifier.width(8.dp))
        Text(right, maxLines = 1, style = mono(12, Monokai.base05))
    }

    private fun mono(size: Int, color: Color, bold: Boolean = false) = TextStyle(
        color = ColorProvider(color),
        fontSize = size.sp,
        fontFamily = FontFamily.Monospace,
        fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
    )

    companion object {
        fun refresh(context: Context) {
            Repo.scope.launch { runCatching { NowWidget().updateAll(context) } }
        }
    }
}

class NowWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = NowWidget()
}
