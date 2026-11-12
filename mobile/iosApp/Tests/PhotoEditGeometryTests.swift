import XCTest

@testable import CentraidApp

/// ONE EDITOR GEOMETRY, THIS SHELL'S HALF (#1185): `PhotoEditRenderer.cropPixels` over every case in
/// `contracts/photos/editor-geometry.json`, which `crates/screens` generates from `editor::crop_pixels`.
final class PhotoEditGeometryTests: XCTestCase {
    private func fixture() throws -> [[String: Any]] {
        // Tests run from the checkout on the host, so the file is found from this source file.
        let relative = "contracts/photos/editor-geometry.json"
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: directory.appendingPathComponent(relative).path) {
            let parent = directory.deletingLastPathComponent()
            if parent == directory {
                XCTFail("\(relative) not found")
                return []
            }
            directory = parent
        }
        let data = try Data(contentsOf: directory.appendingPathComponent(relative))
        let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (root?["cases"] as? [[String: Any]]) ?? []
    }

    func testEveryFixtureCaseIsCutWhereRustCutsIt() throws {
        let cases = try fixture()
        XCTAssertEqual(cases.count, 20)
        for item in cases {
            let name = item["name"] as? String ?? "?"
            let frame = (item["frame"] as? [NSNumber])?.map { $0.intValue } ?? []
            let expected = (item["expected"] as? [NSNumber])?.map { $0.intValue } ?? []
            guard frame.count == 2, expected.count == 4 else {
                XCTFail("\(name): malformed case")
                continue
            }
            var crop: Centraid_Core_V1_PhotosEditCrop?
            if let raw = item["crop"] as? [String: Any] {
                var made = Centraid_Core_V1_PhotosEditCrop()
                made.x = (raw["x"] as? NSNumber)?.doubleValue ?? 0
                made.y = (raw["y"] as? NSNumber)?.doubleValue ?? 0
                made.w = (raw["w"] as? NSNumber)?.doubleValue ?? 0
                made.h = (raw["h"] as? NSNumber)?.doubleValue ?? 0
                crop = made
            }
            let got = PhotoEditRenderer.cropPixels(crop: crop, width: frame[0], height: frame[1])
            XCTAssertEqual([got.x, got.y, got.w, got.h], expected, name)
        }
    }
}
