import SwiftUI

/// `agenda.editor` — make an event, edit one, or edit one occurrence of one
/// (#1135).
///
/// **THE ONE EXPLICIT SAVE.** A wrong date written by an autosave is worse
/// than a lost draft, so this editor is the deliberate exception to #1015 D3:
/// a `PushedPage` whose one trailing action is Save, armed by the state's
/// `can_save`. Back never pops by itself — it forwards `LeaveRequested`, and
/// Rust asks first when there are changes (the discard confirm) or
/// answers `dismissed`, which is what pops.
///
/// The date and time pickers bind to the draft's civil strings
/// (`CivilDayPicker`/`CivilTimePicker`) and forward what was picked; every
/// label, choice, block reason and note is Rust's.
struct AgendaEditorView: View {
    let state: Centraid_Core_V1_AgendaEditorState
    let send: (Centraid_Core_V1_AgendaEditorEvent) -> Void
    let onDone: () -> Void

    /// THE MEMBER'S TYPING, seeded once from the draft (`NotesEditorView`'s rule).
    @State private var typedTitle = ""
    @State private var typedNotes = ""
    @State private var typedLink = ""
    /// A task's address, typed (seeded once like the others).
    @State private var typedUrl = ""
    /// The tag field's typing, cleared when it is sent (`TagAdded`).
    @State private var typedTag = ""
    @State private var seeded = false
    /// Which platform picker is up — presentation only: the value it opens on
    /// and the words over it are the draft's and Rust's.
    @State private var picking: CivilPick? = nil

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_AgendaEditorEvent) -> Void) -> Centraid_Core_V1_AgendaEditorEvent {
        var event = Centraid_Core_V1_AgendaEditorEvent()
        build(&event)
        return event
    }

    var body: some View {
        let chrome = state.chrome
        let editorData: Centraid_Core_V1_AgendaEditorData? = {
            if case let .data(data)? = state.content { return data }
            return nil
        }()
        PushedPage(
            title: editorData?.heading ?? "",
            parentTitle: chrome.close,
            onBack: { send(event { $0.leave = .init() }) }
        ) {
            if let editorData {
                // THE SAVE PILL (#1173): Agenda's blue under a white word, as on the board. The bar
                // hosts it outside the page's environment, so the accent is stated here.
                KitPillButton(label: chrome.save) {
                    send(event { $0.save = .init() })
                }
                .environment(\.appAccent, AppAccent("calendar"))
                .disabled(!editorData.canSave)
                .accessibilityIdentifier("agenda-editor-save")
            }
        } content: {
            // THE READ IS THE KIT'S PAGE STATE (#1185): a task or event that is gone is its final failure.
            PageReadStateView(
                page: state.page,
                loadingLabel: chrome.loading,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) {
                if let editorData {
                    form(editorData, state: state)
                }
            }
        }
        .sheet(isPresented: sheetBinding(state, [.calendar, .guests, .repeat, .reminder, .scope, .list, .customRepeat, .location, .secondReminder, .availability, .zone, .travel])) {
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
            if dismissed { onDone() }
        }
    }

    @ViewBuilder
    private func form(_ editor: Centraid_Core_V1_AgendaEditorData, state: Centraid_Core_V1_AgendaEditorState) -> some View {
        let chrome = state.chrome
        let draft = editor.draft
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // THE ADD SHEET'S SWITCH (#1128): only a create has one, and
                // Rust says which side is lit and what each is called.
                if !editor.kinds.isEmpty {
                    KitSegmented(
                        options: editor.kinds.map { (key: $0.kind, label: $0.label) },
                        selected: editor.kinds.first(where: { $0.selected })?.kind ?? .event,
                        identifier: "agenda-editor-kind"
                    ) { kind in
                        send(event { $0.kindPicked = .with { $0.kind = kind } })
                    }
                    .accessibilityLabel(chrome.kindLabel)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.vertical, 8)
                }
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
                .kitToggle()
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .overlay(alignment: .bottom) { KitHairline() }
                .accessibilityIdentifier("agenda-editor-all-day")
                if editor.showEventFields {
                    // THE BOARD'S TWO CARDS (#1173): the times and the repeat, then the details,
                    // each row a colour tile Rust names.
                    AgendaGroupCard {
                        whenRow(
                            key: editor.startFieldLabel,
                            dayLabel: editor.startDayLabel.isEmpty ? editor.startLabel : editor.startDayLabel,
                            timeLabel: editor.startTimeLabel,
                            chrome: chrome,
                            day: draft.startDay,
                            time: draft.startTime,
                            allDay: draft.allDay,
                            identifier: "agenda-editor-start",
                            tile: tile("start", chrome)
                        ) { day, time in
                            send(event { $0.start = .with { $0.day = day; $0.time = time } })
                        }
                        whenRow(
                            key: chrome.fieldEnds,
                            dayLabel: editor.endDayLabel.isEmpty ? editor.endLabel : editor.endDayLabel,
                            timeLabel: editor.endTimeLabel,
                            chrome: chrome,
                            day: draft.endDay,
                            time: draft.endTime,
                            allDay: draft.allDay,
                            identifier: "agenda-editor-end",
                            tile: tile("end", chrome)
                        ) { day, time in
                            send(event { $0.end = .with { $0.day = day; $0.time = time } })
                        }
                        AgendaTileChoiceRow(
                            key: chrome.fieldRepeat,
                            value: editor.repeatLabel,
                            tile: tile("repeat", chrome),
                            identifier: "agenda-editor-repeat",
                            divider: false
                        ) {
                            send(event { $0.sheetOpened = .with { $0.sheet = .repeat } })
                        }
                    }
                    if !editor.repeatNote.isEmpty {
                        note(editor.repeatNote)
                    }
                    blockedNote(editor)
                    AgendaGroupCard {
                        AgendaTileChoiceRow(
                            key: chrome.fieldCalendar,
                            value: editor.calendarLabel,
                            tile: tile("calendar", chrome),
                            identifier: "agenda-editor-calendar"
                        ) {
                            send(event { $0.sheetOpened = .with { $0.sheet = .calendar } })
                        }
                        AgendaTileChoiceRow(
                            key: chrome.fieldGuests,
                            value: editor.guestsLabel,
                            tile: tile("guests", chrome),
                            identifier: "agenda-editor-guests"
                        ) {
                            send(event { $0.sheetOpened = .with { $0.sheet = .guests } })
                        }
                        AgendaTileChoiceRow(
                            key: chrome.fieldLocation,
                            value: editor.locationLabel,
                            tile: tile("location", chrome),
                            identifier: "agenda-editor-location"
                        ) {
                            send(event { $0.sheetOpened = .with { $0.sheet = .location } })
                        }
                        AgendaTileChoiceRow(
                            key: chrome.fieldFirstAlert,
                            value: editor.reminderLabel,
                            tile: tile("reminder", chrome),
                            identifier: "agenda-editor-reminder"
                        ) {
                            send(event { $0.sheetOpened = .with { $0.sheet = .reminder } })
                        }
                        // AN ALERT NEEDS A TIME: Rust says when the event has none.
                        if !editor.reminderNote.isEmpty {
                            note(editor.reminderNote)
                        }
                        // THE SECOND ALERT waits for the first: Rust says when it is drawn.
                        if editor.showSecondReminder {
                            AgendaTileChoiceRow(
                                key: chrome.fieldSecondAlert,
                                value: editor.secondReminderLabel,
                                tile: tile("second_reminder", chrome),
                                identifier: "agenda-editor-second-reminder"
                            ) {
                                send(event { $0.sheetOpened = .with { $0.sheet = .secondReminder } })
                            }
                        }
                        AgendaTileChoiceRow(
                            key: chrome.fieldAvailability,
                            value: editor.availabilityLabel,
                            tile: tile("availability", chrome),
                            identifier: "agenda-editor-availability"
                        ) {
                            send(event { $0.sheetOpened = .with { $0.sheet = .availability } })
                        }
                        if editor.showZone {
                            AgendaTileChoiceRow(
                                key: chrome.fieldZone,
                                value: editor.zoneLabel,
                                tile: tile("zone", chrome),
                                identifier: "agenda-editor-zone"
                            ) {
                                send(event { $0.sheetOpened = .with { $0.sheet = .zone } })
                            }
                        }
                        AgendaTileChoiceRow(
                            key: chrome.fieldTravel,
                            value: editor.travelLabel,
                            tile: tile("travel", chrome),
                            identifier: "agenda-editor-travel"
                        ) {
                            send(event { $0.sheetOpened = .with { $0.sheet = .travel } })
                        }
                        AgendaTileFieldRow(
                            key: chrome.fieldLink,
                            text: $typedLink,
                            placeholder: chrome.linkPlaceholder,
                            tile: tile("link", chrome),
                            identifier: "agenda-editor-link",
                            divider: false
                        ) { typed in
                            guard seeded, typed != draft.link else { return }
                            send(event { $0.link = .with { $0.text = typed } })
                        }
                    }
                    notesField(draft, chrome: chrome)
                } else {
                    // A TASK IS A TITLE AND A DUE DAY: the event's fields are not drawn.
                    whenRow(
                        key: editor.startFieldLabel,
                        dayLabel: editor.startDayLabel.isEmpty ? editor.startLabel : editor.startDayLabel,
                        timeLabel: editor.startTimeLabel,
                        chrome: chrome,
                        day: draft.startDay,
                        time: draft.startTime,
                        allDay: draft.allDay,
                        identifier: "agenda-editor-start"
                    ) { day, time in
                        send(event { $0.start = .with { $0.day = day; $0.time = time } })
                    }
                    blockedNote(editor)
                }
                // THE NEW TASK SHEET (#1173): Notes, the list, and a More details row that opens
                // priority, repeat and tags.
                if editor.showTaskFields {
                    notesField(draft, chrome: chrome)
                    ChoiceFieldRow(
                        key: chrome.fieldList,
                        value: editor.listLabel,
                        hueKey: editor.listHueKey,
                        identifier: "agenda-editor-list"
                    ) {
                        send(event { $0.sheetOpened = .with { $0.sheet = .list } })
                    }
                    ChoiceFieldRow(
                        key: chrome.fieldMoreDetails,
                        value: editor.moreDetailsSummary,
                        identifier: "agenda-editor-more-details"
                    ) {
                        send(event { $0.moreDetails = .init() })
                    }
                    if editor.moreDetailsOpen {
                        moreDetails(editor, draft: draft, chrome: chrome)
                    }
                }
                // A TASK'S ADDRESS: typed as it comes, and what Save will write said under it.
                if editor.showURL {
                    EditableFieldRow(
                        key: chrome.fieldURL,
                        text: $typedUrl,
                        placeholder: chrome.urlPlaceholder,
                        identifier: "agenda-editor-url"
                    ) { typed in
                        guard seeded, typed != draft.url else { return }
                        send(event { $0.url = .with { $0.text = typed } })
                    }
                    if !editor.urlSavedAs.isEmpty {
                        note(editor.urlSavedAs)
                    }
                }
                if state.hasStatus, !state.status.sentence.isEmpty {
                    Text(state.status.sentence)
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
                typedUrl = draft.url
                seeded = true
            }
        }
    }

    /// Notes: the member's typing, forwarded as it comes (an event's last field, a task's first below the due).
    private func notesField(_ draft: Centraid_Core_V1_AgendaDraft, chrome: Centraid_Core_V1_AgendaEditorChrome) -> some View {
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
    }

    /// THE OPEN MORE DETAILS ROW: priority, repeat and tags, every word Rust's.
    @ViewBuilder
    private func moreDetails(
        _ editor: Centraid_Core_V1_AgendaEditorData,
        draft: Centraid_Core_V1_AgendaDraft,
        chrome: Centraid_Core_V1_AgendaEditorChrome
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(editor.priorityLabel.isEmpty ? chrome.fieldPriority : editor.priorityLabel)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
            HStack(spacing: 6) {
                ForEach(editor.priorities, id: \.key) { choice in
                    KitChip(
                        label: choice.label,
                        selected: choice.selected,
                        spoken: choice.accessibilityLabel,
                        identifier: "agenda-editor-priority-\(choice.key)"
                    ) {
                        send(event { $0.priority = .with { $0.key = choice.key } })
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .overlay(alignment: .bottom) { KitHairline() }
        ChoiceFieldRow(key: chrome.fieldRepeat, value: editor.repeatLabel, identifier: "agenda-editor-repeat") {
            send(event { $0.sheetOpened = .with { $0.sheet = .repeat } })
        }
        VStack(alignment: .leading, spacing: 6) {
            Text(chrome.fieldTags)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
            if !draft.tags.isEmpty {
                // A TAG IS A LIT CHIP: a tap takes it off.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(draft.tags, id: \.self) { tag in
                            KitChip(label: tag, selected: true, identifier: "agenda-editor-tag-\(tag)") {
                                send(event { $0.tagRemoved = .with { $0.text = tag } })
                            }
                        }
                    }
                }
            }
            TextField(chrome.tagPlaceholder, text: $typedTag)
                .centraidType("body")
                .submitLabel(.done)
                .onSubmit {
                    let text = typedTag.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    typedTag = ""
                    send(event { $0.tagAdded = .with { $0.text = text } })
                }
                .accessibilityLabel(chrome.fieldTags)
                .accessibilityIdentifier("agenda-editor-tag-field")
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { KitHairline() }
    }

    /// Starts / Ends: Rust's day and time words, each its own tap that
    /// opens the platform's picker over the draft's civil strings (no time
    /// all-day), titled with Rust's "Pick a date" / "Pick a time".
    @ViewBuilder
    private func whenRow(
        key: String,
        dayLabel: String,
        timeLabel: String,
        chrome: Centraid_Core_V1_AgendaEditorChrome,
        day: String,
        time: String,
        allDay: Bool,
        identifier: String,
        tile: Centraid_Core_V1_AgendaRowTile? = nil,
        onPick: @escaping (String, String) -> Void
    ) -> some View {
        let faces = HStack(spacing: 12) {
            pickerFace(dayLabel, hint: chrome.pickDate, identifier: "\(identifier)-day") {
                picking = CivilPick(id: "\(identifier)-day", title: chrome.pickDate, time: false, day: day, clock: time) { d, _ in onPick(d, time) }
            }
            if !allDay, !timeLabel.isEmpty {
                pickerFace(timeLabel, hint: chrome.pickTime, identifier: "\(identifier)-time") {
                    picking = CivilPick(id: "\(identifier)-time", title: chrome.pickTime, time: true, day: day, clock: time) { _, t in onPick(day, t) }
                }
            }
        }
        if tile != nil {
            // ON THE BOARD'S CARD: the tile, the label, the two taps at the trailing end.
            AgendaTileWhenRow(key: key, tile: tile, identifier: identifier) { faces }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text(key)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                HStack(spacing: 16) {
                    faces
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
    }

    /// The tile Rust names for an event row (`AgendaEditorChrome.tiles`, by key); nil draws none.
    private func tile(_ key: String, _ chrome: Centraid_Core_V1_AgendaEditorChrome) -> Centraid_Core_V1_AgendaRowTile? {
        chrome.tiles.first { $0.key == key }
    }

    /// Why Save is held back, said under the times.
    @ViewBuilder
    private func blockedNote(_ editor: Centraid_Core_V1_AgendaEditorData) -> some View {
        if !editor.blockedReason.isEmpty {
            Text(editor.blockedReason)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("net", scheme))
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 6)
                .accessibilityIdentifier("agenda-editor-blocked")
        }
    }

    /// Rust's words as the tap that opens a picker.
    private func pickerFace(_ words: String, hint: String, identifier: String, action: @escaping () -> Void) -> some View {
        // ONE LINE: the day is the short "Wed 4 Nov" and the pair sits on the board's row.
        KitLink(label: words, identifier: identifier, action: action)
            .monospacedDigit()
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .accessibilityHint(hint)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .centraidType("annotLabel")
            .foregroundStyle(Theme.color("textFaint", scheme))
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 4)
    }

    @ViewBuilder
    private func sheet(_ state: Centraid_Core_V1_AgendaEditorState, _ editor: Centraid_Core_V1_AgendaEditorData) -> some View {
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
        case .list:
            choiceSheet(chrome.fieldList, editor.lists, idPrefix: "agenda-editor-list", chosen: editor.draft.listKey) { key in
                send(event { $0.list = .with { $0.key = key } })
            }
        case .customRepeat:
            if editor.hasCustomRepeat {
                AgendaCustomRepeatSheetView(sheet: editor.customRepeat, fallbackTitle: chrome.customRepeatTitle, send: send)
            }
        case .location:
            AgendaSearchChoiceSheet(
                title: chrome.fieldLocation,
                placeholder: chrome.placeSearchPlaceholder,
                query: editor.placeQuery,
                searchIdentifier: "agenda-editor-place-search",
                idPrefix: "agenda-editor-place",
                choices: editor.places,
                clearLabel: editor.showClearLocation ? chrome.clearLocation_p : "",
                clearIdentifier: "agenda-editor-place-clear",
                onSearch: { text in send(event { $0.placeSearch = .with { $0.text = text } }) },
                onPick: { key in send(event { $0.place = .with { $0.key = key } }) },
                onClear: { send(event { $0.placeCleared = .init() }) }
            )
        case .secondReminder:
            choiceSheet(chrome.fieldSecondAlert, editor.secondReminders, idPrefix: "agenda-editor-second-reminder") { key in
                send(event { $0.secondReminder = .with { $0.key = key } })
            }
        case .availability:
            choiceSheet(chrome.fieldAvailability, editor.availabilities, idPrefix: "agenda-editor-availability") { key in
                send(event { $0.availability = .with { $0.key = key } })
            }
        case .zone:
            AgendaSearchChoiceSheet(
                title: chrome.fieldZone,
                placeholder: chrome.zoneSearchPlaceholder,
                query: editor.zoneQuery,
                searchIdentifier: "agenda-editor-zone-search",
                idPrefix: "agenda-editor-zone",
                choices: editor.zones,
                onSearch: { text in send(event { $0.zoneSearch = .with { $0.text = text } }) },
                onPick: { key in send(event { $0.zone = .with { $0.key = key } }) }
            )
        case .travel:
            choiceSheet(chrome.fieldTravel, editor.travels, idPrefix: "agenda-editor-travel") { key in
                send(event { $0.travel = .with { $0.key = key } })
            }
        case .scope:
            SheetRoom(
                title: chrome.scopeTitle,
                status: state.hasStatus ? state.status.sentence : "",
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
        _ choices: [Centraid_Core_V1_AgendaChoice],
        status: String = "",
        idPrefix: String = "agenda-choice",
        chosen: String = "",
        onPick: @escaping (String) -> Void
    ) -> some View {
        OptionSheet(title: title, status: status) {
            ForEach(choices, id: \.key) { choice in
                HStack(spacing: 8) {
                    if !choice.hueKey.isEmpty {
                        Circle()
                            .fill(agendaHue(choice.hueKey, scheme))
                            .frame(width: 8, height: 8)
                    }
                    SheetRow(label: choice.label, selected: choice.selected || (!chosen.isEmpty && choice.key == chosen), identifier: "\(idPrefix)-\(choice.key)") {
                        onPick(choice.key)
                    }
                }
                .accessibilityElement(children: .combine)
                .modifier(AgendaOptionalLabel(label: choice.accessibilityLabel))
            }
        }
    }

    /// READ from the state, WRITTEN as an event.
    private func sheetBinding(
        _ state: Centraid_Core_V1_AgendaEditorState,
        _ sheets: Set<Centraid_Core_V1_AgendaEditorState.Sheet>
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
