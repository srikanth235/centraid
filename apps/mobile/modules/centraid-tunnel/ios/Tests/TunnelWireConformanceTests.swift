/*
 * Golden-frame conformance for the Swift tunnel wire implementation
 * (issue #263 / #419). Reads the SAME fixture the Node and Kotlin
 * conformance tests read — packages/tunnel/fixtures/wire-golden.json — and
 * asserts TunnelWire's framing is byte-for-byte identical.
 *
 * Byte-exact across languages: framing of the canonical `json` string
 * (u32-BE length prefix), the ALPN strings, and the caps. Object *encoding*
 * is round-tripped (encode → decode → compare) rather than byte-compared,
 * because JSONSerialization key order is not guaranteed to match the Node
 * canonical form. See the fixture's `_readme`.
 *
 * Running (not wired into this repo's CI — it needs an Xcode/SwiftPM toolchain
 * and links the iroh xcframework through the CentraidTunnel module):
 *   - add this file to a unit-test target that `@testable import`s the
 *     CentraidTunnel module (e.g. in the Expo prebuild Xcode project), then
 *     `xcodebuild test -scheme <app> -destination 'platform=iOS Simulator,...'`.
 *   See ../../README.md ("Wire conformance tests").
 */

import XCTest

@testable import CentraidTunnel

private struct GoldenVector: Decodable {
  let name: String
  let note: String
  let json: String
  let jsonByteLength: Int
  let frameBase64: String
}

private struct GoldenFixture: Decodable {
  let version: Int
  let alpns: [String: String]
  let caps: [String: Int]
  let hopByHopHeaders: [String]
  let vectors: [GoldenVector]
}

final class TunnelWireConformanceTests: XCTestCase {
  private lazy var fixture: GoldenFixture = loadFixture()

  /// Ascend from this source file to the repo's shared fixture.
  private func loadFixture() -> GoldenFixture {
    var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    for _ in 0..<12 {
      let candidate = dir.appendingPathComponent("packages/tunnel/fixtures/wire-golden.json")
      if FileManager.default.fileExists(atPath: candidate.path) {
        // swiftlint:disable:next force_try
        let data = try! Data(contentsOf: candidate)
        // swiftlint:disable:next force_try
        return try! JSONDecoder().decode(GoldenFixture.self, from: data)
      }
      dir = dir.deletingLastPathComponent()
    }
    fatalError("wire-golden.json fixture not found above \(#filePath)")
  }

  func testCapsMatchFixture() {
    XCTAssertEqual(fixture.caps["maxHeaderFrameBytes"], TunnelWire.maxHeaderFrameBytes)
    XCTAssertEqual(fixture.caps["maxRequestBodyBytes"], TunnelWire.maxRequestBodyBytes)
    XCTAssertEqual(fixture.caps["readChunkBytes"], TunnelWire.readChunkBytes)
    XCTAssertEqual(TunnelWire.maxHeaderFrameBytes, 256 * 1024)
    XCTAssertEqual(TunnelWire.maxRequestBodyBytes, 32 * 1024 * 1024)
    XCTAssertEqual(TunnelWire.readChunkBytes, 64 * 1024)
  }

  func testAlpnsMatchFixture() {
    // The phone module speaks pair + tunnel; gw-pair is the gateway/web side.
    XCTAssertEqual(fixture.alpns["pair"], TunnelWire.pairAlpn)
    XCTAssertEqual(fixture.alpns["tunnel"], TunnelWire.tunnelAlpn)
    XCTAssertEqual(TunnelWire.pairAlpn, "centraid/pair/1")
    XCTAssertEqual(TunnelWire.tunnelAlpn, "centraid/tunnel/1")
  }

  func testHopByHopMatchesFixture() {
    XCTAssertEqual(Set(fixture.hopByHopHeaders), TunnelWire.hopByHopHeaders)
  }

  /// The core lockstep guarantee: framing the canonical json string yields
  /// exactly the golden bytes, and the length prefix round-trips.
  func testFramingIsByteExact() throws {
    for vector in fixture.vectors {
      let jsonBytes = Data(vector.json.utf8)
      XCTAssertEqual(jsonBytes.count, vector.jsonByteLength, "byte length: \(vector.name)")

      let framed = try TunnelWire.frame(jsonBytes)
      let expected = try XCTUnwrap(Data(base64Encoded: vector.frameBase64))
      XCTAssertEqual(framed, expected, "framing: \(vector.name)")

      let length = try TunnelWire.decodeFrameLength(framed.prefix(4))
      XCTAssertEqual(length, vector.jsonByteLength, "decoded length: \(vector.name)")
    }
  }

  /// Object encode round-trips (order-tolerant): encode the parsed object,
  /// decode the frame back, and assert structural equality.
  func testEncodeRoundTrip() throws {
    for vector in fixture.vectors {
      let object = try JSONSerialization.jsonObject(with: Data(vector.json.utf8))
      let dict = try XCTUnwrap(object as? [String: Any])

      let framed = try TunnelWire.encodeHeaderFrame(dict)
      let length = try TunnelWire.decodeFrameLength(framed.prefix(4))
      let payload = framed.subdata(in: 4..<(4 + length))
      let decoded = try JSONSerialization.jsonObject(with: payload)

      XCTAssertTrue(
        NSDictionary(dictionary: dict).isEqual(to: try XCTUnwrap(decoded as? [String: Any])),
        "round-trip: \(vector.name)"
      )
    }
  }

  func testDecodeRejectsOutOfBoundsLength() {
    // Zero length and over-cap length are rejected by the shared decoder.
    XCTAssertThrowsError(try TunnelWire.decodeFrameLength(Data([0, 0, 0, 0])))
    let overCap = TunnelWire.maxHeaderFrameBytes + 1
    let prefix = Data([
      UInt8((overCap >> 24) & 0xff),
      UInt8((overCap >> 16) & 0xff),
      UInt8((overCap >> 8) & 0xff),
      UInt8(overCap & 0xff),
    ])
    XCTAssertThrowsError(try TunnelWire.decodeFrameLength(prefix))
  }
}
