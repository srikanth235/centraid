import Foundation
import SwiftProtobuf
import SwiftUI

/// A PHOTO SHELF: the library under a predicate, in SwiftUI (#1029, photos port).
///
/// One view for four of v0's routes — `PhotoStateView` (favourites, archive,
/// trash, videos, one person), `AlbumDetail`, `PlaceDetail` and a memory's
/// members. They were four screens reading one table in one order and drawing
/// one cell, and they drifted exactly where four copies drift: only
/// `AlbumDetail.tsx` had a selection mode, only `PlaceDetail.tsx` had its own
/// empty sentence, and only the trash could say how long a photograph had left.
/// Here the shelf is a parameter and all four have all three.
struct PhotoShelfView: View {
    @Environment(\.colorScheme) private var scheme

    /// The encoded `PhotoShelfState` the bridge published.
    ///
    /// Bytes and not an object, for `PhotosBridge`'s reason: one schema, one
    /// fixture, no Objective-C bridging layer between the two shells.
    let data: Data

    /// WHICH LIBRARY THIS IS, from the route.
    ///
    /// The view holds it because the view is what sends `Opened`, and `Opened`
    /// carries the shelf: a read cannot be asked for until the predicate is
    /// known, and the predicate is a navigation parameter
    /// (`nav/Navigation.kt`, `Destination.PhotoShelfRoute`).
    let shelf: Centraid_Screen_V1_PhotoShelf

    /// THE SHELF'S OWN WORDS, from `PhotoShelfMachine` by way of
    /// `PhotoShelfBridge.sentences()`.
    ///
    /// Not derived here, and the reason is in the bridge's own comment: the
    /// machine's `emptySentence` takes Wire's `PhotoShelf` and this side holds
    /// SwiftProtobuf's, which are two types generated from one `.proto`. So the
    /// derivation stays in one place and its ANSWER crosses. A Swift table of
    /// per-shelf sentences beside the Kotlin one is how the two shells start
    /// saying different things about an empty archive.
    let copy: PhotoShelfCopy

    /// One encoded `PhotoShelfEvent`, back to the bridge.
    let send: (Data) -> Void

    /// OPEN ONE PHOTOGRAPH, AS NAVIGATION AND NOT AS AN EVENT.
    ///
    /// `PhotoShelfEvent` has no "cell tapped" arm, which is right: the shelf's
    /// own state does not change when a member walks into the lightbox. The
    /// neighbours are this shelf's order, so a swipe there needs no read.
    var onOpenAsset: (_ assetIdentifier: String, _ neighbours: [String]) -> Void = { _, _ in }
    /// ADD PHOTOGRAPHS TO THIS ALBUM — the picker's only door.
    ///
    /// `photos.picker` was wired, correct and **unreachable**: nothing on
    /// either shell pushed it, so a member could make an album and never put
    /// anything in it. An album is the one shelf this belongs on — the
    /// standing four are predicates over the library and have nothing to add
    /// to — which is why the shelf offers it and Collections does not.
    var onAddPhotographs: (_ collectionIdentifier: String, _ name: String) -> Void = { _, _ in }
    /// "SEND A COPY" AND "DOWNLOAD ORIGINAL" — the platform's, not the vault's.
    ///
    /// Neither writes anything, so neither is an event: the shell finds the
    /// originals, hands them to the share sheet or the photo library
    /// (`ShelfCopyExport.swift`), and reports back into `export_notice`.
    var onExport: (_ assetIdentifiers: [String], _ kind: ShelfCopyExport.Kind) -> Void = { _, _ in }

    @Environment(\.dismiss) private var dismiss
    @State private var confirmingPurge = false
    @State private var confirmingEmptyTrash = false
    @State private var confirmingAlbumDelete = false
    @State private var choosingPlace = false
    @State private var renaming = false
    @State private var draftName = ""

