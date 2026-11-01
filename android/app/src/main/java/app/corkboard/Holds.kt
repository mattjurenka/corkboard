package app.corkboard

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

// Holds (cloud/src/holds.ts): what brains hold, beside the brains. On top,
// each spawn waiting on you, with what it'd hold, to approve or deny; then
// every hold in a row, marked by whether its secret is set or somewhere,
// tapped to open. The Worker says when a brain changes, and the list is
// read again; the spawns are the fleet's, kept live.

private val HOLD_NAME = Regex("^[\\w.-]{1,64}$")

private fun held(h: Hold) = h.brains.isNotEmpty() || h.templates.isNotEmpty()

@Composable
fun HoldsScreen(go: (Screen) -> Unit) {
    val changed by Repo.brainsChanged.collectAsState()
    val fleet by Repo.fleet.collectAsState()
    val scope = rememberCoroutineScope()
    var holds by remember { mutableStateOf<List<Hold>?>(null) }
    var brains by remember { mutableStateOf<List<Brain>>(emptyList()) }
    var busy by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(changed) {
        try {
            holds = Cloud.holds()
            brains = Cloud.brains(true)
        } catch (e: Exception) {
            error = e.message
        }
    }
    val titles = brains.associate { it.name to it.title }
    val waiting = fleet?.spawns.orEmpty().filter { it.state == "pending-approval" }.sortedBy { it.created }
    fun act(s: Spawn, call: suspend (String) -> Spawn) {
        busy = s.id
        error = null
        scope.launch {
            try {
                Repo.setSpawn(call(s.id))
            } catch (e: Exception) {
                error = e.message
            }
            busy = null
        }
    }
    // What a spawn would hold: its brain's, or else its template's.
    fun holding(s: Spawn): List<String> {
        val all = holds
        return when {
            s.brain != null && all != null -> all.filter { s.brain in it.brains }.map { it.name }
            s.brain != null -> brains.firstOrNull { it.name == s.brain }?.credentials.orEmpty()
            else -> all.orEmpty().filter { "${s.environment}/${s.template}" in it.templates }.map { it.name }
        }
    }

    Page {
        Header("holds", holds?.let { "${it.size} holds" } ?: "asking the Worker…") {
            Box(
                Modifier.width(44.dp).fillMaxHeight().clickable(role = Role.Button) { go(Screen.EditHold(null)) },
                contentAlignment = Alignment.Center,
            ) { Text("+", color = Monokai.cyan, fontWeight = FontWeight.SemiBold) }
        }
        Problem()
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            for ((label, value) in listOf("live" to false, "archived" to true)) {
                Text(label, color = Monokai.base04, modifier = Modifier.clickable(role = Role.Tab) { brainsArchived.value = value; go(Screen.Brains) })
            }
            Text("holds", color = Monokai.cyan, fontWeight = FontWeight.SemiBold)
        }
        Rule(Monokai.base01)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(12.dp))
            if (waiting.isNotEmpty()) {
                Panel("waiting on you", border = Monokai.orange, labelColor = Monokai.orange, end = "${waiting.size}", endColor = Monokai.orange) {
                    for ((i, s) in waiting.withIndex()) {
                        if (i > 0) Rule(Monokai.base01)
                        Waiting(s, s.brain?.let { titles[it] ?: it } ?: s.template, holding(s), busy == s.id, deny = { act(s, Cloud::stop) }, approve = { act(s, Cloud::approve) })
                    }
                }
                Spacer(Modifier.height(16.dp))
            }
            Panel("all", end = holds?.let { "${it.size}" }) {
                val all = holds
                if (all != null && all.isEmpty()) Text("No holds.", color = Monokai.base04, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                for (h in all.orEmpty()) {
                    val holders = h.brains.map { titles[it] ?: it } + h.templates.map { it.substringAfter("/") }
                    PanelRow({ go(Screen.EditHold(h.name)) }) {
                        val (mark, color) = when {
                            !held(h) -> "○" to Monokai.base04
                            h.recorded && (h.secret != null || h.where != null) -> "●" to Monokai.green
                            else -> "◌" to Monokai.orange
                        }
                        Text(mark, color = color)
                        Text(h.name, color = if (held(h)) Monokai.base05 else Monokai.base04, maxLines = 1)
                        Text(holders.joinToString(" · "), style = Small, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Text("›", color = Monokai.base04)
                    }
                }
            }
            error?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(vertical = 12.dp)) }
            Spacer(Modifier.height(16.dp))
        }
    }
}

// A label in a box, to read, not tap.
@Composable
private fun HoldTag(text: String) {
    Text(text, style = Small.copy(color = Monokai.base05), modifier = Modifier.border(1.dp, Monokai.base02).padding(horizontal = 8.dp, vertical = 2.dp))
}

// A spawn waiting on you: who asked, for whom, what it'd hold, when, and
// the start of its task.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Waiting(s: Spawn, forWhom: String, holds: List<String>, busy: Boolean, deny: () -> Unit, approve: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("${s.by.ifEmpty { "?" }} → $forWhom", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(ago(s.created), style = Small, modifier = Modifier.padding(start = 8.dp))
        }
        if (holds.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (h in holds) HoldTag(h)
        }
        if (s.task.isNotBlank()) Text(s.task.trim().lineSequence().take(3).joinToString("\n"), style = Small, maxLines = 3, overflow = TextOverflow.Ellipsis)
        Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Outline("deny", Modifier.weight(1f), color = Monokai.red, border = Monokai.red) { if (!busy) deny() }
            Solid(if (busy) "…" else "approve", Modifier.weight(1f), color = Monokai.green, enabled = !busy, onClick = approve)
        }
    }
}

