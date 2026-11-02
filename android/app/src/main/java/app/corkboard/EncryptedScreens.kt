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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.corkboard.e2ee.CardChange
import app.corkboard.e2ee.LogEntry
import app.corkboard.e2ee.MergedCard
import app.corkboard.e2ee.Replica
import app.corkboard.e2ee.SharedObject
import app.corkboard.e2ee.showCode
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

// The end-to-end encrypted side (Encrypted.kt), beside the brains: pairing
// this phone, then its boards (from the account's index, or a board's key
// typed in) and what other accounts share with it, read and written
// straight from the relay, which sees none of it.

private val STATUSES = listOf("doing", "review", "ready", "backlog", "done")

private fun short(key: String) = "${key.take(8)}…${key.takeLast(4)}"

// The row of views along the brains tab's top, encrypted lit.
@Composable
fun BrainsRow(go: (Screen) -> Unit, here: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        for ((label, to) in listOf("live" to Screen.Brains, "archived" to Screen.Brains, "holds" to Screen.Holds, "encrypted" to Screen.Encrypted)) {
            Text(
                label,
                color = if (here == label) Monokai.cyan else Monokai.base04,
                fontWeight = if (here == label) FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier.clickable(role = Role.Tab) {
                    if (to == Screen.Brains) brainsArchived.value = label == "archived"
                    go(to)
                },
            )
        }
    }
    Rule(Monokai.base01)
}

