import CoreGraphics
import XCTest
@testable import CentraidApp

final class PhotoGridTests: XCTestCase {
    func testAspectRatioClampsAndDefaults() {
        XCTAssertEqual(PhotoGridMath.aspectRatio(for: 0), 1.0, accuracy: 0.001)
        XCTAssertEqual(PhotoGridMath.aspectRatio(for: 1333), 1.333, accuracy: 0.001)
        XCTAssertEqual(PhotoGridMath.aspectRatio(for: 100), 0.45, accuracy: 0.001)
        XCTAssertEqual(PhotoGridMath.aspectRatio(for: 6000), 2.5, accuracy: 0.001)
    }

    func testJustifiedRowsFillContainerWidthAndKeepTrailingRowNatural() {
        var tiles: [Centraid_Core_V1_RoomPhotoTile] = []
        for idx in 0..<5 {
            var tile = Centraid_Core_V1_RoomPhotoTile()
            tile.selectorID = "photo-\(idx)"
            tile.kind = idx == 1 ? .video : .photo
            tile.aspectMilli = idx % 2 == 0 ? 1500 : 1000
            tile.durationLabel = idx == 1 ? "0:42" : ""
            tile.starred = idx == 0
            tiles.append(tile)
        }

        let width: CGFloat = 390
        let rows = PhotoGridMath.justify(tiles: tiles, containerWidth: width, zoom: .all)
        XCTAssertGreaterThanOrEqual(rows.count, 2)

        let firstRow = rows[0]
        let firstRowGaps = PhotoGridMath.tileGap * CGFloat(max(firstRow.items.count - 1, 0))
        let firstRowSum = firstRow.items.reduce(CGFloat(0)) { $0 + $1.width } + firstRowGaps
        XCTAssertEqual(firstRowSum, width, accuracy: 0.5)
        XCTAssertGreaterThanOrEqual(firstRow.height, PhotoGridMath.minRowHeight)
        XCTAssertLessThanOrEqual(firstRow.height, PhotoGridMath.maxRowHeight)

        let lastRow = rows[rows.count - 1]
        XCTAssertLessThanOrEqual(lastRow.height, PhotoGridMath.targetRowHeight(for: .all))
    }

    func testZoomLevelsAdjustTargetRowDensity() {
        var tiles: [Centraid_Core_V1_RoomPhotoTile] = []
        for idx in 0..<12 {
            var tile = Centraid_Core_V1_RoomPhotoTile()
            tile.selectorID = "tile-\(idx)"
            tile.aspectMilli = 1000
            tiles.append(tile)
        }

        let yearsRows = PhotoGridMath.justify(tiles: tiles, containerWidth: 390, zoom: .years)
        let monthsRows = PhotoGridMath.justify(tiles: tiles, containerWidth: 390, zoom: .months)
        let allRows = PhotoGridMath.justify(tiles: tiles, containerWidth: 390, zoom: .all)

        XCTAssertLessThanOrEqual(yearsRows.count, monthsRows.count)
        XCTAssertLessThanOrEqual(monthsRows.count, allRows.count)
        XCTAssertEqual(PhotoGridMath.justify(tiles: tiles, containerWidth: 0, zoom: .all).count, 0)
        XCTAssertEqual(PhotoGridMath.justify(tiles: [], containerWidth: 390, zoom: .all).count, 0)
    }

    func testBuildSectionsPreservesHeadingsAndSelectors() {
        var tile = Centraid_Core_V1_RoomPhotoTile()
        tile.selectorID = "photo-nov-1"
        tile.aspectMilli = 1333

        var section = Centraid_Core_V1_RoomPhotoSection()
        section.heading = "November 2026"
        section.tiles = [tile]

        let layouts = PhotoGridMath.buildSections([section], containerWidth: 390, zoom: .months)
        XCTAssertEqual(layouts.count, 1)
        XCTAssertEqual(layouts[0].heading, "November 2026")
        XCTAssertEqual(layouts[0].rows.count, 1)
        XCTAssertEqual(layouts[0].rows[0].items[0].id, "photo-nov-1")
    }

    func testViewerZoomPanAndPagingMath() {
        XCTAssertEqual(PhotoGridMath.clampZoomScale(0.5), 1.0, accuracy: 0.001)
        XCTAssertEqual(PhotoGridMath.clampZoomScale(2.5), 2.5, accuracy: 0.001)
        XCTAssertEqual(PhotoGridMath.clampZoomScale(8.0), 4.0, accuracy: 0.001)

        let viewport = CGSize(width: 400, height: 600)
        XCTAssertEqual(PhotoGridMath.clampPanOffset(CGSize(width: 100, height: 100), scale: 1.0, viewport: viewport), .zero)
        let clamped = PhotoGridMath.clampPanOffset(CGSize(width: 500, height: -500), scale: 2.0, viewport: viewport)
        XCTAssertEqual(clamped.width, 200, accuracy: 0.001)
        XCTAssertEqual(clamped.height, -300, accuracy: 0.001)

        XCTAssertNil(PhotoGridMath.nextPageIndex(current: 0, delta: -1, count: 3))
        XCTAssertEqual(PhotoGridMath.nextPageIndex(current: 0, delta: 1, count: 3), 1)
        XCTAssertNil(PhotoGridMath.nextPageIndex(current: 2, delta: 1, count: 3))

        XCTAssertNil(PhotoGridMath.slideshowNextIndex(current: 0, count: 1))
        XCTAssertEqual(PhotoGridMath.slideshowNextIndex(current: 0, count: 3), 1)
        XCTAssertEqual(PhotoGridMath.slideshowNextIndex(current: 2, count: 3), 0)
    }
}
