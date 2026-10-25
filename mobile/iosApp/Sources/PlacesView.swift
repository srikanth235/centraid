import SwiftUI

/// PLACES — THE SHELF AND THE PLOT, ON ONE SCREEN, drawn from the core's
/// `PhotosPlacesState` (#1135). Cards or a map is a parameter Rust holds; the
/// control at the top swaps the body over rows already on screen. A row carries
/// the `Route` to its shelf. The projection of a place onto the plate (`pinX`,
/// `pinY`, `pinSize`) is Rust's (`photos/places.rs`); this only multiplies by its
/// own box. Nothing is fetched: the plate is drawn from the member's own
/// coordinates, with no basemap and no request to anyone.
///
/// The Compose twin is `androidApp/.../screens/PlacesScreen.kt`.
struct PlacesView: View {
    @Environment(\.colorScheme) private var scheme

    let state: Centraid_Core_V1_PhotosPlacesState
    let send: (Centraid_Core_V1_PhotosPlacesEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    /// The words typed so far in the name sheet: the only place they exist
    /// before they are sent.
    @State private var typedName = ""

    private func event(_ build: (inout Centraid_Core_V1_PhotosPlacesEvent) -> Void) {
        var event = Centraid_Core_V1_PhotosPlacesEvent()
        build(&event)
        send(event)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    KitSegmented(
                        options: [
                            (key: Centraid_Core_V1_PhotosPlacesState.Presentation.cards, label: state.cardsLabel),
                            (key: Centraid_Core_V1_PhotosPlacesState.Presentation.map, label: state.mapLabel),
                        ],
                        selected: state.presentation,
                        identifier: "places-presentation"
                    ) { presentation in
                        event { $0.presentation = .with { $0.presentation = presentation } }
                    }
                    Spacer()
                }

                // OVER THE LIST, NEVER INSTEAD OF IT: a refused rename changed
                // nothing, so the places a member was renaming from stay.
                if state.hasStatus {
                    ScreenFailureView(sentence: state.status.sentence, remedy: "")
                        .padding(10)
                        .background(Theme.color("bgElev", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
                }

                switch state.content {
                case .loading?, nil:
                    RowSkeleton()
                case let .failure(failure)?:
                    ScreenFailureView(sentence: failure.sentence, remedy: failure.remedy)
                case let .data(data)?:
                    if data.hasEmpty {
                        ScreenEmptyView(sentence: data.empty.headline, remedy: data.empty.body)
                    } else if state.presentation == .map, data.hasMapEmpty {
                        ScreenEmptyView(sentence: data.mapEmpty.headline, remedy: data.mapEmpty.body)
                    } else if state.presentation == .map {
                        PlacesPlot(data: data, open: open)
                    } else {
                        cards(data.places)
                    }
                    footer(data)
                }
            }
            .padding(.vertical, 12)
        }
        .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
        .navigationTitle(state.title)
        .sheet(isPresented: Binding(
            get: { state.hasNameSheet },
            set: { shown in if !shown, state.hasNameSheet { event { $0.nameDismissed = .init() } } }
        )) {
            renameSheet(state.nameSheet)
        }
    }

    private func cards(_ places: [Centraid_Core_V1_PhotosPlaceRow]) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 12)], spacing: 12) {
            ForEach(places, id: \.placeID) { row in
                PlaceCard(row: row) {
                    open(row.open)
                } onName: {
                    typedName = row.currentName
                    event { $0.nameRequested = .with { $0.placeID = row.placeID } }
                }
            }
        }
    }

    /// WHAT THE PLOT IS NOT SHOWING, AND WHERE THE PIXELS CAME FROM.
    @ViewBuilder
    private func footer(_ data: Centraid_Core_V1_PhotosPlacesData) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if !data.unplacedLabel.isEmpty {
                // AND IT IS A DOOR: a count of photographs a member cannot reach
                // is a number with no next move.
                Button {
                    if data.hasUnplacedOpen { open(data.unplacedOpen) }
                } label: {
                    HStack(spacing: 6) {
                        Text(data.unplacedLabel)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                        Spacer(minLength: 0)
                        CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme))
                    }
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(data.unplacedLabel) \(data.unplacedOpenLabel)")
                .accessibilityIdentifier("places.unplaced")
            }
            if state.presentation == .map {
                if !data.unpinnedLabel.isEmpty {
                    Text(data.unpinnedLabel)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                Text(data.mapNote)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func renameSheet(_ sheet: Centraid_Core_V1_PhotosPlaceNameSheet) -> some View {
        SheetRoom(
            title: sheet.title,
            // A blank name is not offered: Save is greyed.
            primary: SheetPrimary(
                label: sheet.saveLabel,
                enabled: !typedName.trimmingCharacters(in: .whitespaces).isEmpty
            ) {
                event { $0.renamed = .with { $0.placeID = sheet.placeID; $0.name = typedName } }
            }
        ) {
            TextField(sheet.fieldLabel, text: $typedName)
                .centraidType("body")
                .padding(.horizontal, 12)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                        .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                )
                .accessibilityIdentifier("place-name-field")
        }
        .presentationDetents([.height(260)])
    }
}

