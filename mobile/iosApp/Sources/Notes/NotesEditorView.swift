import SwiftUI

/// `notes.editor` — the Notes editor, in SwiftUI, on the kit (#1135).
///
/// **AN EDITOR ROOM: AUTOSAVE, CLOSE = DONE (#1015 D3).** There is no Save
/// button and no save event from here: every edit is handed to Rust, whose
/// autosave writes after its debounce, and `AutosaveStatus` — hosted by
/// `EditorRoom` — says whether the words are safe. Done pops the page; Rust
/// flushes what is unsaved when it sees the page leave (`Left`).
///
/// **EVERY WORD IS RUST'S** — the close verb, the placeholders, the pin, link,
/// history and Send to Agenda labels and the status (`NotesEditorChrome`).
/// History and Send to Agenda are routes the state carries; the powerbox is a
/// sheet the state opens (`link`), also on a typed `[[`.
struct NotesEditorView: View {
    let state: Centraid_Core_V1_NotesEditorState
    let send: (Centraid_Core_V1_NotesEditorEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onClose: () -> Void

    /// THE ONLY PLACE A KEYSTROKE EXISTS BEFORE RUST HEARS IT.
    ///
    /// Filled from the draft ONCE, when the draft first arrives — and again
    /// only when the powerbox closes, because a pick changed the body under
    /// the field.
    @State private var typedTitle = ""
    @State private var typedBody = ""
    @State private var seeded = false

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_NotesEditorEvent) -> Void) -> Centraid_Core_V1_NotesEditorEvent {
        var event = Centraid_Core_V1_NotesEditorEvent()
        build(&event)
        return event
    }

    private var draft: Centraid_Core_V1_NotesEditorDraft? {
        if case let .draft(draft)? = state.content { return draft }
        return nil
    }

    private var content: ScreenContent<Centraid_Core_V1_NotesEditorDraft> {
        switch state.content {
        case .loading?, nil: return .loading(true)
        case let .failure(failure)?: return .failed(failure)
        case let .draft(draft)?: return .data(draft)
        }
    }

    var body: some View {
        let chrome = state.chrome
        EditorRoom(
            title: chrome.title,
            status: state.autosave,
            closeLabel: chrome.close,
            onClose: onClose,
            onDeparted: {}
        ) {
            if draft != nil {
                Menu {
                    Button(chrome.pinLabel) { send(event { $0.pin = .init() }) }
                    Button(chrome.linkLabel) { send(event { $0.linkRequested = .init() }) }
                    if chrome.historyEnabled, state.hasHistory {
                        Button(chrome.historyLabel) { open(state.history) }
                    }
                    if state.hasSendToAgenda {
                        Button(chrome.sendToAgendaLabel) { open(state.sendToAgenda) }
                    }
                } label: {
                    ToolbarIconFace(iconKey: "MoreHoriz")
                }
                .accessibilityLabel(chrome.menuLabel)
                .accessibilityIdentifier("note-editor-menu")
            }
        } content: {
            ReadStateView(
                content: content,
                skeleton: { RowSkeleton(rows: 4, meta: false, label: "") },
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { draft in
                VStack(alignment: .leading, spacing: 8) {
                    if !chrome.status.isEmpty {
                        Text(chrome.status)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                    }
                    TextField(chrome.titlePlaceholder, text: $typedTitle)
                        .centraidType("title")
                        .foregroundStyle(Theme.color("text", scheme))
                        .accessibilityIdentifier("note-title-field")
                        // AN EDIT IS A DIFFERENCE FROM THE DRAFT, not an
                        // assignment to the field: seeding writes to it too.
                        .onChange(of: typedTitle) { _, typed in
                            guard typed != draft.title else { return }
                            send(event { $0.title = .with { $0.title = typed } })
                        }
                    NotesTagsRow(tags: state.tags, placeholder: chrome.tagPlaceholder, send: send)
                    ZStack(alignment: .topLeading) {
                        if typedBody.isEmpty {
                            Text(chrome.bodyPlaceholder)
                                .centraidType("reading")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                                .padding(.top, 8)
                                .padding(.leading, 5)
                                .allowsHitTesting(false)
                        }
                        TextEditor(text: $typedBody)
                            .centraidType("reading")
                            .foregroundStyle(Theme.color("text", scheme))
                            .scrollContentBackground(.hidden)
                            .accessibilityIdentifier("note-body-field")
                            .onChange(of: typedBody) { _, typed in
                                guard typed != draft.body else { return }
                                send(event { $0.body = .with { $0.body = typed } })
                            }
                    }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .onAppear {
                    // ONCE. See `seeded`.
                    if !seeded {
                        typedTitle = draft.title
                        typedBody = draft.body
                        seeded = true
                    }
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.hasLink },
            set: { shown in
                guard !shown, state.hasLink else { return }
                send(event { $0.linkDismissed = .init() })
            }
        )) {
            NotesLinkSheet(sheet: state.link, send: send)
        }
        .onChange(of: state.hasLink) { _, shown in
            // THE POWERBOX CLOSED: a pick spliced `[[title]]` into the body
            // Rust holds, so the field takes it.
            if !shown, let draft { typedBody = draft.body }
        }
    }
}

/// THE NOTE'S TAGS, each removable, and the field that adds one (`add-tag`,
/// `remove-tag`; Rust writes at once). The field is offered only once the
/// note exists (`tag_placeholder` is empty before).
private struct NotesTagsRow: View {
    let tags: [Centraid_Core_V1_NotesEditorTag]
    let placeholder: String
    let send: (Centraid_Core_V1_NotesEditorEvent) -> Void

    @State private var typed = ""
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(tags, id: \.conceptID) { tag in
                HStack(spacing: 6) {
                    Text(tag.label)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                    KitIconKey(iconKey: "X", label: tag.removeLabel, tint: "textSoft", identifier: "note-tag-remove-\(tag.conceptID)") {
                        var event = Centraid_Core_V1_NotesEditorEvent()
                        event.tagRemoved = .with { $0.label = tag.label }
                        send(event)
                    }
                }
            }
            if !placeholder.isEmpty {
                TextField(placeholder, text: $typed)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("text", scheme))
                    .submitLabel(.done)
                    .accessibilityIdentifier("note-tag-field")
                    .onSubmit {
                        let label = typed
                        typed = ""
                        var event = Centraid_Core_V1_NotesEditorEvent()
                        event.tagAdded = .with { $0.label = label }
                        send(event)
                    }
            }
        }
    }
}

