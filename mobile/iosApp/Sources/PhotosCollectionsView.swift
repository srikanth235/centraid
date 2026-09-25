import Foundation
import SwiftProtobuf
import SwiftUI

/// COLLECTIONS, IN SWIFTUI (#1029, the photos port).
///
/// The hub: v0's `PHOTOS_MORE_FOOT` says "The rest of Photos is in
/// Collections", so every surface this miniapp has that is not the library or
/// search is reached from this list.
///
/// **LAID OUT AS THE SYSTEM PHOTOS APP LAYS OUT ITS COLLECTIONS TAB** (iOS 26):
/// a run of titled sections, each foldable — Memories as one wide card, Pinned
/// as a strip of square covers with the name printed on the photograph, Albums
/// as covers with the name and count beneath, People, and Utilities as a
/// grouped list. A member who knows that screen knows this one. What is NOT
/// borrowed is the system's own look: the type, colour and icons are the
/// emitted tables' (DESIGN.md), because a second icon set is a second product.
///
/// **The wire decides nothing new.** Which section a row lands in is read off
/// what the row already is — `member_owned` for albums, the mode for a standing
/// shelf, the kind for a door — and a row this file does not recognise goes to
/// Pinned rather than nowhere, so a sixth standing shelf is drawn before
/// anyone edits this.
///
/// **It takes bytes and two closures, not a `ShellModel`.** Where a tap GOES is
/// the navigator's business and this file routes nothing: it names the shelf
/// that was pressed and the door that was opened, and the shell decides what
/// that means. The closures are defaulted so the view renders in isolation.
struct PhotosCollectionsView: View {
    let data: Data
    var send: (Data) -> Void = { _ in }
    /// A shelf was tapped — the parameter for `photos.shelf`, whole.
    var onOpenShelf: (Centraid_Screen_V1_PhotoShelf) -> Void = { _ in }
    var onOpenDoor: (Centraid_Screen_V1_CollectionsDoor.Kind) -> Void = { _ in }

    @Environment(\.colorScheme) private var scheme
    /// WHICH SECTIONS ARE FOLDED, held here and nowhere else.
    ///
    /// The one piece of state this view owns, and deliberately: a fold is where
    /// a member's eye is, like a scroll offset, and not a fact about the vault.
    /// Nothing reads it back, no write depends on it, and a relaunch that opens
    /// every section again has lost nothing a member made.
    @State private var folded: Set<CollectionsSection> = []
    /// The album a member asked to delete, while the confirm is up.
    @State private var deleting: Centraid_Screen_V1_ShelfRow?

    var state: PhotosCollectionsStateView { PhotosCollectionsStateView(data: data) }

