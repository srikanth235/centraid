import SwiftUI

struct PhotoJustifiedItem: Equatable, Sendable, Identifiable {
    let id: String
    let tile: Centraid_Core_V1_RoomPhotoTile
    let width: CGFloat
    let height: CGFloat
    let fallbackIndex: Int
}

struct PhotoJustifiedRow: Equatable, Sendable, Identifiable {
    let id: String
    let height: CGFloat
    let items: [PhotoJustifiedItem]
}

struct PhotoSectionLayout: Equatable, Sendable, Identifiable {
    let id: String
    let heading: String
    let rows: [PhotoJustifiedRow]
}

enum PhotoGridMath {
    static let tileGap: CGFloat = 2
    static let minRowHeight: CGFloat = 72
    static let maxRowHeight: CGFloat = 220
    static let minZoomScale: CGFloat = 1
    static let maxZoomScale: CGFloat = 4
    static let doubleTapZoomScale: CGFloat = 2.5

    static func targetRowHeight(for zoom: Centraid_Core_V1_RoomPhotoZoom) -> CGFloat {
        switch zoom {
        case .years: return 92
        case .months: return 116
        case .all, .unspecified, .UNRECOGNIZED: return 140
        }
    }

    static func maxTilesPerRow(for zoom: Centraid_Core_V1_RoomPhotoZoom) -> Int {
        switch zoom {
        case .years: return 6
        case .months: return 5
        case .all, .unspecified, .UNRECOGNIZED: return 4
        }
    }

    static func aspectRatio(for aspectMilli: UInt32) -> CGFloat {
        guard aspectMilli > 0 else { return 1 }
        return min(max(CGFloat(aspectMilli) / 1000, 0.45), 2.5)
    }

    static func justify(
        tiles: [Centraid_Core_V1_RoomPhotoTile],
        containerWidth: CGFloat,
        zoom: Centraid_Core_V1_RoomPhotoZoom,
        sectionIndex: Int = 0
    ) -> [PhotoJustifiedRow] {
        guard containerWidth > 0, !tiles.isEmpty else { return [] }
        let targetHeight = targetRowHeight(for: zoom)
        let maxPerRow = maxTilesPerRow(for: zoom)

        var rows: [PhotoJustifiedRow] = []
        var pending: [(index: Int, tile: Centraid_Core_V1_RoomPhotoTile, aspect: CGFloat)] = []
        var aspectSum: CGFloat = 0

        func flush(justified: Bool) {
            guard !pending.isEmpty else { return }
            let count = pending.count
            let totalGap = tileGap * CGFloat(max(count - 1, 0))
            let available = max(containerWidth - totalGap, 1)

            let rowHeight: CGFloat
            if justified {
                let ideal = available / max(aspectSum, 0.01)
                rowHeight = min(max(ideal, minRowHeight), maxRowHeight)
            } else {
                let natural = aspectSum * targetHeight
                if natural > available {
                    rowHeight = min(max(available / max(aspectSum, 0.01), minRowHeight), maxRowHeight)
                } else {
                    rowHeight = min(targetHeight, maxRowHeight)
                }
            }

            var items: [PhotoJustifiedItem] = []
            items.reserveCapacity(count)
            var usedWidth: CGFloat = 0
            for (offset, entry) in pending.enumerated() {
                let isLast = offset == count - 1
                let itemWidth: CGFloat
                if justified && isLast {
                    itemWidth = max(available - usedWidth, 1)
                } else {
                    itemWidth = min(max(entry.aspect * rowHeight, 1), available)
                }
                usedWidth += itemWidth
                let tileID = entry.tile.selectorID.isEmpty
                    ? "tile-\(sectionIndex)-\(entry.index)"
                    : entry.tile.selectorID
                items.append(
                    PhotoJustifiedItem(
                        id: tileID,
                        tile: entry.tile,
                        width: itemWidth,
                        height: rowHeight,
                        fallbackIndex: entry.index
                    )
                )
            }
            rows.append(
                PhotoJustifiedRow(
                    id: "row-\(sectionIndex)-\(rows.count)",
                    height: rowHeight,
                    items: items
                )
            )
            pending.removeAll(keepingCapacity: true)
            aspectSum = 0
        }

        for (index, tile) in tiles.enumerated() {
            let aspect = aspectRatio(for: tile.aspectMilli)
            pending.append((index: index, tile: tile, aspect: aspect))
            aspectSum += aspect

            let gapWidth = tileGap * CGFloat(max(pending.count - 1, 0))
            let naturalWidth = aspectSum * targetHeight + gapWidth
            if naturalWidth >= containerWidth || pending.count >= maxPerRow {
                flush(justified: true)
            }
        }
        flush(justified: false)
        return rows
    }

