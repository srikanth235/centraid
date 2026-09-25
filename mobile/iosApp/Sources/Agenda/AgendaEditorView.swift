import SwiftUI

/// `agenda.editor` — make an event, edit one, or edit one occurrence of one
/// (#1046 wave 5).
///
/// **THE ONE EXPLICIT SAVE.** A wrong date written by an autosave is worse
/// than a lost draft, so this editor is the deliberate exception to #1015 D3:
/// a `PushedPage` whose one trailing action is Save, armed by the state's
/// `can_save`. Back never pops by itself — it forwards `LeaveRequested`, and
/// the machine asks first when there are changes (the discard confirm) or
/// answers `dismissed`, which is what pops.
///
/// The date and time pickers bind to the draft's civil strings
/// (`CivilDayPicker`/`CivilTimePicker`) and forward what was picked; every
/// label, choice, block reason and note is the machine's.
struct AgendaEditorView: View {
    let data: Data
    /// The route's `Opened`: ONE BRIDGE SERVES EVERY SITTING, so until the
    /// state is about this one (the last sitting's draft is still held while
    /// this `Opened` is in flight) the view draws loading and seeds nothing.
    var opened: Data = Data()
    let send: (Data) -> Void
    let onDone: () -> Void

    /// THE MEMBER'S TYPING, seeded once from the draft (`NotesEditorView`'s rule).
    @State private var typedTitle = ""
    @State private var typedNotes = ""
    @State private var typedLink = ""
    @State private var seeded = false
    /// Which platform picker is up — presentation only: the value it opens on
    /// and the words over it are the draft's and the machine's.
    @State private var picking: CivilPick? = nil

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_AgendaEditorState {
        (try? Centraid_Screen_V1_AgendaEditorState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_AgendaEditorEvent) -> Void) -> Data {
        tasksEvent(Centraid_Screen_V1_AgendaEditorEvent.self, build)
    }

    /// The state is this route's sitting: same mode, same occurrence, same day.
    private func mine(_ state: Centraid_Screen_V1_AgendaEditorState) -> Bool {
        guard let route = (try? Centraid_Screen_V1_AgendaEditorEvent(serializedBytes: opened))?.opened,
              route.mode != .unspecified else { return true }
        return state.mode == route.mode
            && state.eventID == route.eventID
            && state.instanceKey == route.instanceKey
            && (route.day.isEmpty || state.day == route.day)
    }

