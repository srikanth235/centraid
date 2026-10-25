import Foundation
import Network

// THE iOS HALF OF Q-1080-D3: ASK THE LAN WHERE A GATEWAY WENT.
//
// Rust decides WHEN to browse (the screen that asked, `BrowseGateways`), WHICH
// sighting is which gateway (the TXT `gw`, never the instance name;
// `crates/screens/src/pairing/matching.rs`) and what the core does with the
// answer (`refresh_destination` dials each offered address with the pinned
// certificate and keeps only the ones that answer as that gateway). This file
// is only the browse: `GatewayBrowsing` performs the effect over `NWBrowser`.
//
// THE PHONE ONLY BROWSES. `NWBrowser` sends a multicast query and reads its
// answers; nothing here is an `NWListener`, and nothing accepts a connection.
// (`no-listening-socket` scans Rust, and this is not Rust; the doctrine is
// SECURITY.md's, and this file is where it is kept on iOS.) The one other act
// is an OUTBOUND TCP connect to a service the browse found, below.
//
// HOW AN ADVERTISEMENT BECOMES ADDRESSES. `NWBrowser` returns a Bonjour
// service endpoint — a name, not an address — and Network.framework resolves
// it only when something connects. So each result that carries a `gw` key is
// connected to once per IP family (a TCP handshake, cancelled the moment the
// connection is `.ready`), and the path's remote endpoint is the resolved
// `host:port`. That is the same resolution the system does for any
// connection, it needs no `NetService` and no `DNSServiceResolve`, and it
// works on the simulator and on a device. A result with no `gw` is never
// connected to: it cannot be a gateway the core would accept.
//
// BOUNDED, ALL OF IT. The whole browse — discovery and every resolution —
// ends at `windowMs`; `done` is called exactly once then, with whatever
// resolved by that moment (an empty list is an answer). A browser that
// fails, a local-network grant that was refused (the browse then waits for a
// grant that never comes) and an advertisement that no longer answers are
// all a browse that found less, never one that hangs or raises.
//
// NOTHING HERE IS TRUSTED. An address in a sighting is what some machine on
// the network said; Rust's `pairing::matching` drops names, loopback,
// multicast and IPv6 link-local ones, and the core proves identity by the
// pinned certificate and `/v2/info` before it keeps any.

/// THE BROWSE'S PURE RULES — what a TXT record must carry to be worth a
/// connection, and how a resolved endpoint is spelled for `pairing::matching`.
enum GatewayBrowse {
    /// The service type `serve` advertises (Rust's `pairing::matching`),
    /// which `NSBonjourServices` must list or iOS refuses the browse.
    static let serviceType = "_centraid-gateway._tcp"

    /// The TXT key carrying the gateway's id (Rust's `pairing::matching`).
    static let idKey = "gw"