    static func buildSections(
        _ sections: [Centraid_Core_V1_RoomPhotoSection],
        containerWidth: CGFloat,
        zoom: Centraid_Core_V1_RoomPhotoZoom
    ) -> [PhotoSectionLayout] {
        guard containerWidth > 0 else { return [] }
        return sections.enumerated().map { index, section in
            let rows = justify(
                tiles: section.tiles,
                containerWidth: containerWidth,
                zoom: zoom,
                sectionIndex: index
            )
            let id = section.heading.isEmpty ? "photo-section-\(index)" : "photo-section-\(index)-\(section.heading)"
            return PhotoSectionLayout(id: id, heading: section.heading, rows: rows)
        }
    }

    static func clampZoomScale(_ scale: CGFloat) -> CGFloat {
        min(max(scale, minZoomScale), maxZoomScale)
    }

    static func clampPanOffset(_ offset: CGSize, scale: CGFloat, viewport: CGSize) -> CGSize {
        guard scale > 1.01, viewport.width > 0, viewport.height > 0 else { return .zero }
        let maxX = viewport.width * (scale - 1) / 2
        let maxY = viewport.height * (scale - 1) / 2
        return CGSize(
            width: min(max(offset.width, -maxX), maxX),
            height: min(max(offset.height, -maxY), maxY)
        )
    }

    static func nextPageIndex(current: UInt32, delta: Int, count: UInt32) -> UInt32? {
        guard count > 0 else { return nil }
        let candidate = Int(current) + delta
        guard candidate >= 0, candidate < Int(count) else { return nil }
        let next = UInt32(candidate)
        return next == current ? nil : next
    }

    static func slideshowNextIndex(current: UInt32, count: UInt32) -> UInt32? {
        guard count > 1 else { return nil }
        return (current + 1) % count
    }
}

struct PhotoGridCanvasView: View {
    let grid: Centraid_Core_V1_RoomPhotoGrid
    let callbacks: RoomCallbacks

    @State private var containerWidth: CGFloat = 0
    @State private var sectionLayouts: [PhotoSectionLayout] = []

    private var activeZoom: Centraid_Core_V1_RoomPhotoZoom {
        grid.zoom == .unspecified ? .all : grid.zoom
    }

