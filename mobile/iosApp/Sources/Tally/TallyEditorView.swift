import SwiftUI

// THE MONEY FORMS — add or edit an expense, and settle up (#1046).
//
// **EXPLICIT SAVE, NOT AUTOSAVE.** A money form is not an `EditorRoom`: an
// expense half-typed is not an expense, so the editor saves on Save and asks
// before leaving with changes (`TallyEditorState.confirm`). The machine owns
// the form, the reconcile line, the shares, the issues and whether Save is
// enabled; this file draws them and forwards each keystroke as the form's
// edit event.

/// A typed field whose text lives here while the member types, and follows the
/// machine's text whenever the member is not in it (a method change clears
/// the entries; a re-seed on edit fills them).
struct TallyTextField: View {
    let key: String
    let value: String
    var placeholder: String = ""
    var keyboard: UIKeyboardType = .default
    var identifier: String = ""
    let onEdit: (String) -> Void

    @State private var typed = ""
    @FocusState private var focused: Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if !key.isEmpty {
                Text(key)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
            TextField(placeholder, text: $typed)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
                .keyboardType(keyboard)
                .focused($focused)
                .accessibilityLabel(key.isEmpty ? placeholder : key)
                .accessibilityIdentifier(identifier)
        }
        .onAppear { typed = value }
        .onChange(of: typed) { _, text in
            guard text != value else { return }
            onEdit(text)
        }
        .onChange(of: value) { _, text in
            if !focused, text != typed { typed = text }
        }
    }
}

