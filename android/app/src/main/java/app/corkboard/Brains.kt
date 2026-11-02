package app.corkboard

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

// Brains (cloud/src/brains.ts): who agents work for, a panel each with its
// title on the border, what it's for and its particulars as labelled rows.
// Tapped, one opens in full, to edit or archive; an archived one, to restore
// or purge, its name typed again. The Worker says when one changes, and the
// list is read again.

private val ABILITIES = listOf("chat")

// Live or archived, kept while the holds view is open beside it.
val brainsArchived = mutableStateOf(false)

private fun plural(n: Int, one: String, many: String) = "${if (n >= 1000) "%.1fk".format(n / 1000.0) else "$n"} ${if (n == 1) one else many}"

@Composable
fun BrainsScreen(go: (Screen) -> Unit) {
    val changed by Repo.brainsChanged.collectAsState()
    val scope = rememberCoroutineScope()
    var archived by brainsArchived
    var brains by remember { mutableStateOf(Cache.read<List<Brain>>("brains-$archived")) }
    var open by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<String?>(null) }
    var typed by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(archived, changed) {
        try {
            brains = Cloud.brains(archived).also { Cache.write("brains-$archived", it) }
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
            Text("holds", color = Monokai.base04, modifier = Modifier.clickable(role = Role.Tab) { go(Screen.Holds) })
        }
        Rule(Monokai.base01)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(12.dp))
            if (brains != null && shown.isEmpty()) Text(if (archived) "None archived." else "No brains.", color = Monokai.base04)
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
    val label = if (b.name == b.title.lowercase()) b.title else "${b.title}  ${b.name}"
    val end = when {
        b.archived != null -> "archived ${ago(b.archived)}"
        b.default -> "● default"
        else -> null
    }
    Panel(
        label,
        Modifier.alpha(if (b.archived != null) 0.6f else 1f).clickable(role = Role.Button, onClick = tap),
        border = if (open) Monokai.cyan else Monokai.base02,
        labelColor = if (open) Monokai.cyan else Monokai.base05,
        end = end,
        endColor = if (b.archived == null) Monokai.base05 else Monokai.base04,
    ) {
        Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (b.description.isNotEmpty()) Text(b.description, maxLines = if (open) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 6.dp))
            val m = b.memory ?: BrainMemory()
            Labelled("memory") {
                if (m.notes + m.entries + m.episodes == 0) Text("empty", style = Small)
                else Text("${plural(m.notes, "note", "notes")} · ${plural(m.entries, "log entry", "log entries")} · ${plural(m.episodes, "session", "sessions")}", style = Small.copy(color = Monokai.base05))
            }
            m.lastEpisode?.let { Labelled("active") { Text(ago(it), style = Small.copy(color = Monokai.base05)) } }
            Labelled("runs as") {
                if (b.account != null) Text(b.account, style = Small.copy(color = Monokai.base05)) else Text("the machine's default account", style = Small)
            }
            if (b.credentials.isNotEmpty()) Labelled("holds") {
                Column {
                    Text(b.credentials.joinToString("  "), style = Small.copy(color = Monokai.base05))
                    Text("agents need your OK to spawn it", style = Small.copy(color = Monokai.orange))
                }
            }
            if (b.abilities.isNotEmpty()) Labelled("can") { Text(b.abilities.joinToString("  "), style = Small.copy(color = Monokai.base05)) }
            if (open) Text(listOfNotNull("made ${ago(b.created)}", "changed ${ago(b.updated)}").joinToString(" · "), style = Small, modifier = Modifier.padding(top = 6.dp))
        }
    }
}

// A label, dim, and its value beside it.
@Composable
private fun Labelled(label: String, value: @Composable () -> Unit) {
    Row {
        Text(label, style = Small, modifier = Modifier.width(64.dp))
        value()
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

private val LABEL = Regex("^[\\w.-]{1,64}$")

// A title as a name: lowercase, dashes, starting with a letter, at most 32.
private fun slug(title: String) =
    title.lowercase().replace(Regex("[^a-z0-9]+"), "-").replace(Regex("^[^a-z]+"), "").take(32).trimEnd('-')

// A tag to tap, lit when it's picked.
@Composable
private fun Tag(text: String, on: Boolean, dashed: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier.heightIn(min = 44.dp)
            .then(if (on) Modifier.background(Monokai.workTint) else Modifier)
            .border(1.dp, if (on) Monokai.cyan else if (dashed) Monokai.base03 else Monokai.base02)
            .clickable(role = Role.Button, onClick = onClick).padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = if (on) Monokai.base05 else Monokai.base04)
    }
}

