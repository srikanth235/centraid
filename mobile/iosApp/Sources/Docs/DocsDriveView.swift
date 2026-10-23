import SwiftUI
import AVFoundation
import UIKit

import CentraidShared

/// THE DRIVE — All · Folders · Starred, More as a sheet; and, pushed over it,
/// a folder's page (#1046, #1135).
///
/// **THE VIEW DECIDES NOTHING.** The band, the pills and whether they are
/// lit, the list-or-grid layout, every sheet's rows and enabled flags, the
/// empty and its one action, the head's subtitle: all `DocsDriveState`, which
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

    private func content(_ state: Centraid_Core_V1_DocsDriveState) -> ScreenContent<Centraid_Core_V1_DocsDriveData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    /// Rust's search flag and term, as the kit's field state.
    private func searchField(_ state: Centraid_Core_V1_DocsDriveState) -> Centraid_Screen_V1_SearchField {
        var field = Centraid_Screen_V1_SearchField()
        field.open = state.search.open
        field.term = state.search.term
        field.corrected = state.search.corrected
        return field
    }

    var body: some View {
        let state = state
        let content = content(state)
        Group {
            if isFolderPage {
                PushedPage(title: state.folderName, parentTitle: state.chrome.back, onBack: onBack) {
                    RoomTrailing(action: addAction(state, content))
                } content: {
                    // A FOLDER PAGE IS NOT A ROOM, so it draws the room's
                    // search bar and chip row itself, in the room's order.
                    VStack(spacing: 0) {
                        Group {
                            if state.search.open {
                                CentraidSearchField(
                                    field: searchField(state),
                                    placeholder: state.chrome.searchPlaceholder,
                                    closeLabel: state.chrome.searchClose,
                                    identifier: "docs-search",
                                    onTerm: { term in send(Self.event { $0.searchTerm = .with { $0.term = term } }) },
                                    onClose: { send(Self.event { $0.searchClosed = .init() }) }
                                )
                            } else if !content.isDenied {
                                SearchOpener(
                                    placeholder: state.chrome.searchPlaceholder,
                                    identifier: "docs-search-open",
                                    onOpen: { send(Self.event { $0.searchOpened = .init() }) }
                                )
                            }
                        }
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.top, 4)
                        .padding(.bottom, 8)
                        let row = self.chips(state, content)
                        if !row.isEmpty {
                            RoomChipRow(app: "docs", chips: row)
                                .padding(.bottom, 4)
                        }
                        page(state, content)
                    }
                }
            } else {
                AppPlace(
                    app: "docs",
                    title: state.chrome.title,
                    trailing: addAction(state, content),
                    search: SearchSlot(
                        field: searchField(state),
                        placeholder: state.chrome.searchPlaceholder,
                        closeLabel: state.chrome.searchClose,
                        onOpen: { send(Self.event { $0.searchOpened = .init() }) },
                        onTerm: { term in send(Self.event { $0.searchTerm = .with { $0.term = term } }) },
                        onClose: { send(Self.event { $0.searchClosed = .init() }) }
                    ),
                    chips: chips(state, content),
                    showsBand: !content.isDenied
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
                    page(state, content)
                }
            }
        }
        .sheet(isPresented: sheetBinding(state)) {
            DocsSheetView(sheet: state.sheet, actions: sheetActions(state))
        }
        .onAppear {
            reportPermissions()
            reportFollowed()
        }
    }

    /// THE ONE TRAILING ACTION (R-CHROME-1): the Plus, said as the state's
    /// add label; it opens the Add sheet.
    private func addAction(
        _ state: Centraid_Core_V1_DocsDriveState,
        _ content: ScreenContent<Centraid_Core_V1_DocsDriveData>
    ) -> RoomAction? {
        guard !content.isDenied, !state.chrome.add.isEmpty else { return nil }
        return RoomAction(iconKey: "Plus", label: state.chrome.add, identifier: "docs-add") {
            send(Self.event { $0.sheetOpened = .with { $0.kind = .add } })
        }
    }

    /// THE CHIP ROW (R-CHROME-3), Rust's pills as they come: the filters,
    /// Clear while one is set, the sort last.
    private func chips(
        _ state: Centraid_Core_V1_DocsDriveState,
        _ content: ScreenContent<Centraid_Core_V1_DocsDriveData>
    ) -> [RoomChip] {
        guard !content.isDenied else { return [] }
        return state.pills.map { pill in
            RoomChip(
                identifier: pill.clears ? "docs-clear-filters" : "docs-pill-\(pill.key.rawValue)",
                label: pill.label,
                selected: pill.active,
                chevron: pill.chevron,
                spoken: pill.accessibilityLabel.isEmpty ? pill.label : pill.accessibilityLabel
            ) {
                if pill.clears {
                    send(Self.event { $0.filtersCleared = .init() })
                } else {
                    send(Self.event { $0.sheetOpened = .with { $0.kind = pill.key } })
                }
            }
        }
    }

    // MARK: The page

    private func page(
        _ state: Centraid_Core_V1_DocsDriveState,
        _ content: ScreenContent<Centraid_Core_V1_DocsDriveData>
    ) -> some View {
        VStack(spacing: 0) {
            if !content.isDenied { controls(state) }
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
            ReadStateView(
                content: content,
                loadingLabel: state.chrome.loading,
                onRetry: { send(Self.event { $0.refreshed = .init() }) }
            ) { drive in
                ScrollView {
                  VStack(alignment: .leading, spacing: 0) {
                    // THE FOLDERS WHOSE NAME MATCHED come first (#1097): each pushes its route.
                    ForEach(drive.containers, id: \.id) { container in
                        SearchContainerRow(container: container.legacy) { _ in open(container.route) }
                    }
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if !drive.crumbs.isEmpty, isFolderPage { crumbs(drive.crumbs) }
                        ForEach(drive.folders, id: \.folderID) { node in
                            folderRow(node)
                        }
                        if drive.hasEmpty {
                            if drive.mode == .search {
                                // A SEARCH THAT FOUND NOTHING: the kit's one no-match state.
                                EmptyStateView(drive.empty.legacy)
                            } else {
                                EmptyStateView(drive.empty.legacy, onAction: emptyAction(drive.emptyAction))
                            }
                        } else if state.layout == .grid {
                            grid(drive.rows, state)
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
                    // THE ASK ROW closes a search's answer, matched or not (#1135).
                    if state.search.hasAskRow { SearchAskRow(ask: state.search.askRow.legacy) }
                  }
                  .padding(.bottom, 16)
                }
                .refreshable { send(Self.event { $0.refreshed = .init() }) }
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { send(Self.event { $0.dismissed = .init() }) } }
        )) {
            ConfirmSheet(
                state.confirm.legacy,
                onConfirm: { send(Self.event { $0.confirmed = .init() }) },
                onDismiss: { send(Self.event { $0.dismissed = .init() }) }
            )
        }
    }

    /// The head's subtitle and the layout toggle — one line over the list.
    /// Search and the chips are the room's (R-CHROME-2/3), drawn above.
    private func controls(_ state: Centraid_Core_V1_DocsDriveState) -> some View {
        HStack(spacing: 6) {
            Text(state.headMeta)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textFaint", scheme))
            Spacer(minLength: 0)
            iconControl(
                state.chrome.layoutIconKey.isEmpty ? "Grid" : state.chrome.layoutIconKey,
                state.chrome.layoutToggle,
                "docs-layout"
            ) {
                send(Self.event { $0.layoutToggled = .init() })
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 2)
    }

    private func iconControl(_ icon: String, _ label: String, _ identifier: String, action: @escaping () -> Void) -> some View {
        KitIconKey(iconKey: icon, label: label, framed: true, identifier: identifier, action: action)
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

    private func grid(_ rows: [Centraid_Core_V1_DocsRowView], _ state: Centraid_Core_V1_DocsDriveState) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], spacing: 8) {
            ForEach(rows, id: \.documentID) { row in
                Button {
                    open(row.route)
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        CentraidIconView(iconKey: row.kindIconKey, tint: Theme.color("textSoft", scheme), size: 28)
                            .frame(maxWidth: .infinity, minHeight: 72)
                            .background(
                                RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
                                    .fill(Theme.color("bgSunken", scheme))
                            )
                            .accessibilityHidden(true)
                        Text(row.title)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("text", scheme))
                            .lineLimit(2)
                        Text(row.meta)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                            .lineLimit(1)
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                            .strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.accessibilityLabel.isEmpty ? row.title : row.accessibilityLabel)
                .accessibilityAddTraits(.isButton)
                .accessibilityIdentifier("docs-row-\(row.documentID)")
                .contextMenu {
                    Button(state.chrome.rowMenu) {
                        send(Self.event { $0.rowMenu = .with { $0.documentID = row.documentID } })
                    }
                }
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
        case .clearFilters: return { send(Self.event { $0.filtersCleared = .init() }) }
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

    /// THE INGEST'S LINE (DESIGN.md: one line, at most one text action, never
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

    /// THE FOLDERS FOLLOWED, REPORTED (law 4): the More sheet lists them.
    private func reportFollowed() {
        DocsFollow.shared.followed { folders in
            send(Self.event {
                $0.followedChanged = .with {
                    $0.followed = folders.map { folder -> Centraid_Core_V1_DocsFollowed in
                        var followed = Centraid_Core_V1_DocsFollowed()
                        followed.originID = folder.phoneOrigin
                        followed.name = folder.name
                        followed.documents = folder.documents
                        return followed
                    }
                }
            })
        }
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
