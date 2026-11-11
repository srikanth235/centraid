package dev.centraid.android.glance

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * HEALTH'S WIDGET DOCUMENT AS THE SHELL READS IT (#1185): a version-1 document parses (unknown keys
 * ignored), any other reads as nothing, and staleness is a comparison of the document's own civil
 * stamp in its own zone. Robolectric because `org.json` is the platform's.
 */
@RunWith(RobolectricTestRunner::class)
class HealthSnapshotTest {
    private val sample = """
        {"version":1,"state":"ready","today":"2026-11-11","zone":"Europe/Berlin",
         "refresh_after":"2026-11-12T00:00","open":"home",
         "words":{"title":"Health","empty":"No store","nothing":"Nothing yet","stale":"Out of date",
                  "stale_hint":"Open Centraid","unavailable":"Unavailable","steps_caption":"steps today"},
         "figures":[{"metric":"steps","label":"Steps","value":"8,412","unit":"","text":"8,412"},
                    {"metric":"weight","label":"Weight","value":"72.4","unit":"kg","text":"72.4 kg"}],
         "sleep_line":"Slept 7 h 12 min","future_key":1}
    """.trimIndent()

    @Test
    fun aVersionOneDocumentParses() {
        val snapshot = HealthSnapshot.parse(sample)
        assertNotNull(snapshot)
        snapshot!!
        assertEquals("ready", snapshot.state)
        assertEquals("home", snapshot.open)
        assertEquals("steps today", snapshot.words.stepsCaption)
        assertEquals(listOf("steps", "weight"), snapshot.figures.map { it.metric })
        assertEquals("72.4 kg", snapshot.figures[1].text)
        assertEquals("Slept 7 h 12 min", snapshot.sleepLine)
    }

    @Test
    fun anotherVersionOrBrokenJsonIsNothing() {
        assertNull(HealthSnapshot.parse(sample.replace("\"version\":1", "\"version\":2")))
        assertNull(HealthSnapshot.parse("{"))
        assertNull(HealthSnapshot.parse("{\"version\":1}"))
    }

    @Test
    fun staleOnceRefreshAfterHasPassedInTheDocumentsZone() {
        val snapshot = HealthSnapshot.parse(sample)!!
        // 2026-11-12T00:00 in Berlin (UTC+1 in November) is 2026-11-11T23:00Z.
        val at = snapshot.refreshAtMillis()
        assertEquals(1_794_438_000_000L, at)
        assertFalse(snapshot.isStale(at!! - 60_000L))
        assertTrue(snapshot.isStale(at))
    }

    @Test
    fun onlyAReadyDocumentCanBeStaleAndABadStampIsStale() {
        val snapshot = HealthSnapshot.parse(sample)!!
        assertFalse(snapshot.copy(state = "empty").isStale(Long.MAX_VALUE))
        assertTrue(snapshot.copy(refreshAfter = "garbage").isStale(0L))
    }
}