// Tags, wrapped, then + what, which turns into a field for one: done adds it.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Tags(what: String, onAdd: (String) -> Unit, tags: @Composable () -> Unit) {
    var typing by remember { mutableStateOf<String?>(null) }
    FlowRow(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        tags()
        val t = typing
        if (t == null) Tag("+ $what", on = false, dashed = true) { typing = "" }
        else {
            val add = {
                if (LABEL.matches(t.trim())) onAdd(t.trim())
                typing = null
            }
            Box(Modifier.heightIn(min = 44.dp).width(160.dp).border(1.dp, if (t.isEmpty() || LABEL.matches(t.trim())) Monokai.cyan else Monokai.orange), contentAlignment = Alignment.CenterStart) {
                BasicTextField(
                    value = t,
                    onValueChange = { typing = it },
                    singleLine = true,
                    textStyle = LocalTextStyle.current,
                    cursorBrush = SolidColor(Monokai.cyan),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { add() }),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                )
            }
        }
    }
}

// A new brain, or one to change. The account and what it holds are tags
// from the live brains', or one added; a new brain names itself from its
// title and may start from another, taking its account, what it holds and
// its abilities. A change goes with the updated it was read with; if the
// brain changed since, the form shows it as it is now.
@Composable
fun EditBrainScreen(name: String?, back: () -> Unit) {
    val scope = rememberCoroutineScope()
    var was by remember { mutableStateOf<Brain?>(null) }
    var others by remember { mutableStateOf<List<Brain>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    var named by remember { mutableStateOf(false) }
    var from by remember { mutableStateOf<String?>(null) }
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var account by remember { mutableStateOf<String?>(null) }
    var credentials by remember { mutableStateOf(listOf<String>()) }
    var abilities by remember { mutableStateOf(setOf<String>()) }
    var default by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun fill(b: Brain) {
        was = b
        title = b.title
        description = b.description
        account = b.account
        credentials = b.credentials
        abilities = b.abilities.toSet()
        default = b.default
    }
    fun start(b: Brain?) {
        from = b?.name
        account = b?.account
        credentials = b?.credentials ?: emptyList()
        abilities = b?.abilities?.toSet() ?: emptySet()
    }
    LaunchedEffect(name) {
        try {
            others = Cloud.brains(false)
            if (name != null) others.firstOrNull { it.name == name }?.let(::fill) ?: run { error = "no brain $name" }
        } catch (e: Exception) {
            error = e.message
        }
        loaded = true
    }
    val accounts = (others.mapNotNull { it.account } + listOfNotNull(account)).distinct().sorted()
    val labels = (others.flatMap { it.credentials } + credentials).distinct().sorted()

    Page {
        Header(if (name == null) "new brain" else "brain", name ?: "")
        Problem()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(12.dp))
            if (name == null && others.isNotEmpty()) {
                Panel("start from") {
                    PanelRow({ start(null) }) {
                        Check(from == null)
                        Text("blank")
                    }
                    for (b in others) PanelRow({ start(b) }) {
                        Check(from == b.name)
                        Text("like ${b.title}")
                    }
                }
                Spacer(Modifier.height(16.dp))
            }
            Panel("title") {
                Field(title) {
                    title = it
                    if (name == null && !named) newName = slug(it)
                }
            }
            Spacer(Modifier.height(16.dp))
            if (name == null) {
                Panel("name") {
                    Field(newName) {
                        named = true
                        newName = it.lowercase()
                    }
                }
                Spacer(Modifier.height(16.dp))
            }
            Panel("about") { Field(description, minHeight = 88) { description = it } }
            Spacer(Modifier.height(16.dp))
            Panel("runs as") {
                Tags("account", onAdd = { account = it }) {
                    for (a in accounts) Tag(if (account == a) "● $a" else "○ $a", on = account == a) { account = a }
                    Tag(if (account == null) "● machine default" else "○ machine default", on = account == null) { account = null }
                }
            }
            Spacer(Modifier.height(16.dp))
            Panel("holds") {
                Tags("label", onAdd = { if (it !in credentials) credentials = credentials + it }) {
                    for (l in labels) {
                        val on = l in credentials
                        Tag(if (on) "✓ $l" else "+ $l", on = on) { credentials = if (on) credentials - l else credentials + l }
                    }
                }
                if (credentials.isNotEmpty()) Text(
                    "agents need your OK to spawn it",
                    style = Small.copy(color = Monokai.orange),
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
            Spacer(Modifier.height(16.dp))
            Panel("can") {
                for (a in ABILITIES) PanelRow({ abilities = if (a in abilities) abilities - a else abilities + a }) {
                    Check(a in abilities)
                    Text(a)
                }
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
                    account = account,
                    credentials = credentials,
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
