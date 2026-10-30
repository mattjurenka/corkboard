package app.corkboard

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

// The fleet, as the web's fleet view has it (web/src/views/Fleet.tsx): by
// project, a panel per project with its sessions and running spawns, each
// saying where it runs; or by machine, each environment with its memory and
// a line per machine that's up, a slot's with its spawn, and under each
// machine the Claude Code sessions each bridge there has open. Then the
// spawns waiting or over. A spawn tapped opens, to approve or stop; a
// session, to see and type into (Sessions.kt).

fun stateColor(state: String): Color = when (state) {
    "pending-approval" -> Monokai.yellow
    "running" -> Monokai.cyan
    "failed" -> Monokai.orange
    "done" -> Monokai.base05
    else -> Monokai.base04
}

// fleetd looks at least every minute; one not heard from in three is gone.
private fun stale(e: FleetEnvironment) = (age(e.seen) ?: Long.MAX_VALUE) > 180

// A VM's config in a line: "2 cores · allowlist 4 · 10.80.0.2".
private fun summary(c: VmConfig?): String? {
    c ?: return null
    val egress = if (c.egress == "open") "open" else
        "allowlist ${c.allowedDomains.size + c.allowedDomainSuffixes.size}" + if (c.routedEgress.isNotEmpty()) " +${c.routedEgress.size} routed" else ""
    return listOfNotNull(c.cores?.let { "$it cores" }, egress, c.address).joinToString(" · ")
}

private fun hostSummary(h: Host) = listOfNotNull(
    h.cores?.let { "$it threads" },
    h.available?.let { "${gib(it)} free" },
    h.load.firstOrNull()?.let { "load %.2f".format(it) },
).joinToString(" · ").ifEmpty { null }

// working and starting are busy; asking and permission need you.
fun sessionColor(state: String): Color = when (state) {
    "asking", "permission" -> Monokai.yellow
    "working", "starting" -> Monokai.cyan
    "idle" -> Monokai.base05
    else -> Monokai.base04
}

fun needsYou(s: BridgeSession) = s.state == "asking" || s.state == "permission"

fun fleetCounts(f: Fleet): String {
    val sessions = f.bridges.flatMap { it.sessions }
    val needs = sessions.count(::needsYou)
    val waiting = f.spawns.count { it.state == "pending-approval" }
    val running = f.spawns.count { it.state == "running" }
    val queued = f.spawns.count { it.state == "queued" }
    return listOfNotNull(
        "$running running",
        if (queued > 0) "$queued queued" else null,
        if (waiting > 0) "$waiting to approve" else null,
        if (sessions.isNotEmpty()) "${sessions.size} session" + (if (sessions.size == 1) "" else "s") else null,
        if (needs > 0) "$needs need you" else null,
    ).joinToString(" · ")
}

