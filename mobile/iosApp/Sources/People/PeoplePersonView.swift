import SwiftUI

/// One person — facts, channels, dates, notes and the touch log — on the kit
/// (#1029 app port). A `PushedPage` from People.
///
/// **THE VIEW DECIDES NOTHING.** The four write sheets, the merge choices and
/// the confirms are all the machine's (`PeoplePersonState.sheet`, `.confirm`);
/// this file draws whichever one the state holds and hands each keystroke back
/// as the sheet's own event. `EditRequested` and `ChannelTapped` are intents
/// `PeopleScreens` routes; `done` (a person moved to the trash) pops.
struct PeoplePersonView: View {
    let data: Data
    let opened: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_PeoplePersonState {
        (try? Centraid_Screen_V1_PeoplePersonState(serializedBytes: data)) ?? .init()
    }

    private var content: ScreenContent<Centraid_Screen_V1_PeoplePersonData> {
        switch state.content {
        case let .loading(loading): return .loading(loading.firstLoad)
        case let .failure(failure): return .failed(failure)
        case let .denied(denied): return .denied(denied)
        case let .data(data): return .data(data)
        case .gone, .none: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        let chrome = state.chrome
        let person: Centraid_Screen_V1_PeoplePersonData? = {
            if case let .data(data) = state.content { return data }
            return nil
        }()
        PushedPage(
            title: person?.name ?? state.nameHint,
            parentTitle: chrome.back,
            onBack: onBack
        ) {
            if person != nil, !chrome.edit.isEmpty {
                Button {
                    send(PeopleEvents.person { $0.edit = .init() })
                } label: {
                    Text(chrome.edit)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .frame(minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("people-person-edit")
            }
        } content: {
            if case let .gone(gone) = state.content {
                EmptyStateView(gone)
            } else {
                ReadStateView(
                    content: content,
                    loadingLabel: chrome.loading,
                    onRetry: { send(PeopleEvents.person { $0.refreshed = .init() }) }
                ) { person in
                    PeoplePersonBody(person: person, state: state, send: send)
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.hasSheet && !state.hasConfirm },
            set: { open in
                guard !open, state.hasSheet else { return }
                send(PeopleEvents.person { $0.sheetClosed = .init() })
            }
        )) {
            PeoplePersonSheetView(sheet: state.sheet, send: send)
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in
                guard !open, state.hasConfirm else { return }
                send(PeopleEvents.person { $0.dismissed = .init() })
            }
        )) {
            ConfirmSheet(
                state.confirm,
                onConfirm: { send(PeopleEvents.person { $0.confirmed = .init() }) },
                onDismiss: { send(PeopleEvents.person { $0.dismissed = .init() }) }
            )
        }
        .onChange(of: state.done) { _, done in
            if done { onBack() }
        }
    }
}

private struct PeoplePersonBody: View {
    let person: Centraid_Screen_V1_PeoplePersonData
    let state: Centraid_Screen_V1_PeoplePersonState
    let send: (Data) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let chrome = state.chrome
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header
                actions(chrome)
                if !state.status.isEmpty {
                    PeopleStatusLine(text: state.status)
                }
                ForEach(Array(person.facts.enumerated()), id: \.offset) { _, fact in
                    FieldRow(key: fact.label, value: fact.value)
                }

                SectionHeader(person.channelsHead)
                if person.channels.isEmpty { PeopleStatusLine(text: person.channelsEmpty) }
                ForEach(person.channels, id: \.channelID) { channel in
                    channelRow(channel)
                }

