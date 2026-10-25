package dev.centraid.android.screens.chat

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight

/**
 * AN ANSWER'S MARKDOWN, DRAWN AS TEXT AND NEVER AS ITS MARKERS (the Compose twin of iOS's
 * `ChatMarkdown`). A small model writes `**bold**`, `*italic*`, `` `code` `` and `-` or `1.` lists
 * whether or not anyone asked. The block structure is read line by line: a line that starts `-`,
 * `*`, `+`, `•` or `1.` / `1)` is a list item, a line that starts `#` is a heading (the strong
 * weight), everything else is a paragraph and a blank line ends one. **Nothing is a link**: a
 * tappable address in an answer is a way out of the device the member did not ask for, so
 * `[x](https://…)` keeps its words and drops the address. While an answer streams, a marker that
 * has not closed yet is left out until its partner arrives.
 */
internal object ChatMarkdown {
    sealed interface Block {
        data class Paragraph(val text: AnnotatedString) : Block
        data class Item(val marker: String, val text: AnnotatedString) : Block
        data class Heading(val text: AnnotatedString) : Block
    }

    fun blocks(text: String, streaming: Boolean = false): List<Block> {
        val out = mutableListOf<Block>()
        val paragraph = mutableListOf<String>()
        fun flush() {
            if (paragraph.isEmpty()) return
            out += Block.Paragraph(inline(paragraph.joinToString("\n"), streaming))
            paragraph.clear()
        }
        for (raw in text.replace("\r\n", "\n").split("\n")) {
            val line = raw.trim()
            val item = listItem(line)
            val heading = headingText(line)
            when {
                line.isEmpty() -> flush()
                item != null -> {
                    flush()
                    out += Block.Item(item.first, inline(item.second, streaming))
                }
                heading != null -> {
                    flush()
                    out += Block.Heading(inline(heading, streaming, strong = true))
                }
                else -> paragraph += line
            }
        }
        flush()
        return out
    }

    /** One run of text with its inline Markdown applied, links removed and markers never shown. */
    fun inline(text: String, streaming: Boolean = false, strong: Boolean = false): AnnotatedString {
        val prepared = unlinked(if (streaming) withoutUnclosed(text) else text)
        return buildAnnotatedString {
            var bold = false
            var italic = false
            var code = false
            var i = 0
            fun style() = SpanStyle(
                fontWeight = if (bold || strong) FontWeight.SemiBold else null,
                fontStyle = if (italic) FontStyle.Italic else null,
                fontFamily = if (code) FontFamily.Monospace else null,
            )
            val run = StringBuilder()
            fun emit() {
                if (run.isNotEmpty()) {
                    pushStyle(style())
                    append(run.toString())
                    pop()
                    run.clear()
                }
            }
            while (i < prepared.length) {
                when {
                    prepared.startsWith("**", i) && !code -> {
                        emit()
                        bold = !bold
                        i += 2
                    }
                    prepared[i] == '`' -> {
                        emit()
                        code = !code
                        i += 1
                    }
                    // A star that opens must touch a word; one that closes may follow anything.
                    prepared[i] == '*' && !code && (italic || (i + 1 < prepared.length && prepared[i + 1] != ' ')) -> {
                        emit()
                        italic = !italic
                        i += 1
                    }
                    else -> {
                        run.append(prepared[i])
                        i += 1
                    }
                }
            }
            emit()
        }
    }

    /** The words alone, for a screen reader: no asterisks, backticks or hashes. */
    fun plain(text: String): String = blocks(text).joinToString(". ") { block ->
        when (block) {
            is Block.Paragraph -> block.text.text
            is Block.Heading -> block.text.text
            is Block.Item -> block.marker + " " + block.text.text
        }
    }

    private fun listItem(line: String): Pair<String, String>? {
        if (line.length > 1 && line[0] in "-*+•" && line[1] == ' ') {
            val rest = line.drop(2).trim()
            // `**bold**` starts with a star and no space: not an item.
            return if (rest.isEmpty()) null else "•" to rest
        }
        val digits = line.takeWhile { it.isDigit() }.take(3)
        val at = digits.length
        if (digits.isEmpty() || at + 1 >= line.length) return null
        if ((line[at] != '.' && line[at] != ')') || line[at + 1] != ' ') return null
        val rest = line.drop(at + 2).trim()
        return if (rest.isEmpty()) null else "$digits." to rest
    }

    private fun headingText(line: String): String? {
        val hashes = line.takeWhile { it == '#' }.length
        if (hashes !in 1..6 || line.length <= hashes || line[hashes] != ' ') return null
        return line.drop(hashes + 1).trim().ifEmpty { null }
    }

    /** `[words](address)` keeps the words. */
    private fun unlinked(text: String): String =
        Regex("\\[([^\\]]*)]\\([^)]*\\)").replace(text) { it.groupValues[1] }

    /** A marker that has not closed yet is dropped, so `**bol` never flashes as asterisks. */
    private fun withoutUnclosed(text: String): String {
        var out = text
        if (out.split("**").size % 2 == 0) out = out.substringBeforeLast("**") + out.substringAfterLast("**")
        if (out.count { it == '`' } % 2 == 1) out = out.substringBeforeLast('`') + out.substringAfterLast('`')
        return out
    }
}