    var body: some View {
        // NO SCROLL VIEW OF ITS OWN. This body is drawn inside the photos
        // grid's scroll view, under its band, and a second vertical scroll view
        // nested in the first is two scrollers fighting for one drag.
        VStack(alignment: .leading, spacing: 0) {
            switch state.content {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
            case let .denied(denied):
                DeniedGate(denied)
            case let .failure(sentence, remedy):
                ScreenFailureView(sentence: sentence, remedy: remedy)
            case let .data(shelves, doors):
                let layout = CollectionsLayout(shelves: shelves, doors: doors)
                if let memories = layout.memories {
                    section(.memories) {
                        MemoriesCard(door: memories, onOpen: onOpenDoor)
                    }
                }
                if !layout.pinned.isEmpty {
                    section(.pinned) { pinnedStrip(layout.pinned) }
                }
                section(.albums) { albums(layout.albums) }
                if let people = layout.people {
                    section(.people) { PeopleCard(door: people, onOpen: onOpenDoor) }
                }
                if !layout.utilities.isEmpty {
                    section(.utilities) {
                        UtilitiesGroup(
                            items: layout.utilities,
                            onOpenShelf: onOpenShelf,
                            onOpenDoor: onOpenDoor
                        )
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 24)
        .navigationTitle("Collections")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    send(state.sheetEvent(.newAlbum))
                } label: {
                    CentraidIconView(iconKey: "add", tint: Theme.color("link", scheme))
                }
                .accessibilityLabel("New album")
                .accessibilityIdentifier("photos.collections.new-album")
            }
            // SHOW ALL / COLLAPSE ALL — v0's Collections menu, and only that
            // (`photos-collections-menu.ts`): no reorder row, because no order
            // is kept, and neither row is checked, because a bulk fold is a
            // command and not a setting.
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Show all") { fold(nothing: true) }
                        .accessibilityIdentifier("photos.collections.show-all")
                    Button("Collapse all") { fold(nothing: false) }
                        .accessibilityIdentifier("photos.collections.collapse-all")
                } label: {
                    CentraidIconView(iconKey: "MoreHoriz", tint: Theme.color("link", scheme))
                }
                .accessibilityLabel("Collections options")
                .accessibilityIdentifier("photos.collections.menu")
            }
        }
        // DELETING AN ALBUM DELETES THE GROUPING, and the confirm says so in
        // v0's one sentence. The reducer's `album_deleted` arm was wired and
        // nothing sent it.
        .confirmationDialog(
            "Delete this album?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deleting
        ) { row in
            Button("Delete album", role: .destructive) {
                if case let .album(album) = row.shelf.of {
                    send(PhotosCollectionsStateView.deleteEvent(album.collectionID))
                }
                deleting = nil
            }
            Button("Keep it", role: .cancel) { deleting = nil }
        } message: { _ in
            Text("Photos stay in the library.")
        }
        // NAMING A NEW ALBUM IS A SHEET AND THE STATE SAYS WHICH SHEET IS OPEN.
        // `isPresented` is derived from the state rather than held here,
        // because a sheet with its own `@State` would be a second place the
        // answer lives — and a swipe-to-dismiss has to reach the reducer too,
        // or the state would still say `NEW_ALBUM` with nothing on screen.
        .sheet(
            isPresented: Binding(
                get: { state.sheet == .newAlbum },
                set: { open in
                    guard !open, state.sheet == .newAlbum else { return }
                    send(state.sheetEvent(.none))
                }
            )
        ) {
            NewAlbumSheet(send: send, failure: state.writeFailure)
        }
    }

    /// EVERY SECTION AT ONCE, open or folded — under the same curve a single
    /// fold uses.
    private func fold(nothing: Bool) {
        withAnimation(.easeInOut(duration: CentraidGeometry.durationOne / 1000)) {
            folded = nothing ? [] : Set(CollectionsSection.allCases)
        }
    }

    /// A TITLED, FOLDABLE SECTION — the system's header: the name large and on
    /// the left, a round fold control on the right that points down while the
    /// section is open.
    private func section<Content: View>(
        _ section: CollectionsSection,
        @ViewBuilder content: () -> Content
    ) -> some View {
        let isFolded = folded.contains(section)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center) {
                Text(section.title)
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                Button {
                    withAnimation(.easeInOut(duration: CentraidGeometry.durationOne / 1000)) {
                        if isFolded { folded.remove(section) } else { folded.insert(section) }
                    }
                } label: {
                    CentraidIconView(iconKey: "ChevronDown", tint: Theme.color("link", scheme))
                        .rotationEffect(.degrees(isFolded ? -90 : 0))
                        .frame(width: foldControl, height: foldControl)
                        .background(Circle().fill(Theme.color("bgElev", scheme)))
                        .frame(
                            minWidth: CentraidGeometry.targetMinCoarse,
                            minHeight: CentraidGeometry.targetMinCoarse,
                            alignment: .trailing
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isFolded ? "Show \(section.title)" : "Hide \(section.title)")
            }
            if !isFolded { content() }
        }
        .padding(.top, 20)
    }

    /// PINNED IS A STRIP, and it runs to the screen's edge.
    ///
    /// The strip bleeds through the page margin on both sides so a card that
    /// does not fit is cut by the glass and not by an invisible gutter — the
    /// half-shown card is how a member learns the row scrolls.
    private func pinnedStrip(_ items: [CollectionsItem]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: cardGap) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    PinnedCard(item: item, onOpenShelf: onOpenShelf, onOpenDoor: onOpenDoor)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
        }
        .padding(.horizontal, -CentraidGeometry.pageMargin)
    }

    /// THE MEMBER'S OWN ALBUMS — covers in a strip, or the invitation to make
    /// one. The empty case is a card with its verb on it, as the system draws
    /// it, and not a blank section: a section that vanished when it was empty
    /// would hide the one place a first album is made.
    @ViewBuilder
    private func albums(_ rows: [Centraid_Screen_V1_ShelfRow]) -> some View {
        if rows.isEmpty {
            EmptySectionCard(
                iconKey: "album",
                title: "No albums yet",
                caption: "Albums you make appear here.",
                verb: "Create",
                onVerb: { send(state.sheetEvent(.newAlbum)) }
            )
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: cardGap) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        AlbumCard(row: row, onOpen: onOpenShelf, onDelete: { deleting = row })
                    }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
            }
            .padding(.horizontal, -CentraidGeometry.pageMargin)
        }
    }
}