    /// Whether a TXT record claims an id at all. This is only the filter that
    /// decides what is worth connecting to; whether the id is the paired
    /// gateway's is Rust's (`pairing::matching`), and whether the machine IS that gateway
    /// is the core's.
    static func claimsGateway(_ txt: [String: String]) -> Bool {
        txt.contains { key, value in
            key.caseInsensitiveCompare(idKey) == .orderedSame
                && !value.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    /// `a.b.c.d:port` or `[v6]:port`, with an interface scope (`%en0`)
    /// removed, or nil for a host that is a name. A scoped link-local address
    /// is spelled without its scope and so dropped by `pairing::matching`, which is
    /// the rule: it cannot be dialled from an advertisement's own words.
    static func spelling(host: NWEndpoint.Host, port: NWEndpoint.Port) -> String? {
        switch host {
        case .ipv4(let address):
            return "\(bare("\(address)")):\(port.rawValue)"
        case .ipv6(let address):
            return "[\(bare("\(address)"))]:\(port.rawValue)"
        case .name:
            return nil
        @unknown default:
            return nil
        }
    }

    private static func bare(_ address: String) -> String {
        address.split(separator: "%", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? address
    }
}

/// One service the browse saw, before it is resolved.
struct FoundService {
    /// The DNS-SD instance name. Never an identity.
    let name: String
    let txt: [String: String]
    let endpoint: NWEndpoint
    /// One result per (service, interface); two interfaces make two keys.
    var key: String { "\(endpoint)" }
}

/// One advertisement as resolved: what a `GatewaySighting` carries to Rust.
struct ResolvedService: Equatable {
    let serviceName: String
    let txt: [String: String]
    let addresses: [String]
}

/// WHAT FINDS ADVERTISEMENTS — `NWBrowser` in production, a fake in tests.
protocol ServiceFinder: AnyObject {
    /// Begin. `found` is given every result seen so far each time the set
    /// changes; `failed` is called if the browse cannot run.
    func start(queue: DispatchQueue, found: @escaping ([FoundService]) -> Void, failed: @escaping () -> Void)
    /// End, and drop every handler. Idempotent.
    func stop()
}

/// WHAT TURNS A SERVICE ENDPOINT INTO ADDRESSES — an outbound connect in
/// production, a fake in tests.
protocol AddressResolver: AnyObject {
    /// Resolve [endpoint]. [completion] is called with each batch of addresses
    /// as one resolves — once per IP family that answers, so possibly twice,
    /// possibly never (a family the gateway does not serve stays pending until
    /// the window ends) and never after [cancelAll].
    func resolve(_ endpoint: NWEndpoint, queue: DispatchQueue, completion: @escaping ([String]) -> Void)
    /// Cancel everything in flight. Idempotent.
    func cancelAll()
}

/// ONE BROWSE, FROM START TO THE ONE ANSWER. All state lives on [queue].
final class GatewayBrowseRun {
    private let finder: ServiceFinder
    private let resolver: AddressResolver
    private let window: TimeInterval
    private let queue: DispatchQueue
    private let deliver: ([ResolvedService]) -> Void

    private var finished = false
    private var started = false
    private var seen: Set<String> = []
    /// Instance name → what resolved so far, in first-seen order.
    private var order: [String] = []
    private var resolved: [String: ResolvedService] = [:]

    init(
        finder: ServiceFinder,
        resolver: AddressResolver,
        window: TimeInterval,
        queue: DispatchQueue = DispatchQueue(label: "dev.centraid.gateway-browse"),
        deliver: @escaping ([ResolvedService]) -> Void
    ) {
        self.finder = finder
        self.resolver = resolver
        self.window = window
        self.queue = queue
        self.deliver = deliver
    }

    /// Begin. A second call does nothing.
    func start() {
        queue.async {
            guard !self.started, !self.finished else { return }
            self.started = true
            self.finder.start(
                queue: self.queue,
                found: { results in self.queue.async { self.saw(results) } },
                failed: { self.queue.async { self.finish() } }
            )
            self.queue.asyncAfter(deadline: .now() + self.window) { self.finish() }
        }
    }

    private func saw(_ results: [FoundService]) {
        guard !finished else { return }
        for result in results where GatewayBrowse.claimsGateway(result.txt) && seen.insert(result.key).inserted {
            resolver.resolve(result.endpoint, queue: queue) { addresses in
                self.queue.async { self.merge(result, addresses) }
            }
        }
    }

    private func merge(_ result: FoundService, _ addresses: [String]) {
        guard !finished, !addresses.isEmpty else { return }
        if let held = resolved[result.name] {
            // The same instance on another interface or family: one sighting.
            let merged = held.addresses + addresses.filter { !held.addresses.contains($0) }
            resolved[result.name] = ResolvedService(serviceName: held.serviceName, txt: held.txt, addresses: merged)
        } else {
            order.append(result.name)
            resolved[result.name] = ResolvedService(serviceName: result.name, txt: result.txt, addresses: addresses)
        }
    }

    /// THE ONE ANSWER. Whatever ends the browse first — the window, a failed
    /// browser — wins, and every later one finds `finished` set.
    private func finish() {
        guard !finished else { return }
        finished = true
        finder.stop()
        resolver.cancelAll()
        deliver(order.compactMap { resolved[$0] })
    }
}

// MARK: - The platform's half

/// `NWBrowser` over `_centraid-gateway._tcp`. Outbound only: a query, and
/// the answers to it.
final class NWServiceFinder: ServiceFinder {
    private var browser: NWBrowser?

    func start(queue: DispatchQueue, found: @escaping ([FoundService]) -> Void, failed: @escaping () -> Void) {
        // `NWParameters()` and not a peer-to-peer set: a gateway is on the
        // member's own network, and AWDL is not that.
        let browser = NWBrowser(
            for: .bonjourWithTXTRecord(type: GatewayBrowse.serviceType, domain: nil),
            using: NWParameters()
        )
        browser.stateUpdateHandler = { state in
            // `.waiting` is a refused or pending local-network grant: it may
            // yet resolve, and the window bounds it either way.
            if case .failed = state { failed() }
        }
        browser.browseResultsChangedHandler = { results, _ in
            found(results.compactMap(Self.service))
        }
        self.browser = browser
        browser.start(queue: queue)
    }

    func stop() {
        browser?.stateUpdateHandler = nil
        browser?.browseResultsChangedHandler = nil
        browser?.cancel()
        browser = nil
    }

    private static func service(_ result: NWBrowser.Result) -> FoundService? {
        guard case .service(let name, _, _, _) = result.endpoint else { return nil }
        var txt: [String: String] = [:]
        if case .bonjour(let record) = result.metadata { txt = record.dictionary }
        return FoundService(name: name, txt: txt, endpoint: result.endpoint)
    }
}

/// A TCP CONNECT, CANCELLED AT ONCE, READ FOR THE PATH'S REMOTE ENDPOINT.
/// One per IP family, so a dual-stack gateway yields both.
final class ConnectionResolver: AddressResolver {
    private var connections: [NWConnection] = []
    private var cancelled = false

    func resolve(_ endpoint: NWEndpoint, queue: DispatchQueue, completion: @escaping ([String]) -> Void) {
        guard !cancelled else { return }
        let families: [NWProtocolIP.Options.Version] = [.v4, .v6]
        for family in families {
            let parameters = NWParameters.tcp
            if let options = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
                options.version = family
            }
            let connection = NWConnection(to: endpoint, using: parameters)
            var settled = false
            connection.stateUpdateHandler = { [weak connection] state in
                guard !settled else { return }
                switch state {
                case .ready:
                    settled = true
                    var found: [String] = []
                    if case .hostPort(let host, let port)? = connection?.currentPath?.remoteEndpoint,
                       let address = GatewayBrowse.spelling(host: host, port: port) {
                        found = [address]
                    }
                    connection?.cancel()
                    completion(found)
                case .failed:
                    settled = true
                    connection?.cancel()
                default:
                    break
                }
            }
            connections.append(connection)
            connection.start(queue: queue)
        }
    }

    func cancelAll() {
        cancelled = true
        for connection in connections {
            connection.stateUpdateHandler = nil
            connection.cancel()
        }
        connections.removeAll()
    }
}

// MARK: - the `BrowseGateways` effect

/// THE PERFORMER OF `BrowseGateways` (#1135). `on: true` starts a browse for the
/// screen that asked and keeps it going until `on: false` or that screen is
/// closed: one window of `window_ms`, answered as `GatewaysSighted` with
/// everything it resolved, then again every `repeat_ms` (0: once). A window that
/// finds nothing is an empty answer. The window, the cadence and what the
/// sightings mean are Rust's; this runs the browse and reports.
@MainActor
final class GatewayBrowsing {
    static let shared = GatewayBrowsing()

    /// One screen's browse; `ended` stops its next window.
    private final class Session {
        var ended = false
    }

    private var sessions: [UInt64: Session] = [:]

    func perform(
        _ instance: UInt64,
        _ browse: Centraid_Core_V1_BrowseGateways,
        answer: @escaping (Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void
    ) {
        stop(instance)
        guard browse.on else {
            answer(.done(Centraid_Core_V1_EffectDone()))
            return
        }
        let session = Session()
        sessions[instance] = session
        window(session, browse, answer)
    }

    func stop(_ instance: UInt64) {
        sessions.removeValue(forKey: instance)?.ended = true
    }

    private func window(
        _ session: Session,
        _ browse: Centraid_Core_V1_BrowseGateways,
        _ answer: @escaping (Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void
    ) {
        let run = GatewayBrowseRun(
            finder: NWServiceFinder(),
            resolver: ConnectionResolver(),
            window: TimeInterval(browse.windowMs) / 1000
        ) { found in
            DispatchQueue.main.async {
                guard !session.ended else { return }
                var sighted = Centraid_Core_V1_GatewaysSighted()
                sighted.sightings = found.map { service in
                    var sighting = Centraid_Core_V1_GatewaySighting()
                    sighting.serviceName = service.serviceName
                    sighting.txt = service.txt
                    sighting.addresses = service.addresses
                    return sighting
                }
                answer(.gatewaysSighted(sighted))
                guard browse.repeatMs > 0 else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(browse.repeatMs))) {
                    guard !session.ended else { return }
                    GatewayBrowsing.shared.window(session, browse, answer)
                }
            }
        }
        run.start()
    }
}
