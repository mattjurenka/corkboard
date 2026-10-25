package app.corkboard

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

sealed interface Screen {
    data object Home : Screen
    data object Plan : Screen
    data object Meditate : Screen
    data object Apps : Screen
    data class Chat(val draft: String = "") : Screen

    companion object {
        fun named(name: String?): Screen? = when (name) {
            "plan" -> Plan
            "meditate" -> Meditate
            "chat" -> Chat()
            "apps" -> Apps
            else -> null
        }
    }
}

@Composable
fun Page(content: @Composable ColumnScope.() -> Unit) =
    Column(Modifier.fillMaxSize().background(Monokai.base00), content = content)

@Composable
fun Footer(content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    Rule()
    Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), content = content)
}

@Composable
fun Problem() {
    val problem by Repo.problem.collectAsState()
    problem?.let { Text(it, style = Small.copy(color = Monokai.orange), modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
}

// Signing in ---------------------------------------------------------------------------

@Composable
fun SignInScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val error by Repo.signInError.collectAsState()
    var opening by remember { mutableStateOf(false) }
    Page {
        Header("corkboard", "sign in")
        Column(Modifier.padding(16.dp).weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Spacer(Modifier.height(24.dp))
            Text("Sign in to corkboard", fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
            Text("Your day plan and Pepper live on corkboard's Worker. Signing in opens the browser: allow \"corkboard phone\" and sign in with Google, and it comes back here.", color = Monokai.base04)
            error?.let { Text(it, color = Monokai.orange) }
        }
        Footer {
            // Tapping again starts over, if the browser was closed.
            Solid(if (opening) "Opening the browser…" else "Sign in", Modifier.weight(1f), enabled = !opening) {
                opening = true
                Repo.signInError.value = null
                scope.launch {
                    try {
                        Cloud.startSignIn(context)
                    } catch (e: Exception) {
                        Repo.signInError.value = e.message
                    }
                    opening = false
                }
            }
        }
    }
}

// First run: what Android has to allow ------------------------------------------------

@Composable
fun SetupScreen(resumed: Int, done: () -> Unit) {
    val context = LocalContext.current
    val power = context.getSystemService(PowerManager::class.java)
    // Re-read on every resume: each one comes back from a settings page.
    val accessibility = remember(resumed) { Blocker.enabled(context) }
    val battery = remember(resumed) { power.isIgnoringBatteryOptimizations(context.packageName) }
    var notifications by remember(resumed) {
        mutableStateOf(context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { notifications = it }
    Page {
        Header("setup", "${listOf(accessibility, battery, notifications).count { it }}/3 allowed")
        Column(Modifier.padding(16.dp).weight(1f).verticalScroll(rememberScrollState())) {
            Text("To lock apps, corkboard needs", fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
            Text("Each opens Android's settings. Come back here when it's on.", color = Monokai.base04)
            Spacer(Modifier.height(20.dp))
            Panel("permissions") {
                Permission("Accessibility", "sees which app comes to the front, the moment it opens", accessibility) {
                    context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                }
                Rule(Monokai.base01)
                Permission("Unrestricted battery", "so Android doesn't stop the blocker in the background", battery) {
                    @SuppressLint("BatteryLife")
                    val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
                    context.startActivity(i)
                }
                Rule(Monokai.base01)
                Permission("Notifications", "the current block and the timer, in the shade", notifications) {
                    ask.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            }
            Spacer(Modifier.height(16.dp))
            Text("On Android 13+, accessibility may be greyed out for an app installed outside the Play Store: open corkboard's App info, ⋮ › Allow restricted settings, then try again.", style = Small)
        }
        Footer { Solid("Continue", Modifier.weight(1f), enabled = accessibility, onClick = done) }
    }
}

@Composable
private fun Permission(title: String, why: String, on: Boolean, allow: () -> Unit) {
    PanelRow(if (on) null else allow) {
        Check(on)
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.SemiBold)
            Text(why, style = Small)
        }
        if (!on) Text("allow ›", color = Monokai.orange)
    }
}

// Home: locked, or the block now ------------------------------------------------------

@Composable
fun LockedScreen(go: (Screen) -> Unit) {
    val context = LocalContext.current
    val plan by Repo.plan.collectAsState()
    val planned = plan?.accepted != null
    val med = seconds(Meditation.running()) { Meditation.elapsed() }
    var confirm by remember { mutableStateOf(false) }
    Page {
        Header("corkboard", java.time.LocalDate.now().let { "%ta %<td %<tb".format(it).lowercase() })
        Problem()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(32.dp))
            Text("▌LOCKED", color = Monokai.orange, fontSize = 28.sp, lineHeight = 40.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 2.sp)
            Text("Your locked apps stay closed until both of these are done.", color = Monokai.base04)
            Spacer(Modifier.height(24.dp))
            Panel("unlock · ${listOf(planned, med >= Meditation.GOAL).count { it }}/2") {
                PanelRow({ go(Screen.Plan) }) {
                    Check(planned)
                    Column(Modifier.weight(1f)) {
                        Text("Plan the day", fontWeight = FontWeight.SemiBold)
                        Text(
                            when {
                                planned -> "accepted"
                                plan?.proposal != null -> "Pepper has a plan for you to look at"
                                else -> "talk it through with Pepper"
                            },
                            style = Small,
                        )
                    }
                    Text("›", color = Monokai.orange)
                }
                Rule(Monokai.base01)
                PanelRow({ go(Screen.Meditate) }) {
                    Check(med >= Meditation.GOAL)
                    Column(Modifier.weight(1f)) {
                        Text("Meditate", fontWeight = FontWeight.SemiBold)
                        Text("%02d:%02d of 30:00".format(med / 60, med % 60), style = Small)
                    }
                    Text("›", color = Monokai.orange)
                }
            }
            Spacer(Modifier.height(24.dp))
            Panel("locked apps") {
                PanelRow({ go(Screen.Apps) }) {
                    Text(
                        App.store.lockedApps.map { Blocker.label(context, it) }.sorted().joinToString("  ") { "▪ $it" },
                        modifier = Modifier.weight(1f),
                    )
                    Text("edit", color = Monokai.base04)
                }
            }
        }
        Footer {
            Text("calls, maps and messages stay open", style = Small, modifier = Modifier.weight(1f).align(Alignment.CenterVertically))
            Outline(
                if (confirm) "unlock ${Gate.EMERGENCY_MINUTES}m?" else "emergency",
                color = if (confirm) Monokai.orange else Monokai.base04,
                border = if (confirm) Monokai.orange else Monokai.base02,
            ) {
                if (confirm) Gate.emergency(context) else confirm = true
            }
        }
    }
}

@Composable
fun NowScreen(go: (Screen) -> Unit) {
    val plan by Repo.plan.collectAsState()
    val minute by ticking()
    val block = Now.current(plan, minute)
    val emergency = App.store.emergencyUntil > System.currentTimeMillis() && !(Gate.planned() && Gate.meditated())
    Page {
        Header("corkboard", java.time.LocalDate.now().let { "%ta %<td %<tb".format(it).lowercase() })
        Problem()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(28.dp))
            if (block != null) {
                Text("NOW · ${clock(block.start)}–${clock(block.stop)}", style = Small.copy(color = Monokai.cyan), letterSpacing = 2.sp)
                Text(block.title, fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.padding(top = 8.dp))
                listOfNotNull(block.card, block.project).joinToString(" · ").takeIf { it.isNotEmpty() }?.let {
                    Text(it, color = Monokai.base04, modifier = Modifier.padding(top = 4.dp))
                }
                block.desc?.let { Text(it, modifier = Modifier.padding(top = 12.dp)) }
                Spacer(Modifier.height(24.dp))
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(length(block.stop - minute), fontSize = 40.sp, lineHeight = 48.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.weight(1f))
                    Text("left · ${length(minute - block.start)} in", color = Monokai.base04)
                }
                Spacer(Modifier.height(8.dp))
                Box(Modifier.fillMaxWidth().height(8.dp).background(Monokai.base01)) {
                    Box(Modifier.fillMaxWidth((minute - block.start).toFloat() / (block.stop - block.start)).fillMaxHeight().background(Monokai.cyan))
                }
            } else {
                val next = Now.next(plan, minute, 1).firstOrNull()
                Text(if (plan?.day?.blocks.isNullOrEmpty()) "NOTHING PLANNED" else "FREE", style = Small, letterSpacing = 2.sp)
                Text(
                    if (next != null) "until ${clock(next.start)}" else "for the rest of the day",
                    fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.padding(top = 8.dp),
                )
            }
            val next = Now.next(plan, minute, 4)
            if (next.isNotEmpty()) {
                Spacer(Modifier.height(32.dp))
                Panel("next") {
                    for (b in next) BlockLine(b)
                }
            }
            plan?.let { DayStrip(it, minute) }
        }
        Rule()
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (emergency) {
                Text("emergency unlock until ${java.time.Instant.ofEpochMilli(App.store.emergencyUntil).atZone(java.time.ZoneId.systemDefault()).toLocalTime().toString().take(5)}", style = Small.copy(color = Monokai.orange), modifier = Modifier.weight(1f))
            } else {
                Check(true); Text("planned", style = Small)
                Check(true); Text("meditated", style = Small, modifier = Modifier.weight(1f))
            }
        }
        Footer {
            Outline("plan", Modifier.weight(1f)) { go(Screen.Plan) }
            Outline("pepper", Modifier.weight(1f), color = Monokai.purple) { go(Screen.Chat()) }
            Outline("apps", Modifier.weight(1f)) { go(Screen.Apps) }
        }
    }
}