// MARK: - the measures, and where each came from

/// Home's tile radius: one card corner in the product, not one per screen.
private let cardRadius: CGFloat = 12
/// The gap between cards in a strip — the system's, measured on its Pinned row.
private let cardGap: CGFloat = 12
/// A Pinned card's side. The system shows three and a sliver on a 402pt phone.
private let pinnedSide: CGFloat = 110
/// An album cover's side: larger than Pinned's, because an album is read by
/// its picture and a pinned shelf by its name.
private let albumSide: CGFloat = 150
/// The round fold control's drawn diameter; the hit area is the coarse target.
private let foldControl: CGFloat = 30
/// The Memories and People cards' height — the system's Memories card.
private let wideCardHeight: CGFloat = 150

// MARK: - which row goes in which section

enum CollectionsSection: Hashable, CaseIterable {
    case memories, pinned, albums, people, utilities

    var title: String {
        switch self {
        case .memories: return "Memories"
        case .pinned: return "Pinned"
        case .albums: return "Albums"
        case .people: return "People"
        case .utilities: return "Utilities"
        }
    }
}

/// A shelf or a door, which is all a card on this screen can be.
enum CollectionsItem {
    case shelf(Centraid_Screen_V1_ShelfRow)
    case door(Centraid_Screen_V1_CollectionsDoor)
}

/// The rows, sorted into the system's sections.
///
/// Pinned holds what a member reaches for — Favorites, Videos, and Places in
/// the slot the system gives its Map. Utilities holds the housekeeping —
/// Duplicates, Archive, Trash — where the system keeps Duplicates and Recently
/// Deleted. Anything else a standing shelf turns out to be lands in Pinned.
struct CollectionsLayout {
    var memories: Centraid_Screen_V1_CollectionsDoor?
    var people: Centraid_Screen_V1_CollectionsDoor?
    var pinned: [CollectionsItem] = []
    var albums: [Centraid_Screen_V1_ShelfRow] = []
    var utilities: [CollectionsItem] = []

    init(shelves: [Centraid_Screen_V1_ShelfRow], doors: [Centraid_Screen_V1_CollectionsDoor]) {
        var places: Centraid_Screen_V1_CollectionsDoor?
        var duplicates: Centraid_Screen_V1_CollectionsDoor?
        for door in doors {
            switch door.kind {
            case .memories: memories = door
            case .people: people = door
            case .places: places = door
            case .duplicates: duplicates = door
            case .unspecified, .UNRECOGNIZED: break
            }
        }
        var housekeeping: [CollectionsItem] = []
        for row in shelves {
            if row.memberOwned {
                albums.append(row)
            } else if [.archive, .trash].contains(Self.mode(of: row)) {
                housekeeping.append(.shelf(row))
            } else {
                pinned.append(.shelf(row))
            }
        }
        // PLACES AFTER THE SECOND STANDING SHELF, where the system puts Map:
        // after Favorites and its neighbour, before the rest.
        if let places {
            pinned.insert(.door(places), at: min(2, pinned.count))
        }
        if let duplicates { utilities.append(.door(duplicates)) }
        utilities += housekeeping
    }

