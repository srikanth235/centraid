import Foundation
import Network

import CentraidShared

// THE iOS HALF OF Q-1080-D3: ASK THE LAN WHERE A GATEWAY WENT.
//
// `commonMain`'s `GatewayRediscovery` decides WHEN to browse (a foreground
// pass found no paired gateway, at most once every 30 s), WHICH sighting is
// which gateway (the TXT `gw`, never the instance name) and what the core
// does with the answer (`refresh_destination` dials each offered address with
// the pinned certificate and keeps only the ones that answer as that
// gateway). This file is only the browse: `GatewayBrowser`'s one method,
// over `NWBrowser`.
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
// the network said; `GatewayMatch.normalise` drops names, loopback,
// multicast and IPv6 link-local ones, and the core proves identity by the
// pinned certificate and `/v2/info` before it keeps any.

/// THE BROWSE'S PURE RULES — what a TXT record must carry to be worth a
/// connection, and how a resolved endpoint is spelled for `GatewayMatch`.
enum GatewayBrowse {
    /// The service type `serve` advertises (`GatewayMatch.SERVICE_TYPE`),
    /// which `NSBonjourServices` must list or iOS refuses the browse.
    static let serviceType = "_centraid-gateway._tcp"

    /// The TXT key carrying the gateway's id (`GatewayMatch.ID_KEY`).
    static let idKey = "gw"

    /// Whether a TXT record claims an id at all. This is only the filter that
    /// decides what is worth connecting to; whether the id is the paired
    /// gateway's is `GatewayMatch`'s, and whether the machine IS that gateway
    /// is the core's.
    static func claimsGateway(_ txt: [String: String]) -> Bool {
        txt.contains { key, value in
            key.caseInsensitiveCompare(idKey) == .orderedSame
                && !value.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    /// `a.b.c.d:port` or `[v6]:port`, with an interface scope (`%en0`)
    /// removed, or nil for a host that is a name. A scoped link-local address
    /// is spelled without its scope and so dropped by `GatewayMatch`, which is
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

/// One advertisement as resolved, the platform-neutral twin of the shared
/// module's `GatewaySighting`.
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

/// THE KOTLIN-VISIBLE HALF: `GatewayBrowser` is `commonMain`'s interface
/// (`sync/GatewayDiscovery.kt`) and this is its iOS implementation, installed
/// once through `HomeBridge.installGatewayBrowser` (`ShellModel.init`).
final class BonjourGatewayBrowser: NSObject, GatewayBrowser {
    func browse(windowMs: Int64, done: @escaping ([GatewaySighting]) -> Void) {
        let run = GatewayBrowseRun(
            finder: NWServiceFinder(),
            resolver: ConnectionResolver(),
            window: TimeInterval(max(windowMs, 0)) / 1000
        ) { found in
            let sightings = found.map {
                GatewaySighting(serviceName: $0.serviceName, txt: $0.txt, addresses: $0.addresses)
            }
            // On the main queue, as every shell callback into Kotlin is.
            DispatchQueue.main.async { done(sightings) }
        }
        run.start()
    }
}
