package app.corkboard

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

// Brains (cloud/src/brains.ts): who agents work for, a panel each with its
// memory and what its agents get. Tapped, one opens to its description and
// egress, to edit or archive; an archived one, to restore or purge, its
// name typed again. The Worker says when one changes, and the list is read
// again.

private val ABILITIES = listOf("chat")

private fun counts(m: BrainMemory?) = m?.let {
    listOfNotNull("${it.notes} notes", "${it.entries} entries", "${it.episodes} episodes", it.lastEpisode?.let { at -> ago(at) }).joinToString(" · ")
}

@Composable
fun BrainsScreen(go: (Screen) -> Unit) {
    val changed by Repo.brainsChanged.collectAsState()
    val scope = rememberCoroutineScope()
    var archived by remember { mutableStateOf(false) }
    var brains by remember { mutableStateOf<List<Brain>?>(null) }
    var open by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<String?>(null) }
    var typed by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(archived, changed) {
        try {
            brains = Cloud.brains(archived)
        } catch (e: Exception) {
            error = e.message
        }
    }
    val shown = brains.orEmpty().filter { archived == (it.archived != null) }
    val selected = shown.firstOrNull { it.name == open }
    fun act(call: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            try {
                call()
                brains = Cloud.brains(archived)
                confirm = null
                typed = ""
            } catch (e: Exception) {
                error = e.message
            }
            busy = false
        }
    }

    Page {
        Header("brains", brains?.let { b -> listOfNotNull("${b.count { it.archived == null }} brains", b.firstOrNull { it.default }?.let { "default ${it.name}" }).joinToString(" · ") } ?: "asking the Worker…")
        Problem()
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            for ((label, value) in listOf("live" to false, "archived" to true)) {
                Text(
                    label,
                    color = if (archived == value) Monokai.cyan else Monokai.base04,
                    fontWeight = if (archived == value) FontWeight.SemiBold else FontWeight.Normal,
                    modifier = Modifier.clickable(role = Role.Tab) { archived = value; open = null; confirm = null },
                )
            }
        }
        Rule(Monokai.base01)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(12.dp))
            if (brains != null && shown.isEmpty()) Text(if (archived) "none archived" else "no brains", color = Monokai.base04)
            for (b in shown) {
                BrainPanel(b, b.name == open) { open = if (open == b.name) null else b.name; confirm = null; typed = ""; error = null }
                Spacer(Modifier.height(16.dp))
            }
            error?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(bottom = 12.dp)) }
        }
        val b = selected
        when {
            b == null -> if (!archived) Footer {
                Solid("New brain +", Modifier.weight(1f), color = Monokai.cyan) { go(Screen.EditBrain(null)) }
            }
            b.archived == null && confirm == "archive" -> Footer {
                Outline("no", Modifier.weight(1f), color = Monokai.base04) { confirm = null }
                Solid(if (busy) "…" else "archive ${b.name}", Modifier.weight(1f), color = Monokai.orange, enabled = !busy) { act { Cloud.archiveBrain(b.name) } }
            }
            b.archived == null -> Footer {
                Outline("archive", Modifier.weight(1f), color = Monokai.orange) { confirm = "archive" }
                Solid("edit", Modifier.weight(1f), color = Monokai.cyan) { go(Screen.EditBrain(b.name)) }
            }
            confirm == "purge" -> Column {
                Rule()
                Text("type ${b.name} to purge it and its memory", style = Small, modifier = Modifier.padding(start = 16.dp, top = 12.dp))
                Field(typed, Modifier.padding(horizontal = 16.dp)) { typed = it }
                Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Outline("no", Modifier.weight(1f), color = Monokai.base04) { confirm = null; typed = "" }
                    Solid(if (busy) "…" else "purge", Modifier.weight(1f), color = Monokai.orange, enabled = !busy && typed.trim() == b.name) { act { Cloud.purgeBrain(b.name) } }
                }
            }
            else -> Footer {
                Outline("purge", Modifier.weight(1f), color = Monokai.orange) { confirm = "purge" }
                Solid(if (busy) "…" else "restore", Modifier.weight(1f), color = Monokai.cyan, enabled = !busy) { act { Cloud.restoreBrain(b.name) } }
            }
        }
    }
}

