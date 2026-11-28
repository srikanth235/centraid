package dev.centraid.android.glance

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GlanceSnapshotTest {
    @Test
    fun parsesD6WidgetTodaySnapshot() {
        val json = """
            {
              "v": 1,
              "title": "Today",
              "day": "2026-11-26",
              "summary": "1 event · 1 task",
              "lines": [
                {"text": "Lunch with Ana", "url": "centraid://open/event/e1", "kind": "event"},
                {"text": "Pay bill", "url": "centraid://open/task/t1", "kind": "task"}
              ]
            }
        """.trimIndent()
        val parsed = GlanceSnapshot.parse(json)
        assertNotNull(parsed)
        assertEquals("Today", parsed!!.title)
        assertEquals("2026-11-26", parsed.day)
        assertEquals("1 event · 1 task", parsed.summary)
        assertEquals(2, parsed.lines.size)
        assertEquals("centraid://open/event/e1", parsed.lines[0].url)
        assertEquals("task", parsed.lines[1].kind)
    }

    @Test
    fun rejectsWrongVersionOrMalformedJson() {
        assertNull(GlanceSnapshot.parse("""{"v": 2, "title": "Today"}"""))
        assertNull(GlanceSnapshot.parse("""{"version": 1, "state": "ready"}"""))
        assertNull(GlanceSnapshot.parse("not json"))
    }
}
