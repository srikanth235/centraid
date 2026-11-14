import AVFoundation
import Combine
import XCTest

@testable import CentraidApp

@MainActor
final class LightboxPlayerReadinessTests: XCTestCase {
    func testExtensionlessMediaLoadsItsDurationWithoutPlayback() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("original")
        try oneSecondOfSilence().write(to: file)

        let loaded = expectation(description: "Paused media metadata loaded")
        let model = LightboxPlayer(path: file.path, mediaType: "audio/wav", once: false)
        let observation = model.$duration.filter { $0 > 0 }.first().sink { _ in loaded.fulfill() }
        defer { observation.cancel(); model.pause() }
        let result = await XCTWaiter.fulfillment(of: [loaded], timeout: 5)
        XCTAssertEqual(result, .completed)
        XCTAssertEqual(model.duration, 1, accuracy: 0.01)
        XCTAssertEqual(model.position, 0)
        XCTAssertEqual(model.player.rate, 0)
        XCTAssertFalse(model.playing)
    }

    private func oneSecondOfSilence() -> Data {
        let samples: UInt32 = 8_000
        let payload = samples * 2
        var bytes = Data()
        func text(_ value: String) { bytes.append(contentsOf: value.utf8) }
        func integer(_ value: UInt32, bytes count: Int) {
            for offset in 0..<count { bytes.append(UInt8((value >> (offset * 8)) & 0xff)) }
        }
        text("RIFF"); integer(36 + payload, bytes: 4); text("WAVE")
        text("fmt "); integer(16, bytes: 4); integer(1, bytes: 2); integer(1, bytes: 2)
        integer(samples, bytes: 4); integer(samples * 2, bytes: 4)
        integer(2, bytes: 2); integer(16, bytes: 2)
        text("data"); integer(payload, bytes: 4)
        bytes.append(Data(repeating: 0, count: Int(payload)))
        return bytes
    }
}