@Composable
fun FleetScreen(go: (Screen) -> Unit) {
    val fleet by Repo.fleet.collectAsState()
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf<String?>(null) }
    var view by remember { mutableStateOf(App.store.fleetView) }
    val byProject = view != "machine"
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val f = fleet
    val spawns = f?.spawns.orEmpty()
    val inSlots = f?.environments.orEmpty().flatMap { e -> e.running?.slots.orEmpty().mapNotNull { it.spawn } }.toSet()
    val shown = if (byProject) spawns.filter { it.state == "running" }.map { it.id }.toSet() else inSlots
    val queue = spawns.filter { it.id !in shown }
    val selected = spawns.firstOrNull { it.id == open }
    fun act(call: suspend (String) -> Spawn) {
        val id = selected?.id ?: return
        busy = true
        error = null
        scope.launch {
            try {
                Repo.setSpawn(call(id))
            } catch (e: Exception) {
                error = e.message
            }
            busy = false
        }
    }
    val tap = { id: String -> open = if (open == id) null else id; error = null }
    Page {
        Header("fleet", f?.let { fleetCounts(it) } ?: "asking the Worker…")
        Problem()
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            for (label in listOf("away", "project", "machine")) {
                Text(
                    label,
                    color = if (view == label) Monokai.cyan else Monokai.base04,
                    fontWeight = if (view == label) FontWeight.SemiBold else FontWeight.Normal,
                    modifier = Modifier.clickable(role = Role.Tab) { view = label; App.store.fleetView = label },
                )
            }
        }
        Rule(Monokai.base01)
        if (view == "away") return@Page Away(f) { b, s -> go(Screen.Session(b.id, s.key)) }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(12.dp))
            if (f != null && f.environments.isEmpty() && spawns.isEmpty() && f.bridges.isEmpty()) {
                Text("No fleetd has told the Worker of an environment yet.", color = Monokai.base04)
            }
            val environments = f?.environments.orEmpty()
            val bridges = f?.bridges.orEmpty()
            val session = { b: Bridge, s: BridgeSession -> go(Screen.Session(b.id, s.key)) }
            if (byProject) ByProject(bridges, spawns.filter { it.id in shown }, open, tap, session)
            else {
                for (e in environments) {
                    EnvironmentPanel(e, spawns, bridges.filter { it.environment == e.name }, open, tap, session) { go(Screen.NewSession(e.name)) }
                    Spacer(Modifier.height(16.dp))
                }
                // A bridge in no environment fleetd tells of, on its own.
                for (b in bridges.filter { b -> environments.none { it.name == b.environment } && b.sessions.isNotEmpty() }) {
                    Panel(b.machine.ifEmpty { b.id }) {
                        for (s in b.sessions) SessionRow(s) { session(b, s) }
                    }
                    Spacer(Modifier.height(16.dp))
                }
            }
            if (queue.isNotEmpty()) {
                Panel("queue") {
                    for ((i, s) in queue.withIndex()) {
                        if (i > 0) Rule(Monokai.base01)
                        SpawnRow(s, s.environment, s.id == open) { tap(s.id) }
                    }
                }
                Spacer(Modifier.height(16.dp))
            }
            error?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(bottom = 12.dp)) }
        }
        // Its tab is the way back; this is only for a spawn that's open.
        when (selected?.state) {
            "pending-approval" -> Footer {
                Outline("stop", Modifier.weight(1f), color = Monokai.orange) { act(Cloud::stop) }
                Solid(if (busy) "…" else "Approve ✓", Modifier.weight(1f), color = Monokai.yellow, enabled = !busy) { act(Cloud::approve) }
            }
            "queued", "running" -> Footer {
                Outline(if (busy) "…" else "stop", Modifier.weight(1f), color = Monokai.orange, border = Monokai.orange) { if (!busy) act(Cloud::stop) }
            }
        }
    }
}

private fun newestFirst(sessions: List<Pair<Bridge, BridgeSession>>) = sessions.sortedByDescending { it.second.since ?: 0L }