/// ONE PLACE, AS A CARD. The count is drawn only when Rust gave one.
private struct PlaceCard: View {
    @Environment(\.colorScheme) private var scheme
    let row: Centraid_Core_V1_PhotosPlaceRow
    let onOpen: () -> Void
    let onName: () -> Void

    private var cover: String? {
        row.hasCover && row.cover.hasThumbnailPath && !row.cover.thumbnailPath.isEmpty
            ? row.cover.thumbnailPath
            : nil
    }

    var body: some View {
        Button(action: onOpen) {
            card
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.spoken)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: row.nameLabel, onName)
        .contextMenu {
            Button {
                onName()
            } label: {
                Label {
                    Text(row.nameLabel)
                } icon: {
                    CentraidIconView(iconKey: "Pencil", tint: Theme.color("text", scheme))
                }
            }
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 6) {
            Color.clear
                .aspectRatio(4 / 3, contentMode: .fit)
                .overlay {
                    if let cover {
                        ContentImage(path: cover)
                    } else {
                        // THE GROUND, when there are no bytes.
                        Theme.color("bgSunken", scheme)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
            Text(row.title)
                .centraidType("small")
                .lineLimit(2)
                .foregroundStyle(Theme.color("text", scheme))
            if !row.countLabel.isEmpty {
                Text(row.countLabel)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// THE PRIVATE PLOT — the pins over a plate, and no basemap at all.
private struct PlacesPlot: View {
    @Environment(\.colorScheme) private var scheme
    let data: Centraid_Core_V1_PhotosPlacesData
    let open: (Centraid_Core_V1_Route) -> Void

    /// The plate's inset, so a pin on the edge is not clipped. Geometry, not copy.
    private let inset: CGFloat = 32

    private var pinned: [Centraid_Core_V1_PhotosPlaceRow] { data.places.filter(\.pinned) }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                // RHYTHM, NOT REFERENCE.
                Canvas { context, size in
                    let ink = Theme.color("line", scheme)
                    for step in 1..<4 {
                        let fraction = CGFloat(step) / 4
                        var horizontal = Path()
                        horizontal.move(to: CGPoint(x: 0, y: size.height * fraction))
                        horizontal.addLine(to: CGPoint(x: size.width, y: size.height * fraction))
                        context.stroke(horizontal, with: .color(ink), lineWidth: 1)
                        var vertical = Path()
                        vertical.move(to: CGPoint(x: size.width * fraction, y: 0))
                        vertical.addLine(to: CGPoint(x: size.width * fraction, y: size.height))
                        context.stroke(vertical, with: .color(ink), lineWidth: 1)
                    }
                }
                Text(data.northLabel)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                // REAL BUTTONS OVER THE CANVAS: every pin is a control with a name.
                ForEach(pinned, id: \.placeID) { row in
                    Button {
                        open(row.open)
                    } label: {
                        PlacePin(row: row)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(row.spoken)
                    .position(
                        x: inset + CGFloat(row.pinX) * max(1, geometry.size.width - inset * 2),
                        y: inset + CGFloat(row.pinY) * max(1, geometry.size.height - inset * 2)
                    )
                }
            }
            .background(Theme.color("bgSunken", scheme))
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
        }
        .frame(height: 260)
    }
}

/// ONE PIN: THE PLACE'S NEWEST PHOTOGRAPH WITH ITS COUNT IN THE CORNER. With no
/// cover it is the count alone, on the stage ink.
private struct PlacePin: View {
    @Environment(\.colorScheme) private var scheme
    let row: Centraid_Core_V1_PhotosPlaceRow

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
        let size = CGFloat(row.pinSize)
        if row.hasCover, row.cover.hasThumbnailPath, !row.cover.thumbnailPath.isEmpty {
            Color.clear
                .frame(width: size, height: size)
                .overlay { ContentImage(path: row.cover.thumbnailPath) }
                .overlay(alignment: .bottomTrailing) {
                    if !row.countMark.isEmpty {
                        Text(row.countMark)
                            .centraidType("mono")
                            .foregroundStyle(Theme.color("onStage", scheme))
                            .padding(.horizontal, 4)
                            .background(
                                Theme.color("stage", scheme),
                                in: UnevenRoundedRectangle(topLeadingRadius: Theme.radius("md", scheme))
                            )
                    }
                }
                .background(Theme.color("bgElev", scheme))
                .clipShape(shape)
                .overlay(shape.strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline))
        } else {
            Text(row.countMark.isEmpty ? "·" : row.countMark)
                .centraidType("mono")
                .foregroundStyle(Theme.color("onStage", scheme))
                .frame(width: size, height: size)
                .background(Theme.color("stage", scheme), in: shape)
        }
    }
}
