import SwiftUI

import CentraidShared

/// The Photos grid, in SwiftUI (#1020, D-1020-E3).
///
/// Two planes on one screen: the GRID renders the vault's assets, the BACKUP
/// banner renders the camera roll's permission and progress. A denied photo
/// grant changes the banner and never the grid — which on iOS is the difference
/// between a member seeing their library and a member seeing an empty screen
/// with a Settings link.
///
/// `PHAuthorizationStatusLimited` is a first-class state here, not a degraded
/// denial: the banner says "the photos you selected".
struct PhotosGridView: View {
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme
    @State private var beforeSearch: Centraid_Screen_V1_PhotosGridState.Destination = .library
    /// The library's width, for packing justified rows — the one layout fact
    /// the machine cannot know.
    @State private var width: CGFloat = 0
    /// The row at the top of the library, as `scrollPosition` reports it —
    /// what a grain switch lands on and what the scrub rail moves.
    @State private var scrolledID: String?
    /// "Send a copy" is asking how much of the place travels — a question
    /// about this press, not the vault, so it is the view's (the shelf's too).
    @State private var choosingPlace = false

    var state: PhotosGridStateView { PhotosGridStateView(data: shell.photosState) }

    /// THE WIRE STATE, for the library's own fields. `PhotosGridStateView`
    /// keeps its decode private and answers the band and backup questions;
    /// the library reads the rest straight off the message.
    private var grid: Centraid_Screen_V1_PhotosGridState {
        (try? Centraid_Screen_V1_PhotosGridState(serializedBytes: shell.photosState)) ?? .init()
    }

    private var isLibrary: Bool {
        switch state.destination {
        case .library, .unspecified, .UNRECOGNIZED: return true
        case .collections, .search: return false
        }
    }