                SectionHeader(person.datesHead)
                if person.dates.isEmpty { PeopleStatusLine(text: person.datesEmpty) }
                ForEach(person.dates, id: \.dateID) { date in
                    HStack(spacing: 0) {
                        CentraidRow(
                            title: date.label,
                            meta: [date.dayLabel, date.reminderLabel].filter { !$0.isEmpty }.joined(separator: " · "),
                            trailing: date.whenLabel,
                            accessibility: date.accessibilityLabel,
                            identifier: "people-date-\(date.dateID)"
                        )
                        Button {
                            send(PeopleEvents.person { $0.reminder = .with { $0.dateID = date.dateID } })
                        } label: {
                            CentraidIconView(
                                iconKey: "Bell",
                                tint: Theme.color(date.reminderOn ? "text" : "textFaint", scheme),
                                size: 18
                            )
                            .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(date.toggleLabel)
                        .accessibilityAddTraits(date.reminderOn ? .isSelected : [])
                        .accessibilityIdentifier("people-reminder-\(date.dateID)")
                        .padding(.trailing, 8)
                    }
                }

                SectionHeader(person.notesHead)
                if person.notes.isEmpty { PeopleStatusLine(text: person.notesEmpty) }
                ForEach(person.notes, id: \.annotationID) { note in
                    CentraidRow(title: note.text, meta: note.whenLabel, identifier: "people-note-\(note.annotationID)")
                }

                SectionHeader(person.touchesHead)
                if person.touches.isEmpty { PeopleStatusLine(text: person.touchesEmpty) }
                ForEach(person.touches, id: \.interactionID) { touch in
                    CentraidRow(
                        title: touch.kindLabel,
                        meta: touch.text,
                        trailing: touch.whenLabel,
                        accessibility: touch.accessibilityLabel,
                        identifier: "people-touch-\(touch.interactionID)"
                    )
                }

                VStack(alignment: .leading, spacing: 8) {
                    if !chrome.merge.isEmpty {
                        KitOutlineButton(label: chrome.merge) {
                            send(PeopleEvents.person { $0.sheetOpened = .with { $0.which = .merge } })
                        }
                        .accessibilityIdentifier("people-person-merge")
                    }
                    if !chrome.moveToTrash.isEmpty {
                        KitOutlineButton(label: chrome.moveToTrash, tone: "net") {
                            send(PeopleEvents.person { $0.trashTapped = .init() })
                        }
                        .accessibilityIdentifier("people-person-trash")
                    }
                }
                .padding(CentraidGeometry.pageMargin)
            }
        }
        .refreshable { send(PeopleEvents.person { $0.refreshed = .init() }) }
        .accessibilityIdentifier("people-person")
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            PeopleAvatarView(avatar: person.avatar, size: 56)
            VStack(alignment: .leading, spacing: 4) {
                Text(person.name)
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                    .accessibilityAddTraits(.isHeader)
                if !person.role.isEmpty {
                    Text(person.role)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                if !person.cadenceLine.isEmpty {
                    Text(person.cadenceLine)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
                if person.hasDueChip {
                    StatusChipView(person.dueChip)
                }
            }
            Spacer(minLength: 0)
            PeopleStarButton(
                starred: person.starred,
                label: person.starLabel,
                identifier: "people-person-star",
                onTap: { send(PeopleEvents.person { $0.star = .init() }) }
            )
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 12)
    }

    private func actions(_ chrome: Centraid_Screen_V1_PeoplePersonChrome) -> some View {
        let verbs: [(String, Centraid_Screen_V1_PeoplePersonEvent.SheetOpened.Which, String)] = [
            (chrome.logTouch, .logTouch, "log-touch"),
            (chrome.addNote, .note, "add-note"),
            (chrome.addDate, .date, "add-date"),
            (chrome.addChannel, .channel, "add-channel"),
        ]
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(verbs.filter { !$0.0.isEmpty }, id: \.2) { verb in
                    KitOutlineButton(label: verb.0) {
                        send(PeopleEvents.person { $0.sheetOpened = .with { $0.which = verb.1 } })
                    }
                    .accessibilityIdentifier("people-person-\(verb.2)")
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
        }
        .padding(.bottom, 8)
    }

