package app.corkboard

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// The Worker's day plan (cloud/src/plans.ts), as much of it as the phone
// shows. Times are minutes since midnight.

@Serializable
data class Block(
    val id: String,
    val start: Int,
    val stop: Int,
    val title: String,
    val kind: String,
    val desc: String? = null,
    val project: String? = null,
    val tag: String? = null,
    val card: String? = null,
    val board: String? = null,
    val pinned: Boolean? = null,
)

@Serializable
data class Reason(val text: String, val source: String? = null, val tone: String? = null)

@Serializable
data class Proposal(
    val from: Int = 0,
    val blocks: List<Block> = emptyList(),
    val reasons: List<Reason> = emptyList(),
    val why: Map<String, String> = emptyMap(),
    val made: String = "",
    val by: String = "",
)

@Serializable
data class Day(val blocks: List<Block> = emptyList())

@Serializable
data class Plan(
    val date: String,
    val version: Int,
    val day: Day = Day(),
    val proposal: Proposal? = null,
    val asked: List<String> = emptyList(),
    val accepted: String? = null,
)

// A goal, as the Worker reads it out of Pepper's goal note (cloud/src/goals.ts).
@Serializable
data class Goal(
    val id: String,
    val name: String,
    val aim: String = "",
    val why: String = "",
    val measures: List<String> = emptyList(),
    val week: List<String> = emptyList(),
    @SerialName("week_of") val weekOf: String? = null,
)

// A message between the user and Pepper (cloud/src/user.ts's chat).
@Serializable
data class ChatMessage(val id: Long, val at: String, val who: String, val text: String)

// The fleet (cloud/src/fleet.ts): each environment as its fleetd last told
// the Worker, and the spawns queued, running or lately over. Memory in MiB.

@Serializable
data class Host(
    val name: String,
    val os: String? = null,
    val kernel: String? = null,
    val cpu: String? = null,
    val cores: Int? = null,
    val memory: Double? = null,
    val available: Double? = null,
    val load: List<Double> = emptyList(),
    val uptime: Double? = null,
)

@Serializable
data class Routed(
    val reason: String = "",
    val destinations: List<String> = emptyList(),
    val tcpPorts: List<String> = emptyList(),
    val udpPorts: List<String> = emptyList(),
)

@Serializable
data class VmConfig(
    val address: String? = null,
    val egress: String = "allowlist",
    val allowedDomains: List<String> = emptyList(),
    val allowedDomainSuffixes: List<String> = emptyList(),
    val routedEgress: List<Routed> = emptyList(),
    val cores: Int? = null,
    val capabilities: List<String> = emptyList(),
    val account: String? = null,
    val needsApproval: Boolean? = null,
)

@Serializable
data class Resident(val name: String, val brain: String? = null, val memory: Double? = null, val up: Boolean = false, val config: VmConfig? = null)

@Serializable
data class Slot(val name: String, val spawn: String? = null, val template: String? = null, val memory: Double? = null, val config: VmConfig? = null)

@Serializable
data class Running(
    val budget: Double? = null,
    val used: Double = 0.0,
    val host: Host? = null,
    val residents: List<Resident> = emptyList(),
    val slots: List<Slot> = emptyList(),
)

@Serializable
data class FleetEnvironment(val name: String, val seen: String = "", val running: Running? = null, val templates: Map<String, Template> = emptyMap())

// What a VM type is, as its environment's fleetd describes it. memory in MiB.
@Serializable
data class Template(val brain: String? = null, val needsApproval: Boolean = false, val memory: Double = 0.0, val cores: Int = 0, val capNames: List<String> = emptyList())

// A board, and the repo its project is in, if it has one.
@Serializable
data class BoardInfo(val key: String, val name: String = "", val root: String? = null)

