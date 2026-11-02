package app.corkboard

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import java.io.File

// The files agents attached to cards (attach_file), as corkboard's media
// panel has them (web/src/views/Media.tsx): every board's, newest first, one
// line a file. One tapped opens on its own: an image to pinch and drag, a
// video to play, text to read; anything else (a PDF, audio) opens in the app
// the phone has for it. Files are kept in the cache once fetched.

@Serializable
data class Attached(val board: BoardInfo, val card: Card, val file: MediaFile)

private suspend fun attached(): List<Attached> = coroutineScope {
    Cloud.boards().map { b ->
        async { runCatching { Cloud.cards(b.key) }.getOrDefault(emptyList()).flatMap { c -> c.extra.media.map { Attached(b, c, it) } } }
    }.awaitAll().flatten().sortedByDescending { it.file.at }
}

fun bytes(n: Long) = when {
    n < 1024 -> "$n B"
    n < 1024 * 1024 -> "%.0f KB".format(n / 1024.0)
    else -> "%.1f MB".format(n / (1024.0 * 1024))
}

@Composable
fun MediaScreen(go: (Screen) -> Unit) {
    var files by remember { mutableStateOf(Cache.read<List<Attached>>("media")) }
    var problem by remember { mutableStateOf<String?>(null) }
    var loads by remember { mutableStateOf(0) }
    LaunchedEffect(loads) {
        try {
            files = attached().also { Cache.write("media", it) }
            problem = null
        } catch (e: Exception) {
            problem = e.message ?: e.toString()
        }
    }
    Page {
        Header("media", files?.let { "${it.size}" } ?: "…")
        problem?.let { Text(it, style = Small.copy(color = Monokai.orange), modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
        val list = files
        when {
            list == null -> Text("…", color = Monokai.base04, modifier = Modifier.padding(16.dp).weight(1f))
            list.isEmpty() -> Text(
                "Nothing yet. Screenshots, plots and recordings agents attach to their cards show up here.",
                color = Monokai.base04,
                modifier = Modifier.padding(16.dp).weight(1f),
            )
            else -> LazyColumn(Modifier.weight(1f)) {
                items(list, key = { "${it.board.key}/${it.card.id}/${it.file.id}" }) { a ->
                    PanelRow({ go(Screen.Viewing(a.board.key, a.card.id, a.file.id)) }) {
                        Text(glyph(a.file.type), color = Monokai.cyan)
                        Column(Modifier.weight(1f)) {
                            Text(a.file.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                listOf(a.card.title.ifEmpty { a.card.id }, a.board.name.ifEmpty { a.board.key }).joinToString(" · "),
                                style = Small,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(listOf(ago(a.file.at), a.file.who, bytes(a.file.size)).filter { it.isNotEmpty() }.joinToString(" · "), style = Small)
                        }
                        Text("›", color = Monokai.orange)
                    }
                    Rule(Monokai.base01)
                }
            }
        }
        Footer { Outline("refresh", Modifier.weight(1f), color = Monokai.base04) { loads++ } }
    }
}

private fun glyph(type: String) = when {
    type.startsWith("image/") -> "▣"
    type.startsWith("video/") -> "▶"
    type.startsWith("audio/") -> "♪"
    type == "application/pdf" -> "¶"
    else -> "·"
}

// Where a file is kept: the cache, by board, card and id, with its name's
// extension so the app that opens it knows it.
private fun cached(context: Context, board: String, card: String, f: MediaFile) =
    File(context.cacheDir, "media/$board/$card/${f.id}.${f.name.substringAfterLast('.', "bin")}")

private fun openElsewhere(context: Context, file: File, type: String): Boolean {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type.ifEmpty { "*/*" }).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return try {
        context.startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        false
    }
}

@Composable
fun ViewingScreen(v: Screen.Viewing, back: () -> Unit) {
    val context = LocalContext.current
    var found by remember { mutableStateOf<Attached?>(null) }
    var file by remember { mutableStateOf<File?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var noApp by remember { mutableStateOf(false) }
    LaunchedEffect(v) {
        try {
            val board = Cloud.boards().firstOrNull { it.key == v.board } ?: BoardInfo(v.board)
            val card = Cloud.cards(v.board).firstOrNull { it.id == v.card } ?: throw Exception("that card is gone")
            val f = card.extra.media.firstOrNull { it.id == v.id } ?: throw Exception("that file is gone")
            found = Attached(board, card, f)
            val to = cached(context, v.board, v.card, f)
            Cloud.download(v.board, v.card, f.id, to)
            file = to
        } catch (e: Exception) {
            problem = e.message ?: e.toString()
        }
    }
    val a = found
    Page {
        Header(a?.file?.name ?: "media", a?.let { listOf(it.card.title.ifEmpty { it.card.id }, bytes(it.file.size)).joinToString(" · ") } ?: "…")
        problem?.let { Text(it, style = Small.copy(color = Monokai.orange), modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            val f = file
            val type = a?.file?.type.orEmpty()
            when {
                f == null -> if (problem == null) Text("…", color = Monokai.base04)
                type.startsWith("image/") && type != "image/svg+xml" -> Picture(f)
                type.startsWith("video/") -> Video(f)
                type.startsWith("text/") || type == "application/json" -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                    Text(remember(f) { f.readText().take(200_000) }, style = Small.copy(color = Monokai.base05))
                }
                else -> Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(16.dp)) {
                    Text(glyph(type), color = Monokai.cyan)
                    Spacer(Modifier.height(8.dp))
                    Text(if (noApp) "No app on this phone opens ${type.ifEmpty { "it" }}." else "Opens in another app.", color = Monokai.base04)
                }
            }
        }
        Footer {
            Outline("back", Modifier.weight(1f), color = Monokai.base04, onClick = back)
            file?.let { f -> Outline("open with…", Modifier.weight(1f)) { noApp = !openElsewhere(context, f, a?.file?.type.orEmpty()) } }
        }
    }
}

// An image, scaled to the screen; pinch to zoom, drag to look around.
// Decoded at most 4096 pixels a side, so a huge one doesn't run out of memory.
@Composable
private fun Picture(f: File) {
    var image by remember(f) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(f) { mutableStateOf(false) }
    LaunchedEffect(f) {
        image = withContext(Dispatchers.IO) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(f.path, bounds)
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 4096) sample *= 2
            BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
        }
        failed = image == null
    }
    var scale by remember(f) { mutableFloatStateOf(1f) }
    var offset by remember(f) { mutableStateOf(Offset.Zero) }
    val state = rememberTransformableState { zoom, pan, _ ->
        scale = (scale * zoom).coerceIn(1f, 8f)
        offset = if (scale == 1f) Offset.Zero else offset + pan
    }
    when (val i = image) {
        null -> Text(if (failed) "This image won't open here; try open with…" else "…", color = Monokai.base04)
        else -> Image(
            i,
            contentDescription = f.name,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize().transformable(state).graphicsLayer {
                scaleX = scale
                scaleY = scale
                translationX = offset.x
                translationY = offset.y
            },
        )
    }
}

// A video, playing, with the system's controls on a tap.
@Composable
private fun Video(f: File) {
    AndroidView(
        modifier = Modifier.fillMaxWidth(),
        factory = { context ->
            VideoView(context).apply {
                setMediaController(MediaController(context).also { it.setAnchorView(this) })
                setVideoURI(Uri.fromFile(f))
                setOnPreparedListener { it.isLooping = true; start() }
            }
        },
        onRelease = { it.stopPlayback() },
    )
}