    private func channelRow(_ channel: Centraid_Screen_V1_PeopleChannelRow) -> some View {
        HStack(spacing: 0) {
            CentraidRow(
                title: channel.value,
                meta: [channel.kindLabel, channel.label, channel.preferredLabel, channel.duplicateNote]
                    .filter { !$0.isEmpty }
                    .joined(separator: " · "),
                accessibility: channel.accessibilityLabel,
                identifier: "people-channel-\(channel.channelID)",
                onTap: { send(PeopleEvents.person { $0.channel = .with { $0.channelID = channel.channelID } }) }
            )
            if !channel.actionLabel.isEmpty {
                Button {
                    send(PeopleEvents.person { $0.channel = .with { $0.channelID = channel.channelID } })
                } label: {
                    Text(channel.actionLabel)
                        .centraidType("annotLabelOn")
                        .foregroundStyle(Theme.color("link", scheme))
                        .frame(minWidth: CentraidGeometry.targetMinCoarse, minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("people-channel-action-\(channel.channelID)")
            }
            if !channel.removeLabel.isEmpty {
                Button {
                    send(PeopleEvents.person { $0.removeChannel = .with { $0.channelID = channel.channelID } })
                } label: {
                    CentraidIconView(iconKey: "X", tint: Theme.color("textFaint", scheme), size: 14)
                        .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(channel.removeLabel)
                .accessibilityIdentifier("people-channel-remove-\(channel.channelID)")
            }
        }
        .padding(.trailing, 8)
    }
}

// MARK: - The write sheets

/// WHICHEVER SHEET THE MACHINE HOLDS. Each field's text is the view's own
/// `@State` (seeded once, like every editor field), handed over as the
/// sheet's `TextChanged` / `SecondTextChanged`.
private struct PeoplePersonSheetView: View {
    let sheet: Centraid_Screen_V1_PeoplePersonSheet
    let send: (Data) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        switch sheet.kind {
        case let .logTouch(log):
            frameRoom(log.frame) {
                PeopleKindChips(kinds: log.kinds, send: send)
                PeopleSheetField(
                    key: log.noteLabel,
                    seed: log.note,
                    placeholder: log.notePlaceholder,
                    identifier: "people-sheet-note",
                    onEdit: { text in send(PeopleEvents.person { $0.text = .with { $0.text = text } }) }
                )
                if !log.hint.isEmpty {
                    Text(log.hint)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
            }
        case let .note(note):
            frameRoom(note.frame) {
                PeopleSheetField(
                    key: "",
                    seed: note.text,
                    placeholder: note.placeholder,
                    identifier: "people-sheet-note",
                    onEdit: { text in send(PeopleEvents.person { $0.text = .with { $0.text = text } }) }
                )
            }
        case let .date(date):
            frameRoom(date.frame) {
                PeopleSheetField(
                    key: date.labelField,
                    seed: date.label,
                    placeholder: "",
                    identifier: "people-sheet-date-label",
                    onEdit: { text in send(PeopleEvents.person { $0.text = .with { $0.text = text } }) }
                )
                PeopleSheetField(
                    key: date.monthDayField,
                    seed: date.monthDay,
                    placeholder: date.monthDayPlaceholder,
                    identifier: "people-sheet-date-day",
                    onEdit: { text in send(PeopleEvents.person { $0.secondText = .with { $0.text = text } }) }
                )
                if !date.monthDayInvalid.isEmpty {
                    Text(date.monthDayInvalid)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("net", scheme))
                }
                PeopleFlagRow(label: date.reminderLabel, on: date.reminderOn, identifier: "people-sheet-reminder") {
                    send(PeopleEvents.person { $0.flag = .init() })
                }
            }
        case let .channel(channel):
            frameRoom(channel.frame) {
                PeopleKindChips(kinds: channel.kinds, send: send)
                PeopleSheetField(
                    key: channel.valueField,
                    seed: channel.value,
                    placeholder: "",
                    identifier: "people-sheet-channel-value",
                    onEdit: { text in send(PeopleEvents.person { $0.text = .with { $0.text = text } }) }
                )
                PeopleSheetField(
                    key: channel.labelField,
                    seed: channel.label,
                    placeholder: "",
                    identifier: "people-sheet-channel-label",
                    onEdit: { text in send(PeopleEvents.person { $0.secondText = .with { $0.text = text } }) }
                )
                PeopleFlagRow(label: channel.preferredLabel, on: channel.preferred, identifier: "people-sheet-preferred") {
                    send(PeopleEvents.person { $0.flag = .init() })
                }
            }
        case let .merge(merge):
            SheetRoom(title: merge.title) {
                if !merge.body.isEmpty {
                    Text(merge.body)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                switch merge.content {
                case .loading, .none:
                    RowSkeleton(rows: 3, label: merge.title)
                        .frame(height: 170)
                case let .failure(failure):
                    FailureView(sentence: failure.sentence, remedy: failure.remedy, onRetry: nil)
                case let .choices(choices):
                    if choices.hasEmpty {
                        EmptyStateView(choices.empty)
                    } else {
                        ScrollView {
                            VStack(spacing: 0) {
                                ForEach(choices.choices, id: \.partyID) { choice in
                                    HStack(spacing: 0) {
                                        PeopleAvatarView(avatar: choice.avatar)
                                        CentraidRow(
                                            title: choice.name,
                                            meta: choice.role,
                                            identifier: "people-merge-\(choice.partyID)",
                                            onTap: {
                                                send(PeopleEvents.person { $0.mergePicked = .with { $0.partyID = choice.partyID } })
                                            }
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                cancel(merge.cancelLabel)
            }
        case .none:
            EmptyView()
        }
    }

    private func frameRoom<Fields: View>(
        _ frame: Centraid_Screen_V1_PeopleSheetFrame,
        @ViewBuilder fields: @escaping () -> Fields
    ) -> some View {
        SheetRoom(
            title: frame.title,
            status: frame.hasFailure ? frame.failure.sentence : "",
            primary: SheetPrimary(label: frame.submitLabel) {
                guard frame.submitEnabled, !frame.sending else { return }
                send(PeopleEvents.person { $0.submitted = .init() })
            }
        ) {
            fields()
            cancel(frame.cancelLabel)
        }
    }

    @ViewBuilder
    private func cancel(_ label: String) -> some View {
        if !label.isEmpty {
            Button {
                send(PeopleEvents.person { $0.sheetClosed = .init() })
            } label: {
                Text(label)
                    .centraidType("labelOn")
                    .foregroundStyle(Theme.color("text", scheme))
                    .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("people-sheet-cancel")
        }
    }
}

/// A sheet's kind choice: one chip per kind, the machine's selection lit.
private struct PeopleKindChips: View {
    let kinds: [Centraid_Screen_V1_PeopleKindChoice]
    let send: (Data) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(kinds, id: \.key) { kind in
                    Button {
                        send(PeopleEvents.person { $0.kindPicked = .with { $0.key = kind.key } })
                    } label: {
                        Text(kind.label)
                            .centraidType(kind.selected ? "smallStrong" : "small")
                            .foregroundStyle(Theme.color(kind.selected ? "text" : "textSoft", scheme))
                            .padding(.horizontal, 12)
                            .frame(minHeight: 32)
                            .background(Capsule().fill(Theme.color(kind.selected ? "bgSunken" : "bgElev", scheme)))
                            .overlay(
                                Capsule().strokeBorder(
                                    Theme.color(kind.selected ? "lineStrong" : "line", scheme),
                                    lineWidth: CentraidGeometry.hairline
                                )
                            )
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(kind.selected ? .isSelected : [])
                    .accessibilityIdentifier("people-kind-\(kind.key)")
                }
            }
        }
    }
}

/// A sheet's text field: typed text held here, seeded once from the machine.
private struct PeopleSheetField: View {
    let key: String
    let seed: String
    let placeholder: String
    let identifier: String
    let onEdit: (String) -> Void

    @State private var text = ""
    @State private var seeded = false

    var body: some View {
        EditableFieldRow(key: key, text: $text, placeholder: placeholder, identifier: identifier) { typed in
            guard seeded, typed != seed else { return }
            onEdit(typed)
        }
        .padding(.horizontal, -CentraidGeometry.pageMargin)
        .onAppear {
            if !seeded {
                text = seed
                seeded = true
            }
        }
    }
}

/// A sheet's on/off: the machine's flag, flipped by its `FlagToggled`.
private struct PeopleFlagRow: View {
    let label: String
    let on: Bool
    let identifier: String
    let onToggle: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Toggle(isOn: Binding(get: { on }, set: { value in if value != on { onToggle() } })) {
            Text(label)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
        }
        .frame(minHeight: CentraidGeometry.targetMinCoarse)
        .accessibilityIdentifier(identifier)
    }
}
