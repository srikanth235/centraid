import SwiftUI

/// PHOTOS' ROOT, IN SWIFTUI (#1135, lane D): the library, Collections and Search,
/// drawn from the view state Rust sends for `photos.home`.
///
/// **THE VIEW DECIDES NOTHING.** Every word, flag, filter chip, tab, row, count and
/// sheet is on `PhotosHomeState`; this maps fields to geometry and taps to events.
/// The two things only the shell knows go the other way: the width the grid is
/// drawn at (`viewport`, so Rust can pack the rows) and the camera roll's grant
/// and progress (`permission`, `backup`, sent by `ScreenStore`).
///
/// **THE ROOT'S CHROME IS RUST'S (R-CHROME-1…5).** "Photos" has ONE trailing
/// action — Select on the library (the app with nothing to create), New album on
/// Collections — the search bar under the title (it opens Search, whose body is
/// the hits), the library's filter chips, the body, and the band at the foot. The
/// band's places are Library and Collections, then More (a tab whose press opens
/// a sheet — `more` is a sheet, never a destination). While selecting, the bar
/// takes the band's place (Apple Photos'), so a tap aimed at Trash cannot land on
/// a destination.
///
/// The Compose twin is `androidApp/.../screens/photos/PhotosHomeScreen.kt`.
struct PhotosHomeView: View {
    let state: Centraid_Core_V1_PhotosHomeState
    let send: (Centraid_Core_V1_PhotosHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onHome: () -> Void

    /// The day at the top of the library, for a grain switch to land on.
    @State private var visibleDay = ""

    private var chrome: Centraid_Core_V1_PhotosHomeChrome { state.chrome }
    private var selection: Centraid_Core_V1_PhotosSelection { state.selection }
    private var searching: Bool { state.destination == .search }
    private var collecting: Bool { state.destination == .collections }
    private var selecting: Bool { !collecting && !searching && selection.selecting }
    private var hasTiles: Bool {
        if state.hasLibrary, case let .data(data)? = state.library.content { return !data.tiles.isEmpty }
        return false
    }

    var body: some View {
        AppPlace(
            app: "photos",
            title: selecting ? (selection.title.isEmpty ? chrome.selectingTitle : selection.title) : chrome.title,
            trailing: trailing,
            // SEARCH IS THE FIELD UNDER THE TITLE (R-CHROME-2): the bar's press moves
            // Photos to Search, whose body is the hits, and the field opens where the
            // bar stood; closing clears the query and returns to the library. Not while
            // selecting — the header is the selection's then.
            search: selecting ? nil : SearchSlot(
                field: searchField,
                placeholder: chrome.searchPlaceholder,
                closeLabel: chrome.closeSearchLabel,
                onOpen: { send(PhotosHomeEvents.make { $0.searchOpened = .init() }) },
                onTerm: { term in send(PhotosHomeEvents.make { $0.searchTerm = term }) },
                onClose: { send(PhotosHomeEvents.make { $0.searchClosed = .init() }) }
            ),
            chips: state.chips.map { chip in
                RoomChip(
                    identifier: chip.filter == .favorites ? "photos-filter-favorites" : "photos-filter-all",
                    label: chip.label,
                    selected: chip.selected
                ) { send(PhotosHomeEvents.make { $0.filter = chip.filter }) }
            },
            band: { foot },
            content: { pageBody }
        )
        .modifier(PhotosHomeSheets(state: state, send: send))
    }

    /// THE HEADER'S ONE TRAILING ACTION (R-CHROME-1), a glyph and its words.
    private var trailing: RoomAction? {
        if searching { return nil }
        if collecting {
            return RoomAction(iconKey: "Plus", label: chrome.newAlbumLabel, identifier: "photos.collections.new-album") {
                send(PhotosHomeEvents.sheet(.newAlbum))
            }
        }
        if selecting {
            return RoomAction(iconKey: "X", label: chrome.cancelLabel, identifier: "photos.library.cancel") {
                send(PhotosHomeEvents.selection { $0.mode = .with { $0.selecting = false } })
            }
        }
        guard hasTiles else { return nil }
        return RoomAction(iconKey: "CheckCircle", label: chrome.selectLabel, identifier: "photos.library.select") {
            send(PhotosHomeEvents.selection { $0.mode = .with { $0.selecting = true } })
        }
    }

    private var searchField: KitSearchField {
        var field = KitSearchField()
        field.open = searching
        field.term = state.hasSearch ? state.search.query : ""
        field.corrected = state.hasSearch ? state.search.corrected : ""
        return field
    }

    /// THE FOOT: the band, or what stands in its place. The content ends above it
    /// BY LAYOUT (v0's rule), so the last row of photographs scrolls clear of it.
    @ViewBuilder
    private var foot: some View {
        if selecting {
            PhotosSelectionBar(selection: selection, sendCopyLabel: chrome.sendCopyLabel, send: send)
        } else {
            VStack(spacing: 0) {
                // YEARS · MONTHS · ALL, PERMANENT while the library has photographs
                // (v0) — above the band, never on a timer.
                if !collecting, !searching, hasTiles, state.hasLibrary {
                    LibraryGrainControl(grain: state.library.grain, chrome: chrome) { next in
                        send(PhotosHomeEvents.make {
                            $0.grain = .with {
                                $0.grain = next
                                $0.atDay = visibleDay
                            }
                        })
                    }
                }
                // PLACES, THEN MORE — an ordinary tab of the band, whose press opens
                // the sheet.
                AppBand(
                    app: "photos",
                    tabs: state.band.map { tab in
                        BandView(
                            label: tab.label,
                            event: Data(tab.key.utf8),
                            iconKey: tab.iconKey,
                            selected: tab.current,
                            key: tab.key
                        )
                    },
                    onSelect: { picked in
                        let key = String(decoding: picked, as: UTF8.self)
                        send(PhotosHomeEvents.make { $0.band = key })
                    },
                    onHome: onHome
                )
            }
        }
    }

    /// Which section is on screen is `destination`; the others are unset.
    @ViewBuilder
    private var pageBody: some View {
        VStack(spacing: 0) {
            // A WRITE THE VAULT REFUSED, or what a copy came to: its own line, never
            // in place of the library — the photographs are still what they were.
            if state.hasStatus, !collecting {
                StatusLineView(status: state.status, identifier: "photos-status") {}
            }
            if searching, state.hasSearch {
                PhotosSearchBody(search: state.search, send: send, open: open)
            } else if collecting, state.hasCollections {
                PhotosCollectionsBody(state: state, collections: state.collections, send: send, open: open)
            } else if state.hasLibrary {
                PhotosLibraryBody(
                    state: state,
                    library: state.library,
                    send: send,
                    open: open,
                    visibleDay: $visibleDay
                )
            } else {
                Color.clear
            }
        }
    }
}

/// THE CAMERA-ROLL BANNER, AS RUST DECIDED IT: unset when there is nothing to say
/// or do, so a library with photographs and an import that is done draws no line at
/// all, and "Import now" is offered only over an empty library.
///
/// **An import, not the backup** (#1080): it brings the camera roll into this
/// vault and says so; where the backup to a gateway stands is Home's backup line
/// and the Backup screen. A DENIED grant changes this line and never the library —
/// the difference between a member seeing the photographs they own and a member
/// seeing an empty screen with a Settings link. A remedy's tap is an event: the
/// prompt is the camera roll's, in Rust, and Settings and iOS's limited
/// selection are the shell's (`ScreenStore`, the `CameraRoll` effect).
/// Nothing here blames the member.
struct PhotosBackupBanner: View {
    @Environment(\.colorScheme) private var scheme
    let banner: Centraid_Core_V1_PhotosHomeImportBanner
    let send: (Centraid_Core_V1_PhotosHomeEvent) -> Void

