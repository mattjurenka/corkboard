package app.corkboard

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

// The look: corkboard's, monospace and box-drawn, in the stylix theme's
// colours (Monokai, from ~/.config/stylix/palette.json).
object Monokai {
    val base00 = Color(0xFF272822)
    val base01 = Color(0xFF383830)
    val base02 = Color(0xFF49483E)
    val base03 = Color(0xFF75715E)
    val base04 = Color(0xFFA59F85)
    val base05 = Color(0xFFF8F8F2)
    val orange = Color(0xFFFD971F) // base09: locked, still to do
    val yellow = Color(0xFFF4BF75) // base0A
    val cyan = Color(0xFF66D9EF) // base0D: planned work, done
    val purple = Color(0xFFAE81FF) // base0E: Pepper
    val workTint = Color(0xFF304341) // cyan over base00
}

@OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
private fun mono(weight: Int) = Font(
    R.font.jetbrains_mono,
    weight = FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
)

val Mono = FontFamily(mono(400), mono(600), mono(800))

@Composable
fun CorkboardTheme(content: @Composable () -> Unit) {
    CompositionLocalProvider(
        LocalTextStyle provides TextStyle(fontFamily = Mono, fontSize = 14.sp, lineHeight = 20.sp, color = Monokai.base05),
        content = content,
    )
}

val Small = TextStyle(fontFamily = Mono, fontSize = 12.sp, lineHeight = 16.sp, color = Monokai.base04)

// The bar along the top: where you are on the left, the time on the right.
@Composable
fun Header(title: String, sub: String) {
    val minute by ticking()
    Row(
        Modifier.fillMaxWidth().height(40.dp).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
        Text(" ─ $sub", style = Small, modifier = Modifier.weight(1f))
        Text(clock(minute), style = Small)
    }
    Rule()
}

@Composable
fun Rule(color: Color = Monokai.base02) = Box(Modifier.fillMaxWidth().height(1.dp).background(color))

// The minute of the day, updated as it turns.
@Composable
fun ticking(): androidx.compose.runtime.State<Int> {
    val state = remember { androidx.compose.runtime.mutableIntStateOf(minuteNow()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(60_000L - System.currentTimeMillis() % 60_000L)
            state.intValue = minuteNow()
        }
    }
    return state
}

// A box with its label set into the top border, like a TUI panel.
@Composable
fun Panel(label: String, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Box(modifier.padding(top = 8.dp)) {
        Column(
            Modifier.fillMaxWidth().border(1.dp, Monokai.base02).padding(top = 14.dp, bottom = 8.dp),
            content = content,
        )
        Text(
            label,
            style = Small,
            modifier = Modifier.offset(x = 10.dp, y = (-8).dp).background(Monokai.base00).padding(horizontal = 6.dp),
        )
    }
}

// A row in a panel that does something: at least 56dp tall to tap.
@Composable
fun PanelRow(onClick: (() -> Unit)? = null, content: @Composable RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

@Composable
fun Check(done: Boolean) = Text(if (done) "[x]" else "[ ]", color = if (done) Monokai.cyan else Monokai.base04)

@Composable
fun Solid(text: String, modifier: Modifier = Modifier, color: Color = Monokai.orange, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        modifier.heightIn(min = 52.dp).background(if (enabled) color else Monokai.base02)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = Monokai.base00, fontWeight = FontWeight.ExtraBold)
    }
}

@Composable
fun Outline(text: String, modifier: Modifier = Modifier, color: Color = Monokai.base05, border: Color = Monokai.base02, onClick: () -> Unit) {
    Box(
        modifier.heightIn(min = 52.dp).border(1.dp, border).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = color)
    }
}

// A bar of `of` cells with `done` filled: the meditation's minutes.
@Composable
fun Cells(done: Int, of: Int, perRow: Int, color: Color) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        for (row in 0 until (of + perRow - 1) / perRow) {
            Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                for (i in row * perRow until minOf(of, (row + 1) * perRow)) {
                    Box(Modifier.weight(1f).height(20.dp).background(if (i < done) color else Monokai.base01))
                }
            }
        }
    }
}

// Seconds, ticking while `running`.
@Composable
fun seconds(running: Boolean, read: () -> Int): Int {
    var value by remember { mutableIntStateOf(read()) }
    LaunchedEffect(running) {
        value = read()
        while (running) {
            delay(1000)
            value = read()
        }
    }
    return value
}
