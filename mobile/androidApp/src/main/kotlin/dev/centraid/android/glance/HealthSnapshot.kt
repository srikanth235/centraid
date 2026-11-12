package dev.centraid.android.glance

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.io.IOException
import java.text.ParseException
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * WHAT THE HEALTH WIDGET DRAWS (#1185): the document Rust writes through `Effect.health_glance`
 * (`crates/screens/src/health/glance/snapshot.rs`, schema version 1), read back here. Every word and
 * figure is Rust's, finished in the member's language and units; this file only decodes. Unknown keys
 * are ignored; a document that does not parse, or names another version, reads as no document at
 * all ([HealthSnapshot.load] returns null), which the widget draws as its name and the "open
 * Centraid" sentence.
 */
internal data class HealthWords(
    val title: String,
    val empty: String,
    val nothing: String,
    val stale: String,
    val staleHint: String,
    val unavailable: String,
    val stepsCaption: String,
)

/** One figure: [metric] is `steps`, `sleep`, `energy`, `exercise` or `weight`; [text] is value and unit joined. */
internal data class HealthFigure(
    val metric: String,
    val label: String,
    val value: String,
    val unit: String,
    val text: String,
)

internal data class HealthSnapshot(
    /** `ready`, `empty` or `unavailable`. */
    val state: String,
    /** Local wall clock in [zone], `yyyy-MM-ddTHH:mm`; after it the widget shows the stale words. */
    val refreshAfter: String,
    val zone: String,
    /** The core's opaque key for a tap on the widget (never a screen). */
    val open: String,
    val words: HealthWords,
    val figures: List<HealthFigure>,
    val sleepLine: String,
) {
    /** The instant the document runs out (epoch ms), or null when `refresh_after` is empty or does not read. */
    fun refreshAtMillis(): Long? {
        if (refreshAfter.isEmpty()) return null
        return try {
            SimpleDateFormat(STAMP, Locale.ROOT).apply {
                timeZone = TimeZone.getTimeZone(zone)
                isLenient = false
            }.parse(refreshAfter)?.time
        } catch (_: ParseException) {
            null
        }
    }

    /** A ready document past its `refresh_after`, or one whose stamp does not read (never trusted as fresh). */
    fun isStale(nowMillis: Long): Boolean {
        if (state != "ready") return false
        val at = refreshAtMillis() ?: return true
        return nowMillis >= at
    }

    companion object {
        /** The only schema version this reader draws. */
        const val VERSION: Int = 1

        /** The file name under the app's files directory; Rust names it in the effect, this is the reader's copy. */
        const val FILE: String = "health-glance.json"

        private const val STAMP = "yyyy-MM-dd'T'HH:mm"

        /** The snapshot as the last write left it, or null when there is none this reader trusts. */
        fun load(context: Context): HealthSnapshot? {
            val text = try {
                AtomicFile(file(context, FILE)).openRead().use { it.readBytes().toString(Charsets.UTF_8) }
            } catch (_: IOException) {
                return null
            }
            return parse(text)
        }

        internal fun file(context: Context, name: String): File = File(context.filesDir, name)

        internal fun parse(text: String): HealthSnapshot? = try {
            val root = JSONObject(text)
            if (root.optInt("version", 0) != VERSION) {
                null
            } else {
                val words = root.getJSONObject("words")
                HealthSnapshot(
                    state = root.optString("state"),
                    refreshAfter = root.optString("refresh_after"),
                    zone = root.optString("zone"),
                    open = root.optString("open"),
                    words = HealthWords(
                        title = words.optString("title"),
                        empty = words.optString("empty"),
                        nothing = words.optString("nothing"),
                        stale = words.optString("stale"),
                        staleHint = words.optString("stale_hint"),
                        unavailable = words.optString("unavailable"),
                        stepsCaption = words.optString("steps_caption"),
                    ),
                    figures = objects(root.optJSONArray("figures")).map { row ->
                        HealthFigure(
                            metric = row.optString("metric"),
                            label = row.optString("label"),
                            value = row.optString("value"),
                            unit = row.optString("unit"),
                            text = row.optString("text"),
                        )
                    },
                    sleepLine = root.optString("sleep_line"),
                )
            }
        } catch (_: JSONException) {
            null
        }

        private fun objects(array: JSONArray?): List<JSONObject> =
            if (array == null) emptyList() else (0 until array.length()).mapNotNull { array.optJSONObject(it) }
    }
}
