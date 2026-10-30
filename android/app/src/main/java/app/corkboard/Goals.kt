package app.corkboard

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The goals, as the day plan's goals view has them (web/src/views/Plan.tsx):
// one at a time, its aim, why and how it's measured, and this week's steps
// below, quieter. The plan screen lists them (GoalsPanel); a goal tapped
// opens here on it.

@Composable
fun GoalsPanel(goals: List<Goal>, open: (String) -> Unit) {
    Panel("goals") {
        goals.forEachIndexed { i, g ->
            if (i > 0) Rule(Monokai.base01)
            PanelRow({ open(g.id) }) {
                Column(Modifier.weight(1f)) {
                    Text(g.name, fontWeight = FontWeight.SemiBold)
                    if (g.aim.isNotEmpty()) Text(g.aim, style = Small, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Text("›", color = Monokai.orange)
            }
        }
    }
}

@Composable
fun GoalsScreen(first: String?, back: () -> Unit) {
    val goals by Repo.goals.collectAsState()
    var at by remember { mutableStateOf(first) }
    LaunchedEffect(Unit) { runCatching { Repo.loadGoals() } }
    val g = goals.firstOrNull { it.id == at } ?: goals.firstOrNull()
    Page {
        Header("goals", "${goals.size}")
        Problem()
        if (goals.size > 1) {
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (x in goals) {
                    val on = x.id == g?.id
                    Box(
                        Modifier.heightIn(min = 44.dp)
                            .border(1.dp, if (on) Monokai.orange else Monokai.base02)
                            .background(if (on) Monokai.base01 else Monokai.base00)
                            .clickable(role = Role.Tab) { at = x.id }
                            .padding(horizontal = 14.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(x.name, color = if (on) Monokai.base05 else Monokai.base04, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal)
                    }
                }
            }
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            if (g == null) {
                Spacer(Modifier.height(20.dp))
                Text("No goals yet. Pepper keeps them as goal notes.", color = Monokai.base04)
                return@Column
            }
            Spacer(Modifier.height(16.dp))
            Text(g.name, fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.ExtraBold)
            if (g.aim.isNotEmpty()) Text(g.aim, color = Monokai.orange, modifier = Modifier.padding(top = 6.dp))
            if (g.why.isNotEmpty()) Text(g.why, modifier = Modifier.padding(top = 12.dp))
            if (g.measures.isNotEmpty()) {
                Spacer(Modifier.height(16.dp))
                Panel("measured by") {
                    for (m in g.measures) Line("›", m)
                }
            }
            if (g.week.isNotEmpty()) {
                Spacer(Modifier.height(16.dp))
                Panel(listOfNotNull("this week", g.weekOf?.let { "from $it" }).joinToString(" · ")) {
                    for (w in g.week) Line("·", w, Monokai.base04)
                }
            }
            Spacer(Modifier.height(16.dp))
        }
        Footer {
            Outline("back", color = Monokai.base04, onClick = back)
        }
    }
}

@Composable
private fun Line(mark: String, text: String, color: androidx.compose.ui.graphics.Color = Monokai.base05) {
    Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(mark, color = Monokai.base04)
        Text(text, color = color)
    }
}
