package dev.centraid.android.glance

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.io.IOException
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

internal data class GlanceLine(
    val text: String,
    val url: String,
    val kind: String,
)

internal data class GlanceSnapshot(
    val title: String,
    val day: String,
    val summary: String,
    val lines: List<GlanceLine>,
) {
    companion object {
        const val VERSION: Int = 1
        const val KEY: String = "widget.today"

        fun load(context: Context): GlanceSnapshot? {
            val candidates = buildList {
                add(file(context))
                context.filesDir.listFiles()?.forEach { child ->
                    if (child.isDirectory) {
                        add(File(child, "vault.db.device/$KEY"))
                    }
                }
            }
            val existing = candidates.firstOrNull { it.isFile } ?: return null
            val text = try {
                AtomicFile(existing).openRead().use { it.readBytes().toString(Charsets.UTF_8) }
            } catch (_: IOException) {
                return null
            }
            return parse(text)
        }

        internal fun file(context: Context): File = File(context.filesDir, KEY)

        internal fun parse(text: String): GlanceSnapshot? = try {
            val root = JSONObject(text)
            if (root.optInt("v", 0) != VERSION) {
                null
            } else {
                GlanceSnapshot(
                    title = root.optString("title"),
                    day = root.optString("day"),
                    summary = root.optString("summary"),
                    lines = objects(root.optJSONArray("lines")).map { row ->
                        GlanceLine(
                            text = row.optString("text"),
                            url = row.optString("url"),
                            kind = row.optString("kind"),
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
