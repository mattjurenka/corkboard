package app.corkboard

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// One of a bridge's Claude Code sessions, from the fleet. One whose log is
// on its bridge's machine opens as its conversation (Conversation, below). Any other,
// as what its terminal shows, looked at again every couple of seconds while
// it's open, and a line to type into it. Send types the line and enter; the
// keys along the top go on their own, for Claude Code's menus. Both go
// through the Worker to the bridge, and its page's Neovim
// (corkboard/away.lua).

private val SCREEN = 11.sp

// For what JetBrains Mono doesn't draw: Claude Code's ⏵⏵ and ⏸, its ✻ and ✢.
private val Symbols = FontFamily(Font(R.font.noto_sans_symbols2))

// A line as its characters, each with its run (null: the default).
private class Cells(val chars: List<String>, val styles: List<List<Double>?>)

private fun cells(line: String, runs: List<List<Double>>?): Cells {
    val chars = mutableListOf<String>()
    var i = 0
    while (i < line.length) {
        val n = Character.charCount(line.codePointAt(i))
        chars += line.substring(i, i + n)
        i += n
    }
    val styles = MutableList<List<Double>?>(chars.size) { null }
    var at = 0
    for (r in runs.orEmpty()) {
        val n = r[0].toInt()
        for (k in at until minOf(at + n, chars.size)) styles[k] = r
        at += n
    }
    return Cells(chars, styles)
}

// A line wider than the phone wraps, but a rule (Claude Code's ───── above
// and below its prompt) gives up its longest run of ─ instead.
private fun fit(line: Cells, cols: Int): Cells {
    val size = line.chars.size
    if (size <= cols) return line
    var best = 0 until 0
    var start = -1
    for (k in 0..size) {
        val rule = k < size && line.chars[k] in setOf("─", "━", "═")
        if (rule && start < 0) start = k
        if (!rule && start >= 0) {
            if (k - start > best.count()) best = start until k
            start = -1
        }
    }
    if (best.count() * 2 < size) return line
    val cut = best.first until best.first + minOf(size - cols, best.count() - 1)
    return Cells(line.chars.filterIndexed { k, _ -> k !in cut }, line.styles.filterIndexed { k, _ -> k !in cut })
}

// The 16 colors where its Neovim doesn't say: base16 Monokai.
private val ANSI = listOf(
    0xFF272822, 0xFFF92672, 0xFFA6E22E, 0xFFF4BF75, 0xFF66D9EF, 0xFFAE81FF, 0xFFA1EFE4, 0xFFF8F8F2,
    0xFF75715E, 0xFFF92672, 0xFFA6E22E, 0xFFF4BF75, 0xFF66D9EF, 0xFFAE81FF, 0xFFA1EFE4, 0xFFF9F8F5,
).map { Color(it) }

// A step of the 256 colors' 6×6×6 cube.
private fun level(x: Long) = if (x == 0L) 0 else (55 + 40 * x).toInt()

// fg or bg as vt.lua has it: -1 the default, 0-255 the palette, 2^24 + rgb.
private fun termColor(v: Double, palette: List<Color>): Color? {
    val n = v.toLong()
    return when {
        n < 0 -> null
        n < 16 -> palette[n.toInt()]
        n < 232 -> (n - 16).let { i -> Color(level(i / 36), level(i / 6 % 6), level(i % 6)) }
        n < 256 -> (8 + 10 * (n - 232)).toInt().let { Color(it, it, it) }
        else -> Color(0xFF000000 or (n and 0xFFFFFF))
    }
}

private fun style(r: List<Double>?, palette: List<Color>): SpanStyle? {
    r ?: return null
    val flags = r[3].toInt()
    var fg = termColor(r[1], palette)
    var bg = termColor(r[2], palette)
    if (flags and 16 != 0) {
        val was = fg
        fg = bg ?: Monokai.base00
        bg = was ?: Monokai.base05
    }
    val lines = listOfNotNull(TextDecoration.Underline.takeIf { flags and 8 != 0 }, TextDecoration.LineThrough.takeIf { flags and 32 != 0 })
    return SpanStyle(
        color = (fg ?: Monokai.base05).let { if (flags and 2 != 0) it.copy(alpha = 0.6f) else it },
        background = bg ?: Color.Unspecified,
        fontWeight = if (flags and 1 != 0) FontWeight.SemiBold else null,
        fontStyle = if (flags and 4 != 0) FontStyle.Italic else null,
        textDecoration = if (lines.isEmpty()) null else TextDecoration.combine(lines),
    )
}

