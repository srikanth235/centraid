package dev.centraid.android.session

import java.net.Inet6Address
import java.net.InetAddress
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE ANDROID GATEWAY BROWSE, WITHOUT A NETWORK (#1080, Q-1080-D3, #1152).
 *
 * `GatewayBrowseRun` is the browse's whole decision structure: what is worth reporting, how one
 * instance on two interfaces becomes one sighting, and the one answer a window ends with. It runs
 * here over fakes for the two platform seams (`ServiceFinder`, `AddressResolver`), the same split
 * as iOS's `GatewayBrowseTests`. `NsdManager` finding a real advertisement is not provable without
 * an mDNS responder; `docs/release/v1-handoffs.md` carries that. Each rule has its negative beside
 * it: a result with no `gw` is never reported, a second answer is never delivered, and an answer
 * after the window is ignored. Which sighting is which gateway is Rust's.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class GatewayBrowseTest {
    private val id = "ab".repeat(32)

    // ---- spelling, the TXT filter and the TXT map -----------------------------------------------

    @Test
    fun anIPv4EndpointIsHostColonPort() {
        val host = InetAddress.getByAddress(byteArrayOf(192.toByte(), 168.toByte(), 1, 44))
        assertEquals("192.168.1.44:7443", GatewayBrowse.spelling(host, 7443))
    }

    @Test
    fun anIPv6EndpointIsBracketedAndLosesItsScope() {
        val bytes = ByteArray(16).also { it[0] = 0xfd.toByte(); it[15] = 5 }
        val scoped = Inet6Address.getByAddress(null, bytes, 2)
        assertTrue("the fixture carries a scope", scoped.hostAddress!!.contains('%'))
        assertEquals("[fd00:0:0:0:0:0:0:5]:7443", GatewayBrowse.spelling(scoped, 7443))
    }

    @Test
    fun aPortNoSocketHasIsNeverAnAddress() {
        val host = InetAddress.getByAddress(byteArrayOf(10, 0, 0, 5))
        assertNull(GatewayBrowse.spelling(host, 0))
        assertNull(GatewayBrowse.spelling(host, -1))
        assertNull(GatewayBrowse.spelling(host, 65_536))
        assertEquals("10.0.0.5:65535", GatewayBrowse.spelling(host, 65_535))
    }

    @Test
    fun onlyARecordWithAGatewayIdIsWorthReporting() {
        assertTrue(GatewayBrowse.claimsGateway(mapOf("gw" to id, "v" to "2")))
        assertTrue(GatewayBrowse.claimsGateway(mapOf("GW" to id)))
        assertFalse(GatewayBrowse.claimsGateway(mapOf("v" to "2")))
        assertFalse(GatewayBrowse.claimsGateway(mapOf("gw" to "  ")))
        assertFalse(GatewayBrowse.claimsGateway(emptyMap()))
    }

    @Test
    fun aTxtMapIsTextAndAFlagKeyIsEmpty() {
        val txt = GatewayBrowse.txtOf(mapOf("gw" to id.toByteArray(), "v" to "2".toByteArray(), "flag" to null))
        assertEquals(mapOf("gw" to id, "v" to "2", "flag" to ""), txt)
    }

    // ---- one run --------------------------------------------------------------------------------

    @Test
    fun anAdvertisementIsResolvedAndAnsweredOnceAtTheWindow() = runTest {
        val finder = FakeFinder()
        val resolver = FakeResolver(mapOf("lan" to Resolution(mapOf("gw" to id), listOf("192.168.1.44:7443"))))
        val answer = async { GatewayBrowseRun(finder, resolver, 300).run() }
        runCurrent()
        finder.show(service("centraid-gateway-abababab", "lan"))
        advanceTimeBy(299)
        assertFalse("the window has not ended", answer.isCompleted)
        advanceTimeBy(2)
        // A late sighting after the window changes nothing.
        finder.show(service("centraid-gateway-late", "late"))
        runCurrent()
        assertEquals(
            listOf(ResolvedService("centraid-gateway-abababab", mapOf("gw" to id), listOf("192.168.1.44:7443"))),
            answer.await(),
        )
        assertTrue(finder.stopped)
        assertTrue(resolver.cancelled)
        assertEquals(listOf("lan"), resolver.asked)
    }

    @Test
    fun aResultWithNoGatewayIdIsNeverReported() = runTest {
        val finder = FakeFinder()
        val resolver = FakeResolver(mapOf("decoy" to Resolution(mapOf("v" to "2"), listOf("192.168.1.99:7443"))))
        val answer = async { GatewayBrowseRun(finder, resolver, 200).run() }
        runCurrent()
        finder.show(service("centraid-gateway-abababab", "decoy"))
        advanceTimeBy(201)
        assertEquals(emptyList<ResolvedService>(), answer.await())
    }

    @Test
    fun oneInstanceOnTwoInterfacesIsOneSighting() = runTest {
        val finder = FakeFinder()
        val resolver = FakeResolver(
            mapOf(
                "en0" to Resolution(mapOf("gw" to id), listOf("192.168.1.44:7443")),
                "en1" to Resolution(mapOf("gw" to id), listOf("192.168.1.44:7443", "[fd00::5]:7443")),
            ),
        )
        val answer = async { GatewayBrowseRun(finder, resolver, 300).run() }
        runCurrent()
        finder.show(
            service("centraid-gateway-abababab", "en0"),
            service("centraid-gateway-abababab", "en1"),
        )
        // The same result shown again is not resolved again.
        finder.show(service("centraid-gateway-abababab", "en0"))
        advanceTimeBy(301)
        val found = answer.await()
        assertEquals(1, found.size)
        assertEquals(listOf("192.168.1.44:7443", "[fd00::5]:7443"), found[0].addresses)
        assertEquals(listOf("en0", "en1"), resolver.asked.sorted())
    }

    @Test
    fun aResolveThatAnswersTwiceMergesIntoOneSighting() = runTest {
        // Android 14's service-info callback reports addresses as they are learned.
        val finder = FakeFinder()
        val resolver = FakeResolver(
            mapOf("lan" to Resolution(mapOf("gw" to id), listOf("192.168.1.44:7443"))),
            then = mapOf("lan" to Resolution(mapOf("gw" to id), listOf("[fd00::5]:7443", "192.168.1.44:7443"))),
        )
        val answer = async { GatewayBrowseRun(finder, resolver, 300).run() }
        runCurrent()
        finder.show(service("centraid-gateway-abababab", "lan"))
        advanceTimeBy(301)
        assertEquals(listOf("192.168.1.44:7443", "[fd00::5]:7443"), answer.await().single().addresses)
    }

    @Test
    fun anAdvertisementThatNeverAnswersIsLeftOutNotWaitedFor() = runTest {
        val finder = FakeFinder()
        val answer = async { GatewayBrowseRun(finder, FakeResolver(emptyMap()), 300).run() }
        runCurrent()
        finder.show(service("centraid-gateway-gone", "stale"))
        advanceTimeBy(299)
        assertFalse(answer.isCompleted)
        advanceTimeBy(2)
        assertEquals(emptyList<ResolvedService>(), answer.await())
    }

    @Test
    fun aResolveWithNoAddressIsLeftOut() = runTest {
        val finder = FakeFinder()
        val resolver = FakeResolver(mapOf("lan" to Resolution(mapOf("gw" to id), emptyList())))
        val answer = async { GatewayBrowseRun(finder, resolver, 100).run() }
        runCurrent()
        finder.show(service("centraid-gateway-abababab", "lan"))
        advanceTimeBy(101)
        assertEquals(emptyList<ResolvedService>(), answer.await())
    }

    @Test
    fun aBrowserThatFailsEndsTheBrowseAtOnceWithNothing() = runTest {
        val finder = FakeFinder()
        val answer = async { GatewayBrowseRun(finder, FakeResolver(emptyMap()), 30_000).run() }
        runCurrent()
        finder.fail()
        runCurrent()
        assertTrue("answered long before the window", answer.isCompleted)
        assertEquals(emptyList<ResolvedService>(), answer.await())
        assertEquals(0, currentTime)
        assertTrue(finder.stopped)
    }

    @Test
    fun aWindowCancelledMidwayStopsTheFinderAndAnswersNothing() = runTest {
        val finder = FakeFinder()
        val resolver = FakeResolver(emptyMap())
        val answer = async { GatewayBrowseRun(finder, resolver, 30_000).run() }
        runCurrent()
        answer.cancel()
        runCurrent()
        assertTrue(answer.isCancelled)
        assertTrue(finder.stopped)
        assertTrue(resolver.cancelled)
    }

    // ---- one resolve at a time ------------------------------------------------------------------

    @Test
    fun aSecondJobWaitsForTheFirstToRelease() {
        val line = OneAtATime()
        val log = mutableListOf<String>()
        val releases = mutableListOf<() -> Unit>()
        line.submit { release -> log += "a"; releases += release }
        line.submit { release -> log += "b"; releases += release }
        assertEquals(listOf("a"), log)
        releases[0]()
        assertEquals(listOf("a", "b"), log)
    }

    @Test
    fun aReleaseCalledTwiceReleasesOnce() {
        val line = OneAtATime()
        val log = mutableListOf<String>()
        val releases = mutableListOf<() -> Unit>()
        line.submit { release -> log += "a"; releases += release }
        line.submit { release -> log += "b"; releases += release }
        line.submit { release -> log += "c"; releases += release }
        releases[0]()
        releases[0]()
        assertEquals("b is out, so c waits", listOf("a", "b"), log)
    }

    @Test
    fun aJobThatThrowsDoesNotHoldTheLine() {
        val line = OneAtATime()
        val log = mutableListOf<String>()
        line.submit { error("the platform refused") }
        line.submit { release -> log += "b"; release() }
        assertEquals(listOf("b"), log)
    }

    @Test
    fun clearingDropsWhatHasNotStartedAndStartsNothingMore() {
        val line = OneAtATime()
        val log = mutableListOf<String>()
        val releases = mutableListOf<() -> Unit>()
        line.submit { release -> log += "a"; releases += release }
        line.submit { log += "b" }
        line.clear()
        releases[0]()
        line.submit { log += "c" }
        assertEquals(listOf("a"), log)
    }

    // ---- fakes ----------------------------------------------------------------------------------

    /** The interface is carried in the key so each result has its own, as two interfaces would. */
    private fun service(name: String, interfaceName: String) = FoundService(name = name, key = interfaceName)

    private class FakeFinder : ServiceFinder {
        private var found: ((List<FoundService>) -> Unit)? = null
        private var failed: (() -> Unit)? = null
        var stopped = false

        override fun start(found: (List<FoundService>) -> Unit, failed: () -> Unit) {
            this.found = found
            this.failed = failed
        }

        override fun stop() {
            stopped = true
        }

        fun show(vararg services: FoundService) = found?.invoke(services.toList())

        fun fail() = failed?.invoke()
    }

    /** Answers by the service's key (its interface); an unlisted one never answers, as a stale advertisement does not. */
    private class FakeResolver(
        private val answers: Map<String, Resolution>,
        private val then: Map<String, Resolution> = emptyMap(),
    ) : AddressResolver {
        val asked = mutableListOf<String>()
        var cancelled = false

        override fun resolve(service: FoundService, completion: (Resolution) -> Unit) {
            asked += service.key
            answers[service.key]?.let(completion)
            then[service.key]?.let(completion)
        }

        override fun cancelAll() {
            cancelled = true
        }
    }
}