    private var state: PhotoShelfStateView { PhotoShelfStateView(data: data) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header

                // "KEEP ORIGINALS ON THIS PHONE" — an album's, and only an
                // album's (`KeepOriginals.opened`).
                if state.keepOriginals.offered {
                    KeepOriginalsRowView(row: state.keepOriginals) { send(state.keepOriginalsEvent($0)) }
                }

                // THE TRASH SAYS WHAT THE RULE IS, and it is the only shelf
                // that does. A WINDOW and not a countdown: `purge_window_days`
                // is 0 on every other shelf, so `copy.purgeWindow` is empty
                // there. `PhotoShelfBridge.sentences()` reads it off that
                // field, so this draws what the state says. v0's trash said the
                // same thing — "purged 30 days after deletion".
                if !copy.purgeWindow.isEmpty {
                    Text(copy.purgeWindow)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }

                // A WRITE WAS REFUSED, AND IT DOES NOT TAKE THE SHELF WITH IT.
                //
                // Drawn ABOVE the cells and outside the `content` switch, which
                // is the whole reason `write_failure` is its own field: a
                // denied delete rendered through the read's `failure` would
                // replace a shelf full of photographs with an error message,
                // and a member would lose the very selection they were deleting
                // from. `NoteDraft.save_failure` is the same field for the same
                // reason — a failed save does not replace the editor.
                if let refusal = state.writeFailure {
                    ScreenFailureView(sentence: refusal.sentence, remedy: refusal.remedy)
                        .accessibilityIdentifier("photos.shelf.writeFailure")
                }

                // WHAT A COPY CAME TO — one clause, from the shell, and gone
                // with the next verb. Not a refusal: nothing was written.
                if !state.exportNotice.isEmpty {
                    Text(state.exportNotice)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .accessibilityIdentifier("photos.shelf.exportNotice")
                }

                switch state.content {
                case .loading:
                    ProgressView()
                case let .denied(denied):
                    DeniedGate(denied)
                case let .failure(sentence, remedy):
                    ScreenFailureView(sentence: sentence, remedy: remedy)
                case let .data(cells, packAbsent):
                    if cells.isEmpty {
                        // NOTHING HERE, AND WHY — the sentence is this shelf's
                        // and never a generic one. An empty archive and an
                        // empty place are different answers to different
                        // questions.
                        ScreenEmptyView(sentence: copy.empty, remedy: copy.emptyRemedy)
                    } else {
                        // ONE CELL RENDERER, SHARED WITH EVERY OTHER PHOTOS
                        // SURFACE (`PhotoCells.swift`). Held state, the two
                        // empty-cell sentences and the download arrow all
                        // arrive with it rather than being remembered here.
                        PhotoCellsGrid(
                            cells: cells,
                            packAbsent: packAbsent,
                            selected: state.selected,
                            onTap: { identifier in
                                if state.selecting {
                                    send(state.selectionEvent(assetIdentifier: identifier))
                                } else {
                                    onOpenAsset(identifier, cells.map(\.assetID))
                                }
                            }
                        )
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
        .navigationTitle(copy.title)
        .toolbar {
            // ONLY AN ALBUM CAN BE ADDED TO. A `PhotoShelf` is a oneof, so
            // this is a case check and not a flag: favourites, archive, trash,
            // videos, a place, a person and a memory are all predicates over
            // photographs that are already in the vault, and "add" means
            // nothing on any of them.
            if case let .album(album) = shelf.of {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        onAddPhotographs(album.collectionID, copy.title)
                    } label: {
                        CentraidIconView(iconKey: "add", tint: Theme.color("link", scheme), size: 20)
                    }
                    .accessibilityLabel("Add photographs")
                    .accessibilityIdentifier("photos.shelf.add")
                }
                // THE ALBUM'S OWN VERBS, behind one control: the system's
                // album menu. Rename and Delete are about the grouping, never
                // about a photograph in it.
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Rename album") {
                            draftName = copy.title
                            renaming = true
                        }
                        .accessibilityIdentifier("photos.shelf.rename")
                        Button("Delete album", role: .destructive) { confirmingAlbumDelete = true }
                            .accessibilityIdentifier("photos.shelf.deleteAlbum")
                    } label: {
                        CentraidIconView(iconKey: "MoreHoriz", tint: Theme.color("link", scheme), size: 20)
                    }
                    .accessibilityLabel("Album options")
                    .accessibilityIdentifier("photos.shelf.albumMenu")
                }
            }
        }
        // THE BAR IS THE MODE, and it is absent when there is no mode. v0
        // passed its selection bar unconditionally and the screen sat
        // permanently in the mode — the header read "Choose photographs" and
        // the band sat dimmed before a single photograph had been picked
        // (R-A-14).
        .safeAreaInset(edge: .bottom) {
            if state.selecting { selectionBar }
        }
        .confirmationDialog(
            // THE OWNER'S CONFIRMATION IS THE SCREEN'S, deliberately.
            // `media.purge_asset` is `confirm: false` in the registry and its
            // comment says why: a command-level confirm would ALSO park the
            // member's own act. So the safety is here, in front of the write.
            purgeQuestion,
            isPresented: $confirmingPurge,
            titleVisibility: .visible
        ) {
            Button("Delete \(state.selected.count) forever", role: .destructive) {
                send(state.deleteEvent(permanent: true))
            }
            Button("Keep them", role: .cancel) {}
        } message: {
            Text(
                "This cannot be undone. They leave your library now — with their captions, "
                    + "faces, tags and album membership — and the space they hold is freed "
                    + "shortly afterwards. Restore will not bring them back."
            )
        }
        .confirmationDialog(
            "Delete everything in the trash forever?",
            isPresented: $confirmingEmptyTrash,
            titleVisibility: .visible
        ) {
            Button("Empty trash", role: .destructive) { send(state.emptyTrashEvent) }
            Button("Keep them", role: .cancel) {}
        } message: {
            Text(
                "This cannot be undone. Every photograph in the trash leaves your library now — "
                    + "with its captions, faces and tags — and the space it holds is freed shortly "
                    + "afterwards."
            )
        }
        .confirmationDialog(
            "Delete this album?",
            isPresented: $confirmingAlbumDelete,
            titleVisibility: .visible
        ) {
            Button("Delete album", role: .destructive) { send(state.albumDeleteEvent) }
            Button("Keep it", role: .cancel) {}
        } message: {
            // v0's `ALBUM_DELETE_BODY`, the one thing a member deciding needs.
            Text("Photos stay in the library.")
        }
        // HOW MUCH OF THE PLACE TRAVELS, asked every time (#816). Two answers
        // for a batch: a place NAME is one sentence per photograph, and a
        // batch has as many places as photographs.
        .confirmationDialog(
            "Send a copy — how much of the place?",
            isPresented: $choosingPlace,
            titleVisibility: .visible
        ) {
            Button("No location") { onExport(Array(state.selected), .send(keepLocation: false)) }
            Button("Exact location") { onExport(Array(state.selected), .send(keepLocation: true)) }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Rename album", isPresented: $renaming) {
            TextField("Album name", text: $draftName)
                .accessibilityIdentifier("photos.shelf.albumName")
            Button("Save") { send(state.renameEvent(draftName)) }
                .disabled(draftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        }
        // "ADD TO ALBUM" — the shared sheet. `isPresented` is the state's, so a
        // swipe-down reaches the reducer rather than leaving it saying "open".
        .sheet(
            isPresented: Binding(
                get: { state.albumChoiceOpen },
                set: { open in if !open, state.albumChoiceOpen { send(state.albumChoiceDismissedEvent) } }
            )
        ) {
            AlbumChoiceSheet(
                choices: state.albumChoices,
                onChoose: { send(state.albumChosenEvent($0)) },
                onNewAlbum: { send(state.albumCreatedEvent($0)) },
                onCancel: { send(state.albumChoiceDismissedEvent) }
            )
        }
        // THE ALBUM IS GONE — its delete committed — so the shelf showing it
        // leaves. What it would otherwise offer is Add and Rename against a
        // row the vault now refuses on `album_exists`.
        .onChange(of: state.albumGone) { _, gone in
            if gone { dismiss() }
        }
        .onAppear { send(state.openedEvent(shelf: shelf)) }
    }

    /// Is this the favourites shelf? Read off the route's own oneof: there the
    /// heart UNstars, because everything on it is starred.
    private var isFavorites: Bool {
        guard case let .stateView(view) = shelf.of, case let .mode(mode) = view.view else { return false }
        return mode.kind == .favorites
    }

    private var isAlbum: Bool {
        if case .album = shelf.of { return true }
        return false
    }

    /// The count, and the way into and out of selection.
    ///
    /// The count is the PAGE's and says so. There is no `COUNT(*)` on this
    /// door, so a shelf longer than one page has read a floor and not a total —
    /// and a bare "412 photographs" over a truncated page would be a number the
    /// screen made up.
    private var header: some View {
        HStack {
            Text(state.countSentence)
                .centraidType("control")
                .foregroundStyle(Theme.color("textSoft", scheme))
            Spacer()
            if state.selecting {
                Button("Done") { send(state.selectionModeEvent(selecting: false)) }
                    .accessibilityIdentifier("photos.shelf.done")
            } else if state.hasCells {
                // EMPTY TRASH, only on the trash, beside the way into
                // selection. A text control and never a filled one: the
                // safety is the confirm behind it.
                if copy.isTrash {
                    Button("Empty trash") { confirmingEmptyTrash = true }
                        .foregroundStyle(Theme.color("danger", scheme))
                        .accessibilityIdentifier("photos.shelf.emptyTrash")
                }
                Button("Select") { send(state.selectionModeEvent(selecting: true)) }
                    .accessibilityIdentifier("photos.shelf.select")
            }
        }
    }

    /// THE VERBS A SHELF HAS OVER ITS SELECTION, and which depends on the shelf.
    ///
    /// The trash has two — Restore and Delete forever — which is v0's rule
    /// (`PhotoStateView.tsx`: "Trash swaps the fifth target for Restore"): a
    /// trashed photograph cannot be starred, filed or sent until it is back.
    /// Every other shelf has the system's row — Send a copy, the heart, Add to
    /// album, Archive, Trash — and the rest behind one menu. The archive's
    /// Archive is an UN-ARCHIVE — the machine sends
    /// `media.update_asset` for it rather than `restore_asset`, because an
    /// archived photograph was never in the trash and the command's own
    /// precondition would refuse it.
    private var selectionBar: some View {
        HStack(spacing: 14) {
            if copy.isTrash {
                verb(icon: "restore", label: "Restore", identifier: "photos.shelf.restore") {
                    send(state.restoreEvent)
                }
                verb(icon: "trash", label: "Delete forever", identifier: "photos.shelf.purge") {
                    confirmingPurge = true
                }
            } else {
                verb(icon: "share", label: "Send a copy", identifier: "photos.shelf.send") {
                    choosingPlace = true
                }
                // THE HEART STARS — and UNstars on the favourites shelf, where
                // everything is already starred. The other direction is in the
                // menu, because a cell does not carry its star.
                verb(
                    icon: "heart",
                    label: isFavorites ? "Unfavorite" : "Favorite",
                    identifier: "photos.shelf.favorite"
                ) { send(state.favoriteEvent(!isFavorites)) }
                verb(icon: "album", label: "Add to album", identifier: "photos.shelf.addToAlbum") {
                    send(state.albumChoiceOpenedEvent)
                }
                if copy.isArchive {
                    verb(icon: "restore", label: "Unarchive", identifier: "photos.shelf.restore") {
                        send(state.restoreEvent)
                    }
                } else {
                    verb(icon: "Archive", label: "Archive", identifier: "photos.shelf.archive") {
                        send(state.archiveEvent(archived: true))
                    }
                }
                verb(icon: "trash", label: "Trash", identifier: "photos.shelf.trash") {
                    send(state.deleteEvent(permanent: false))
                }
                moreMenu
            }

            Spacer()
            Text("\(state.selected.count) chosen")
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 10)
        .background(.thinMaterial)
    }

    /// THE REST OF THE VERBS — the ones a member reaches for less, and the
    /// album's own: "Make key photo" wants exactly one photograph, and
    /// "Remove from album" takes the reference and never the photograph.
    private var moreMenu: some View {
        Menu {
            Button("Download original") { onExport(Array(state.selected), .save) }
                .accessibilityIdentifier("photos.shelf.download")
            if !isFavorites {
                Button("Unfavorite") { send(state.favoriteEvent(false)) }
                    .accessibilityIdentifier("photos.shelf.unfavorite")
            }
            if isAlbum {
                Button("Make key photo") {
                    if let only = state.selected.first { send(state.coverEvent(only)) }
                }
                .disabled(state.selected.count != 1)
                .accessibilityIdentifier("photos.shelf.cover")
                Button("Remove from album") { send(state.removeFromAlbumEvent) }
                    .accessibilityIdentifier("photos.shelf.removeFromAlbum")
            }
        } label: {
            CentraidIconView(
                iconKey: "MoreHoriz",
                tint: Theme.color(state.selected.isEmpty ? "textDisabled" : "text", scheme),
                size: 22
            )
        }
        .disabled(state.selected.isEmpty)
        .accessibilityLabel("More")
        .accessibilityIdentifier("photos.shelf.more")
    }

    /// One verb, and it is disabled with nothing picked rather than hidden: a
    /// bar whose controls come and go as a member picks is a bar that moves
    /// under their thumb.
    private func verb(
        icon: String,
        label: String,
        identifier: String,
        run: @escaping () -> Void
    ) -> some View {
        Button(action: run) {
            // THE ICON KEY IS ONE THE CATALOG HAS. `CentraidIconView` falls
            // back to `?? []` and an unknown key draws NOTHING, silently —
            // which is what made the More tab render as a dash. SF Symbols are
            // deliberately not used here: a second icon set is a second
            // product.
            CentraidIconView(
                iconKey: icon,
                tint: Theme.color(state.selected.isEmpty ? "textDisabled" : "text", scheme),
                size: 22
            )
        }
        .disabled(state.selected.isEmpty)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    private var purgeQuestion: String {
        let count = state.selected.count
        return count == 1
            ? "Delete 1 photograph forever?"
            : "Delete \(count) photographs forever?"
    }
}

