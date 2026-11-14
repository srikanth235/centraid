import SwiftUI

// HOME AS WIDGETS (#1173; boards `HomeWidgets`, `FirstHome`). Rust folds every
// app's tile into widgets (`crates/screens/src/shell/policy.rs`): which widgets,
// in what order, how wide (small is one of four columns, medium two, large all
// four), how tall, and the rows they sit in. These views draw what it sends and
// decide none of it. A widget wears the colour of the app it shows (`app_id`);
// `widget` is its identity (one per app since Calendar and Reminders split).

/// The grid's stated geometry: four columns, the board's gap and one row's floor.
private enum WidgetGeometry {
    static let columns = 4
    static let gap: CGFloat = 14
    /// A FLOOR, never a height: a fixed height slices bodies at large text sizes.
    static let row: CGFloat = 74
    static let pad: CGFloat = 12

    static func floor(rows: Int) -> CGFloat {
        CGFloat(rows) * row + CGFloat(max(rows - 1, 0)) * gap
    }
}

/// ONE ROW OF THE GRID: each widget as wide as its columns, and the row as tall
/// as its tallest widget or its floor. A lone widget keeps its columns instead of
/// stretching over the rest.
private struct WidgetRowLayout: Layout {
    let spans: [Int]
    let floor: CGFloat

    private func width(_ span: Int, in total: CGFloat) -> CGFloat {
        let unit = (total - CGFloat(WidgetGeometry.columns - 1) * WidgetGeometry.gap) / CGFloat(WidgetGeometry.columns)
        return unit * CGFloat(span) + CGFloat(span - 1) * WidgetGeometry.gap
    }

    private func height(_ subviews: Subviews, total: CGFloat) -> CGFloat {
        var tallest = floor
        for (index, view) in subviews.enumerated() where index < spans.count {
            let size = view.sizeThatFits(ProposedViewSize(width: width(spans[index], in: total), height: nil))
            tallest = max(tallest, size.height)
        }
        return tallest
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let total = proposal.width ?? 320
        return CGSize(width: total, height: height(subviews, total: total))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let tall = height(subviews, total: bounds.width)
        var x = bounds.minX
        for (index, view) in subviews.enumerated() where index < spans.count {
            let w = width(spans[index], in: bounds.width)
            view.place(at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading, proposal: ProposedViewSize(width: w, height: tall))
            x += w + WidgetGeometry.gap
        }
    }
}

/// THE WIDGET GRID, in the rows Rust packed (`grid_rows`). One packer, in Rust:
/// the Android grid reads the same rows.
struct WidgetGrid: View {
    let data: Centraid_Core_V1_HomeData
    @ObservedObject var shell: ShellModel
    /// AT THE LARGEST TEXT a widget has no room to share a row: each takes the whole width.
    @Environment(\.isLargestText) private var largestText

    private var byWidget: [String: Centraid_Core_V1_HomeTile] {
        Dictionary(data.tiles.map { ($0.widget, $0) }, uniquingKeysWith: { first, _ in first })
    }

    private func span(_ tile: Centraid_Core_V1_HomeTile) -> Int {
        switch tile.size {
        case .small: return 1
        case .medium: return 2
        default: return WidgetGeometry.columns
        }
    }

    /// Rust's rows, or one widget a row at the largest text.
    private func rows(_ tiles: [String: Centraid_Core_V1_HomeTile]) -> [[Centraid_Core_V1_HomeTile]] {
        let packed = data.gridRows.map { $0.widgets.compactMap { tiles[$0] } }.filter { !$0.isEmpty }
        return largestText ? packed.flatMap { $0 }.map { [$0] } : packed
    }

    var body: some View {
        let tiles = byWidget
        VStack(spacing: WidgetGeometry.gap) {
            ForEach(Array(rows(tiles).enumerated()), id: \.offset) { _, drawn in
                WidgetRowLayout(
                    spans: drawn.map { largestText ? WidgetGeometry.columns : span($0) },
                    floor: WidgetGeometry.floor(rows: Int(drawn.map(\.height).min() ?? 1))
                ) {
                    ForEach(drawn, id: \.widget) { tile in
                        WidgetCard(tile: tile, shell: shell)
                    }
                }
            }
        }
        // A CONTAINER, OR THE ID LEAKS: on a plain stack SwiftUI hands its
        // identifier down to every child, so each widget read `home-grid`.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home-grid")
    }
}

/// One widget: a card in the app's colour, pressed to open the app. The card is
/// white on the light page and the dark card in dark, with no border; only
/// floating glass casts a shadow.
private struct WidgetCard: View {
    let tile: Centraid_Core_V1_HomeTile
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme

    private var radius: CGFloat {
        CentraidScale.cardRadius * (tile.height > 1 || tile.size == .large ? 1.375 : 1.125)
    }