    var body: some View {
        Group {
            if grid.hasViewer {
                PhotoViewerView(viewer: grid.viewer, callbacks: callbacks)
            } else {
                gridContent
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var gridContent: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(sectionLayouts) { section in
                            VStack(alignment: .leading, spacing: 6) {
                                if !section.heading.isEmpty {
                                    Text(section.heading)
                                        .kitType(.group)
                                        .foregroundStyle(Surface.meta)
                                        .padding(.horizontal, CentraidGeometry.pageMargin)
                                        .padding(.top, 8)
                                        .accessibilityAddTraits(.isHeader)
                                }
                                VStack(alignment: .leading, spacing: PhotoGridMath.tileGap) {
                                    ForEach(section.rows) { row in
                                        HStack(spacing: PhotoGridMath.tileGap) {
                                            ForEach(row.items) { item in
                                                PhotoTileView(item: item, onTap: callbacks.tap)
                                            }
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                }
                            }
                        }
                        if !grid.nextPageSelectorID.isEmpty {
                            ShowMoreFooter(visible: true) {
                                callbacks.tap(grid.nextPageSelectorID)
                            }
                            .onAppear { callbacks.tap(grid.nextPageSelectorID) }
                        }
                    }
                    .padding(.bottom, 72)
                }
                .softBottomScrollEdge()

                zoomControl
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.bottom, 12)
            }
            .onAppear {
                updateLayout(width: geo.size.width)
            }
            .onChange(of: geo.size.width) { _, nextWidth in
                updateLayout(width: nextWidth)
            }
            .onChange(of: grid) { _, _ in
                updateLayout(width: containerWidth > 0 ? containerWidth : geo.size.width)
            }
        }
    }

    private var zoomControl: some View {
        KitSegmented(
            options: [
                (key: Centraid_Core_V1_RoomPhotoZoom.years, label: "Years"),
                (key: Centraid_Core_V1_RoomPhotoZoom.months, label: "Months"),
                (key: Centraid_Core_V1_RoomPhotoZoom.all, label: "All"),
            ],
            selected: activeZoom,
            identifier: "photo-grid-zoom",
            segmentID: { zoom, _ in
                switch zoom {
                case .years: return "years"
                case .months: return "months"
                case .all, .unspecified, .UNRECOGNIZED: return "all"
                }
            },
            onSelect: { emitZoom($0) }
        )
    }

    private func updateLayout(width: CGFloat) {
        guard width > 0 else { return }
        containerWidth = width
        sectionLayouts = PhotoGridMath.buildSections(
            grid.sections,
            containerWidth: width,
            zoom: activeZoom
        )
    }

    private func emitZoom(_ zoom: Centraid_Core_V1_RoomPhotoZoom) {
        var zoomed = Centraid_Core_V1_RoomPhotoZoomed()
        zoomed.zoom = zoom
        var event = Centraid_Core_V1_RoomCanvasEvent()
        event.selectorID = "photo-grid-zoom"
        event.kind = .photoZoom(zoomed)
        callbacks.canvas(event)
    }
}

private struct PhotoTileView: View {
    let item: PhotoJustifiedItem
    let onTap: (String) -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent

    private var tile: Centraid_Core_V1_RoomPhotoTile { item.tile }

