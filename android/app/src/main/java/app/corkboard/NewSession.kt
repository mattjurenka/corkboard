package app.corkboard

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

// A new Claude Code session in one of an environment's VMs: the VM type (a
// template its fleetd runs), the project it works in (a board's repo, copied
// in; its commits come back when it stops), and what to say first, if
// anything. Its fleetd starts it in a free slot (fleet/fleetd/sessions.ts),
// and it shows under that slot in the fleet, to open and talk to.

@Composable
fun NewSessionScreen(environment: String, go: (Screen) -> Unit, back: () -> Unit) {
    val fleet by Repo.fleet.collectAsState()
    val templates = fleet?.environments?.firstOrNull { it.name == environment }?.templates.orEmpty().toSortedMap()
    val scope = rememberCoroutineScope()
    var boards by remember { mutableStateOf<List<BoardInfo>?>(null) }
    var template by remember { mutableStateOf<String?>(null) }
    var board by remember { mutableStateOf<String?>(null) }
    var text by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            boards = Cloud.boards().filter { !it.root.isNullOrEmpty() }.sortedBy { it.name.ifEmpty { it.key } }
        } catch (e: Exception) {
            boards = emptyList()
            error = e.message
        }
    }
    val chosen = template?.takeIf { it in templates } ?: templates.keys.firstOrNull()
    val project = board?.takeIf { b -> boards.orEmpty().any { it.key == b } } ?: boards?.firstOrNull()?.key

    Page {
        Header("new session", environment)
        Problem()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(12.dp))
            Panel("vm") {
                if (templates.isEmpty()) Text("its fleetd runs no VM types", style = Small, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                for ((name, t) in templates) {
                    PanelRow({ template = name }) {
                        Check(name == chosen)
                        Column(Modifier.weight(1f).padding(start = 8.dp)) {
                            Text(name, color = if (name == chosen) Monokai.cyan else Monokai.base05)
                            Text(
                                listOfNotNull(
                                    gib(t.memory),
                                    t.cores.takeIf { it > 0 }?.let { "$it cores" },
                                    t.brain?.let { "brain $it" },
                                    t.capNames.takeIf { it.isNotEmpty() }?.joinToString(", "),
                                ).joinToString(" · "),
                                style = Small,
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
            Panel("project") {
                when {
                    boards == null -> Text("…", style = Small, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                    boards!!.isEmpty() -> Text("no board has a repo", style = Small, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                }
                for (b in boards.orEmpty()) {
                    PanelRow({ board = b.key }) {
                        Check(b.key == project)
                        Column(Modifier.weight(1f).padding(start = 8.dp)) {
                            Text(b.name.ifEmpty { b.key }, color = if (b.key == project) Monokai.cyan else Monokai.base05)
                            Text(b.root!!.replace(Regex("^/home/[^/]+"), "~"), style = Small)
                        }
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
            Panel("first message") {
                BasicTextField(
                    value = text,
                    onValueChange = { text = it },
                    textStyle = androidx.compose.material3.LocalTextStyle.current,
                    cursorBrush = SolidColor(Monokai.cyan),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 88.dp).padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
            error?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(vertical = 12.dp)) }
            Spacer(Modifier.height(16.dp))
        }
        Footer {
            Outline("back", color = Monokai.base04, onClick = back)
            Solid(if (busy) "…" else "Start ›", Modifier.weight(1f), color = Monokai.cyan, enabled = !busy && chosen != null && project != null) {
                busy = true
                error = null
                scope.launch {
                    try {
                        Repo.setSpawn(Cloud.startSession(environment, chosen!!, project, text.trim()))
                        go(Screen.Fleet)
                    } catch (e: Exception) {
                        error = e.message
                    }
                    busy = false
                }
            }
        }
    }
}