    private func remedy(_ which: Centraid_Core_V1_PhotosHomeImportBanner.Remedy) {
        send(PhotosHomeEvents.make { $0.remedy = .with { $0.remedy = which } })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !banner.sentence.isEmpty {
                Text(banner.sentence)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("text", scheme))
            }
            if !banner.reason.isEmpty {
                Text(banner.reason)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            // THE VERBS ARE THE KIT'S LINK: `link` ink, 44 target.
            HStack(spacing: 16) {
                switch banner.remedy {
                case .ask:
                    KitLink(label: banner.allowLabel) { remedy(.ask) }
                case .settings:
                    KitLink(label: banner.settingsLabel, identifier: "photos.backup.open-settings") { remedy(.settings) }
                case .manageSelection:
                    KitLink(label: banner.manageLabel) { remedy(.manageSelection) }
                default:
                    EmptyView()
                }
                if banner.importNow {
                    KitLink(label: banner.importNowLabel, identifier: "photos.backup.import-now") {
                        send(PhotosHomeEvents.make { $0.importNow = .init() })
                    }
                }
            }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
    }
}

/// THE SHEETS PHOTOS' HOME OPENS: More, the tile sizes, the camera roll's detail,
/// the location a copy carries, "New album", "Add to album" and the confirms.
/// WHICH ONE IS OPEN IS STATE — `isPresented` is derived from `state.sheet` and a
/// swipe-to-dismiss is WRITTEN as an event, or the state would still say `MORE`
/// with nothing on screen and the next press on `···` would be a no-op.
private struct PhotosHomeSheets: ViewModifier {
    let state: Centraid_Core_V1_PhotosHomeState
    let send: (Centraid_Core_V1_PhotosHomeEvent) -> Void

