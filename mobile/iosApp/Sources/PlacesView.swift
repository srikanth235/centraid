import SwiftUI

import CentraidShared

/// The decoder between `photos.places`' bytes and the view below.
///
/// Its own file rather than an addition to `StateViews.swift`: that file is
/// shared by every screen and a per-screen decoder belongs beside the screen it
/// decodes. The three-state read law is kept as `ScreenContent`, which
/// `StateViews.swift` already declares for everyone.
struct PlacesStateView {
    let data: Data

    private var state: Centraid_Screen_V1_PlacesState {
        (try? Centraid_Screen_V1_PlacesState(serializedBytes: data)) ?? .init()
    }

    /// Cards or the plot. **A parameter, not a screen** — this is what the
    /// segmented control reads, and switching costs no read.
    var presentation: Centraid_Screen_V1_PlacesState.Presentation { state.presentation }

    /// The places, and how many photographs carry no place at all.
    ///
    /// The rows cross AS THE WIRE HOLDS THEM. A per-card struct in between
    /// would be a second decode of a message that is already decoded, and a
    /// second place for "does this row have a pin" to be answered.
    var content: ScreenContent<([Centraid_Screen_V1_PlaceRow], UInt32, Bool)> {
        switch state.content {
        case let .failure(failure):
            return .failure(failure.sentence, failure.remedy)
        case let .data(data):
            return .data((data.places, data.unplacedCount, data.unplacedCountCapped))
        // `loading`, and the `nil` a message with no content set decodes to,
        // are the SAME screen — a state that has not read yet. Collapsing them
        // into `.data([])` is the fourth state the read law forbids.
        case let .loading(loading):
            return .loading(loading.firstLoad)
        case .none:
            return .loading(true)
        }
    }

    /// A WRITE WAS REFUSED, AND THE SENTENCE A MEMBER READS.
    ///
    /// Its own slot and never `content`'s `failure`: that one is the READ's,
    /// and a denied rename drawn there would replace the shelf of places the
    /// member was renaming from. The view draws this OVER the list.
    var writeFailure: (String, String)? {
        guard state.hasWriteFailure else { return nil }
        return (state.writeFailure.sentence, state.writeFailure.remedy)
    }

    var openedEvent: Data {
        var event = Centraid_Screen_V1_PlacesEvent()
        event.opened = .init()
        return event.encoded
    }

    /// THE PHOTOGRAPHS WITH NO PLACE, as the shelf a tap on the count opens —
    /// `PlacesMachine.unplacedShelf`'s value, spelled in Swift because the
    /// shelf crosses as bytes. `PhotosSearchReads` opens the same one.
    static var unplacedShelf: Data {
        var shelf = Centraid_Screen_V1_PhotoShelf()
        shelf.place = .with {
            $0.placeName = PhotosCopy.shared.PLACE_NO_LOCATION
            $0.unplaced = true
        }
        return (try? shelf.serializedData()) ?? Data()
    }

    func presentationEvent(
        _ presentation: Centraid_Screen_V1_PlacesState.Presentation
    ) -> Data {
        var event = Centraid_Screen_V1_PlacesEvent()
        event.presentation = .with { $0.presentation = presentation }
        return event.encoded
    }

    /// The member typed a name for a place.
    ///
    /// `media.name_place` is the VAULT command and the reducer is what names
    /// it; a view that composed a command name could compose one the vault does
    /// not register.
    func renameEvent(placeIdentifier: String, name: String) -> Data {
        var event = Centraid_Screen_V1_PlacesEvent()
        event.renamed = .with {
            $0.placeID = placeIdentifier
            $0.name = name
        }
        return event.encoded
    }
}

/// PLACES — THE SHELF AND THE PLOT, ON ONE SCREEN (#1029, photos port).
///
/// v0 had `PlacesView.tsx` and `PlacesMap.tsx`: two routes, two reads of the
/// same rows, two empty states. Here the draw is a parameter, so the control in
/// the toolbar swaps the body over rows that are already on screen.
///
/// It takes bytes and closures rather than the shell object, so it compiles and
/// renders without waiting on the screen's wiring: the root hands it
/// `shell.placesState`, a `send` that routes to `"photos.places"`, and the
/// navigation closure that pushes `photos.shelf`.
struct PlacesView: View {
    @Environment(\.colorScheme) private var scheme
    let data: Data
    let send: (Data) -> Void

    /// A tap lands on `photos.shelf` with a `PhotoShelf.Place`.
    ///
    /// **The name rides along** so the shelf's head says "The cabin" before its
    /// first page returns — a head that waited for a read paints under the
    /// previous shelf's title.
    var onOpenPlace: ((_ placeIdentifier: String, _ placeName: String) -> Void)?

