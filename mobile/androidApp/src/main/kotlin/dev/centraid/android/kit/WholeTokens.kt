package dev.centraid.android.kit

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle

private val UNIT_AFTER_NUMBER = Regex("""(\d) (bytes|KB|MB|GB|TB)\b""")

/**
 * A NUMBER AND ITS UNIT STAY ON ONE LINE (#1202): "928 KB" broke as "928 / KB" at the largest
 * text. Display only; the words are Rust's.
 */
public fun unitsJoined(text: String): String = UNIT_AFTER_NUMBER.replace(text, "$1 $2")

private fun isAddress(token: String): Boolean =
    token.length >= 7 && token.any { it.isDigit() } && token.any { it == '.' || it == ':' }

/**
 * A SENTENCE THAT NEVER BREAKS AN ADDRESS (#1202). Words wrap as words do; a token with no space
 * that carries a digit and a dot or colon (a network address, "192.168.1.5:18455") is a line of its
 * own that shrinks to fit rather than split mid-number. The iOS twin is `KitWholeTokens`.
 */
@Composable
public fun WholeTokensText(text: String, style: TextStyle, color: Color, modifier: Modifier = Modifier) {
    val pieces = buildList {
        val run = mutableListOf<String>()
        fun flush() {
            if (run.isNotEmpty()) add(run.joinToString(" ") to false)
            run.clear()
        }
        for (token in unitsJoined(text).split(' ').filter { it.isNotEmpty() }) {
            if (isAddress(token)) {
                flush()
                add(token to true)
            } else {
                run += token
            }
        }
        flush()
    }
    Column(modifier) {
        pieces.forEach { (piece, whole) ->
            if (whole) {
                BasicText(
                    piece,
                    style = style.copy(color = color),
                    maxLines = 1,
                    softWrap = false,
                    autoSize = TextAutoSize.StepBased(minFontSize = style.fontSize * 0.5f, maxFontSize = style.fontSize),
                )
            } else {
                Text(piece, style = style, color = color)
            }
        }
    }
}
