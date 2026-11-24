import Foundation
import XCTest

@testable import CentraidApp

/// THE BACKGROUND MOVER'S PURE HALF (#1080 rulings 1, 2; A6, A10).
///
/// Everything here runs without a gateway, a network or the core: the pin
/// verdict, the tag a relaunch reads off a task, the code a finished task
/// reports, the host a pinned address answers for, the refusal of an upload
/// outside TLS, and the link each part may cross. Each law has its NEGATIVE
/// case beside it — a pin that differs by one byte is refused, a part the core did not allow
/// cellular never gets it — because a gate shown only green is a gate nobody
/// saw refuse. The
/// session itself, the relaunch and the OS carrying the files are device
/// hand-offs.
final class BackgroundUploadTests: XCTestCase {
    private let vault = String(repeating: "ab", count: 32)
    private let part = String(repeating: "0f", count: 32)

    // MARK: the pin

    func testTheExactPinnedDERIsTrusted() {
        let der = Data([0x30, 0x82, 0x01, 0x0a, 0x02, 0x82])
        XCTAssertEqual(UploadPinning.verdict(presented: der, pinned: der), .trust)
    }

    func testOneDifferentByteIsRefused() {
        let pinned = Data([0x30, 0x82, 0x01, 0x0a, 0x02, 0x82])
        var presented = pinned
        presented[presented.count - 1] ^= 0x01
        XCTAssertEqual(UploadPinning.verdict(presented: presented, pinned: pinned), .refuse)
    }

    func testNoPinIsARefusalAndNeverAFallback() {
        let presented = Data([0x30, 0x82])
        XCTAssertEqual(UploadPinning.verdict(presented: presented, pinned: nil), .refuse)
        XCTAssertEqual(UploadPinning.verdict(presented: presented, pinned: Data()), .refuse)
        XCTAssertEqual(UploadPinning.verdict(presented: nil, pinned: presented), .refuse)
    }

    // MARK: the tag a relaunch recovers

    func testTheTagRoundTripsThroughTheTaskDescription() {
        let tag = UploadTag(name: part, gateway: "gw-1", vault: vault)
        XCTAssertEqual(UploadTag.decode(tag.encoded), tag)
    }

    func testATaskWithNoDescriptionNamesNothingAndNothingIsReadOffItsURL() {
        // The vault id is never read back off the request's path: no description, no tag.
        XCTAssertNil(UploadTag.decode("not a tag"))
        XCTAssertNil(UploadTag.decode(nil))
        XCTAssertEqual(UploadTag.unknown.key, "//")
    }

    // MARK: what a finished task reports

    func testAStoredPartReportsNoError() {
        XCTAssertNil(UploadOutcome.reason(status: 201, error: nil, reply: Data(), pinRefused: false))
        XCTAssertNil(UploadOutcome.reason(status: 200, error: nil, reply: Data(), pinRefused: false))
    }