/// THE POWERBOX: a sheet over the editor. A pick is `LinkPicked`, and Rust
/// splices `[[title]]` into the body.
private struct NotesLinkSheet: View {
    let sheet: Centraid_Core_V1_NotesLinkSheet
    let send: (Centraid_Core_V1_NotesEditorEvent) -> Void

    private func event(_ build: (inout Centraid_Core_V1_NotesEditorEvent) -> Void) -> Centraid_Core_V1_NotesEditorEvent {
        var event = Centraid_Core_V1_NotesEditorEvent()
        build(&event)
        return event
    }

    private var content: ScreenContent<Centraid_Core_V1_NotesLinkData> {
        switch sheet.content {
        case .loading?, nil: return .loading(true)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        }
    }

    var body: some View {
        SheetRoom(title: sheet.title, status: sheet.foot) {
            CentraidSearchField(
                field: KitSearchField.with {
                    $0.open = true
                    $0.term = sheet.term
                },
                placeholder: sheet.searchPlaceholder,
                closeLabel: sheet.close,
                identifier: "notes-link-search",
                onTerm: { term in send(event { $0.linkTerm = .with { $0.term = term } }) },
                onClose: { send(event { $0.linkDismissed = .init() }) }
            )
            ReadStateView(
                content: content,
                skeleton: { RowSkeleton(rows: 4, label: sheet.loadingLabel) },
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { picker in
                if picker.domains.allSatisfy({ $0.rows.isEmpty }) {
                    EmptyStateView(picker.empty)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(picker.domains.enumerated()), id: \.offset) { _, domain in
                                SectionHeader(title: domain.head.title, count: domain.head.count)
                                    .padding(.horizontal, -CentraidGeometry.pageMargin)
                                ForEach(domain.rows, id: \.id) { row in
                                    CentraidRow(
                                        title: row.title,
                                        meta: row.subtitle,
                                        accessibility: row.accessibilityLabel,
                                        identifier: "notes-link-\(row.id)",
                                        onTap: { send(event { $0.linkPicked = .with { $0.id = row.id } }) }
                                    )
                                    .padding(.horizontal, -CentraidGeometry.pageMargin)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// `notes.history` — one note's versions, newest first (#1135).
struct NotesHistoryView: View {
    let state: Centraid_Core_V1_NotesHistoryState
    let send: (Centraid_Core_V1_NotesHistoryEvent) -> Void
    let onBack: () -> Void

    private func event(_ build: (inout Centraid_Core_V1_NotesHistoryEvent) -> Void) -> Centraid_Core_V1_NotesHistoryEvent {
        var event = Centraid_Core_V1_NotesHistoryEvent()
        build(&event)
        return event
    }

    private var content: ScreenContent<Centraid_Core_V1_NotesHistoryData> {
        switch state.content {
        case .loading?, nil: return .loading(true)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        }
    }

    var body: some View {
        PushedPage(title: state.title, parentTitle: state.back, onBack: onBack) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                StatusLineView(status: state.status, identifier: "notes-history-status") {}
                ReadStateView(
                    content: content,
                    loadingLabel: state.loadingLabel,
                    onRetry: { send(event { $0.refreshed = .init() }) }
                ) { history in
                    if history.rows.count <= 1, history.hasEmpty {
                        EmptyStateView(history.empty)
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 0) {
                                ForEach(history.rows, id: \.contentID) { row in
                                    HStack(spacing: 0) {
                                        CentraidRow(
                                            title: row.label,
                                            meta: row.preview,
                                            dimmed: row.current,
                                            accessibility: row.accessibilityLabel,
                                            identifier: "notes-version-\(row.contentID)"
                                        )
                                        if !row.current, !row.restoreLabel.isEmpty {
                                            KitLink(
                                                label: row.restoreLabel,
                                                dense: true,
                                                identifier: "notes-restore-\(row.contentID)"
                                            ) {
                                                send(event { $0.restore = .with { $0.contentID = row.contentID } })
                                            }
                                            .padding(.trailing, 8)
                                        }
                                    }
                                }
                            }
                        }
                        .refreshable { send(event { $0.refreshed = .init() }) }
                        .accessibilityIdentifier("notes-history")
                    }
                }
            }
        }
    }
}
