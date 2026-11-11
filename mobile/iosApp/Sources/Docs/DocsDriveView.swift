import SwiftUI
import AVFoundation
import UIKit

/// THE DRIVE — Recents · Browse · Starred, More as a sheet; and, pushed over it,
/// a folder's page (#1046, #1135).
///
/// **THE VIEW DECIDES NOTHING.** The band, the header's filter menu (the filters,
/// the sort and the list-or-grid layout) and whether it is lit, every sheet's rows
/// and enabled flags, the empty and its one action, the head's subtitle: all
/// `DocsDriveState`, which
/// Rust makes (`crates/screens/src/docs`). What is here is geometry, the
/// events, and the platform's half of a capture: the OS grants, reported.
/// A row, a folder and a sheet row that opens a page carry their `Route`, and
/// a tap hands it to `open`.
struct DocsDriveView: View {
    let state: Centraid_Core_V1_DocsDriveState
    let send: (Centraid_Core_V1_DocsDriveEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    /// A folder is a pushed page; the drive at its tab is an app place with the band.
    private var isFolderPage: Bool {
        state.destination == .folders && !state.folderID.isEmpty
    }

    static func event(_ build: (inout Centraid_Core_V1_DocsDriveEvent) -> Void) -> Centraid_Core_V1_DocsDriveEvent {
        var event = Centraid_Core_V1_DocsDriveEvent()
        build(&event)
        return event
    }

    /// The vault will not let Docs read: the header offers no Plus and no controls, and the
    /// band is not drawn. (Only the header's items are chosen from the page; the page itself is
    /// drawn by `PageReadStateView`.)
    private func isDenied(_ state: Centraid_Core_V1_DocsDriveState) -> Bool {
        if case .refused? = state.page.state { return true }
        return false
    }

    /// Rust's search flag and term, as the kit's field state.
    private func searchField(_ state: Centraid_Core_V1_DocsDriveState) -> KitSearchField {
        var field = KitSearchField()
        field.open = state.search.open
        field.term = state.search.term
        field.corrected = state.search.corrected
        field.correctedLabel = state.search.correctedLabel
        return field
    }

    /// The one search slot both of Docs' places hand the kit: the band's key on the root, the
    /// folder page's own foot key under it.
    private func searchSlot(_ state: Centraid_Core_V1_DocsDriveState) -> SearchSlot {
        SearchSlot(
            field: searchField(state),
            placeholder: state.chrome.searchPlaceholder,
            closeLabel: state.chrome.searchClose,
            onOpen: { send(Self.event { $0.searchOpened = .init() }) },
            onTerm: { term in send(Self.event { $0.searchTerm = .with { $0.term = term } }) },
            onClose: { send(Self.event { $0.searchClosed = .init() }) }
        )
    }

    var body: some View {
        let state = state
        let denied = isDenied(state)
        Group {
            if isFolderPage {
                PushedPage(title: state.folderName, parentTitle: state.chrome.back, onBack: onBack) {
                    // A FOLDER PAGE IS NOT A ROOM, so it puts the header's two items in its
                    // trailing slot itself: the filter menu, then the Plus.
                    HStack(spacing: 0) {
                        if let slot = filter(state) { FilterMenuButton(app: "docs", slot: slot) }
                        RoomTrailing(action: addAction(state, denied), app: "docs")
                    }
                } content: {
                    // With no band to hang the search key on, the key alone stands at its foot.
                    VStack(spacing: 0) {
                        page(state, denied)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .safeAreaInset(edge: .bottom, spacing: 0) {
                        if !denied || state.search.open {
                            SearchFoot(search: searchSlot(state), identifier: "docs-search")
                        }
                    }
                }
            } else {
                AppPlace(
                    app: "docs",
                    title: state.chrome.title,
                    trailing: addAction(state, denied),
                    search: searchSlot(state),
                    filter: filter(state),
                    showsBand: !denied
                ) {
                    AppBand(
                        app: "docs",
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
                            send(Self.event { $0.band = .with { $0.key = key } })
                        },
                        onHome: onHome
                    )
                } content: {
                    page(state, denied)
                }
            }
        }
        .sheet(isPresented: sheetBinding(state)) {
            DocsSheetView(sheet: state.sheet, actions: sheetActions(state))
        }
        .onAppear {
            reportPermissions()
        }
    }

    /// THE ONE TRAILING ACTION (R-CHROME-1): the Plus, said as the state's
    /// add label; it opens the Add sheet.
    private func addAction(
        _ state: Centraid_Core_V1_DocsDriveState,
        _ denied: Bool
    ) -> RoomAction? {
        guard !denied, !state.chrome.add.isEmpty else { return nil }
        return RoomAction(iconKey: "Plus", label: state.chrome.add, identifier: "docs-add") {
            send(Self.event { $0.sheetOpened = .with { $0.kind = .add } })
        }
    }

    /// THE HEADER'S FILTER BUTTON (R-CHROME-3): Rust's menu as it comes: the filters, the
    /// sort and the layout. A pick or the clear row is an event; which is checked, and whether
    /// the funnel is lit, is on the state.
    private func filter(_ state: Centraid_Core_V1_DocsDriveState) -> FilterSlot? {
        guard state.hasFilterMenu else { return nil }
        return FilterSlot(
            menu: state.filterMenu,
            onPick: { section, option in
                send(Self.event {
                    $0.filterMenuPicked = .with {
                        $0.sectionKey = section
                        $0.optionKey = option
                    }
                })
            },
            onClear: { send(Self.event { $0.filterMenuCleared = .init() }) }
        )
    }

    // MARK: The page

    private func page(
        _ state: Centraid_Core_V1_DocsDriveState,
        _ denied: Bool
    ) -> some View {
        VStack(spacing: 0) {
            if !denied { controls(state) }
            DocsWriteLine(status: state.status)
            ingestLine(state.ingest)
            if state.hasRename {
                DocsRenameField(
                    rename: state.rename,
                    placeholder: state.chrome.renamePlaceholder,
                    doneLabel: state.chrome.renameDone,
                    onEdit: { title in send(Self.event { $0.renameEdited = .with { $0.title = title } }) },
                    onClose: { send(Self.event { $0.renameClosed = .init() }) }
                )
                .id(state.rename.documentID)
            }
            // THE WAY BACK UP (a folder page's path) stays over an empty folder too.
            if !state.crumbs.isEmpty, isFolderPage { crumbs(state.crumbs) }
            PageReadStateView(
                page: state.page,
                loadingLabel: state.chrome.loading,
                onRetry: { send(Self.event { $0.refreshed = .init() }) },
                // The empty page's one action is Rust's: add a document, clear the filters or make a folder.
                onEmptyAction: emptyAction(state.emptyAction)
            ) {
                let drive = state.data
                ScrollView {
                  VStack(alignment: .leading, spacing: 0) {
                    // THE FOLDERS WHOSE NAME MATCHED come first (#1097): each pushes its route.
                    ForEach(drive.containers, id: \.id) { container in
                        SearchContainerRow(container: container) { _ in open(container.route) }
                    }
                    if !drive.labelChips.isEmpty {
                        DocsLabelChips(chips: drive.labelChips) { label in
                            send(Self.event { $0.labelChip = .with { $0.label = label } })
                        }
                    }
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if state.layout != .grid {
                            ForEach(drive.folders, id: \.folderID) { node in
                                folderRow(node)
                            }
                        }
                        if state.layout == .grid {
                            grid(drive.folders, drive.rows, state)
                        } else {
                            ForEach(drive.rows, id: \.documentID) { row in
                                DocsRowItem(
                                    row: row,
                                    starredLabel: state.chrome.starred,
                                    menuLabel: state.chrome.rowMenu,
                                    onTap: { open(row.route) },
                                    onMenu: { send(Self.event { $0.rowMenu = .with { $0.documentID = row.documentID } }) }
                                )
                            }
                        }
                        note(drive.shelfNote)
                        note(drive.truncatedNote)
                    }
                  }
                  .padding(.bottom, 16)
                }
                .refreshable { send(Self.event { $0.refreshed = .init() }) }
                .scrollDismissesKeyboard(.interactively)
            }
            // THE ASK ROW closes a search's answer, matched or not (#1135): under the page, so an
            // answer that matched nothing keeps it too.
            if state.search.hasAskRow { SearchAskRow(ask: state.search.askRow) }
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { send(Self.event { $0.dismissed = .init() }) } }
        )) {
            ConfirmSheet(
                state.confirm,
                onConfirm: { send(Self.event { $0.confirmed = .init() }) },
                onDismiss: { send(Self.event { $0.dismissed = .init() }) }
            )
        }
        // THE STOP CONFIRM (#1185): the kit's sheet in Rust's own sentences, named for the folder.
        .sheet(isPresented: Binding(
            get: { state.hasStop },
            set: { open in if !open, state.hasStop { send(Self.event { $0.stopDismissed = .init() }) } }
        )) {
            ConfirmSheet(
                state.stop,
                onConfirm: { send(Self.event { $0.stopConfirmed = .init() }) },
                onDismiss: { send(Self.event { $0.stopDismissed = .init() }) }
            )
        }
    }

    /// The head's subtitle — one line over the list. Search and the filter menu are the
    /// room's (R-CHROME-2/3), drawn at the foot and in the header.
    private func controls(_ state: Centraid_Core_V1_DocsDriveState) -> some View {
        HStack(spacing: 6) {
            Text(state.headMeta)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textFaint", scheme))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 2)
    }

    private func crumbs(_ crumbs: [Centraid_Core_V1_DocsCrumb]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(Array(crumbs.enumerated()), id: \.offset) { index, crumb in
                    if index > 0 {
                        CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme), size: 10)
                            .accessibilityHidden(true)
                    }
                    Text(crumb.name)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color(index == crumbs.count - 1 ? "text" : "textSoft", scheme))
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 4)
        }
        .accessibilityElement(children: .combine)
    }

    private func folderRow(_ node: Centraid_Core_V1_DocsFolderNode) -> some View {
        Button {
            open(node.route)
        } label: {
            HStack(spacing: 12) {
                CentraidIconView(iconKey: "Folder", tint: Theme.color("textSoft", scheme), size: 20)
                    .frame(width: 28, height: 28)
                    .accessibilityHidden(true)
                Text(node.name)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(node.countLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme), size: 14)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
            .overlay(alignment: .bottom) { KitHairline() }
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(node.accessibilityLabel.isEmpty ? node.name : node.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("docs-folder-\(node.folderID)")
    }

    /// THE GRID (the default): three tiles across, Browse's folders first, each document a real
    /// thumbnail under its kind badge. Labels are the chips over it.
    private func grid(
        _ folders: [Centraid_Core_V1_DocsFolderNode],
        _ rows: [Centraid_Core_V1_DocsRowView],
        _ state: Centraid_Core_V1_DocsDriveState
    ) -> some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .top), count: 3),
            spacing: 16
        ) {
            ForEach(folders, id: \.folderID) { node in
                DocsFolderTile(node: node) { open(node.route) }
            }
            ForEach(rows, id: \.documentID) { row in
                DocsGridTile(
                    row: row,
                    onTap: { open(row.route) },
                    onMenu: { send(Self.event { $0.rowMenu = .with { $0.documentID = row.documentID } }) },
                    menuLabel: state.chrome.rowMenu
                )
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func note(_ text: String) -> some View {
        if !text.isEmpty {
            Text(text)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 8)
        }
    }

    // MARK: Events

    private func emptyAction(_ action: Centraid_Core_V1_DocsDriveData.EmptyAction) -> (() -> Void)? {
        switch action {
        case .add: return { send(Self.event { $0.sheetOpened = .with { $0.kind = .add } }) }
        case .clearFilters: return { send(Self.event { $0.filterMenuCleared = .init() }) }
        case .newFolder: return { send(Self.event { $0.sheetOpened = .with { $0.kind = .newFolder } }) }
        case .none, .unspecified, .UNRECOGNIZED: return nil
        }
    }

    /// A sheet row is one event; Rust decides what it does (a capture asks this
    /// shell for a picker, Follow a folder for its folder picker). A row that
    /// opens a page carries its `route`, which the shell pushes.
    private func sheetActions(_ state: Centraid_Core_V1_DocsDriveState) -> DocsSheetActions {
        DocsSheetActions(
            onAction: { action in
                send(Self.event { $0.action = .with { $0.key = action.key } })
                if action.hasRoute { open(action.route) }
            },
            onChoice: { key in send(Self.event { $0.choice = .with { $0.key = key } }) },
            onLabelAdd: { label in send(Self.event { $0.labelAdded = .with { $0.label = label } }) },
            onLabelRemove: { tag in send(Self.event { $0.labelRemoved = .with { $0.tagID = tag } }) },
            onLabelDraft: { text in send(Self.event { $0.labelDraft = .with { $0.text = text } }) },
            onFolderName: { name in send(Self.event { $0.folderName = .with { $0.name = name } }) },
            onFolderCreate: { send(Self.event { $0.folderCreated = .init() }) }
        )
    }

    /// THE INGEST'S LINE (product-intuition/references/design-behaviour.md § Status line: one line, at most one text action, never
    /// clears itself): its words, a determinate bar while bytes move, Try again
    /// on a failure, and the close key once there is something to put away.
    @ViewBuilder
    private func ingestLine(_ line: Centraid_Core_V1_DocsIngestView) -> some View {
        if !line.statusLabel.isEmpty {
            let moving = line.phase == .picking || line.phase == .filing
            ProgressStatusLine(
                sentence: line.statusLabel,
                permille: moving ? line.progressPermille : nil,
                refused: line.phase == .failed,
                actionLabel: line.retryLabel,
                onAct: { send(Self.event { $0.ingestRetried = .init() }) },
                closeLabel: line.dismissLabel,
                onClose: { send(Self.event { $0.ingestDismissed = .init() }) },
                identifier: "docs-ingest"
            )
        }
    }

    /// THE OS GRANTS, REPORTED (law 4): the Add sheet offers, greys or drops
    /// Scan and Upload by what Rust hears here.
    private func reportPermissions() {
        let camera: Centraid_Core_V1_DocsPermission
        if !UIImagePickerController.isSourceTypeAvailable(.camera) {
            camera = .unavailable
        } else {
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: camera = .granted
            case .denied: camera = .denied
            case .restricted: camera = .restricted
            case .notDetermined: camera = .notAsked
            @unknown default: camera = .notAsked
            }
        }
        send(Self.event { $0.permission = .with { $0.surface = .camera; $0.permission = camera } })
        // The document picker needs no grant: it runs out of process.
        send(Self.event { $0.permission = .with { $0.surface = .files; $0.permission = .granted } })
    }

    private func sheetBinding(_ state: Centraid_Core_V1_DocsDriveState) -> Binding<Bool> {
        let open = state.sheet.kind != .none && state.sheet.kind != .unspecified
        return Binding(
            get: { open },
            set: { shown in
                guard !shown, open else { return }
                send(Self.event { $0.sheetClosed = .init() })
            }
        )
    }
}
