import SwiftUI

/// The decoder between `photos.memories`' bytes and the view below.
///
/// Its own file rather than an addition to `StateViews.swift`: that file is
/// shared by every screen and a per-screen decoder belongs beside the screen it
/// decodes. The three-state read law is kept as `ScreenContent`, which
/// `StateViews.swift` already declares for everyone.
struct PhotosMemoriesStateView {
    let data: Data

    private var state: Centraid_Screen_V1_PhotosMemoriesState {
        (try? Centraid_Screen_V1_PhotosMemoriesState(serializedBytes: data)) ?? .init()
    }

    /// The memories, and whether a pass has said anything at all.
    ///
    /// **THE SECOND MEMBER OF THAT PAIR IS THE WHOLE EMPTY STATE.** An empty
    /// list with `computed` false is "not yet"; with it true it is "there are
    /// none". A view that drew one sentence for both would tell a member their
    /// library has nothing in it while the pass that decides that has never
    /// run.
    var content: ScreenContent<([Centraid_Screen_V1_MemoryRow], Bool)> {
        switch state.content {
        case let .failure(failure):
            return .failure(failure.sentence, failure.remedy)
        case let .data(data):
            return .data((data.memories, data.computed))
        // `loading`, and the `nil` a message with no content set decodes to,
        // are the SAME screen — a state that has not read yet. Collapsing them
        // into `.data([])` is the fourth state the read law forbids.
        case let .loading(loading):
            return .loading(loading.firstLoad)
        case .none:
            return .loading(true)
        }
    }

    var openedEvent: Data {
        var event = Centraid_Screen_V1_PhotosMemoriesEvent()
        event.opened = .init()
        return event.encoded
    }
}

/// MEMORIES — WHAT A PASS NOTICED IN A LIBRARY (#1029, photos port).
///
/// Browse only, as v0's `MemoriesView.tsx` was: no selection, no batch verb, no
/// write. A tap opens the memory's members, which are the library under a
/// predicate — `photos.shelf` with a `PhotoShelf.Memory`.
///
/// It takes bytes and closures rather than the shell object, so it compiles and
/// renders without waiting on the screen's wiring.
struct PhotosMemoriesView: View {
    @Environment(\.colorScheme) private var scheme
    let data: Data
    let send: (Data) -> Void

    /// A tap lands on `photos.shelf`. **The title rides along**, composed from
    /// the row rather than stored, so the shelf's head has something to say
    /// before its first page returns.
    var onOpenMemory: ((_ memoryIdentifier: String, _ title: String) -> Void)?

    private var state: PhotosMemoriesStateView { PhotosMemoriesStateView(data: data) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                switch state.content {
                case .loading:
                    ProgressView()
                case let .denied(denied):
                    DeniedGate(denied)
                case let .failure(sentence, remedy):
                    ScreenFailureView(sentence: sentence, remedy: remedy)
                case let .data(memories, computed):
                    if memories.isEmpty {
                        emptyShelf(computed: computed)
                    } else {
                        // THREE SECTIONS, AS v0 DREW THEM — on this day, trips,
                        // similar moments — over ONE read. The rows arrive in
                        // the vault's own order (`computed_at DESC`) and each
                        // section keeps it, so grouping is an arrangement and
                        // never a re-sort that would disagree with the desktop.
                        section("On this day", icon: "Calendar", rows: memories.filter { $0.kind == .onThisDay })
                        section("Trips", icon: "place", rows: memories.filter { $0.kind == .trip })
                        section("Similar moments", icon: "Image", rows: memories.filter { $0.kind == .similar })
                        // A KIND THIS BUILD DOES NOT KNOW IS STILL A MEMORY.
                        // Drawn rather than dropped: a shelf that quietly
                        // shrinks when a newer vault adds a fourth kind is a
                        // shelf a member cannot trust.
                        section("Other", icon: "Sparkle", rows: memories.filter { $0.kind == .unspecified })
                    }
                }
            }
            .padding(.vertical, 12)
        }
        .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
        .navigationTitle("Memories")
        .onAppear { send(state.openedEvent) }
    }

    /// TWO EMPTY SHELVES, AND THEY ARE NOT THE SAME SCREEN.
    ///
    /// `computed` false is a pass that has not run — nothing is wrong and
    /// nothing is missing, and the member has nothing to do. `computed` true is
    /// a pass that ran and found nothing, which is a fact about the library. On
    /// this tree the first is the only one a member will see: no command in
    /// `crates/` writes the memories projection, which the reducer says in full.
    @ViewBuilder
    private func emptyShelf(computed: Bool) -> some View {
        if computed {
            ScreenEmptyView(
                sentence: "No memories yet.",
                remedy: "Your own photographs, noticed — a year behind a day, a trip, a burst."
            )
        } else {
            ScreenEmptyView(
                sentence: "Centraid has not looked for memories yet.",
                remedy: "They appear here once it has."
            )
        }
    }

    @ViewBuilder
    private func section(
        _ title: String,
        icon: String,
        rows: [Centraid_Screen_V1_MemoryRow]
    ) -> some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    CentraidIconView(iconKey: icon, tint: Theme.color("textSoft", scheme))
                    Text(title)
                        .centraidType("title")
                        .foregroundStyle(Theme.color("text", scheme))
                }
                ForEach(rows, id: \.memoryID) { row in
                    MemoryCard(row: row) {
                        onOpenMemory?(row.memoryID, MemoryCard.title(of: row))
                    }
                }
            }
        }
    }
}

