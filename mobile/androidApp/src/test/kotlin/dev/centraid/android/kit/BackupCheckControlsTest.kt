package dev.centraid.android.kit

import centraid.core.v1.BackupCheckAction
import centraid.core.v1.BackupCheckRow
import centraid.core.v1.BackupCheckState
import centraid.core.v1.BackupCheckTone
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/**
 * THE ONE FIXTURE BOTH SHELLS READ (`contracts/backup/check-controls.json`, #1188 B13): for each state,
 * the selectors the Check my backup page draws in order, the event each tap sends and how a row is inked.
 * The iOS shell's `BackupCheckControlsTests` reads the same file. Robolectric because `org.json` is the
 * platform's; nothing here draws.
 */
@RunWith(RobolectricTestRunner::class)
class BackupCheckControlsTest {
    private fun action(name: String) = when (name) {
        "start" -> BackupCheckAction.BACKUP_CHECK_ACTION_CHECK
        "stop" -> BackupCheckAction.BACKUP_CHECK_ACTION_STOP
        else -> BackupCheckAction.BACKUP_CHECK_ACTION_NONE
    }

    private fun tone(name: String) = when (name) {
        "ok" -> BackupCheckTone.BACKUP_CHECK_TONE_OK
        "bad" -> BackupCheckTone.BACKUP_CHECK_TONE_BAD
        else -> BackupCheckTone.BACKUP_CHECK_TONE_NOT_RUN
    }

    private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

    @Test
    fun theSharedFixtureHoldsOnThisShell() {
        val root = JSONObject(File("../../contracts/backup/check-controls.json").readText())
        val cases = root.getJSONArray("cases")
        assertTrue("the fixture has cases", cases.length() >= 6)
        for (n in 0 until cases.length()) {
            val case = cases.getJSONObject(n)
            val name = case.getString("name")
            val given = case.getJSONObject("state")
            val rows = given.getJSONArray("rows")
            val state = BackupCheckState(
                heading = given.getString("heading"),
                running = given.getBoolean("running"),
                action = action(given.getString("action")),
                action_label = given.getString("action_label"),
                back_up_now_label = given.getString("back_up_now_label"),
                rows = (0 until rows.length()).map {
                    val row = rows.getJSONObject(it)
                    BackupCheckRow(gateway_id = row.getString("gateway_id"), tone = tone(row.getString("tone")))
                },
            )
            assertEquals(name, case.getJSONArray("shown").strings(), BackupCheckControls.shown(state))
            val taps = case.getJSONObject("taps")
            for (tag in taps.keys()) {
                assertEquals("$name: $tag", taps.getString(tag), BackupCheckControls.eventFor(tag))
            }
            val ink = case.getJSONObject("ink")
            for (row in state.rows) {
                assertEquals("$name: ${row.gateway_id}", ink.getString(row.gateway_id), BackupCheckControls.ink(row.tone))
            }
        }
    }
}