    static func mode(of row: Centraid_Screen_V1_ShelfRow) -> Centraid_Screen_V1_PhotoStateView.Mode.Kind? {
        guard case let .stateView(view) = row.shelf.of, case let .mode(mode) = view.view else { return nil }
        return mode.kind
    }
}

// MARK: - the counts, spelled once

/// **A CAPPED COUNT SAYS `N+` AND NEVER A BARE NUMBER.** The door has no
/// `COUNT(*)`, so every count on this screen is rows read and counted, and a
/// page that filled has more behind it — printing its ceiling as a fact would
/// be stating a total nobody counted. `HomeView`'s tile count is the same rule
/// and the same spelling, and the spoken form says "at least" because a screen
/// reader cannot pronounce a plus.
///
/// Zero on a SHELF is a real count and reads "Empty", which is the field's own
/// word. Zero on a DOOR means nothing is known yet — the contract's own words —
/// so it draws nothing: an empty Trash is a fact, and a Places door with nothing
/// to say is a door that has not been counted.
private enum Counted {
    static func shelf(_ row: Centraid_Screen_V1_ShelfRow) -> (shown: String, spoken: String) {
        if row.itemCountCapped { return ("\(row.itemCount)+", "at least \(row.itemCount)") }
        return row.itemCount == 0 ? ("Empty", "empty") : ("\(row.itemCount)", "\(row.itemCount)")
    }

    /// `needs_attention` OUTRANKS the count: a member deciding whether to open
    /// Duplicates is deciding on the decisions still owed, not on how many
    /// clusters exist.
    static func door(_ door: Centraid_Screen_V1_CollectionsDoor) -> (shown: String, spoken: String, urgent: Bool)? {
        if door.needsAttention > 0 {
            return ("\(door.needsAttention) waiting", "\(door.needsAttention) waiting", true)
        }
        guard door.count > 0 else { return nil }
        return door.countCapped
            ? ("\(door.count)+", "at least \(door.count)", false)
            : ("\(door.count)", "\(door.count)", false)
    }

    /// AN ALBUM WITH NO NAME IS STILL A CARD, and it says so. Dropping it would
    /// leave a member with an album they made and cannot find; a blank caption
    /// would leave them with one they cannot recognise.
    static func title(_ row: Centraid_Screen_V1_ShelfRow) -> String {
        row.title.isEmpty ? "Untitled album" : row.title
    }
}

// MARK: - the cards

/// A cover, or the ground a card without one stands on.
///
/// With no photograph the card is a soft vertical wash rather than a flat
/// block, so a coverless shelf reads as a card waiting for a picture — the
/// system does the same with its grey Map and Favorites cards.
private struct CoverGround: View {
    let path: String?
    let iconKey: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Theme.color("bgElev", scheme), Theme.color("lineStrong", scheme)],
                startPoint: .top,
                endPoint: .bottom
            )
            if let path, !path.isEmpty {
                ContentImage(path: path)
            } else {
                CentraidIconView(iconKey: iconKey, tint: Theme.color("textFaint", scheme), size: 28)
            }
        }
        .clipped()
    }
}

/// ONE PINNED CARD: a square, the name printed on the picture.
///
/// The name sits on a dark wash at the foot of the card so it reads on any
/// photograph — white on a bright sky is the failure the wash prevents. A card
/// with no cover gets the same wash, so the name is always drawn one way.
private struct PinnedCard: View {
    let item: CollectionsItem
    let onOpenShelf: (Centraid_Screen_V1_PhotoShelf) -> Void
    let onOpenDoor: (Centraid_Screen_V1_CollectionsDoor.Kind) -> Void