    private var content: Bool { tile.status == .content }

    var body: some View {
        Button {
            // A widget with no route is not tappable (loading, or unreadable).
            if tile.hasRoute { shell.open(tile.route) }
        } label: {
            Group {
                if case .photos? = tile.body.kind, tile.status != .loading {
                    PhotoWidget(tile: tile)
                } else {
                    WidgetBody(tile: tile)
                        .padding(WidgetGeometry.pad)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Surface.card)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        }
        .buttonStyle(.plain)
        // Keyed on the widget: Calendar's and Reminders' are `home-tile-calendar` and
        // `home-tile-reminders`. The label carries the live count; the id does not.
        .accessibilityIdentifier("home-tile-\(tile.widget)")
        .accessibilityLabel(tile.accessibilityLabel)
    }
}

/// What a widget says, by what it holds and how big it is. Something to show is
/// the app's own face; nothing yet is the app's name and what to do.
private struct WidgetBody: View {
    let tile: Centraid_Core_V1_HomeTile
    @Environment(\.colorScheme) private var scheme
    @Environment(\.homeLoadingLabel) private var loadingLabel
    /// At the largest text the tile is a full-width card whose lines would clip: the title and
    /// the note after it wrap, and "Edited today" is the line that goes first.
    @Environment(\.isLargestText) private var largestText

    private var accent: Color { AppAccent(tile.appID).text }
    private var meta: Color { Surface.meta }
    private var ink: Color { Surface.ink }

    var body: some View {
        if tile.status == .loading {
            skeleton
        } else if tile.status != .content {
            // A SMALL SLOT HOLDS A GLANCE, NOT A SENTENCE: Health's one word under its mark.
            if tile.size == .small { glance(figure: "", caption: tile.emptyCopy) } else { invitation }
        } else {
            switch tile.body.kind {
            case let .agenda(day): agenda(day)
            case let .reminders(owed): reminders(owed)
            case let .money(spent): glance(figure: spent.amounts.first ?? "", caption: spent.caption)
            case let .health(health): glance(figure: health.figure, caption: health.caption)
            case let .people(people): glance(figure: people.figure, caption: people.caption)
            case let .locker(locker): glance(figure: locker.stateLabel, caption: tile.name)
            case let .notes(notes): line(title: notes.title, next: notes.nextTitle, meta: notes.edited)
            case let .docs(docs): line(title: docs.rows.first?.name ?? "", meta: docs.rows.first?.size ?? "")
            case .photos, .none: EmptyView()
            }
        }
    }

