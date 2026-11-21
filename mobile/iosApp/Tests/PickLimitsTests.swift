import Foundation
import XCTest

@testable import CentraidApp

/// THE SIZE CEILINGS OF A PICK (#1202): a file is sized before it is read, so what an importer would
/// refuse is never held; the pick's total is spent in order. Bytes and counts only.
final class PickLimitsTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("pick-limits-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func file(_ name: String, _ size: Int) throws -> URL {
        let url = folder.appendingPathComponent(name)
        try Data(repeating: 7, count: size).write(to: url)
        return url
    }

    func testAFileWithinTheCeilingIsRead() throws {
        var limits = PickLimits(perFile: 100, total: 0)
        guard case let .bytes(data) = limits.read(try file("a", 100)) else { return XCTFail("a file that fits is read") }
        XCTAssertEqual(data.count, 100)
    }

    func testAFileOverTheCeilingIsNotRead() throws {
        var limits = PickLimits(perFile: 100, total: 0)
        guard case .tooLarge = limits.read(try file("b", 101)) else { return XCTFail("101 bytes is over 100") }
    }

    func testNoCeilingReadsAnything() throws {
        var limits = PickLimits(perFile: 0, total: 0)
        guard case .bytes = limits.read(try file("c", 5_000)) else { return XCTFail("0 is no ceiling") }
    }

    func testTheTotalIsSpentInOrder() throws {
        var limits = PickLimits(perFile: 0, total: 250)
        guard case .bytes = limits.read(try file("d1", 100)) else { return XCTFail("first fits") }
        guard case .bytes = limits.read(try file("d2", 100)) else { return XCTFail("second fits") }
        guard case .tooLarge = limits.read(try file("d3", 100)) else { return XCTFail("third passes the total") }
        guard case .bytes = limits.read(try file("d4", 50)) else { return XCTFail("a smaller one still fits") }
        XCTAssertEqual(limits.used, 250)
    }

    func testAMissingFileIsUnreadable() {
        var limits = PickLimits(perFile: 100, total: 0)
        guard case .unreadable = limits.read(folder.appendingPathComponent("missing")) else {
            return XCTFail("a file that is not there is unreadable")
        }
    }
}