    var body: some View {
        Button(action: open) {
            ZStack(alignment: .bottomLeading) {
                CoverGround(path: cover, iconKey: iconKey)
                LinearGradient(
                    colors: [.black.opacity(0), .black.opacity(0.45)],
                    startPoint: .center,
                    endPoint: .bottom
                )
                Text(title)
                    .centraidType("smallStrong")
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .padding(10)
            }
            .frame(width: pinnedSide, height: pinnedSide)
            .clipShape(RoundedRectangle(cornerRadius: cardRadius))
            .contentShape(RoundedRectangle(cornerRadius: cardRadius))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier(identifier)
    }

    private var title: String {
        switch item {
        case let .shelf(row): return Counted.title(row)
        case let .door(door): return PhotosCollectionsStateView.title(for: door.kind)
        }
    }

    private var cover: String? {
        guard case let .shelf(row) = item, row.hasCoverThumbnailPath else { return nil }
        return row.coverThumbnailPath
    }

    private var iconKey: String {
        switch item {
        case let .shelf(row): return PhotosCollectionsStateView.iconKey(for: row.shelf)
        case let .door(door): return PhotosCollectionsStateView.iconKey(for: door.kind)
        }
    }

    private var spoken: String {
        switch item {
        case let .shelf(row): return "\(title), \(Counted.shelf(row).spoken)"
        case let .door(door):
            guard let count = Counted.door(door) else { return title }
            return "\(title), \(count.spoken)"
        }
    }

    private var identifier: String {
        if case .door = item { return "photos.collections.door" }
        return "photos.collections.shelf"
    }

    private func open() {
        switch item {
        case let .shelf(row): onOpenShelf(row.shelf)
        case let .door(door): onOpenDoor(door.kind)
        }
    }
}

/// ONE ALBUM: the cover, then the name and the count beneath it.
private struct AlbumCard: View {
    let row: Centraid_Screen_V1_ShelfRow
    let onOpen: (Centraid_Screen_V1_PhotoShelf) -> Void
    /// A long-press's "Delete album" — the parent confirms before it sends.
    var onDelete: () -> Void = {}
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button {
            onOpen(row.shelf)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                CoverGround(
                    path: row.hasCoverThumbnailPath ? row.coverThumbnailPath : nil,
                    iconKey: "album"
                )
                .frame(width: albumSide, height: albumSide)
                .clipShape(RoundedRectangle(cornerRadius: cardRadius))
                VStack(alignment: .leading, spacing: 0) {
                    Text(Counted.title(row))
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                    Text(Counted.shelf(row).shown)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
                .frame(width: albumSide, alignment: .leading)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // THE SYSTEM'S LONG-PRESS ON AN ALBUM. Only an album: a standing shelf
        // is not `member_owned`, and never reaches this card.
        .contextMenu {
            Button("Delete album", role: .destructive, action: onDelete)
                .accessibilityIdentifier("photos.collections.delete-album")
        }
        .accessibilityLabel("\(Counted.title(row)), \(Counted.shelf(row).spoken)")
        .accessibilityIdentifier("photos.collections.shelf")
        .accessibilityAction(named: "Delete album", onDelete)
    }
}

/// THE WIDE CARD both Memories and People are drawn on: an icon at the top,
/// the sentence at the foot, the whole card a door.
private struct WideCard: View {
    let iconKey: String
    let title: String
    let caption: String?
    let urgent: Bool
    let spoken: String
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                CentraidIconView(iconKey: iconKey, tint: Theme.color("textFaint", scheme), size: 28)
                Spacer(minLength: 12)
                Text(title)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color(urgent ? "accent" : "text", scheme))
                if let caption {
                    Text(caption)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, minHeight: wideCardHeight, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: cardRadius).fill(Theme.color("bgElev", scheme))
            )
            .contentShape(RoundedRectangle(cornerRadius: cardRadius))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier("photos.collections.door")
    }
}

