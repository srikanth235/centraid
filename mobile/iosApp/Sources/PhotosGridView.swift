import SwiftUI

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

    /// The band tab the member came to Search from — its mark rides the search
    /// row's leading circle, so the way back looks like the place it goes.
    private var returnBand: BandView? {
        state.bands.first { $0.event == PhotosGridStateView.destinationEvent(beforeSearch) }
    }

    var body: some View {
        // A SCROLLVIEW, LIKE EVERY OTHER COVER (R-PHOTOS-2, #1025).
        //
        // This was a bare `VStack`, and a `NavigationStack` destination that
        // does not scroll is laid out under the bar rather than below it: the
        // band row, "Camera roll import is off." and "Import now" all drew
        // ON TOP of the back chevron and the "Photos" title, and the grid's
        // last row was cut off at the tab bar with no way to reach it. Nineteen
        // photographs in a view that cannot scroll is the same defect twice.
        //
        // The scroll view is also what makes the inset correct, which is why
        // the hand-rolled `.safeAreaPadding(.top)` + 44pt that stood here is
        // gone rather than moved: SwiftUI insets scrollable content below the
        // bar itself, and a screen that adds its own offset on top of that is
        // the compensation R-PHOTOS-2 set out to delete, not keep.
        let grid = self.grid
        let cells = grid.data.cells
        let rows = isLibrary && grid.grain == .all && width > 0
            ? LibraryLayout.rows(cells, width: width, rung: Int(grid.rung))
            : []
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
                        send: { shell.send(screen: "photos.collections", event: $0) },
                        onOpenShelf: { shelf in
                            shell.path.append(
                                .photoShelf((try? shelf.serializedData()) ?? Data())
                            )
                        },
                        onOpenDoor: { kind in
                            switch kind {
                            case .people: shell.path.append(.photosPeople)
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
                        send: { shell.send(screen: "photos.search", event: $0) },
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
        // `PhotosTimeline.pinch`, restated in `pinched`.
        .simultaneousGesture(
            MagnifyGesture().onEnded { value in pinched(grid: grid, scale: value.magnification) },
            including: isLibrary && !cells.isEmpty ? .all : .subviews
        )
        // A BAND BODY READS BECAUSE IT WAS OPENED, and `.task(id:)` is what
        // tells it: the id is the destination, so switching bands re-runs and
        // an ordinary recomposition does not. The library needs none — its
        // `Opened` comes with the route, through `ShellModel.opened`.
        // A SCROLL THROUGH THE HITS PUTS THE KEYBOARD AWAY, as the system's
        // search does: the member has stopped typing and started looking, and
        // the row then settles into the band's slot.
        .scrollDismissesKeyboard(.immediately)
        .task(id: state.destination) { shell.openedPhotosBand(state.destination) }
        // THE BAND IS AT THE FOOT, and the content ends above it BY LAYOUT
        // (v0's rule): a safe-area inset rather than padding on the scroll
        // content, so the last row of photographs scrolls clear of the band
        // instead of sitting underneath it.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Group {
                // ON SEARCH THE FIELD TAKES THE BAND'S PLACE — the system
                // Photos app's search, which replaces its tab bar rather than
                // stacking a field over it. Closing puts the band back on the
                // destination the member came from, and clears the query, so
                // the next Search opens on an empty field as the system's does.
                if state.destination == .search {
                    PhotosSearchBar(
                        query: PhotosSearchStateView(data: shell.photosSearchState).query,
                        returnIconKey: returnBand?.iconKey ?? "Image",
                        returnLabel: returnBand?.label ?? "Library",
                        send: { shell.send(screen: "photos.search", event: $0) },
                        onReturn: {
                            shell.send(
                                screen: "photos.grid",
                                event: PhotosGridStateView.destinationEvent(beforeSearch)
                            )
                        },
                        onClose: {
                            shell.send(screen: "photos.search", event: PhotosSearchStateView.queryEvent(""))
                            shell.send(
                                screen: "photos.grid",
                                event: PhotosGridStateView.destinationEvent(beforeSearch)
                            )
                        }
                    )
                } else if isLibrary, grid.selecting {
                    // A SELECTION TAKES THE BAND'S PLACE (Apple Photos; v0's
                    // room), so a tap aimed at Trash cannot land on a
                    // destination.
                    LibrarySelectionBar(
                        grid: grid,
                        send: { shell.send(screen: "photos.grid", event: $0) },
                        onSendCopy: { choosingPlace = true }
                    )
                } else {
                    VStack(spacing: 0) {
                        // YEARS · MONTHS · ALL, PERMANENT while the library has
                        // photographs (v0) — above the band, never on a timer.
                        if isLibrary, !cells.isEmpty {
                            LibraryGrainControl(grain: grid.grain) { next in
                                shell.send(
                                    screen: "photos.grid",
                                    event: LibraryEvents.grain(next, at: LibraryLayout.day(forID: scrolledID, cells: cells))
                                )
                            }
                        }
                        AppBand(
                            app: "photos",
                            tabs: state.bands,
                            onSelect: { shell.send(screen: "photos.grid", event: $0) },
                            // `more` IS A SHEET, NEVER A DESTINATION. It sends a
                            // sheet event; there is no band value it could send.
                            onMore: { shell.send(screen: "photos.grid", event: state.moreSheetEvent) },
                            onHome: { shell.path.removeAll() }
                        )
                    }
                }
            }
            .background(Theme.color("bg", scheme).ignoresSafeArea(edges: .bottom))
        }
        // WHERE THE SEARCH BAR'S CLOSE RETURNS TO. Held here because the state
        // carries only the destination on screen, and "the one before" is the
        // back-of-the-hand memory a close control needs — a fact about this
        // visit, not about the vault, so nothing reads it but the close.
        .onChange(of: state.destination) { previous, next in
            guard next == .search, previous != .search else { return }
            beforeSearch = previous == .unspecified ? .library : previous
        }
        .navigationTitle(isLibrary && grid.selecting ? selectionTitle(grid.selected.count) : "Photos")
        .toolbar { libraryToolbar(grid: grid, hasCells: !cells.isEmpty) }
        // LAND WHERE THE MACHINE SAYS THE MEMBER IS — a grain switch or a card
        // names a day, and the list moves to it once.
        .onChange(of: grid.placeDay) { _, day in land(on: day, grid: grid, rows: rows) }
        .onChange(of: grid.grain) { _, _ in land(on: grid.placeDay, grid: grid, rows: rows) }
        // THE SELECTION'S TWO SHEETS: the album choice (one sheet for every
        // "Add to album") and the trash confirm.
        .sheet(isPresented: albumBinding(grid)) {
            AlbumChoiceSheet(
                choices: grid.albumChoices,
                onChoose: { shell.send(screen: "photos.grid", event: LibraryEvents.albumChosen($0)) },
                onNewAlbum: { shell.send(screen: "photos.grid", event: LibraryEvents.albumCreated($0)) },
                onCancel: { shell.send(screen: "photos.grid", event: LibraryEvents.albumDismissed()) }
            )
        }
        .confirmationDialog(
            LibraryTrashCopy.question(grid.selected.count),
            isPresented: sheetBinding(.confirmTrash),
            titleVisibility: .visible
        ) {
            Button("Move to trash", role: .destructive) {
                shell.send(screen: "photos.grid", event: LibraryEvents.trashConfirmed())
            }
            Button("Keep them", role: .cancel) {}
        } message: {
            Text(LibraryTrashCopy.body)
        }
        // HOW MUCH OF THE PLACE TRAVELS, asked every time (#816) — the shelf's
        // two answers, for the shelf's reason: a place NAME is one sentence per
        // photograph, and a batch has as many places as photographs.
        .confirmationDialog(
            "Send a copy — how much of the place?",
            isPresented: $choosingPlace,
            titleVisibility: .visible
        ) {
            Button("No location") { shell.exportLibrary(grid.selected, keepLocation: false) }
            Button("Exact location") { shell.exportLibrary(grid.selected, keepLocation: true) }
            Button("Cancel", role: .cancel) {}
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
        let send: (Data) -> Void = { shell.send(screen: "photos.grid", event: $0) }
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
                            sentence: "No favorites yet",
                            remedy: "Photographs you mark as a favorite appear here."
                        )
                    } else {
                        ScreenEmptyView(
                            sentence: "No photographs on this device yet.",
                            remedy: "Import your camera roll and they appear here."
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
        case 0: return "Select photographs"
        case 1: return "1 photograph selected"
        default: return "\(count) photographs selected"
        }
    }

    /// THE LIBRARY'S HEADER CONTROLS: the menu and Select, or — selecting —
    /// Cancel.
    ///
    /// The menu is v0's `libraryMenuGroups`: the filter at every grain, the
    /// tile size only at All — Years and Months draw one cover per period at
    /// an aspect the grain fixes, so a size there would act on nothing on
    /// screen.
    ///
    /// v0's third group, "Prioritise faces", is NOT here: the enrichment ask
    /// behind it went with #1029, so all that row could do is open People — a
    /// place, not a view option, and one Collections already has a door to
    /// (Apple Photos' view menu carries none either).
    @ToolbarContentBuilder
    private func libraryToolbar(grid: Centraid_Screen_V1_PhotosGridState, hasCells: Bool) -> some ToolbarContent {
        if isLibrary {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if grid.selecting {
                    Button("Cancel") { shell.send(screen: "photos.grid", event: LibraryEvents.selecting(false)) }
                        .accessibilityIdentifier("photos.library.cancel")
                } else {
                    Menu {
                        Picker(
                            selection: Binding(
                                get: { grid.filter == .favorites ? Centraid_Screen_V1_PhotosGridState.Filter.favorites : .all },
                                set: { shell.send(screen: "photos.grid", event: LibraryEvents.filter($0)) }
                            )
                        ) {
                            Text("All photos").tag(Centraid_Screen_V1_PhotosGridState.Filter.all)
                            Text("Favorites").tag(Centraid_Screen_V1_PhotosGridState.Filter.favorites)
                        } label: {
                            Text("Filter")
                        }
                        .pickerStyle(.inline)
                        if grid.grain == .all || grid.grain == .unspecified {
                            Picker(
                                selection: Binding(
                                    get: { Int(grid.rung) },
                                    set: { shell.send(screen: "photos.grid", event: LibraryEvents.rung($0)) }
                                )
                            ) {
                                ForEach(PhotoTileMetrics.rungLabels.indices, id: \.self) { rung in
                                    Text(PhotoTileMetrics.rungLabels[rung]).tag(rung)
                                }
                            } label: {
                                Text("Tile size")
                            }
                            .pickerStyle(.inline)
                        }
                    } label: {
                        CentraidIconView(iconKey: "Sliders", tint: Theme.color("text", scheme), size: 20)
                            .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("View options")
                    .accessibilityIdentifier("photos.library.menu")
                    if hasCells {
                        Button("Select") { shell.send(screen: "photos.grid", event: LibraryEvents.selecting(true)) }
                            .accessibilityIdentifier("photos.library.select")
                    }
                }
            }
        }
    }

    /// A PINCH, as `PhotosTimeline.pinch` reads it — restated because the SPM
    /// host build links no Kotlin: a rung step inside All, a grain past its
    /// ends, v0's thresholds. Landing where the member was, like every grain
    /// change.
    private func pinched(grid: Centraid_Screen_V1_PhotosGridState, scale: CGFloat) {
        let out = scale >= 1.15
        let inward = scale <= 0.86
        guard out || inward else { return }
        let day = LibraryLayout.day(forID: scrolledID, cells: grid.data.cells)
        let send: (Data) -> Void = { shell.send(screen: "photos.grid", event: $0) }
        let rung = Int(grid.rung)
        switch grid.grain {
        case .years:
            if out { send(LibraryEvents.grain(.months, at: day)) }
        case .months:
            send(LibraryEvents.grain(out ? .all : .years, at: day))
        default:
            if out {
                if rung < PhotoTileMetrics.rungHeights.count - 1 { send(LibraryEvents.rung(rung + 1)) }
            } else if rung > 0 {
                send(LibraryEvents.rung(rung - 1))
            } else {
                send(LibraryEvents.grain(.months, at: day))
            }
        }
    }

    /// LAND ON THE DAY A GRAIN SWITCH OR A CARD NAMED: the row or card that
    /// holds it, once per change — a member who scrolls away is not pulled back.
    private func land(on day: String, grid: Centraid_Screen_V1_PhotosGridState, rows: [LibraryRow]) {
        guard !day.isEmpty else { return }
        let month = String(day.prefix(7))
        let target: String?
        switch grid.grain {
        case .years:
            target = "y:\(day.prefix(4))"
        case .months:
            let periods = LibraryLayout.periods(grid.data.cells, years: false)
            let pair = LibraryLayout.monthPairs(periods)
                .flatMap(\.pairs)
                .first { $0.contains { $0.key == month } }
            target = pair?.first.map { "p:\($0.key)" }
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
                shell.send(screen: "photos.grid", event: LibraryEvents.albumDismissed())
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
                shell.send(screen: "photos.grid", event: state.sheetEvent(.none))
            }
        )
    }
}
