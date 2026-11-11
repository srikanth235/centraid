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
/// Send to Agenda labels and the status (`NotesEditorChrome`).
/// Earlier versions and Send to Agenda are routes the state carries; the powerbox is a
/// sheet the state opens (`link`), also on a typed `[[`.
struct NotesEditorView: View {
    let state: Centraid_Core_V1_NotesEditorState
    let send: (Centraid_Core_V1_NotesEditorEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onClose: () -> Void

    /// THE ONLY PLACE A KEYSTROKE EXISTS BEFORE RUST HEARS IT.
    ///
    /// Filled from the draft ONCE, when the draft first arrives. The body's own typing lives in
    /// `NotesRichBody`, which takes the core's body back only when the core made it (a checklist
    /// tap, Return, Undo, a pick), never an echo of the typing.
    @State private var typedTitle = ""
    @State private var seeded = false
    /// A core edit is on its way back, so the body field may take the core's body while focused.
    @State private var coreEdit = false
    @State private var bodyEmpty = true

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

    @FocusState private var tagFocused: Bool
    @State private var bodyFocused = false

    /// Send an event; the ones that make the core rewrite the body say so first, so the field
    /// follows the answer.
    private func dispatch(_ event: Centraid_Core_V1_NotesEditorEvent) {
        switch event.kind {
        case .checklistRequested?, .checklistToggled?, .returnPressed?, .statusActed?, .linkPicked?:
            coreEdit = true
        default:
            break
        }
        send(event)
    }

    /// A tap on a link chip: a resolved note opens as History does, its route the core's; a URL, a
    /// missing note and a trashed one are the core's to answer (`link_opened`).
    private func openChip(_ chip: Centraid_Core_V1_NotesLinkChip, at: UInt32) {
        if chip.kind == .note, chip.resolution == .resolved, chip.hasRoute {
            open(chip.route)
        } else {
            dispatch(event { $0.linkOpened = .with { $0.at = at } })
        }
    }

    var body: some View {
        let chrome = state.chrome
        NotesEditorRoom(
            title: chrome.title,
            // THE ONE STATUS LINE: its sentence is the core's (the save, or an editing sentence);
            // while a verb rides it (Undo) the sentence sits in the pill over the keys and the
            // header keeps the save.
            status: chrome.statusAction.isEmpty ? chrome.status : state.autosave.label,
            refused: state.autosave.refused,
            closeLabel: chrome.close,
            onClose: onClose
        ) {
            if draft != nil {
                Menu {
                    Button(chrome.pinLabel) { send(event { $0.pin = .init() }) }
                    Button(chrome.linkLabel) { send(event { $0.linkRequested = .init() }) }
                    if state.hasLinksEntry {
                        // LINKED TO (#1185): everything the note is linked to; a sheet over the editor.
                        Button([state.linksEntry.label, state.linksEntry.countLabel].filter { !$0.isEmpty }.joined(separator: "  ")) {
                            send(event { $0.linksOpened = .init() })
                        }
                        .accessibilityIdentifier("note-editor-linked-to")
                    }
                    if state.hasEarlier, EarlierEntryRow.isDrawn(state.earlier) {
                        Button("\(state.earlier.label)  \(state.earlier.countLabel)") { open(state.earlier.route) }
                            .accessibilityIdentifier(EarlierEntryRow.identifier)
                    }
                    if state.hasOrigin, OriginLineView.isDrawn(state.origin) {
                        // WHERE IT CAME FROM (#1185): a quiet line in the menu, nothing to tap.
                        Button(state.origin.text) {}
                            .disabled(true)
                            .accessibilityLabel(state.origin.accessibilityLabel)
                            .accessibilityIdentifier(OriginLineView.identifier)
                    }
                    if state.hasSendToAgenda {
                        Button(chrome.sendToAgendaLabel) { open(state.sendToAgenda) }
                    }
                    if !chrome.shareLabel.isEmpty {
                        Button(chrome.shareLabel) { send(event { $0.shareRequested = .init() }) }
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
                VStack(alignment: .leading, spacing: 0) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            metaLine(draft)
                            TextField(chrome.titlePlaceholder, text: $typedTitle, axis: .vertical)
                                .kitType(.title)
                                .foregroundStyle(Surface.ink)
                                .accessibilityIdentifier("note-title-field")
                                // AN EDIT IS A DIFFERENCE FROM THE DRAFT, not an
                                // assignment to the field: seeding writes to it too.
                                .onChange(of: typedTitle) { _, typed in
                                    guard typed != draft.title else { return }
                                    send(event { $0.title = .with { $0.title = typed } })
                                }
                            NotesTagsRow(tags: state.tags, placeholder: chrome.tagPlaceholder, focused: $tagFocused, send: send)
                            ZStack(alignment: .topLeading) {
                                if bodyEmpty {
                                    Text(chrome.bodyPlaceholder)
                                        .kitType(.row)
                                        .foregroundStyle(Surface.meta)
                                        .allowsHitTesting(false)
                                }
                                NotesRichBody(
                                    value: draft.body,
                                    rich: state.hasRich ? state.rich : nil,
                                    selection: state.hasSelection ? state.selection : nil,
                                    follows: !bodyFocused || coreEdit || state.hasLink,
                                    focused: $bodyFocused,
                                    label: chrome.bodyPlaceholder,
                                    onEdit: { typed in
                                        coreEdit = false
                                        send(event { $0.body = .with { $0.body = typed } })
                                    },
                                    onEmpty: { bodyEmpty = $0 },
                                    onAdopted: { coreEdit = false },
                                    onReturn: { caret in dispatch(event { $0.returnPressed = .with { $0.caret = caret } }) },
                                    onToggle: { at in dispatch(event { $0.checklistToggled = .with { $0.at = at } }) },
                                    onLink: openChip
                                )
                                .frame(minHeight: 280, alignment: .top)
                            }
                        }
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.bottom, 80)
                    }
                    .scrollDismissesKeyboard(.interactively)
                }
                .overlay(alignment: .bottom) {
                    VStack(spacing: 0) {
                        // THE EDITING SENTENCE with its one verb ("Item checked", Undo).
                        ProgressStatusLine(
                            sentence: chrome.statusAction.isEmpty ? "" : chrome.status,
                            actionLabel: chrome.statusAction,
                            onAct: { dispatch(event { $0.statusActed = .init() }) },
                            identifier: "notes-editor-status"
                        )
                        toolbar(chrome)
                    }
                }
                .onAppear {
                    // ONCE. See `seeded`.
                    if !seeded {
                        typedTitle = draft.title
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
            NotesLinkSheet(sheet: state.link, send: dispatch)
        }
        .sheet(isPresented: Binding(
            get: { state.hasLinks },
            set: { shown in
                guard !shown, state.hasLinks else { return }
                send(event { $0.linksClosed = .init() })
            }
        )) {
            NotesLinkedSheet(
                section: state.links,
                picker: state.hasLinkPicker ? state.linkPicker : nil,
                send: { link in send(event { $0.link = link }) },
                open: { route in
                    // The sheet gives way to the page it opens.
                    send(event { $0.linksClosed = .init() })
                    open(route)
                }
            )
        }
        .appAccent("notes")
    }

    /// The line over the title, the pin first when the note is pinned: "Travel · Edited Wed 4 November".
    @ViewBuilder
    private func metaLine(_ draft: Centraid_Core_V1_NotesEditorDraft) -> some View {
        // ABOUT, above the words (#1173): who or what the note is about; a tap opens it.
        AboutChips(chips: state.about, onOpen: open)
        if !state.meta.isEmpty {
            HStack(spacing: 6) {
                if draft.pinned { NotesPinMark() }
                Text(state.meta)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .lineLimit(1)
                    .accessibilityIdentifier("notes-editor-meta")
            }
        }
    }

    /// THE TOOLBAR over the keyboard: a floating glass bar. Checklist and Add link are Rust's
    /// events; the tag key reaches the tag field; the last hides the keyboard.
    private func toolbar(_ chrome: Centraid_Core_V1_NotesEditorChrome) -> some View {
        HStack(spacing: 0) {
            NotesToolKey(iconKey: "ListChecks", label: chrome.checklistLabel, identifier: "notes-tool-checklist") {
                dispatch(event { $0.checklistRequested = .init() })
            }
            NotesToolKey(iconKey: "Link", label: chrome.linkLabel, identifier: "notes-tool-link") {
                send(event { $0.linkRequested = .init() })
            }
            if !chrome.tagPlaceholder.isEmpty {
                NotesToolKey(iconKey: "Hash", label: chrome.tagPlaceholder, identifier: "notes-tool-tag") {
                    bodyFocused = false
                    tagFocused = true
                }
            }
            NotesToolKey(iconKey: "ChevronDown", label: chrome.keyboardLabel, identifier: "notes-tool-keyboard") {
                bodyFocused = false
                tagFocused = false
            }
        }
        .padding(.horizontal, 8)
        .modifier(NotesGlassBar())
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }
}

/// A floating bar in Liquid Glass on iOS 26, and a solid card before it and under Reduce
/// Transparency or Increase Contrast. Only floating glass casts a shadow.
private struct NotesGlassBar: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), !reduceTransparency, contrast != .increased {
            content.glassEffect(.regular, in: Capsule())
        } else {
            content
                .background(Surface.card, in: Capsule())
                .overlay(Capsule().strokeBorder(Surface.border, lineWidth: CentraidGeometry.hairline))
                .shadow(color: .black.opacity(0.12), radius: 10, y: 2)
        }
    }
}