/// The six things a shelf says about itself, from `PhotoShelfBridge.sentences()`.
///
/// A struct rather than five parameters so the shell's wiring is one value, and
/// so that adding a seventh sentence is a change in the machine and in this
/// struct rather than in every call site.
struct PhotoShelfCopy {
    let title: String
    let empty: String
    let emptyRemedy: String
    /// Empty on every shelf but the trash. See `PhotoShelfMachine`.
    let purgeWindow: String
    let isTrash: Bool
    let isArchive: Bool

    /// What a shelf opened without its parameter says, and what a preview uses.
    static let unknown = PhotoShelfCopy(
        title: "Photographs",
        empty: "This shelf was opened without saying which photographs it is.",
        emptyRemedy: "",
        purgeWindow: "",
        isTrash: false,
        isArchive: false
    )
}

/// The thin decoder between the shelf's bytes and its view.
///
/// Its own struct in its own file rather than an addition to `StateViews.swift`:
/// that file is shared by every lane of this port and a tenth screen appended
/// to it is a tenth chance for two lanes to collide in one place.
///
/// **A DECODE THAT FAILS RENDERS THE INITIAL STATE, NOT AN EMPTY ONE.** Every
/// screen's initial state is `loading`, which is the honest thing to draw when
/// the bytes have not arrived — an empty `.data` case in its place would be a
/// screen claiming an empty shelf before it had read one.
struct PhotoShelfStateView {
    let data: Data