@Composable
private fun Field(value: String, modifier: Modifier = Modifier, hint: String = "", onChange: (String) -> Unit) {
    Box(modifier.fillMaxWidth().border(1.dp, Monokai.base02).heightIn(min = 44.dp), contentAlignment = Alignment.CenterStart) {
        if (value.isEmpty() && hint.isNotEmpty()) Text(hint, color = Monokai.base03, modifier = Modifier.padding(horizontal = 12.dp))
        BasicTextField(
            value = value,
            onValueChange = onChange,
            textStyle = LocalTextStyle.current,
            cursorBrush = SolidColor(Monokai.cyan),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun Row2(label: String, value: String) {
    Row(Modifier.padding(horizontal = 12.dp, vertical = 2.dp)) {
        Text(label, style = Small, modifier = Modifier.width(64.dp))
        Text(value, style = Small.copy(color = Monokai.base05), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// Pairing, then the account --------------------------------------------------------

private sealed interface Pairing {
    data object Idle : Pairing
    data class Code(val code: String) : Pairing
    data class Sas(val code: String, val sas: String, val answer: CompletableDeferred<Boolean>) : Pairing
}

@Composable
fun EncryptedScreen(go: (Screen) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val me by Encrypted.me.collectAsState()
    val problem by Encrypted.problem.collectAsState()
    var loaded by remember { mutableStateOf(false) }
    var pairing by remember { mutableStateOf<Pairing>(Pairing.Idle) }
    var job by remember { mutableStateOf<Job?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var boards by remember { mutableStateOf<List<Encrypted.Ref>?>(null) }
    var shared by remember { mutableStateOf<List<SharedObject>?>(null) }
    var unshared by remember { mutableStateOf<List<String>>(emptyList()) }
    var typed by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        withContext(Dispatchers.IO) { runCatching { Encrypted.load(context) }.onFailure { error = it.message } }
        loaded = true
    }
    LaunchedEffect(me) {
        val m = me ?: return@LaunchedEffect
        try {
            boards = Encrypted.call(m) { Encrypted.boards(it) }
            val (ok, bad) = Encrypted.call(m) { Encrypted.shared(it) }
            shared = ok
            unshared = bad
        } catch (e: Exception) {
            error = e.message
        }
    }

    Page {
        Header("encrypted", if (!loaded) "…" else me?.let { "as ${it.name}" } ?: "not paired")
        BrainsRow(go, "encrypted")
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(12.dp))
            val m = me
            if (m == null) when (val p = pairing) {
                Pairing.Idle -> {}
                is Pairing.Code -> Panel("pairing", border = Monokai.cyan, labelColor = Monokai.cyan) {
                    Text(showCode(p.code), fontSize = 28.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                    Text("corkboard-bridge e2ee approve ${showCode(p.code)}", style = Small, modifier = Modifier.padding(horizontal = 12.dp))
                }
                is Pairing.Sas -> Panel("pairing", border = Monokai.yellow, labelColor = Monokai.yellow, end = showCode(p.code)) {
                    Text(p.sas.chunked(3).joinToString(" "), fontSize = 36.sp, fontWeight = FontWeight.ExtraBold, color = Monokai.yellow, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                }
            } else {
                Panel("this phone") {
                    Row2("account", short(m.account))
                    Row2("device", short(m.device.id))
                    Row2("name", m.name)
                }
                Spacer(Modifier.height(16.dp))
                Panel("boards", end = boards?.size?.toString()) {
                    for (b in boards.orEmpty()) PanelRow({ go(Screen.EncryptedBoard(b)) }) {
                        Text(b.name ?: b.obj, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("›", color = Monokai.base04)
                    }
                    Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Field(typed, Modifier.weight(1f), hint = "board key") { typed = it.trim() }
                        Outline("open", color = Monokai.cyan) {
                            val key = typed
                            if (key.isEmpty()) return@Outline
                            scope.launch {
                                try {
                                    val ref = Encrypted.call(m) { Encrypted.addBoard(it, key) }
                                    typed = ""
                                    go(Screen.EncryptedBoard(ref))
                                } catch (e: Exception) {
                                    error = e.message
                                }
                            }
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))
                Panel("shared with you", end = shared?.size?.toString()) {
                    if (shared?.isEmpty() == true && unshared.isEmpty()) Text("Nothing.", color = Monokai.base04, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                    for (s in shared.orEmpty()) PanelRow({ go(if (s.kind == "brain") Screen.SharedBrain(Encrypted.ref(s)) else Screen.EncryptedBoard(Encrypted.ref(s))) }) {
                        Text(s.kind, style = Small, modifier = Modifier.width(48.dp))
                        Text(s.name, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${short(s.owner)} · ${s.role}", style = Small)
                        Text("›", color = Monokai.base04)
                    }
                    for (u in unshared) Text(u, style = Small.copy(color = Monokai.orange), modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp))
                }
            }
            (error ?: problem)?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(vertical = 12.dp)) }
        }
        if (me == null && loaded) when (val p = pairing) {
            Pairing.Idle -> Footer {
                Solid("pair this phone", Modifier.weight(1f), color = Monokai.cyan) {
                    error = null
                    job = scope.launch {
                        try {
                            Encrypted.pair(
                                "phone (${android.os.Build.MODEL})",
                                show = { pairing = Pairing.Code(it) },
                                confirm = { sas ->
                                    val code = (pairing as? Pairing.Code)?.code ?: ""
                                    val answer = CompletableDeferred<Boolean>()
                                    pairing = Pairing.Sas(code, sas, answer)
                                    answer.await()
                                },
                            )
                        } catch (e: kotlinx.coroutines.CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.message
                        }
                        pairing = Pairing.Idle
                    }
                }
            }
            is Pairing.Code -> Footer { Outline("cancel", Modifier.weight(1f), color = Monokai.base04) { job?.cancel(); pairing = Pairing.Idle } }
            is Pairing.Sas -> Footer {
                Outline("no", Modifier.weight(1f), color = Monokai.orange) { p.answer.complete(false) }
                Solid("they match", Modifier.weight(1f), color = Monokai.cyan) { p.answer.complete(true) }
            }
        }
    }
}

// A board ----------------------------------------------------------------------------

// Opens the replica, reads it, and follows it while shown; cards: each time it changes.
@Composable
private fun following(ref: Encrypted.Ref, onError: (String?) -> Unit): Pair<Replica?, List<MergedCard>> {
    val scope = rememberCoroutineScope()
    var rep by remember(ref) { mutableStateOf<Replica?>(null) }
    var cards by remember(ref) { mutableStateOf<List<MergedCard>>(emptyList()) }
    LaunchedEffect(ref) {
        val m = Encrypted.me.value ?: return@LaunchedEffect
        try {
            val r = Encrypted.replica(m, ref)
            rep = r
            cards = r.cards()
            Encrypted.call(m) { r.sync() }
            cards = r.cards()
            onError(null)
            // The owner's clients compact a log grown long.
            if (ref.owner == null && r.worthCompacting) runCatching { r.compact() }
        } catch (e: Exception) {
            onError(e.message)
        }
    }
    DisposableEffect(rep) {
        val r = rep
        val stop = r?.let { rr -> runCatching { rr.live(scope) { cards = rr.cards() } }.getOrNull() }
        onDispose { stop?.invoke() }
    }
    return rep to cards
}

@Composable
fun EncryptedBoardScreen(ref: Encrypted.Ref, go: (Screen) -> Unit, back: () -> Unit) {
    var error by remember { mutableStateOf<String?>(null) }
    val (rep, cards) = following(ref) { error = it }
    val byStatus = cards.groupBy { it.text("status") ?: "backlog" }
    Page {
        Header(ref.name ?: ref.obj, rep?.let { "${cards.size} cards" + if (it.pending > 0) " · ${it.pending} to send" else "" } ?: "…")
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(4.dp))
            for (status in STATUSES + (byStatus.keys - STATUSES.toSet()).sorted()) {
                val these = byStatus[status] ?: continue
                Panel(status, end = "${these.size}", labelColor = if (status == "doing") Monokai.cyan else Monokai.base04) {
                    for ((i, c) in these.sortedBy { it.text("title") ?: it.id }.withIndex()) {
                        if (i > 0) Rule(Monokai.base01)
                        PanelRow({ go(Screen.EncryptedCard(ref, c.id)) }) {
                            Column(Modifier.weight(1f)) {
                                Text(c.text("title") ?: c.id, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text(listOfNotNull(c.id, c.text("priority"), c.log.size.takeIf { it > 0 }?.let { "$it logged" }).joinToString(" · "), style = Small, maxLines = 1)
                            }
                            Text("›", color = Monokai.base04)
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
            }
            if (rep != null && cards.isEmpty()) Text("No cards.", color = Monokai.base04)
            error?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(vertical = 12.dp)) }
        }
        Footer { Outline("back", Modifier.weight(1f), color = Monokai.base04, onClick = back) }
    }
}

private fun show(e: JsonElement): String = when (e) {
    is JsonNull -> "—"
    is JsonPrimitive -> e.content
    is JsonArray -> e.joinToString("  ") { show(it) }
    else -> e.toString()
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun EncryptedCardScreen(ref: Encrypted.Ref, id: String, back: () -> Unit) {
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    val (rep, cards) = following(ref) { error = it }
    val card = cards.firstOrNull { it.id == id }
    var title by remember(card?.text("title")) { mutableStateOf(card?.text("title") ?: "") }
    var status by remember(card?.text("status")) { mutableStateOf(card?.text("status") ?: "backlog") }
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val changed = card != null && (title != (card.text("title") ?: "") || status != (card.text("status") ?: "backlog"))

    fun send(vararg changes: CardChange, after: () -> Unit = {}) {
        val m = Encrypted.me.value ?: return
        busy = true
        error = null
        scope.launch {
            try {
                Encrypted.call(m) { Encrypted.edit(it, ref, *changes) }
                after()
            } catch (e: Exception) {
                // Kept in the replica's queue, and sent with the next push.
                error = e.message
            }
            busy = false
        }
    }

    Page {
        Header(id, ref.name ?: "", null)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(4.dp))
            if (card == null) Text(if (rep == null) "…" else "No such card.", color = Monokai.base04, modifier = Modifier.padding(vertical = 12.dp))
            else {
                Panel("title") {
                    if (ref.write) Field(title, Modifier.padding(horizontal = 12.dp)) { title = it } else Text(title, modifier = Modifier.padding(horizontal = 12.dp))
                }
                Panel("status") {
                    FlowRow(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (s in STATUSES) {
                            val on = s == status
                            Box(
                                Modifier.heightIn(min = 44.dp).border(1.dp, if (on) Monokai.cyan else Monokai.base02)
                                    .clickable(enabled = ref.write, role = Role.Button) { status = s }.padding(horizontal = 12.dp),
                                contentAlignment = Alignment.Center,
                            ) { Text(s, color = if (on) Monokai.base05 else Monokai.base04) }
                        }
                    }
                }
                val rest = card.fields.filterKeys { it != "title" && it != "status" }
                if (rest.isNotEmpty()) Panel("fields") {
                    for ((k, v) in rest.entries.sortedBy { it.key }) {
                        if (k == "body" || k == "description") continue
                        Row2(k, show(v))
                    }
                    (card.text("body") ?: card.text("description"))?.takeIf { it.isNotBlank() }?.let {
                        Markdown(it, Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                    }
                }
                Panel("log", end = "${card.log.size}") {
                    for (e in card.log.takeLast(30)) {
                        Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                            Text("${e.who} · ${ago(e.at).ifEmpty { e.at }}", style = Small)
                            Text(e.note)
                        }
                    }
                    if (ref.write) Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Field(note, Modifier.weight(1f)) { note = it }
                        Outline("log", color = Monokai.cyan) {
                            val text = note.trim()
                            if (text.isEmpty() || busy) return@Outline
                            val who = Encrypted.me.value?.name ?: "phone"
                            send(CardChange.Log(id, LogEntry(java.time.Instant.now().toString(), who, text))) { note = "" }
                        }
                    }
                }
            }
            error?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(vertical = 12.dp)) }
        }
        Footer {
            Outline("back", Modifier.weight(1f), color = Monokai.base04, onClick = back)
            if (ref.write && card != null) Solid(if (busy) "…" else "save", Modifier.weight(1f), color = Monokai.cyan, enabled = changed && !busy) {
                val set = buildMap<String, JsonElement> {
                    if (title != (card.text("title") ?: "")) put("title", JsonPrimitive(title))
                    if (status != (card.text("status") ?: "backlog")) put("status", JsonPrimitive(status))
                }
                send(CardChange.Set(id, set))
            }
        }
    }
}

// A brain shared with this account -------------------------------------------------

@Composable
fun SharedBrainScreen(ref: Encrypted.Ref, back: () -> Unit) {
    var error by remember { mutableStateOf<String?>(null) }
    val (rep, records) = following(ref) { error = it }
    var open by remember { mutableStateOf<String?>(null) }
    val brain = records.firstOrNull { it.id == "brain" }
    val notes = records.filter { it.id.startsWith("note:") }.sortedBy { it.text("title") ?: it.id }
    val entries = records.filter { it.id.startsWith("entry:") }.sortedByDescending { it.text("at") ?: "" }
    Page {
        Header(brain?.text("title") ?: ref.name ?: "brain", ref.owner?.let { "from ${short(it)}" } ?: "")
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(4.dp))
            brain?.text("description")?.takeIf { it.isNotBlank() }?.let { Text(it, modifier = Modifier.padding(vertical = 8.dp)) }
            Panel("notes", end = "${notes.size}") {
                if (rep != null && notes.isEmpty()) Text("None.", color = Monokai.base04, modifier = Modifier.padding(horizontal = 12.dp))
                for ((i, n) in notes.withIndex()) {
                    if (i > 0) Rule(Monokai.base01)
                    PanelRow({ open = if (open == n.id) null else n.id }) {
                        Text(n.text("title") ?: n.id.removePrefix("note:"), modifier = Modifier.weight(1f), color = if (open == n.id) Monokai.cyan else Monokai.base05)
                        n.text("kind")?.let { Text(it, style = Small) }
                    }
                    if (open == n.id) Markdown(n.text("body") ?: "", Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                }
            }
            Spacer(Modifier.height(12.dp))
            Panel("log", end = "${entries.size}") {
                if (rep != null && entries.isEmpty()) Text("None.", color = Monokai.base04, modifier = Modifier.padding(horizontal = 12.dp))
                for (e in entries.take(100)) {
                    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                        Text(listOfNotNull(e.text("day") ?: e.text("at"), e.text("who")).joinToString(" · "), style = Small)
                        Text(e.text("text") ?: "")
                    }
                }
            }
            error?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(vertical = 12.dp)) }
        }
        Footer { Outline("back", Modifier.weight(1f), color = Monokai.base04, onClick = back) }
    }
}
