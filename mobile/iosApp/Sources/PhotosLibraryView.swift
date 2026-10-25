import SwiftUI
import UIKit

// THE LIBRARY'S DRAWING, IN SWIFTUI (#1029, photos port — v0's `PhotoTimeline.tsx`,
// `PhotoGrainView.tsx`, `ScrubRail.tsx`, `TimelineGrainControl.tsx`; #1135).
//
// What is drawn here is arithmetic over a position only the shell knows: where
// a header sits, which tile is under a finger. WHICH ROWS THE PHOTOGRAPHS PACK
// INTO, where a month or a day header goes, which cards a grain draws, how the
// months pair, and every title and count are Rust's (`photos::home::layout`):
// the shell reports the width it draws at and draws the rows it is given, so
// the Compose twin (`PhotosLibraryTimeline.kt`) draws the same library from the
// same rules.

/// The library's measures, matching the Compose twin so both shells draw the
/// same headers, rail and cards at the same sizes.
enum LibraryMetrics {
    static let monthRow: CGFloat = 46
    static let dayRow: CGFloat = 34
    static let railWidth: CGFloat = 44
    static let railInset: CGFloat = 8
    static let thumb: CGFloat = 44
    static let railMinimumRows = 12
    static let yearCoverRatio: CGFloat = 0.72
    static let cardGutter: CGFloat = 8
    static let cardBottom: CGFloat = 20
    static let sentinel: CGFloat = 64
}

/// `PhotosHomeEvent`s, built.
enum PhotosHomeEvents {
    static func make(_ build: (inout Centraid_Core_V1_PhotosHomeEvent) -> Void) -> Centraid_Core_V1_PhotosHomeEvent {
        var event = Centraid_Core_V1_PhotosHomeEvent()
        build(&event)
        return event
    }

    static func selection(_ build: (inout Centraid_Core_V1_PhotosSelectionEvent) -> Void) -> Centraid_Core_V1_PhotosHomeEvent {
        var inner = Centraid_Core_V1_PhotosSelectionEvent()
        build(&inner)
        return make { $0.selection = inner }
    }

    static func sheet(_ sheet: Centraid_Core_V1_PhotosHomeState.Sheet) -> Centraid_Core_V1_PhotosHomeEvent {
        make { $0.sheet = .with { $0.sheet = sheet } }
    }

    /// The library's lightbox route template with the tapped photograph's id set.
    static func lightbox(_ template: Centraid_Core_V1_Route, _ photoID: String) -> Centraid_Core_V1_Route {
        var route = template
        route.photosLightbox.photoID = photoID
        return route
    }
}

/// THE LIBRARY BODY: the camera-roll banner, then the loading grid, a failure,
/// an empty sentence, a grain's cards or the justified timeline — whichever Rust
/// says the library is.
struct PhotosLibraryBody: View {
    @Environment(\.colorScheme) private var scheme