/// ONE MEMORY, AS A ROW.
///
/// No tile rail: the members are a page of `media_asset` and this screen reads
/// `media_memory` alone, so drawing thumbnails here would need a second read
/// per memory. The shelf a tap opens is where the photographs are, which is the
/// contract's own arrangement — *"computed memories; their MEMBERS are a
/// shelf"*.
private struct MemoryCard: View {
    @Environment(\.colorScheme) private var scheme
    let row: Centraid_Screen_V1_MemoryRow
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                Color.clear
                    .frame(width: 56, height: 56)
                    .overlay {
                        if row.hasCoverThumbnailPath, !row.coverThumbnailPath.isEmpty {
                            ContentImage(path: row.coverThumbnailPath)
                        } else {
                            // THE GROUND, when there are no bytes. The cover
                            // needs a `media_asset` row this read never asks
                            // for, so it is empty here rather than fetched by a
                            // second trip per card.
                            Theme.color("bgSunken", scheme)
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                VStack(alignment: .leading, spacing: 2) {
                    Text(Self.title(of: row))
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                    let days = Self.dayRange(of: row)
                    if !days.isEmpty {
                        Text(days)
                            .centraidType("mono")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                    }
                }
                Spacer(minLength: 0)
                if !row.route.isEmpty {
                    RouteSketch(route: row.route)
                }
                CentraidIconView(
                    iconKey: "ChevronRight",
                    tint: Theme.color("textFaint", scheme)
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Self.title(of: row))
    }

    /// WHAT THIS MEMORY IS CALLED — the same ladder `PhotosMemoriesMachine.titleOf`
    /// walks, because the state crosses this boundary as BYTES and Swift cannot
    /// hand a `Centraid_Screen_V1_MemoryRow` to a Kotlin function. Kept in step
    /// by hand, like `PhotoCells.swift` and `PhotoCells.kt`.
    ///
    /// `title_hint` is what the pass called it and is empty when it had nothing
    /// to call it, so the title is COMPOSED rather than stored: a title written
    /// into the vault would be a name the vault never wrote.
    static func title(of row: Centraid_Screen_V1_MemoryRow) -> String {
        let hint = row.titleHint.trimmingCharacters(in: .whitespaces)
        if !hint.isEmpty { return hint }
        switch row.kind {
        case .onThisDay:
            return "On this day"
        case .trip:
            // `place_name` is folded from the trip's members' places by the
            // bridge; a trip whose photographs carry no readable place falls
            // back rather than printing a place id as a place.
            return row.placeName.isEmpty ? "Away from home" : row.placeName
        case .similar:
            return row.memberCount > 0
                ? "\(row.memberCount) similar photographs"
                : "Similar photographs"
        case .unspecified, .UNRECOGNIZED:
            return "A memory"
        }
    }

    /// The days a memory covers, or nothing.
    ///
    /// **A PARTIAL RANGE IS NOT PRINTED**: one date where a member expects two
    /// reads as a trip that ended the day it started. The dates are the vault's
    /// own `YYYY-MM-DD` — spelling "3 Jun" needs a locale, and the locale that
    /// is right is the VAULT's and never the device's.
    static func dayRange(of row: Centraid_Screen_V1_MemoryRow) -> String {
        let start = String(row.startedAt.prefix(10))
        let end = String(row.endedAt.prefix(10))
        guard start.count == 10, end.count == 10 else { return "" }
        return start == end ? start : "\(start) – \(end)"
    }
}

/// A TRIP'S ROUTE, SKETCHED BESIDE ITS NAME (v0's `RouteSketch`, #816).
///
/// Small on purpose — it situates the trip, it is not a map to be read — and
/// drawn here from the member's own coordinates with nothing fetched: a tile
/// would tell a stranger's server where the member has been
/// (`docs/photos/places.md`). The stops are joined in the order the
/// photographs were taken; a one-stop trip is a dot and no line.
///
/// The projection mirrors `PhotosMemoriesMachine.sketch`, which is what
/// Compose calls — the state crosses as BYTES, so Swift cannot hand the route
/// to a Kotlin function. Kept in step by hand, like `PlacesPlot`.
private struct RouteSketch: View {
    @Environment(\.colorScheme) private var scheme
    let route: [Centraid_Screen_V1_MemoryStop]