    private var state: Centraid_Screen_V1_PhotoShelfState {
        (try? Centraid_Screen_V1_PhotoShelfState(serializedBytes: data)) ?? .init()
    }

    /// The cells, AS THE WIRE HOLDS THEM, and whether this device has a
    /// thumbnail pack at all. No per-cell struct in between: `PhotoCellsGrid`
    /// renders `Centraid_Screen_V1_PhotoCell` directly.
    var content: ScreenContent<([Centraid_Screen_V1_PhotoCell], Bool)> {
        switch state.content {
        case let .failure(failure):
            return .failure(failure.sentence, failure.remedy)
        case let .data(data):
            return .data((data.cells, data.thumbnailPackAbsent))
        case let .loading(loading):
            return .loading(loading.firstLoad)
        // `loading`, and the `nil` a message with no content set decodes to,
        // are the SAME screen — a state that has not read yet. Collapsing them
        // into `.data([])` is the fourth state the read law forbids.
        case .none:
            return .loading(true)
        }
    }

    /// THE PICK IS THE STATE'S, NOT THE CELL'S. A selection over a cell the
    /// page has not loaded yet still has to survive until it arrives, which is
    /// why it is a field on the message and not a flag on a row.
    var selected: Set<String> { Set(state.selectedAssetIds) }

