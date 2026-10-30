package dev.centraid.android.session

import centraid.core.v1.BrowseGateways
import centraid.core.v1.EffectResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE `BrowseGateways` EFFECT'S LIFE, WITHOUT A NETWORK (#1152): which windows run, when each is
 * answered, and what ends a browse. The window itself is a fake; what a window finds is
 * `GatewayBrowseTest`'s.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class GatewayBrowsingTest {
    private val id = "ab".repeat(32)
    private val sighting = ResolvedService("centraid-gateway-abababab", mapOf("gw" to id), listOf("192.168.1.44:7443"))

    private class Harness(scope: CoroutineScope, found: List<ResolvedService>, private val takes: Long = 100) {
        val windows = mutableListOf<Long>()
        val answers = mutableListOf<EffectResult>()
        val browsing = GatewayBrowsing(scope) { windowMs ->
            windows += windowMs
            delay(takes)
            found
        }

        fun perform(instance: Long, on: Boolean, window: Int = 4_000, repeat: Int = 0): EffectResult? =
            browsing.perform(instance, BrowseGateways(on = on, window_ms = window, repeat_ms = repeat)) { answers += it }
    }

    @Test
    fun aBrowseWithNoRepeatAnswersOneWindowAndEnds() = runTest {
        val h = Harness(backgroundScope, listOf(sighting))
        assertNull("it answers itself later", h.perform(7, on = true, window = 4_000, repeat = 0))
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(listOf(4_000L), h.windows)
        val sighted = h.answers.single().gateways_sighted!!
        assertEquals("centraid-gateway-abababab", sighted.sightings.single().service_name)
        assertEquals(mapOf("gw" to id), sighted.sightings.single().txt)
        assertEquals(listOf("192.168.1.44:7443"), sighted.sightings.single().addresses)
        advanceTimeBy(600_000)
        assertEquals("a once-browse never browses again", 1, h.windows.size)
    }

    @Test
    fun aWindowThatFindsNothingIsAnEmptyAnswer() = runTest {
        val h = Harness(backgroundScope, emptyList())
        h.perform(7, on = true)
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(emptyList<Any>(), h.answers.single().gateways_sighted!!.sightings)
    }

    @Test
    fun aRepeatingBrowseAnswersEveryWindowUnderTheOneEffect() = runTest {
        val h = Harness(backgroundScope, listOf(sighting))
        h.perform(7, on = true, window = 4_000, repeat = 30_000)
        advanceTimeBy(1_000)
        assertEquals(1, h.answers.size)
        advanceTimeBy(30_000)
        assertEquals(2, h.answers.size)
        advanceTimeBy(30_100)
        assertEquals(3, h.answers.size)
        h.browsing.stop(7)
        advanceTimeBy(300_000)
        assertEquals(3, h.answers.size)
    }

    @Test
    fun offEndsTheBrowseAndAnswersDone() = runTest {
        val h = Harness(backgroundScope, listOf(sighting))
        h.perform(7, on = true, repeat = 30_000)
        advanceTimeBy(1_000)
        val off = h.perform(7, on = false)
        assertNotNull(off?.done)
        advanceTimeBy(300_000)
        assertEquals("only the window before `off`", 1, h.answers.size)
    }

    @Test
    fun aBrowseStoppedDuringItsWindowAnswersNothing() = runTest {
        val h = Harness(backgroundScope, listOf(sighting), takes = 5_000)
        h.perform(7, on = true)
        advanceTimeBy(2_000)
        h.browsing.stop(7)
        advanceTimeBy(60_000)
        assertTrue(h.answers.isEmpty())
    }

    @Test
    fun aSecondBrowseFromTheSameScreenReplacesTheFirst() = runTest {
        val h = Harness(backgroundScope, listOf(sighting))
        h.perform(7, on = true, repeat = 30_000)
        advanceTimeBy(1_000)
        h.perform(7, on = true, window = 2_000, repeat = 0)
        advanceTimeBy(600_000)
        assertEquals("one answer from the first, one from the second, no more", 2, h.answers.size)
        assertEquals(listOf(4_000L, 2_000L), h.windows)
    }

    @Test
    fun aClosedScreenEndsItsBrowseAndOnlyItsBrowse() = runTest {
        val h = Harness(backgroundScope, listOf(sighting))
        h.perform(7, on = true, repeat = 30_000)
        h.perform(8, on = true, repeat = 30_000)
        advanceTimeBy(1_000)
        assertEquals(2, h.answers.size)
        h.browsing.retain(setOf(8L))
        advanceTimeBy(30_000)
        assertEquals("only screen 8 browsed again", 3, h.answers.size)
    }
}
