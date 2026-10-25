package app.corkboard

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier

class MainActivity : ComponentActivity() {
    private var screen by mutableStateOf<Screen>(Screen.Home)
    // Bumped on every resume, so screens re-read what a settings page changed.
    private var resumed by mutableIntStateOf(0)
    private var setupDone by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Screen.named(intent.getStringExtra("screen"))?.let { screen = it }
        setContent {
            CorkboardTheme {
                Box(Modifier.fillMaxSize().background(Monokai.base00).safeDrawingPadding()) {
                    val signedIn by Repo.signedIn.collectAsState()
                    val plan by Repo.plan.collectAsState()
                    val go = { s: Screen -> screen = s }
                    val home = { screen = Screen.Home }
                    BackHandler(screen != Screen.Home, home)
                    resumed // read, so a resume recomposes
                    when {
                        !signedIn -> SignInScreen()
                        !setupDone && !Blocker.enabled(this@MainActivity) -> SetupScreen(resumed) { setupDone = true }
                        else -> when (val s = screen) {
                            Screen.Home -> {
                                plan // the gate follows the plan
                                if (Gate.open()) NowScreen(go) else LockedScreen(go)
                            }
                            Screen.Plan -> PlanScreen(go, home)
                            Screen.Meditate -> MeditateScreen(home)
                            Screen.Apps -> AppsScreen(home)
                            is Screen.Chat -> ChatScreen(s.draft) { screen = Screen.Plan.takeIf { plan?.accepted == null } ?: Screen.Home }
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        Screen.named(intent.getStringExtra("screen"))?.let { screen = it }
    }

    override fun onResume() {
        super.onResume()
        resumed++
        Ticker.update(this)
    }
}
