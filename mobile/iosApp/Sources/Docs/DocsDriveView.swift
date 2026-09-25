import SwiftUI
import AVFoundation
import UIKit

/// THE DRIVE — All · Folders · Starred, More as a sheet; and, pushed over it,
/// a folder's page (#1046).
///
/// **THE VIEW DECIDES NOTHING.** The band, the pills and whether they are
/// lit, the list-or-grid layout, every sheet's rows and enabled flags, the
/// empty and its one action, the head's subtitle: all `DocsDriveState`. What
/// is here is geometry, the events, and the INTENTS the machine leaves to the
/// shell — a folder, a document, the trash, and capture.
struct DocsDriveView: View {
    let data: Data
    /// The registry id this page's bridge answers to.
    let screen: String
    /// `nil` on the drive (an app place with the band); the parent's name on a
    /// folder page (a pushed page).
    let parentTitle: String?
    let send: (Data) -> Void
    let push: (ShellModel.Route) -> Void
    let onBack: () -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_DocsDriveState {
        (try? Centraid_Screen_V1_DocsDriveState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_DocsDriveEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_DocsDriveEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_DocsDriveState) -> ScreenContent<Centraid_Screen_V1_DocsDriveData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        let content = content(state)
        Group {
            if let parentTitle {
                PushedPage(title: state.folderName, parentTitle: parentTitle, onBack: onBack) {
                    addButton(state, content)
                } content: {
                    VStack(spacing: 0) {
                        if state.search.open {
                            CentraidSearchField(
                                field: state.search,
                                placeholder: state.chrome.searchPlaceholder,
                                closeLabel: state.chrome.searchClose,
                                identifier: "docs-search",
                                onTerm: { term in send(Self.event { $0.searchTerm = .with { $0.term = term } }) },
                                onClose: { send(Self.event { $0.searchClosed = .init() }) }
                            )
                            .padding(.horizontal, CentraidGeometry.pageMargin)
                            .padding(.bottom, 8)
                        }
                        page(state, content)
                    }
                }
            } else {
                AppPlace(
                    app: "docs",
                    title: state.chrome.title,
                    search: SearchSlot(
                        field: state.search,
                        placeholder: state.chrome.searchPlaceholder,
                        closeLabel: state.chrome.searchClose,
                        onTerm: { term in send(Self.event { $0.searchTerm = .with { $0.term = term } }) },
                        onClose: { send(Self.event { $0.searchClosed = .init() }) }
                    ),
                    showsBand: !content.isDenied
                ) {
                    addButton(state, content)
                } band: {
                    AppBand(
                        app: "docs",
                        tabs: state.band.map { tab in
                            BandView(
                                label: tab.label,
                                event: Self.event { $0.band = .with { $0.key = tab.key } },
                                iconKey: tab.iconKey,
                                selected: tab.current
                            )
                        },
                        onSelect: send,
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
        .onAppear(perform: reportPermissions)
    }

    @ViewBuilder
    private func addButton(
        _ state: Centraid_Screen_V1_DocsDriveState,
        _ content: ScreenContent<Centraid_Screen_V1_DocsDriveData>
    ) -> some View {
        if !content.isDenied, !state.chrome.add.isEmpty {
            Button {
                send(Self.event { $0.sheetOpened = .with { $0.kind = .add } })
            } label: {
                Text(state.chrome.add)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                    .padding(.horizontal, 8)
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("docs-add")
        }
    }

    // MARK: The page

    private func page(
        _ state: Centraid_Screen_V1_DocsDriveState,
        _ content: ScreenContent<Centraid_Screen_V1_DocsDriveData>
    ) -> some View {
        VStack(spacing: 0) {
            if !content.isDenied { controls(state) }
            DocsWriteLine(write: state.write)
            if let rename = DocsRenameOpen.of(state.hasRename, state.rename) {
                DocsRenameField(
                    rename: rename,
                    placeholder: state.chrome.renamePlaceholder,
                    doneLabel: state.chrome.renameDone,
                    onEdit: { title in send(Self.event { $0.renameEdited = .with { $0.title = title } }) },
                    onClose: { send(Self.event { $0.renameClosed = .init() }) }
                )
                .id(rename.documentID)
            }
            ReadStateView(
                content: content,
                loadingLabel: state.chrome.loading,
                onRetry: { send(Self.event { $0.refreshed = .init() }) }
            ) { drive in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if !drive.crumbs.isEmpty, parentTitle != nil { crumbs(drive.crumbs) }
                        ForEach(drive.folders, id: \.folderID) { node in
                            folderRow(node)
                        }
                        if drive.hasEmpty {
                            EmptyStateView(drive.empty, onAction: emptyAction(drive.emptyAction))
                        } else if state.layout == .grid {
                            grid(drive.rows, state)
                        } else {
                            ForEach(drive.rows, id: \.documentID) { row in
                                DocsRowItem(
                                    row: row,
                                    starredLabel: state.chrome.starred,
                                    menuLabel: state.chrome.rowMenu,
                                    onTap: { open(row) },
                                    onMenu: { send(Self.event { $0.rowMenu = .with { $0.documentID = row.documentID } }) }
                                )
                            }
                        }
                        note(drive.shelfNote)
                        note(drive.truncatedNote)
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
                state.confirm,
                onConfirm: { send(Self.event { $0.confirmed = .init() }) },
                onDismiss: { send(Self.event { $0.dismissed = .init() }) }
            )
        }
    }

    /// The head's subtitle, the search opener, the filter pills, Clear and the
    /// layout toggle — one scrolling row.
    private func controls(_ state: Centraid_Screen_V1_DocsDriveState) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if !state.headMeta.isEmpty {
                Text(state.headMeta)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .padding(.horizontal, CentraidGeometry.pageMargin)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if !state.search.open {
                        iconControl("Search", state.chrome.searchLabel, "docs-search-open") {
                            send(Self.event { $0.searchOpened = .init() })
                        }
                    }
                    ForEach(state.pills, id: \.key) { pill in
                        Button {
                            send(Self.event { $0.sheetOpened = .with { $0.kind = pill.key } })
                        } label: {
                            HStack(spacing: 4) {
                                Text(pill.label)
                                    .centraidType("annotLabelOn")
                                    .foregroundStyle(Theme.color(pill.active ? "onAccent" : "text", scheme))
                                CentraidIconView(
                                    iconKey: "ChevronDown",
                                    tint: Theme.color(pill.active ? "onAccent" : "textSoft", scheme),
                                    size: 10
                                )
                                .accessibilityHidden(true)
                            }
                            .padding(.horizontal, 12)
                            .frame(minHeight: CentraidGeometry.targetMinFine)
                            .background(Capsule().fill(Theme.color(pill.active ? "accent" : "bgSunken", scheme)))
                            .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(pill.accessibilityLabel.isEmpty ? pill.label : pill.accessibilityLabel)
                        .accessibilityAddTraits(pill.active ? .isSelected : [])
                        .accessibilityIdentifier("docs-pill-\(pill.key.rawValue)")
                    }
                    if state.filtersActive, !state.chrome.filtersClearLabel.isEmpty {
                        Button {
                            send(Self.event { $0.filtersCleared = .init() })
                        } label: {
                            Text(state.chrome.filtersClearLabel)
                                .centraidType("annotLabelOn")
                                .foregroundStyle(Theme.color("link", scheme))
                                .padding(.horizontal, 8)
                                .frame(minHeight: CentraidGeometry.targetMinFine)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("docs-clear-filters")
                    }
                    iconControl(
                        state.chrome.layoutIconKey.isEmpty ? "Grid" : state.chrome.layoutIconKey,
                        state.chrome.layoutToggle,
                        "docs-layout"
                    ) {
                        send(Self.event { $0.layoutToggled = .init() })
                    }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
            }
        }
        .padding(.vertical, 6)
    }

    private func iconControl(_ icon: String, _ label: String, _ identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            CentraidIconView(iconKey: icon, tint: Theme.color("text", scheme), size: 16)
                .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinFine)
                .background(Capsule().fill(Theme.color("bgSunken", scheme)))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    private func crumbs(_ crumbs: [Centraid_Screen_V1_DocsCrumb]) -> some View {
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

    private func folderRow(_ node: Centraid_Screen_V1_DocsFolderNode) -> some View {
        Button {
            send(Self.event { $0.folderPicked = .with { $0.folderID = node.folderID; $0.name = node.name } })
            push(DocsScreens.folderRoute(node.folderID, node.name))
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

    private func grid(_ rows: [Centraid_Screen_V1_DocsRowView], _ state: Centraid_Screen_V1_DocsDriveState) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], spacing: 8) {
            ForEach(rows, id: \.documentID) { row in
                Button {
                    open(row)
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

    // MARK: Events and intents

    private func open(_ row: Centraid_Screen_V1_DocsRowView) {
        send(Self.event {
            $0.documentPicked = .with { $0.documentID = row.documentID; $0.title = row.title; $0.surface = row.surface }
        })
        push(DocsScreens.documentRoute(row.documentID, row.title))
    }

    private func emptyAction(_ action: Centraid_Screen_V1_DocsDriveData.EmptyAction) -> (() -> Void)? {
        switch action {
        case .add: return { send(Self.event { $0.sheetOpened = .with { $0.kind = .add } }) }
        case .clearFilters: return { send(Self.event { $0.filtersCleared = .init() }) }
        case .newFolder: return { send(Self.event { $0.sheetOpened = .with { $0.kind = .newFolder } }) }
        case .none, .unspecified, .UNRECOGNIZED: return nil
        }
    }

    private func sheetActions(_ state: Centraid_Screen_V1_DocsDriveState) -> DocsSheetActions {
        DocsSheetActions(
            onAction: { action in
                // The keys are `DocsWrites.KEY_*`. Capture and the trash are
                // the shell's; everything else is the machine's.
                switch (state.sheet.kind, action.key) {
                case (.add, "upload"): addRequested(.upload, state)
                case (.add, "scan"): addRequested(.scan, state)
                case (.add, "text"): addRequested(.text, state)
                case (.more, "trash_shelf"):
                    send(Self.event { $0.trashOpened = .init() })
                    push(DocsScreens.trashRoute)
                default:
                    send(Self.event { $0.action = .with { $0.key = action.key } })
                }
            },
            onChoice: { key in send(Self.event { $0.choice = .with { $0.key = key } }) },
            onLabelAdd: { label in send(Self.event { $0.labelAdded = .with { $0.label = label } }) },
            onLabelRemove: { tag in send(Self.event { $0.labelRemoved = .with { $0.tagID = tag } }) },
            onLabelDraft: { text in send(Self.event { $0.labelDraft = .with { $0.text = text } }) },
            onFolderName: { name in send(Self.event { $0.folderName = .with { $0.name = name } }) },
            onFolderCreate: { send(Self.event { $0.folderCreated = .init() }) }
        )
    }

    /// CAPTURE IS THE OS'S. The event closes the sheet; the capture itself is
    /// not wired: nothing on the shared side takes picked or scanned bytes
    /// into `core.add_document` for Docs (Staging is Photos' pipe), and a file
    /// importer whose file went nowhere would be a door that lies.
    private func addRequested(
        _ kind: Centraid_Screen_V1_DocsDriveEvent.AddRequested.Kind,
        _ state: Centraid_Screen_V1_DocsDriveState
    ) {
        send(Self.event { $0.addRequested = .with { $0.kind = kind; $0.folderID = state.folderID } })
        // TODO(intent): AddRequested UPLOAD → `.fileImporter`; SCAN →
        // VisionKit `VNDocumentCameraViewController`; TEXT → a new text
        // document opened in `docs.editor`. Each needs an ingest (or create)
        // call on the shared side before the shell can hand it anything.
    }

    /// THE OS GRANTS, REPORTED (law 4): the Add sheet offers, greys or drops
    /// Scan and Upload by what the machine hears here.
    private func reportPermissions() {
        let camera: Centraid_Screen_V1_DocsCapture.Permission
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

    private func sheetBinding(_ state: Centraid_Screen_V1_DocsDriveState) -> Binding<Bool> {
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

/// An open inline rename, or nothing.
enum DocsRenameOpen {
    static func of(_ present: Bool, _ rename: Centraid_Screen_V1_DocsRename) -> Centraid_Screen_V1_DocsRename? {
        guard present, !rename.closed, !rename.documentID.isEmpty else { return nil }
        return rename
    }
}