    /// A tap on "N photographs carry no place": the shelf of those photographs,
    /// as encoded `PhotoShelf` bytes (v0's trailing "No location yet" card).
    var onOpenShelf: ((Data) -> Void)?

    /// The place being renamed, and the words typed so far.
    ///
    /// The typed text lives HERE because this is the only place it exists
    /// before it is written; the reducer holds the name the vault last said.
    @State private var renaming: RenameTarget?
    @State private var typedName = ""

    private var state: PlacesStateView { PlacesStateView(data: data) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                presentationControl

                // OVER THE LIST, NEVER INSTEAD OF IT. A refused rename changed
                // nothing, so the places a member was renaming from stay
                // exactly where they were.
                if let (sentence, remedy) = state.writeFailure {
                    ScreenFailureView(sentence: sentence, remedy: remedy)
                        .padding(10)
                        .background(Theme.color("bgElev", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
                }

                switch state.content {
                case .loading:
                    RowSkeleton()
                case let .denied(denied):
                    DeniedGate(denied)
                case let .failure(sentence, remedy):
                    ScreenFailureView(sentence: sentence, remedy: remedy)
                case let .data(places, unplaced, capped):
                    if places.isEmpty {
                        ScreenEmptyView(
                            sentence: PhotosCopy.shared.PHOTOS_PLACES_EMPTY,
                            remedy: PhotosCopy.shared.PHOTOS_PLACES_EMPTY_CAPTION
                        )
                    } else if state.presentation == .map {
                        PlacesPlot(places: places) { row in
                            onOpenPlace?(row.placeID, row.name)
                        }
                    } else {
                        cards(places)
                    }
                    footer(places: places, unplaced: unplaced, capped: capped)
                }
            }
            .padding(.vertical, 12)
        }
        .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
        .navigationTitle(PhotosCopy.shared.PHOTOS_PLACES)
        .onAppear { send(state.openedEvent) }
        .sheet(item: $renaming) { target in
            renameSheet(target)
        }
    }

    /// CARDS OR A PLOT, as two views of one read.
    private var presentationControl: some View {
        HStack {
            KitSegmented(
                options: [
                    (key: Centraid_Screen_V1_PlacesState.Presentation.cards, label: PhotosCopy.shared.PHOTOS_PLACES_CARDS),
                    (key: Centraid_Screen_V1_PlacesState.Presentation.map, label: PhotosCopy.shared.PHOTOS_PLACES_MAP),
                ],
                selected: state.presentation,
                identifier: "places-presentation"
            ) { presentation in
                send(state.presentationEvent(presentation))
            }
            Spacer()
        }
    }