/// MEMORIES, AS THE SYSTEM'S WIDE CARD.
///
/// "None yet", never "none": nothing in this build computes a memory
/// (`docs/photos/derived-ledger.md`), so a zero is a projection nobody has
/// written, and a card that said there were no memories would be stating a
/// finding nothing made.
private struct MemoriesCard: View {
    let door: Centraid_Screen_V1_CollectionsDoor
    let onOpen: (Centraid_Screen_V1_CollectionsDoor.Kind) -> Void

    var body: some View {
        let count = Counted.door(door)
        WideCard(
            iconKey: "Sparkle",
            title: count.map { "\($0.shown) memories" } ?? "No memories yet",
            caption: count == nil ? "Memories appear here once this vault has made some." : nil,
            urgent: count?.urgent ?? false,
            spoken: count.map { "Memories, \($0.spoken)" } ?? "Memories, none yet",
            action: { onOpen(.memories) }
        )
    }
}

/// PEOPLE, AS A WIDE CARD. The system draws a grid of faces here; this state
/// carries a count and no faces, so the card names the door and what waits
/// behind it rather than drawing circles it has nothing to fill with.
private struct PeopleCard: View {
    let door: Centraid_Screen_V1_CollectionsDoor
    let onOpen: (Centraid_Screen_V1_CollectionsDoor.Kind) -> Void

    var body: some View {
        let count = Counted.door(door)
        WideCard(
            iconKey: "Users",
            title: count.map { $0.urgent ? $0.shown : "\($0.shown) people" } ?? "People",
            caption: "The faces in your photographs, and who they are.",
            urgent: count?.urgent ?? false,
            spoken: count.map { "People, \($0.spoken)" } ?? "People",
            action: { onOpen(.people) }
        )
    }
}

/// AN EMPTY SECTION'S CARD: icon and verb across the top, the sentence at the
/// foot. The verb is a real control, not decoration — it is the same
/// `newAlbum` sheet the toolbar's plus opens.
private struct EmptySectionCard: View {
    let iconKey: String
    let title: String
    let caption: String
    let verb: String
    let onVerb: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                CentraidIconView(iconKey: iconKey, tint: Theme.color("textFaint", scheme), size: 28)
                Spacer()
                Button(action: onVerb) {
                    Text(verb)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("link", scheme))
                        .padding(.horizontal, 14)
                        .frame(minHeight: CentraidGeometry.targetMinFine)
                        .background(Capsule().fill(Theme.color("bgPress", scheme)))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("photos.collections.create-album-card")
            }
            Spacer(minLength: 12)
            Text(title)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("textSoft", scheme))
            Text(caption)
                .centraidType("small")
                .foregroundStyle(Theme.color("textFaint", scheme))
        }
        .padding(18)
        .frame(maxWidth: .infinity, minHeight: wideCardHeight, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: cardRadius).fill(Theme.color("bgElev", scheme)))
    }
}

