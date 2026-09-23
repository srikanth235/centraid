import SwiftUI

// THE LIBRARY'S LAYOUT, IN SWIFTUI (#1029, photos port — v0's `PhotoTimeline.tsx`,
// `PhotoGrainView.tsx`, `ScrubRail.tsx`, `TimelineGrainControl.tsx` and
// `timeline-rows.ts`).
//
// Everything here is arithmetic over a width only the shell knows: which rows
// the cells pack into, where a header goes, which tile is under a finger. What a
// day IS, which grain comes next and what a pick means are the machine's
// (`PhotosGridMachine`, `PhotosTimeline`), so Compose's
// `PhotosLibraryTimeline.kt` draws the same library from the same state.

/// One row of the All grain. The id is what `scrollPosition` reports and
/// what a grain switch lands on, so it carries the day it belongs to.
enum LibraryRow: Identifiable {
    /// The month's name and nothing else — no tally (#712). Pinned.
    case month(id: String, title: String, day: String)
    /// A day's header. Selecting, it carries the day's "Select".
    case day(id: String, day: String, title: String, ids: [String])
    /// One justified row of tiles.
    case tiles(id: String, day: String, tiles: [JustifiedTile])

    var id: String {
        switch self {
        case let .month(id, _, _), let .day(id, _, _, _), let .tiles(id, _, _): return id
        }
    }

    var day: String {
        switch self {
        case let .month(_, _, day), let .day(_, day, _, _), let .tiles(_, day, _): return day
        }
    }

    /// The row's height in the flow, EXACTLY as drawn — the sweep walks these
    /// to find the tile under a finger that has left the row it started in.
    var height: CGFloat {
        switch self {
        case .month: return LibraryMetrics.monthRow
        case .day: return LibraryMetrics.dayRow
        case let .tiles(_, _, tiles): return (tiles.first?.height ?? 0) + PhotoTileMetrics.gap
        }
    }
}

/// A month and the rows under it — one pinned section.
struct LibrarySection: Identifiable {
    let month: LibraryRow
    let rows: [LibraryRow]
    var id: String { month.id }
}

/// One Years or Months card: the prefix key, its name, its tally, its cover.
struct LibraryPeriod: Identifiable {
    let key: String
    let title: String
    let count: String
    let cover: Centraid_Screen_V1_PhotoCell?
    let anchorDay: String
    var id: String { key }
}

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
    static let radiusMedium: CGFloat = 7
}

enum LibraryLayout {
    static let undated = "undated"

    /// CELLS INTO ROWS (v0's `buildRows`): a month header where the month
    /// changes, a day header per day, then the day's cells justified at the
    /// rung's height.
    ///
    /// The cells arrive newest first and already grouped by the read's order,
    /// so a section is a run of equal `day`s and nothing is re-sorted: a
    /// re-sort would make this a different library from the one the lightbox
    /// walks. THE UNDATED TAIL HAS ONE HEADER, "Undated", and no day under it —
    /// the same word twice says nothing more.
    static func rows(_ cells: [Centraid_Screen_V1_PhotoCell], width: CGFloat, rung: Int) -> [LibraryRow] {
        let target = PhotoTileMetrics.height(rung: rung)
        let year = Calendar.current.component(.year, from: Date())
        var rows: [LibraryRow] = []
        var month: String?
        var start = 0
        while start < cells.count {
            let day = cells[start].day
            var end = start
            while end < cells.count, cells[end].day == day { end += 1 }
            let section = Array(cells[start..<end])
            let monthKey = day.isEmpty ? undated : String(day.prefix(7))
            if monthKey != month {
                month = monthKey
                rows.append(.month(id: "m:\(monthKey)", title: monthTitle(monthKey), day: day))
            }
            if !day.isEmpty {
                rows.append(.day(id: "d:\(day)", day: day, title: dayTitle(day, currentYear: year), ids: section.map(\.assetID)))
            }
            for (index, tiles) in PhotoJustify.rows(section, width: width, target: target).enumerated() {
                rows.append(.tiles(id: "r:\(day):\(index)", day: day, tiles: tiles))
            }
            start = end
        }
        return rows
    }

