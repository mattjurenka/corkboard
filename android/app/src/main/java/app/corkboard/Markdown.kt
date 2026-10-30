package app.corkboard

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Pepper writes markdown; this draws the part of it Pepper uses, in the
// app's terminal look: headings bold, lists with their marks, code and
// quotes set off, tables lined up in the monospace grid.

private sealed interface Md {
    data class Heading(val level: Int, val text: String) : Md
    data class Para(val text: String) : Md
    data class Item(val mark: String, val depth: Int, val text: String) : Md
    data class Quote(val text: String) : Md
    data class Code(val text: String) : Md
    data class Table(val rows: List<List<String>>) : Md
    data object Rule : Md
}

private val heading = Regex("^(#{1,6})\\s+(.*)$")
private val bullet = Regex("^(\\s*)[-*+]\\s+(\\[[ xX]]\\s+)?(.*)$")
private val numbered = Regex("^(\\s*)(\\d+)[.)]\\s+(.*)$")
private val rule = Regex("^\\s*([-*_])(\\s*\\1){2,}\\s*$")
private val tableDivider = Regex("^\\s*\\|?\\s*:?-+:?\\s*(\\|\\s*:?-+:?\\s*)*\\|?\\s*$")

private fun parse(text: String): List<Md> {
    val out = mutableListOf<Md>()
    val lines = text.replace("\r\n", "\n").split("\n")
    var i = 0
    val para = StringBuilder()
    fun flush() {
        if (para.isNotBlank()) out += Md.Para(para.toString().trim())
        para.clear()
    }
    while (i < lines.size) {
        val line = lines[i]
        when {
            line.trimStart().startsWith("```") -> {
                flush()
                val code = mutableListOf<String>()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) code += lines[i++]
                out += Md.Code(code.joinToString("\n"))
            }
            line.isBlank() -> flush()
            heading.matches(line) -> {
                flush()
                val m = heading.find(line)!!
                out += Md.Heading(m.groupValues[1].length, m.groupValues[2].trimEnd('#', ' '))
            }
            rule.matches(line) -> { flush(); out += Md.Rule }
            line.contains('|') && i + 1 < lines.size && tableDivider.matches(lines[i + 1]) -> {
                flush()
                val rows = mutableListOf(cells(line))
                i += 2
                while (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) rows += cells(lines[i++])
                out += Md.Table(rows)
                continue
            }
            bullet.matches(line) -> {
                flush()
                val m = bullet.find(line)!!
                val box = m.groupValues[2].trim()
                val mark = when {
                    box.isEmpty() -> "•"
                    box[1] == ' ' -> "[ ]"
                    else -> "[x]"
                }
                out += Md.Item(mark, m.groupValues[1].length / 2, m.groupValues[3])
            }
            numbered.matches(line) -> {
                flush()
                val m = numbered.find(line)!!
                out += Md.Item("${m.groupValues[2]}.", m.groupValues[1].length / 2, m.groupValues[3])
            }
            line.trimStart().startsWith(">") -> {
                flush()
                val quote = mutableListOf<String>()
                while (i < lines.size && lines[i].trimStart().startsWith(">")) quote += lines[i++].trimStart().removePrefix(">").trimStart()
                out += Md.Quote(quote.joinToString(" "))
                continue
            }
            // A line under a list item, indented, carries the item on.
            line.startsWith("  ") && para.isEmpty() && out.lastOrNull() is Md.Item -> {
                val last = out.removeAt(out.lastIndex) as Md.Item
                out += last.copy(text = last.text + " " + line.trim())
            }
            else -> para.append(line.trim()).append(if (line.endsWith("  ")) "\n" else " ")
        }
        i++
    }
    flush()
    return out
}

private fun cells(line: String) = line.trim().removePrefix("|").removeSuffix("|").split("|").map { it.trim() }

private val code = SpanStyle(color = Monokai.yellow, background = Monokai.base01)
private val links = TextLinkStyles(SpanStyle(color = Monokai.cyan, textDecoration = TextDecoration.Underline))

