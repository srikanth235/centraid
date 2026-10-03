import Foundation
import XCTest

@testable import CentraidApp

/// THE BACKGROUND MOVER'S PURE HALF (#1080 rulings 1, 2; A6).
///
/// Everything here runs without a gateway, a network or the core: the pin
/// verdict, the tag a relaunch recovers a task by, the code a finished task
/// reports, the host a pinned address answers for, and the refusal of an
/// upload outside TLS. Each law has its NEGATIVE case beside it — a pin that
/// differs by one byte is refused, a path the protocol did not shape names no
/// part — because a gate shown only green is a gate nobody saw refuse. The
/// session itself, the relaunch and the OS carrying the files are device
/// hand-offs (`docs/release/v1-handoffs.md`, section 8).
final class BackgroundUploadTests: XCTestCase {
    private let vault = String(repeating: "ab", count: 32)
    private let name = String(repeating: "0f", count: 32)

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
        let tag = UploadTag(name: name, gateway: "gw-1", vault: vault)
        XCTAssertEqual(UploadTag.decode(tag.encoded), tag)
    }

    func testTheProtocolPathNamesTheVaultAndThePart() throws {
        let url = URL(string: "https://192.168.1.4:8443/v2/v/\(vault)/o/\(name)")
        let parsed = try XCTUnwrap(UploadTag.parse(url: url))
        XCTAssertEqual(parsed.vault, vault)
        XCTAssertEqual(parsed.name, name)
    }

    func testAPathThisFileDidNotBuildNamesNothing() {
        // The head, a short name, upper-case hex and a foreign prefix.
        XCTAssertNil(UploadTag.parse(url: URL(string: "https://h/v2/v/\(vault)/head")))
        XCTAssertNil(UploadTag.parse(url: URL(string: "https://h/v2/v/\(vault)/o/abc")))
        XCTAssertNil(UploadTag.parse(url: URL(string: "https://h/v2/v/\(vault)/o/\(name.uppercased())")))
        XCTAssertNil(UploadTag.parse(url: URL(string: "https://h/v1/v/\(vault)/o/\(name)")))
        XCTAssertNil(UploadTag.decode("not a tag"))
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

    func testTheRequestIsThePresignedOneAndNeverMetered() throws {
        let order = UploadOrder(
            name: name, path: "/tmp/part", url: "https://gw.local:8443/v2/v/\(vault)/o/\(name)", method: "PUT",
            headers: [.init(name: "Content-Digest", value: "blake3=00")], size: 12, gateway: "gw-1", vault: vault
        )
        let request = try order.request().get()
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Digest"), "blake3=00")
        XCTAssertFalse(request.allowsCellularAccess)
        XCTAssertFalse(request.allowsExpensiveNetworkAccess)
        XCTAssertFalse(request.allowsConstrainedNetworkAccess)
    }

    func testAnUploadOutsideTLSIsRefusedBeforeATaskExists() {
        let order = UploadOrder(
            name: name, path: "/tmp/part", url: "http://gw.local:8443/v2/v/\(vault)/o/\(name)", method: "PUT",
            headers: [], size: 12, gateway: "gw-1", vault: vault
        )
        guard case let .failure(refusal) = order.request() else {
            return XCTFail("a plain http upload became a request")
        }
        XCTAssertEqual(refusal, .notHTTPS)
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
}