@Composable
private fun HoldField(
    value: String,
    modifier: Modifier = Modifier,
    single: Boolean = true,
    minHeight: Int = 0,
    secret: Boolean = false,
    hint: String? = null,
    onChange: (String) -> Unit,
) {
    BasicTextField(
        value = value,
        onValueChange = onChange,
        singleLine = single,
        textStyle = LocalTextStyle.current,
        cursorBrush = SolidColor(Monokai.cyan),
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = if (secret) KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false) else KeyboardOptions.Default,
        modifier = modifier.fillMaxWidth().heightIn(min = maxOf(minHeight, 44).dp).padding(horizontal = 12.dp, vertical = 8.dp),
        decorationBox = { inner ->
            Box(contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty() && hint != null) Text(hint, style = Small)
                inner()
            }
        },
    )
}

// A hold to change, or a new one. Its secret is never shown: typed, it's
// set; forget clears it. One not recorded yet is recorded by saving it. A
// change goes with the updated it was read with; if the hold changed since,
// the form shows it as it is now.
@Composable
fun EditHoldScreen(name: String?, back: () -> Unit) {
    val scope = rememberCoroutineScope()
    var was by remember { mutableStateOf<Hold?>(null) }
    var loaded by remember { mutableStateOf(name == null) }
    var newName by remember { mutableStateOf("") }
    var about by remember { mutableStateOf("") }
    var where by remember { mutableStateOf("") }
    var secret by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun fill(h: Hold) {
        was = h
        newName = h.name
        about = h.about
        where = h.where ?: ""
    }
    LaunchedEffect(name) {
        if (name == null) return@LaunchedEffect
        try {
            Cloud.holds().firstOrNull { it.name == name }?.let(::fill) ?: run { error = "no hold $name" }
        } catch (e: Exception) {
            error = e.message
        }
        loaded = true
    }
    val h = was
    val nix = h?.templates.orEmpty().isNotEmpty()
    val nameOk = HOLD_NAME.matches(newName.trim())
    fun send(call: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            try {
                call()
            } catch (e: Cloud.HoldConflict) {
                fill(e.hold.copy(brains = h?.brains.orEmpty(), templates = h?.templates.orEmpty()))
                error = "${e.message}: the form shows it as it is now"
            } catch (e: Exception) {
                error = e.message
            }
            busy = false
        }
    }

    Page {
        Header(if (name == null) "new hold" else "hold", name ?: "")
        Problem()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(12.dp))
            Panel("name", border = if (newName.isEmpty() || nameOk) Monokai.base02 else Monokai.orange) {
                if (nix) Text(newName, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                else HoldField(newName) { newName = it }
            }
            Spacer(Modifier.height(16.dp))
            Panel("about") { HoldField(about, single = false, minHeight = 88) { about = it } }
            Spacer(Modifier.height(16.dp))
            Panel("where") { HoldField(where) { where = it } }
            Spacer(Modifier.height(16.dp))
            Panel("secret") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    HoldField(secret, Modifier.weight(1f), secret = true, hint = h?.secret?.let { "set ${ago(it)}" }) { secret = it }
                    if (h?.secret != null && h.recorded) Text(
                        "forget",
                        color = Monokai.red,
                        modifier = Modifier.heightIn(min = 44.dp).clickable(role = Role.Button, enabled = !busy) {
                            send { was = Cloud.forgetSecret(h.name, h.updated) }
                        }.padding(horizontal = 12.dp, vertical = 12.dp),
                    )
                }
            }
            if (h != null) {
                Spacer(Modifier.height(16.dp))
                Panel("held by") {
                    if (!held(h)) Text("—", style = Small, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                    for (b in h.brains) Text(b, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                    for (t in h.templates) Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                        Text(t, modifier = Modifier.weight(1f))
                        Text("nix", style = Small)
                    }
                }
            }
            error?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(vertical = 12.dp)) }
            Spacer(Modifier.height(16.dp))
        }
        if (confirm && h != null) Footer {
            Outline("no", Modifier.weight(1f), color = Monokai.base04) { confirm = false }
            Solid(if (busy) "…" else "delete ${h.name}", Modifier.weight(1f), color = Monokai.red, enabled = !busy) {
                send {
                    Cloud.deleteHold(h.name)
                    back()
                }
            }
        }
        else Footer {
            Outline("back", color = Monokai.base04, onClick = back)
            if (h != null && !nix) Outline("delete", color = Monokai.red) { confirm = true }
            Solid(if (busy) "…" else "Save ✓", Modifier.weight(1f), color = Monokai.cyan, enabled = !busy && loaded && nameOk && (name == null || h != null)) {
                val n = newName.trim()
                val w = where.trim().ifEmpty { null }
                val s = secret.ifEmpty { null }
                send {
                    when {
                        h == null -> Cloud.createHold(n, about.trim(), w, s)
                        !h.recorded -> {
                            val made = Cloud.createHold(h.name, about.trim(), w, s)
                            if (n != h.name) Cloud.updateHold(h.name, made.updated, n, about.trim(), w, null)
                        }
                        else -> Cloud.updateHold(h.name, h.updated, n.takeIf { it != h.name }, about.trim(), w, s)
                    }
                    back()
                }
            }
        }
    }
}
