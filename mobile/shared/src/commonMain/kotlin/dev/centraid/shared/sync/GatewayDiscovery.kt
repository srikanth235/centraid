package dev.centraid.shared.sync

import centraid.core.v1.RefreshDestinationRequest
import centraid.core.v1.Request
import dev.centraid.core.CentraidCore
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * FINDING A GATEWAY WHOSE ADDRESS CHANGED (#1080, Q-1080-D3, recommended (a)).
 *
 * The pairing payload's addresses are the only ones the core keeps. A laptop
 * that wakes on another address leaves the phone dialling a dead one and
 * reading "waiting for your laptop" until the member pairs again. `serve`
 * advertises `_centraid-gateway._tcp` with its id in the TXT record (`gw`), so
 * a phone in the foreground can ask the LAN where that gateway is now.
 *
 * ## Three parts, and where each one lives
 *
 * | Part | Lives in | Does |
 * |---|---|---|
 * | the browse | the platform (`NWBrowser` on iOS, `NsdManager` on Android) behind [GatewayBrowser] | finds advertisements and resolves their addresses |
 * | the match | [GatewayMatch], pure, proved on the JVM | decides which sighting is WHICH gateway and which addresses may be offered |
 * | the check | the core's `refresh_destination` | dials each offered address with the pinned certificate and keeps only the ones that answer as that gateway |
 *
 * ## THE PHONE NEVER LISTENS
 *
 * A browse is a query and its answers: the phone sends a multicast question and
 * reads replies, which is an outbound act. It opens no listening socket and
 * accepts no connection, so `no-listening-socket` has nothing to find (the rule
 * scans Rust, and no Rust here browses). It runs in the FOREGROUND only, for
 * seconds, and only after a pass found no paired gateway reachable.
 */
public interface GatewayBrowser {
    /**
     * Browse for `_centraid-gateway._tcp` for at most [windowMs], then call
     * [done] exactly once with everything found and resolved (an empty list is
     * an answer). **Outbound only**; never raises, because a platform that
     * refuses the browse (no local-network grant, no Wi-Fi) is a browse that
     * found nothing.
     */
    public fun browse(windowMs: Long, done: (List<GatewaySighting>) -> Unit)
}

/**
 * One advertisement of `_centraid-gateway._tcp`, as the platform resolved it.
 * Nothing here is trusted: it is what some machine on the network said.
 */
public data class GatewaySighting(
    /** The DNS-SD instance name (`centraid-gateway-<first 8 of the id>`). **Never an identity.** */
    public val serviceName: String,
    /** The TXT record's key/value pairs. */
    public val txt: Map<String, String>,
    /** `host:port` for each address the instance resolved to; IPv6 in brackets. */
    public val addresses: List<String>,
)

/**
 * THE MATCHING RULE: which sighting is which paired gateway, and which of its
 * addresses may be offered to the core.
 *
 * **BY IDENTITY, NEVER BY NAME.** A sighting is a paired gateway's only when
 * its TXT `gw` equals that gateway's id, compared as hex without regard to
 * case. The instance name is the first eight characters of the id and anyone
 * on the network can advertise one, so a sighting with the right name and no
 * `gw`, or with another `gw`, is nobody's. Even a sighting that passes is only
 * a hint: the core dials what this offers with the certificate it pinned and
 * asks the gateway its own id, so a machine that lies in its TXT record is
 * refused by TLS ([refresh_destination]'s check).
 */
public object GatewayMatch {
    /** The Bonjour service type `serve` advertises, `crates/gateway`'s `SERVICE_TYPE`. */
    public const val SERVICE_TYPE: String = "_centraid-gateway._tcp"

    /** The TXT key carrying the gateway's id. */
    public const val ID_KEY: String = "gw"

    /** At most this many addresses are offered at once; the core's own cap. */
    public const val MAX_CANDIDATES: Int = 8

    /**
     * The id a sighting claims, or null when it claims none the rule can
     * compare: absent, blank, or not hex. TXT keys are case-insensitive.
     */
    public fun identityOf(sighting: GatewaySighting): String? {
        val claimed = sighting.txt.entries
            .firstOrNull { it.key.equals(ID_KEY, ignoreCase = true) }?.value
            ?.trim()?.lowercase()
            ?: return null
        return claimed.takeIf { it.isNotEmpty() && it.all(::isHexDigit) }
    }

    /** Whether [sighting] claims to be the gateway [gatewayId]. */
    public fun isGateway(sighting: GatewaySighting, gatewayId: String): Boolean {
        val wanted = gatewayId.trim().lowercase()
        return wanted.isNotEmpty() && identityOf(sighting) == wanted
    }

    /**
     * The addresses to offer for [gatewayId]: those of every sighting that
     * claims it, that [recorded] does not already hold (the core dials those
     * anyway), as `host:port` IP literals, each once, IPv4 before IPv6, at most
     * [MAX_CANDIDATES].
     */
    public fun candidates(
        gatewayId: String,
        recorded: List<String>,
        sightings: List<GatewaySighting>,
    ): List<String> {
        val held = recorded.mapNotNull(::normalise).toSet()
        val offered = sightings
            .filter { isGateway(it, gatewayId) }
            .flatMap { it.addresses }
            .mapNotNull(::normalise)
            .filter { it !in held }
            .distinct()
        return (offered.filterNot { it.startsWith("[") } + offered.filter { it.startsWith("[") })
            .take(MAX_CANDIDATES)
    }

    /**
     * One address as the core will read it, or null when the rule will not
     * offer it: `a.b.c.d:port` or `[v6]:port`, a port from 1 to 65535, and no
     * name, no unspecified, multicast or loopback address and no IPv6
     * link-local address, which cannot be dialled without a scope the
     * advertisement does not carry.
     */
    public fun normalise(address: String): String? {
        val text = address.trim()
        if (text.startsWith("[")) {
            val close = text.indexOf("]:")
            if (close < 0) return null
            val host = text.substring(1, close)
            val port = portOf(text.substring(close + 2)) ?: return null
            return if (isRoutableV6(host)) "[${host.lowercase()}]:$port" else null
        }
        val colon = text.lastIndexOf(':')
        if (colon <= 0) return null
        val host = text.substring(0, colon)
        val port = portOf(text.substring(colon + 1)) ?: return null
        return if (isRoutableV4(host)) "$host:$port" else null
    }

    private fun portOf(text: String): Int? =
        text.takeIf { it.isNotEmpty() && it.length <= PORT_DIGITS && it.all { c -> c in '0'..'9' } }
            ?.toInt()?.takeIf { it in 1..MAX_PORT }

    private fun isRoutableV4(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != V4_PARTS) return false
        val octets = parts.map { part ->
            part.takeIf { it.isNotEmpty() && it.length <= OCTET_DIGITS && it.all { c -> c in '0'..'9' } }
                ?.toInt()?.takeIf { it in 0..MAX_OCTET }
                ?: return false
        }
        val first = octets[0]
        // 0.0.0.0/8 (unspecified), 127/8 (this phone), 224/4 (multicast), 240/4 (reserved, broadcast).
        return first != 0 && first != LOOPBACK_FIRST && first < MULTICAST_FIRST
    }

    private fun isRoutableV6(host: String): Boolean {
        val lowered = host.lowercase()
        if (!lowered.contains(':') || !lowered.all { it == ':' || isHexDigit(it) }) return false
        // `::` and `::1`, then link-local fe80::/10 and multicast ff00::/8 by the first group.
        if (lowered == "::" || lowered == "::1") return false
        val head = lowered.substringBefore(':').padStart(HEXTET, '0')
        if (head.length > HEXTET) return false
        val top = head.substring(0, 2).toInt(HEX_RADIX)
        val second = head.substring(2, 4).toInt(HEX_RADIX)
        val linkLocal = top == 0xfe && (second and 0xc0) == 0x80
        return !linkLocal && top != 0xff
    }

    private fun isHexDigit(character: Char): Boolean = character in '0'..'9' || character in 'a'..'f'

    private const val PORT_DIGITS: Int = 5
    private const val MAX_PORT: Int = 65_535
    private const val V4_PARTS: Int = 4
    private const val OCTET_DIGITS: Int = 3
    private const val MAX_OCTET: Int = 255
    private const val LOOPBACK_FIRST: Int = 127
    private const val MULTICAST_FIRST: Int = 224
    private const val HEXTET: Int = 4
    private const val HEX_RADIX: Int = 16
}