struct TallyEditorView: View {
    let data: Data
    let send: (Data) -> Void
    let onDone: () -> Void
    let onDeparted: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_TallyEditorState {
        (try? Centraid_Screen_V1_TallyEditorState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_TallyEditorEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_TallyEditorEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_TallyEditorState) -> ScreenContent<Centraid_Screen_V1_TallyEditorData> {
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
        let chrome = state.chrome
        PushedPage(
            title: chrome.title,
            parentTitle: chrome.cancel,
            onBack: { send(Self.event { $0.close = .init() }) }
        ) {
            if case let .data(editor) = content {
                Button {
                    send(Self.event { $0.save = .init() })
                } label: {
                    Text(chrome.save)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color(editor.canSave ? "text" : "textFaint", scheme))
                }
                .disabled(!editor.canSave)
                .accessibilityIdentifier("tally-editor-save")
            }
        } content: {
            ReadStateView(
                content: content,
                loadingLabel: chrome.loading,
                onRetry: { send(Self.event { $0.refreshed = .init() }) }
            ) { editor in
                form(state, editor)
            }
        }
        .onChange(of: state.done) { _, done in if done { onDone() } }
        .onDisappear(perform: onDeparted)
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { send(Self.event { $0.dismissed = .init() }) } }
        )) {
            ConfirmSheet(
                state.confirm,
                onConfirm: { send(Self.event { $0.confirmed = .init() }) },
                onDismiss: { send(Self.event { $0.dismissed = .init() }) }
            )
        }
        // THE CHOICE SHEET IS THE STATE'S (`TallyEditorState.sheet`): a chip
        // set's row sends `SheetOpened`, a pick closes it in the machine, and
        // a swipe away is `SheetClosed`.
        .sheet(isPresented: Binding(
            get: { Self.isOpen(state.sheet) },
            set: { open in if !open, Self.isOpen(state.sheet) { send(Self.event { $0.sheetClosed = .init() }) } }
        )) {
            if case let .data(editor) = content, let pick = choices(state.sheet, chrome, editor) {
                OptionSheet(title: pick.title) {
                    ForEach(pick.choices, id: \.key) { choice in
                        SheetRow(
                            label: choice.label,
                            selected: choice.selected,
                            identifier: "tally-choice-\(choice.key)",
                            onTap: { pick.pick(choice) }
                        )
                        .disabled(!choice.enabled)
                        .opacity(choice.enabled ? 1 : 0.5)
                    }
                }
            }
        }
    }

    private static func isOpen(_ sheet: Centraid_Screen_V1_TallyEditorState.Sheet) -> Bool {
        sheet != .none && sheet != .unspecified
    }

    /// Which chip set the open sheet draws, with its field's key as the title
    /// and the pick event each row sends — a lookup, not a rule.
    private func choices(
        _ sheet: Centraid_Screen_V1_TallyEditorState.Sheet,
        _ chrome: Centraid_Screen_V1_TallyEditorChrome,
        _ editor: Centraid_Screen_V1_TallyEditorData
    ) -> (title: String, choices: [Centraid_Screen_V1_TallyChoice], pick: (Centraid_Screen_V1_TallyChoice) -> Void)? {
        switch sheet {
        case .currency:
            return (chrome.currencyKey, editor.currencies, { c in send(Self.event { $0.currency = .with { $0.currency = c.key } }) })
        case .payer:
            return (chrome.payerKey, editor.payers, { c in send(Self.event { $0.payer = .with { $0.partyID = c.key } }) })
        case .group:
            return (chrome.groupKey, editor.groups, { c in send(Self.event { $0.group = .with { $0.groupID = c.key } }) })
        case .category:
            return (chrome.categoryKey, editor.categories, { c in send(Self.event { $0.category = .with { $0.category = c.key } }) })
        case .date:
            return (chrome.dateKey, editor.dates, { c in send(Self.event { $0.date = .with { $0.day = c.key } }) })
        case .method:
            return (chrome.methodKey, editor.methods, { c in send(Self.event { $0.method = .with { $0.method = c.method } }) })
        case .none, .unspecified, .UNRECOGNIZED:
            return nil
        }
    }

    private func form(_ state: Centraid_Screen_V1_TallyEditorState, _ editor: Centraid_Screen_V1_TallyEditorData) -> some View {
        let chrome = state.chrome
        let form = state.form
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                TallyWriteLine(write: state.write)
                TallyTextField(
                    key: chrome.descriptionKey,
                    value: form.description_p,
                    placeholder: chrome.descriptionPlaceholder,
                    identifier: "tally-editor-description"
                ) { text in send(Self.event { $0.description_p = .with { $0.text = text } }) }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.vertical, 8)
                    .overlay(alignment: .bottom) { KitHairline() }
                TallyTextField(
                    key: chrome.amountKey,
                    value: form.amountText,
                    keyboard: .decimalPad,
                    identifier: "tally-editor-amount"
                ) { text in send(Self.event { $0.amount = .with { $0.text = text } }) }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.vertical, 8)
                    .overlay(alignment: .bottom) { KitHairline() }
                choiceRow(chrome.currencyKey, editor.currencies, locked: editor.currencyLocked, id: "currency", sheet: .currency)
                TallyNote(text: editor.rateLine)
                choiceRow(chrome.payerKey, editor.payers, id: "payer", sheet: .payer)
                choiceRow(chrome.groupKey, editor.groups, id: "group", sheet: .group)
                choiceRow(chrome.categoryKey, editor.categories, id: "category", sheet: .category)
                choiceRow(chrome.dateKey, editor.dates, id: "date", sheet: .date)
                choiceRow(chrome.methodKey, editor.methods, id: "method", sheet: .method)
                if form.method == .byLine {
                    lines(state, editor)
                } else {
                    ForEach(form.entries, id: \.person.partyID) { entry in
                        entryRow(entry, editor)
                    }
                }
                reconcile(editor)
            }
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    /// A chip set as a field: the selected choice's label, tapping opens the set.
    @ViewBuilder
    private func choiceRow(
        _ key: String,
        _ choices: [Centraid_Screen_V1_TallyChoice],
        locked: Bool = false,
        id: String,
        sheet: Centraid_Screen_V1_TallyEditorState.Sheet
    ) -> some View {
        if !choices.isEmpty {
            let selected = choices.first(where: \.selected)?.label ?? ""
            if locked {
                FieldRow(key: key, value: selected)
            } else {
                ChoiceFieldRow(key: key, value: selected, identifier: "tally-editor-\(id)") {
                    send(Self.event { $0.sheetOpened = .with { $0.sheet = sheet } })
                }
            }
        }
    }

    private func name(_ entry: Centraid_Screen_V1_TallySplitEntry, _ editor: Centraid_Screen_V1_TallyEditorData) -> String {
        if !entry.person.name.isEmpty { return entry.person.name }
        return editor.payers.first(where: { $0.key == entry.person.partyID })?.label ?? ""
    }

    /// One person's part of the division: in or out, their typed number where
    /// the method takes one, their share, and the entry's issue.
    private func entryRow(_ entry: Centraid_Screen_V1_TallySplitEntry, _ editor: Centraid_Screen_V1_TallyEditorData) -> some View {
        let party = entry.person.partyID
        let label = name(entry, editor)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 12) {
                Button {
                    send(Self.event { $0.entryToggled = .with { $0.partyID = party } })
                } label: {
                    CentraidIconView(
                        iconKey: entry.included ? "CheckCircle" : "Circle",
                        tint: Theme.color(entry.included ? "text" : "textFaint", scheme),
                        size: 20
                    )
                    .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(label)
                .accessibilityAddTraits(entry.included ? .isSelected : [])
                .accessibilityIdentifier("tally-entry-toggle-\(party)")
                Text(label)
                    .centraidType("body")
                    .foregroundStyle(Theme.color(entry.included ? "text" : "textFaint", scheme))
                    .lineLimit(1)
                Spacer(minLength: 8)
                if !entry.unitLabel.isEmpty {
                    TallyTextField(
                        key: "",
                        value: entry.text,
                        placeholder: entry.unitLabel,
                        keyboard: .decimalPad,
                        identifier: "tally-entry-\(party)"
                    ) { text in send(Self.event { $0.entryChanged = .with { $0.partyID = party; $0.text = text } }) }
                        .frame(width: 88)
                        .multilineTextAlignment(.trailing)
                    Text(entry.unitLabel)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
                if entry.hasShare {
                    Text(tallyMoney(entry.share))
                        .centraidType("smallStrong")
                        .monospacedDigit()
                        .foregroundStyle(Theme.color("text", scheme))
                }
            }
            if !entry.issue.isEmpty {
                Text(entry.issue)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("net", scheme))
                    .padding(.leading, CentraidGeometry.targetMinCoarse + 12)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 2)
        .overlay(alignment: .bottom) { KitHairline() }
    }

    @ViewBuilder
    private func lines(_ state: Centraid_Screen_V1_TallyEditorState, _ editor: Centraid_Screen_V1_TallyEditorData) -> some View {
        let chrome = state.chrome
        ForEach(state.form.lines, id: \.lineKey) { line in
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    TallyTextField(
                        key: "",
                        value: line.description_p,
                        placeholder: chrome.linePlaceholder,
                        identifier: "tally-line-description-\(line.lineKey)"
                    ) { text in
                        send(Self.event {
                            $0.lineChanged = .with { $0.lineKey = line.lineKey; $0.description_p = text; $0.amountText = line.amountText }
                        })
                    }
                    TallyTextField(
                        key: "",
                        value: line.amountText,
                        placeholder: chrome.amountKey,
                        keyboard: .decimalPad,
                        identifier: "tally-line-amount-\(line.lineKey)"
                    ) { text in
                        send(Self.event {
                            $0.lineChanged = .with { $0.lineKey = line.lineKey; $0.description_p = line.description_p; $0.amountText = text }
                        })
                    }
                    .frame(width: 96)
                    Button {
                        send(Self.event { $0.lineRemoved = .with { $0.lineKey = line.lineKey } })
                    } label: {
                        CentraidIconView(iconKey: "X", tint: Theme.color("textSoft", scheme), size: 16)
                            .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(chrome.removeLine)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(editor.payers, id: \.key) { person in
                            let on = line.partyIds.contains(person.key)
                            Button {
                                send(Self.event { $0.lineParty = .with { $0.lineKey = line.lineKey; $0.partyID = person.key } })
                            } label: {
                                Text(person.label)
                                    .centraidType("annotLabelOn")
                                    .foregroundStyle(Theme.color(on ? "onAccent" : "textSoft", scheme))
                                    .padding(.horizontal, 10)
                                    .frame(minHeight: CentraidGeometry.targetMinFine)
                                    .background(Capsule().fill(Theme.color(on ? "accent" : "bgSunken", scheme)))
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(on ? .isSelected : [])
                        }
                    }
                }
                if !line.issue.isEmpty {
                    Text(line.issue)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("net", scheme))
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) { KitHairline() }
        }
        HStack {
            KitOutlineButton(label: chrome.addLine) { send(Self.event { $0.lineAdded = .init() }) }
                .accessibilityIdentifier("tally-line-add")
            Spacer()
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func reconcile(_ editor: Centraid_Screen_V1_TallyEditorData) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if !editor.reconcileLine.isEmpty {
                Text(editor.reconcileLine)
                    .centraidType("small")
                    .foregroundStyle(Theme.color(editor.reconcileProblem ? "net" : "textSoft", scheme))
                    .accessibilityIdentifier("tally-reconcile")
            }
            if editor.hasRemaining, !editor.remainingLabel.isEmpty {
                Text("\(editor.remainingLabel) \(tallyMoney(editor.remaining))")
                    .centraidType("annotLabel")
                    .monospacedDigit()
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            ForEach(Array(editor.issues.enumerated()), id: \.offset) { _, issue in
                Text(issue)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("net", scheme))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 12)
    }
}

