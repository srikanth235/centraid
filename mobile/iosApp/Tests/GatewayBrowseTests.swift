import Foundation
import Network
import XCTest

#if canImport(CentraidShared)
import CentraidShared
#endif

@testable import CentraidApp

/// THE iOS GATEWAY BROWSE, WITHOUT A NETWORK (#1080, Q-1080-D3).
///
/// `GatewayBrowseRun` is the browse's whole decision structure — what is
/// worth connecting to, how one instance on two interfaces becomes one
/// sighting, and the one answer a window ends with — and it runs here over
/// fakes for the two platform seams (`ServiceFinder`, `AddressResolver`).
/// `NWBrowser` finding a real advertisement and a real connect resolving it
/// are not provable without a Bonjour responder; the simulator walk and
/// `docs/release/v1-handoffs.md` carry those. Each rule has its negative
/// beside it: a result with no `gw` is never connected to, a second answer is
/// never delivered, and an answer after the window is ignored.
final class GatewayBrowseTests: XCTestCase {
    private let id = String(repeating: "ab", count: 32)

    // MARK: spelling and the TXT filter

    func testAnIPv4EndpointIsHostColonPort() throws {
        let host = NWEndpoint.Host.ipv4(try XCTUnwrap(IPv4Address("192.168.1.44")))
        XCTAssertEqual(GatewayBrowse.spelling(host: host, port: 7443), "192.168.1.44:7443")
    }

    func testAnIPv6EndpointIsBracketedAndLosesItsScope() throws {
        let host = NWEndpoint.Host.ipv6(try XCTUnwrap(IPv6Address("fd00::5%en0")))
        XCTAssertEqual(GatewayBrowse.spelling(host: host, port: 7443), "[fd00::5]:7443")
    }

    func testANameIsNeverAnAddress() {
        XCTAssertNil(GatewayBrowse.spelling(host: .name("laptop.local", nil), port: 7443))
    }

    func testOnlyARecordWithAGatewayIdIsWorthAConnection() {
        XCTAssertTrue(GatewayBrowse.claimsGateway(["gw": id, "v": "2"]))
        XCTAssertTrue(GatewayBrowse.claimsGateway(["GW": id]))
        XCTAssertFalse(GatewayBrowse.claimsGateway(["v": "2"]))
        XCTAssertFalse(GatewayBrowse.claimsGateway(["gw": "  "]))
        XCTAssertFalse(GatewayBrowse.claimsGateway([:]))
    }

    // MARK: one run

    func testAnAdvertisementIsResolvedAndAnsweredOnceAtTheWindow() throws {
        let finder = FakeFinder()
        let resolver = FakeResolver(answers: ["lan": ["192.168.1.44:7443"]])
        let answer = expectation(description: "answered")
        var answers: [[ResolvedService]] = []
        let run = GatewayBrowseRun(finder: finder, resolver: resolver, window: 0.3) { found in
            answers.append(found)
            answer.fulfill()
        }
        run.start()
        finder.show([service("centraid-gateway-abababab", txt: ["gw": id], interface: "lan")])
        wait(for: [answer], timeout: 2)
        // A late sighting and a second window end change nothing.
        finder.show([service("centraid-gateway-late", txt: ["gw": id], interface: "late")])
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertEqual(answers.count, 1)
        XCTAssertEqual(answers[0], [ResolvedService(
            serviceName: "centraid-gateway-abababab",
            txt: ["gw": id],
            addresses: ["192.168.1.44:7443"]
        )])
        XCTAssertTrue(finder.stopped)
        XCTAssertTrue(resolver.cancelled)
    }

    func testAResultWithNoGatewayIdIsNeverConnectedTo() {
        let finder = FakeFinder()
        let resolver = FakeResolver(answers: ["decoy": ["192.168.1.99:7443"]])
        let answer = expectation(description: "answered")
        var found: [ResolvedService] = [ResolvedService(serviceName: "unset", txt: [:], addresses: [])]
        let run = GatewayBrowseRun(finder: finder, resolver: resolver, window: 0.2) {
            found = $0
            answer.fulfill()
        }
        run.start()
        finder.show([service("centraid-gateway-abababab", txt: ["v": "2"], interface: "decoy")])
        wait(for: [answer], timeout: 2)
        XCTAssertEqual(found, [])
        XCTAssertEqual(resolver.asked, [])
    }

