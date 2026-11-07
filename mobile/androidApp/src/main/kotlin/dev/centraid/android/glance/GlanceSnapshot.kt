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
 * WHAT THE WIDGETS DRAW (#1173): the snapshot document Rust writes through `Effect.agenda_glance`
 * (`crates/screens/src/agenda/glance/snapshot.rs`, schema version 1), read back here. Every word in
 * it is Rust's; this file only decodes. Unknown keys are ignored; a document that does not parse,
 * or that names another version, reads as no document at all ([load] returns null), which a widget
 * draws as unavailable, never as an empty, healthy day.
 */
internal data class GlanceWords(
    val upNextTitle: String,
    val todayTitle: String,
    val remindersTitle: String,
    val nothingNext: String,
    val noReminders: String,
    val unavailable: String,
    val stale: String,
    val todayLabel: String,
    val overdueLabel: String,
    val flaggedLabel: String,
    val addLabel: String,
)

/** One row of the Up next list. [tint] is a colour key (`agenda` or `red`), never a colour. */
internal data class UpNextRow(
    val title: String,
    val timeLabel: String,
    val dayLabel: String,
    val tint: String,
)

/** One row of the Reminders list. */
internal data class ReminderRow(
    val title: String,
    val dueLabel: String,
    val overdue: Boolean,
    val flagged: Boolean,
)

internal data class GlanceSnapshot(
    /** `state == "ready"`; anything else is Rust saying the day could not be read. */
    val ready: Boolean,
    /** Local wall clock in [zone], `yyyy-MM-ddTHH:mm`; after it the widget shows [GlanceWords.stale]. */
    val refreshAfter: String,
    val zone: String,
    val words: GlanceWords,
    val upNext: List<UpNextRow>,
    val todayCount: Int,
    val overdueCount: Int,
    val flaggedCount: Int,
    val reminders: List<ReminderRow>,
) {
    /**
     * The instant the document runs out, in epoch milliseconds, or null when it names none that
     * reads (an unavailable document has no day to run out). The device's clock is read here and
     * nowhere in Rust: the widget is the platform's surface.
     */
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

    /**
     * True when the widget must say [GlanceWords.stale] instead of its rows: a ready document past
     * its `refresh_after`, or one whose `refresh_after` does not read (never trusted as fresh).
     */
    fun isStale(nowMillis: Long): Boolean {
        if (!ready) return false
        val at = refreshAtMillis() ?: return true
        return nowMillis >= at
    }

    companion object {
        /** The only schema version this reader draws. */
        const val VERSION: Int = 1

        /** The one file name, under the app's files directory; Rust's performer writes it. */
        const val FILE: String = "agenda-glance.json"

        private const val STAMP = "yyyy-MM-dd'T'HH:mm"

        /** The snapshot as the last write left it, or null when there is none that this reader trusts. */
        fun load(context: Context): GlanceSnapshot? {
            val text = try {
                AtomicFile(file(context)).openRead().use { it.readBytes().toString(Charsets.UTF_8) }
            } catch (_: IOException) {
                return null
            }
            return parse(text)
        }

        internal fun file(context: Context): File = File(context.filesDir, FILE)

        internal fun parse(text: String): GlanceSnapshot? = try {
            val root = JSONObject(text)
            if (root.optInt("version", 0) != VERSION) {
                null
            } else {
                val words = root.getJSONObject("words")
                val reminders = root.getJSONObject("reminders")
                GlanceSnapshot(
                    ready = root.optString("state") == "ready",
                    refreshAfter = root.optString("refresh_after"),
                    zone = root.optString("zone"),
                    words = GlanceWords(
                        upNextTitle = words.optString("up_next_title"),
                        todayTitle = words.optString("today_title"),
                        remindersTitle = words.optString("reminders_title"),
                        nothingNext = words.optString("nothing_next"),
                        noReminders = words.optString("no_reminders"),
                        unavailable = words.optString("unavailable"),
                        stale = words.optString("stale"),
                        todayLabel = words.optString("today_label"),
                        overdueLabel = words.optString("overdue_label"),
                        flaggedLabel = words.optString("flagged_label"),
                        addLabel = words.optString("add_label"),
                    ),
                    upNext = objects(root.optJSONArray("up_next")).map { row ->
                        UpNextRow(
                            title = row.optString("title"),
                            timeLabel = row.optString("time_label"),
                            dayLabel = row.optString("day_label"),
                            tint = row.optString("tint"),
                        )
                    },
                    todayCount = reminders.optInt("today_count"),
                    overdueCount = reminders.optInt("overdue_count"),
                    flaggedCount = reminders.optInt("flagged_count"),
                    reminders = objects(reminders.optJSONArray("rows")).map { row ->
                        ReminderRow(
                            title = row.optString("title"),
                            dueLabel = row.optString("due_label"),
                            overdue = row.optBoolean("overdue"),
                            flagged = row.optBoolean("flagged"),
                        )
                    },
                )
            }
        } catch (_: JSONException) {
            null
        }

        private fun objects(array: JSONArray?): List<JSONObject> =
            if (array == null) emptyList() else (0 until array.length()).mapNotNull { array.optJSONObject(it) }
    }
}