    var body: some View {
        let grid = self.grid
        let cells = grid.data.cells
        let rows = isLibrary && grid.grain == .all && width > 0
            ? LibraryLayout.rows(cells, width: width, rung: Int(grid.rung))
            : []
        // AN APP'S ROOT, LIKE EVERY OTHER APP'S (R-CHROME-1…5): "Photos" with
        // ONE trailing action — Select on the library (the app with nothing to
        // create), New album on Collections — the search bar under it, the
        // library's filter chips, the body, and the band at the foot. Every
        // word and every chip is the machine's (`grid.chrome`, `grid.chips`,
        // `grid.band`).
        AppPlace(
            app: "photos",
            title: isLibrary && grid.selecting ? selectionTitle(grid.selected.count) : grid.chrome.title,
            trailing: trailingAction(grid: grid, hasCells: !cells.isEmpty),
            search: searchSlot(grid: grid),
            chips: filterChips(grid: grid),
            band: { foot(grid: grid, cells: cells) },
            content: { scroller(grid: grid, rows: rows, cells: cells) }
        )
        // WHERE THE SEARCH BAR'S CLOSE RETURNS TO. Held here because the state
        // carries only the destination on screen, and "the one before" is the
        // back-of-the-hand memory a close control needs — a fact about this
        // visit, not about the vault, so nothing reads it but the close.
        .onChange(of: state.destination) { previous, next in
            guard next == .search, previous != .search else { return }
            beforeSearch = previous == .unspecified ? .library : previous
        }
        // LAND WHERE THE MACHINE SAYS THE MEMBER IS — a grain switch or a card
        // names a day, and the list moves to it once.
        .onChange(of: grid.placeDay) { _, day in land(on: day, grid: grid, rows: rows) }
        .onChange(of: grid.grain) { _, _ in land(on: grid.placeDay, grid: grid, rows: rows) }
        // THE SELECTION'S TWO SHEETS: the album choice (one sheet for every
        // "Add to album") and the trash confirm.
        .sheet(isPresented: albumBinding(grid)) {
            AlbumChoiceSheet(
                choices: grid.albumChoices,
                onChoose: { shell.send(screen: PhotosScreens.grid, event: LibraryEvents.albumChosen($0)) },
                onNewAlbum: { shell.send(screen: PhotosScreens.grid, event: LibraryEvents.albumCreated($0)) },
                onCancel: { shell.send(screen: PhotosScreens.grid, event: LibraryEvents.albumDismissed()) }
            )
        }
        .sheet(isPresented: sheetBinding(.confirmTrash)) {
            ConfirmSheet(
                Centraid_Screen_V1_Confirm.with {
                    $0.title = LibraryTrashCopy.question(grid.selected.count)
                    $0.body = LibraryTrashCopy.body
                    $0.confirmLabel = PhotosCopy.shared.PHOTOS_GRID_TRASH_CONFIRM
                    $0.destructive = true
                },
                cancelLabel: PhotosCopy.shared.PHOTOS_KEEP_THEM,
                onConfirm: { shell.send(screen: PhotosScreens.grid, event: LibraryEvents.trashConfirmed()) },
                onDismiss: { shell.send(screen: PhotosScreens.grid, event: state.sheetEvent(.none)) }
            )
        }
        // HOW MUCH OF THE PLACE TRAVELS, asked every time (#816) — the shelf's
        // two answers, for the shelf's reason: a place NAME is one sentence per
        // photograph, and a batch has as many places as photographs.
        .sheet(isPresented: $choosingPlace) {
            OptionSheet(title: PhotosCopy.shared.PHOTOS_SEND_PLACE_TITLE) {
                SheetRow(label: PhotosCopy.shared.PHOTOS_SEND_NO_LOCATION) {
                    choosingPlace = false
                    shell.exportLibrary(grid.selected, keepLocation: false)
                }
                SheetRow(label: PhotosCopy.shared.PHOTOS_SEND_EXACT_LOCATION) {
                    choosingPlace = false
                    shell.exportLibrary(grid.selected, keepLocation: true)
                }
            }
            .presentationDetents([.height(220)])
        }
        // WHICH SHEET IS OPEN IS STATE, and this is what reads it. The `···`
        // moved `state.sheet` and nothing drew anything, so the control
        // reduced correctly and did nothing a member could see. `isPresented`
        // is derived from the state rather than held here, because a sheet
        // that had its own `@State` would be a second place the answer lives.
        .sheet(isPresented: sheetBinding(.more)) {
            PhotosMoreSheet(shell: shell, state: state)
        }
        .sheet(isPresented: sheetBinding(.backupDetail)) {
            PhotosBackupDetailSheet(shell: shell, state: state)
        }
        // THE TILE SIZES, a choice opened from More's "Tile size" row — the
        // header lost its menu (R-CHROME-3). Picking one closes it (the
        // machine's `RungChanged`).
        .sheet(isPresented: sheetBinding(.tileSize)) {
            OptionSheet(title: grid.chrome.tileSizeLabel) {
                ForEach(Array(grid.chrome.tileSizes.enumerated()), id: \.offset) { rung, label in
                    SheetRow(
                        label: label,
                        selected: rung == Int(grid.rung),
                        identifier: "photos.tileSize.\(rung)"
                    ) { shell.send(screen: PhotosScreens.grid, event: LibraryEvents.rung(rung)) }
                }
            }
            .presentationDetents([.medium])
        }
    }

