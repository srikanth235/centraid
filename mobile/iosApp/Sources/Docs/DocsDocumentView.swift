import AVKit
import PDFKit
import SwiftUI

/// ONE DOCUMENT'S PAGE (#1046, #1135): its surface — the reader (text), the
/// stage (image, video, PDF), facts only, or gone — then its path, facts, a row
/// to its version history, activity, and the verbs Rust offers.
///
/// **THE VIEW DECIDES NOTHING.** Which verbs exist and whether each is
/// enabled are `DocsDocumentData.actions`; the editor, a crumb's folder and the
/// version history are routes the data carries, which a tap pushes.
struct DocsDocumentView: View {
    let state: Centraid_Core_V1_DocsDocumentState
    let send: (Centraid_Core_V1_DocsDocumentEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    static func event(_ build: (inout Centraid_Core_V1_DocsDocumentEvent) -> Void) -> Centraid_Core_V1_DocsDocumentEvent {
        var event = Centraid_Core_V1_DocsDocumentEvent()
        build(&event)
        return event
    }

    private func content(_ state: Centraid_Core_V1_DocsDocumentState) -> ScreenContent<Centraid_Core_V1_DocsDocumentData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        let content = content(state)
        let document: Centraid_Core_V1_DocsDocumentData? = {
            if case let .data(document) = content { return document }
            return nil
        }()
        let title = (document?.hasRow ?? false) && !(document?.row.title.isEmpty ?? true)
            ? document!.row.title
            : state.titleHint
        PushedPage(title: title, parentTitle: state.chrome.back, onBack: onBack) {
            if let document, !document.actions.isEmpty {
                ToolbarIcon(
                    iconKey: "MoreHoriz",
                    label: state.chrome.more,
                    identifier: "docs-document-more"
                ) {
                    send(Self.event { $0.moreOpened = .init() })
                }
            }
        } content: {
            VStack(spacing: 0) {
                DocsWriteLine(status: state.status)
                if state.hasRename {
                    DocsRenameField(
                        rename: state.rename,
                        placeholder: state.chrome.renamePlaceholder,
                        doneLabel: state.chrome.renameDone,
                        onEdit: { text in send(Self.event { $0.renameEdited = .with { $0.title = text } }) },
                        onClose: { send(Self.event { $0.renameClosed = .init() }) }
                    )
                }
                ReadStateView(
                    content: content,
                    loadingLabel: state.chrome.loading,
                    onRetry: { send(Self.event { $0.refreshed = .init() }) }
                ) { document in
                    if case let .gone(empty)? = document.surface {
                        EmptyStateView(empty.legacy)
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                if !document.trashedNote.isEmpty {
                                    Text(document.trashedNote)
                                        .centraidType("small")
                                        .foregroundStyle(Theme.color("net", scheme))
                                        .padding(.horizontal, CentraidGeometry.pageMargin)
                                        .padding(.vertical, 8)
                                }
                                surface(document)
                                if !document.path.isEmpty { path(document.path) }
                                if !document.facts.isEmpty {
                                    SectionHeader(title: state.chrome.factsHeading)
                                    // Ids prefixed per list: facts and activity share one
                                    // `LazyVStack`, where equal offset ids collide.
                                    ForEach(Array(document.facts.enumerated()).map { ("fact-\($0.offset)", $0.element) }, id: \.0) { _, fact in
                                        FieldRow(key: fact.label, value: fact.detail)
                                    }
                                }
                                if document.hasVersions { versionsRow(document.versions) }
                                SectionHeader(title: state.chrome.activityHeading)
                                if document.activity.isEmpty, !document.activityEmpty.isEmpty {
                                    Text(document.activityEmpty)
                                        .centraidType("annotLabel")
                                        .foregroundStyle(Theme.color("textSoft", scheme))
                                        .padding(.horizontal, CentraidGeometry.pageMargin)
                                        .padding(.vertical, 6)
                                }
                                ForEach(Array(document.activity.enumerated()).map { ("activity-\($0.offset)", $0.element) }, id: \.0) { _, row in
                                    CentraidRow(title: row.label, meta: row.meta)
                                }
                            }
                            .padding(.bottom, 16)
                        }
                        .refreshable { send(Self.event { $0.refreshed = .init() }) }
                    }
                }
            }
        }
        // DELETED FOREVER here (`dismissed`): Rust says the page is done.
        .onChange(of: state.dismissed) { _, dismissed in
            if dismissed { onBack() }
        }
        // THE STATE'S SHEET — More (`MoreOpened` → `KIND_MORE`), a move, the
        // labels — and, on a second host so they never share a presenter,
        // its confirm.
        .sheet(isPresented: sheetBinding(state)) {
            DocsSheetView(sheet: state.sheet, actions: sheetActions())
        }
        .background {
            Color.clear.sheet(isPresented: Binding(
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
    }

    // MARK: Surface

    @ViewBuilder
    private func surface(_ document: Centraid_Core_V1_DocsDocumentData) -> some View {
        switch document.surface {
        case let .reading(reader)?:
            VStack(alignment: .leading, spacing: 12) {
                if !reader.hasText_p {
                    Text(reader.noText)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                } else if reader.body.isEmpty {
                    Text(reader.emptyBody)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                } else if reader.format == .markdown,
                          let rich = try? AttributedString(
                              markdown: reader.body,
                              options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
                          ) {
                    Text(rich)
                        .centraidType("reading")
                        .foregroundStyle(Theme.color("text", scheme))
                        .textSelection(.enabled)
                } else {
                    Text(reader.body)
                        .centraidType("reading")
                        .foregroundStyle(Theme.color("text", scheme))
                        .textSelection(.enabled)
                }
                // EDIT IS THE HEAD'S `edit` ACTION: its route is the editor.
                if reader.editable, !reader.editLabel.isEmpty,
                   let edit = document.actions.first(where: { $0.key == "edit" }), edit.hasRoute {
                    KitOutlineButton(label: reader.editLabel) { open(edit.route) }
                        .accessibilityIdentifier("docs-document-edit")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(CentraidGeometry.pageMargin)
            .accessibilityIdentifier("docs-reader")
        case let .stage(stage)?:
            DocsStageCard(stage: stage)
        case let .factsOnly(facts)?:
            Text(facts.sentence)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(CentraidGeometry.pageMargin)
        case .gone, nil:
            EmptyView()
        }
    }

    private func path(_ crumbs: [Centraid_Core_V1_DocsCrumb]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(Array(crumbs.enumerated()), id: \.offset) { index, crumb in
                    if index > 0 {
                        CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme), size: 10)
                            .accessibilityHidden(true)
                    }
                    KitLink(label: crumb.name, dense: true, identifier: "docs-crumb-\(crumb.folderID)") {
                        if crumb.hasRoute { open(crumb.route) }
                    }
                    .disabled(crumb.folderID.isEmpty)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 4)
        }
    }

    /// THE VERSION HISTORY'S ROW: its words, how many, and the page it opens.
    private func versionsRow(_ versions: Centraid_Core_V1_DocsVersionsLink) -> some View {
        Button {
            open(versions.route)
        } label: {
            HStack(spacing: 12) {
                Text(versions.label)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                Spacer(minLength: 8)
                Text(versions.countLabel)
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
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("docs-versions")
    }

    // MARK: Events

    /// A verb picked from a sheet is `ActionPicked` (which closes it); `edit`
    /// carries the editor's route, as it does from the head.
    private func sheetActions() -> DocsSheetActions {
        DocsSheetActions(
            onAction: { action in
                send(Self.event { $0.action = .with { $0.key = action.key } })
                if action.hasRoute { open(action.route) }
            },
            onChoice: { key in send(Self.event { $0.choice = .with { $0.key = key } }) },
            onLabelAdd: { label in send(Self.event { $0.labelAdded = .with { $0.label = label } }) },
            onLabelRemove: { tag in send(Self.event { $0.labelRemoved = .with { $0.tagID = tag } }) },
            onLabelDraft: { text in send(Self.event { $0.labelDraft = .with { $0.text = text } }) }
        )
    }

    private func sheetBinding(_ state: Centraid_Core_V1_DocsDocumentState) -> Binding<Bool> {
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

/// THE STAGE: an image, a PDF, audio or video the vault holds — or why it
/// does not (#1047, R-1047-Q4).
///
/// `bytes_path` is the file on this device, set by the core only when the
/// bytes are here and the type may be drawn inline; the view hands it to the
/// platform's renderer `media` names — an image view, `PDFView`, or the AV
/// player. With no path, the card says what the stage holds (its spoken
/// label) or, absent, why.
struct DocsStageCard: View {
    let stage: Centraid_Core_V1_DocsStage

    @Environment(\.colorScheme) private var scheme

    private var iconKey: String {
        switch stage.media {
        case .image: return "Image"
        case .pdf: return "FileText"
        case .audio: return "Music"
        case .video: return "Play"
        case .unspecified, .UNRECOGNIZED: return "FileText"
        }
    }

    var body: some View {
        if stage.held, !stage.bytesPath.isEmpty {
            drawn
                .frame(maxWidth: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                        .fill(Theme.color("bgSunken", scheme))
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
                .padding(CentraidGeometry.pageMargin)
                .accessibilityElement(children: .contain)
                .accessibilityLabel(stage.accessibilityLabel)
                .accessibilityIdentifier("docs-stage")
        } else {
            VStack(spacing: 10) {
                CentraidIconView(iconKey: iconKey, tint: Theme.color("textSoft", scheme), size: 32)
                    .accessibilityHidden(true)
                Text(stage.held ? stage.accessibilityLabel : stage.absentReason)
                    .centraidType("small")
                    .foregroundStyle(Theme.color(stage.held ? "text" : "textSoft", scheme))
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, minHeight: 200)
            .padding(CentraidGeometry.pageMargin)
            .background(
                RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                    .fill(Theme.color("bgSunken", scheme))
            )
            .padding(CentraidGeometry.pageMargin)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("docs-stage")
        }
    }

    @ViewBuilder
    private var drawn: some View {
        let url = URL(fileURLWithPath: stage.bytesPath)
        switch stage.media {
        case .image:
            if let image = UIImage(contentsOfFile: stage.bytesPath) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 480)
            } else {
                Color.clear.frame(height: 200)
            }
        case .pdf:
            DocsPDFStage(url: url).frame(height: 480)
        case .video:
            DocsPlayerStage(url: url).frame(height: 280)
        case .audio:
            DocsPlayerStage(url: url).frame(height: 88)
        case .unspecified, .UNRECOGNIZED:
            Color.clear.frame(height: 200)
        }
    }
}

/// Audio or video on the stage: one player for the file, held across redraws.
struct DocsPlayerStage: View {
    let url: URL
    @State private var player: AVPlayer?

    var body: some View {
        VideoPlayer(player: player)
            .onAppear { if player == nil { player = AVPlayer(url: url) } }
            .onDisappear { player?.pause() }
    }
}

/// A PDF on the stage: PDFKit's own view, fitted to its width.
struct DocsPDFStage: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.backgroundColor = .clear
        view.document = PDFDocument(url: url)
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        if view.document?.documentURL != url { view.document = PDFDocument(url: url) }
    }
}

// MARK: - Version history

/// A DOCUMENT'S VERSIONS (`docs.versions`): newest first, the current one
/// marked, an earlier one of a live document restorable. Every word, and
/// whether a row offers Restore at all, is Rust's.
struct DocsVersionsView: View {
    let state: Centraid_Core_V1_DocsVersionsState
    let send: (Centraid_Core_V1_DocsVersionsEvent) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    static func event(_ build: (inout Centraid_Core_V1_DocsVersionsEvent) -> Void) -> Centraid_Core_V1_DocsVersionsEvent {
        var event = Centraid_Core_V1_DocsVersionsEvent()
        build(&event)
        return event
    }

    private func content(_ state: Centraid_Core_V1_DocsVersionsState) -> ScreenContent<Centraid_Core_V1_DocsVersionsData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        PushedPage(title: state.chrome.heading, parentTitle: state.chrome.back, onBack: onBack) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                DocsWriteLine(status: state.status)
                ReadStateView(
                    content: content(state),
                    loadingLabel: state.chrome.loading,
                    onRetry: { send(Self.event { $0.refreshed = .init() }) }
                ) { data in
                    if data.hasEmpty {
                        EmptyStateView(data.empty.legacy)
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(data.versions, id: \.key) { version in
                                    HStack(spacing: 8) {
                                        CentraidRow(title: version.label, meta: version.meta, dimmed: !version.current)
                                        if !version.restoreLabel.isEmpty {
                                            KitLink(
                                                label: version.restoreLabel,
                                                dense: true,
                                                identifier: "docs-version-restore-\(version.key)"
                                            ) {
                                                send(Self.event { $0.restored = .with { $0.key = version.key } })
                                            }
                                        }
                                    }
                                    .padding(.trailing, 8)
                                }
                            }
                            .padding(.bottom, 16)
                        }
                        .refreshable { send(Self.event { $0.refreshed = .init() }) }
                    }
                }
            }
        }
    }
}

