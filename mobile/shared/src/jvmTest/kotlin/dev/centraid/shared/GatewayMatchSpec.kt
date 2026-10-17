package dev.centraid.shared

import dev.centraid.shared.sync.AddressAnswer
import dev.centraid.shared.sync.GatewayBrowser
import dev.centraid.shared.sync.GatewayMatch
import dev.centraid.shared.sync.GatewayRediscovery
import dev.centraid.shared.sync.GatewaySighting
import dev.centraid.shared.sync.RecordedGateway
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.test.runTest

/**
 * WHICH SIGHTING IS WHICH GATEWAY (#1080, Q-1080-D3): by identity, never by
 * name. The core dials what this offers with the pinned certificate and checks
 * the gateway's own id; this is the rule for what is offered at all.
 */
class GatewayMatchSpec : StringSpec({

    val id = "ab".repeat(32)
    val other = "cd".repeat(32)

    fun sighting(name: String, gw: String?, vararg addresses: String) = GatewaySighting(
        serviceName = name,
        txt = if (gw == null) mapOf("v" to "2") else mapOf("gw" to gw, "v" to "2"),
        addresses = addresses.toList(),
    )

    "a sighting is a gateway's only by the id in its TXT record" {
        val named = "centraid-gateway-" + id.take(8)
        GatewayMatch.isGateway(sighting(named, id), id) shouldBe true
        GatewayMatch.isGateway(sighting("anything", id.uppercase()), id) shouldBe true
        // THE NAME IS NOT AN IDENTITY: the right name with no id, or with
        // another gateway's, is nobody's.
        GatewayMatch.isGateway(sighting(named, null), id) shouldBe false
        GatewayMatch.isGateway(sighting(named, other), id) shouldBe false
        GatewayMatch.isGateway(sighting(named, ""), id) shouldBe false
        GatewayMatch.isGateway(sighting(named, "not hex"), id) shouldBe false
        GatewayMatch.isGateway(sighting(named, id), "") shouldBe false
        // TXT KEYS ARE CASE-INSENSITIVE.
        GatewayMatch.isGateway(GatewaySighting(named, mapOf("GW" to id), emptyList()), id) shouldBe true
    }

    "only the matching sighting's dialable addresses are offered, new ones, once, IPv4 first" {
        val sightings = listOf(
            sighting("a", id, "[2001:db8::7]:7443", "192.168.1.44:7443", "192.168.1.44:7443"),
            sighting("b", other, "192.168.1.99:7443"),
            sighting("c", id, "192.168.1.20:7443", "laptop.local:7443"),
        )
        GatewayMatch.candidates(id, listOf("192.168.1.20:7443"), sightings) shouldBe
            listOf("192.168.1.44:7443", "[2001:db8::7]:7443")
        GatewayMatch.candidates(other, emptyList(), sightings) shouldBe listOf("192.168.1.99:7443")
        GatewayMatch.candidates("ef".repeat(32), emptyList(), sightings) shouldBe emptyList()
    }

    "an address is offered only as an IP literal the core can dial" {
        GatewayMatch.normalise("192.168.1.44:7443") shouldBe "192.168.1.44:7443"
        GatewayMatch.normalise("[2001:DB8::7]:7443") shouldBe "[2001:db8::7]:7443"
        for (bad in listOf(
            "laptop.local:7443", "192.168.1.44", "192.168.1.44:0", "192.168.1.44:70000", "0.0.0.0:7443",
            "127.0.0.1:7443", "224.0.0.251:5353", "999.1.1.1:7443", "[fe80::1]:7443", "[fe80::1%en0]:7443",
            "[ff02::fb]:5353", "[::1]:7443", "[::]:7443", "", ":7443",
        )) {
            GatewayMatch.normalise(bad) shouldBe null
        }
    }

    "no more than the core's cap is offered" {
        val many = sighting("a", id, *Array(20) { "10.0.0.${it + 1}:7443" })
        GatewayMatch.candidates(id, emptyList(), listOf(many)).size shouldBe GatewayMatch.MAX_CANDIDATES
    }

    "a rediscovery offers the core each matched gateway's new addresses and counts the ones it kept" {
        runTest {
            val browser = object : GatewayBrowser {
                override fun browse(windowMs: Long, done: (List<GatewaySighting>) -> Unit) {
                    done(listOf(sighting("a", id, "192.168.1.44:7443"), sighting("b", other, "192.168.1.99:7443")))
                }
            }
            val offered = mutableListOf<Pair<String, List<String>>>()
            val kept = GatewayRediscovery(browser).run(
                listOf(RecordedGateway(id, listOf("192.168.1.20:7443")), RecordedGateway("ef".repeat(32), emptyList())),
            ) { gateway, candidates ->
                offered += gateway to candidates
                AddressAnswer(refreshed = true, addrs = candidates)
            }
            kept shouldBe 1
            offered shouldBe listOf(id to listOf("192.168.1.44:7443"))
        }
    }

    "a browse that finds nothing, and no paired gateway, offer the core nothing" {
        runTest {
            val empty = object : GatewayBrowser {
                override fun browse(windowMs: Long, done: (List<GatewaySighting>) -> Unit) = done(emptyList())
            }
            var asked = false
            GatewayRediscovery(empty).run(listOf(RecordedGateway(id, emptyList()))) { _, _ -> asked = true; null } shouldBe 0
            GatewayRediscovery(empty).run(emptyList()) { _, _ -> asked = true; null } shouldBe 0
            asked shouldBe false
        }
    }
})