// A panel per project (corkboard.fleet's by_project): its sessions and its
// running spawns, each saying where it runs.
@Composable
private fun ByProject(bridges: List<Bridge>, running: List<Spawn>, open: String?, tap: (String) -> Unit, session: (Bridge, BridgeSession) -> Unit) {
    val sessions = newestFirst(bridges.flatMap { b -> b.sessions.map { b to it } }).groupBy { it.second.project.ifEmpty { "—" } }
    val spawns = running.sortedByDescending { it.started ?: it.created }.groupBy { it.board.ifEmpty { "—" } }
    // The project with the newest session or spawn first.
    fun newest(project: String) = maxOf(
        sessions[project]?.firstOrNull()?.second?.since ?: 0L,
        spawns[project]?.firstOrNull()?.let { s -> runCatching { java.time.Instant.parse(s.started ?: s.created).toEpochMilli() }.getOrNull() } ?: 0L,
    )
    for (project in (sessions.keys + spawns.keys).sortedByDescending(::newest)) {
        Panel(project) {
            for ((b, s) in sessions[project].orEmpty()) SessionRow(s, s.vm ?: s.host ?: b.machine) { session(b, s) }
            for (s in spawns[project].orEmpty()) SpawnRow(s, s.environment + (s.slot?.let { "/$it" } ?: ""), s.id == open) { tap(s.id) }
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun EnvironmentPanel(
    e: FleetEnvironment,
    spawns: List<Spawn>,
    bridges: List<Bridge>,
    open: String?,
    tap: (String) -> Unit,
    session: (Bridge, BridgeSession) -> Unit,
    newSession: () -> Unit,
) {
    val r = e.running
    val h = r?.host
    val label = listOfNotNull(e.name, e.seen.takeIf { it.isNotEmpty() }?.let { if (stale(e)) "not heard from since ${ago(it)}" else "seen ${ago(it)}" })
    Panel(label.joinToString(" · "), Modifier.alpha(if (stale(e)) 0.6f else 1f)) {
        // The agents' memory budget; with none, the machine's own in use.
        val (used, of, ram) = when {
            r?.budget != null -> Triple(r.used, r.budget, false)
            h?.memory != null && h.available != null -> Triple(h.memory - h.available, h.memory, true)
            else -> Triple(null, null, false)
        }
        if (used != null && of != null && of > 0) Meter(used, of, ram)
        // Each session under the VM it runs in, or else its machine.
        val up = r?.residents.orEmpty().filter { it.up }
        val sessions = newestFirst(bridges.flatMap { b -> b.sessions.map { b to it } })
        val vms = up.map { it.name } + r?.slots.orEmpty().filter { it.spawn != null }.map { it.name }
        val (inVms, onHosts) = sessions.partition { (_, s) -> s.vm in vms }
        @Composable
        fun sessionsIn(vm: String?) {
            for ((b, s) in if (vm == null) onHosts else inVms.filter { it.second.vm == vm }) SessionRow(s) { session(b, s) }
        }
        if (r == null) {
            Text("its fleetd hasn't said what runs there", style = Small, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
            sessionsIn(null)
            return@Panel
        }
        if (h != null) "m:${e.name}/${h.name}".let { k -> Machine(h.name, "host", null, hostSummary(h), hostFields(h, e), k == open) { tap(k) } }
        sessionsIn(null)
        for (v in up) {
            "m:${e.name}/${v.name}".let { k -> Machine(v.name, v.brain, gib(v.memory), summary(v.config), vmFields(v.brain, null, v.memory, v.config), k == open) { tap(k) } }
            sessionsIn(v.name)
        }
        for (sl in r.slots.filter { it.spawn != null }) {
            "m:${e.name}/${sl.name}".let { k -> Machine(sl.name, sl.template, gib(sl.memory), summary(sl.config), vmFields(null, sl.template, sl.memory, sl.config), k == open) { tap(k) } }
            spawns.firstOrNull { it.id == sl.spawn }?.let { SpawnRow(it, null, it.id == open) { tap(it.id) } }
            sessionsIn(sl.name)
        }
        val idle = r.residents.filter { !it.up }.map { "${it.name} down" } + r.slots.filter { it.spawn == null }.map { "${it.name} free" }
        if (h == null && up.isEmpty() && r.slots.none { it.spawn != null } && sessions.isEmpty()) {
            Text("nothing running", style = Small, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
        }
        if (idle.isNotEmpty()) Text(idle.joinToString(" · "), style = Small, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
        if (e.templates.isNotEmpty() && !stale(e)) PanelRow(newSession) { Text("+ session", color = Monokai.cyan) }
    }
}

// The budget as a bar: filled for what's used.
@Composable
private fun Meter(used: Double, of: Double, ram: Boolean) {
    val share = (used / of).coerceIn(0.0, 1.0).toFloat()
    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
        Box(Modifier.fillMaxWidth().height(8.dp).background(Monokai.base01)) {
            Box(Modifier.fillMaxWidth(share).fillMaxHeight().background(if (share > 0.9f) Monokai.yellow else Monokai.cyan))
        }
        Text("${gib(used)} / ${gib(of)}" + if (ram) " RAM" else "", style = Small, modifier = Modifier.padding(top = 4.dp))
    }
}

// A machine's particulars, a field to a row (corkboard.fleet's describe).
private typealias Fields = List<Pair<String, List<String>>>

private fun duration(secs: Long) = when {
    secs < 3600 -> "${secs / 60}m"
    secs < 86400 -> "${secs / 3600}h ${secs % 3600 / 60}m"
    else -> "${secs / 86400}d ${secs % 86400 / 3600}h"
}

private fun hostFields(h: Host, e: FleetEnvironment): Fields {
    val r = e.running
    val vms = r?.residents.orEmpty().count { it.up } + r?.slots.orEmpty().count { it.spawn != null }
    return listOfNotNull(
        h.os?.let { "os" to listOf(it) },
        h.kernel?.let { "kernel" to listOf(it) },
        (h.cpu?.let { c -> c + (h.cores?.let { " · $it threads" } ?: "") } ?: h.cores?.let { "$it threads" })?.let { "cpu" to listOf(it) },
        h.memory?.let { m -> "memory" to listOf(h.available?.let { "${gib(it)} free of ${gib(m)}" } ?: gib(m)) },
        h.load.takeIf { it.isNotEmpty() }?.let { l -> "load" to listOf(l.joinToString(" ") { "%.2f".format(it) }) },
        h.uptime?.let { "up" to listOf(duration(it.toLong())) },
        "environment" to listOf(e.name),
        "vms up" to listOf("$vms"),
    )
}

private fun vmFields(brain: String?, template: String?, memory: Double?, c: VmConfig?): Fields {
    val caps = c?.capabilities.orEmpty()
    val out = mutableListOf<Pair<String, List<String>>>()
    if (template != null) out += "template" to listOf(template + if (caps.isNotEmpty()) " (${caps.joinToString(", ")})" else "")
    else {
        brain?.let { out += "brain" to listOf(it) }
        if (caps.isNotEmpty()) out += "capabilities" to listOf(caps.joinToString(", "))
    }
    c?.account?.let { out += "account" to listOf(it) }
    memory?.let { out += "memory" to listOf(gib(it)) }
    c ?: return out
    c.cores?.let { out += "cores" to listOf("$it") }
    c.address?.let { out += "address" to listOf(it) }
    out += "egress" to listOf(c.egress) + c.allowedDomains + c.allowedDomainSuffixes.map { "*.$it" }
    for (r in c.routedEgress) {
        val ports = r.tcpPorts.map { "tcp $it" } + r.udpPorts.map { "udp $it" }
        out += "routed" to listOf(r.reason.lineSequence().first(), r.destinations.joinToString(", ") + "  " + ports.joinToString(", "))
    }
    c.needsApproval?.let { out += "approval" to listOf(if (it) "needed for a brain's spawn" else "not needed") }
    return out
}

// A machine in a line or two; tapped, its particulars below.
@Composable
private fun Machine(name: String, label: String?, memory: String?, summary: String?, fields: Fields, opened: Boolean, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(name, fontWeight = FontWeight.SemiBold, color = if (opened) Monokai.cyan else Monokai.base05, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            listOfNotNull(label, memory).joinToString(" · ").takeIf { it.isNotEmpty() }?.let { Text(it, style = Small) }
        }
        if (!opened) summary?.let { Text(it, style = Small, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        if (opened) {
            Column(Modifier.padding(top = 4.dp)) {
                for ((label, values) in fields) {
                    Row {
                        Text(label, style = Small, modifier = Modifier.width(96.dp))
                        Column(Modifier.weight(1f)) {
                            values.forEachIndexed { i, v -> Text(v, style = if (i == 0) Small.copy(color = Monokai.base05) else Small) }
                        }
                    }
                }
            }
        }
    }
}

// A session in two lines, and what it's asking, if it is.
@Composable
private fun SessionRow(s: BridgeSession, where: String? = null, onClick: () -> Unit) {
    PanelRow(onClick) {
        Text("●", color = sessionColor(s.state), modifier = Modifier.align(Alignment.Top))
        Column(Modifier.weight(1f)) {
            Text(s.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row {
                Text(s.state, style = Small.copy(color = sessionColor(s.state)))
                Text((if (where != null) listOf("", where) else listOfNotNull("", s.project, s.host)).joinToString(" · "), style = Small, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (s.state != "attached") s.since?.let { Text(agoMs(it), style = Small) }
            }
            s.detail?.let { Text(it, style = Small.copy(color = Monokai.yellow), maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
    }
}

// A spawn in two lines; opened, all of its task and how it went.
@Composable
private fun SpawnRow(s: Spawn, where: String?, opened: Boolean, onClick: () -> Unit) {
    PanelRow(onClick) {
        Text(if (s.state in OVER) "○" else "●", color = stateColor(s.state), modifier = Modifier.align(Alignment.Top))
        Column(Modifier.weight(1f)) {
            Text(
                s.task.ifBlank { "${s.template} session" }.let { if (opened) it else it.lineSequence().first() },
                fontWeight = if (opened) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = if (opened) Int.MAX_VALUE else 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row {
                Text(s.state, style = Small.copy(color = stateColor(s.state)))
                Text(listOfNotNull("", s.template, where).joinToString(" · "), style = Small, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(ago(s.ended ?: s.started ?: s.created), style = Small)
            }
            if (opened) {
                Text(
                    listOfNotNull("asked by ${s.by}", s.brain?.let { "brain $it" }, s.card.takeIf { it.isNotEmpty() }?.let { "card $it on ${s.board}" }).joinToString(" · "),
                    style = Small,
                    modifier = Modifier.padding(top = 4.dp),
                )
                s.error?.let { Text(it, style = Small.copy(color = Monokai.orange), modifier = Modifier.padding(top = 4.dp)) }
                s.result?.let { Text(it, style = Small.copy(color = Monokai.base05), modifier = Modifier.padding(top = 4.dp)) }
            }
        }
    }
}
