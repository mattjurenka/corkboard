package app.corkboard

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        store = Store(this)
        Notifications.channels(this)
        Ticker.update(this)
        // A meditation still running when the process was restarted.
        Chimes.sync(this)
        // Followed live while the app is in front; the notification and
        // widget move on with alarms the rest of the time.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = Repo.follow()
            override fun onStop(owner: LifecycleOwner) = Repo.unfollow()
        })
    }

    companion object {
        lateinit var instance: App
            private set
        lateinit var store: Store
            private set
    }
}

// What the screens show: today's plan, the chat with Pepper and the fleet,
// kept fresh from the Worker.
object Repo {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    val plan = MutableStateFlow(App.store.plan?.takeIf { it.date == today() })
    val chat = MutableStateFlow<List<ChatMessage>>(emptyList())
    val signedIn = MutableStateFlow(App.store.auth != null)
    val problem = MutableStateFlow<String?>(null)
    val signInError = MutableStateFlow<String?>(null)
    // Whether /api/chat exists on this Worker yet.
    val chatReady = MutableStateFlow(true)
    // Null until it's first heard.
    val fleet = MutableStateFlow<Fleet?>(null)
    // Read with the plan; they change only when Pepper rewrites a goal note.
    val goals = MutableStateFlow<List<Goal>>(emptyList())

    private var socket: WebSocket? = null
    private var following: Job? = null

    fun setPlan(p: Plan) {
        if (p.date != today()) return
        plan.value = p
        App.store.plan = p
        Ticker.update(App.instance)
    }

    suspend fun refresh() {
        try {
            setPlan(Cloud.plan(today()))
            loadChat()
            loadGoals()
            loadFleet()
            problem.value = null
        } catch (e: Cloud.NotSignedIn) {
            signedIn.value = false
        } catch (e: Exception) {
            problem.value = e.message ?: e.toString()
        }
    }

    private suspend fun loadChat() {
        try {
            chat.value = Cloud.chat()
            chatReady.value = true
        } catch (e: Cloud.Failed) {
            if (e.status == 404) chatReady.value = false else throw e
        }
    }

    // A Worker without /api/goals yet has none.
    suspend fun loadGoals() {
        goals.value = try {
            Cloud.goals()
        } catch (e: Cloud.Failed) {
            if (e.status == 404) emptyList() else throw e
        }
    }

    // What's waiting or running, and the last few over, as the bridge asks.
    private suspend fun loadFleet() {
        val open = Cloud.spawns("pending-approval,queued,running", 50)
        val over = Cloud.spawns("done,failed,stopped", 8)
        // A Worker without bridges yet has none.
        val bridges = try {
            Cloud.bridges()
        } catch (e: Cloud.Failed) {
            if (e.status == 404) emptyList() else throw e
        }
        fleet.value = Fleet(Cloud.environments(), open + over, bridges)
    }

    private fun setBridge(b: Bridge) {
        val f = fleet.value ?: return
        fleet.value = f.copy(bridges = (f.bridges.filter { it.id != b.id } + listOfNotNull(b.takeIf { !it.gone })).sortedBy { it.id })
    }

    fun setSpawn(s: Spawn) {
        val f = fleet.value ?: return
        val all = listOf(s) + f.spawns.filter { it.id != s.id }
        val (over, open) = all.partition { it.state in OVER }
        fleet.value = f.copy(
            spawns = open.sortedByDescending { it.created } + over.sortedByDescending { it.ended ?: it.created }.take(8),
        )
    }

    private fun setEnvironment(e: FleetEnvironment) {
        val f = fleet.value ?: return
        fleet.value = f.copy(environments = (f.environments.filter { it.name != e.name } + e).sortedBy { it.name })
    }

    fun addMessage(m: ChatMessage) {
        if (chat.value.none { it.id == m.id }) chat.value = (chat.value + m).sortedBy { it.id }
    }

    // Refresh, then follow the live socket, reconnecting while in front.
    fun follow() {
        if (following?.isActive == true || App.store.auth == null) return
        following = scope.launch {
            while (true) {
                refresh()
                val closed = kotlinx.coroutines.CompletableDeferred<Unit>()
                socket = try {
                    Cloud.live(object : WebSocketListener() {
                        override fun onMessage(webSocket: WebSocket, text: String) {
                            scope.launch { event(text) }
                        }
                        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                            closed.complete(Unit)
                        }
                        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                            closed.complete(Unit)
                        }
                    })
                } catch (e: Exception) {
                    closed.complete(Unit)
                    null
                }
                closed.await()
                delay(5_000)
            }
        }
    }

    fun unfollow() {
        following?.cancel()
        following = null
        socket?.close(1000, null)
        socket = null
    }

    private fun event(text: String) {
        val e = runCatching { Cloud.json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (e["type"]?.jsonPrimitive?.content) {
            "plan" -> setPlan(Cloud.json.decodeFromJsonElement(e["plan"]!!))
            "chat" -> addMessage(Cloud.json.decodeFromJsonElement(e["message"]!!))
            "fleet" -> setEnvironment(Cloud.json.decodeFromJsonElement(e["environment"]!!))
            "spawn" -> setSpawn(Cloud.json.decodeFromJsonElement(e["spawn"]!!))
            "bridge" -> setBridge(Cloud.json.decodeFromJsonElement(e["bridge"]!!))
        }
    }
}