@Composable
private fun BlockLine(b: Block) {
    Row(Modifier.padding(horizontal = 12.dp, vertical = 5.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(clock(b.start), color = Monokai.base04)
        Text(b.title, modifier = Modifier.weight(1f), color = if (b.kind == "off") Monokai.base04 else Monokai.base05)
        if (b.kind == "fixed") Text("fixed", style = Small)
    }
}

// The day in half hours, with a mark at now.
@Composable
private fun DayStrip(plan: Plan, minute: Int) {
    val blocks = plan.day.blocks
    if (blocks.isEmpty()) return
    val from = blocks.minOf { it.start } / 60 * 60
    val to = (blocks.maxOf { it.stop } + 59) / 60 * 60
    val cells = (to - from) / 30
    Spacer(Modifier.height(28.dp))
    Text("today · ${clock(from).take(2)}–${clock(to).take(2)}", style = Small)
    Spacer(Modifier.height(6.dp))
    Row(Modifier.fillMaxWidth().height(16.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        for (i in 0 until cells) {
            val at = from + i * 30
            val b = blocks.firstOrNull { it.start <= at && at < it.stop }
            val color = when {
                at <= minute && minute < at + 30 -> Monokai.base05
                b == null -> Monokai.base01
                b.kind == "work" -> Monokai.cyan
                else -> Monokai.base03
            }
            Box(Modifier.weight(1f).fillMaxHeight().background(color))
        }
    }
}

// Planning: Pepper's plan, accepted here ----------------------------------------------

@Composable
fun PlanScreen(go: (Screen) -> Unit, back: () -> Unit) {
    val plan by Repo.plan.collectAsState()
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val proposal = plan?.proposal
    fun act(f: suspend () -> Plan) {
        busy = true
        error = null
        scope.launch {
            try {
                Repo.setPlan(f())
            } catch (e: Cloud.Conflict) {
                Repo.setPlan(e.plan)
                error = e.message
            } catch (e: Exception) {
                error = e.message
            }
            busy = false
        }
    }
    Page {
        Header("plan", if (proposal != null) "review Pepper's plan" else if (plan?.accepted != null) "today" else "talk to Pepper")
        Problem()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(20.dp))
            when {
                proposal != null -> {
                    Text(if (plan!!.accepted != null) "A re-plan from ${clock(proposal.from)}" else "Pepper's plan for today", fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
                    Text("Accept it, or tell Pepper what to change.", color = Monokai.base04)
                    if (proposal.reasons.isNotEmpty()) {
                        Spacer(Modifier.height(16.dp))
                        Panel("pepper") {
                            for (r in proposal.reasons) Text(r.text, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                        }
                    }
                    Spacer(Modifier.height(16.dp))
                    Timeline(proposal.blocks, proposal.why)
                }
                plan?.accepted != null -> {
                    Text("Today's plan", fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
                    Text("Accepted at ${plan!!.accepted!!.substringAfter('T').take(5)} UTC.", color = Monokai.base04)
                    Spacer(Modifier.height(16.dp))
                    Timeline(plan!!.day.blocks, emptyMap())
                }
                else -> {
                    Text("What's on today?", fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
                    Text("Pepper looks at your boards, calendar and goals and proposes the day. Tell it anything it should know first: how you slept, what's due, what you want to get to.", color = Monokai.base04)
                    if (plan?.asked?.isNotEmpty() == true) {
                        Spacer(Modifier.height(16.dp))
                        Panel("waiting on pepper") {
                            for (a in plan!!.asked) Text(a, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                        }
                    }
                }
            }
            error?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(top = 12.dp)) }
            Spacer(Modifier.height(16.dp))
        }
        Footer {
            Outline("back", color = Monokai.base04, onClick = back)
            when {
                proposal != null -> {
                    Outline("change", Modifier.weight(1f), color = Monokai.purple) { go(Screen.Chat("")) }
                    Solid(if (busy) "…" else "Accept ✓", Modifier.weight(1f), enabled = !busy) { act { Cloud.accept(plan!!) } }
                }
                plan?.accepted != null ->
                    Outline("Ask Pepper to re-plan", Modifier.weight(1f), color = Monokai.purple) { go(Screen.Chat("Re-plan the rest of my day: ")) }
                else -> Solid("Talk to Pepper ›", Modifier.weight(1f)) { go(Screen.Chat("Plan my day. ")) }
            }
        }
    }
}

@Composable
private fun Timeline(blocks: List<Block>, why: Map<String, String>) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (b in blocks) {
            val work = b.kind == "work"
            Row(Modifier.fillMaxWidth()) {
                Text(clock(b.start), style = Small, modifier = Modifier.width(48.dp).padding(top = 6.dp))
                Column(
                    Modifier.weight(1f)
                        .then(if (work) Modifier.background(Monokai.workTint).border(1.dp, Monokai.cyan) else Modifier.border(1.dp, Monokai.base02))
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                ) {
                    Row {
                        Text(b.title, fontWeight = if (work) FontWeight.SemiBold else FontWeight.Normal, color = if (work) Monokai.base05 else Monokai.base04, modifier = Modifier.weight(1f))
                        Text(length(b.stop - b.start), style = Small)
                    }
                    listOfNotNull(b.card, if (b.kind == "fixed") "fixed" else null).joinToString(" · ").takeIf { it.isNotEmpty() }?.let { Text(it, style = Small) }
                    why[b.id]?.let { Text(it, style = Small.copy(color = Monokai.purple), modifier = Modifier.padding(top = 2.dp)) }
                }
            }
        }
    }
}

// Pepper -------------------------------------------------------------------------------

@Composable
fun ChatScreen(draft: String, back: () -> Unit) {
    val messages by Repo.chat.collectAsState()
    val ready by Repo.chatReady.collectAsState()
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf(draft) }
    var error by remember { mutableStateOf<String?>(null) }
    val list = rememberLazyListState()
    LaunchedEffect(messages.size) { if (messages.isNotEmpty()) list.animateScrollToItem(messages.size - 1) }
    Page {
        Header("pepper", if (messages.lastOrNull()?.who == "matt") "thinking…" else "chat")
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (!ready) item { Text("This Worker has no chat yet: deploy the cloud/ update for messages to reach Pepper.", color = Monokai.orange) }
            if (ready && messages.isEmpty()) item { Text("Nothing yet. Pepper answers here, and can change today's plan while you talk.", color = Monokai.base04) }
            items(messages, key = { it.id }) { m ->
                Column {
                    Text(if (m.who == "pepper") "pepper" else "you", style = Small.copy(color = if (m.who == "pepper") Monokai.purple else Monokai.base04))
                    Text(m.text, modifier = Modifier.padding(top = 2.dp))
                }
            }
        }
        error?.let { Text(it, color = Monokai.orange, modifier = Modifier.padding(horizontal = 16.dp)) }
        Rule()
        Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Outline("back", color = Monokai.base04, onClick = back)
            Row(
                Modifier.weight(1f).heightIn(min = 52.dp).border(1.dp, Monokai.base02).padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("› ", color = Monokai.purple)
                BasicTextField(
                    value = text,
                    onValueChange = { text = it },
                    textStyle = androidx.compose.material3.LocalTextStyle.current,
                    cursorBrush = SolidColor(Monokai.purple),
                    modifier = Modifier.weight(1f),
                    maxLines = 5,
                )
            }
            Solid("send", color = Monokai.purple, enabled = ready && text.isNotBlank()) {
                val sending = text.trim()
                text = ""
                scope.launch {
                    try {
                        Repo.addMessage(Cloud.say(sending))
                        error = null
                    } catch (e: Exception) {
                        text = sending
                        error = e.message
                    }
                }
            }
        }
    }
}