// MARK: - Settle up

struct TallySettleUpView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void
    let onDeparted: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_TallySettleUpState {
        (try? Centraid_Screen_V1_TallySettleUpState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_TallySettleUpEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_TallySettleUpEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_TallySettleUpState) -> ScreenContent<Centraid_Screen_V1_TallySettleUpData> {
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
        PushedPage(title: state.title, parentTitle: state.chrome.back, onBack: onBack) {
            EmptyView()
        } content: {
            ReadStateView(
                content: content(state),
                loadingLabel: state.chrome.loading,
                onRetry: { send(Self.event { $0.refreshed = .init() }) }
            ) { settle in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        TallyWriteLine(write: state.write)
                        TallyNote(text: state.lede)
                        if settle.hasEmpty { EmptyStateView(settle.empty) }
                        ForEach(settle.suggestions, id: \.key) { transfer in
                            TallyTransferRowView(transfer: transfer) {
                                send(Self.event { $0.picked = .with { $0.key = transfer.key } })
                            }
                        }
                    }
                    .padding(.bottom, 16)
                }
                .refreshable { send(Self.event { $0.refreshed = .init() }) }
            }
        }
        .onDisappear(perform: onDeparted)
        .sheet(isPresented: Binding(
            get: { state.hasDraft },
            set: { open in if !open, state.hasDraft { send(Self.event { $0.dismissed = .init() }) } }
        )) {
            let draft = state.draft
            SheetRoom(
                title: draft.transfer.line,
                status: draft.foot,
                primary: SheetPrimary(label: draft.recordLabel) {
                    if draft.canRecord { send(Self.event { $0.record = .init() }) }
                }
            ) {
                TallyWriteLine(write: state.write)
                TallyTextField(
                    key: draft.amountKey,
                    value: draft.amountText,
                    keyboard: .decimalPad,
                    identifier: "tally-settle-amount"
                ) { text in send(Self.event { $0.amount = .with { $0.text = text } }) }
                if !draft.issue.isEmpty {
                    Text(draft.issue)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("net", scheme))
                }
                Button {
                    send(Self.event { $0.dismissed = .init() })
                } label: {
                    Text(draft.cancelLabel)
                        .centraidType("labelOn")
                        .foregroundStyle(Theme.color("text", scheme))
                        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .disabled(state.write.phase == .inFlight)
            .accessibilityIdentifier("tally-settle-draft")
        }
    }
}