    var selecting: Bool { state.selecting }

    /// A WRITE WAS REFUSED, AND THE SENTENCE A MEMBER READS.
    ///
    /// Its own slot and never the `content` oneof's `failure`: that one is the
    /// READ's, and a denied write drawn through it would take the rows off the
    /// screen. Absent when nothing was refused, which is the ordinary case.
    var writeFailure: Centraid_Screen_V1_ReadFailure? {
        state.hasWriteFailure ? state.writeFailure : nil
    }

    var hasCells: Bool {
        if case let .data(cells, _) = content { return !cells.isEmpty }
        return false
    }

    /// A FLOOR, AND IT SAYS SO WHEN IT IS ONE.
    ///
    /// There is no `COUNT(*)` on the page door, so what this screen knows is
    /// how many rows came back. When a next cursor exists the page was full and
    /// the shelf is longer than what was read; "at least" is the difference
    /// between a count and a claim.
    var countSentence: String {
        guard case let .data(cells, _) = content else { return "" }
        let noun = cells.count == 1 ? "photograph" : "photographs"
        return state.data.hasNextCursor
            ? "At least \(cells.count) \(noun)"
            : "\(cells.count) \(noun)"
    }

    /// A screen reads because it was OPENED, and the shelf rides the open.
    func openedEvent(shelf: Centraid_Screen_V1_PhotoShelf) -> Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.opened = .with { $0.shelf = shelf }
        return event.encodedShelfEvent
    }

    func selectionEvent(assetIdentifier: String) -> Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.selection = .with { $0.assetID = assetIdentifier }
        return event.encodedShelfEvent
    }

    func selectionModeEvent(selecting: Bool) -> Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.selectionMode = .with { $0.selecting = selecting }
        return event.encodedShelfEvent
    }

    var restoreEvent: Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.restore = .init()
        return event.encodedShelfEvent
    }

    /// `permanent` IS THE SCREEN'S WORD, not an inference off the shelf. The
    /// two are one tap apart and only one of them is reversible, so the surface
    /// that asked has to have said so — which is why the confirmation sits in
    /// front of this call and not inside the reducer.
    func deleteEvent(permanent: Bool) -> Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.delete = .with { $0.permanent = permanent }
        return event.encodedShelfEvent
    }

    func archiveEvent(archived: Bool) -> Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.archive = .with { $0.archived = archived }
        return event.encodedShelfEvent
    }

    var albumChoiceOpen: Bool { state.albumChoiceOpen }
    var albumChoices: [Centraid_Screen_V1_AlbumChoiceEntry] { state.albumChoices }
    var albumGone: Bool { state.albumGone }
    var exportNotice: String { state.exportNotice }

    /// The album's keep switch, as the reducer last settled it.
    var keepOriginals: Centraid_Screen_V1_KeepOriginalsRow { state.keepOriginals }

    func keepOriginalsEvent(_ keep: Bool) -> Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.keepOriginalsToggled = .with { $0.keep = keep }
        return event.encodedShelfEvent
    }

    func favoriteEvent(_ favorite: Bool) -> Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.favorite = .with { $0.favorite = favorite }
        return event.encodedShelfEvent
    }

    var albumChoiceOpenedEvent: Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.albumChoiceOpened = .init()
        return event.encodedShelfEvent
    }

    var albumChoiceDismissedEvent: Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.albumChoiceDismissed = .init()
        return event.encodedShelfEvent
    }

    func albumChosenEvent(_ albumIdentifier: String) -> Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.albumChosen = .with { $0.albumID = albumIdentifier }
        return event.encodedShelfEvent
    }

    func albumCreatedEvent(_ title: String) -> Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.albumChoiceCreated = .with { $0.title = title }
        return event.encodedShelfEvent
    }

    func renameEvent(_ title: String) -> Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.albumRenamed = .with { $0.title = title }
        return event.encodedShelfEvent
    }

    var albumDeleteEvent: Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.albumDelete = .init()
        return event.encodedShelfEvent
    }

    func coverEvent(_ assetIdentifier: String) -> Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.cover = .with { $0.assetID = assetIdentifier }
        return event.encodedShelfEvent
    }

    var removeFromAlbumEvent: Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.removeFromAlbum = .init()
        return event.encodedShelfEvent
    }

    var emptyTrashEvent: Data {
        var event = Centraid_Screen_V1_PhotoShelfEvent()
        event.emptyTrash = .init()
        return event.encodedShelfEvent
    }
}