    private func cards(_ places: [Centraid_Screen_V1_PlaceRow]) -> some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 140), spacing: 12)],
            spacing: 12
        ) {
            ForEach(places, id: \.placeID) { row in
                PlaceCard(row: row) {
                    onOpenPlace?(row.placeID, row.name)
                } onRename: {
                    renaming = RenameTarget(id: row.placeID, name: row.name)
                    typedName = row.name
                }
            }
        }
    }

    /// WHAT THE PLOT IS NOT SHOWING, AND WHERE THE PIXELS CAME FROM.
    ///
    /// Two sentences a member needs and v0 showed only one of:
    ///
    /// * **`unplaced_count`** — photographs with no place at all. It is the
    ///   number that says whether this screen is the library or a corner of it,
    ///   and v0 never showed it.
    /// * **the ground** — nothing is fetched, so opening Places asks nothing of
    ///   anyone. v0's default ground was real tiles and the equivalent sentence
    ///   there was a disclosure: the provider sees which areas you open.
    @ViewBuilder
    private func footer(
        places: [Centraid_Screen_V1_PlaceRow],
        unplaced: UInt32,
        capped: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if unplaced > 0 {
                // "AT LEAST", WHEN THE COUNTING PAGE FILLED. This is the number
                // that answers "is the plot my library or a corner of it", and
                // one that quietly stopped at a page would answer it wrong.
                //
                // AND IT IS A DOOR (v0's "No location yet" card, #816): a count
                // of photographs a member cannot reach is a number with no
                // next move.
                let sentence = unplacedSentence(unplaced, capped: capped)
                Button {
                    onOpenShelf?(PlacesStateView.unplacedShelf)
                } label: {
                    HStack(spacing: 6) {
                        Text(sentence)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                        Spacer(minLength: 0)
                        CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme))
                    }
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(sentence) \(PhotosCopy.shared.PHOTOS_PLACES_OPEN_THEM)")
                .accessibilityIdentifier("places.unplaced")
            }
            if state.presentation == .map {
                let unpinned = places.filter { !$0.hasCoordinate_p }.count
                if unpinned > 0 {
                    Text(
                        unpinned == 1
                            ? PhotosCopy.shared.PHOTOS_PLACES_UNPINNED_ONE
                            : copyFill(PhotosCopy.shared.PHOTOS_PLACES_UNPINNED_MANY, "count", "\(unpinned)")
                    )
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                }
                Text(PhotosCopy.shared.PHOTOS_PLACES_MAP_NOTE)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// One sentence, two verbs, because "1 photo has" and "at least 1 photo
    /// has" are both things a member may read; the count phrase is `CappedCount`'s.
    private func unplacedSentence(_ unplaced: UInt32, capped: Bool) -> String {
        let photos = CappedCount.shared.phrase(
            count: Int64(unplaced),
            capped: capped,
            one: PhotosCopy.shared.TILE_COUNT_ONE,
            many: PhotosCopy.shared.TILE_COUNT_MANY
        )
        let template = unplaced == 1 ? PhotosCopy.shared.PHOTOS_PLACES_UNPLACED_ONE : PhotosCopy.shared.PHOTOS_PLACES_UNPLACED_MANY
        return copyFill(template, "photos", photos)
    }

    private func renameSheet(_ target: RenameTarget) -> some View {
        SheetRoom(
            title: PhotosCopy.shared.PHOTOS_PLACES_NAME_THIS,
            // `media.name_place` REFUSES A BLANK NAME, so the control that would
            // send one is greyed. A round trip whose only possible outcome is
            // a denial teaches a member nothing.
            primary: SheetPrimary(
                label: PhotosCopy.shared.PHOTOS_SAVE,
                enabled: !typedName.trimmingCharacters(in: .whitespaces).isEmpty
            ) {
                send(
                    state.renameEvent(
                        placeIdentifier: target.id,
                        name: typedName
                    )
                )
                renaming = nil
            }
        ) {
            TextField(PhotosCopy.shared.PHOTOS_PLACE_NAME, text: $typedName)
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

/// ONE PLACE, AS A CARD.
///
/// The count is drawn only when it is non-zero: the count is derived by reading
/// the library's own page and counting it, so a zero is "this read has not
/// counted it" and never "no photographs here". A "0" under a place a member
/// has photographed is worse than no number at all.
private struct PlaceCard: View {
    @Environment(\.colorScheme) private var scheme
    let row: Centraid_Screen_V1_PlaceRow
    let onOpen: () -> Void
    let onRename: () -> Void

    private var cover: String? {
        row.hasCoverThumbnailPath && !row.coverThumbnailPath.isEmpty
            ? row.coverThumbnailPath
            : nil
    }

    /// "12", or "at least 12".
    ///
    /// The counting pass takes ONE page — `media_asset.captured_at` is nullable
    /// and a keyset continuation over a nullable sort column drops rows — so
    /// past that page every count is a floor. `asset_count_capped` is the row
    /// saying so, and printing a bare number over it would be this card
    /// claiming a total it never read.
    static func countPhrase(_ row: Centraid_Screen_V1_PlaceRow) -> String {
        CappedCount.shared.spoken(count: Int64(row.assetCount), capped: row.assetCountCapped, one: "", many: "")
    }

    var body: some View {
        Button(action: onOpen) {
            card
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            row.assetCount > 0
                ? copyFill(
                    copyFill(PhotosCopy.shared.PHOTOS_PLACES_SPOKEN, "name", row.name),
                    "count", PlaceCard.countPhrase(row))
                : row.name
        )
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Rename", onRename)
        .contextMenu {
            Button {
                onRename()
            } label: {
                Label {
                    Text(PhotosCopy.shared.PHOTOS_PLACES_NAME_THIS)
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
                        // THE GROUND, when there are no bytes. Not a
                        // placeholder image: a surface the eye reads as empty.
                        Theme.color("bgSunken", scheme)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
            Text(row.name)
                .centraidType("small")
                .lineLimit(2)
                .foregroundStyle(Theme.color("text", scheme))
            if row.assetCount > 0 {
                Text(PlaceCard.countPhrase(row))
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// THE PRIVATE PLOT — the pins over a plate, and no basemap at all.
///
/// v0 could choose a real tile map (`places-map-mode.ts`, default `real`) and
/// disclosed the cost under it: the provider sees which areas a member opens.
/// **Neither shell here links a map SDK, and `docs/photos/places.md` says no
/// surface in this tree draws a map**, so this is the private ground: a
/// coordinate-space plot of the member's own `geo_lat`/`geo_lng` with no
/// request to anyone. A real-tile map remains a separate decision with that
/// privacy cost attached.
///
/// The projection is the machine's (`PlacesMachine.plot`, run as the rows
/// arrive): every pinned row carries its place on the plate and its pin's size
/// (`pinX`, `pinY`, `pinSize`), and this only multiplies by its own box.
private struct PlacesPlot: View {
    @Environment(\.colorScheme) private var scheme
    let places: [Centraid_Screen_V1_PlaceRow]
    let onOpen: (Centraid_Screen_V1_PlaceRow) -> Void

    /// A place with a pin. **`has_coordinate`, never a test against zero** —
    /// 0,0 is a real point in the Gulf of Guinea.
    private var pinned: [Centraid_Screen_V1_PlaceRow] {
        places.filter(\.hasCoordinate_p)
    }

    var body: some View {
        GeometryReader { geometry in
            let plotted = plot(in: geometry.size)
            ZStack(alignment: .topLeading) {
                // RHYTHM, NOT REFERENCE. A graticule says "this is a chart of
                // your own coordinates" where a tiled ground would say "this is
                // the world", which is a claim this plate cannot make.
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
                // NORTH, because the plate has no other orientation cue and a
                // chart without one is a picture.
                Text(PhotosCopy.shared.PHOTOS_PLACES_NORTH)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                // REAL BUTTONS OVER THE CANVAS. A `Canvas` gives the
                // accessibility tree nothing to land on, so every pin is a
                // control with a name — which is the same reason v0 put
                // `Pressable`s over its SVG.
                ForEach(plotted, id: \.row.placeID) { pin in
                    Button {
                        onOpen(pin.row)
                    } label: {
                        PlacePin(row: pin.row, size: pin.size)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        pin.row.assetCount > 0
                            ? copyFill(
                                copyFill(PhotosCopy.shared.PHOTOS_PLACES_SPOKEN, "name", pin.row.name),
                                "count", PlaceCard.countPhrase(pin.row))
                            : pin.row.name
                    )
                    .position(x: pin.point.x, y: pin.point.y)
                }
            }
            .background(Theme.color("bgSunken", scheme))
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
        }
        .frame(height: 260)
    }

    private struct Pin {
        let row: Centraid_Screen_V1_PlaceRow
        let point: CGPoint
        let size: CGFloat
    }

    /// The pins in this box: the machine's unit square scaled inside the plate's
    /// inset. **y grows SOUTH**: the canvas origin is the top left.
    private func plot(in size: CGSize) -> [Pin] {
        let inset = CGFloat(PlacesMachine.shared.PLOT_INSET)
        return pinned.map { row in
            Pin(
                row: row,
                point: CGPoint(
                    x: inset + CGFloat(row.pinX) * max(1, size.width - inset * 2),
                    y: inset + CGFloat(row.pinY) * max(1, size.height - inset * 2)
                ),
                size: CGFloat(row.pinSize)
            )
        }
    }
}

/// ONE PIN: THE PLACE'S NEWEST PHOTOGRAPH WITH ITS COUNT IN THE CORNER (v0's
/// `places-pin.tsx`). A member recognises a place by what they took there long
/// before they recognise it by where it sits on a plate with no coastline. With
/// no cover it is the count alone, on the stage ink.
private struct PlacePin: View {
    @Environment(\.colorScheme) private var scheme
    let row: Centraid_Screen_V1_PlaceRow
    let size: CGFloat

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
        if row.hasCoverThumbnailPath, !row.coverThumbnailPath.isEmpty {
            Color.clear
                .frame(width: size, height: size)
                .overlay { ContentImage(path: row.coverThumbnailPath) }
                .overlay(alignment: .bottomTrailing) {
                    if row.assetCount > 0 {
                        Text("\(row.assetCount)")
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
            Text(row.assetCount > 0 ? "\(row.assetCount)" : "·")
                .centraidType("mono")
                .foregroundStyle(Theme.color("onStage", scheme))
                .frame(width: size, height: size)
                .background(Theme.color("stage", scheme), in: shape)
        }
    }
}

/// WHICH PLACE THE RENAME SHEET IS ABOUT.
///
/// A local pair rather than a retroactive `Identifiable` on the generated row:
/// conformances on a type another module owns are the kind of thing two lanes
/// both add and then collide over, and `sheet(item:)` needs nothing more than
/// an id. The id is the primary key — never the name, which is the thing the
/// sheet is about to change.
private struct RenameTarget: Identifiable {
    let id: String
    let name: String
}
