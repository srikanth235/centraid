package dev.centraid.android.a11y

import com.squareup.wire.Message
import com.squareup.wire.WireField
import okio.ByteString

/**
 * A STATE WITH ITS WORDS: Rust finishes every sentence a screen shows (`state.chrome.new_note`, a row's
 * `accessibility_label`), so a hand-built state with empty strings would make every control "unlabelled" for a
 * reason that is the fixture's. [labelled] gives each EMPTY text field of a message (and of the messages and
 * rows inside it) its own name, humanised ("new_note" becomes "New note"), so a label the screen draws from the
 * wire is present and distinct, and one a screen forgets to draw (or hardcodes empty) still shows as missing.
 * Fields that are keys, ids, routes or colours are not words and are left as the fixture set them.
 */
internal fun <T : Any> T.labelled(): T = labelledAny(this, "") as T

private val NOT_WORDS = Regex("(^|_)(key|id|ids|icon|color|colour|accent|route|screen|uri|url|tab|app|token|tag|kind|scheme|instance|currency|locale|iso|code|name_key|anchor|query|term)($|_)")

private fun labelledAny(value: Any?, field: String): Any? = when {
    value == null -> null
    value is String -> if (value.isEmpty() && !NOT_WORDS.containsMatchIn(field)) humanise(field) else value
    value is List<*> -> value.map { labelledAny(it, field) }
    value is Message<*, *> -> labelledMessage(value)
    else -> value
}

private fun humanise(field: String): String =
    field.trim('_').replace('_', ' ').replaceFirstChar { it.uppercase() }.ifEmpty { "Text" }

private fun labelledMessage(m: Message<*, *>): Message<*, *> {
    val cls = m.javaClass
    val fields = cls.declaredFields
        .filter { it.getAnnotation(WireField::class.java) != null }
        .sortedBy { it.getAnnotation(WireField::class.java).schemaIndex }
    val copy = cls.methods.firstOrNull { it.name == "copy" && it.parameterCount == fields.size + 1 } ?: return m
    val args = fields.map { f ->
        f.isAccessible = true
        labelledAny(f.get(m), f.name)
    } + (m.unknownFields as ByteString)
    return copy.invoke(m, *args.toTypedArray()) as Message<*, *>
}