// **bold**, *italic* or _italic_, `code`, ~~struck~~ and [links](url).
private fun inline(text: String): AnnotatedString = buildAnnotatedString {
    var i = 0
    fun closes(marker: String, from: Int) = text.indexOf(marker, from).takeIf { it > from }
    while (i < text.length) {
        val rest = text.substring(i)
        when {
            rest.startsWith("`") -> closes("`", i + 1)?.let { end ->
                withStyle(code) { append(text.substring(i + 1, end)) }
                i = end + 1
            }
            rest.startsWith("**") || rest.startsWith("__") -> closes(rest.take(2), i + 2)?.let { end ->
                withStyle(SpanStyle(fontWeight = FontWeight.ExtraBold)) { append(inline(text.substring(i + 2, end))) }
                i = end + 2
            }
            rest.startsWith("~~") -> closes("~~", i + 2)?.let { end ->
                withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough, color = Monokai.base04)) { append(inline(text.substring(i + 2, end))) }
                i = end + 2
            }
            (rest.startsWith("*") || rest.startsWith("_")) && rest.length > 1 && !rest[1].isWhitespace() &&
                (i == 0 || !text[i - 1].isLetterOrDigit()) -> closes(rest.take(1), i + 1)?.let { end ->
                withStyle(SpanStyle(fontStyle = FontStyle.Italic, color = Monokai.base05)) { append(inline(text.substring(i + 1, end))) }
                i = end + 1
            }
            rest.startsWith("[") -> Regex("^\\[([^]]+)]\\(([^)\\s]+)\\)").find(rest)?.let { m ->
                withLink(LinkAnnotation.Url(m.groupValues[2], links)) { append(inline(m.groupValues[1])) }
                i += m.value.length
            }
            else -> null
        } ?: run { append(text[i]); i++ }
    }
}

@Composable
fun Markdown(text: String, modifier: Modifier = Modifier) {
    val blocks = remember(text) { parse(text) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (b in blocks) when (b) {
            is Md.Heading -> Text(
                inline(b.text),
                fontWeight = FontWeight.ExtraBold,
                fontSize = if (b.level <= 2) 16.sp else 14.sp,
                color = if (b.level == 1) Monokai.orange else Monokai.base05,
                modifier = Modifier.padding(top = 4.dp),
            )
            is Md.Para -> Text(inline(b.text))
            is Md.Item -> Row(Modifier.padding(start = (b.depth * 16).dp)) {
                Text(b.mark, color = if (b.mark == "[x]") Monokai.cyan else Monokai.base04, modifier = Modifier.width(if (b.mark.length > 2) 36.dp else 20.dp))
                Text(inline(b.text), modifier = Modifier.weight(1f))
            }
            is Md.Quote -> Row {
                Text("│ ", color = Monokai.purple)
                Text(inline(b.text), color = Monokai.base04, modifier = Modifier.weight(1f))
            }
            is Md.Code -> Box(Modifier.fillMaxWidth().background(Monokai.base01).horizontalScroll(rememberScrollState()).padding(8.dp)) {
                Text(b.text, style = Small.copy(color = Monokai.base05), softWrap = false)
            }
            is Md.Table -> Box(Modifier.horizontalScroll(rememberScrollState())) {
                Text(table(b.rows), style = Small.copy(color = Monokai.base05), softWrap = false)
            }
            Md.Rule -> Rule()
        }
    }
}

// A table drawn in box lines, its columns as wide as their widest cell.
private fun table(rows: List<List<String>>): AnnotatedString = buildAnnotatedString {
    val cols = rows.maxOf { it.size }
    val plain = rows.map { r -> List(cols) { c -> inline(r.getOrElse(c) { "" }) } }
    val widths = List(cols) { c -> plain.maxOf { it[c].length } }
    plain.forEachIndexed { n, r ->
        if (n > 0) append("\n")
        r.forEachIndexed { c, cell ->
            if (c > 0) withStyle(SpanStyle(color = Monokai.base03)) { append(" │ ") }
            if (n == 0) withStyle(SpanStyle(fontWeight = FontWeight.ExtraBold)) { append(cell) } else append(cell)
            append(" ".repeat(widths[c] - cell.length))
        }
        if (n == 0) {
            append("\n")
            withStyle(SpanStyle(color = Monokai.base03)) { append(widths.joinToString("─┼─") { "─".repeat(it) }) }
        }
    }
}