@Serializable
data class Spawn(
    val id: String,
    val template: String,
    val environment: String,
    val task: String,
    val brain: String? = null,
    val by: String = "",
    val state: String,
    val board: String = "",
    val card: String = "",
    val created: String = "",
    val started: String? = null,
    val ended: String? = null,
    val slot: String? = null,
    val error: String? = null,
    val result: String? = null,
    val interactive: Boolean = false,
)

// The Claude Code sessions each connected bridge's pages have (cloud/src/
// user.ts's bridges): since in ms, context in tokens. One "gone" is a
// bridge that went away.
@Serializable
data class BridgeSession(
    // What it's asked for by: a page's session "3-12", a VM's its spawn's id.
    val key: String,
    val spawn: String? = null,
    val project: String = "",
    val name: String = "Claude Code",
    val state: String = "",
    val since: Long? = null,
    val detail: String? = null,
    // When you last said something to it, in epoch ms.
    val typed: Long? = null,
    val host: String? = null,
    val vm: String? = null,
    val role: String? = null,
    val card: String? = null,
    val context: Double? = null,
    // Whether its conversation can be followed (Conversation in Sessions.kt).
    val attach: Boolean = false,
)

@Serializable
data class Bridge(val id: String, val machine: String = "", val environment: String? = null, val sessions: List<BridgeSession> = emptyList(), val gone: Boolean = false)

// A session's conversation, as its bridge reads it from the log
// (bridge/transcript.ts): kind you, claude, tool or result; a tool's call is
// its id, which its result names. options: a question's, each question's
// labels. reset: the log started over.
@Serializable
data class Turn(
    val id: String,
    val at: String = "",
    val kind: String,
    val text: String? = null,
    val tool: String? = null,
    val call: String? = null,
    val detail: String? = null,
    val options: List<List<String>>? = null,
    val error: Boolean = false,
)

@Serializable
data class Turns(val items: List<Turn> = emptyList(), val reset: Boolean = false)

// What a session's terminal shows, its last lines; width, in columns, when
// it's in a window. colors: by line, its runs [characters, fg, bg, flags]
// (corkboard/vt.lua), empty for one in the default; palette, the 16 colors
// its Neovim gives its terminals.
@Serializable
data class Terminal(val lines: List<String> = emptyList(), val width: Int? = null, val colors: List<List<List<Double>>>? = null, val palette: List<String>? = null)

data class Fleet(val environments: List<FleetEnvironment> = emptyList(), val spawns: List<Spawn> = emptyList(), val bridges: List<Bridge> = emptyList())

// A spawn in one of these is over.
val OVER = setOf("done", "failed", "stopped")

@Serializable
data class Auth(val clientId: String, val access: String, val refresh: String, val expiresAt: Long)

// A sign-in waiting for the browser to come back (Cloud.startSignIn).
@Serializable
data class PendingSignIn(val clientId: String, val verifier: String, val state: String, val at: Long = 0)

fun clock(m: Int) = "%02d:%02d".format(m / 60 % 24, m % 60)

fun length(m: Int): String {
    val h = m / 60
    val rest = m % 60
    return when {
        h == 0 -> "${rest}m"
        rest == 0 -> "${h}h"
        else -> "%dh%02d".format(h, rest)
    }
}

fun gib(mib: Double?) = if (mib == null) "—" else "%.1f GiB".format(mib / 1024)

// Seconds since an ISO time, or null for none.
fun age(iso: String?): Long? =
    iso?.let { runCatching { (System.currentTimeMillis() - java.time.Instant.parse(it).toEpochMilli()) / 1000 }.getOrNull() }

fun agoMs(ms: Long) = ago(java.time.Instant.ofEpochMilli(ms).toString())

fun ago(iso: String?): String {
    val secs = age(iso) ?: return ""
    return when {
        secs < 60 -> "now"
        secs < 3600 -> "${secs / 60}m ago"
        secs < 86400 -> "${secs / 3600}h ago"
        else -> "${secs / 86400}d ago"
    }
}
