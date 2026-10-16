import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// `money.transaction` — one transaction, its facts, the two offers the app
/// proposes (a transfer, a rule) and the actions (#1099).
///
/// Nothing is written until the member accepts an offer or picks an action; the
/// category and name edits are sheets, and a void is the state's `Confirm`. Every
/// word, the direction, the amount's tone and each action's enabled flag are the
/// machine's.
struct MoneyTransactionView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_MoneyTransactionState {
        (try? Centraid_Screen_V1_MoneyTransactionState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_MoneyTransactionEvent) -> Void) -> Data {
        moneyEvent(Centraid_Screen_V1_MoneyTransactionEvent.self, build)
    }

    var body: some View {
        let state = state
        let content = state.readContent
        let sheetBinding = moneySheetBinding(state.sheet == .category || state.sheet == .name) {
            send(event { $0.sheetClosed = .init() })
        }
        let confirmBinding = moneySheetBinding(state.hasConfirm) {
            send(event { $0.confirmDismissed = .init() })
        }
        PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            ReadStateView(
                content: content,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { transaction in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) { page(transaction) }
                        .padding(.bottom, 16)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                MoneyStatusFoot(
                    status: MoneyWords.line(state.hasStatus ? state.status : nil, write: state.write),
                    identifier: "money-transaction-status"
                )
            }
        }
        .sheet(isPresented: sheetBinding) { sheetContent(state, transaction: content.loaded) }
        .sheet(isPresented: confirmBinding) {
            ConfirmSheet(
                state.confirm,
                onConfirm: { send(event { $0.confirmAccepted = .init() }) },
                onDismiss: { send(event { $0.confirmDismissed = .init() }) }
            )
        }
    }

    @ViewBuilder
    private func page(_ transaction: Centraid_Screen_V1_MoneyTransactionData) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(transaction.directionLabel)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
            Text(MoneyWords.amount(transaction.amount))
                .centraidType("display")
                .foregroundStyle(Theme.color(StatusChipView.ink(transaction.amountTone, neutral: "text"), scheme))
            Text(transaction.title)
                .centraidType("title")
                .foregroundStyle(Theme.color("text", scheme))
                .accessibilityAddTraits(.isHeader)
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
        let folded = Set(transaction.facts.compactMap { actionKey(forFact: $0.label, in: transaction) })
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(transaction.facts.enumerated()), id: \.offset) { _, fact in
                if let key = actionKey(forFact: fact.label, in: transaction),
                   let action = transaction.actions.first(where: { $0.key == key }) {
                    MoneyFactRow(
                        label: fact.label,
                        value: fact.detail,
                        owed: fact.detail == MoneyCopy.shared.NO_CATEGORY,
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
    private func actionKey(forFact label: String, in transaction: Centraid_Screen_V1_MoneyTransactionData) -> String? {
        let key: String
        if label == MoneyCopy.shared.FACT_CATEGORY { key = "category" }
        else if label == MoneyCopy.shared.FACT_NAME { key = "name" }
        else { return nil }
        return transaction.actions.contains { $0.key == key } ? key : nil
    }

    /// An offer the app proposes: words, and the member's two choices. Nothing is
    /// written until Accept.
    @ViewBuilder
    private func offer(_ offer: Centraid_Screen_V1_MoneyOffer, key: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(offer.title)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("text", scheme))
            if !offer.body.isEmpty {
                Text(offer.body)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
            }
            if !offer.detail.isEmpty {
                Text(offer.detail)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
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
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radius("lg", scheme))
                .strokeBorder(Theme.color("seam", scheme), lineWidth: 1)
        )
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 16)
    }

    @ViewBuilder
    private func sheetContent(_ state: Centraid_Screen_V1_MoneyTransactionState, transaction: Centraid_Screen_V1_MoneyTransactionData?) -> some View {
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

/// `money.target` — a category's plan for a month, per currency (#1099).
///
/// The amount is the member's typing, held as `amount_text` on the state, and
/// every edit re-reads for the preview; the average, the carry and the preview's
/// words are the machine's. Save is enabled by the state, not by this file.
struct MoneyTargetView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    private var state: Centraid_Screen_V1_MoneyTargetState {
        (try? Centraid_Screen_V1_MoneyTargetState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_MoneyTargetEvent) -> Void) -> Data {
        moneyEvent(Centraid_Screen_V1_MoneyTargetEvent.self, build)
    }

    var body: some View {
        let state = state
        let content = state.readContent
        PushedPage(
            title: content.loaded?.title ?? state.chrome.title,
            parentTitle: state.chrome.backLabel,
            onBack: onBack
        ) {
            EmptyView()
        } content: {
            ReadStateView(
                content: content,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { target in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) { page(target, state: state) }
                        .padding(.bottom, 16)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                MoneyStatusFoot(
                    status: MoneyWords.line(nil, write: state.write),
                    identifier: "money-target-status"
                )
            }
        }
    }

    @ViewBuilder
    private func page(_ target: Centraid_Screen_V1_MoneyTargetData, state: Centraid_Screen_V1_MoneyTargetState) -> some View {
        MoneyNote(text: target.monthLabel)
        MoneyTextField(
            key: MoneyWords.meta(target.amountLabel, target.currencyLabel),
            value: state.amountText,
            identifier: "money-target-amount",
            large: true
        ) { text in send(event { $0.amount = .with { $0.text = text } }) }
        MoneyNote(text: target.issue, ink: "net")
        MoneyNote(text: target.exponentHint)
        ForEach(Array(target.figures.enumerated()), id: \.offset) { _, figure in
            MoneyFigureRow(figure: figure)
        }
        MoneyQuietButton(label: target.useAverageLabel, identifier: "money-target-average") {
            send(event { $0.useAverage = .init() })
        }
        MoneyToggleRow(label: target.carryLabel, on: state.carry, identifier: "money-target-carry") {
            send(event { $0.carry = .init() })
        }
        MoneyNote(text: target.carryNote)
        MoneyPreviewCard(label: target.previewLabel, amount: target.preview, note: target.previewNote)
        // SAVE AND REMOVE ARE ALTERNATIVES: one stack.
        MoneyChoiceStack {
            MoneyInkButton(label: target.saveLabel, enabled: target.canSave, identifier: "money-target-save") {
                send(event { $0.save = .init() })
            }
            if !target.removeLabel.isEmpty {
                MoneyQuietButton(label: target.removeLabel, tone: "net", identifier: "money-target-remove") {
                    send(event { $0.remove = .init() })
                }
            }
        }
    }
}

/// `money.recurring` — what repeats, per merchant (#1099). A read: nothing here writes.
struct MoneyRecurringView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    private var state: Centraid_Screen_V1_MoneyRecurringState {
        (try? Centraid_Screen_V1_MoneyRecurringState(serializedBytes: data)) ?? .init()
    }

    var body: some View {
        let state = state
        PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            ReadStateView(
                content: state.readContent,
                onRetry: { send(moneyEvent(Centraid_Screen_V1_MoneyRecurringEvent.self) { $0.refreshed = .init() }) }
            ) { recurring in
                if recurring.hasEmpty {
                    EmptyStateView(recurring.empty)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(recurring.rows.enumerated()), id: \.offset) { _, row in
                                CentraidRow(
                                    title: row.merchant,
                                    meta: MoneyWords.meta(row.meta, row.detail),
                                    trailing: MoneyWords.amount(row.amount),
                                    chips: row.chips,
                                    accessibility: MoneyWords.spoken(row.accessibilityLabel, row.amount),
                                    identifier: "money-recurring-\(row.key)"
                                )
                            }
                            ForEach(Array(recurring.definitions.enumerated()), id: \.offset) { _, fact in
                                FieldRow(key: fact.label, value: fact.detail)
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