@Composable
private fun BrainPanel(b: Brain, open: Boolean, tap: () -> Unit) {
    val label = listOfNotNull(b.name, "default".takeIf { b.default }, b.archived?.let { "archived ${ago(it)}" }).joinToString(" · ")
    Panel(label, Modifier.alpha(if (b.archived != null) 0.6f else 1f).clickable(role = Role.Button, onClick = tap)) {
        Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(b.title, color = if (open) Monokai.cyan else Monokai.base05, fontWeight = if (b.default) FontWeight.SemiBold else FontWeight.Normal)
            Text(listOfNotNull(b.account ?: "no account", counts(b.memory)).joinToString(" · "), style = Small)
            val holds = (b.credentials + b.abilities).joinToString(" ")
            if (holds.isNotEmpty()) Text(holds, style = Small)
            if (open) {
                if (b.description.isNotEmpty()) Text(b.description, modifier = Modifier.padding(top = 6.dp))
                if (b.egress.isNotEmpty()) {
                    Text("egress", style = Small, modifier = Modifier.padding(top = 6.dp))
                    for (h in b.egress) Text("  $h", style = Small)
                }
                Text(listOfNotNull("made ${ago(b.created)}", "changed ${ago(b.updated)}").joinToString(" · "), style = Small, modifier = Modifier.padding(top = 6.dp))
            }
        }
    }
}

@Composable
private fun Field(value: String, modifier: Modifier = Modifier, minHeight: Int = 0, onChange: (String) -> Unit) {
    BasicTextField(
        value = value,
        onValueChange = onChange,
        textStyle = LocalTextStyle.current,
        cursorBrush = SolidColor(Monokai.cyan),
        modifier = modifier.fillMaxWidth().heightIn(min = minHeight.dp).padding(horizontal = 12.dp, vertical = 8.dp),
    )
}

private fun words(s: String) = s.split(Regex("[\\s,]+")).filter { it.isNotEmpty() }

// A new brain, or one to change. A change goes with the updated it was read
// with; if the brain changed since, the form shows it as it is now.
@Composable
fun EditBrainScreen(name: String?, back: () -> Unit) {
    val scope = rememberCoroutineScope()
    var was by remember { mutableStateOf<Brain?>(null) }
    var loaded by remember { mutableStateOf(name == null) }
    var newName by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var account by remember { mutableStateOf("") }
    var credentials by remember { mutableStateOf("") }
    var egress by remember { mutableStateOf("") }
    var abilities by remember { mutableStateOf(setOf<String>()) }
    var default by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun fill(b: Brain) {
        was = b
        title = b.title
        description = b.description
        account = b.account.orEmpty()
        credentials = b.credentials.joinToString(" ")
        egress = b.egress.joinToString("\n")
        abilities = b.abilities.toSet()
        default = b.default
    }
    LaunchedEffect(name) {
        if (name == null) return@LaunchedEffect
        try {
            Cloud.brains(true).firstOrNull { it.name == name }?.let(::fill) ?: run { error = "no brain $name" }
        } catch (e: Exception) {
            error = e.message
        }
        loaded = true
    }

    Page {
        Header(if (name == null) "new brain" else "brain", name ?: "")
        Problem()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(12.dp))
            if (name == null) {
                Panel("name") { Field(newName) { newName = it.lowercase() } }
                Spacer(Modifier.height(16.dp))
            }
            Panel("title") { Field(title) { title = it } }
            Spacer(Modifier.height(16.dp))
            Panel("description") { Field(description, minHeight = 88) { description = it } }
            Spacer(Modifier.height(16.dp))
            Panel("account") { Field(account) { account = it.trim() } }
            Spacer(Modifier.height(16.dp))
            Panel("credentials") { Field(credentials) { credentials = it } }
            Spacer(Modifier.height(16.dp))
            Panel("egress") { Field(egress, minHeight = 64) { egress = it } }
            Spacer(Modifier.height(16.dp))
            Panel("abilities") {
                for (a in ABILITIES) PanelRow({ abilities = if (a in abilities) abilities - a else abilities + a }) {
                    Check(a in abilities)
                    Text(a)
                }
            }
            Spacer(Modifier.height(16.dp))
            Panel("default") {
                PanelRow({ default = !default }) {
                    Check(default)
                    Text("default")
                }
            }
            error?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(vertical = 12.dp)) }
            Spacer(Modifier.height(16.dp))
        }
        Footer {
            Outline("back", color = Monokai.base04, onClick = back)
            Solid(if (busy) "…" else "Save ✓", Modifier.weight(1f), color = Monokai.cyan, enabled = !busy && loaded && title.isNotBlank() && (name != null || newName.isNotBlank())) {
                busy = true
                error = null
                val b = Brain(
                    name = name ?: newName.trim(),
                    title = title.trim(),
                    description = description.trim(),
                    account = account.ifEmpty { null },
                    credentials = words(credentials),
                    egress = words(egress),
                    abilities = ABILITIES.filter { it in abilities },
                    default = default,
                    updated = was?.updated ?: "",
                )
                scope.launch {
                    try {
                        if (name == null) Cloud.createBrain(b) else Cloud.updateBrain(b)
                        back()
                    } catch (e: Cloud.BrainConflict) {
                        fill(e.brain)
                        error = "${e.message}: the form shows it as it is now"
                    } catch (e: Exception) {
                        error = e.message
                    }
                    busy = false
                }
            }
        }
    }
}