// Meditation ---------------------------------------------------------------------------

@Composable
fun MeditateScreen(back: () -> Unit) {
    val context = LocalContext.current
    var running by remember { mutableStateOf(Meditation.running()) }
    val elapsed = seconds(running) { Meditation.elapsed().also { if (it >= Meditation.GOAL) running = false } }
    val left = Meditation.GOAL - elapsed
    Page {
        Header("meditate", if (left == 0) "done" else "unlock")
        Column(Modifier.weight(1f).padding(horizontal = 16.dp), verticalArrangement = Arrangement.Center) {
            Text("REMAINING", style = Small, letterSpacing = 2.sp, modifier = Modifier.align(Alignment.CenterHorizontally))
            Text(
                "%02d:%02d".format(left / 60, left % 60),
                fontSize = 76.sp, lineHeight = 88.sp, fontWeight = FontWeight.ExtraBold,
                modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 8.dp),
            )
            Text("${elapsed / 60} of 30 minutes", color = Monokai.base04, modifier = Modifier.align(Alignment.CenterHorizontally))
            Spacer(Modifier.height(40.dp))
            Panel("one cell a minute") {
                Box(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) { Cells(elapsed / 60, 30, 15, Monokai.orange) }
            }
            Text(
                "The screen can go off. Opening another app pauses the timer.\nA chime plays at 30:00.",
                style = Small, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
            )
        }
        Footer {
            if (left == 0) {
                Solid("Done ✓", Modifier.weight(1f), color = Monokai.cyan, onClick = back)
            } else {
                Outline(if (running) "Pause" else if (elapsed > 0) "Carry on" else "Start", Modifier.weight(1f), color = Monokai.orange, border = Monokai.orange) {
                    if (running) Meditation.pause(context) else Meditation.start(context)
                    running = Meditation.running()
                }
                Outline("back", color = Monokai.base04, onClick = back)
            }
        }
    }
}

