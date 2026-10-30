package app.corkboard

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

// Away mode, as the web's (web/src/components/Away.tsx): the fleet gone
// dark but for its Claude Code sessions, listed under their projects, the
// one you last typed in first, and a count under them. What's asking comes up
// on its own at the top. A session or an ask tapped opens it.

// How many finished sessions it shows.
private const val READY = 3

private enum class Look(val glyph: String, val color: Color, val word: String) {
    Needs("▲", Monokai.yellow, "needs you"),
    Working("●", Monokai.cyan, "working"),
    Ready("○", Monokai.base05, "ready"),
    Idle("·", Monokai.base04, "idle"),
}

private fun look(state: String) = when (state) {
    "asking", "permission" -> Look.Needs
    "working", "starting" -> Look.Working
    "idle" -> Look.Ready
    else -> Look.Idle
}

@Composable
fun ColumnScope.Away(f: Fleet?, open: (Bridge, BridgeSession) -> Unit) {
    // The one you last typed in first, and of the finished ones only the
    // last READY; by project, the project of the first first.
    val recent = f?.bridges.orEmpty().flatMap { b -> b.sessions.map { b to it } }
        .sortedByDescending { it.second.typed ?: it.second.since ?: 0L }
    val finished = recent.filter { look(it.second.state) == Look.Ready || look(it.second.state) == Look.Idle }.drop(READY).toSet()
    val sessions = recent.filter { it !in finished }
    val groups = sessions.groupBy { it.second.project.ifEmpty { "—" } }
    val asking = sessions.filter { look(it.second.state) == Look.Needs }
    val approve = f?.spawns.orEmpty().count { it.state == "pending-approval" }
    val counts = listOf(Look.Working, Look.Ready, Look.Needs)
        .mapNotNull { l -> sessions.count { look(it.second.state) == l }.takeIf { it > 0 }?.let { "$it ${l.word}" } }
        .plus(listOfNotNull(approve.takeIf { it > 0 }?.let { "$it to approve" }))
        .joinToString(" · ")
    val breath by rememberInfiniteTransition(label = "breath")
        .animateFloat(1f, 0.35f, infiniteRepeatable(tween(1600), RepeatMode.Reverse), label = "breath")
    Column(
        Modifier.weight(1f).fillMaxSize().background(Color.Black).verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        for ((b, s) in asking) {
            Column(
                Modifier.fillMaxWidth().border(1.dp, Monokai.yellow).clickable(role = Role.Button) { open(b, s) }.padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Text("▲ ${s.project.ifEmpty { "—" }} · ${s.name}", color = Monokai.yellow, fontWeight = FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(s.detail ?: "waiting on you", maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
        if (sessions.isEmpty()) {
            Text("no Claude Code sessions", color = Monokai.base04)
            return@Column
        }
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            for ((project, list) in groups) {
                Column {
                    Text(project, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    for ((b, s) in list) {
                        val l = look(s.state)
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable(role = Role.Button) { open(b, s) }.padding(start = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Text(l.glyph, color = l.color, modifier = Modifier.width(16.dp).then(if (l == Look.Working) Modifier.alpha(breath) else Modifier))
                            Text(s.name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Text(l.word, style = Small.copy(color = l.color))
                            s.since?.takeIf { s.state != "attached" }?.let { Text(agoMs(it), style = Small, textAlign = TextAlign.End, modifier = Modifier.width(44.dp)) }
                        }
                    }
                }
            }
        }
        Text(counts.ifEmpty { "all idle" }, color = Monokai.base04)
    }
}