    private func binding(_ sheet: Centraid_Core_V1_PhotosHomeState.Sheet) -> Binding<Bool> {
        Binding(
            get: { state.sheet == sheet },
            set: { open in
                guard !open, state.sheet == sheet else { return }
                send(PhotosHomeEvents.sheet(.none))
            }
        )
    }

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: binding(.more)) {
                if state.hasMore { PhotosMoreSheetView(state: state, more: state.more, send: send) }
            }
            // THE SIZES, XS TO L, the current one checked; picking one closes the choice.
            .sheet(isPresented: binding(.tileSize)) {
                if state.hasTileSize {
                    OptionSheet(title: state.tileSize.title) {
                        ForEach(state.tileSize.options, id: \.rung) { option in
                            SheetRow(
                                label: option.label,
                                selected: option.selected,
                                identifier: "photos.tileSize.\(option.rung)"
                            ) { send(PhotosHomeEvents.make { $0.rung = option.rung }) }
                        }
                    }
                    .presentationDetents([.medium])
                }
            }
            .sheet(isPresented: binding(.backupDetail)) {
                if state.hasBackupDetail { PhotosBackupDetailSheet(detail: state.backupDetail, send: send) }
            }
            // HOW MUCH OF THE PLACE TRAVELS, asked every time (#816): a place NAME is
            // one sentence per photograph, and a batch has as many places as photographs.
            .sheet(isPresented: binding(.copyPlace)) {
                if state.hasCopyPlace {
                    OptionSheet(title: state.copyPlace.title) {
                        SheetRow(label: state.copyPlace.noLocationLabel) {
                            send(PhotosHomeEvents.make { $0.copyPlaceChosen = .with { $0.keepLocation = false } })
                        }
                        SheetRow(label: state.copyPlace.exactLocationLabel) {
                            send(PhotosHomeEvents.make { $0.copyPlaceChosen = .with { $0.keepLocation = true } })
                        }
                    }
                    .presentationDetents([.height(220)])
                }
            }
            // NAMING A NEW ALBUM. The sheet does NOT close itself when Create is
            // pressed: Rust closes it when the write commits, so a refused create
            // leaves the typed name on screen with the refusal beside it.
            .sheet(isPresented: binding(.newAlbum)) {
                if state.hasCollections {
                    SheetRoom(
                        title: state.chrome.newAlbumLabel,
                        status: state.hasStatus ? state.status.sentence : "",
                        primary: state.collections.newAlbumCanSubmit
                            ? SheetPrimary(
                                label: state.collections.createLabel,
                                identifier: "photos.collections.create-album"
                            ) { send(PhotosHomeEvents.make { $0.newAlbumSubmitted = .init() }) }
                            : nil
                    ) {
                        MachineTextField(
                            placeholder: state.collections.newAlbumPlaceholder,
                            value: state.collections.newAlbumName,
                            focusOnAppear: true,
                            onEdit: { name in send(PhotosHomeEvents.make { $0.newAlbumName = name }) },
                            onSubmit: {
                                if state.collections.newAlbumCanSubmit {
                                    send(PhotosHomeEvents.make { $0.newAlbumSubmitted = .init() })
                                }
                            }
                        )
                        .centraidType("body")
                        .accessibilityLabel(state.collections.newAlbumPlaceholder)
                        .accessibilityIdentifier("photos.collections.album-name")
                    }
                }
            }
            // "ADD TO ALBUM" — the shared sheet. `isPresented` is the state's, so a
            // swipe-down reaches Rust rather than leaving it saying "open".
            .sheet(isPresented: Binding(
                get: { state.albumChoice.open },
                set: { open in
                    if !open, state.albumChoice.open {
                        send(PhotosHomeEvents.make { $0.albumChoice = .with { $0.dismissed = .init() } })
                    }
                }
            )) {
                PhotosAlbumChoiceSheet(choice: state.albumChoice) { event in
                    send(PhotosHomeEvents.make { $0.albumChoice = event })
                }
            }
            // THE TRASH CONFIRM — a confirm is a sheet (D4), in Rust's words.
            .sheet(isPresented: Binding(
                get: { state.selection.hasConfirm },
                set: { shown in
                    if !shown, state.selection.hasConfirm {
                        send(PhotosHomeEvents.selection { $0.dismissed = .init() })
                    }
                }
            )) {
                ConfirmSheet(
                    state.selection.confirm,
                    cancelLabel: state.selection.cancelLabel,
                    onConfirm: { send(PhotosHomeEvents.selection { $0.confirmed = .init() }) },
                    onDismiss: { send(PhotosHomeEvents.selection { $0.dismissed = .init() }) }
                )
            }
            // DELETING AN ALBUM DELETES THE GROUPING, and the confirm says so in one
            // sentence; the photographs stay in the library.
            .sheet(isPresented: Binding(
                get: { state.hasCollections && state.collections.hasDeleteConfirm },
                set: { shown in
                    if !shown, state.hasCollections, state.collections.hasDeleteConfirm {
                        send(PhotosHomeEvents.make { $0.albumDeleteDismissed = .init() })
                    }
                }
            )) {
                if state.hasCollections {
                    ConfirmSheet(
                        state.collections.deleteConfirm,
                        cancelLabel: state.collections.keepLabel,
                        onConfirm: { send(PhotosHomeEvents.make { $0.albumDeleteConfirmed = .init() }) },
                        onDismiss: { send(PhotosHomeEvents.make { $0.albumDeleteDismissed = .init() }) }
                    )
                }
            }
    }
}

