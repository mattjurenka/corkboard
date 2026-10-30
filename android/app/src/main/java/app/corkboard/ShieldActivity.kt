package app.corkboard

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// What a locked app shows instead of itself: what's still to do, and the
// way to it. Back and "Go home" both leave to the home screen, never into
// the app.
class ShieldActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = Locks.label(this, intent.getStringExtra(APP) ?: "")
        setContent {
            CorkboardTheme {
                val plan by Repo.plan.collectAsState()
                // The plan may have been accepted on the desktop since the
                // phone last looked.
                LaunchedEffect(Unit) { Repo.refresh() }
                plan
                if (Gate.open()) {
                    finish()
                    return@CorkboardTheme
                }
                val planned = Gate.planned()
                val med = Meditation.elapsed() / 60
                BackHandler { home() }
                Column(
                    Modifier.fillMaxSize().background(Monokai.base00).safeDrawingPadding().padding(horizontal = 24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Spacer(Modifier.weight(2f))
                    Box(Modifier.size(80.dp).border(1.dp, Monokai.base02), contentAlignment = Alignment.Center) {
                        Image(
                            painterResource(R.drawable.ic_lock),
                            contentDescription = null,
                            colorFilter = ColorFilter.tint(Monokai.orange),
                            modifier = Modifier.size(36.dp),
                        )
                    }
                    Text("$app is locked", fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.padding(top = 28.dp))
                    Text(
                        "Plan your day and meditate for 30 minutes first.",
                        color = Monokai.base04, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 12.dp),
                    )
                    Spacer(Modifier.height(24.dp))
                    Panel("still to do", Modifier.fillMaxWidth()) {
                        Row(Modifier.padding(horizontal = 12.dp, vertical = 5.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Check(planned)
                            Text(
                                "plan the day", modifier = Modifier.weight(1f),
                                color = if (planned) Monokai.base04 else Monokai.base05,
                                textDecoration = if (planned) TextDecoration.LineThrough else null,
                            )
                        }
                        Row(Modifier.padding(horizontal = 12.dp, vertical = 5.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Check(med >= 30)
                            Text("meditate", modifier = Modifier.weight(1f))
                            Text("$med/30m", color = Monokai.orange)
                        }
                    }
                    Spacer(Modifier.weight(3f))
                    val next = if (!planned) "plan" else "meditate"
                    Solid(if (!planned) "Plan the day" else "Meditate · ${30 - med}m left", Modifier.fillMaxWidth()) {
                        startActivity(Intent(this@ShieldActivity, MainActivity::class.java).putExtra("screen", next).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        finish()
                    }
                    Spacer(Modifier.height(8.dp))
                    Outline("Go home", Modifier.fillMaxWidth()) { home() }
                    Text("Back goes home too, not into $app.", style = Small, modifier = Modifier.padding(top = 16.dp, bottom = 24.dp))
                }
            }
        }
    }

    private fun home() {
        startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }

    companion object {
        const val APP = "app"
    }
}