// MARK: - Editor

/// THE TEXT EDITOR: an `EditorRoom` — autosave, close = done, the status line
/// hosted inside. Leaving by any route is a `NavPopped` the shell reports,
/// which Rust turns into the screen's `Left`: the flush of unsaved words.
struct DocsEditorView: View {
    let state: Centraid_Core_V1_DocsEditorState
    let send: (Centraid_Core_V1_DocsEditorEvent) -> Void
    let onClose: () -> Void

    /// THE ONLY PLACE A KEYSTROKE EXISTS BEFORE RUST HEARS IT — seeded
    /// once from the draft, never again (see `NotesEditorView`).
    @State private var typedTitle = ""
    @State private var typedBody = ""
    @State private var seeded = false
    @Environment(\.colorScheme) private var scheme

    static func event(_ build: (inout Centraid_Core_V1_DocsEditorEvent) -> Void) -> Centraid_Core_V1_DocsEditorEvent {
        var event = Centraid_Core_V1_DocsEditorEvent()
        build(&event)
        return event
    }

    private func content(_ state: Centraid_Core_V1_DocsEditorState) -> ScreenContent<Centraid_Core_V1_DocsEditorDraft> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .draft(draft)?: return .data(draft)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        let chrome = state.chrome
        EditorRoom(
            title: typedTitle.isEmpty ? state.titleHint : typedTitle,
            status: state.autosave.legacy,
            closeLabel: chrome.done,
            onClose: onClose,
            onDeparted: {}
        ) {
            EmptyView()
        } content: {
            ReadStateView(
                content: content(state),
                skeleton: { RowSkeleton(rows: 4, meta: false, label: chrome.loading) },
                onRetry: { send(Self.event { $0.refreshed = .init() }) }
            ) { draft in
                VStack(alignment: .leading, spacing: 8) {
                    let notes = [state.versionLabel, state.statusLabel, state.remoteNote].filter { !$0.isEmpty }
                    ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                        Text(note)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                    }
                    TextField(chrome.titlePlaceholder, text: $typedTitle)
                        .centraidType("title")
                        .foregroundStyle(Theme.color("text", scheme))
                        .accessibilityIdentifier("docs-editor-title")
                        .onChange(of: typedTitle) { _, typed in
                            guard seeded, typed != draft.title else { return }
                            send(Self.event { $0.title = .with { $0.title = typed } })
                        }
                    ZStack(alignment: .topLeading) {
                        if typedBody.isEmpty {
                            Text(chrome.bodyPlaceholder)
                                .centraidType("reading")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                                .padding(.top, 8)
                                .padding(.leading, 5)
                                .accessibilityHidden(true)
                        }
                        TextEditor(text: $typedBody)
                            .centraidType("reading")
                            .foregroundStyle(Theme.color("text", scheme))
                            .scrollContentBackground(.hidden)
                            .accessibilityLabel(chrome.bodyPlaceholder)
                            .accessibilityIdentifier("docs-editor-body")
                            .onChange(of: typedBody) { _, typed in
                                guard seeded, typed != draft.body else { return }
                                send(Self.event { $0.body = .with { $0.body = typed } })
                            }
                    }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .onAppear {
                    if !seeded {
                        typedTitle = draft.title
                        typedBody = draft.body
                        seeded = true
                    }
                }
            }
        }
    }
}