    func testOneInstanceOnTwoInterfacesIsOneSighting() {
        let finder = FakeFinder()
        let resolver = FakeResolver(answers: [
            "en0": ["192.168.1.44:7443"],
            "en1": ["192.168.1.44:7443", "[fd00::5]:7443"],
        ])
        let answer = expectation(description: "answered")
        var found: [ResolvedService] = []
        let run = GatewayBrowseRun(finder: finder, resolver: resolver, window: 0.3) {
            found = $0
            answer.fulfill()
        }
        run.start()
        finder.show([
            service("centraid-gateway-abababab", txt: ["gw": id], interface: "en0"),
            service("centraid-gateway-abababab", txt: ["gw": id], interface: "en1"),
        ])
        // The same result shown again is not resolved again.
        finder.show([service("centraid-gateway-abababab", txt: ["gw": id], interface: "en0")])
        wait(for: [answer], timeout: 2)
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found[0].addresses, ["192.168.1.44:7443", "[fd00::5]:7443"])
        XCTAssertEqual(resolver.asked.sorted(), ["en0", "en1"])
    }

    func testAnAdvertisementThatNeverAnswersIsLeftOutNotWaitedFor() {
        let finder = FakeFinder()
        let resolver = FakeResolver(answers: [:])
        let answer = expectation(description: "answered")
        var found: [ResolvedService] = [ResolvedService(serviceName: "unset", txt: [:], addresses: [])]
        let started = Date()
        let run = GatewayBrowseRun(finder: finder, resolver: resolver, window: 0.3) {
            found = $0
            answer.fulfill()
        }
        run.start()
        finder.show([service("centraid-gateway-gone", txt: ["gw": id], interface: "stale")])
        wait(for: [answer], timeout: 2)
        XCTAssertEqual(found, [])
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), 0.25)
    }

    func testABrowserThatFailsEndsTheBrowseAtOnceWithNothing() {
        let finder = FakeFinder()
        let answer = expectation(description: "answered")
        var answers = 0
        let run = GatewayBrowseRun(finder: finder, resolver: FakeResolver(answers: [:]), window: 30) { found in
            XCTAssertEqual(found, [])
            answers += 1
            answer.fulfill()
        }
        run.start()
        finder.fail()
        wait(for: [answer], timeout: 2)
        XCTAssertEqual(answers, 1)
    }

    #if canImport(CentraidShared)
    /// The Swift-built sighting is the one the shared match reads: the TXT
    /// `gw` is the identity, and the instance name is nobody's.
    func testTheSharedMatchReadsWhatThisFileHandsIt() {
        let sighting = GatewaySighting(
            serviceName: "centraid-gateway-abababab",
            txt: ["gw": id],
            addresses: ["192.168.1.44:7443"]
        )
        XCTAssertTrue(GatewayMatch.shared.isGateway(sighting: sighting, gatewayId: id))
        let stranger = GatewaySighting(serviceName: "centraid-gateway-abababab", txt: [:], addresses: ["192.168.1.44:7443"])
        XCTAssertFalse(GatewayMatch.shared.isGateway(sighting: stranger, gatewayId: id))
        XCTAssertEqual(
            GatewayMatch.shared.candidates(gatewayId: id, recorded: [], sightings: [sighting]),
            ["192.168.1.44:7443"]
        )
    }
    #endif

    // MARK: fakes

    private func service(_ name: String, txt: [String: String], interface: String) -> FoundService {
        // The interface is carried in the endpoint's domain so each result has its own key.
        FoundService(
            name: name,
            txt: txt,
            endpoint: .service(name: name, type: GatewayBrowse.serviceType, domain: interface, interface: nil)
        )
    }
}

private final class FakeFinder: ServiceFinder {
    private var found: (([FoundService]) -> Void)?
    private var failed: (() -> Void)?
    private(set) var stopped = false
    private let started = DispatchSemaphore(value: 0)

    func start(queue: DispatchQueue, found: @escaping ([FoundService]) -> Void, failed: @escaping () -> Void) {
        self.found = found
        self.failed = failed
        started.signal()
    }

    func stop() { stopped = true }

    /// `GatewayBrowseRun.start` hops to its queue, so a test waits for the browse to begin.
    private func begun() {
        if started.wait(timeout: .now() + 2) == .success { started.signal() }
    }

    func show(_ results: [FoundService]) { begun(); found?(results) }
    func fail() { begun(); failed?() }
}

/// Answers by the endpoint's domain (the fake's interface name); an
/// unlisted one never answers, as a stale advertisement does not.
private final class FakeResolver: AddressResolver {
    private let answers: [String: [String]]
    private(set) var asked: [String] = []
    private(set) var cancelled = false

    init(answers: [String: [String]]) { self.answers = answers }

    func resolve(_ endpoint: NWEndpoint, queue: DispatchQueue, completion: @escaping ([String]) -> Void) {
        guard case .service(_, _, let domain, _) = endpoint else { return }
        asked.append(domain)
        if let addresses = answers[domain] { queue.async { completion(addresses) } }
    }

    func cancelAll() { cancelled = true }
}