    /// The rows under their month headers, for pinned sections.
    static func sections(_ rows: [LibraryRow]) -> [LibrarySection] {
        var sections: [LibrarySection] = []
        var month: LibraryRow?
        var under: [LibraryRow] = []
        for row in rows {
            if case .month = row {
                if let month { sections.append(LibrarySection(month: month, rows: under)) }
                month = row
                under = []
            } else {
                under.append(row)
            }
        }
        if let month { sections.append(LibrarySection(month: month, rows: under)) }
        return sections
    }

    /// PERIODS FROM CELLS (v0's `buildPeriods`), in the cells' own newest-first
    /// order and never re-sorted. COVER = NEWEST: this vault has none of the
    /// signals a key photograph is picked by, and a card must land on the
    /// photograph at the top of that period in All. Undated photographs are
    /// in All only — "sometime" is not a stretch of time.
    static func periods(_ cells: [Centraid_Screen_V1_PhotoCell], years: Bool) -> [LibraryPeriod] {
        let width = years ? 4 : 7
        var order: [String] = []
        var grouped: [String: [Centraid_Screen_V1_PhotoCell]] = [:]
        for cell in cells where !cell.day.isEmpty {
            let key = String(cell.day.prefix(width))
            if grouped[key] == nil { order.append(key) }
            grouped[key, default: []].append(cell)
        }
        return order.map { key in
            let group = grouped[key] ?? []
            return LibraryPeriod(
                key: key,
                title: years ? key : monthTitle(key),
                count: describeCounts(group),
                cover: group.first { $0.hasThumbnailPath && !$0.thumbnailPath.isEmpty } ?? group.first,
                anchorDay: group.first?.day ?? ""
            )
        }
    }

    /// Two months to a row, PAIRED WITHIN A YEAR: December beside the previous
    /// January under a heading true of only half is what this prevents. The
    /// pair's id is its first month's key.
    static func monthPairs(_ periods: [LibraryPeriod]) -> [(year: String, pairs: [[LibraryPeriod]])] {
        var years: [(year: String, pairs: [[LibraryPeriod]])] = []
        for period in periods {
            let year = String(period.key.prefix(4))
            if years.last?.year != year { years.append((year, [])) }
            var last = years[years.count - 1]
            if let pair = last.pairs.last, pair.count == 1 {
                last.pairs[last.pairs.count - 1].append(period)
            } else {
                last.pairs.append([period])
            }
            years[years.count - 1] = last
        }
        return years
    }

    /// `3 photographs · 1 video` — v0's `describeCounts`.
    static func describeCounts(_ cells: [Centraid_Screen_V1_PhotoCell]) -> String {
        let videos = cells.filter { $0.kind == .video }.count
        let photographs = cells.count - videos
        var parts: [String] = []
        if photographs > 0 { parts.append("\(photographs) photograph" + (photographs == 1 ? "" : "s")) }
        if videos > 0 { parts.append("\(videos) video" + (videos == 1 ? "" : "s")) }
        return parts.isEmpty ? "0 photographs" : parts.joined(separator: " · ")
    }

    /// THE DAY BEHIND A SCROLL TARGET'S ID — a row's own day, or a card's
    /// newest loaded day — so a grain switch lands where the member was.
    static func day(forID id: String?, cells: [Centraid_Screen_V1_PhotoCell]) -> String {
        guard let id else { return "" }
        let body = id.dropFirst(2)
        switch id.prefix(2) {
        case "d:": return String(body)
        case "r:": return String(body.split(separator: ":", omittingEmptySubsequences: false).first ?? "")
        case "y:", "p:": return cells.first { !$0.day.isEmpty && $0.day.hasPrefix(body) }?.day ?? ""
        default: return ""
        }
    }

    private static let utc = TimeZone(identifier: "UTC") ?? .current

    /// A DAY'S NAME IN THE READER'S LOCALE — `Fri, Aug 14`, with the year only
    /// when it is not this one. The day is already capture-local; it is
    /// formatted at noon UTC in UTC so no zone can move it.
    static func dayTitle(_ day: String, currentYear: Int) -> String {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return day }
        return format(parts[0], parts[1], parts[2], template: parts[0] == currentYear ? "EEEMMMd" : "EEEMMMdyyyy")
    }

    /// `August 2026`, or "Undated" for the tail.
    static func monthTitle(_ month: String) -> String {
        if month == undated { return "Undated" }
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2 else { return month }
        return format(parts[0], parts[1], 1, template: "MMMMyyyy")
    }

    private static func format(_ year: Int, _ month: Int, _ day: Int, template: String) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        guard let date = calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12)) else {
            return "\(year)-\(month)-\(day)"
        }
        let formatter = DateFormatter()
        formatter.timeZone = utc
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter.string(from: date)
    }
}