    let state: Centraid_Core_V1_PhotosHomeState
    let library: Centraid_Core_V1_PhotosLibrary
    let send: (Centraid_Core_V1_PhotosHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    /// WHERE THE MEMBER IS STANDING (capture-local `YYYY-MM-DD`), written as the
    /// list scrolls, so a grain switch can land on the same stretch of time.
    @Binding var visibleDay: String

    /// The row (or card) at the top of the list, as `scrollPosition` reports it.
    @State private var scrolledID: String?
    @State private var landed = ""
    @State private var reported = CGSize.zero

    private var selection: Centraid_Core_V1_PhotosSelection { state.selection }

    private var data: Centraid_Core_V1_PhotosLibraryData? {
        if case let .data(data)? = library.content { return data }
        return nil
    }

    var body: some View {
        let tiles = data?.tiles ?? []
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                if state.hasImportBanner {
                    PhotosBackupBanner(banner: state.importBanner, send: send)
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                }
                content(tiles: tiles)
            }
            .scrollTargetLayout()
        }
        .scrollPosition(id: $scrolledID, anchor: .top)
        // RUST PACKS THE ROWS: it is told the width this grid is drawn at, and the
        // height of what can be seen.
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
            guard abs(size.width - reported.width) > 0.5 || abs(size.height - reported.height) > 0.5 else { return }
            reported = size
            send(PhotosHomeEvents.make { $0.viewport = .with { $0.width = Double(size.width); $0.height = Double(size.height) } })
        }
        .overlay(alignment: .topTrailing) {
            if library.grain == .all, !selection.selecting, let data, data.rows.count >= LibraryMetrics.railMinimumRows {
                LibraryScrubRail(rows: data.rows, data: data, position: $scrolledID)
            }
        }
        // A PINCH IS A STEPPER PRESS, NOT A CONTINUOUS ZOOM (v0 §4.2), and past
        // the table's ends it moves the grain — Rust's table, asked with the scale.
        .simultaneousGesture(
            MagnifyGesture().onEnded { value in
                send(PhotosHomeEvents.make {
                    $0.pinched = .with {
                        $0.scale = Float(value.magnification)
                        $0.atDay = visibleDay
                    }
                })
            },
            including: tiles.isEmpty ? .subviews : .all
        )
        .scrollDismissesKeyboard(.immediately)
        .onChange(of: scrolledID) { _, id in visibleDay = day(of: id) }
        // LAND WHERE RUST SAYS THE MEMBER IS — a grain switch or a card names a
        // day, and the list moves to it once.
        .onChange(of: library.placeDay) { _, day in land(on: day) }
        .onChange(of: library.grain) { _, _ in land(on: library.placeDay) }
        // WHAT BROUGHT THE MEMBER BACK FROM SETTINGS is heard in Rust: coming forward walks the
        // camera roll, whose head reads the grant again and tells this home.
    }

    @ViewBuilder
    private func content(tiles: [Centraid_Core_V1_PhotoTile]) -> some View {
        switch library.content {
        case let .loading(loading)?:
            // THE GRID IS THE LOADING STATE (v0 §14): skeleton tiles at the rung's
            // real geometry, so nothing reflows when the bytes land. Never a spinner.
            PhotoGridSkeleton(rows: loading.skeleton, label: state.chrome.title)
        case let .failure(failure)?:
            ScreenFailureView(sentence: failure.sentence, remedy: failure.remedy)
                .padding(.horizontal, CentraidGeometry.pageMargin)
        case let .data(data)?:
            if tiles.isEmpty {
                // THE FILTER EMPTIED THE GRID, NOT THE LIBRARY — its own sentence,
                // never the empty-library copy.
                if data.hasEmpty {
                    EmptyStateView(data.empty)
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                }
            } else if library.grain == .years || library.grain == .months {
                LibraryGrainCards(
                    items: data.grainItems,
                    years: library.grain == .years,
                    complete: data.complete,
                    undatedNote: data.undatedNote,
                    open: { day in send(PhotosHomeEvents.make { $0.periodOpened = day }) }
                )
                LibraryMoreSentinel(data: data, count: tiles.count, send: send)
            } else {
                LibraryTimelineRows(
                    tiles: tiles,
                    rows: data.rows,
                    rung: Int(library.rung),
                    selecting: selection.selecting,
                    selected: Set(selection.selectedIds),
                    send: send,
                    // A TILE OPENS THE PHOTOGRAPH, and the loaded library's own
                    // order rides along as the neighbours — so a swipe in the
                    // lightbox costs no read.
                    onOpen: { photoID in open(PhotosHomeEvents.lightbox(data.open, photoID)) }
                )
                LibraryMoreSentinel(data: data, count: tiles.count, send: send)
            }
        case nil:
            EmptyView()
        }
    }

    /// The day at the top of the list: a row's, or a grain card's first period.
    private func day(of id: String?) -> String {
        guard let id, let data else { return "" }
        if let row = data.rows.first(where: { $0.id == id }) { return row.day }
        if let item = data.grainItems.first(where: { $0.key == id }) { return item.periods.first?.anchorDay ?? "" }
        return ""
    }

    /// LAND ON THE DAY A GRAIN SWITCH OR A CARD NAMED: the row or card that holds
    /// it, once per change — a member who scrolls away is not pulled back.
    private func land(on day: String) {
        guard !day.isEmpty, day != landed, let data else { return }
        let month = String(day.prefix(7))
        let year = String(day.prefix(4))
        let target: String?
        switch library.grain {
        case .years:
            target = data.grainItems.first { $0.periods.contains { $0.anchorDay.hasPrefix(year) } }?.key
        case .months:
            target = data.grainItems.first { $0.periods.contains { $0.anchorDay.hasPrefix(month) } }?.key
        default:
            target = data.rows.first { $0.kind == .day && $0.day == day }?.id
                ?? data.rows.first { $0.kind != .month && $0.day.hasPrefix(month) }?.id
        }
        guard let target else { return }
        landed = day
        // A TURN LATER: the rows of the grain just switched to are laid out in this
        // update, and a position set before they exist lands nowhere.
        DispatchQueue.main.async { scrolledID = target }
    }
}