    func testARefusalCarriesTheGatewaysCodeAndNeverASentence() {
        let coded = Data(#"{"code":"DIGEST_MISMATCH","time_ms":1}"#.utf8)
        XCTAssertEqual(UploadOutcome.reason(status: 409, error: nil, reply: coded, pinRefused: false), "DIGEST_MISMATCH")
        let sentence = Data(#"{"code":"the digest did not match"}"#.utf8)
        XCTAssertEqual(UploadOutcome.reason(status: 409, error: nil, reply: sentence, pinRefused: false), "HTTP_409")
        XCTAssertEqual(UploadOutcome.reason(status: 500, error: nil, reply: Data(), pinRefused: false), "HTTP_500")
    }

    func testAPinRefusalAndACancelAreNamed() {
        let cancelled = NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
        XCTAssertEqual(UploadOutcome.reason(status: 0, error: cancelled, reply: Data(), pinRefused: true), "PIN_MISMATCH")
        XCTAssertEqual(UploadOutcome.reason(status: 0, error: cancelled, reply: Data(), pinRefused: false), "CANCELLED")
        let lost = NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost)
        XCTAssertEqual(
            UploadOutcome.reason(status: 0, error: lost, reply: Data(), pinRefused: false),
            "TRANSPORT_\(NSURLErrorNetworkConnectionLost)"
        )
    }

    // MARK: the request

    func testTheRequestIsThePresignedOneAndCarriesThePartsVerdict() throws {
        let order = UploadOrder(
            name: part, path: "/tmp/part", url: "https://gw.local:8443/v1/v/\(vault)/o/\(part)", method: "PUT",
            headers: [.init(name: "Content-Digest", value: "blake3=00")], size: 12, gateway: "gw-1", vault: vault,
            allowsCellular: true
        )
        let request = try order.request().get()
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Digest"), "blake3=00")
        // A10: the core allowed this part cellular, so the request does — and
        // an expensive link with it, or cellular would still be refused.
        XCTAssertTrue(request.allowsCellularAccess)
        XCTAssertTrue(request.allowsExpensiveNetworkAccess)
        // Low Data Mode is the member's own, and no part overrides it.
        XCTAssertFalse(request.allowsConstrainedNetworkAccess)
    }

    func testAPartTheCoreDidNotAllowNeverCrossesCellular() throws {
        // THE NEGATIVE CASE, twice: an order with no verdict at all — a part
        // from a core that never set `allows_cellular` — and one refused.
        let url = "https://gw.local:8443/v1/v/\(vault)/o/\(part)"
        let silent = UploadOrder(
            name: part, path: "/tmp/part", url: url, method: "PUT",
            headers: [], size: 12, gateway: "gw-1", vault: vault
        )
        let refused = UploadOrder(
            name: part, path: "/tmp/part", url: url, method: "PUT",
            headers: [], size: 12, gateway: "gw-1", vault: vault, allowsCellular: false
        )
        for order in [silent, refused] {
            let request = try order.request().get()
            XCTAssertFalse(request.allowsCellularAccess)
            XCTAssertFalse(request.allowsExpensiveNetworkAccess)
            XCTAssertFalse(request.allowsConstrainedNetworkAccess)
        }
    }

    func testTheSessionLetsEachRequestDecideAndRefusesLowDataMode() {
        // A request can only narrow its session, so a session that refused
        // cellular would refuse every part's allowance.
        let configuration = BackgroundUploader.configuration()
        XCTAssertEqual(configuration.identifier, BackgroundUploader.identifier)
        XCTAssertTrue(configuration.allowsCellularAccess)
        XCTAssertTrue(configuration.allowsExpensiveNetworkAccess)
        XCTAssertFalse(configuration.allowsConstrainedNetworkAccess)
        XCTAssertTrue(configuration.sessionSendsLaunchEvents)
        XCTAssertFalse(configuration.isDiscretionary)
    }

    func testEmptyMethodDefaultsToPOST() throws {
        let order = UploadOrder(
            name: part, path: "/tmp/part", url: "https://gw.local:8443/v1/v/\(vault)/bundle", method: "",
            headers: [], size: 12, gateway: "gw-1", vault: vault
        )
        let request = try order.request().get()
        XCTAssertEqual(request.httpMethod, "POST")
    }

    func testAnUploadOutsideTLSIsRefusedBeforeATaskExists() {
        let order = UploadOrder(
            name: part, path: "/tmp/part", url: "http://gw.local:8443/v1/v/\(vault)/o/\(part)", method: "PUT",
            headers: [], size: 12, gateway: "gw-1", vault: vault
        )
        guard case let .failure(refusal) = order.request() else {
            return XCTFail("a plain http upload became a request")
        }
        XCTAssertEqual(refusal, .notHTTPS)
    }

    // MARK: the bundles the core named

    func testEveryBundleBecomesOneOrderWithItsRequestAsGiven() throws {
        var first = Centraid_Core_V1_HandoffPart()
        first.name = "b1"
        first.path = "/staging/b1"
        first.url = "https://gw.local:8443/v1/v/\(vault)/bundle"
        first.method = "POST"
        var header = Centraid_Core_V1_Header()
        header.name = "Authorization"
        header.value = "Bearer t"
        first.headers = [header]
        first.allowsCellular = true
        var second = first
        second.name = "b2"
        second.allowsCellular = false
        let orders = BackgroundUploader.orders(from: [first, second])
        XCTAssertEqual(orders.count, 2)
        XCTAssertEqual(orders.map(\.allowsCellular), [true, false])
        let request = try orders[0].request().get()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer t")
        XCTAssertEqual(request.url?.absoluteString, first.url)
        XCTAssertEqual(BackgroundUploader.orders(from: []).count, 0)
    }

    // MARK: a report is a wake

    @MainActor
    func testWakesWaitForTheSinkThenArriveOnceEachInOrder() async {
        let settlement = UploadSettlement()
        let sink = CountingSink()
        for name in ["a", "b", "c"] {
            settlement.report(SettledUpload(name: name, httpStatus: 201, error: nil, gateway: "gw", vault: vault))
        }
        XCTAssertEqual(sink.settledNames, [], "no sink yet: held, not dropped")
        settlement.attach(sink)
        await sink.waitForSettled(3)
        XCTAssertEqual(sink.settledNames, ["a", "b", "c"])
        XCTAssertEqual(sink.drainedCount, 0)
        settlement.report(SettledUpload(name: "d", httpStatus: 0, error: "TRANSPORT_-1005", gateway: "gw", vault: vault))
        await sink.waitForSettled(4)
        XCTAssertEqual(sink.settledNames.count, 4)
    }

    @MainActor
    func testAttachDoesNotDrainBeforeEventsFinished() async {
        let tracker = SettlementTracker()
        let settlement = UploadSettlement(beginGrace: { name in tracker.beginGrace(name) })
        let sink = CountingSink()

        settlement.awaitingFinish { tracker.finishCalls += 1 }
        settlement.report(SettledUpload(name: "a", httpStatus: 201, error: nil, gateway: "gw", vault: vault))
        settlement.attach(sink)

        await sink.waitForSettled(1)
        for _ in 0..<5 { await Task.yield() }

        XCTAssertEqual(sink.settledNames, ["a"])
        XCTAssertEqual(sink.drainedCount, 0, "attach must not drain before urlSessionDidFinishEvents")
        XCTAssertEqual(tracker.finishCalls, 0)
        XCTAssertEqual(tracker.graceStarted, 0)
        XCTAssertEqual(tracker.graceEnded, 0)

        settlement.eventsFinished()
        await sink.waitForDrained(1)
        await tracker.waitForGraceEnd()

        XCTAssertEqual(sink.drainedCount, 1)
        XCTAssertEqual(tracker.finishCalls, 1)
        XCTAssertEqual(tracker.graceStarted, 1)
        XCTAssertEqual(tracker.graceEnded, 1)
    }

    @MainActor
    func testEventsFinishedBeforeAttachDrainsAfterHeldUploads() async {
        let tracker = SettlementTracker()
        let settlement = UploadSettlement(beginGrace: { name in tracker.beginGrace(name) })
        let sink = CountingSink()

        settlement.awaitingFinish { tracker.finishCalls += 1 }
        settlement.report(SettledUpload(name: "a", httpStatus: 201, error: nil, gateway: "gw", vault: vault))
        settlement.eventsFinished()
        XCTAssertEqual(tracker.finishCalls, 0)
        XCTAssertEqual(tracker.graceEnded, 0)

        settlement.attach(sink)
        await sink.waitForDrained(1)
        await tracker.waitForGraceEnd()

        XCTAssertEqual(sink.settledNames, ["a"])
        XCTAssertEqual(sink.drainedCount, 1)
        XCTAssertEqual(tracker.finishCalls, 1)
        XCTAssertEqual(tracker.graceEnded, 1)
    }

    @MainActor
    func testFinishAndGraceWaitUntilAsyncReportCompletes() async {
        let oldWatcher = LibraryWatcher.shared.onChange
        defer { LibraryWatcher.shared.onChange = oldWatcher }

        let core = UploadTestCore()
        defer { core.finish() }
        let store = ScreenStore(core: core)
        let sink = ScreenUploadSink(store)
        let tracker = SettlementTracker()
        let settlement = UploadSettlement(beginGrace: { name in tracker.beginGrace(name) })

        settlement.awaitingFinish { tracker.finishCalls += 1 }
        settlement.attach(sink)
        settlement.report(SettledUpload(name: "b1", httpStatus: 201, error: nil, gateway: "gw-1", vault: vault))
        settlement.eventsFinished()

        var facts = core.facts.makeAsyncIterator()
        let first = await facts.next()
        XCTAssertEqual(first, "settled:b1")
        let second = await facts.next()
        XCTAssertEqual(second, "drained")

        // The drained fact has reached the core, but has not returned yet:
        // neither iOS's completion handler nor grace.end() may fire yet.
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(tracker.graceStarted, 1)
        XCTAssertEqual(tracker.finishCalls, 0)
        XCTAssertEqual(tracker.graceEnded, 0)

        await core.releaseDrained()
        await tracker.waitForGraceEnd()

        XCTAssertEqual(tracker.finishCalls, 1)
        XCTAssertEqual(tracker.graceEnded, 1)
    }

    // MARK: the pinned addresses

    func testAnAddressAnswersForItsHost() {
        XCTAssertEqual(UploadPins.host(of: "192.168.1.4:8443"), "192.168.1.4")
        XCTAssertEqual(UploadPins.host(of: "[fe80::1]:8443"), "fe80::1")
        XCTAssertEqual(UploadPins.host(of: "NAS.local"), "nas.local")
        XCTAssertEqual(UploadPins.host(of: "fe80::1"), "fe80::1")
    }

    func testThePinsSurviveARelaunchAndMapAHostBack() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("pins-\(UUID().uuidString).plist")
        defer { try? FileManager.default.removeItem(at: file) }
        let der = Data([0x30, 0x82, 0x01])
        UploadPins(at: file).replace(with: ["gw-1": .init(certificate: der, hosts: ["192.168.1.4"])])
        let reopened = UploadPins(at: file)
        XCTAssertEqual(reopened.certificate(of: "gw-1"), der)
        XCTAssertEqual(reopened.gateway(serving: "192.168.1.4"), "gw-1")
        XCTAssertNil(reopened.gateway(serving: "192.168.1.5"))
        XCTAssertNil(reopened.certificate(of: "gw-2"))
    }

