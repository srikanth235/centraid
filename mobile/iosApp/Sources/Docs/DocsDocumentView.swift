import SwiftUI

/// ONE DOCUMENT'S PAGE (#1046): its surface — the reader (text), the stage
/// (image, video, PDF), facts only, or gone — then its path, facts, versions
/// (restore on an earlier one), activity, and the verbs the state offers.
///
/// **THE VIEW DECIDES NOTHING.** Which verbs exist and whether each is
/// enabled are `DocsDocumentData.actions`; a version's restore exists only
/// when its row carries a label. `edit` and a crumb are intents the shell
/// routes (`EditRequested`, `FolderPicked`).
struct DocsDocumentView: View {
    let data: Data
    let send: (Data) -> Void
    let push: (ShellModel.Route) -> Void
    let onBack: () -> Void
    let onDeparted: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_DocsDocumentState {
        (try? Centraid_Screen_V1_DocsDocumentState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_DocsDocumentEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_DocsDocumentEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_DocsDocumentState) -> ScreenContent<Centraid_Screen_V1_DocsDocumentData> {
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
        let document: Centraid_Screen_V1_DocsDocumentData? = {
            if case let .data(document) = content { return document }
            return nil
        }()
        let title = (document?.hasRow ?? false) && !(document?.row.title.isEmpty ?? true)
            ? document!.row.title
            : state.titleHint
        PushedPage(title: title, parentTitle: state.chrome.back, onBack: onBack) {
            if let document, !document.actions.isEmpty {
                Button {
                    send(Self.event { $0.moreOpened = .init() })
                } label: {
                    CentraidIconView(iconKey: "MoreHoriz", tint: Theme.color("text", scheme), size: 18)
                        .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(state.chrome.more)
                .accessibilityIdentifier("docs-document-more")
            }
        } content: {
            VStack(spacing: 0) {
                DocsWriteLine(write: state.write)
                if let rename = DocsRenameOpen.of(state.hasRename, state.rename) {
                    DocsRenameField(
                        rename: rename,
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
                        EmptyStateView(empty)
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
                                if !document.versions.isEmpty {
                                    SectionHeader(title: state.chrome.versionsHeading, count: UInt32(document.versions.count))
                                    ForEach(document.versions, id: \.contentID) { version in
                                        versionRow(version, state)
                                    }
                                }
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
        .onDisappear(perform: onDeparted)
        // THE STATE'S SHEET — More (`MoreOpened` → `KIND_MORE`), a move, the
        // labels — and, on a second host so they never share a presenter,
        // its confirm.
        .sheet(isPresented: sheetBinding(state)) {
            DocsSheetView(sheet: state.sheet, actions: sheetActions(document))
        }
        .background {
            Color.clear.sheet(isPresented: Binding(
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
    }

    // MARK: Surface

    @ViewBuilder
    private func surface(_ document: Centraid_Screen_V1_DocsDocumentData) -> some View {
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
                if reader.editable, !reader.editLabel.isEmpty {
                    KitOutlineButton(label: reader.editLabel) { edit(document) }
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

    private func path(_ crumbs: [Centraid_Screen_V1_DocsCrumb]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(Array(crumbs.enumerated()), id: \.offset) { index, crumb in
                    if index > 0 {
                        CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme), size: 10)
                            .accessibilityHidden(true)
                    }
                    Button {
                        send(Self.event { $0.folderPicked = .with { $0.folderID = crumb.folderID; $0.name = crumb.name } })
                        push(DocsScreens.folderRoute(crumb.folderID, crumb.name))
                    } label: {
                        Text(crumb.name)
                            .centraidType("annotLabelOn")
                            .foregroundStyle(Theme.color("link", scheme))
                            .frame(minHeight: CentraidGeometry.targetMinFine)
                    }
                    .buttonStyle(.plain)
                    .disabled(crumb.folderID.isEmpty)
                    .accessibilityIdentifier("docs-crumb-\(crumb.folderID)")
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 4)
        }
    }

    private func versionRow(
        _ version: Centraid_Screen_V1_DocsVersionRow,
        _ state: Centraid_Screen_V1_DocsDocumentState
    ) -> some View {
        HStack(spacing: 8) {
            CentraidRow(title: version.label, meta: version.meta, dimmed: !version.current)
            if !version.restoreLabel.isEmpty {
                Button {
                    send(Self.event { $0.versionRestore = .with { $0.contentID = version.contentID } })
                } label: {
                    Text(version.restoreLabel)
                        .centraidType("annotLabelOn")
                        .foregroundStyle(Theme.color("link", scheme))
                        .frame(minWidth: CentraidGeometry.targetMinCoarse, minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(state.write.phase == .inFlight)
                .accessibilityIdentifier("docs-version-restore-\(version.contentID)")
            }
        }
        .padding(.trailing, 8)
    }

    // MARK: Events and intents

    private func edit(_ document: Centraid_Screen_V1_DocsDocumentData) {
        let id = document.row.documentID
        send(Self.event { $0.editRequested = .with { $0.documentID = id; $0.title = document.row.title } })
        push(DocsScreens.editorRoute(id, document.row.title))
    }

    /// A verb picked from a sheet is `ActionPicked` (which closes it) — and
    /// `edit` is also the shell's route, as it is from the head.
    private func sheetActions(_ document: Centraid_Screen_V1_DocsDocumentData?) -> DocsSheetActions {
        DocsSheetActions(
            onAction: { action in
                if action.key == "edit", let document {
                    send(Self.event { $0.action = .with { $0.key = action.key } })
                    edit(document)
                } else {
                    send(Self.event { $0.action = .with { $0.key = action.key } })
                }
            },
            onChoice: { key in send(Self.event { $0.choice = .with { $0.key = key } }) },
            onLabelAdd: { label in send(Self.event { $0.labelAdded = .with { $0.label = label } }) },
            onLabelRemove: { tag in send(Self.event { $0.labelRemoved = .with { $0.tagID = tag } }) },
            onLabelDraft: { text in send(Self.event { $0.labelDraft = .with { $0.text = text } }) }
        )
    }

    private func sheetBinding(_ state: Centraid_Screen_V1_DocsDocumentState) -> Binding<Bool> {
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
/// does not.
///
/// The bytes are not drawn yet: `DocsStage` names a `content_id` and no file
/// path, and the byte door that answers Photos with a path is not exposed for
/// Docs on the shared side. The card says what the stage holds (its spoken
/// label) until a path arrives; an absent one says why.
struct DocsStageCard: View {
    let stage: Centraid_Screen_V1_DocsStage

    @Environment(\.colorScheme) private var scheme

    private var iconKey: String {
        switch stage.media {
        case .image: return "Image"
        case .pdf: return "FileText"
        case .audio: return "Music"
        case .video: return "Play"
        case .unspecified, .UNRECOGNIZED: return "File"
        }
    }

    var body: some View {
        VStack(spacing: 10) {
            CentraidIconView(iconKey: iconKey, tint: Theme.color("textSoft", scheme), size: 32)
                .accessibilityHidden(true)
            Text(stage.held ? stage.accessibilityLabel : stage.absentReason)
                .centraidType("small")
                .foregroundStyle(Theme.color(stage.held ? "text" : "textSoft", scheme))
                .multilineTextAlignment(.center)
            // TODO(intent): draw the held bytes (`ContentImage` / the
            // lightbox's `StageImage` for an image, `PDFView` for a PDF,
            // `PlayerSurface` for video) once `DocsStage` carries a path.
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

// MARK: - Editor

/// THE TEXT EDITOR: an `EditorRoom` — autosave, close = done, the status line
/// hosted inside. Leaving by any route is `onDeparted`, the bridge's
/// `departed()`, which flushes unsaved words.
struct DocsEditorView: View {
    let data: Data
    /// The route's `Opened`. ONE BRIDGE SERVES EVERY DOCUMENT: until the state
    /// is about this one, the last document's draft is still held, and seeding
    /// from it would put one document's words in another's fields.
    var opened: Data = Data()
    let send: (Data) -> Void
    let onClose: () -> Void
    let onDeparted: () -> Void

    /// THE ONLY PLACE A KEYSTROKE EXISTS BEFORE THE MACHINE HEARS IT — seeded
    /// once from the draft, never again (see `NotesEditorView`).
    @State private var typedTitle = ""
    @State private var typedBody = ""
    @State private var seeded = false
    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_DocsEditorState {
        (try? Centraid_Screen_V1_DocsEditorState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_DocsEditorEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_DocsEditorEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_DocsEditorState) -> ScreenContent<Centraid_Screen_V1_DocsEditorDraft> {
        if let route = (try? Centraid_Screen_V1_DocsEditorEvent(serializedBytes: opened))?.opened,
           !route.documentID.isEmpty, state.documentID != route.documentID {
            return .loading(true)
        }
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
            status: state.autosave,
            closeLabel: chrome.done,
            onClose: onClose,
            onDeparted: onDeparted
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
                            guard typed != draft.title else { return }
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
                                guard typed != draft.body else { return }
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