/// THE ALL GRAIN: month headers pinned over day headers and justified rows of
/// tiles. The gestures: a TAP is the tile's own (it opens, or while selecting it
/// toggles); a LONG PRESS picks the tile under it and enters the mode; a drag
/// that continues it sweeps every tile it crosses into the selection (v0's pan,
/// Apple Photos' swipe-select). A sweep adds and never toggles.
struct LibraryTimelineRows: View {
    @Environment(\.colorScheme) private var scheme
    let tiles: [Centraid_Core_V1_PhotoTile]
    let rows: [Centraid_Core_V1_PhotosTimelineRow]
    let rung: Int
    let selecting: Bool
    let selected: Set<String>
    let send: (Centraid_Core_V1_PhotosHomeEvent) -> Void
    let onOpen: (String) -> Void

    @State private var sweep: Bool?
    @State private var swept: String?

    /// The rows grouped under their month: a month row opens a section.
    private var sections: [(month: Centraid_Core_V1_PhotosTimelineRow?, rows: [Centraid_Core_V1_PhotosTimelineRow])] {
        var out: [(month: Centraid_Core_V1_PhotosTimelineRow?, rows: [Centraid_Core_V1_PhotosTimelineRow])] = []
        for row in rows {
            if row.kind == .month {
                out.append((month: row, rows: []))
            } else if out.isEmpty {
                out.append((month: nil, rows: [row]))
            } else {
                out[out.count - 1].rows.append(row)
            }
        }
        return out
    }