    func testEmptyTagGatewayFallsBackToHostPin() {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("pins-\(UUID().uuidString).plist")
        defer { try? FileManager.default.removeItem(at: file) }
        let der = Data([0x30, 0x82, 0x01])
        let pins = UploadPins(at: file)
        pins.replace(with: ["gw-1": .init(certificate: der, hosts: ["192.168.1.4"])])
        let uploader = BackgroundUploader(pins: pins)

        XCTAssertEqual(uploader.gateway(for: .unknown, host: "192.168.1.4"), "gw-1")
        XCTAssertEqual(
            uploader.gateway(for: UploadTag(name: part, gateway: "", vault: vault), host: "192.168.1.4"),
            "gw-1"
        )
        XCTAssertEqual(uploader.gateway(for: nil, host: "192.168.1.4"), "gw-1")
        XCTAssertEqual(
            uploader.gateway(for: UploadTag(name: part, gateway: "gw-2", vault: vault), host: "192.168.1.4"),
            "gw-2"
        )
        XCTAssertNil(uploader.gateway(for: .unknown, host: "192.168.1.5"))
    }
}

/// A sink that counts the wakes it is given.
@MainActor
private final class CountingSink: UploadSink {
    var settledNames: [String] = []
    var drainedCount = 0

    func settled(_ upload: SettledUpload) async { settledNames.append(upload.name) }
    func drained() async { drainedCount += 1 }