/// THE MORE SHEET: the camera roll, the tile size, and the "Free up space" row.
/// More is a tab of the band whose press opens this; every other surface is
/// reached from Collections, so the foot says so in one clause. Rows, sentences and
/// the free-up row are Rust's.
private struct PhotosMoreSheetView: View {
    let state: Centraid_Core_V1_PhotosHomeState
    let more: Centraid_Core_V1_PhotosMoreSheet
    let send: (Centraid_Core_V1_PhotosHomeEvent) -> Void

    var body: some View {
        OptionSheet(title: more.title, status: more.foot) {
            ForEach(more.rows, id: \.key) { row in
                SheetRow(
                    iconKey: row.iconKey,
                    label: row.meta.isEmpty ? row.label : "\(row.label) \u{00B7} \(row.meta)",
                    identifier: "photos.more.\(row.key)"
                ) {
                    // `tile_size` opens its choice; the camera roll opens its detail.
                    send(PhotosHomeEvents.sheet(row.key == "tile_size" ? .tileSize : .backupDetail))
                }
            }
            if more.hasFreeUp {
                FreeUpSpaceRow(row: more.freeUp) { send(PhotosHomeEvents.make { $0.freeUpTapped = .init() }) }
            }
        }
    }
}

/// THE ROW ITSELF (#1080 A19): the title, the census's line, why nothing can be
/// freed (or how much a tap frees) and what the last free-up came to are Rust's;
/// the action is drawn only while it can act, and holds still while the system's
/// confirmation is up.
private struct FreeUpSpaceRow: View {
    @Environment(\.colorScheme) private var scheme
    let row: Centraid_Core_V1_PhotosFreeUpRow
    let onFree: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 12) {
                CentraidIconView(iconKey: "Gauge", tint: Theme.color("text", scheme), size: 18)
                    .frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                    Text(row.meta)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
            }
            .accessibilityElement(children: .combine)
            if !row.reason.isEmpty {
                Text(row.reason)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
            if !row.actionLabel.isEmpty {
                KitLink(label: row.actionLabel, identifier: "photos.more.freeUp.action", action: onFree)
                    .disabled(!row.enabled)
            }
            if !row.notice.isEmpty {
                Text(row.notice)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            // WHAT A PHOTO DELETED FOR GOOD COSTS THE BACKUP DEVICE (#1080 F5).
            if !row.retention.isEmpty {
                Text(row.retention)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .padding(.vertical, 6)
        .accessibilityIdentifier("photos.more.freeUp")
    }
}

/// WHAT THIS DEVICE'S CAMERA-ROLL IMPORT IS DOING, IN FULL: the banner says the
/// phase in one sentence; this says the rest — how many, and why it is not moving.
///
/// **An IMPORT, and only that** (#1080). It brings the camera roll into this vault;
/// it says nothing about a gateway, and it carries no transport row. An import
/// already running has nothing to start, so the ink button is drawn greyed, not
/// hidden.
private struct PhotosBackupDetailSheet: View {
    let detail: Centraid_Core_V1_PhotosBackupDetailSheet
    let send: (Centraid_Core_V1_PhotosHomeEvent) -> Void

    var body: some View {
        SheetRoom(
            title: detail.title,
            status: detail.status,
            primary: SheetPrimary(label: detail.importLabel, enabled: detail.importEnabled) {
                send(PhotosHomeEvents.make { $0.importNow = .init() })
            }
        ) {
            VStack(spacing: 0) {
                ForEach(detail.rows, id: \.key) { row in
                    FieldRow(key: row.key, value: row.value)
                }
            }
        }
    }
}