private struct NotesToolKey: View {
    let iconKey: String
    let label: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            CentraidIconView(iconKey: iconKey, tint: Surface.ink, size: 20)
                .frame(maxWidth: .infinity, minHeight: 52)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}

private struct NotesPinMark: View {
    @Environment(\.appAccent) private var accent

    var body: some View {
        CentraidIconView(iconKey: "Pin", tint: accent.text, size: 12)
    }
}

/// THE NOTES EDITOR'S PAGE: the kit's editor room with the app's colour on Done and the plain
/// list page under it (#1173). Close is Done; the status is the autosave's word, centred.
private struct NotesEditorRoom<Trailing: View, Content: View>: View {
    let title: String
    let status: String
    let refused: Bool
    let closeLabel: String
    let onClose: () -> Void
    @ViewBuilder let trailing: () -> Trailing
    @ViewBuilder let content: () -> Content

    @Environment(\.appAccent) private var accent

    var body: some View {
        content()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Surface.plainPage.ignoresSafeArea())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: onClose) {
                        Text(closeLabel)
                            .kitType(.row)
                            .fontWeight(.semibold)
                            .foregroundStyle(accent.text)
                            .lineLimit(1)
                            .fixedSize()
                            .padding(.horizontal, 8)
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("kit-editor-close")
                }
                ToolbarItem(placement: .principal) {
                    Text(status)
                        .kitType(.meta)
                        .foregroundStyle(refused ? StateColor.red.text : Surface.meta)
                        .lineLimit(1)
                        .accessibilityIdentifier("kit-autosave-status")
                        // A principal toolbar item does not redraw when only its text changes; a
                        // new identity per sentence does, so a tapped chip's "in the trash" shows.
                        .id(status)
                }
                ToolbarItem(placement: .topBarTrailing) { trailing() }
            }
    }
}