/// UTILITIES, AS A GROUPED LIST: one rounded card, a row per shelf or door,
/// hairlines between them inset past the icon — the system's inset-grouped
/// list, which is how it draws Duplicates and Recently Deleted.
private struct UtilitiesGroup: View {
    let items: [CollectionsItem]
    let onOpenShelf: (Centraid_Screen_V1_PhotoShelf) -> Void
    let onOpenDoor: (Centraid_Screen_V1_CollectionsDoor.Kind) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                if index > 0 {
                    Rectangle()
                        .fill(Theme.color("line", scheme))
                        .frame(height: CentraidGeometry.hairline)
                        .padding(.leading, 50)
                }
                row(item)
            }
        }
        .background(RoundedRectangle(cornerRadius: cardRadius).fill(Theme.color("bgElev", scheme)))
    }

    private func row(_ item: CollectionsItem) -> some View {
        let (title, iconKey, count, spoken, urgent, identifier): (String, String, String?, String, Bool, String) = {
            switch item {
            case let .shelf(row):
                let counted = Counted.shelf(row)
                return (
                    Counted.title(row),
                    PhotosCollectionsStateView.iconKey(for: row.shelf),
                    counted.shown,
                    "\(Counted.title(row)), \(counted.spoken)",
                    false,
                    "photos.collections.shelf"
                )
            case let .door(door):
                let name = PhotosCollectionsStateView.title(for: door.kind)
                let counted = Counted.door(door)
                return (
                    name,
                    PhotosCollectionsStateView.iconKey(for: door.kind),
                    counted?.shown,
                    counted.map { "\(name), \($0.spoken)" } ?? name,
                    counted?.urgent ?? false,
                    "photos.collections.door"
                )
            }
        }()
        return Button {
            switch item {
            case let .shelf(row): onOpenShelf(row.shelf)
            case let .door(door): onOpenDoor(door.kind)
            }
        } label: {
            HStack(spacing: 12) {
                CentraidIconView(iconKey: iconKey, tint: Theme.color("link", scheme), size: 22)
                    .frame(width: 26)
                Text(title)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                Spacer(minLength: 8)
                if let count {
                    Text(count)
                        .centraidType("small")
                        .foregroundStyle(Theme.color(urgent ? "accent" : "textFaint", scheme))
                }
                CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme))
            }
            .padding(.horizontal, 12)
            .frame(minHeight: CentraidGeometry.targetMinCoarse + 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier(identifier)
    }
}

/// ONE FIELD AND A VERB.
///
/// The sheet does NOT close itself when Create is pressed: the reducer closes
/// it when the write commits, so a refused create leaves the member's typed
/// name on the screen and the album visibly not made. Closing on the press
/// would be the shell claiming an album exists because a button was tapped.
private struct NewAlbumSheet: View {
    let send: (Data) -> Void
    /// The last refusal, drawn BESIDE the field and never instead of it — the
    /// member's typed name is the only copy of it, and a sheet that swapped it
    /// for an error would have thrown that away.
    let failure: String?

    @Environment(\.colorScheme) private var scheme
    @State private var name = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField("Album name", text: $name)
                    .accessibilityIdentifier("photos.collections.album-name")
                if let failure {
                    Text(failure)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .accessibilityIdentifier("photos.collections.write-failure")
                }
            }
            .navigationTitle("New album")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        send(PhotosCollectionsStateView.createEvent(name))
                    }
                    // AN EMPTY NAME IS NOT A WRITE. `media.create_album`'s
                    // schema has `"title": { "minLength": 1 }`, so the vault
                    // would refuse it — and a control that submits a command
                    // known to be refused is a control that wastes a round trip
                    // to tell a member what the field already knew.
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("photos.collections.create-album")
                }
            }
        }
    }
}

/// The decoder between Collections' bytes and the view above.
///
/// Its own file rather than an addition to `StateViews.swift`, which is shared
/// and would collide with every other screen landing in this port. The
/// three-state read law is a Swift `enum` with three cases, which is how the
/// law survives the language boundary — `ScreenContent` is declared once in
/// `StateViews.swift` and reused here rather than redeclared.
struct PhotosCollectionsStateView {
    let data: Data

    private var state: Centraid_Screen_V1_PhotosCollectionsState {
        (try? Centraid_Screen_V1_PhotosCollectionsState(serializedBytes: data)) ?? .init()
    }

    var sheet: Centraid_Screen_V1_PhotosCollectionsState.Sheet { state.sheet }

    /// A WRITE WAS REFUSED, AND THE SENTENCE A MEMBER READS.
    ///
    /// **Read off `write_failure` and never off `content`'s `failure`.** That
    /// slot is the READ's — one of the three states a read can be in — and a
    /// denied create drawn there would replace the whole list of shelves with
    /// an error, so a member whose new album was refused would lose the
    /// Collections screen itself, four standing shelves and all.
    var writeFailure: String? {
        state.hasWriteFailure ? state.writeFailure.sentence : nil
    }