    private static let width: CGFloat = 96
    private static let height: CGFloat = 56
    /// Clear of the plate's edge by a dot's radius, as v0's was.
    private static let pad: CGFloat = 7

    var body: some View {
        let line = Theme.color("textFaint", scheme)
        let dot = Theme.color("textSoft", scheme)
        Canvas { context, size in
            let width = size.width - Self.pad * 2
            let height = size.height - Self.pad * 2
            let points = Self.sketch(route, aspect: Double(width / height)).map {
                CGPoint(x: Self.pad + CGFloat($0.x) * width, y: Self.pad + CGFloat($0.y) * height)
            }
            if points.count > 1 {
                var path = Path()
                path.addLines(points)
                context.stroke(path, with: .color(line), lineWidth: 1)
            }
            for point in points {
                let radius: CGFloat = 2.5
                context.fill(
                    Path(ellipseIn: CGRect(
                        x: point.x - radius,
                        y: point.y - radius,
                        width: radius * 2,
                        height: radius * 2
                    )),
                    with: .color(dot)
                )
            }
        }
        .frame(width: Self.width, height: Self.height)
        .background(Theme.color("bgSunken", scheme), in: RoundedRectangle(cornerRadius: 4))
        .accessibilityElement()
        .accessibilityLabel(route.count == 1 ? "A sketch of one stop" : "A sketch of \(route.count) stops")
    }

    /// `PhotosMemoriesMachine.sketch`: longitude narrowed by the cosine of the
    /// middle latitude, one scale for both axes, centred, y growing south.
    static func sketch(
        _ route: [Centraid_Screen_V1_MemoryStop],
        aspect: Double
    ) -> [(x: Double, y: Double)] {
        guard !route.isEmpty, aspect > 0 else { return [] }
        let latitudes = route.map(\.latitude)
        let middle = ((latitudes.min() ?? 0) + (latitudes.max() ?? 0)) / 2
        let narrowing = cos(middle * .pi / 180)
        let xs = route.map { $0.longitude * narrowing }
        let ys = route.map { -$0.latitude }
        let minX = xs.min() ?? 0, maxX = xs.max() ?? 0
        let minY = ys.min() ?? 0, maxY = ys.max() ?? 0
        let spanX = maxX - minX
        let spanY = maxY - minY
        let scale = min(
            spanX > 0 ? aspect / spanX : .infinity,
            spanY > 0 ? 1 / spanY : .infinity
        )
        let centreX = (maxX + minX) / 2
        let centreY = (maxY + minY) / 2
        return route.indices.map { index in
            guard scale.isFinite else { return (0.5, 0.5) }
            return (
                0.5 + (xs[index] - centreX) * scale / aspect,
                0.5 + (ys[index] - centreY) * scale
            )
        }
    }
}