/// THE NOTE'S TAGS as chips, each removable (`add-tag`, `remove-tag`; Rust writes at once), and
/// the dashed chip that adds one. The field is offered only once the note exists
/// (`tag_placeholder` is empty before).
private struct NotesTagsRow: View {
    let tags: [Centraid_Core_V1_NotesEditorTag]
    let placeholder: String
    var focused: FocusState<Bool>.Binding
    let send: (Centraid_Core_V1_NotesEditorEvent) -> Void

    @State private var typed = ""

    var body: some View {
        if !tags.isEmpty || !placeholder.isEmpty {
            KitFlow(spacing: 8) {
                ForEach(tags, id: \.conceptID) { tag in
                    HStack(spacing: 4) {
                        Text(tag.label)
                            .kitType(.meta)
                            .foregroundStyle(Surface.body)
                        Button {
                            var event = Centraid_Core_V1_NotesEditorEvent()
                            event.tagRemoved = .with { $0.label = tag.label }
                            send(event)
                        } label: {
                            CentraidIconView(iconKey: "X", tint: Surface.meta, size: 10)
                                .frame(width: 20, height: 20)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(tag.removeLabel)
                        .accessibilityIdentifier("note-tag-remove-\(tag.conceptID)")
                    }
                    .padding(.leading, 10)
                    .padding(.trailing, 4)
                    .frame(minHeight: 30)
                    .background(Surface.fill, in: Capsule())
                }
                if !placeholder.isEmpty {
                    TextField(placeholder, text: $typed)
                        .kitType(.meta)
                        .foregroundStyle(Surface.ink)
                        .submitLabel(.done)
                        .focused(focused)
                        .frame(minWidth: 96)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 30)
                        .overlay(Capsule().strokeBorder(Surface.border, style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
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
}

/// Chips that wrap onto the next line.
struct KitFlow: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal.width ?? 0, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let laid = arrange(bounds.width, subviews)
        for (subview, point) in zip(subviews, laid.points) {
            subview.place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: .unspecified)
        }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
        var points: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += row + spacing
                row = 0
            }
            points.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            row = max(row, size.height)
            widest = max(widest, x - spacing)
        }
        return (CGSize(width: widest, height: y + row), points)
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
                field: KitSearchField(open: true, term: sheet.term),
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

/// THE "Linked to" SHEET (#1185): every item the note is linked to (the `[[title]]` wikilinks among
/// them), the add row, and the kit's picker over it. Rust makes every word and row; a tap is a
/// `LinkEvent`.
private struct NotesLinkedSheet: View {
    let section: Centraid_Core_V1_LinkSection
    let picker: Centraid_Core_V1_LinkPicker?
    let send: (Centraid_Core_V1_LinkEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        SheetRoom(title: section.title, titleIdentifier: "notes-linked-to") {
            ScrollView {
                LinkSectionView(section: section, send: send, open: open, padded: false)
            }
        }
        .linkPickerSheet(picker ?? Centraid_Core_V1_LinkPicker(), send: send)
    }
}