    /// The shelves and the doors, as the wire holds them.
    ///
    /// No per-row struct in between: the rows are already decoded by the time
    /// this has a data case, and a mapping step would be a second decode plus a
    /// second place for "is this member-owned" to be spelled.
    var content: ScreenContent<
        ([Centraid_Screen_V1_ShelfRow], [Centraid_Screen_V1_CollectionsDoor])
    > {
        switch state.content {
        case let .failure(failure):
            return .failure(failure.sentence, failure.remedy)
        case let .data(data):
            return .data((data.shelves, data.doors))
        // `loading`, and the `nil` a message with no content set decodes to,
        // are the SAME screen — a state that has not read yet. Collapsing them
        // into an empty data case is the fourth state the read law forbids.
        case let .loading(loading):
            return .loading(loading.firstLoad)
        case .none:
            return .loading(true)
        }
    }

    func sheetEvent(_ sheet: Centraid_Screen_V1_PhotosCollectionsState.Sheet) -> Data {
        var event = Centraid_Screen_V1_PhotosCollectionsEvent()
        event.sheet = .with { $0.sheet = sheet }
        return event.encoded
    }

    static func createEvent(_ name: String) -> Data {
        var event = Centraid_Screen_V1_PhotosCollectionsEvent()
        event.albumCreated = .with { $0.name = name }
        return event.encoded
    }

    /// Sent from the album card's long-press, after the confirm.
    static func deleteEvent(_ collectionIdentifier: String) -> Data {
        var event = Centraid_Screen_V1_PhotosCollectionsEvent()
        event.albumDeleted = .with { $0.collectionID = collectionIdentifier }
        return event.encoded
    }

    static func nextPageEvent(_ cursor: String) -> Data {
        var event = Centraid_Screen_V1_PhotosCollectionsEvent()
        event.nextPage = .with { $0.afterCursor = cursor }
        return event.encoded
    }

    /// THE CATALOG'S KEYS AND NOTHING ELSE.
    ///
    /// `CentraidIconView` looks the key up in `CentraidCatalog.icons` and falls
    /// back to `?? []`, so a key that does not exist draws NOTHING — silently,
    /// which is the failure that once made the band's More tab render as a
    /// dash. Every key below is in the emitted catalog. SF Symbols are
    /// deliberately not reachable from here: a second icon set is a second
    /// product.
    static func iconKey(for shelf: Centraid_Screen_V1_PhotoShelf) -> String {
        switch shelf.of {
        case let .stateView(view):
            switch view.view {
            case let .mode(mode):
                switch mode.kind {
                case .favorites: return "heart"
                case .archive: return "Archive"
                case .trash: return "trash"
                case .videos: return "Video"
                case .unspecified, .UNRECOGNIZED: return "album"
                }
            case .person: return "person"
            case .none: return "album"
            }
        case .album, .none: return "album"
        case .place: return "place"
        case .memory: return "Sparkle"
        }
    }

    static func iconKey(for kind: Centraid_Screen_V1_CollectionsDoor.Kind) -> String {
        switch kind {
        case .people: return "Users"
        case .places: return "place"
        case .memories: return "Sparkle"
        case .duplicates: return "dupe"
        case .unspecified, .UNRECOGNIZED: return "album"
        }
    }

    /// A DOOR'S NAME IS COPY AND RIDES THE SHELL, not the wire.
    ///
    /// `CollectionsDoor` carries a `kind` and no title, deliberately: the four
    /// are fixed and a string on the row would be four strings to keep in step
    /// with Compose's four. The kind is the fact; this is the word.
    static func title(for kind: Centraid_Screen_V1_CollectionsDoor.Kind) -> String {
        switch kind {
        case .people: return "People"
        case .places: return "Places"
        case .memories: return "Memories"
        case .duplicates: return "Duplicates"
        case .unspecified, .UNRECOGNIZED: return ""
        }
    }
}

