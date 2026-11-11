import SwiftUI

/// `agenda.task` — the task editor, an `EditorRoom`: autosave, close = done
/// (#1015 D3).
///
/// The title and notes are the member's typing, autosaved by Rust and reported
/// by the room's `AutosaveStatus`; every other field (when, time, reminder,
/// repeats, priority, effort, project, tags) is a write of its own, its words
/// and choices finished on `TodoField`. Leaving by any route is a `NavPopped`
/// the shell reports, which Rust turns into the screen's `Left`, the flush.
/// The parent link and a subtask's row carry a `route` the shell pushes.
struct TodoDetailView: View {
    let state: Centraid_Core_V1_TodoDetailState
    let send: (Centraid_Core_V1_TodoDetailEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onClose: () -> Void
    let onPhoneSays: (Centraid_Core_V1_PhoneSaysTaken) -> Void

    /// THE ONLY PLACE A KEYSTROKE EXISTS BEFORE THE MACHINE HEARS IT —
    /// seeded once from the draft, never re-seeded (`NotesEditorView`'s rule).
    @State private var typedTitle = ""
    @State private var typedNotes = ""
    @State private var typedTag = ""
    @State private var typedSubtask = ""
    @State private var seeded = false

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_TodoDetailEvent) -> Void) -> Centraid_Core_V1_TodoDetailEvent {
        var event = Centraid_Core_V1_TodoDetailEvent()
        build(&event)
        return event
    }

    var body: some View {
        EditorRoom(
            title: state.chrome.title,
            status: state.autosave,
            onClose: onClose,
            onDeparted: {}
        ) {
            if case let .data(detail)? = state.content {
                KitCheckBox(state: detail.check.kitState, label: detail.checkLabel, round: !detail.hasParentRoute) {
                    send(event { $0.check = .init() })
                }
            }
        } content: {
            if case let .gone(gone)? = state.content {
                EmptyStateView(gone, onAction: onClose)
            } else {
                ReadStateView(
                    content: readContent(state),
                    loadingLabel: state.chrome.loading,
                    onRetry: { send(event { $0.refreshed = .init() }) }
                ) { detail in
                    editor(detail, state: state)
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { !state.openField.isEmpty },
            set: { open in if !open, !state.openField.isEmpty { send(event { $0.fieldClosed = .init() }) } }
        )) {
            if case let .data(detail)? = state.content, let field = detail.fields.first(where: { $0.key == state.openField }) {
                OptionSheet(title: field.label, status: field.note) {
                    ForEach(field.choices, id: \.key) { choice in
                        SheetRow(iconKey: choice.iconKey, label: choice.label, selected: choice.selected, identifier: "tasks-choice-\(field.key)-\(choice.key)") {
                            send(event { $0.fieldChoice = .with { $0.field = field.key; $0.key = choice.key } })
                        }
                        .padding(.leading, choice.indented ? 24 : 0)
                        .disabled(!choice.enabled)
                    }
                    pickers(field, today: detail.today)
                }
            }
        }
        // THE CUSTOM REPEAT SHEET: the editor's own, over this task's rule; Done is Rust's.
        .sheet(isPresented: Binding(
            get: { hasCustomRepeat(state) },
            set: { open in if !open, hasCustomRepeat(state) { send(event { $0.fieldClosed = .init() }) } }
        )) {
            if case let .data(detail)? = state.content, detail.hasCustomRepeat {
                AgendaCustomRepeatSheetView(sheet: detail.customRepeat) { editorEvent in
                    send(event { $0.customRepeat = editorEvent })
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { send(event { $0.dismissed = .init() }) } }
        )) {
            ConfirmSheet(
                state.confirm,
                cancelLabel: state.chrome.cancel,
                onConfirm: { send(event { $0.confirmed = .init() }) },
                onDismiss: { send(event { $0.dismissed = .init() }) }
            )
        }
        .linkPickerSheet(state.linkPicker) { link in send(event { $0.link = link }) }
        // THE TASK LEFT — deleted, or gone from the vault: the view pops.
        .onChange(of: state.finished) { _, finished in
            if finished { onClose() }
        }
    }

    private func hasCustomRepeat(_ state: Centraid_Core_V1_TodoDetailState) -> Bool {
        if case let .data(detail)? = state.content { return detail.hasCustomRepeat }
        return false
    }

    private func readContent(_ state: Centraid_Core_V1_TodoDetailState) -> ScreenContent<Centraid_Core_V1_TodoDetailData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        case .gone?, nil: return .loading(true)
        }
    }

    @ViewBuilder
    private func editor(_ detail: Centraid_Core_V1_TodoDetailData, state: Centraid_Core_V1_TodoDetailState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if detail.hasParentRoute {
                    KitLink(label: detail.parentTitle, dense: true, identifier: "tasks-parent") {
                        open(detail.parentRoute)
                    }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                }
                if !detail.statusLabel.isEmpty {
                    Text(detail.statusLabel)
                        .centraidType("eyebrow")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                }
                TextField(detail.titlePlaceholder, text: $typedTitle, axis: .vertical)
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.vertical, 8)
                    .accessibilityLabel(detail.titlePlaceholder)
                    .accessibilityIdentifier("tasks-title-field")
                    // AN EDIT IS A DIFFERENCE FROM THE DRAFT, not an assignment.
                    .onChange(of: typedTitle) { _, typed in
                        guard seeded, typed != detail.draft.title else { return }
                        send(event { $0.title = .with { $0.title = typed } })
                    }
                TextField(detail.notesPlaceholder, text: $typedNotes, axis: .vertical)
                    .centraidType("reading")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(3...12)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.bottom, 8)
                    .accessibilityLabel(detail.notesPlaceholder)
                    .accessibilityIdentifier("tasks-notes-field")
                    .onChange(of: typedNotes) { _, typed in
                        guard seeded, typed != detail.draft.notes else { return }
                        send(event { $0.notes = .with { $0.notes = typed } })
                    }
                // WHAT THE PHONE'S REMINDERS SAY DIFFERENTLY (#1185), each with its "Use phone's".
                PhoneSaysLines(lines: state.phoneSays, onTake: onPhoneSays)
                KitHairline()
                // THE GROUPED CARDS (#1173): a field with a `group` opens a new card under that heading.
                ForEach(Self.cards(detail.fields), id: \.id) { card in
                    if !card.heading.isEmpty {
                        SectionHeader(title: card.heading)
                            .padding(.top, 12)
                            .accessibilityIdentifier("tasks-detail-group-\(card.id)")
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(card.fields, id: \.key) { field in
                            fieldRow(field, today: detail.today)
                        }
                    }
                    .background(Surface.card)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                }
                // THE TASK'S ADDRESS, as it is stored, opened by the core's own OpenUrl effect.
                if detail.hasLink {
                    linkRow(detail.link)
                }
                subtasks(detail)
                if detail.hasAttachments {
                    AgendaAttachmentsView(
                        section: detail.attachments,
                        idPrefix: "agenda-detail-attachment",
                        headIdentifier: "agenda-detail-attachments",
                        open: open,
                        send: { attachment in send(event { $0.attachment = attachment }) }
                    )
                }
                // LINKED TO (#1185): the kit's section, after the attachments; Rust makes every word and row.
                if detail.hasLinks {
                    LinkSectionView(section: detail.links, send: { link in
                        send(event { $0.link = link })
                    }, open: open)
                }
                // EVERY RECORD KEEPS ITS EARLIER VALUES (#1185): the last content row, above the foot actions.
                EarlierEntryRow(entry: state.hasEarlier ? state.earlier : nil, open: open)
                OriginLineView(line: state.hasOrigin ? state.origin : nil)
                HStack(spacing: 12) {
                    if !detail.shareLabel.isEmpty {
                        KitOutlineButton(label: detail.shareLabel) { send(event { $0.shareRequested = .init() }) }
                            .accessibilityIdentifier("tasks-share")
                    }
                    if !detail.deleteLabel.isEmpty {
                        KitOutlineButton(label: detail.deleteLabel, tone: "net") { send(event { $0.delete = .init() }) }
                            .accessibilityIdentifier("tasks-delete")
                    }
                    if detail.canRelease, !detail.releaseLabel.isEmpty {
                        KitOutlineButton(label: detail.releaseLabel) { send(event { $0.release = .init() }) }
                            .accessibilityIdentifier("tasks-release")
                    }
                }
                .padding(CentraidGeometry.pageMargin)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            StatusLineView(status: state.status, identifier: "tasks-status-action") { send(event { $0.statusActed = .init() }) }
                .background(Theme.color("bg", scheme))
        }
        .onAppear {
            // ONCE. See `seeded`.
            if !seeded {
                typedTitle = detail.draft.title
                typedNotes = detail.draft.notes
                seeded = true
            }
        }
    }

    /// One field: a sheet's `ChoiceFieldRow`, or the key, value and note with
    /// the choices as chips inline, the platform's pickers where the field
    /// offers them, and a tag entry for Tags.
    @ViewBuilder
    private func fieldRow(_ field: Centraid_Core_V1_TodoField, today: String) -> some View {
        if field.toggle {
            // A SWITCH ROW (Flag): the tap is a choice, "on" or "off".
            Toggle(isOn: Binding(
                get: { field.on },
                set: { on in send(event { $0.fieldChoice = .with { $0.field = field.key; $0.key = on ? "on" : "off" } }) }
            )) {
                Text(field.label)
                    .centraidType("body")
                    .foregroundStyle(Theme.color(field.enabled ? "text" : "textDisabled", scheme))
            }
            .kitToggle()
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .overlay(alignment: .bottom) { KitHairline() }
            .disabled(!field.enabled)
            .accessibilityIdentifier("tasks-field-\(field.key)")
        } else if field.sheet {
            ChoiceFieldRow(key: field.label, value: field.value, identifier: "tasks-field-\(field.key)") {
                send(event { $0.fieldOpened = .with { $0.field = field.key } })
            }
            .disabled(!field.enabled)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(field.label)
                        .centraidType("body")
                        .foregroundStyle(Theme.color(field.enabled ? "text" : "textDisabled", scheme))
                    Spacer(minLength: 8)
                    Text(field.value)
                        .centraidType("body")
                        .foregroundStyle(Theme.color(field.enabled ? "textSoft" : "textDisabled", scheme))
                        .lineLimit(1)
                }
                if !field.choices.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(field.choices, id: \.key) { choice in
                                chip(choice, field: field)
                            }
                        }
                    }
                }
                pickers(field, today: today)
                if field.addText {
                    HStack(spacing: 8) {
                        TextField(field.addPlaceholder, text: $typedTag)
                            .centraidType("small")
                            .submitLabel(.done)
                            .onSubmit(addTag)
                            .accessibilityLabel(field.addPlaceholder)
                            .accessibilityIdentifier("tasks-tag-field")
                        TodoEntryVerb(label: state.chrome.addTagVerb, enabled: !typedTag.isEmpty, identifier: "tasks-tag-add", action: addTag)
                    }
                }
                if !field.note.isEmpty {
                    Text(field.note)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .overlay(alignment: .bottom) { KitHairline() }
            .disabled(!field.enabled)
            .accessibilityIdentifier("tasks-field-\(field.key)")
        }
    }

    /// The link row: its key, the address and the verb that opens it.
    private func linkRow(_ link: Centraid_Core_V1_TodoLink) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(link.label)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                Text(link.url)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            KitLink(label: link.openLabel, identifier: "agenda-detail-link-open") {
                send(event { $0.openLink = .init() })
            }
            .accessibilityLabel(link.accessibilityLabel.isEmpty ? link.openLabel : link.accessibilityLabel)
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .overlay(alignment: .bottom) { KitHairline() }
        .accessibilityIdentifier("agenda-detail-link")
    }

    /// One card of fields: the heading its first field carries, and the id of that field.
    private struct FieldCard {
        let id: String
        let heading: String
        var fields: [Centraid_Core_V1_TodoField]
    }

    /// The fields cut into cards: a new one at each field whose `group` is not empty.
    private static func cards(_ fields: [Centraid_Core_V1_TodoField]) -> [FieldCard] {
        var cards: [FieldCard] = []
        for field in fields {
            if !field.group.isEmpty || cards.isEmpty {
                cards.append(FieldCard(id: field.key, heading: field.group, fields: [field]))
            } else {
                cards[cards.count - 1].fields.append(field)
            }
        }
        return cards
    }

    private func addTag() {
        let label = typedTag
        guard !label.isEmpty else { return }
        typedTag = ""
        send(event { $0.tagAdded = .with { $0.label = label } })
    }

    private func addSubtask() {
        let title = typedSubtask
        guard !title.isEmpty else { return }
        typedSubtask = ""
        send(event { $0.subtaskAdded = .with { $0.title = title } })
    }

    /// The platform's pickers, under the field's own words ("Pick a date"),
    /// opened on the day and time Rust names (the due, else today).
    @ViewBuilder
    private func pickers(_ field: Centraid_Core_V1_TodoField, today: String) -> some View {
        if field.pickDate || field.pickTime {
            HStack(spacing: 8) {
                if !field.pickLabel.isEmpty {
                    Text(field.pickLabel)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                Spacer(minLength: 0)
                if field.pickDate {
                    CivilDayPicker(label: field.pickLabel.isEmpty ? field.label : field.pickLabel, day: field.day, fallbackDay: today) { day in
                        send(event { $0.datePicked = .with { $0.day = day } })
                    }
                }
                if field.pickTime {
                    CivilTimePicker(label: field.pickLabel.isEmpty ? field.label : field.pickLabel, time: field.time) { time in
                        send(event { $0.timePicked = .with { $0.time = time } })
                    }
                }
            }
        }
    }

    private func chip(_ choice: Centraid_Core_V1_TodoChoice, field: Centraid_Core_V1_TodoField) -> some View {
        KitChip(
            label: choice.label,
            selected: choice.selected,
            identifier: "tasks-chip-\(field.key)-\(choice.key)"
        ) {
            send(event { $0.fieldChoice = .with { $0.field = field.key; $0.key = choice.key } })
        }
        .disabled(!choice.enabled)
    }

    @ViewBuilder
    private func subtasks(_ detail: Centraid_Core_V1_TodoDetailData) -> some View {
        if !detail.subtasksLabel.isEmpty, detail.canAddSubtask || !detail.subtasks.isEmpty {
            SectionHeader(title: detail.subtasksLabel)
            ForEach(detail.subtasks, id: \.taskID) { row in
                TodoRowView(
                    row: row,
                    onCheck: { id in send(event { $0.subtaskChecked = .with { $0.taskID = id } }) },
                    onPick: open
                )
            }
            if detail.canAddSubtask {
                HStack(spacing: 8) {
                    TextField(detail.addSubtaskPlaceholder, text: $typedSubtask)
                        .centraidType("body")
                        .submitLabel(.done)
                        .onSubmit(addSubtask)
                        .accessibilityLabel(detail.addSubtaskPlaceholder)
                        .accessibilityIdentifier("tasks-subtask-field")
                    TodoEntryVerb(label: state.chrome.addSubtaskVerb, enabled: !typedSubtask.isEmpty, identifier: "tasks-subtask-add", action: addSubtask)
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
            }
        }
        if !detail.subtaskNote.isEmpty {
            Text(detail.subtaskNote)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textFaint", scheme))
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 4)
        }
    }
}

/// The text verb beside an entry field ("Add"): live while something is typed.
private struct TodoEntryVerb: View {
    let label: String
    let enabled: Bool
    let identifier: String
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if !label.isEmpty {
            KitLink(label: label, identifier: identifier, action: action)
                .disabled(!enabled)
        }
    }
}