    /// THE BODY, IN ITS SCROLL VIEW (R-PHOTOS-2, #1025).
    ///
    /// The scroll view is what makes the inset correct: SwiftUI insets
    /// scrollable content below the bar itself, and a screen that adds its own
    /// offset on top of that is the compensation R-PHOTOS-2 set out to delete.
    @ViewBuilder
    private func scroller(
        grid: Centraid_Screen_V1_PhotosGridState,
        rows: [LibraryRow],
        cells: [Centraid_Screen_V1_PhotoCell]
    ) -> some View {
        ScrollView {
            // WHICH BAND IS SHOWING IS A PARAMETER, SO THE BODY SWITCHES HERE
            // (law 2). Collections and Search are not routes — a push per band
            // would make "which band am I in" a second piece of state and put
            // the bands a member tapped into the back stack.
            switch state.destination {
            case .collections:
                VStack(alignment: .leading) {
                    PhotosCollectionsView(
                        data: shell.photosCollectionsState,
                        showAllLabel: grid.chrome.showAllLabel,
                        collapseAllLabel: grid.chrome.collapseAllLabel,
                        send: { shell.send(screen: PhotosScreens.collections, event: $0) },
                        onOpenShelf: { shelf in
                            shell.path.append(
                                .photoShelf((try? shelf.serializedData()) ?? Data())
                            )
                        },
                        onOpenDoor: { kind in
                            switch kind {
                            case .places: shell.path.append(.places)
                            case .memories: shell.path.append(.photosMemories)
                            case .duplicates: shell.path.append(.photoDuplicates)
                            case .unspecified, .UNRECOGNIZED: break
                            }
                        }
                    )
                }
                // THE PAGE MARGIN, per band: the library is full-bleed (v0 —
                // only its headers keep the margin), so the margin that used to
                // sit on the whole scroll view now sits on the bodies that
                // want it.
                .padding(.horizontal, CentraidGeometry.pageMargin)

            case .search:
                VStack(alignment: .leading) {
                    PhotosSearchView(
                        data: shell.photosSearchState,
                        send: { shell.send(screen: PhotosScreens.search, event: $0) },
                        onOpenAsset: { identifier in
                            shell.path.append(.photoLightbox(identifier, []))
                        },
                        onOpenShelf: { shelf in shell.path.append(.photoShelf(shelf)) }
                    )
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)

            case .library, .unspecified, .UNRECOGNIZED:
                libraryBody(grid: grid, rows: rows)
            }
        }
        // WHERE THE LIBRARY IS, both ways: read as the member scrolls, and set
        // to land a grain switch or to follow the scrub rail.
        .scrollPosition(id: $scrolledID, anchor: .top)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        // THE SCRUB RAIL, on the trailing edge of the All grain.
        .overlay(alignment: .topTrailing) {
            if isLibrary, grid.grain == .all, !grid.selecting, rows.count >= LibraryMetrics.railMinimumRows {
                LibraryScrubRail(rows: rows, position: $scrolledID)
            }
        }
        // A PINCH IS A STEPPER PRESS, NOT A CONTINUOUS ZOOM (v0 §4.2), and past
        // the table's ends it moves the grain — the machine's table,
        // `PhotosTimeline.pinch`, asked in `pinched`.
        .simultaneousGesture(
            MagnifyGesture().onEnded { value in pinched(grid: grid, scale: value.magnification) },
            including: isLibrary && !cells.isEmpty ? .all : .subviews
        )
        // A SCROLL THROUGH THE HITS PUTS THE KEYBOARD AWAY, as the system's
        // search does: the member has stopped typing and started looking.
        .scrollDismissesKeyboard(.immediately)
        // A BAND BODY READS BECAUSE IT WAS OPENED, and `.task(id:)` is what
        // tells it: the id is the destination, so switching bands re-runs and
        // an ordinary recomposition does not. The library needs none — its
        // `Opened` comes with the route, through `ShellModel.opened`.
        .task(id: state.destination) { shell.openedPhotosBand(state.destination) }
    }

    /// THE FOOT, in `AppPlace`'s band slot: the band, or what stands in its
    /// place. The content ends above it BY LAYOUT (v0's rule), so the last row
    /// of photographs scrolls clear of it instead of sitting underneath.
    @ViewBuilder
    private func foot(grid: Centraid_Screen_V1_PhotosGridState, cells: [Centraid_Screen_V1_PhotoCell]) -> some View {
        // SEARCH IS THE FIELD UNDER THE TITLE (R-CHROME-2), so the band
        // stays: the member can leave for another place without closing it.
        if isLibrary, grid.selecting {
            // A SELECTION TAKES THE BAND'S PLACE (Apple Photos; v0's room), so
            // a tap aimed at Trash cannot land on a destination.
            LibrarySelectionBar(
                grid: grid,
                send: { shell.send(screen: PhotosScreens.grid, event: $0) },
                onSendCopy: { choosingPlace = true }
            )
        } else {
            VStack(spacing: 0) {
                // YEARS · MONTHS · ALL, PERMANENT while the library has
                // photographs (v0) — above the band, never on a timer.
                if isLibrary, !cells.isEmpty {
                    LibraryGrainControl(grain: grid.grain) { next in
                        shell.send(
                            screen: PhotosScreens.grid,
                            event: LibraryEvents.grain(next, at: LibraryLayout.day(forID: scrolledID, cells: cells))
                        )
                    }
                }
                // PLACES, THEN MORE — an ordinary tab of the band, whose event
                // opens the sheet (`more` is a sheet, never a destination).
                AppBand(
                    app: "photos",
                    tabs: state.bands,
                    onSelect: { shell.send(screen: PhotosScreens.grid, event: $0) },
                    onHome: { shell.path.removeAll() }
                )
            }
        }
    }