    func waitForSettled(_ count: Int) async {
        while settledNames.count < count { await Task.yield() }
    }

    func waitForDrained(_ count: Int) async {
        while drainedCount < count { await Task.yield() }
    }
}

/// Records `awaitingFinish` and UIKit grace callbacks on the main actor.
@MainActor
private final class SettlementTracker {
    var finishCalls = 0
    var graceStarted = 0
    var graceEnded = 0

    func beginGrace(_ name: String) -> (@MainActor () -> Void) {
        graceStarted += 1
        return { self.graceEnded += 1 }
    }

    func waitForGraceEnd() async {
        while graceEnded == 0 { await Task.yield() }
    }
}

/// A fake core that suspends on `UploadsDrained` until the test releases it.
private actor UploadTestCore: ScreenCore {
    nonisolated private let pushed: AsyncStream<Centraid_Core_V1_ScreenUpdate>
    nonisolated private let push: AsyncStream<Centraid_Core_V1_ScreenUpdate>.Continuation
    nonisolated let facts: AsyncStream<String>
    nonisolated private let factEvents: AsyncStream<String>.Continuation
    nonisolated var updates: AsyncStream<Centraid_Core_V1_ScreenUpdate> { pushed }

    private var drainedRelease: CheckedContinuation<Void, Never>?

    init() {
        (pushed, push) = AsyncStream.makeStream()
        (facts, factEvents) = AsyncStream.makeStream()
    }

    func call(_ request: Centraid_Core_V1_Request) async throws -> Centraid_Core_V1_Response {
        if case .screen(let screen)? = request.kind, case .shellFact(let shell)? = screen.kind {
            switch shell.fact {
            case .settled(let settled)?:
                factEvents.yield("settled:\(settled.name)")
            case .drained?:
                await withCheckedContinuation { continuation in
                    drainedRelease = continuation
                    factEvents.yield("drained")
                }
            default:
                break
            }
        }
        return .with { $0.kind = .screen(.init()) }
    }

    func call(_ request: Centraid_Core_V1_Request, lane: Core.Lane) async throws -> Centraid_Core_V1_Response {
        try await call(request)
    }

    func releaseDrained() {
        drainedRelease?.resume()
        drainedRelease = nil
    }

    nonisolated func finish() {
        push.finish()
        factEvents.finish()
    }
}