    /// THE CALENDAR: the weekday in caps and the date, today's events (a bar in
    /// the app's colour, the title, the span), and the foot.
    private func agenda(_ day: Centraid_Core_V1_HomeTileBody.Agenda) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(day.weekday.uppercased())
                .centraidType("eyebrow")
                .foregroundStyle(accent)
            Text(day.day)
                .centraidType("display")
                .foregroundStyle(ink)
                .padding(.top, -4)
            ForEach(Array(day.events.enumerated()), id: \.offset) { _, event in
                HStack(spacing: 6) {
                    Capsule().fill(AppAccent(tile.appID).fill).frame(width: 3)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(event.title)
                            .centraidType("annotLabelOn")
                            .foregroundStyle(ink)
                            .lineLimit(1)
                        Text(event.span)
                            .centraidType("annotLabel")
                            .foregroundStyle(meta)
                            .lineLimit(1)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Text(day.foot)
                .centraidType("annotLabel")
                .foregroundStyle(meta)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// WHAT IS OWED TODAY: the name and how many, then the first titles behind
    /// a ring, then the caption.
    private func reminders(_ owed: Centraid_Core_V1_HomeTileBody.Reminders) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(tile.name)
                    .centraidType("annotLabelOn")
                    .foregroundStyle(accent)
                Spacer(minLength: 0)
                Text(tile.count.capped ? "\(tile.count.value)+" : "\(tile.count.value)")
                    .centraidType("title")
                    .foregroundStyle(accent)
            }
            ForEach(Array(owed.titles.enumerated()), id: \.offset) { _, title in
                HStack(spacing: 6) {
                    Circle()
                        .strokeBorder(meta, lineWidth: 1.4)
                        .frame(width: 12, height: 12)
                    Text(title)
                        .centraidType("annotLabel")
                        .foregroundStyle(ink)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Text(owed.caption)
                .centraidType("annotLabel")
                .foregroundStyle(meta)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// THE MARK A WIDGET DRAWS: the app's own, except People's, which the board draws as the
    /// person (the address book is the app's launcher glyph, not the widget's).
    private func widgetIcon(_ appIcon: String) -> String {
        tile.appID == "people" ? "User" : appIcon
    }

    /// A GLANCE (small): the app's mark in its colour, a figure and a word.
    private func glance(figure: String, caption: String) -> some View {
        VStack(spacing: 2) {
            if let app = CentraidCatalog.byID[tile.appID] {
                CentraidIconView(iconKey: widgetIcon(app.iconKey), tint: accent, size: 22)
                    .accessibilityHidden(true)
            }
            if !figure.isEmpty {
                Text(figure)
                    .centraidType("annotLabelOn")
                    .foregroundStyle(ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
            Text(caption)
                .centraidType("annotLabel")
                .foregroundStyle(meta)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// A LINE (medium, one row): the app's name in its colour, then what is
    /// newest in it and a word about it. AT THE LARGEST TEXT the word about it is dropped first
    /// and the titles wrap to two lines, so no line is cut mid-word.
    private func line(title: String, next: String = "", meta line2: String) -> some View {
        let titleLines = largestText ? 2 : 1
        return VStack(alignment: .leading, spacing: 2) {
            Text(tile.name)
                .centraidType("annotLabelOn")
                .foregroundStyle(accent)
            Text(title)
                .centraidType("annotLabel")
                .foregroundStyle(ink)
                .lineLimit(titleLines)
            // THE NOTE AFTER IT (Notes): a new vault's two starter notes both show.
            if !next.isEmpty {
                Text(next)
                    .centraidType("annotLabel")
                    .foregroundStyle(ink)
                    .lineLimit(titleLines)
            }
            if !line2.isEmpty, !largestText {
                Text(line2)
                    .centraidType("annotLabel")
                    .foregroundStyle(meta)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// NOTHING TO SHOW YET (or nothing readable): the app's mark and name, and
    /// what to DO, never what is missing.
    private var invitation: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if let app = CentraidCatalog.byID[tile.appID] {
                    CentraidIconView(iconKey: widgetIcon(app.iconKey), tint: accent, size: 16)
                        .accessibilityHidden(true)
                }
                Text(tile.name)
                    .centraidType("annotLabelOn")
                    .foregroundStyle(accent)
            }
            Spacer(minLength: 0)
            Text(tile.emptyCopy)
                .centraidType("annotLabel")
                .foregroundStyle(Surface.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// STATIC BARS, NEVER A SPINNER: a read in flight holds its slot, and the
    /// bars stand where the lines will.
    private var skeleton: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach([0.8, 0.55], id: \.self) { fraction in
                GeometryReader { proxy in
                    RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
                        .fill(Surface.line)
                        .frame(width: proxy.size.width * fraction, height: 10)
                }
                .frame(height: 10)
            }
        }
        .accessibilityLabel(loadingLabel)
    }
}

/// PHOTOS (large, or a tall medium with something to show): the newest four as
/// a strip of the photographs present, with the app's name over the foot.
/// A real cell with no bytes on this phone is drawn grey; absent cells take no space.
private struct PhotoWidget: View {
    let tile: Centraid_Core_V1_HomeTile
    @Environment(\.colorScheme) private var scheme

    private var photos: Centraid_Core_V1_HomeTileBody.Photos { tile.body.photos }

    private func cell(_ index: Int) -> some View {
        Rectangle()
            .fill(Surface.line)
            .overlay {
                if index < photos.cells.count, photos.cells[index].hasThumbnailPath,
                   !photos.cells[index].thumbnailPath.isEmpty {
                    ContentImage(path: photos.cells[index].thumbnailPath)
                }
            }
            .clipped()
    }

    var body: some View {
        // The photograph strip takes the card's height; the label rides its foot.
        HStack(spacing: 2) {
            cell(0).frame(maxWidth: .infinity)
            if photos.cells.count == 2 {
                cell(1).frame(maxWidth: .infinity)
            } else if photos.cells.count >= 3 {
                VStack(spacing: 2) {
                    cell(1)
                    cell(2)
                }
                .frame(maxWidth: .infinity)
                if photos.cells.count >= 4 {
                    cell(3).frame(maxWidth: .infinity)
                }
            }
        }
        .frame(minHeight: WidgetGeometry.floor(rows: 2))
        .overlay(alignment: .bottomLeading) {
            VStack(alignment: .leading, spacing: 2) {
                Text(tile.name)
                    .centraidType("annotLabelOn")
                    .foregroundStyle(Surface.ink)
                if !photos.absentLine.isEmpty {
                    Text(photos.absentLine)
                        .centraidType("annotLabel")
                        .foregroundStyle(Surface.meta)
                }
            }
            // An opaque caption plate keeps ordinary card contrast over any photograph.
            .padding(.horizontal, Theme.spacing("2", scheme))
            .padding(.vertical, Theme.spacing("1", scheme))
            .background(Surface.card, in: RoundedRectangle(cornerRadius: Theme.radius("sm", scheme), style: .continuous))
            .padding(WidgetGeometry.pad)
        }
    }
}
