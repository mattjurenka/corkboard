package app.corkboard

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private var screen by mutableStateOf<Screen>(Screen.Home)
    // Bumped on every resume, so screens re-read what a settings page changed.
    private var resumed by mutableIntStateOf(0)
    private var setupDone by mutableStateOf(false)

    @OptIn(ExperimentalLayoutApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Screen.named(intent.getStringExtra("screen"))?.let { screen = it }
        if (savedInstanceState == null) signedIn(intent)
        setContent {
            CorkboardTheme {
                Box(Modifier.fillMaxSize().background(Monokai.base00).safeDrawingPadding()) {
                    val signedIn by Repo.signedIn.collectAsState()
                    val plan by Repo.plan.collectAsState()
                    val go = { s: Screen -> screen = s }
                    val home = { screen = Screen.Home }
                    BackHandler(screen != Screen.Home) {
                        screen = when (screen) {
                            is Screen.Session, is Screen.NewSession -> Screen.Fleet
                            is Screen.Goals -> Screen.Plan
                            else -> Screen.Home
                        }
                    }
                    resumed // read, so a resume recomposes
                    when {
                        !signedIn -> SignInScreen()
                        !setupDone && !Setup.locking(this@MainActivity) -> SetupScreen(resumed) { setupDone = true }
                        // The four tabs, with the bar along the foot; it steps
                        // aside for the keyboard.
                        isTab(screen) -> Column(Modifier.fillMaxSize()) {
                            Box(Modifier.weight(1f)) {
                                when (val s = screen) {
                                    Screen.Fleet -> FleetScreen(go)
                                    Screen.Plan -> PlanScreen(go)
                                    is Screen.Chat -> ChatScreen(s.draft)
                                    else -> {
                                        plan // the gate follows the plan
                                        if (Gate.open()) NowScreen(go) else LockedScreen(go)
                                    }
                                }
                            }
                            if (!WindowInsets.isImeVisible) Tabs(screen, go)
                        }
                        else -> when (val s = screen) {
                            Screen.Home, Screen.Fleet, Screen.Plan, is Screen.Chat -> {}
                            is Screen.Goals -> GoalsScreen(s.id) { screen = Screen.Plan }
                            Screen.Meditate -> MeditateScreen(home)
                            Screen.Apps -> AppsScreen(home)
                            Screen.Setup -> SetupScreen(resumed, home)
                            is Screen.Session -> SessionScreen(s) { screen = Screen.Fleet }
                            is Screen.NewSession -> NewSessionScreen(s.environment, go) { screen = Screen.Fleet }
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        signedIn(intent)
        Screen.named(intent.getStringExtra("screen"))?.let { screen = it }
    }

    // The browser, back from signing in (Cloud.REDIRECT).
    private fun signedIn(intent: Intent) {
        val answer = intent.data?.takeIf { it.toString().startsWith(Cloud.REDIRECT) } ?: return
        lifecycleScope.launch {
            try {
                Cloud.finishSignIn(answer)
                Repo.signInError.value = null
                Repo.signedIn.value = true
                Repo.follow()
            } catch (e: Exception) {
                Repo.signInError.value = e.message
            }
        }
    }

    override fun onResume() {
        super.onResume()
        resumed++
        Ticker.update(this)
    }
}
