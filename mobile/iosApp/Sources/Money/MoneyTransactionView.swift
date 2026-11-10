import SwiftUI

/// `money.transaction` — one transaction, its facts, the two offers the app
/// proposes (a transfer, a rule) and the actions (#1099).
///
/// Nothing is written until the member accepts an offer or picks an action; the
/// category and name edits are sheets, and a transaction goes to the trash and asks nothing (#1185). Every
/// word, the direction, the amount's tone and each action's enabled flag are the
/// machine's.
struct MoneyTransactionView: View {
    let state: Centraid_Core_V1_MoneyTransactionState
    let send: (Centraid_Core_V1_MoneyTransactionEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_MoneyTransactionEvent) -> Void) -> Centraid_Core_V1_MoneyTransactionEvent {
        var event = Centraid_Core_V1_MoneyTransactionEvent()
        build(&event)
        return event
    }

    var body: some View {
        let content = state.readContent
        let sheetBinding = moneySheetBinding(state.sheet == .category || state.sheet == .name) {
            send(event { $0.sheetClosed = .init() })
        }
        // THE PAGE HEADS ITSELF with the merchant's name, so the bar carries only the back chevron
        // (the board draws no small title over it).
        PushedPage(title: "", parentTitle: state.chrome.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            // THE PAGE STAYS ON THE GONE CARD AFTER MOVE TO TRASH, and the status line under it
            // carries "{title} moved to trash" with Undo (#1185).
            Group {
                if case let .gone(gone)? = state.content {
                    EmptyStateView(gone)
                } else {
                    ReadStateView(
                        content: content,
                        onRetry: { send(event { $0.refreshed = .init() }) }
                    ) { transaction in
                        ScrollView {
                            VStack(alignment: .leading, spacing: 0) { page(transaction) }
                                .padding(.bottom, 16)
                        }
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                MoneyStatusFoot(
                    status: MoneyWords.line(state.hasStatus ? state.status : nil),
                    identifier: "money-status-action"
                ) {
                    send(event { $0.statusActed = .init() })
                }
            }
        }
        .sheet(isPresented: sheetBinding) { sheetContent(state, transaction: content.loaded) }
        .linkPickerSheet(state.withPicker) { link in send(event { $0.withLink = link }) }
    }

    @ViewBuilder
    private func page(_ transaction: Centraid_Core_V1_MoneyTransactionData) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(transaction.title)
                .kitType(.title)
                .foregroundStyle(Surface.ink)
                .accessibilityAddTraits(.isHeader)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(MoneyWords.amount(transaction.amount))
                    .kitType(.title)
                    .monospacedDigit()
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                    .foregroundStyle(moneyInk(positive: transaction.amountPositive, tone: transaction.amountTone))
                Text(transaction.directionLabel)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            }
            HStack(spacing: 6) {
                ForEach(Array(transaction.chips.enumerated()), id: \.offset) { _, chip in StatusChipView(chip) }
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(MoneyWords.spoken(transaction.accessibilityLabel.isEmpty ? transaction.title : transaction.accessibilityLabel, transaction.amount))
        // A FACT THE MEMBER CAN CHANGE is the row that changes it: the state's
        // Category and Name facts carry the `category` and `name` actions, so those
        // two actions are not drawn a second time below.
        let folded = Set(transaction.facts.compactMap { actionKey(forFact: $0, in: transaction) })
        MoneyPageCard {
            ForEach(Array(transaction.facts.enumerated()), id: \.offset) { index, fact in
                if index > 0 { KitHairline(inset: 16) }
                if let key = actionKey(forFact: fact, in: transaction),
                   let action = transaction.actions.first(where: { $0.key == key }) {
                    MoneyFactRow(
                        label: fact.label,
                        value: fact.detail,
                        owed: fact.tone == .seam,
                        onTap: action.enabled ? { send(event { $0.action = .with { $0.key = key } }) } : nil,
                        identifier: "money-fact-\(key)"
                    )
                } else {
                    MoneyFactRow(label: fact.label, value: fact.detail)
                }
            }
        }
        .padding(.top, 8)
        ForEach(Array(transaction.notes.enumerated()), id: \.offset) { _, note in
            MoneyNote(text: note)
        }
        if transaction.hasTransferOffer { offer(transaction.transferOffer, key: "transfer") }
        if transaction.hasRuleOffer { offer(transaction.ruleOffer, key: "rule") }
        if transaction.hasWithOffer { offer(transaction.withOffer, key: "with") }
        // EVERY RECORD KEEPS ITS EARLIER VALUES (#1185): the last content row, above the actions.
        EarlierEntryRow(entry: state.hasEarlier ? state.earlier : nil, open: open)
        // THE ACTIONS ARE ALTERNATIVES: one stack.
        KitChoiceStack {
            ForEach(Array(transaction.actions.filter { !folded.contains($0.key) }.enumerated()), id: \.offset) { _, action in
                let key = action.key
                KitOutlineButton(label: action.label, tone: action.destructive ? "net" : "text") {
                    send(event { $0.action = .with { $0.key = key } })
                }
                .disabled(!action.enabled)
                .accessibilityIdentifier("money-action-\(key)")
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 24)
    }

    /// The action a fact stands for, when the state offers one.
    private func actionKey(forFact fact: Centraid_Core_V1_MoneyFact, in transaction: Centraid_Core_V1_MoneyTransactionData) -> String? {
        guard !fact.action.isEmpty else { return nil }
        return transaction.actions.contains { $0.key == fact.action } ? fact.action : nil
    }

    /// An offer the app proposes: words, and the member's two choices. Nothing is
    /// written until Accept.
    @ViewBuilder
    private func offer(_ offer: Centraid_Core_V1_MoneyOffer, key: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(offer.title)
                .kitType(.row)
                .fontWeight(.semibold)
                .foregroundStyle(Surface.ink)
            if !offer.body.isEmpty {
                Text(offer.body)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
            }
            if !offer.detail.isEmpty {
                Text(offer.detail)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            }
            HStack(spacing: 8) {
                KitOutlineButton(label: offer.acceptLabel) {
                    send(event { $0.offerAccepted = .with { $0.key = key } })
                }
                .accessibilityIdentifier("money-offer-accept-\(key)")
                KitOutlineButton(label: offer.dismissLabel) {
                    send(event { $0.offerDismissed = .with { $0.key = key } })
                }
                .accessibilityIdentifier("money-offer-dismiss-\(key)")
                Spacer(minLength: 0)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StateColor.amber.tint, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 16)
    }

    @ViewBuilder
    private func sheetContent(_ state: Centraid_Core_V1_MoneyTransactionState, transaction: Centraid_Core_V1_MoneyTransactionData?) -> some View {
        switch state.sheet {
        case .category:
            MoneyChoiceSheet(
                title: transaction?.categorySheetTitle ?? "",
                choices: transaction?.categoryOptions ?? [],
                identifierPrefix: "money-category-option"
            ) { key in send(event { $0.category = .with { $0.categoryID = key } }) }
        case .name:
            SheetRoom(
                title: transaction?.nameSheetTitle ?? "",
                primary: SheetPrimary(label: transaction?.saveLabel ?? "", identifier: "money-name-save") {
                    send(event { $0.nameSaved = .init() })
                }
            ) {
                MoneyTextField(
                    key: "",
                    value: state.nameDraft,
                    placeholder: transaction?.namePlaceholder ?? "",
                    identifier: "money-name",
                    focusOnAppear: true
                ) { text in send(event { $0.nameEdited = .with { $0.text = text } }) }
                .environment(\.moneyInset, 0)
            }
        default:
            EmptyView()
        }
    }
}

/// `money.target` — a category's plan for a month, per currency (#1099), as a SHEET over Money
/// (`Route.sheet`) the way MoneyTarget.dc.html draws it: the X, the title, the figures, the
/// amount with "Use average" inside the field, the carry switch, the next month's effect, and
/// Save pinned at the foot with Remove under it.
///
/// The amount is the member's typing, held as `amount_text` on the state, and
/// every edit re-reads for the preview; the average, the carry and the preview's
/// words are the machine's. Save is enabled by the state, not by this file.
struct MoneyTargetView: View {
    let state: Centraid_Core_V1_MoneyTargetState
    let send: (Centraid_Core_V1_MoneyTargetEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    private func event(_ build: (inout Centraid_Core_V1_MoneyTargetEvent) -> Void) -> Centraid_Core_V1_MoneyTargetEvent {
        var event = Centraid_Core_V1_MoneyTargetEvent()
        build(&event)
        return event
    }

    var body: some View {
        let content = state.readContent
        SheetPage(title: state.chrome.title, onCancel: onBack) {
            ReadStateView(
                content: content,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { target in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) { page(target, state: state) }
                        .padding(.bottom, 16)
                }
                .scrollDismissesKeyboard(.interactively)
            }
        } foot: {
            VStack(spacing: 0) {
                MoneyStatusFoot(
                    status: MoneyWords.line(state.hasStatus ? state.status : nil),
                    identifier: "money-target-status"
                )
                if let target = content.loaded {
                    footKeys(target)
                }
            }
        }
        // SAVED OR REMOVED: Rust says the page is done, the shell closes the sheet.
        .onChange(of: state.finished) { _, finished in if finished { onBack() } }
    }

    @ViewBuilder
    private func page(_ target: Centraid_Core_V1_MoneyTargetData, state: Centraid_Core_V1_MoneyTargetState) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(target.title)
                .kitType(.section)
                .foregroundStyle(Surface.ink)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("kit-sheet-title")
            Text(target.monthLabel)
                .kitType(.row)
                .foregroundStyle(Surface.meta)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, CentraidGeometry.pageMargin + 2)
        .padding(.top, 8)
        MoneyFigureCard(figures: target.figures)
        amountField(target, state: state)
        MoneyNote(text: target.issue, ink: "net")
        MoneyNote(text: target.exponentHint)
        carryCard(target, on: state.carry)
        MoneyPreviewCard(label: target.previewLabel, amount: target.preview, note: target.previewNote)
    }

    /// THE AMOUNT, on a card with the accent's ring: the currency, the figure, and "Use average"
    /// at the trailing end in the app's ink.
    private func amountField(_ target: Centraid_Core_V1_MoneyTargetData, state: Centraid_Core_V1_MoneyTargetState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(target.amountLabel)
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
                .padding(.leading, 4)
            HStack(spacing: 10) {
                Text(target.currencyLabel)
                    .kitType(.row)
                    .foregroundStyle(Surface.meta)
                MachineTextField(placeholder: "", value: state.amountText) { text in
                    send(event { $0.amount = .with { $0.text = text } })
                }
                .centraidType("title")
                .foregroundStyle(Surface.ink)
                .accessibilityLabel(MoneyWords.meta(target.amountLabel, target.currencyLabel))
                .accessibilityIdentifier("money-target-amount")
                Button { send(event { $0.useAverage = .init() }) } label: {
                    Text(target.useAverageLabel)
                        .centraidType("sheetKey")
                        .foregroundStyle(accent.text)
                        .frame(minHeight: CentraidGeometry.targetMinCoarse)
                        .padding(.horizontal, 6)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("money-target-average")
            }
            .padding(.leading, 14)
            .padding(.trailing, 6)
            .frame(minHeight: 52)
            .background(Surface.card, in: RoundedRectangle(cornerRadius: Theme.radius("md", scheme), style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.radius("md", scheme), style: .continuous).strokeBorder(accent.fill, lineWidth: 1.5)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 8)
    }

    /// THE CARRY SWITCH, with its sentence under the label, on a card.
    private func carryCard(_ target: Centraid_Core_V1_MoneyTargetData, on: Bool) -> some View {
        Toggle(isOn: Binding(get: { on }, set: { value in if value != on { send(event { $0.carry = .init() }) } })) {
            VStack(alignment: .leading, spacing: 1) {
                Text(target.carryLabel)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                Text(target.carryNote)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            }
        }
        .kitToggle()
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .kitCard()
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 8)
        .accessibilityIdentifier("money-target-carry")
    }

    /// SAVE, THEN ITS ALTERNATIVE under it, pinned to the foot: the ink key, and Remove as a red
    /// text key when a target is stored.
    private func footKeys(_ target: Centraid_Core_V1_MoneyTargetData) -> some View {
        VStack(spacing: 2) {
            KitInkButton(label: target.saveLabel, identifier: "money-target-save") {
                send(event { $0.save = .init() })
            }
            .disabled(!target.canSave)
            if !target.removeLabel.isEmpty {
                Button { send(event { $0.remove = .init() }) } label: {
                    Text(target.removeLabel)
                        .centraidType("sheetKey")
                        .foregroundStyle(StateColor.red.text)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("money-target-remove")
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 8)
        .padding(.bottom, 8)
    }

    @Environment(\.appAccent) private var accent
    @Environment(\.colorScheme) private var scheme
}

/// `money.recurring` — what repeats, per merchant (#1099). A read: nothing here writes.
struct MoneyRecurringView: View {
    let state: Centraid_Core_V1_MoneyRecurringState
    let send: (Centraid_Core_V1_MoneyRecurringEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    var body: some View {
        PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            ReadStateView(
                content: state.readContent,
                onRetry: { send(Centraid_Core_V1_MoneyRecurringEvent.with { $0.refreshed = .init() }) }
            ) { recurring in
                if recurring.hasEmpty {
                    EmptyStateView(recurring.empty)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            MoneyPageCard {
                                ForEach(Array(recurring.rows.enumerated()), id: \.offset) { index, row in
                                    if index > 0 { KitHairline(inset: 16) }
                                    CentraidRow(
                                        title: row.merchant,
                                        meta: MoneyWords.meta(row.meta, row.detail),
                                        trailing: MoneyWords.amount(row.amount),
                                        chips: row.chips,
                                        accessibility: MoneyWords.spoken(row.accessibilityLabel, row.amount),
                                        identifier: "money-recurring-\(row.key)",
                                        divider: false
                                    )
                                }
                            }
                            ForEach(Array(recurring.definitions.enumerated()), id: \.offset) { _, fact in
                                MoneyNote(text: "\(fact.label). \(fact.detail)")
                            }
                            MoneyNote(text: recurring.windowNote)
                        }
                        .padding(.bottom, 16)
                    }
                }
            }
        }
    }
}