    var body: some View {
        let state = state
        let chrome = state.chrome
        let mine = mine(state)
        let editorData: Centraid_Screen_V1_AgendaEditorData? = {
            if mine, case let .data(data)? = state.content { return data }
            return nil
        }()
        PushedPage(
            title: editorData?.heading ?? "",
            parentTitle: chrome.close,
            onBack: { send(event { $0.leave = .init() }) }
        ) {
            if let editorData {
                Button {
                    send(event { $0.save = .init() })
                } label: {
                    Text(chrome.save)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color(editorData.canSave ? "link" : "textFaint", scheme))
                        .frame(minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!editorData.canSave || state.write.phase == .inFlight)
                .accessibilityIdentifier("agenda-editor-save")
            }
        } content: {
            if mine, case let .gone(gone)? = state.content {
                EmptyStateView(headline: gone.title, body: gone.body, actionLabel: gone.actionLabel, onAction: onDone)
                    .accessibilityIdentifier("agenda-editor-gone")
            } else {
                ReadStateView(
                    content: mine ? readContent(state) : .loading(true),
                    loadingLabel: chrome.loading,
                    onRetry: { send(event { $0.refreshed = .init() }) }
                ) { editor in
                    form(editor, state: state)
                }
            }
        }
        .sheet(isPresented: sheetBinding(state, [.calendar, .guests, .repeat, .reminder, .scope])) {
            if let editorData { sheet(state, editorData) }
        }
        .sheet(item: $picking) { pick in
            CivilPickSheet(pick: pick, doneLabel: chrome.done) { picking = nil }
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { send(event { $0.confirmDismissed = .init() }) } }
        )) {
            ConfirmSheet(
                state.confirm,
                cancelLabel: chrome.keepEditing,
                onConfirm: { send(event { $0.confirmed = .init() }) },
                onDismiss: { send(event { $0.confirmDismissed = .init() }) }
            )
        }
        // SAVED, SKIPPED, OR LEFT WITH NOTHING TO LOSE: the editor is done.
        .onChange(of: state.dismissed) { _, dismissed in
            if dismissed, mine { onDone() }
        }
    }

    private func readContent(_ state: Centraid_Screen_V1_AgendaEditorState) -> ScreenContent<Centraid_Screen_V1_AgendaEditorData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case .gone?, nil: return .loading(true)
        }
    }

    @ViewBuilder
    private func form(_ editor: Centraid_Screen_V1_AgendaEditorData, state: Centraid_Screen_V1_AgendaEditorState) -> some View {
        let chrome = state.chrome
        let draft = editor.draft
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                EditableFieldRow(
                    key: chrome.fieldTitle,
                    text: $typedTitle,
                    placeholder: chrome.titlePlaceholder,
                    identifier: "agenda-editor-title"
                ) { typed in
                    guard seeded, typed != draft.title else { return }
                    send(event { $0.title = .with { $0.text = typed } })
                }
                Toggle(isOn: Binding(
                    get: { draft.allDay },
                    set: { on in send(event { $0.allDay = .with { $0.on = on } }) }
                )) {
                    Text(chrome.fieldAllDay)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                }
                .tint(Theme.color("accent", scheme))
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .overlay(alignment: .bottom) { KitHairline() }
                .accessibilityIdentifier("agenda-editor-all-day")
                whenRow(
                    key: chrome.fieldStarts,
                    dayLabel: editor.startDayLabel,
                    timeLabel: editor.startTimeLabel,
                    chrome: chrome,
                    day: draft.startDay,
                    time: draft.startTime,
                    allDay: draft.allDay,
                    identifier: "agenda-editor-start"
                ) { day, time in
                    send(event { $0.start = .with { $0.day = day; $0.time = time } })
                }
                whenRow(
                    key: chrome.fieldEnds,
                    dayLabel: editor.endDayLabel,
                    timeLabel: editor.endTimeLabel,
                    chrome: chrome,
                    day: draft.endDay,
                    time: draft.endTime,
                    allDay: draft.allDay,
                    identifier: "agenda-editor-end"
                ) { day, time in
                    send(event { $0.end = .with { $0.day = day; $0.time = time } })
                }
                if !editor.blockedReason.isEmpty {
                    Text(editor.blockedReason)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("net", scheme))
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.vertical, 6)
                        .accessibilityIdentifier("agenda-editor-blocked")
                }
                ChoiceFieldRow(key: chrome.fieldCalendar, value: editor.calendarLabel, identifier: "agenda-editor-calendar") {
                    send(event { $0.sheetOpened = .with { $0.sheet = .calendar } })
                }
                ChoiceFieldRow(key: chrome.fieldGuests, value: editor.guestsLabel, identifier: "agenda-editor-guests") {
                    send(event { $0.sheetOpened = .with { $0.sheet = .guests } })
                }
                ChoiceFieldRow(key: chrome.fieldRepeat, value: editor.repeatLabel, identifier: "agenda-editor-repeat") {
                    send(event { $0.sheetOpened = .with { $0.sheet = .repeat } })
                }
                .disabled(!editor.repeatEnabled)
                .opacity(editor.repeatEnabled ? 1 : 0.5)
                if !editor.repeatNote.isEmpty {
                    note(editor.repeatNote)
                }
                ChoiceFieldRow(key: chrome.fieldReminder, value: editor.reminderLabel, identifier: "agenda-editor-reminder") {
                    send(event { $0.sheetOpened = .with { $0.sheet = .reminder } })
                }
                EditableFieldRow(
                    key: chrome.fieldLink,
                    text: $typedLink,
                    placeholder: chrome.linkPlaceholder,
                    identifier: "agenda-editor-link"
                ) { typed in
                    guard seeded, typed != draft.link else { return }
                    send(event { $0.link = .with { $0.text = typed } })
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(chrome.fieldNotes)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                    TextField(chrome.notesPlaceholder, text: $typedNotes, axis: .vertical)
                        .centraidType("body")
                        .lineLimit(3...10)
                        .accessibilityLabel(chrome.fieldNotes)
                        .accessibilityIdentifier("agenda-editor-notes")
                        .onChange(of: typedNotes) { _, typed in
                            guard seeded, typed != draft.notes else { return }
                            send(event { $0.notes = .with { $0.text = typed } })
                        }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 8)
                .overlay(alignment: .bottom) { KitHairline() }
                if state.write.phase == .refused, state.write.hasFailure {
                    Text(state.write.failure.sentence)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("net", scheme))
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.top, 12)
                        .accessibilityIdentifier("agenda-editor-status")
                }
                if editor.showSkip {
                    KitOutlineButton(label: editor.skipLabel, tone: "net") { send(event { $0.skip = .init() }) }
                        .padding(CentraidGeometry.pageMargin)
                        .accessibilityIdentifier("agenda-editor-skip")
                }
                if !editor.footNote.isEmpty {
                    note(editor.footNote)
                        .padding(.top, 8)
                }
            }
        }
        .onAppear {
            // ONCE. See `seeded`.
            if !seeded {
                typedTitle = draft.title
                typedNotes = draft.notes
                typedLink = draft.link
                seeded = true
            }
        }
    }

    /// Starts / Ends: the machine's day and time words, each its own tap that
    /// opens the platform's picker over the draft's civil strings (no time
    /// all-day), titled with the machine's "Pick a date" / "Pick a time".
    private func whenRow(
        key: String,
        dayLabel: String,
        timeLabel: String,
        chrome: Centraid_Screen_V1_AgendaEditorChrome,
        day: String,
        time: String,
        allDay: Bool,
        identifier: String,
        onPick: @escaping (String, String) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(key)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
            HStack(spacing: 16) {
                pickerFace(dayLabel, hint: chrome.pickDate, identifier: "\(identifier)-day") {
                    picking = CivilPick(id: "\(identifier)-day", title: chrome.pickDate, time: false, day: day, clock: time) { d, _ in onPick(d, time) }
                }
                if !allDay, !timeLabel.isEmpty {
                    pickerFace(timeLabel, hint: chrome.pickTime, identifier: "\(identifier)-time") {
                        picking = CivilPick(id: "\(identifier)-time", title: chrome.pickTime, time: true, day: day, clock: time) { _, t in onPick(day, t) }
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .overlay(alignment: .bottom) { KitHairline() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    /// The machine's words as the tap that opens a picker.
    private func pickerFace(_ words: String, hint: String, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(words)
                .centraidType("body")
                .monospacedDigit()
                .foregroundStyle(Theme.color("link", scheme))
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(hint)
        .accessibilityIdentifier(identifier)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .centraidType("annotLabel")
            .foregroundStyle(Theme.color("textFaint", scheme))
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 4)
    }

    @ViewBuilder
    private func sheet(_ state: Centraid_Screen_V1_AgendaEditorState, _ editor: Centraid_Screen_V1_AgendaEditorData) -> some View {
        let chrome = state.chrome
        switch state.sheet {
        case .calendar:
            choiceSheet(chrome.fieldCalendar, editor.calendars) { key in
                send(event { $0.calendar = .with { $0.calendarID = key } })
            }
        case .guests:
            choiceSheet(chrome.fieldGuests, editor.guests) { key in
                send(event { $0.guest = .with { $0.partyID = key } })
            }
        case .repeat:
            choiceSheet(chrome.fieldRepeat, editor.repeats, status: editor.repeatNote) { key in
                send(event { $0.repeat = .with { $0.key = key } })
            }
        case .reminder:
            choiceSheet(chrome.fieldReminder, editor.reminders) { key in
                send(event { $0.reminder = .with { $0.key = key } })
            }
        case .scope:
            SheetRoom(
                title: chrome.scopeTitle,
                status: state.write.phase == .refused && state.write.hasFailure ? state.write.failure.sentence : "",
                primary: editor.scopeArmed ? SheetPrimary(label: chrome.save) { send(event { $0.save = .init() }) } : nil
            ) {
                if !chrome.scopeQuestion.isEmpty {
                    Text(chrome.scopeQuestion)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                AgendaScopeRows(scopes: editor.scopes) { scope in
                    send(event { $0.scope = .with { $0.scope = scope } })
                }
            }
        default:
            EmptyView()
        }
    }

    private func choiceSheet(
        _ title: String,
        _ choices: [Centraid_Screen_V1_AgendaChoice],
        status: String = "",
        onPick: @escaping (String) -> Void
    ) -> some View {
        OptionSheet(title: title, status: status) {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(choices, id: \.key) { choice in
                        HStack(spacing: 8) {
                            if !choice.hueKey.isEmpty {
                                Circle()
                                    .fill(Theme.color(AgendaHue.role(choice.hueKey), scheme))
                                    .frame(width: 8, height: 8)
                            }
                            SheetRow(label: choice.label, selected: choice.selected, identifier: "agenda-choice-\(choice.key)") {
                                onPick(choice.key)
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .modifier(AgendaOptionalLabel(label: choice.accessibilityLabel))
                    }
                }
            }
        }
    }

    /// READ from the state, WRITTEN as an event.
    private func sheetBinding(
        _ state: Centraid_Screen_V1_AgendaEditorState,
        _ sheets: Set<Centraid_Screen_V1_AgendaEditorState.Sheet>
    ) -> Binding<Bool> {
        Binding(
            get: { sheets.contains(state.sheet) },
            set: { open in
                guard !open, sheets.contains(state.sheet) else { return }
                send(event { $0.sheetClosed = .init() })
            }
        )
    }
}

private struct AgendaOptionalLabel: ViewModifier {
    let label: String
    func body(content: Content) -> some View {
        if label.isEmpty { content } else { content.accessibilityLabel(label) }
    }
}