/// THE LIBRARY'S EVENTS, as the bytes the bridge takes.
enum LibraryEvents {
    private static func encoded(_ build: (inout Centraid_Screen_V1_PhotosGridEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_PhotosGridEvent()
        build(&event)
        return (try? event.serializedData()) ?? Data()
    }

    static func nextPage() -> Data { encoded { $0.nextPage = .init() } }

    static func grain(_ grain: Centraid_Screen_V1_PhotosGridState.Grain, at day: String) -> Data {
        encoded { $0.grain = .with { $0.grain = grain; $0.atDay = day } }
    }

    static func period(_ day: String) -> Data { encoded { $0.period = .with { $0.anchorDay = day } } }
    static func rung(_ rung: Int) -> Data { encoded { $0.rung = .with { $0.rung = UInt32(max(rung, 0)) } } }

    static func filter(_ filter: Centraid_Screen_V1_PhotosGridState.Filter) -> Data {
        encoded { $0.filter = .with { $0.filter = filter } }
    }

    static func selecting(_ on: Bool) -> Data { encoded { $0.selectionMode = .with { $0.selecting = on } } }
    static func toggle(_ id: String) -> Data { encoded { $0.selectionToggled = .with { $0.assetID = id } } }

    static func pick(_ ids: [String], _ picked: Bool) -> Data {
        encoded { $0.selectionSet = .with { $0.assetIds = ids; $0.selected = picked } }
    }

    static func favorite(_ on: Bool) -> Data { encoded { $0.favoriteSelected = .with { $0.favorite = on } } }
    static func trashConfirmed() -> Data { encoded { $0.trashConfirmed = .init() } }
    static func confirmTrash() -> Data { encoded { $0.sheet = .with { $0.sheet = .confirmTrash } } }
    static func albumOpened() -> Data { encoded { $0.albumChoiceOpened = .init() } }
    static func albumDismissed() -> Data { encoded { $0.albumChoiceDismissed = .init() } }
    static func albumChosen(_ id: String) -> Data { encoded { $0.albumChosen = .with { $0.albumID = id } } }
    static func albumCreated(_ title: String) -> Data { encoded { $0.albumCreated = .with { $0.title = title } } }

    static func fetch(_ id: String, _ hash: String) -> Data {
        encoded { $0.fetchOriginal = .with { $0.assetID = id; $0.contentHash = hash } }
    }
}

/// THE ALL GRAIN'S ROWS, under pinned months (v0's `PhotoTimeline.tsx`).
///
/// ## The gestures
///
/// * A TAP is the tile's own — it opens, or while selecting it toggles.
/// * A LONG PRESS on a tile picks it and enters the mode.
/// * While selecting, a SIDEWAYS drag sweeps every tile it crosses into the
///   selection (Apple Photos' swipe-select, v0's long-press pan). Sideways,
///   because an up-and-down drag is the scroll the member came to do. Each
///   sweep adds and never toggles, so a finger that crosses a tile twice does
///   not undo it. The row a drag started in keeps reporting its location, so
///   the tile under a finger that has left it is found by walking the rows'
///   heights — which is why every row's `height` is exactly what it draws.
struct LibraryTimelineRows: View {
    @Environment(\.colorScheme) private var scheme
    let rows: [LibraryRow]
    let rung: Int
    let selecting: Bool
    let selected: Set<String>
    let send: (Data) -> Void
    let onOpen: (String) -> Void

    @State private var sweep: Bool?
    @State private var swept: String?