// Whether JetBrains Mono has a character, asked once a character.
@Composable
private fun rememberDrawn(): (String) -> Boolean {
    val context = LocalContext.current
    return remember {
        val paint = android.graphics.Paint().apply { typeface = context.resources.getFont(R.font.jetbrains_mono) }
        val known = HashMap<String, Boolean>()
        val drawn: (String) -> Boolean = { ch -> ch.length == 1 && ch[0].code < 0x2000 || known.getOrPut(ch) { paint.hasGlyph(ch) } }
        drawn
    }
}

private fun screen(lines: List<Cells>, palette: List<Color>, drawn: (String) -> Boolean) = buildAnnotatedString {
    lines.forEachIndexed { k, line ->
        if (k > 0) append("\n")
        line.chars.forEachIndexed { i, ch ->
            val s = style(line.styles[i], palette)
            val symbol = !drawn(ch)
            when {
                s == null && !symbol -> append(ch)
                else -> withStyle((s ?: SpanStyle()).let { if (symbol) it.merge(SpanStyle(fontFamily = Symbols)) else it }) { append(ch) }
            }
        }
    }
}

private val KEYS = listOf("esc" to "esc", "↑" to "up", "↓" to "down", "tab" to "tab", "⇧tab" to "shift-tab", "⏎" to "enter", "^C" to "ctrl-c")

@Composable
fun SessionScreen(at: Screen.Session, back: () -> Unit) {
    val fleet by Repo.fleet.collectAsState()
    val bridge = fleet?.bridges?.firstOrNull { it.id == at.bridge }
    val s = bridge?.sessions?.firstOrNull { it.key == at.key }
    // Once a conversation, a conversation still when it ends.
    var terminal by remember(at) { mutableStateOf(false) }
    if (s?.attach == true) terminal = true
    if (terminal) Conversation(at, s, bridge?.machine, back) else Lines(at, s, bridge, fleet, back)
}

@Composable
private fun Lines(at: Screen.Session, s: BridgeSession?, bridge: Bridge?, fleet: Fleet?, back: () -> Unit) {
    val scope = rememberCoroutineScope()
    var terminal by remember { mutableStateOf<Terminal?>(null) }
    var text by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    // Bumped to look again now rather than at the next tick.
    var again by remember { mutableIntStateOf(0) }
    val dictation = rememberDictation(onHeard = { text = it; error = null }, onError = { error = it })

    LaunchedEffect(at, s != null, again) {
        while (s != null) {
            try {
                terminal = Cloud.terminal(at.bridge, s)
                error = null
            } catch (e: Exception) {
                error = e.message
            }
            delay(2_000)
        }
    }

    fun type(line: String, keys: List<String>) {
        val session = s ?: return
        scope.launch {
            try {
                Cloud.type(at.bridge, session, line, keys)
                error = null
            } catch (e: Exception) {
                if (line.isNotEmpty()) text = line
                error = e.message
            }
            delay(300)
            again++
        }
    }

    // Kept at the bottom, as a terminal is, unless scrolled up. Only a
    // scroll decides that: the screen growing under it doesn't.
    val down = rememberScrollState()
    var stick by remember { mutableStateOf(true) }
    LaunchedEffect(down) {
        snapshotFlow { down.isScrollInProgress to down.value }.collect { (moving, at) -> if (moving) stick = at >= down.maxValue - 24 }
    }
    LaunchedEffect(down) { snapshotFlow { down.maxValue }.collect { if (stick) down.scrollTo(it) } }

    Page {
        Header(
            s?.name ?: "session",
            if (s == null) (if (fleet == null) "asking the Worker…" else "ended")
            else listOfNotNull(s.state, s.project, s.vm ?: s.host ?: bridge?.machine).joinToString(" · "),
        )
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            // JetBrains Mono's advance is 0.6 of its size.
            val cols = with(LocalDensity.current) { ((maxWidth - 24.dp).toPx() / (SCREEN.toPx() * 0.6f)).toInt() }
            val drawn = rememberDrawn()
            Column(Modifier.fillMaxSize().verticalScroll(down).padding(12.dp)) {
                val t = terminal
                when {
                    t == null -> Text(if (s == null) "" else "…", color = Monokai.base04)
                    else -> {
                        val palette = t.palette?.mapNotNull { runCatching { Color(android.graphics.Color.parseColor(it)) }.getOrNull() }?.takeIf { it.size == 16 } ?: ANSI
                        val text = remember(t, cols) { screen(t.lines.mapIndexed { k, l -> fit(cells(l, t.colors?.getOrNull(k)), cols) }, palette, drawn) }
                        Text(text, style = Small.copy(color = Monokai.base05, fontSize = SCREEN, lineHeight = 14.sp))
                    }
                }
            }
        }
        s?.detail?.let { Text(it, color = Monokai.yellow, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp), maxLines = 3) }
        error?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
        Rule()
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for ((label, key) in KEYS) {
                Text(
                    label,
                    color = if (s == null) Monokai.base02 else Monokai.base05,
                    modifier = Modifier.border(1.dp, Monokai.base02).clickable(enabled = s != null, role = Role.Button) { type("", listOf(key)) }
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
        }
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Outline("back", color = Monokai.base04, onClick = back)
            Row(
                Modifier.weight(1f).heightIn(min = 52.dp).border(1.dp, Monokai.base02).padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("› ", color = Monokai.cyan)
                BasicTextField(
                    value = text,
                    onValueChange = { text = it },
                    textStyle = androidx.compose.material3.LocalTextStyle.current,
                    cursorBrush = SolidColor(Monokai.cyan),
                    modifier = Modifier.weight(1f),
                    maxLines = 5,
                )
                if (dictation.available) {
                    Text(
                        if (dictation.listening) "stop" else "mic",
                        color = if (dictation.listening) Monokai.orange else Monokai.base04,
                        modifier = Modifier.clickable(role = Role.Button) { dictation.toggle(text) }.padding(start = 12.dp, top = 8.dp, bottom = 8.dp),
                    )
                }
            }
            Solid("send", color = Monokai.cyan, enabled = s != null && text.isNotBlank()) {
                dictation.stop()
                val line = text.trim()
                text = ""
                type(line, listOf("enter"))
            }
        }
    }
}