/** A paired gateway as the phone recorded it, for [GatewayRediscovery]. */
public data class RecordedGateway(
    public val gatewayId: String,
    public val addrs: List<String>,
)

/** What the core answered to a refresh (`RefreshDestinationResponse`). */
public data class AddressAnswer(
    /** At least one candidate answered as the pinned gateway and is now first in the ledger's list. */
    public val refreshed: Boolean,
    /** The ledger's addresses for the gateway after the call. */
    public val addrs: List<String>,
)

/** The core door a rediscovery feeds, as a seam so the specs script its answers. */
public fun interface AddressDoor {
    /** `refresh_destination = 33`, or null for no core and every refusal. */
    public suspend fun refresh(gatewayId: String, candidates: List<String>): AddressAnswer?
}

/**
 * ONE FOREGROUND REDISCOVERY: browse once, match each recorded gateway by its
 * identity, offer the core what matched, and say how many gateways it
 * refreshed. Everything the member sees of it is the next pass reaching the
 * gateway; nothing is asked and nothing is drawn.
 */
public class GatewayRediscovery(
    private val browser: GatewayBrowser,
    private val windowMs: Long = BROWSE_MS,
) {
    /**
     * Browse and refresh. [recorded] is what the ledger holds, [door] feeds the
     * core. Zero when nothing was found, nothing matched, or the core kept
     * nothing.
     */
    public suspend fun run(recorded: List<RecordedGateway>, door: AddressDoor): Int {
        if (recorded.isEmpty()) return 0
        val sightings = browse()
        if (sightings.isEmpty()) return 0
        var refreshed = 0
        for (gateway in recorded) {
            val candidates = GatewayMatch.candidates(gateway.gatewayId, gateway.addrs, sightings)
            if (candidates.isEmpty()) continue
            if (door.refresh(gateway.gatewayId, candidates)?.refreshed == true) refreshed += 1
        }
        return refreshed
    }

    /** One browse, bounded here as well, so a platform that never calls back cannot hang a pass. */
    private suspend fun browse(): List<GatewaySighting> =
        withTimeoutOrNull(windowMs + GRACE_MS) {
            suspendCancellableCoroutine { continuation ->
                browser.browse(windowMs) { found ->
                    if (continuation.isActive) continuation.resume(found)
                }
            }
        } ?: emptyList()

    public companion object {
        /** A LAN answers in well under this; a member is looking at "waiting for your laptop". */
        public const val BROWSE_MS: Long = 4_000

        /** What the platform gets beyond its own window before the browse is abandoned. */
        public const val GRACE_MS: Long = 2_000

        /** The least time between two rediscoveries on one session, so an unreachable laptop is not browsed for on every pass. */
        public const val MIN_INTERVAL_MS: Long = 30_000

        /** The passes that may start one: the member opening the app or asking, in the foreground. */
        public val TRIGGERS: Set<WakeReason> =
            setOf(WakeReason.SESSION_OPENED, WakeReason.BECAME_ACTIVE, WakeReason.BACK_UP_NOW)
    }
}

/** The door over the core's wire. Null for no core and every refusal. */
internal class CoreAddressDoor(private val core: () -> CentraidCore?) : AddressDoor {
    override suspend fun refresh(gatewayId: String, candidates: List<String>): AddressAnswer? =
        askDoor(
            core,
            Request(
                refresh_destination = RefreshDestinationRequest(
                    gateway_id = gatewayId,
                    candidates = candidates,
                ),
            ),
        )?.refresh_destination?.let { AddressAnswer(refreshed = it.refreshed, addrs = it.addrs) }
}