    var body: some View {
        ForEach(LibraryLayout.sections(rows)) { section in
            Section {
                ForEach(section.rows) { row in
                    rowView(row)
                }
            } header: {
                if case let .month(_, title, _) = section.month {
                    Text(title)
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
    private func rowView(_ row: LibraryRow) -> some View {
        switch row {
        case .month:
            EmptyView()
        case let .day(id, _, title, ids):
            dayHeader(title: title, ids: ids).id(id)
        case let .tiles(id, _, tiles):
            HStack(spacing: PhotoTileMetrics.gap) {
                ForEach(tiles, id: \.cell.assetID) { tile in
                    let assetID = tile.cell.assetID
                    PhotoTile(
                        cell: tile.cell,
                        width: tile.width,
                        height: tile.height,
                        rung: rung,
                        selecting: selecting,
                        selected: selected.contains(assetID),
                        onTap: { selecting ? send(LibraryEvents.toggle(assetID)) : onOpen(assetID) },
                        onLongPress: { send(LibraryEvents.pick([assetID], true)) },
                        onFetch: { send(LibraryEvents.fetch($0, $1)) }
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, PhotoTileMetrics.gap)
            .contentShape(Rectangle())
            .simultaneousGesture(sweepGesture(from: id), including: selecting ? .all : .subviews)
            .id(id)
        }
    }

    /// A DAY'S HEADER. Selecting, it offers the whole day at once — v0's
    /// "Select day", Apple Photos' per-day Select — and says "Deselect" once
    /// every photograph under it is picked.
    private func dayHeader(title: String, ids: [String]) -> some View {
        let all = ids.allSatisfy { selected.contains($0) }
        return HStack {
            Text(title)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            if selecting {
                Button(all ? "Deselect" : "Select") { send(LibraryEvents.pick(ids, !all)) }
                    .centraidType("control")
                    .foregroundStyle(Theme.color("text", scheme))
                    // THE TARGET IS A THUMB'S EVEN WHERE THE ROW IS NOT: the
                    // row's 34 is what the sweep's arithmetic reads.
                    .contentShape(Rectangle().inset(by: -6))
                    .accessibilityLabel("\(all ? "Deselect" : "Select") \(title)")
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
                send(LibraryEvents.pick([id], true))
            }
            .onEnded { _ in
                sweep = nil
                swept = nil
            }
    }

    /// THE TILE UNDER A POINT given in the coordinates of the row a drag
    /// began in: walk the rows' heights up or down to the row under it, then
    /// its widths across. Rows are full-bleed, so `x` is already row-relative.
    private func tile(from rowID: String, at point: CGPoint) -> String? {
        guard var index = rows.firstIndex(where: { $0.id == rowID }) else { return nil }
        var y = point.y
        while y < 0, index > 0 {
            index -= 1
            y += rows[index].height
        }
        while index < rows.count, y >= rows[index].height {
            y -= rows[index].height
            index += 1
        }
        guard index < rows.count, case let .tiles(_, _, tiles) = rows[index] else { return nil }
        var left: CGFloat = 0
        for tile in tiles {
            if point.x < left + tile.width { return tile.cell.assetID }
            left += tile.width + PhotoTileMetrics.gap
        }
        return tiles.last?.cell.assetID
    }
}

/// THE YEARS AND MONTHS GRAINS (v0's `PhotoGrainView.tsx`).
///
/// A card is a PERIOD: a tap goes one grain in at its first day, and never
/// selects — a period is not a photograph. A year is a chapter — full width,
/// its name on the cover over a scrim; a month is one of twelve — two to a
/// row, its name beneath. Year headers only when the library spans more than
/// one year. The periods are the same cells All draws, grouped by prefix, so
/// the grains cannot disagree about where a period starts.
struct LibraryGrainCards: View {
    @Environment(\.colorScheme) private var scheme
    let cells: [Centraid_Screen_V1_PhotoCell]
    let years: Bool
    let complete: Bool
    let width: CGFloat
    let send: (Data) -> Void

    var body: some View {
        let periods = LibraryLayout.periods(cells, years: years)
        let stage = max(1, width - 2 * CentraidGeometry.pageMargin)
        if periods.isEmpty, complete {
            // A QUIET LINE, NOT A CARD: undated photographs live in All, and a
            // card for them would be a fake period.
            Text("These photographs carry no capture date, so they are all in All.")
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .padding(CentraidGeometry.pageMargin)
        }
        if years {
            ForEach(periods) { period in
                card(period, coverHeight: (stage * LibraryMetrics.yearCoverRatio).rounded(), overlaid: true)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .id("y:\(period.key)")
            }
        } else {
            let grouped = LibraryLayout.monthPairs(periods)
            let cardWidth = max(1, ((stage - LibraryMetrics.cardGutter) / 2).rounded(.down))
            ForEach(grouped, id: \.year) { group in
                if grouped.count > 1 {
                    Text(group.year)
                        .centraidType("eyebrow")
                        .foregroundStyle(Theme.color("text", scheme))
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.bottom, 6)
                        .frame(maxWidth: .infinity, minHeight: LibraryMetrics.monthRow, alignment: .bottomLeading)
                        .accessibilityAddTraits(.isHeader)
                }
                ForEach(group.pairs, id: \.first?.key) { pair in
                    HStack(alignment: .top, spacing: LibraryMetrics.cardGutter) {
                        ForEach(pair) { period in
                            card(period, coverHeight: cardWidth, overlaid: false).frame(width: cardWidth)
                        }
                        // AN ODD MONTH LEAVES ITS COLUMN EMPTY — a wider card
                        // would read as a bigger month.
                        if pair.count == 1 { Spacer().frame(width: cardWidth) }
                    }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .id("p:\(pair.first?.key ?? "")")
                }
            }
        }
    }

    private func card(_ period: LibraryPeriod, coverHeight: CGFloat, overlaid: Bool) -> some View {
        Button {
            send(LibraryEvents.period(period.anchorDay))
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                Theme.color("skel", scheme)
                    .frame(maxWidth: .infinity)
                    .frame(height: coverHeight)
                    .overlay {
                        if let cover = period.cover, cover.hasThumbnailPath, !cover.thumbnailPath.isEmpty {
                            ContentImage(path: cover.thumbnailPath)
                        }
                    }
                    .overlay(alignment: .bottomLeading) {
                        if overlaid {
                            // AN OVERLAY ONLY WITH A GROUND OF ITS OWN: a name
                            // over an unpredictable photograph needs the scrim.
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
                    .clipShape(RoundedRectangle(cornerRadius: LibraryMetrics.radiusMedium))
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if !overlaid {
                        Text(period.title)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("text", scheme))
                            .lineLimit(1)
                            .layoutPriority(-1)
                    }
                    Text(period.count)
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
        .accessibilityLabel("\(period.title), \(period.count)")
        .accessibilityAddTraits(.isButton)
    }
}

/// THE NEXT PAGE IS ASKED FOR WHEN THE END IS ON SCREEN — and again each time
/// a page lands while it still is, which is what `.task(id:)` on the count
/// does: a member at the foot of a library of short days pages on without
/// lifting a finger. The machine keeps one read in flight, so an ask it cannot
/// serve yet is simply dropped. A STATIC ROW OF GROUND stands where the next
/// photographs will — never a spinner.
struct LibraryMoreSentinel: View {
    @Environment(\.colorScheme) private var scheme
    let complete: Bool
    let count: Int
    let send: (Data) -> Void

    var body: some View {
        if complete {
            Color.clear.frame(height: PhotoTileMetrics.gap)
        } else {
            Theme.color("skel", scheme)
                .frame(maxWidth: .infinity)
                .frame(height: PhotoTileMetrics.rungHeights[0])
                .task(id: count) { send(LibraryEvents.nextPage()) }
                .accessibilityLabel("Loading more photographs")
        }
    }
}

/// THE SCRUB RAIL (v0's `ScrubRail.tsx`, §4.5): month-labelled, on the grid's
/// trailing edge, and hit-testable ONLY UNDER ITS THUMB, so the tiles beneath
/// the rest of the edge stay tappable. The thumb stands where the list is; a
/// drag moves the list, and the month under it rides a bubble beside the
/// thumb for as long as the finger is down. For VoiceOver it is an adjustable
/// control stepping a month at a time.
struct LibraryScrubRail: View {
    @Environment(\.colorScheme) private var scheme
    let rows: [LibraryRow]
    @Binding var position: String?

    @State private var dragging = false
    @State private var start: CGFloat = 0
    @State private var fraction: CGFloat = 0

    /// Only rows with an id the scroll position can land on: day headers and
    /// tile rows. Month headers are section headers and are not targets.
    private var targets: [LibraryRow] {
        rows.filter { if case .month = $0 { return false } else { return true } }
    }

    private var here: CGFloat {
        let list = targets
        guard list.count > 1, let position, let index = list.firstIndex(where: { $0.id == position }) else { return 0 }
        return CGFloat(index) / CGFloat(list.count - 1)
    }

    private func month(at index: Int) -> String {
        let list = targets
        guard !list.isEmpty else { return "" }
        let day = list[min(max(index, 0), list.count - 1)].day
        return LibraryLayout.monthTitle(day.isEmpty ? LibraryLayout.undated : String(day.prefix(7)))
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
            // THE RAIL SPANS WHAT THE MEMBER CAN SEE: the scroll view runs
            // under the bar and the band, and a thumb that slid beneath either
            // would be a control nobody could reach.
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
            .accessibilityLabel("Scrub the timeline by month")
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
/// never on a timer. The band's grammar: one elevated plate on the pill rung
/// with a hairline, the lit segment in ink with a mark-wide rule over it.
struct LibraryGrainControl: View {
    @Environment(\.colorScheme) private var scheme
    let grain: Centraid_Screen_V1_PhotosGridState.Grain
    let onGrain: (Centraid_Screen_V1_PhotosGridState.Grain) -> Void

    var body: some View {
        HStack(spacing: 2) {
            segment(.years, "Years")
            segment(.months, "Months")
            segment(.all, "All")
        }
        .padding(BandMetrics.platePad)
        .background(Theme.color("bgElev", scheme), in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline))
        .frame(maxWidth: .infinity)
        .padding(.top, BandMetrics.topGap)
        .accessibilityElement(children: .contain)
    }

    private func segment(_ key: Centraid_Screen_V1_PhotosGridState.Grain, _ label: String) -> some View {
        let active = key == grain || (key == .all && grain == .unspecified)
        return Button { onGrain(key) } label: {
            Text(label)
                .centraidType(active ? "control" : "band")
                .foregroundStyle(Theme.color(active ? "text" : "textSoft", scheme))
                .lineLimit(1)
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .overlay(alignment: .top) {
                    if active {
                        Capsule()
                            .fill(Theme.color("text", scheme))
                            .frame(width: BandMetrics.markSize, height: BandMetrics.activeRule)
                            .padding(.top, CentraidGeometry.hairline)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
    }
}

/// THE SELECTION BAR, IN THE BAND'S PLACE (Apple Photos; v0's room took the
/// band away under a selection so a tap aimed at Trash could not land on a
/// destination). `PhotosGridView` puts it in the band's slot while the library
/// is selecting — the band component itself is not touched.
///
/// The band's grammar: one elevated plate on the pill rung with a hairline, a
/// mark over a word per verb. With nothing picked every verb is drawn DISABLED
/// rather than hidden, so the bar does not move under the member's thumb as
/// they pick. Favorite says "Unfavorite" under the Favorites filter, where
/// every photograph on screen already is one. Trash is confirmed first.
///
/// "Back up" is NOT here, though v0 had it: v0's grid merged camera-roll
/// photographs that were not yet in any vault, and backing one up was a verb
/// on it. Every tile of this grid IS a vault row — the phone is the vault — so
/// there is nothing on screen for a per-selection backup to carry.
///
/// "Send a copy" is the shelf's batch hand-off (`ShelfCopyExport.swift`) over
/// the library's pick; `onSendCopy` opens the one question it asks first.
struct LibrarySelectionBar: View {
    @Environment(\.colorScheme) private var scheme
    let grid: Centraid_Screen_V1_PhotosGridState
    let send: (Data) -> Void
    let onSendCopy: () -> Void

    var body: some View {
        let armed = !grid.selected.isEmpty
        let favorites = grid.filter == .favorites
        HStack(spacing: BandMetrics.groupGutter) {
            verb("FolderPlus", "Add to album", armed) { send(LibraryEvents.albumOpened()) }
            verb("Heart", favorites ? "Unfavorite" : "Favorite", armed) { send(LibraryEvents.favorite(!favorites)) }
            verb("Share", "Send a copy", armed) { onSendCopy() }
            verb("Trash", "Trash", armed) { send(LibraryEvents.confirmTrash()) }
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

/// "MOVE THESE TO THE TRASH?" — what the confirm asks and the one fact it owes
/// (v0's `TRASH_KEEPS_THE_ORIGINAL`, in this product's words): the trash gives
/// them back, and the camera roll is not touched.
enum LibraryTrashCopy {
    static func question(_ count: Int) -> String {
        count == 1 ? "Move 1 photograph to the trash?" : "Move \(count) photographs to the trash?"
    }

    static let body = "You can restore them from the trash. Photographs in your camera roll are not touched."
}