// A session's conversation, drawn here at the phone's own size from its log
// (bridge/remote.ts), live: what you said, what Claude said, each tool with
// the start of how it went (tapped, the rest). The laptop's terminal is left
// as it is. What's typed here goes into the session as if typed there; a
// permission prompt or a question gets its answers as buttons, which press
// the number Claude Code's menu has for each.

@Composable
private fun Conversation(at: Screen.Session, s: BridgeSession?, machine: String?, back: () -> Unit) {
    val scope = rememberCoroutineScope()
    val items = remember { androidx.compose.runtime.mutableStateListOf<Turn>() }
    val results = remember { androidx.compose.runtime.mutableStateMapOf<String, Turn>() }
    var socket by remember { mutableStateOf<WebSocket?>(null) }
    var following by remember { mutableStateOf(false) }
    var ended by remember { mutableStateOf<String?>(null) }
    var tries by remember { mutableIntStateOf(0) }
    var open by remember { mutableStateOf<String?>(null) }
    var text by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val dictation = rememberDictation(onHeard = { text = it; error = null }, onError = { error = it })
    val list = androidx.compose.foundation.lazy.rememberLazyListState()

    fun take(batch: List<Turn>, reset: Boolean) {
        if (reset) {
            items.clear()
            results.clear()
        }
        val known = items.mapTo(HashSet()) { it.id }
        for (t in batch) {
            if (t.kind == "result") t.call?.let { results[it] = t }
            else if (t.id !in known) items += t
        }
    }

    LaunchedEffect(s != null, tries) {
        val session = s ?: return@LaunchedEffect
        socket?.close(1000, null)
        ended = null
        socket = try {
            Cloud.attach(at.bridge, session, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    scope.launch { following = true }
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val m = runCatching { Cloud.json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
                    when (m["type"]?.jsonPrimitive?.content) {
                        "out" -> {
                            val data = m["data"]?.jsonPrimitive?.content ?: return
                            val batch = runCatching { Cloud.json.decodeFromString<Turns>(data) }.getOrNull() ?: return
                            scope.launch { take(batch.items, batch.reset) }
                        }
                        "end" -> scope.launch { ended = m["why"]?.jsonPrimitive?.contentOrNull ?: "ended" }
                    }
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    scope.launch { if (socket === webSocket) following = false }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    scope.launch {
                        if (socket !== webSocket) return@launch
                        following = false
                        ended = t.message ?: t.toString()
                    }
                }
            })
        } catch (e: Exception) {
            ended = e.message
            null
        }
    }
    DisposableEffect(Unit) { onDispose { socket?.close(1000, null) } }

    // Kept at the end of the newest, from joining on, unless scrolled back.
    var stick by remember { mutableStateOf(true) }
    LaunchedEffect(list) {
        snapshotFlow { list.isScrollInProgress to list.canScrollForward }.collect { (moving, more) -> if (moving) stick = !more }
    }
    LaunchedEffect(items.size, results.size, ended) {
        // Past the last item's end; the list stops at its bottom.
        if (stick && items.isNotEmpty()) list.scrollToItem(items.size - 1 + if (ended != null) 1 else 0, 1_000_000)
    }

    fun type(line: String, keys: List<String>) {
        val session = s ?: return
        scope.launch {
            try {
                Cloud.type(at.bridge, session, line, keys)
                error = null
            } catch (e: Exception) {
                if (keys == listOf("enter")) text = line
                error = e.message
            }
        }
    }

    // What the session waits on you for, and its answers.
    val question = items.lastOrNull { it.kind == "tool" && it.tool == "AskUserQuestion" && it.call !in results }
    val answers: List<String> = when (s?.state) {
        "permission" -> listOf("yes", "always", "no")
        "asking" -> question?.options?.firstOrNull().orEmpty()
        else -> emptyList()
    }

    Page {
        Header(s?.name ?: "session", if (s == null) "ended" else s.state)
        androidx.compose.foundation.lazy.LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            state = list,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (items.isEmpty()) item { Text(if (following) "…" else ended ?: "", color = Monokai.base04) }
            items(items, key = { it.id }) { t -> TurnRow(t, t.call?.let { results[it] }, open == t.id) { open = if (open == t.id) null else t.id } }
            ended?.takeIf { items.isNotEmpty() }?.let { item { Text(it, style = Small) } }
        }
        s?.detail?.takeIf { s.state == "permission" || s.state == "asking" }?.let {
            Text(it, color = Monokai.yellow, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp), maxLines = 4)
        }
        error?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
        Rule()
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!following && s != null) Key("follow", Monokai.cyan) { tries++ }
            answers.forEachIndexed { i, a -> Key("${i + 1} $a", Monokai.yellow) { type("${i + 1}", emptyList()) } }
            if (s?.state == "working" || answers.isNotEmpty()) Key("esc", Monokai.base05) { type("", listOf("esc")) }
        }
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Outline("back", color = Monokai.base04, onClick = back)
            Row(
                Modifier.weight(1f).heightIn(min = 52.dp).border(1.dp, Monokai.base02).padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("› ", color = Monokai.cyan)
                BasicTextField(
                    value = text,
                    onValueChange = { text = it },
                    textStyle = androidx.compose.material3.LocalTextStyle.current,
                    cursorBrush = SolidColor(Monokai.cyan),
                    modifier = Modifier.weight(1f),
                    maxLines = 5,
                )
                if (dictation.available) {
                    Text(
                        if (dictation.listening) "stop" else "mic",
                        color = if (dictation.listening) Monokai.orange else Monokai.base04,
                        modifier = Modifier.clickable(role = Role.Button) { dictation.toggle(text) }.padding(start = 12.dp, top = 8.dp, bottom = 8.dp),
                    )
                }
            }
            Solid("send", color = Monokai.cyan, enabled = s != null && text.isNotBlank()) {
                dictation.stop()
                val line = text.trim()
                text = ""
                type(line, listOf("enter"))
            }
        }
    }
}