    var body: some View {
        ForEach(Array(sections.enumerated()), id: \.offset) { _, section in
            Section {
                ForEach(section.rows, id: \.id) { row in
                    rowView(row)
                }
            } header: {
                if let month = section.month {
                    Text(month.title)
                        .centraidType("eyebrow")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                        .padding(.top, 12)
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .frame(maxWidth: .infinity, minHeight: LibraryMetrics.monthRow, maxHeight: LibraryMetrics.monthRow, alignment: .leading)
                        .background(Theme.color("bg", scheme))
                        .accessibilityAddTraits(.isHeader)
                }
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: Centraid_Core_V1_PhotosTimelineRow) -> some View {
        switch row.kind {
        case .day:
            dayHeader(row).id(row.id)
        case .tiles:
            HStack(spacing: PhotoTileMetrics.gap) {
                ForEach(Array(row.packed.enumerated()), id: \.offset) { _, packed in
                    if Int(packed.tile) < tiles.count {
                        let tile = tiles[Int(packed.tile)]
                        PhotoTile(
                            cell: tile,
                            width: CGFloat(packed.width),
                            height: CGFloat(packed.height),
                            rung: rung,
                            selecting: selecting,
                            selected: selected.contains(tile.photoID),
                            onTap: {
                                if selecting {
                                    send(PhotosHomeEvents.selection { $0.toggled = .with { $0.photoID = tile.photoID } })
                                } else {
                                    onOpen(tile.photoID)
                                }
                            },
                            onLongPress: {
                                send(PhotosHomeEvents.selection {
                                    $0.set = .with {
                                        $0.photoIds = [tile.photoID]
                                        $0.selected = true
                                    }
                                })
                            },
                            onFetch: { photoID, _ in send(PhotosHomeEvents.make { $0.originalRequested = photoID }) }
                        )
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, PhotoTileMetrics.gap)
            .contentShape(Rectangle())
            .simultaneousGesture(sweepGesture(from: row.id), including: selecting ? .all : .subviews)
            .id(row.id)
        default:
            EmptyView()
        }
    }

    /// A DAY'S HEADER. Selecting, it offers the whole day at once — v0's "Select
    /// day", and Apple Photos' per-day Select — and says "Deselect" once every
    /// photograph under it is picked. The words are Rust's.
    private func dayHeader(_ row: Centraid_Core_V1_PhotosTimelineRow) -> some View {
        HStack {
            Text(row.title)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            if selecting, !row.toggleLabel.isEmpty {
                // THE TARGET IS A THUMB'S EVEN WHERE THE ROW IS NOT: the kit's link
                // is 44 and overflows the row's 34, which the sweep's arithmetic reads.
                KitLink(label: row.toggleLabel, dense: true) {
                    send(PhotosHomeEvents.selection {
                        $0.set = .with {
                            $0.photoIds = row.ids
                            $0.selected = !row.allSelected
                        }
                    })
                }
                .accessibilityLabel(row.selectLabel)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .frame(height: LibraryMetrics.dayRow)
    }

    private func sweepGesture(from rowID: String) -> some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                if sweep == nil {
                    sweep = abs(value.translation.width) > abs(value.translation.height)
                }
                guard sweep == true, let id = tile(from: rowID, at: value.location), id != swept else { return }
                swept = id
                send(PhotosHomeEvents.selection {
                    $0.set = .with {
                        $0.photoIds = [id]
                        $0.selected = true
                    }
                })
            }
            .onEnded { _ in
                sweep = nil
                swept = nil
            }
    }

    /// A row's height in the flow, EXACTLY as drawn.
    private func height(_ row: Centraid_Core_V1_PhotosTimelineRow) -> CGFloat {
        switch row.kind {
        case .month: return LibraryMetrics.monthRow
        case .day: return LibraryMetrics.dayRow
        default: return CGFloat(row.packed.first?.height ?? 0) + PhotoTileMetrics.gap
        }
    }

    private func photoID(_ packed: Centraid_Core_V1_PhotosPackedTile) -> String? {
        Int(packed.tile) < tiles.count ? tiles[Int(packed.tile)].photoID : nil
    }

    /// THE TILE UNDER A POINT given in the coordinates of the row a drag began in:
    /// walk the rows' heights up or down to the row under it, then its widths
    /// across. Rows are full-bleed, so `x` is already row-relative.
    private func tile(from rowID: String, at point: CGPoint) -> String? {
        guard var index = rows.firstIndex(where: { $0.id == rowID }) else { return nil }
        var y = point.y
        while y < 0, index > 0 {
            index -= 1
            y += height(rows[index])
        }
        while index < rows.count, y >= height(rows[index]) {
            y -= height(rows[index])
            index += 1
        }
        guard index < rows.count, rows[index].kind == .tiles else { return nil }
        var left: CGFloat = 0
        for packed in rows[index].packed {
            if point.x < left + CGFloat(packed.width) { return photoID(packed) }
            left += CGFloat(packed.width) + PhotoTileMetrics.gap
        }
        return rows[index].packed.last.flatMap(photoID)
    }
}

/// THE YEARS AND MONTHS GRAINS (v0's `PhotoGrainView.tsx`).
///
/// A card is a PERIOD: a tap goes one grain in at its first day, and never
/// selects — a period is not a photograph. A year is a chapter — full width, its
/// name on the cover over a scrim; a month is one of twelve — two to a row, its
/// name beneath. Which cards, their titles and counts are Rust's.
struct LibraryGrainCards: View {
    @Environment(\.colorScheme) private var scheme
    let items: [Centraid_Core_V1_PhotosGrainItem]
    let years: Bool
    let complete: Bool
    let undatedNote: String
    let open: (String) -> Void

    @State private var width: CGFloat = 0

    var body: some View {
        let stage = max(1, width - 2 * CentraidGeometry.pageMargin)
        let cardWidth = max(1, ((stage - LibraryMetrics.cardGutter) / 2).rounded(.down))
        VStack(alignment: .leading, spacing: 0) {
            if items.isEmpty, complete, !undatedNote.isEmpty {
                // A QUIET LINE, NOT A CARD: undated photographs live in All, and a
                // card for them would be a fake period.
                Text(undatedNote)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .padding(CentraidGeometry.pageMargin)
            }
            ForEach(items, id: \.key) { item in
                if !item.header.isEmpty {
                    Text(item.header)
                        .centraidType("eyebrow")
                        .foregroundStyle(Theme.color("text", scheme))
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.bottom, 6)
                        .frame(maxWidth: .infinity, minHeight: LibraryMetrics.monthRow, alignment: .bottomLeading)
                        .accessibilityAddTraits(.isHeader)
                        .id(item.key)
                } else if years, let period = item.periods.first {
                    card(period, coverHeight: (stage * LibraryMetrics.yearCoverRatio).rounded(), overlaid: true)
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .id(item.key)
                } else {
                    HStack(alignment: .top, spacing: LibraryMetrics.cardGutter) {
                        ForEach(item.periods, id: \.key) { period in
                            card(period, coverHeight: cardWidth, overlaid: false).frame(width: cardWidth)
                        }
                        // AN ODD MONTH LEAVES ITS COLUMN EMPTY — a wider card would
                        // read as a bigger month.
                        if item.periods.count == 1 { Spacer().frame(width: cardWidth) }
                    }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .id(item.key)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    private func card(_ period: Centraid_Core_V1_PhotosPeriod, coverHeight: CGFloat, overlaid: Bool) -> some View {
        Button {
            open(period.anchorDay)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                Theme.color("skel", scheme)
                    .frame(maxWidth: .infinity)
                    .frame(height: coverHeight)
                    .overlay {
                        if period.hasCover, period.cover.hasThumbnailPath, !period.cover.thumbnailPath.isEmpty {
                            ContentImage(path: period.cover.thumbnailPath)
                        }
                    }
                    .overlay(alignment: .bottomLeading) {
                        if overlaid {
                            // AN OVERLAY ONLY WITH A GROUND OF ITS OWN: a name over an
                            // unpredictable photograph needs the scrim.
                            ZStack(alignment: .bottomLeading) {
                                Theme.color("scrim", scheme)
                                Text(period.title)
                                    .centraidType("display")
                                    .foregroundStyle(Theme.color("onStage", scheme))
                                    .lineLimit(1)
                                    .padding(.horizontal, 16)
                                    .padding(.bottom, 12)
                            }
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if !overlaid {
                        Text(period.title)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("text", scheme))
                            .lineLimit(1)
                            .layoutPriority(-1)
                    }
                    Text(period.countLabel)
                        .centraidType("mono")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .lineLimit(1)
                }
            }
            .padding(.bottom, LibraryMetrics.cardBottom)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(period.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }
}

/// THE NEXT PAGE IS ASKED FOR WHEN THE END IS ON SCREEN — and again each time a
/// page lands while it still is, which is what `.task(id:)` on the count does: a
/// member at the foot of a library of short days pages on without lifting a
/// finger. Rust reads one page at a time, so an ask it cannot serve is dropped.
/// A STATIC ROW OF GROUND stands where the next photographs will — never a spinner.
struct LibraryMoreSentinel: View {
    @Environment(\.colorScheme) private var scheme
    let data: Centraid_Core_V1_PhotosLibraryData
    let count: Int
    let send: (Centraid_Core_V1_PhotosHomeEvent) -> Void

    var body: some View {
        if data.complete {
            Color.clear.frame(height: PhotoTileMetrics.gap)
        } else {
            Theme.color("skel", scheme)
                .frame(maxWidth: .infinity)
                .frame(height: LibraryMetrics.sentinel)
                .task(id: count) { send(PhotosHomeEvents.make { $0.nextPage = .init() }) }
                .accessibilityLabel(data.loadingMoreLabel)
        }
    }
}

/// THE SCRUB RAIL (v0's `ScrubRail.tsx`, §4.5): month-labelled, on the grid's
/// trailing edge, and hit-testable ONLY UNDER ITS THUMB, so the tiles beneath the
/// rest of the edge stay tappable. The thumb stands where the list is; a drag
/// moves the list, and the month under it rides a bubble beside the thumb for as
/// long as the finger is down. For VoiceOver it is an adjustable control stepping
/// a month at a time. The words are Rust's.
struct LibraryScrubRail: View {
    @Environment(\.colorScheme) private var scheme
    let rows: [Centraid_Core_V1_PhotosTimelineRow]
    let data: Centraid_Core_V1_PhotosLibraryData
    @Binding var position: String?

    @State private var dragging = false
    @State private var start: CGFloat = 0
    @State private var fraction: CGFloat = 0

    /// Only rows with an id the scroll position can land on: day headers and
    /// tile rows. Month headers are section headers and are not targets.
    private var targets: [Centraid_Core_V1_PhotosTimelineRow] { rows.filter { $0.kind != .month } }

    private var here: CGFloat {
        let list = targets
        guard list.count > 1, let position, let index = list.firstIndex(where: { $0.id == position }) else { return 0 }
        return CGFloat(index) / CGFloat(list.count - 1)
    }

    /// The month a target row sits under.
    private func month(at index: Int) -> String {
        let list = targets
        guard !list.isEmpty else { return "" }
        let row = list[min(max(index, 0), list.count - 1)]
        let prefix = String(row.day.prefix(7))
        return rows.first { $0.kind == .month && String($0.day.prefix(7)) == prefix }?.title ?? ""
    }

    private func jump(to value: CGFloat) {
        let list = targets
        guard !list.isEmpty else { return }
        fraction = min(max(value, 0), 1)
        position = list[Int((fraction * CGFloat(list.count - 1)).rounded())].id
    }

    /// One month on, or back, for VoiceOver's swipe.
    private func step(_ forward: Bool) {
        let list = targets
        guard !list.isEmpty else { return }
        let current = list.firstIndex { $0.id == position } ?? 0
        let month = String(list[current].day.prefix(7))
        let next = forward
            ? list[(current + 1)...].firstIndex { String($0.day.prefix(7)) != month }
            : list[..<current].lastIndex { String($0.day.prefix(7)) != month }
        if let next { position = list[next].id }
    }

    var body: some View {
        GeometryReader { geometry in
            // THE RAIL SPANS WHAT THE MEMBER CAN SEE: the scroll view runs under the
            // bar and the band, and a thumb that slid beneath either would be a
            // control nobody could reach.
            let top = geometry.safeAreaInsets.top + LibraryMetrics.railInset
            let bottom = geometry.safeAreaInsets.bottom + LibraryMetrics.railInset
            let track = max(1, geometry.size.height - top - bottom - LibraryMetrics.thumb)
            let shown = dragging ? fraction : here
            ZStack(alignment: .topTrailing) {
                Color.clear
                thumb
                    .offset(y: top + track * shown)
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { value in
                                if !dragging {
                                    dragging = true
                                    start = here
                                }
                                jump(to: start + value.translation.height / track)
                            }
                            .onEnded { _ in dragging = false }
                    )
                if dragging {
                    let list = targets
                    Text(month(at: Int((fraction * CGFloat(max(list.count - 1, 0))).rounded())))
                        .centraidType("mono")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 4)
                        .background(Theme.color("bgElev", scheme), in: Capsule())
                        .overlay(Capsule().strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline))
                        .padding(.trailing, LibraryMetrics.railWidth + 4)
                        .padding(.top, 10)
                        .offset(y: top + track * shown)
                        .allowsHitTesting(false)
                }
            }
            .ignoresSafeArea()
        }
    }

    private var thumb: some View {
        // THE THUMB: a hairline-bordered pill on the elevated ground, the band's
        // grammar at a rail's size. Never glass over a photograph.
        Capsule()
            .fill(Theme.color("bgElev", scheme))
            .overlay(Capsule().strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline))
            .frame(width: 6, height: LibraryMetrics.thumb - 12)
            .padding(.trailing, 4)
            .frame(width: LibraryMetrics.railWidth, height: LibraryMetrics.thumb, alignment: .trailing)
            .contentShape(Rectangle())
            .accessibilityElement()
            .accessibilityLabel(data.scrubLabel)
            .accessibilityValue(month(at: targets.firstIndex { $0.id == position } ?? 0))
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: step(true)
                case .decrement: step(false)
                @unknown default: break
                }
            }
    }
}

/// THE GRAIN CONTROL (v0's `TimelineGrainControl.tsx`): Years · Months · All,
/// PERMANENT while the library is the destination — never armed by a scroll,
/// never on a timer. The band's grammar, which is the kit's `KitSegmented`.
struct LibraryGrainControl: View {
    let grain: Centraid_Core_V1_PhotosGrain
    let chrome: Centraid_Core_V1_PhotosHomeChrome
    let onGrain: (Centraid_Core_V1_PhotosGrain) -> Void

    var body: some View {
        KitSegmented(
            options: [
                (key: Centraid_Core_V1_PhotosGrain.years, label: chrome.grainYearsLabel),
                (key: Centraid_Core_V1_PhotosGrain.months, label: chrome.grainMonthsLabel),
                (key: Centraid_Core_V1_PhotosGrain.all, label: chrome.grainAllLabel),
            ],
            selected: grain == .unspecified ? .all : grain,
            onSelect: onGrain
        )
        .frame(maxWidth: .infinity)
        .padding(.top, BandMetrics.topGap)
    }
}

/// THE SELECTION BAR, IN THE BAND'S PLACE (Apple Photos; v0's room took the band
/// away under a selection so a tap aimed at Trash could not land on a
/// destination). The band's grammar: one elevated plate on the pill rung with a
/// hairline, a mark over a word per verb. With nothing picked every verb is drawn
/// DISABLED rather than hidden, so the bar does not move under the member's thumb
/// as they pick. Which verbs, their words and whether each is enabled are Rust's
/// (`PhotosSelection.actions`); "Send a copy" is the library's own and asks which
/// location travels before it goes.
struct PhotosSelectionBar: View {
    @Environment(\.colorScheme) private var scheme
    let selection: Centraid_Core_V1_PhotosSelection
    let sendCopyLabel: String
    let send: (Centraid_Core_V1_PhotosHomeEvent) -> Void

    var body: some View {
        let armed = !selection.selectedIds.isEmpty
        HStack(spacing: BandMetrics.groupGutter) {
            ForEach(Array(selection.actions.enumerated()), id: \.offset) { _, action in
                verb(icon(action.kind), action.label, action.enabled) {
                    send(PhotosHomeEvents.selection { $0.action = .with { $0.kind = action.kind } })
                }
                // "SEND A COPY" SITS BESIDE THE HEART, as the bar always had it.
                if action.kind == .favorite || action.kind == .unfavorite {
                    verb("Share", sendCopyLabel, armed) {
                        send(PhotosHomeEvents.make { $0.copyAsked = .init() })
                    }
                }
            }
        }
        .padding(BandMetrics.platePad)
        .frame(maxWidth: .infinity)
        .background(Theme.color("bgElev", scheme), in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, BandMetrics.inset)
        .padding(.top, BandMetrics.topGap)
        .padding(.bottom, BandMetrics.floorPadding)
        .accessibilityIdentifier("photos-selection-bar")
    }

    private func icon(_ kind: Centraid_Core_V1_PhotosBatchAction.Kind) -> String {
        switch kind {
        case .addToAlbum: return "FolderPlus"
        case .favorite, .unfavorite: return "Heart"
        case .trash, .deleteForever: return "Trash"
        case .restore: return "Undo"
        case .archive, .unarchive: return "Archive"
        default: return "Check"
        }
    }

    private func verb(_ icon: String, _ label: String, _ armed: Bool, run: @escaping () -> Void) -> some View {
        // DISABLED IS ITS OWN TOKEN ON THE LEAF, never an opacity on the tab.
        let ink = Theme.color(armed ? "text" : "textDisabled", scheme)
        return Button(action: run) {
            VStack(spacing: BandMetrics.labelGap) {
                CentraidIconView(iconKey: icon, tint: ink, size: BandMetrics.iconSize)
                    .frame(width: BandMetrics.markSize, height: BandMetrics.markSize)
                Text(label)
                    .centraidType("band")
                    .foregroundStyle(ink)
                    .lineLimit(1)
            }
            .padding(.top, BandMetrics.tabTop)
            .padding(.bottom, BandMetrics.tabBottom)
            .frame(maxWidth: .infinity, minHeight: BandMetrics.tabMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!armed)
        .accessibilityLabel(label)
    }
}