    /// THE LIBRARY BAND'S OWN BODY (#1029, photos port — v0's `PhotosHome` and
    /// `PhotosLibraryBody`): a justified timeline under pinned months, or a
    /// grain's cards, paged through the whole library as the member scrolls.
    ///
    /// One `LazyVStack` and the scroll view's target layout, so
    /// `scrollPosition` can say which row is at the top and move there. The
    /// backup banner is its first child and scrolls with the photographs.
    @ViewBuilder
    private func libraryBody(grid: Centraid_Screen_V1_PhotosGridState, rows: [LibraryRow]) -> some View {
        let cells = grid.data.cells
        let send: (Data) -> Void = { shell.send(screen: PhotosScreens.grid, event: $0) }
        let skeleton = PhotoGridSkeleton(width: width, target: PhotoTileMetrics.height(rung: Int(grid.rung)))
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
            // THE OTHER PLANE, IN ITS OWN VIEW (#1025 S6). See `BackupStatus`.
            //
            // It belongs to the LIBRARY band and not to the screen: the camera
            // roll's permission and progress are about the photographs a
            // member is looking at, and drawing them over a list of albums or
            // a search field is the backup shouting from a room it is not in.
            BackupStatus(shell: shell, state: state)
                .padding(.horizontal, CentraidGeometry.pageMargin)
            if grid.hasWriteFailure {
                // A REFUSED WRITE SAYS SO, in its own line and never in place
                // of the library: the photographs are still what they were.
                Text(grid.writeFailure.sentence)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.vertical, 4)
            }
            if !grid.exportNotice.isEmpty {
                // WHAT "SEND A COPY" CAME TO — the originals not on this
                // device, a location that could not be taken out.
                Text(grid.exportNotice)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.vertical, 4)
                    .accessibilityIdentifier("photos.library.exportNotice")
            }
            switch grid.content {
            case let .failure(failure)?:
                ScreenFailureView(sentence: failure.sentence, remedy: failure.remedy)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
            case let .data(data)?:
                if cells.isEmpty, !data.complete {
                    // THE DATED WALK CAME BACK EMPTY AND THE UNDATED ONE HAS
                    // NOT RUN: still loading, not an empty library.
                    skeleton.task(id: data.undatedWalk) { send(LibraryEvents.nextPage()) }
                } else if cells.isEmpty {
                    // THE FILTER EMPTIED THE GRID, NOT THE LIBRARY — its own
                    // sentence, never the empty-library copy.
                    if grid.filter == .favorites {
                        ScreenEmptyView(
                            sentence: PhotosCopy.shared.PHOTOS_GRID_NO_FAVORITES,
                            remedy: PhotosCopy.shared.PHOTOS_GRID_NO_FAVORITES_CAPTION
                        )
                    } else {
                        ScreenEmptyView(
                            sentence: PhotosCopy.shared.PHOTOS_GRID_EMPTY,
                            remedy: PhotosCopy.shared.PHOTOS_GRID_EMPTY_CAPTION
                        )
                    }
                } else if grid.grain == .years || grid.grain == .months {
                    LibraryGrainCards(
                        cells: cells,
                        years: grid.grain == .years,
                        complete: data.complete,
                        width: width,
                        send: send
                    )
                    LibraryMoreSentinel(complete: data.complete, count: cells.count, send: send)
                } else {
                    LibraryTimelineRows(
                        rows: rows,
                        rung: Int(grid.rung),
                        selecting: grid.selecting,
                        selected: Set(grid.selected),
                        send: send,
                        // A TILE OPENS THE PHOTOGRAPH, and the loaded library's
                        // own order rides along as the neighbours — so a swipe
                        // in the lightbox costs no read, and it walks the
                        // library in the order the member is looking at.
                        onOpen: { identifier in
                            shell.path.append(.photoLightbox(identifier, cells.map(\.assetID)))
                        }
                    )
                    LibraryMoreSentinel(complete: data.complete, count: cells.count, send: send)
                }
            case .loading?, nil:
                // THE GRID IS THE LOADING STATE (v0 §14): skeleton tiles at the
                // rung's real geometry, so nothing reflows when the bytes land.
                // Never a spinner.
                skeleton
            }
        }
        .scrollTargetLayout()
    }

    /// The header while selecting: the count, as v0's room swapped it in place.
    private func selectionTitle(_ count: Int) -> String {
        switch count {
        case 0: return PhotosCopy.shared.PHOTOS_GRID_SELECT
        case 1: return PhotosCopy.shared.PHOTOS_GRID_SELECTED_ONE
        default: return copyFill(PhotosCopy.shared.PHOTOS_GRID_SELECTED_MANY, "count", "\(count)")
        }
    }

    /// THE HEADER'S ONE TRAILING ACTION (R-CHROME-1), a glyph and its words:
    /// New album's `Plus` on Collections; on the library Select
    /// (`CheckCircle`) — the app with nothing to create — or, selecting, the
    /// way out (`X`). Nothing on Search's page.
    private func trailingAction(grid: Centraid_Screen_V1_PhotosGridState, hasCells: Bool) -> RoomAction? {
        let chrome = grid.chrome
        switch state.destination {
        case .collections:
            return RoomAction(
                iconKey: "Plus",
                label: chrome.newAlbumLabel,
                identifier: "photos.collections.new-album"
            ) {
                shell.send(
                    screen: PhotosScreens.collections,
                    event: PhotosCollectionsStateView(data: shell.photosCollectionsState).sheetEvent(.newAlbum)
                )
            }
        case .search:
            return nil
        case .library, .unspecified, .UNRECOGNIZED:
            if grid.selecting {
                return RoomAction(iconKey: "X", label: chrome.cancelLabel, identifier: "photos.library.cancel") {
                    shell.send(screen: PhotosScreens.grid, event: LibraryEvents.selecting(false))
                }
            }
            guard hasCells else { return nil }
            return RoomAction(iconKey: "CheckCircle", label: chrome.selectLabel, identifier: "photos.library.select") {
                shell.send(screen: PhotosScreens.grid, event: LibraryEvents.selecting(true))
            }
        }
    }

    /// THE SEARCH BAR (R-CHROME-2), under the title on the library and on
    /// Collections, and THE FIELD in the same place once it is pressed — the
    /// same slot every app's search stands in. Pressing it moves the grid to
    /// `DESTINATION_SEARCH`, whose body is the hits; closing clears the query
    /// and returns to the place the member came from. None while selecting:
    /// the header is the selection's then.
    private func searchSlot(grid: Centraid_Screen_V1_PhotosGridState) -> SearchSlot? {
        guard !(isLibrary && grid.selecting) else { return nil }
        let searching = state.destination == .search
        return SearchSlot(
            // THE MACHINE'S FIELD (#1097, R-1097-27): its term and the words
            // its answer corrected, so the shared field draws "Showing results
            // for". Whether it is OPEN is the grid's destination, which is this
            // view's to state; none of it is decided here.
            field: PhotosSearchStateView(data: shell.photosSearchState).field(open: searching),
            placeholder: grid.chrome.searchPlaceholder,
            onOpen: { shell.send(screen: PhotosScreens.grid, event: PhotosGridStateView.destinationEvent(.search)) },
            onTerm: { shell.send(screen: PhotosScreens.search, event: PhotosSearchStateView.queryEvent($0)) },
            onClose: {
                shell.send(screen: PhotosScreens.search, event: PhotosSearchStateView.queryEvent(""))
                shell.send(screen: PhotosScreens.grid, event: PhotosGridStateView.destinationEvent(beforeSearch))
            }
        )
    }

    /// THE FILTER, AS CHIPS (R-CHROME-3): All photos · Favorites, which the
    /// machine offers on the library and nowhere else. Photos has no sort.
    private func filterChips(grid: Centraid_Screen_V1_PhotosGridState) -> [RoomChip] {
        grid.chips.map { chip in
            RoomChip(
                identifier: chip.filter == .favorites ? "photos-filter-favorites" : "photos-filter-all",
                label: chip.label,
                selected: chip.selected
            ) { shell.send(screen: PhotosScreens.grid, event: LibraryEvents.filter(chip.filter)) }
        }
    }

    /// A PINCH, as `PhotosTimeline.pinch` reads it: a rung step inside All, a
    /// grain past its ends, v0's thresholds. Landing where the member was, like
    /// every grain change. The table is the machine's; this only carries the
    /// grain across as its proto number and sends what comes back.
    private func pinched(grid: Centraid_Screen_V1_PhotosGridState, scale: CGFloat) {
        let rung = Int32(grid.rung)
        let landed = PhotosTimeline.shared.pinchNumbers(grain: Int32(grid.grain.rawValue), rung: rung, scale: Float(scale))
        let send: (Data) -> Void = { shell.send(screen: PhotosScreens.grid, event: $0) }
        if landed.rung != rung { send(LibraryEvents.rung(Int(landed.rung))) }
        if landed.grain != Int32(grid.grain.rawValue), let grain = Centraid_Screen_V1_PhotosGridState.Grain(rawValue: Int(landed.grain)) {
            send(LibraryEvents.grain(grain, at: LibraryLayout.day(forID: scrolledID, cells: grid.data.cells)))
        }
    }

    /// LAND ON THE DAY A GRAIN SWITCH OR A CARD NAMED: the row or card that
    /// holds it, once per change — a member who scrolls away is not pulled back.
    private func land(on day: String, grid: Centraid_Screen_V1_PhotosGridState, rows: [LibraryRow]) {
        guard !day.isEmpty else { return }
        let month = String(day.prefix(7))
        let target: String?
        switch grid.grain {
        case .years, .months:
            // THE CARD THAT HOLDS THE DAY — shared's rule, the same one Compose lands on.
            let items = LibraryLayout.grainItems(grid.data.cells, years: grid.grain == .years)
            let index = Int(PhotosLibraryLayout.shared.grainItemIndex(items: items, day: day))
            target = index >= 0 ? items[index].key : nil
        default:
            target = rows.first { $0.id == "d:\(day)" }?.id
                ?? rows.first {
                    if case .month = $0 { return false }
                    return $0.day.hasPrefix(month)
                }?.id
        }
        guard let target else { return }
        // A TURN LATER: the rows of the grain just switched to are laid out in
        // this update, and a position set before they exist lands nowhere.
        DispatchQueue.main.async { scrolledID = target }
    }

    /// The album sheet's presentation, READ from the state and WRITTEN as an
    /// event, for `sheetBinding`'s reason.
    private func albumBinding(_ grid: Centraid_Screen_V1_PhotosGridState) -> Binding<Bool> {
        Binding(
            get: { grid.albumChoiceOpen },
            set: { open in
                guard !open, grid.albumChoiceOpen else { return }
                shell.send(screen: PhotosScreens.grid, event: LibraryEvents.albumDismissed())
            }
        )
    }

    /// A binding that READS the screen's state and WRITES an event.
    ///
    /// A swipe-to-dismiss has to reach the reducer too, or the state would
    /// still say `MORE` with nothing on screen and the next tap on `···` would
    /// be a no-op — which is the shape of bug that makes a control feel
    /// broken every second press.
    private func sheetBinding(
        _ sheet: Centraid_Screen_V1_PhotosGridState.Sheet
    ) -> Binding<Bool> {
        Binding(
            get: { state.sheet == sheet },
            set: { open in
                guard !open, state.sheet == sheet else { return }
                shell.send(screen: PhotosScreens.grid, event: state.sheetEvent(.none))
            }
        )
    }
}