// One turn: you, Claude, or a tool with its result under it.
@Composable
private fun TurnRow(t: Turn, result: Turn?, opened: Boolean, onClick: () -> Unit) {
    when (t.kind) {
        "you" -> Row(Modifier.fillMaxWidth().background(Monokai.base01).padding(horizontal = 8.dp, vertical = 6.dp)) {
            Text("› ", color = Monokai.cyan)
            Text(t.text.orEmpty(), color = Monokai.base05)
        }
        "claude" -> Row {
            Text("● ", color = Monokai.base05)
            Markdown(t.text.orEmpty(), Modifier.weight(1f))
        }
        else -> Column(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick)) {
            Row {
                Text("● ", color = when {
                    result == null -> Monokai.cyan
                    result.error -> Monokai.orange
                    else -> Monokai.base04
                })
                Text(t.tool.orEmpty(), fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
                Text(" " + t.detail.orEmpty(), style = Small.copy(color = Monokai.base04, fontSize = 14.sp, lineHeight = 20.sp), maxLines = if (opened) Int.MAX_VALUE else 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            }
            result?.text?.takeIf { it.isNotBlank() }?.let { r ->
                Row(Modifier.padding(start = 16.dp, top = 2.dp)) {
                    Text("└ ", style = Small)
                    // A subagent's report is Claude writing, in markdown.
                    if (opened && !result.error && t.tool in setOf("Agent", "Task")) Markdown(r, Modifier.weight(1f))
                    else Text(
                        if (opened) r else r.lineSequence().take(2).joinToString("\n"),
                        style = Small.copy(color = if (result.error) Monokai.orange else Monokai.base04),
                        maxLines = if (opened) Int.MAX_VALUE else 2,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun Key(label: String, color: androidx.compose.ui.graphics.Color, onClick: () -> Unit) =
    Text(label, color = color, modifier = Modifier.border(1.dp, Monokai.base02).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 12.dp, vertical = 10.dp))
