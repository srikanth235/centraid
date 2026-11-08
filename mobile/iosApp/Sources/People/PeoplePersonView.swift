import SwiftUI

/// `people.person` — one person: facts, channels, dates, notes and the touch log
/// (#1135). A `PushedPage` from People.
///
/// **THE VIEW DECIDES NOTHING.** The four write sheets, the merge choices, the
/// confirms and the status are all Rust's (`PeoplePersonState.sheet`, `.confirm`,
/// `.status`); this file draws whichever one the state holds and hands each
/// keystroke back as the sheet's own event. Edit is a `Route` the state carries;
/// a channel's tap is an event and Rust asks this shell to call, mail, map or
/// copy it; `done` (a person moved to the trash) pops.
struct PeoplePersonView: View {
    let state: Centraid_Core_V1_PeoplePersonState
    let send: (Centraid_Core_V1_PeoplePersonEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var content: ScreenContent<Centraid_Core_V1_PeoplePersonData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        case .gone?, nil: return .loading(true)
        }
    }

    var body: some View {
        let chrome = state.chrome
        let person: Centraid_Core_V1_PeoplePersonData? = {
            if case let .data(data)? = state.content { return data }
            return nil
        }()
        // THE NAME IS THE HERO'S, so the bar carries no title of its own once the person is read:
        // only the back chevron and the keys. Until then the bar holds the name the row carried
        // (`nameHint`), as Android's does.
        PushedPage(
            title: person == nil ? state.nameHint : "",
            parentTitle: chrome.back,
            onBack: onBack
        ) {
            HStack(spacing: 4) {
                if let person, !person.isMe {
                    personMenu(person, chrome)
                }
                if person != nil, state.hasEdit, !chrome.edit.isEmpty {
                    ToolbarVerb(label: chrome.edit, identifier: "people-person-edit") {
                        open(state.edit)
                    }
                }
            }
        } content: {
            if case let .gone(gone)? = state.content {
                EmptyStateView(gone)
            } else {
                ReadStateView(
                    content: content,
                    loadingLabel: chrome.loading,
                    onRetry: { send(PeopleEvents.person { $0.refreshed = .init() }) }
                ) { person in
                    PeoplePersonBody(person: person, state: state, send: send, open: open)
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.hasSheet && !state.hasConfirm },
            set: { shown in
                guard !shown, state.hasSheet else { return }
                send(PeopleEvents.person { $0.sheetClosed = .init() })
            }
        )) {
            PeoplePersonSheetView(sheet: state.sheet, send: send)
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { shown in
                guard !shown, state.hasConfirm else { return }
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

    /// STAR, MERGE AND MOVE TO TRASH: one glass key in the bar, as the board draws it. Each is an
    /// event or a sheet Rust opened before; the owner's own card has none of them.
    private func personMenu(
        _ person: Centraid_Core_V1_PeoplePersonData,
        _ chrome: Centraid_Core_V1_PeoplePersonChrome
    ) -> some View {
        Menu {
            Button(person.starLabel) {
                send(PeopleEvents.person { $0.star = .init() })
            }
            .accessibilityIdentifier("people-person-star")
            if !chrome.merge.isEmpty {
                Button(chrome.merge) {
                    send(PeopleEvents.person { $0.sheetOpened = .with { $0.which = .merge } })
                }
                .accessibilityIdentifier("people-person-merge")
            }
            if !chrome.moveToTrash.isEmpty {
                Button(chrome.moveToTrash, role: .destructive) {
                    send(PeopleEvents.person { $0.trashTapped = .init() })
                }
                .accessibilityIdentifier("people-person-trash")
            }
        } label: {
            CentraidIconView(iconKey: "MoreHoriz", tint: Surface.ink, size: 18)
                .frame(minWidth: 30, minHeight: CentraidGeometry.targetMinCoarse)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(chrome.more)
        .accessibilityIdentifier("people-person-menu")
    }
}

private struct PeoplePersonBody: View {
    let person: Centraid_Core_V1_PeoplePersonData
    let state: Centraid_Core_V1_PeoplePersonState
    let send: (Centraid_Core_V1_PeoplePersonEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent

    private func openSheet(_ which: Centraid_Core_V1_PeoplePersonEvent.SheetOpened.Which) {
        send(PeopleEvents.person { $0.sheetOpened = .with { $0.which = which } })
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                hero
                heroActions
                if state.hasStatus, !state.status.sentence.isEmpty {
                    PeopleStatusLine(text: state.status.sentence)
                }

                SectionHeader(
                    title: person.channelsHead.title,
                    count: person.channelsHead.count,
                    verb: person.channelsHead.verbLabel
                ) { openSheet(.channel) }
                if person.channels.isEmpty {
                    PeopleStatusLine(text: person.channelsEmpty)
                } else {
                    VStack(spacing: 0) {
                        ForEach(person.channels, id: \.channelID) { channel in
                            channelRow(channel)
                        }
                    }
                    .peopleCard()
                }

                SectionHeader(
                    title: person.datesHead.title,
                    count: person.datesHead.count,
                    verb: person.datesHead.verbLabel
                ) { openSheet(.date) }
                if person.dates.isEmpty && person.facts.isEmpty {
                    PeopleStatusLine(text: person.datesEmpty)
                } else {
                    VStack(spacing: 0) {
                        ForEach(person.dates, id: \.dateID) { date in
                            dateRow(date)
                        }
                        ForEach(Array(person.facts.enumerated()), id: \.offset) { _, fact in
                            FieldRow(key: fact.label, value: fact.value)
                        }
                    }
                    .peopleCard()
                }

                if !person.relations.isEmpty {
                    SectionHeader(title: person.relationsHead.title, count: person.relationsHead.count)
                    VStack(spacing: 0) {
                        ForEach(Array(person.relations.enumerated()), id: \.offset) { _, relation in
                            CentraidRow(
                                title: relation.name,
                                meta: relation.meta,
                                accessibility: relation.accessibilityLabel,
                                identifier: "people-relation-\(relation.partyID)"
                            )
                        }
                    }
                    .peopleCard()
                }

                if !person.vault.isEmpty {
                    vault
                }

                SectionHeader(
                    title: person.notesHead.title,
                    count: person.notesHead.count,
                    verb: person.notesHead.verbLabel
                ) { openSheet(.note) }
                if person.notes.isEmpty {
                    PeopleStatusLine(text: person.notesEmpty)
                } else {
                    VStack(spacing: 0) {
                        ForEach(person.notes, id: \.annotationID) { note in
                            CentraidRow(title: note.text, meta: note.whenLabel, identifier: "people-note-\(note.annotationID)")
                        }
                    }
                    .peopleCard()
                }

                if !person.isMe {
                    SectionHeader(
                        title: person.touchesHead.title,
                        count: person.touchesHead.count,
                        verb: person.touchesHead.verbLabel
                    ) { openSheet(.logTouch) }
                    if person.touches.isEmpty {
                        PeopleStatusLine(text: person.touchesEmpty)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(person.touches, id: \.interactionID) { touch in
                                CentraidRow(
                                    title: touch.kindLabel,
                                    meta: touch.text,
                                    trailing: touch.whenLabel,
                                    accessibility: touch.accessibilityLabel,
                                    identifier: "people-touch-\(touch.interactionID)"
                                )
                            }
                        }
                        .peopleCard()
                    }
                }
            }
            .padding(.bottom, CentraidGeometry.pageMargin)
        }
        .refreshable { send(PeopleEvents.person { $0.refreshed = .init() }) }
        .hardTopScrollEdge()
        .accessibilityIdentifier("people-person")
        // The page's colour runs up under the hero, fading into the page.
        .background(alignment: .top) {
            LinearGradient(
                colors: [accent.wash(dark: scheme == .dark), .clear],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 330)
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
    }

    /// THE HERO: a centred avatar, the name, the role and the cadence line. The owner's own card
    /// says "My card" where the cadence would be.
    private var hero: some View {
        VStack(spacing: 4) {
            PeopleAvatarView(avatar: person.avatar, size: 96)
                .padding(.bottom, 6)
            Text(person.name)
                .kitType(.title)
                .foregroundStyle(Surface.ink)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
                .accessibilityAddTraits(.isHeader)
            if !person.role.isEmpty {
                Text(person.role)
                    .kitType(.row)
                    .foregroundStyle(Surface.body)
            }
            if person.isMe {
                Text(person.myCardLabel)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            } else if !person.cadenceLine.isEmpty {
                Text(person.cadenceLine)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .multilineTextAlignment(.center)
            }
            if person.hasDueChip {
                StatusChipView(person.dueChip)
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 8)
        .padding(.bottom, 14)
    }

    /// MESSAGE · CALL · MAIL · LOG TOUCH: round keys over their small lower-case words. Rust sent
    /// only the ones the person's data allows; Log a touch is the one filled in the app's colour.
    @ViewBuilder
    private var heroActions: some View {
        if !person.hero.isEmpty {
            HStack(alignment: .top, spacing: 14) {
                ForEach(person.hero, id: \.key) { action in
                    VStack(spacing: 4) {
                        Button {
                            send(PeopleEvents.person { $0.hero = .with { $0.key = action.key } })
                        } label: {
                            CentraidIconView(
                                iconKey: action.iconKey,
                                tint: action.primary ? .white : Surface.ink,
                                size: 20
                            )
                            .frame(width: 52, height: 52)
                            .background(
                                action.primary ? accent.fill : Surface.card,
                                in: Circle()
                            )
                            .overlay(
                                Circle().strokeBorder(Surface.border, lineWidth: action.primary ? 0 : CentraidGeometry.hairline)
                            )
                            .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(action.accessibilityLabel)
                        .accessibilityIdentifier("people-person-hero-\(action.key)")
                        Text(action.label)
                            .kitType(.meta)
                            .fontWeight(action.primary ? .semibold : .regular)
                            .foregroundStyle(Surface.body)
                            .lineLimit(1)
                            .accessibilityHidden(true)
                    }
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.bottom, 8)
        }
    }

    /// IN YOUR VAULT: what else is about this person, each kind word in its own app's colour.
    private var vault: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(person.vaultHead.title)
                .kitType(.meta)
                .fontWeight(.semibold)
                .foregroundStyle(Surface.meta)
                .padding(.horizontal, 14)
                .padding(.top, 10)
                .padding(.bottom, 4)
                .accessibilityAddTraits(.isHeader)
            ForEach(person.vault, id: \.id) { row in
                Button { open(row.route) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(row.kindLabel)
                            .kitType(.row)
                            .foregroundStyle(AppAccent(row.appKey).text)
                        Text([row.title, row.whenLabel].filter { !$0.isEmpty }.joined(separator: " · "))
                            .kitType(.row)
                            .foregroundStyle(Surface.ink)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(KitRowPress())
                .accessibilityElement(children: .combine)
                .accessibilityLabel(row.accessibilityLabel)
                .accessibilityIdentifier("people-vault-\(row.id)")
            }
            if !person.vaultMore.isEmpty {
                Text(person.vaultMore)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .padding(.horizontal, 14)
                    .padding(.top, 2)
            }
            Color.clear.frame(height: 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .peopleCard()
        .padding(.top, 10)
        .accessibilityIdentifier("people-vault")
    }

    private func dateRow(_ date: Centraid_Core_V1_PeopleDateRow) -> some View {
        HStack(spacing: 0) {
            CentraidRow(
                title: date.label,
                meta: [date.dayLabel, date.reminderLabel].filter { !$0.isEmpty }.joined(separator: " · "),
                trailing: date.whenLabel,
                accessibility: date.accessibilityLabel,
                identifier: "people-date-\(date.dateID)"
            )
            if date.toggleable {
                KitIconKey(
                    iconKey: "Bell",
                    label: date.toggleLabel,
                    tint: date.reminderOn ? "text" : "textFaint",
                    identifier: "people-reminder-\(date.dateID)"
                ) {
                    send(PeopleEvents.person { $0.reminder = .with { $0.dateID = date.dateID } })
                }
                .accessibilityAddTraits(date.reminderOn ? .isSelected : [])
                .padding(.trailing, 8)
            }
        }
    }

    private func channelRow(_ channel: Centraid_Core_V1_PeopleChannelRow) -> some View {
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
                KitLink(
                    label: channel.actionLabel,
                    dense: true,
                    identifier: "people-channel-action-\(channel.channelID)"
                ) {
                    send(PeopleEvents.person { $0.channel = .with { $0.channelID = channel.channelID } })
                }
            }
            if !channel.removeLabel.isEmpty {
                KitIconKey(
                    iconKey: "X",
                    label: channel.removeLabel,
                    tint: "textFaint",
                    identifier: "people-channel-remove-\(channel.channelID)"
                ) {
                    send(PeopleEvents.person { $0.removeChannel = .with { $0.channelID = channel.channelID } })
                }
            }
        }
        .padding(.trailing, 8)
    }
}

private extension View {
    /// A white card on the page: the card radius, nothing under it (only floating glass casts a
    /// shadow), side margins and a gap below.
    func peopleCard() -> some View {
        background(Surface.card, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.bottom, 10)
    }
}

// MARK: - The write sheets

/// WHICHEVER SHEET RUST HOLDS. Each field's text is the view's own `@State`
/// (seeded once, like every editor field), handed over as the sheet's
/// `TextChanged` / `SecondTextChanged`.
private struct PeoplePersonSheetView: View {
    let sheet: Centraid_Core_V1_PeoplePersonSheet
    let send: (Centraid_Core_V1_PeoplePersonEvent) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        switch sheet.kind {
        case let .logTouch(log)?:
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
        case let .note(note)?:
            frameRoom(note.frame) {
                PeopleSheetField(
                    key: "",
                    seed: note.text,
                    placeholder: note.placeholder,
                    identifier: "people-sheet-note",
                    onEdit: { text in send(PeopleEvents.person { $0.text = .with { $0.text = text } }) }
                )
            }
        case let .date(date)?:
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
        case let .channel(channel)?:
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
        case let .merge(merge)?:
            SheetRoom(title: merge.title) {
                if !merge.body.isEmpty {
                    Text(merge.body)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                switch merge.content {
                case .loading?, nil:
                    RowSkeleton(rows: 3, label: merge.title)
                        .frame(height: 170)
                case let .failure(failure)?:
                    FailureView(sentence: failure.sentence, remedy: failure.remedy, onRetry: nil)
                case let .choices(choices)?:
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
        case nil:
            EmptyView()
        }
    }

    private func frameRoom<Fields: View>(
        _ frame: Centraid_Core_V1_PeopleSheetFrame,
        @ViewBuilder fields: @escaping () -> Fields
    ) -> some View {
        SheetRoom(
            title: frame.title,
            status: frame.hasFailure ? frame.failure.sentence : "",
            primary: SheetPrimary(label: frame.submitLabel) {
                guard frame.submitEnabled else { return }
                send(PeopleEvents.person { $0.submitted = .init() })
            },
            outlines: frame.cancelLabel.isEmpty ? [] : [
                SheetOutline(label: frame.cancelLabel, identifier: "people-sheet-cancel") {
                    send(PeopleEvents.person { $0.sheetClosed = .init() })
                },
            ]
        ) {
            fields()
        }
    }

    @ViewBuilder
    private func cancel(_ label: String) -> some View {
        if !label.isEmpty {
            KitOutlineButton(label: label) {
                send(PeopleEvents.person { $0.sheetClosed = .init() })
            }
            .accessibilityIdentifier("people-sheet-cancel")
        }
    }
}

/// A sheet's kind choice: one chip per kind, Rust's selection lit.
private struct PeopleKindChips: View {
    let kinds: [Centraid_Core_V1_PeopleKindChoice]
    let send: (Centraid_Core_V1_PeoplePersonEvent) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(kinds, id: \.key) { kind in
                    KitChip(label: kind.label, selected: kind.selected, identifier: "people-kind-\(kind.key)") {
                        send(PeopleEvents.person { $0.kindPicked = .with { $0.key = kind.key } })
                    }
                }
            }
        }
    }
}

/// A sheet's text field: typed text held here, seeded once from Rust.
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

/// A sheet's on/off: Rust's flag, flipped by its `FlagToggled`.
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
        .kitToggle()
        .frame(minHeight: CentraidGeometry.targetMinCoarse)
        .accessibilityIdentifier(identifier)
    }
}
