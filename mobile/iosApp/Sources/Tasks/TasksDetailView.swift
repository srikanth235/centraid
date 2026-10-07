import SwiftUI

/// `tasks.detail` — the task editor (#1029 port), an `EditorRoom`: autosave,
/// close = done (#1015 D3).
///
/// The title and notes are the member's typing, autosaved by the machine and
/// reported by the room's `AutosaveStatus`; every other field (when, time,
/// reminder, repeats, priority, effort, project, tags) is a write of its own,
/// its words and choices finished on `TasksField`. Leaving by any route is
/// `onDeparted` → the bridge's `departed()` → the machine's `Left`, the flush.
///
/// ONE BRIDGE SERVES EVERY DETAIL on the stack, so this view seeds and edits
/// only while the state is about ITS task (`taskIdentifier`, the route's).
struct TasksDetailView: View {
    let data: Data
    let taskIdentifier: String
    let send: (Data) -> Void
    let onClose: () -> Void
    let onDeparted: () -> Void

    /// THE ONLY PLACE A KEYSTROKE EXISTS BEFORE THE MACHINE HEARS IT —
    /// seeded once from the draft, never re-seeded (`NotesEditorView`'s rule).
    @State private var typedTitle = ""
    @State private var typedNotes = ""
    @State private var typedTag = ""
    @State private var typedSubtask = ""
    @State private var seeded = false

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_TasksDetailState {
        (try? Centraid_Screen_V1_TasksDetailState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_TasksDetailEvent) -> Void) -> Data {
        tasksEvent(Centraid_Screen_V1_TasksDetailEvent.self, build)
    }

    var body: some View {
        let state = state
        let mine = state.taskID == taskIdentifier
        EditorRoom(
            title: state.chrome.title,
            status: mine ? state.autosave : .init(),
            onClose: onClose,
            onDeparted: onDeparted
        ) {
            if mine, case let .data(detail)? = state.content {
                TasksCheckBox(check: detail.check, label: detail.checkLabel) { send(event { $0.check = .init() }) }
            }
        } content: {
            if mine, case let .gone(gone)? = state.content {
                EmptyStateView(gone, onAction: onClose)
            } else {
                ReadStateView(
                    content: mine ? readContent(state) : .loading(true),
                    loadingLabel: state.chrome.loading,
                    onRetry: { send(event { $0.refreshed = .init() }) }
                ) { detail in
                    editor(detail, state: state)
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { mine && !state.openField.isEmpty },
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
        .sheet(isPresented: Binding(
            get: { mine && state.hasConfirm },
            set: { open in if !open, state.hasConfirm { send(event { $0.dismissed = .init() }) } }
        )) {
            ConfirmSheet(
                state.confirm,
                cancelLabel: state.chrome.cancel,
                onConfirm: { send(event { $0.confirmed = .init() }) },
                onDismiss: { send(event { $0.dismissed = .init() }) }
            )
        }
        // THE TASK LEFT — deleted, or gone from the vault: the view pops.
        .onChange(of: state.finished) { _, finished in
            if finished, mine { onClose() }
        }
    }

    private func readContent(_ state: Centraid_Screen_V1_TasksDetailState) -> ScreenContent<Centraid_Screen_V1_TasksDetailData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case .gone?, nil: return .loading(true)
        }
    }

    @ViewBuilder
    private func editor(_ detail: Centraid_Screen_V1_TasksDetailData, state: Centraid_Screen_V1_TasksDetailState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if !detail.parentTaskID.isEmpty {
                    Button {
                        send(event { $0.parentPicked = .init() })
                    } label: {
                        HStack(spacing: 4) {
                            CentraidIconView(iconKey: "ChevronLeft", tint: Theme.color("link", scheme), size: 12)
                            Text(detail.parentTitle)
                                .centraidType("annotLabelOn")
                                .foregroundStyle(Theme.color("link", scheme))
                        }
                        .frame(minHeight: CentraidGeometry.targetMinFine)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .accessibilityIdentifier("tasks-parent")
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
                KitHairline()
                ForEach(detail.fields, id: \.key) { field in
                    fieldRow(field, today: detail.today)
                }
                subtasks(detail)
                HStack(spacing: 12) {
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
    private func fieldRow(_ field: Centraid_Screen_V1_TasksField, today: String) -> some View {
        if field.sheet {
            ChoiceFieldRow(key: field.label, value: field.value, identifier: "tasks-field-\(field.key)") {
                send(event { $0.fieldOpened = .with { $0.field = field.key } })
            }
            .disabled(!field.enabled)
            .opacity(field.enabled ? 1 : 0.5)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(field.label)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                    Spacer(minLength: 8)
                    Text(field.value)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("textSoft", scheme))
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
                        TasksEntryVerb(label: state.chrome.addTagVerb, enabled: !typedTag.isEmpty, identifier: "tasks-tag-add", action: addTag)
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
            .opacity(field.enabled ? 1 : 0.5)
            .accessibilityIdentifier("tasks-field-\(field.key)")
        }
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
    /// opened on the day and time the machine names (the due, else today).
    @ViewBuilder
    private func pickers(_ field: Centraid_Screen_V1_TasksField, today: String) -> some View {
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

    private func chip(_ choice: Centraid_Screen_V1_TasksChoice, field: Centraid_Screen_V1_TasksField) -> some View {
        Button {
            send(event { $0.fieldChoice = .with { $0.field = field.key; $0.key = choice.key } })
        } label: {
            Text(choice.label)
                .centraidType("annotLabelOn")
                .foregroundStyle(Theme.color(choice.selected ? "onAccent" : "text", scheme))
                .padding(.horizontal, 10)
                .frame(minHeight: 32)
                .background {
                    if choice.selected { Capsule().fill(Theme.color("accent", scheme)) }
                }
                .overlay {
                    if !choice.selected {
                        Capsule().strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!choice.enabled)
        .opacity(choice.enabled ? 1 : 0.4)
        .accessibilityAddTraits(choice.selected ? .isSelected : [])
        .accessibilityIdentifier("tasks-chip-\(field.key)-\(choice.key)")
    }

    @ViewBuilder
    private func subtasks(_ detail: Centraid_Screen_V1_TasksDetailData) -> some View {
        let state = state
        if !detail.subtasksLabel.isEmpty, detail.canAddSubtask || !detail.subtasks.isEmpty {
            SectionHeader(title: detail.subtasksLabel)
            ForEach(detail.subtasks, id: \.taskID) { row in
                TasksRowView(
                    row: row,
                    onCheck: { id in send(event { $0.subtaskChecked = .with { $0.taskID = id } }) },
                    onPick: { id in send(event { $0.subtaskPicked = .with { $0.taskID = id } }) }
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
                    TasksEntryVerb(label: state.chrome.addSubtaskVerb, enabled: !typedSubtask.isEmpty, identifier: "tasks-subtask-add", action: addSubtask)
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
private struct TasksEntryVerb: View {
    let label: String
    let enabled: Bool
    let identifier: String
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if !label.isEmpty {
            Button(action: action) {
                Text(label)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color(enabled ? "link" : "textFaint", scheme))
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!enabled)
            .accessibilityIdentifier(identifier)
        }
    }
}
