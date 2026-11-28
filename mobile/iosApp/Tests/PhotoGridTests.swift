import CoreGraphics
import UIKit
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

    @MainActor
    func testPhotoContentPathsResolveOpaqueRefsAndRejectLateRoomReplies() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let image = folder.appendingPathComponent("preview.png")
        let imageData = try XCTUnwrap(
            Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==")
        )
        XCTAssertNotNil(UIImage(data: imageData))
        try imageData.write(to: image)

        XCTAssertTrue(RoomStore.isOpaquePhotoReference("photo:seeded-front"))
        XCTAssertTrue(RoomStore.isOpaquePhotoReference(String(repeating: "a", count: 64)))
        XCTAssertFalse(RoomStore.isOpaquePhotoReference("file://\(image.path)"))
        XCTAssertFalse(RoomStore.isOpaquePhotoReference("https://example.test/image.jpg"))
        XCTAssertFalse(RoomStore.isOpaquePhotoReference(""))

        let core = PhotoContentPathTestCore(path: image.path)
        let store = RoomStore(core: core)
        store.apply(photoRoom(instance: 41))
        let resolved = await store.photoContentPaths(
            ["photo:seeded-front", String(repeating: "a", count: 64), "file://\(image.path)"],
            instance: 41
        )
        XCTAssertEqual(resolved["photo:seeded-front"], image.path)
        XCTAssertEqual(resolved[String(repeating: "a", count: 64)], image.path)
        let request = await core.lastContentRequest()
        XCTAssertEqual(request?.refs.map(\.contentID), [String(repeating: "a", count: 64), "photo:seeded-front"])
        XCTAssertEqual(request?.refs.map(\.ownerType), ["photo", "photo"])
        XCTAssertEqual(request?.refs.map(\.ownerID), [String(repeating: "a", count: 64), "photo:seeded-front"])

        let libraryOnlyCore = PhotoContentPathTestCore(
            path: image.path,
            source: .osLibrary,
            embeddable: false
        )
        let libraryOnlyStore = RoomStore(core: libraryOnlyCore)
        libraryOnlyStore.apply(photoRoom(instance: 45))
        let libraryOnly = await libraryOnlyStore.photoContentPaths(["photo:seeded-front"], instance: 45)
        XCTAssertTrue(libraryOnly.isEmpty)

        let delayedCore = PhotoContentPathTestCore(path: image.path, delayed: true)
        let delayedStore = RoomStore(core: delayedCore)
        delayedStore.apply(photoRoom(instance: 51))
        var requests = delayedCore.requests.makeAsyncIterator()
        let lookup = Task {
            await delayedStore.photoContentPaths(["photo:seeded-front"], instance: 51)
        }
        let pendingRequest = await requests.next()
        guard let pendingRequest, case .contentUrls(_) = pendingRequest.kind else {
            return XCTFail("photo resolution should use ContentUrls")
        }
        delayedStore.apply(photoRoom(instance: 52))
        await delayedCore.releaseContentRequest()
        let latePaths = await lookup.value
        XCTAssertTrue(latePaths.isEmpty)
    }

    @MainActor
    private func photoRoom(instance: UInt64) -> Centraid_Core_V1_RoomShown {
        var shown = Centraid_Core_V1_RoomShown()
        shown.tab = RustScreens.homeTab
        shown.instance = instance
        shown.depth = 1
        shown.transition = .replace
        shown.room.key = "photos"
        shown.room.state = .ready(.init())
        return shown
    }
}

private actor PhotoContentPathTestCore: ScreenCore {
    nonisolated let updates = AsyncStream<Centraid_Core_V1_ScreenUpdate> { $0.finish() }
    nonisolated let requests: AsyncStream<Centraid_Core_V1_Request>
    private nonisolated let requestSink: AsyncStream<Centraid_Core_V1_Request>.Continuation
    private let path: String
    private let delayed: Bool
    private let source: Centraid_Core_V1_ContentSource
    private let embeddable: Bool
    private var lastRequest: Centraid_Core_V1_ContentUrlRequest?
    private var pending: CheckedContinuation<Centraid_Core_V1_Response, Never>?

    init(
        path: String,
        delayed: Bool = false,
        source: Centraid_Core_V1_ContentSource = .store,
        embeddable: Bool = true
    ) {
        self.path = path
        self.delayed = delayed
        self.source = source
        self.embeddable = embeddable
        let stream = AsyncStream<Centraid_Core_V1_Request>.makeStream()
        requests = stream.stream
        requestSink = stream.continuation
    }

    func call(_ request: Centraid_Core_V1_Request) async throws -> Centraid_Core_V1_Response {
        requestSink.yield(request)
        guard case .contentUrls(let ask)? = request.kind else { return Centraid_Core_V1_Response() }
        lastRequest = ask
        if delayed {
            return await withCheckedContinuation { pending = $0 }
        }
        return response(for: ask)
    }

    func call(
        _ request: Centraid_Core_V1_Request,
        lane: Core.Lane
    ) async throws -> Centraid_Core_V1_Response {
        try await call(request)
    }

    func lastContentRequest() -> Centraid_Core_V1_ContentUrlRequest? { lastRequest }

    func releaseContentRequest() {
        guard let pending, let lastRequest else { return }
        self.pending = nil
        pending.resume(returning: response(for: lastRequest))
    }

    private func response(for ask: Centraid_Core_V1_ContentUrlRequest) -> Centraid_Core_V1_Response {
        var answer = Centraid_Core_V1_ContentUrls()
        answer.urls = ask.refs.map { ref in
            var url = Centraid_Core_V1_ContentUrl()
            url.contentID = ref.contentID
            url.path = path
            url.mediaType = "image/png"
            url.embeddable = embeddable
            url.source = source
            return url
        }
        var response = Centraid_Core_V1_Response()
        response.kind = .contentUrls(answer)
        return response
    }
}