private extension SwiftProtobuf.Message {
    /// The bytes that cross back into `CentraidShared`.
    ///
    /// A serialisation that throws yields EMPTY bytes rather than a crash, and
    /// the shared module decodes those as a message with no `kind` set, which
    /// every reducer's `else` branch already answers with `Step(state)` — a tap
    /// that does nothing rather than a shell that dies on one.
    ///
    /// Spelled `encodedShelfEvent` because `StateViews.swift` already declares
    /// a `private` `encoded` on this protocol: a `private extension` is file
    /// scoped, so a second `encoded` here would compile and then be ambiguous
    /// for any file that saw both.
    var encodedShelfEvent: Data { (try? serializedData()) ?? Data() }
}

/// "KEEP ORIGINALS ON THIS PHONE" (#1029, photos port — v0's
/// `AlbumDetail.tsx` keep row).
///
/// A switch that says what it does underneath it. The line is the reducer's
/// (`KeepOriginals.meta`), derived from the switch, so it never states a fact
/// the switch contradicts; until the keep list answers for this album the
/// switch is disabled and the line says it is checking, because a claim about
/// what freeing space would take is not one to guess at.
///
/// **It holds still while a change is on its way.** The flip shows at once
/// and the list's answer is what settles it; a second flip before that would
/// be a race the member could not see.
private struct KeepOriginalsRowView: View {
    @Environment(\.colorScheme) private var scheme
    let row: Centraid_Screen_V1_KeepOriginalsRow
    let onToggle: (Bool) -> Void

    var body: some View {
        Toggle(isOn: Binding(get: { row.keep }, set: { onToggle($0) })) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Keep originals on this phone")
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                Text(row.meta)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
        }
        .tint(Theme.color("accent", scheme))
        .disabled(!row.ready || row.saving)
        .accessibilityLabel("Keep this album's originals on this phone")
        .accessibilityHint(row.meta)
        .accessibilityIdentifier("photos.shelf.keepOriginals")
    }
}