// Which apps to lock -------------------------------------------------------------------

@Composable
fun AppsScreen(back: () -> Unit) {
    val context = LocalContext.current
    var locked by remember { mutableStateOf(App.store.lockedApps) }
    val apps = remember {
        val pm = context.packageManager
        pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
            .filter { it.first != context.packageName }
            .distinctBy { it.first }
    }
    val sorted = remember(apps) { apps.sortedWith(compareBy({ it.first !in App.store.lockedApps }, { it.second.lowercase() })) }
    val open = Gate.open()
    Page {
        Header("apps", "${locked.size} locked")
        if (!open) Text("While the gate is shut you can lock more apps, not let any out.", style = Small, modifier = Modifier.padding(16.dp))
        LazyColumn(Modifier.weight(1f)) {
            items(sorted, key = { it.first }) { (pkg, label) ->
                val on = pkg in locked
                PanelRow({
                    // While the gate is shut an app can be locked, not let out.
                    if (on && !Gate.open()) return@PanelRow
                    locked = if (on) locked - pkg else locked + pkg
                    App.store.lockedApps = locked
                    Ticker.update(context)
                }) {
                    Check(on)
                    Text(label, modifier = Modifier.weight(1f), color = if (on && !open) Monokai.base04 else Monokai.base05)
                }
            }
        }
        Footer { Outline("back", Modifier.weight(1f), color = Monokai.base04, onClick = back) }
    }
}