    var body: some View {
        Button {
            if !tile.selectorID.isEmpty {
                onTap(tile.selectorID)
            }
        } label: {
            ZStack {
                placeholderFill
                if tile.hasThumb, !tile.thumb.ref.isEmpty {
                    ContentImage(path: tile.thumb.ref)
                        .frame(width: item.width, height: item.height)
                }
            }
            .frame(width: item.width, height: item.height)
            .clipped()
            .overlay(alignment: .bottomLeading) {
                if tile.starred {
                    CentraidIconView(iconKey: "Star", tint: Color.white, size: 12, solid: true)
                        .padding(5)
                        .background(Color.black.opacity(0.45), in: Circle())
                        .padding(6)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !tile.durationLabel.isEmpty {
                    Text(tile.durationLabel)
                        .kitType(.badge)
                        .kitHeld()
                        .foregroundStyle(Color.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.black.opacity(0.65), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .padding(6)
                }
            }
            .overlay(alignment: .topTrailing) {
                if tile.selected {
                    CentraidIconView(iconKey: "Check", tint: Color.white, size: 12)
                        .frame(width: 22, height: 22)
                        .background(accent.fill, in: Circle())
                        .overlay(Circle().strokeBorder(Color.white, lineWidth: 1.5))
                        .padding(6)
                }
            }
            .overlay {
                if tile.selected {
                    Rectangle()
                        .strokeBorder(accent.fill, lineWidth: 2)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spokenLabel)
        .accessibilityAddTraits(tile.selected ? [.isButton, .isSelected] : [.isButton])
        .modifier(OptionalIdentifier(identifier: tile.selectorID))
    }

    private var placeholderFill: Color {
        if tile.hasThumb, !tile.thumb.hueKey.isEmpty {
            return CanvasHue.color(
                for: tile.thumb.hueKey,
                fallbackIndex: item.fallbackIndex,
                scheme: scheme,
                accent: accent
            )
        }
        return Surface.fill
    }

    private var spokenLabel: String {
        if !tile.a11YLabel.isEmpty { return tile.a11YLabel }
        if tile.hasThumb, !tile.thumb.alt.isEmpty { return tile.thumb.alt }
        switch tile.kind {
        case .video: return "Video"
        case .scan: return "Scan"
        case .photo, .unspecified, .UNRECOGNIZED: return "Photo"
        }
    }
}

private struct PhotoViewerView: View {
    let viewer: Centraid_Core_V1_RoomPhotoViewer
    let callbacks: RoomCallbacks

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var zoomScale: CGFloat = 1
    @State private var gestureScale: CGFloat = 1
    @State private var panOffset: CGSize = .zero
    @State private var dragStartOffset: CGSize = .zero
    @State private var detailsPresented = false

    private var effectiveScale: CGFloat {
        PhotoGridMath.clampZoomScale(zoomScale * gestureScale)
    }

    private var viewerSelectorID: String {
        viewer.tileSelectorID.isEmpty ? "photo-viewer" : viewer.tileSelectorID
    }

    var body: some View {
        GeometryReader { geo in
            let ground = viewer.slideshow ? Theme.color("stage", scheme) : Surface.page
            ZStack {
                ground.ignoresSafeArea()

                VStack(spacing: 0) {
                    mediaStage(in: geo.size)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)

                    if !viewer.slideshow {
                        viewerFooter
                    }
                }
            }
            .environment(\.colorScheme, viewer.slideshow ? .dark : scheme)
            .onAppear {
                detailsPresented = viewer.detailsOpen
            }
            .onChange(of: viewer.detailsOpen) { _, open in
                detailsPresented = open
            }
            .onChange(of: viewer.index) { _, _ in
                resetZoom()
            }
            .task(id: viewer.slideshow) {
                guard viewer.slideshow, viewer.count > 1 else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(4))
                    if Task.isCancelled { break }
                    if let next = PhotoGridMath.slideshowNextIndex(current: viewer.index, count: viewer.count) {
                        emitPage(next)
                    }
                }
            }
            .sheet(isPresented: $detailsPresented) {
                NavigationStack {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(viewer.details.enumerated()), id: \.offset) { _, block in
                                RoomBlockView(block: block, callbacks: callbacks)
                            }
                        }
                        .padding(.vertical, 12)
                    }
                    .navigationTitle(KitWords.DETAILS)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button(KitWords.DONE) {
                                detailsPresented = false
                            }
                            .accessibilityIdentifier("photo-viewer-details-done")
                        }
                    }
                }
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .sheetPageGround()
                .kitRootTint()
            }
        }
    }

    private func mediaStage(in size: CGSize) -> some View {
        let aspect = viewer.hasCurrent
            ? PhotoGridMath.aspectRatio(for: viewer.current.aspectMilli)
            : 1.0
        let ref = viewer.hasCurrent && viewer.current.hasThumb ? viewer.current.thumb.ref : ""
        let hueKey = viewer.hasCurrent && viewer.current.hasThumb ? viewer.current.thumb.hueKey : ""
        let alt = viewer.hasCurrent && viewer.current.hasThumb ? viewer.current.thumb.alt : ""

        return ZStack {
            ZStack {
                if !hueKey.isEmpty {
                    CanvasHue.color(for: hueKey, scheme: scheme, accent: accent)
                } else {
                    Surface.fill
                }
                if !ref.isEmpty {
                    ContentImage(path: ref)
                } else if viewer.hasCurrent {
                    CentraidIconView(iconKey: mediaIcon(viewer.current.kind), tint: Surface.meta, size: 36)
                }
            }
            .aspectRatio(aspect, contentMode: .fit)
            .clipped()
            .scaleEffect(effectiveScale)
            .offset(panOffset)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            .accessibilityLabel(alt.isEmpty ? "Photo" : alt)
            .onTapGesture(count: 2) {
                toggleDoubleTapZoom()
            }
            .gesture(
                MagnifyGesture()
                    .onChanged { value in
                        gestureScale = value.magnification
                    }
                    .onEnded { value in
                        let next = PhotoGridMath.clampZoomScale(zoomScale * value.magnification)
                        zoomScale = next
                        gestureScale = 1
                        panOffset = PhotoGridMath.clampPanOffset(panOffset, scale: next, viewport: size)
                        dragStartOffset = panOffset
                    }
            )
            .simultaneousGesture(
                DragGesture(minimumDistance: 16)
                    .onChanged { value in
                        if zoomScale > 1.01 {
                            let proposed = CGSize(
                                width: dragStartOffset.width + value.translation.width,
                                height: dragStartOffset.height + value.translation.height
                            )
                            panOffset = PhotoGridMath.clampPanOffset(proposed, scale: zoomScale, viewport: size)
                        }
                    }
                    .onEnded { value in
                        if zoomScale > 1.01 {
                            dragStartOffset = panOffset
                            return
                        }
                        let dx = value.translation.width
                        let dy = value.translation.height
                        if abs(dx) > abs(dy), abs(dx) > 48 {
                            let delta = dx < 0 ? 1 : -1
                            if let next = PhotoGridMath.nextPageIndex(current: viewer.index, delta: delta, count: viewer.count) {
                                emitPage(next)
                            }
                        } else if dy < -60, !viewer.details.isEmpty {
                            detailsPresented = true
                        } else if dy > 60, detailsPresented {
                            detailsPresented = false
                        }
                    }
            )
        }
    }

    private var viewerFooter: some View {
        VStack(spacing: 6) {
            if viewer.hasCurrent, !viewer.current.caption.isEmpty {
                Text(viewer.current.caption)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
            }
            HStack(spacing: 12) {
                if viewer.count > 1 {
                    KitIconKey(
                        iconKey: "ChevronLeft",
                        label: "Previous photo",
                        identifier: "photo-viewer-prev",
                        action: {
                            if let prev = PhotoGridMath.nextPageIndex(current: viewer.index, delta: -1, count: viewer.count) {
                                emitPage(prev)
                            }
                        }
                    )
                    .disabled(viewer.index == 0)
                }

                Spacer(minLength: 0)

                if !viewer.details.isEmpty {
                    KitIconKey(
                        iconKey: "Info",
                        label: KitWords.DETAILS,
                        identifier: "photo-viewer-details",
                        action: { detailsPresented = true }
                    )
                }

                if viewer.hasMenu, !viewer.menu.sections.isEmpty {
                    Menu {
                        RoomMenuContent(menu: viewer.menu, onTap: callbacks.tap)
                    } label: {
                        CentraidIconView(iconKey: "MoreHoriz", tint: Surface.ink, size: 18)
                            .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel(KitWords.BAND_MORE)
                    .accessibilityIdentifier(viewer.menu.selectorID.isEmpty ? "photo-viewer-menu" : viewer.menu.selectorID)
                }

                Spacer(minLength: 0)

                if viewer.count > 1 {
                    KitIconKey(
                        iconKey: "ChevronRight",
                        label: "Next photo",
                        identifier: "photo-viewer-next",
                        action: {
                            if let next = PhotoGridMath.nextPageIndex(current: viewer.index, delta: 1, count: viewer.count) {
                                emitPage(next)
                            }
                        }
                    )
                    .disabled(viewer.index + 1 >= viewer.count)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 6)
        }
        .background(Surface.page)
    }

    private func toggleDoubleTapZoom() {
        let apply = {
            if zoomScale > 1.01 {
                zoomScale = 1
                panOffset = .zero
                dragStartOffset = .zero
            } else {
                zoomScale = PhotoGridMath.doubleTapZoomScale
            }
        }
        if reduceMotion {
            apply()
        } else {
            withAnimation(.easeInOut(duration: 0.2), apply)
        }
    }

    private func resetZoom() {
        zoomScale = 1
        gestureScale = 1
        panOffset = .zero
        dragStartOffset = .zero
    }

    private func emitPage(_ index: UInt32) {
        var paged = Centraid_Core_V1_RoomPhotoPaged()
        paged.index = index
        var event = Centraid_Core_V1_RoomCanvasEvent()
        event.selectorID = viewerSelectorID
        event.kind = .photoPage(paged)
        callbacks.canvas(event)
    }

    private func mediaIcon(_ kind: Centraid_Core_V1_RoomMediaKind) -> String {
        switch kind {
        case .video: return "Video"
        case .scan: return "Camera"
        case .file: return "FileText"
        case .image, .unspecified, .UNRECOGNIZED: return "Image"
        }
    }
}
