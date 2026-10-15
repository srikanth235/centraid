import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

// THE THREE PAGES THAT MANAGE WHAT MONEY KNOWS (#1099): accounts, rules, categories.
//
// Each is a list with the app's create verb in the header, and its forms are
// SHEETS (a choice or an edit never pushes, #1015 D4). The machine holds the
// form's fields, whether Save is enabled and the sentence that says why not; a
// delete or an archive is the state's `Confirm`, drawn by the kit.

// MARK: - money.accounts

struct MoneyAccountsView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    private var state: Centraid_Screen_V1_MoneyAccountsState {
        (try? Centraid_Screen_V1_MoneyAccountsState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_MoneyAccountsEvent) -> Void) -> Data {
        moneyEvent(Centraid_Screen_V1_MoneyAccountsEvent.self, build)
    }

    var body: some View {
        let state = state
        let content = state.readContent
        let addLabel = content.loaded?.addLabel ?? ""
        let open = state.hasEditor && state.sheet == .editor
        let sheetBinding = moneySheetBinding(open) {
            send(event { $0.sheetClosed = .init() })
        }
        // A confirm over an open sheet is presented BY that sheet; a SwiftUI view
        // presents one sheet at a time. On its own it is the page's.
        let nestedConfirm = moneySheetBinding(state.hasConfirm) { send(event { $0.confirmDismissed = .init() }) }
        let pageConfirm = moneySheetBinding(state.hasConfirm && !open) { send(event { $0.confirmDismissed = .init() }) }
        PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
            RoomTrailing(action: addLabel.isEmpty ? nil : RoomAction(
                iconKey: "Plus",
                label: addLabel,
                identifier: "money-account-add",
                action: { send(event { $0.add = .init() }) }
            ))
        } content: {
            ReadStateView(
                content: content,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { accounts in
                if accounts.hasEmpty {
                    EmptyStateView(accounts.empty, onAction: { send(event { $0.add = .init() }) })
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) { page(accounts) }
                            .padding(.bottom, 16)
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                MoneyStatusFoot(
                    status: MoneyWords.line(state.hasStatus ? state.status : nil, write: state.write),
                    identifier: "money-accounts-status"
                )
            }
        }
        .sheet(isPresented: sheetBinding) {
            editorSheet(state)
                .sheet(isPresented: nestedConfirm) { confirm(state) }
        }
        .sheet(isPresented: pageConfirm) { confirm(state) }
    }

    @ViewBuilder
    private func confirm(_ state: Centraid_Screen_V1_MoneyAccountsState) -> some View {
        ConfirmSheet(
            state.confirm,
            onConfirm: { send(event { $0.confirmAccepted = .init() }) },
            onDismiss: { send(event { $0.confirmDismissed = .init() }) }
        )
    }

    @ViewBuilder
    private func page(_ accounts: Centraid_Screen_V1_MoneyAccountsData) -> some View {
        if !accounts.netWorth.isEmpty {
            MoneyNetWorthCard(label: accounts.netWorthLabel, figures: accounts.netWorth, note: accounts.netWorthNote)
        }
        ForEach(Array(accounts.sections.enumerated()), id: \.offset) { _, section in
            MoneySection(title: section.title)
            ForEach(Array(section.rows.enumerated()), id: \.offset) { _, row in
                let accountID = row.accountID
                MoneyAccountRowView(row: row) { send(event { $0.account = .with { $0.accountID = accountID } }) }
                    .accessibilityIdentifier("money-account-\(accountID)")
            }
        }
        ForEach(Array(accounts.definitions.enumerated()), id: \.offset) { _, fact in
            FieldRow(key: fact.label, value: fact.detail)
        }
    }

    @ViewBuilder
    private func editorSheet(_ state: Centraid_Screen_V1_MoneyAccountsState) -> some View {
        if state.hasEditor {
            let editor = state.editor
            MoneyFormSheet(
                title: editor.title,
                status: state.hasStatus && state.status.refused ? state.status.sentence : "",
                primary: SheetPrimary(label: editor.saveLabel, enabled: editor.canSave, identifier: "money-account-save") {
                    send(event { $0.save = .init() })
                }
            ) {
                MoneyTextField(key: editor.nameLabel, value: editor.name, identifier: "money-account-name") { text in
                    send(event { $0.name = .with { $0.text = text } })
                }
                MoneyHeading(text: editor.kindLabel)
                MoneyChoiceChips(choices: editor.kindOptions, identifierPrefix: "money-account-kind") { kind in
                    send(event { $0.kindPicked = .with { $0.kind = kind } })
                }
                if !editor.currencyLabel.isEmpty {
                    MoneyTextField(key: editor.currencyLabel, value: editor.currency, identifier: "money-account-currency") { text in
                        send(event { $0.currency = .with { $0.text = text } })
                    }
                }
                MoneyTextField(key: editor.externalRefLabel, value: editor.externalRef, identifier: "money-account-number") { text in
                    send(event { $0.externalRef = .with { $0.text = text } })
                }
                MoneyNote(text: editor.externalRefNote)
                if !editor.removeNumberLabel.isEmpty {
                    MoneyQuietButton(label: editor.removeNumberLabel, tone: "net", identifier: "money-account-remove-number") {
                        send(event { $0.removeNumber = .init() })
                    }
                    .disabled(!editor.canRemoveNumber)
                }
                MoneyToggleRow(label: editor.onBudgetLabel, on: editor.onBudget, identifier: "money-account-budget") {
                    send(event { $0.onBudget = .init() })
                }
                if !editor.closedLabel.isEmpty {
                    MoneyToggleRow(label: editor.closedLabel, on: editor.closed, identifier: "money-account-closed") {
                        send(event { $0.closed = .init() })
                    }
                }
                MoneyNote(text: editor.issue, ink: "net")
            }
        }
    }
}

// MARK: - money.rules

struct MoneyRulesView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    private var state: Centraid_Screen_V1_MoneyRulesState {
        (try? Centraid_Screen_V1_MoneyRulesState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_MoneyRulesEvent) -> Void) -> Data {
        moneyEvent(Centraid_Screen_V1_MoneyRulesEvent.self, build)
    }

    private func sheetIsOpen(_ state: Centraid_Screen_V1_MoneyRulesState) -> Bool {
        state.hasEditor && (state.sheet == .editor || state.sheet == .category || state.sheet == .account)
    }

    var body: some View {
        let state = state
        let content = state.readContent
        let addLabel = content.loaded?.addLabel ?? ""
        let open = sheetIsOpen(state)
        let sheetBinding = moneySheetBinding(open) { send(event { $0.sheetClosed = .init() }) }
        // A confirm over an open sheet is presented BY that sheet; a SwiftUI view
        // presents one sheet at a time. On its own it is the page's.
        let nestedConfirm = moneySheetBinding(state.hasConfirm) { send(event { $0.confirmDismissed = .init() }) }
        let pageConfirm = moneySheetBinding(state.hasConfirm && !open) { send(event { $0.confirmDismissed = .init() }) }
        PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
            RoomTrailing(action: addLabel.isEmpty ? nil : RoomAction(
                iconKey: "Plus",
                label: addLabel,
                identifier: "money-rule-add",
                action: { send(event { $0.add = .init() }) }
            ))
        } content: {
            ReadStateView(
                content: content,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { rules in
                if rules.hasEmpty {
                    EmptyStateView(rules.empty, onAction: { send(event { $0.add = .init() }) })
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) { page(rules) }
                            .padding(.bottom, 16)
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                MoneyStatusFoot(
                    status: MoneyWords.line(state.hasStatus ? state.status : nil, write: state.write),
                    identifier: "money-rules-status"
                )
            }
        }
        .sheet(isPresented: sheetBinding) {
            sheetContent(state, rules: content.loaded)
                .sheet(isPresented: nestedConfirm) { confirm(state) }
        }
        .sheet(isPresented: pageConfirm) { confirm(state) }
    }

    @ViewBuilder
    private func page(_ rules: Centraid_Screen_V1_MoneyRulesData) -> some View {
        MoneyNote(text: rules.limitLine)
        ForEach(Array(rules.rows.enumerated()), id: \.offset) { _, row in
            let ruleID = row.ruleID
            MoneyChevronRow(
                title: row.title,
                meta: row.meta,
                accessibility: row.accessibilityLabel,
                identifier: "money-rule-\(ruleID)"
            ) { send(event { $0.rule = .with { $0.ruleID = ruleID } }) }
        }
        if !rules.applyLabel.isEmpty {
            MoneyQuietButton(label: rules.applyLabel, identifier: "money-rules-apply") {
                send(event { $0.apply = .init() })
            }
        }
    }

    @ViewBuilder
    private func sheetContent(_ state: Centraid_Screen_V1_MoneyRulesState, rules: Centraid_Screen_V1_MoneyRulesData?) -> some View {
        let editor = state.editor
        if state.sheet == .category {
            MoneyChoiceSheet(
                title: rules?.categorySheetTitle ?? "",
                choices: rules?.categoryOptions ?? [],
                identifierPrefix: "money-rule-category-option"
            ) { key in send(event { $0.category = .with { $0.categoryID = key } }) }
        } else if state.sheet == .account {
            MoneyChoiceSheet(
                title: rules?.accountSheetTitle ?? "",
                choices: rules?.accountOptions ?? [],
                identifierPrefix: "money-rule-account-option"
            ) { key in send(event { $0.account = .with { $0.accountID = key } }) }
        } else {
            MoneyFormSheet(
                title: editor.title,
                status: state.hasStatus && state.status.refused ? state.status.sentence : "",
                primary: SheetPrimary(label: editor.saveLabel, enabled: editor.canSave, identifier: "money-rule-save") {
                    send(event { $0.save = .init() })
                }
            ) {
                MoneyHeading(text: editor.kindLabel)
                MoneyChoiceChips(choices: editor.kindOptions, identifierPrefix: "money-rule-kind") { kind in
                    send(event { $0.kindPicked = .with { $0.kind = kind } })
                }
                MoneyTextField(key: editor.patternLabel, value: editor.pattern, identifier: "money-rule-pattern") { text in
                    send(event { $0.pattern = .with { $0.text = text } })
                }
                MoneyNote(text: editor.patternNote)
                MoneyChoiceField(
                    key: editor.categoryRowLabel,
                    value: editor.categoryLabel.isEmpty ? editor.clearCategoryLabel_p : editor.categoryLabel,
                    identifier: "money-rule-category"
                ) { send(event { $0.categorySheet = .init() }) }
                MoneyTextField(key: editor.nameLabel, value: editor.displayName, identifier: "money-rule-name") { text in
                    send(event { $0.name = .with { $0.text = text } })
                }
                MoneyChoiceField(
                    key: editor.accountRowLabel,
                    value: editor.accountLabel.isEmpty ? editor.clearAccountLabel : editor.accountLabel,
                    identifier: "money-rule-account"
                ) { send(event { $0.accountSheet = .init() }) }
                if editor.limitsEnabled {
                    MoneyTextField(key: editor.amountMinLabel, value: editor.amountMinText, identifier: "money-rule-amount-min") { text in
                        send(event { $0.amountMin = .with { $0.text = text } })
                    }
                    MoneyTextField(key: editor.amountMaxLabel, value: editor.amountMaxText, identifier: "money-rule-amount-max") { text in
                        send(event { $0.amountMax = .with { $0.text = text } })
                    }
                }
                MoneyNote(text: editor.amountNote)
                MoneyNote(text: editor.issue, ink: "net")
                if !editor.applyLabel.isEmpty {
                    MoneyQuietButton(label: editor.applyLabel, identifier: "money-rule-apply") {
                        send(event { $0.apply = .init() })
                    }
                }
                if !editor.deleteLabel.isEmpty {
                    MoneyQuietButton(label: editor.deleteLabel, tone: "net", identifier: "money-rule-delete") {
                        send(event { $0.delete = .init() })
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func confirm(_ state: Centraid_Screen_V1_MoneyRulesState) -> some View {
        ConfirmSheet(
            state.confirm,
            onConfirm: { send(event { $0.confirmAccepted = .init() }) },
            onDismiss: { send(event { $0.confirmDismissed = .init() }) }
        )
    }
}

// MARK: - money.categories

struct MoneyCategoriesView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    private var state: Centraid_Screen_V1_MoneyCategoriesState {
        (try? Centraid_Screen_V1_MoneyCategoriesState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_MoneyCategoriesEvent) -> Void) -> Data {
        moneyEvent(Centraid_Screen_V1_MoneyCategoriesEvent.self, build)
    }

    private func sheetIsOpen(_ state: Centraid_Screen_V1_MoneyCategoriesState) -> Bool {
        switch state.sheet {
        case .add, .row, .merge: return true
        default: return false
        }
    }

    var body: some View {
        let state = state
        let content = state.readContent
        let addLabel = content.loaded?.addLabel ?? ""
        let open = sheetIsOpen(state)
        let sheetBinding = moneySheetBinding(open) { send(event { $0.sheetClosed = .init() }) }
        let nestedConfirm = moneySheetBinding(state.hasConfirm) { send(event { $0.confirmDismissed = .init() }) }
        let pageConfirm = moneySheetBinding(state.hasConfirm && !open) { send(event { $0.confirmDismissed = .init() }) }
        PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
            RoomTrailing(action: addLabel.isEmpty ? nil : RoomAction(
                iconKey: "Plus",
                label: addLabel,
                identifier: "money-category-add",
                action: { send(event { $0.add = .init() }) }
            ))
        } content: {
            ReadStateView(
                content: content,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { categories in
                if categories.hasEmpty {
                    EmptyStateView(categories.empty)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) { page(categories) }
                            .padding(.bottom, 16)
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                MoneyStatusFoot(
                    status: MoneyWords.line(state.hasStatus ? state.status : nil, write: state.write),
                    identifier: "money-categories-status"
                )
            }
        }
        .sheet(isPresented: sheetBinding) {
            sheetContent(state, categories: content.loaded)
                .sheet(isPresented: nestedConfirm) { confirm(state) }
        }
        .sheet(isPresented: pageConfirm) { confirm(state) }
    }

    @ViewBuilder
    private func page(_ categories: Centraid_Screen_V1_MoneyCategoriesData) -> some View {
        ForEach(Array(categories.groups.enumerated()), id: \.offset) { _, group in
            MoneySection(title: group.label)
            ForEach(Array(group.rows.enumerated()), id: \.offset) { _, row in
                let categoryID = row.categoryID
                CentraidRow(
                    title: row.label,
                    meta: row.meta,
                    dimmed: row.archived,
                    accessibility: row.accessibilityLabel,
                    identifier: "money-category-row-\(categoryID)"
                ) { send(event { $0.category = .with { $0.categoryID = categoryID } }) }
            }
        }
    }

    @ViewBuilder
    private func sheetContent(_ state: Centraid_Screen_V1_MoneyCategoriesState, categories: Centraid_Screen_V1_MoneyCategoriesData?) -> some View {
        if let categories {
            switch state.sheet {
            case .add:
                MoneyFormSheet(
                    title: categories.addTitle,
                    primary: SheetPrimary(label: categories.saveLabel, enabled: categories.canSave, identifier: "money-category-save") {
                        send(event { $0.save = .init() })
                    }
                ) {
                    MoneyTextField(
                        key: categories.nameLabel,
                        value: state.nameDraft,
                        identifier: "money-category-name",
                        focusOnAppear: true
                    ) { text in send(event { $0.name = .with { $0.text = text } }) }
                    MoneyNote(text: categories.issue, ink: "net")
                    MoneyHeading(text: categories.groupLabel)
                    ForEach(Array(categories.groupOptions.enumerated()), id: \.offset) { _, option in
                        let groupID = option.key
                        MoneySheetRow(
                            label: option.label,
                            selected: option.selected,
                            identifier: "money-category-group-\(groupID)"
                        ) { send(event { $0.group = .with { $0.groupID = groupID } }) }
                    }
                }
            case .row:
                OptionSheet(title: categories.rowTitle) {
                    ForEach(Array(categories.rowActions.filter(\.enabled).enumerated()), id: \.offset) { _, action in
                        let key = action.key
                        MoneySheetRow(
                            iconKey: action.iconKey,
                            label: action.label,
                            destructive: action.destructive,
                            identifier: "money-category-action-\(key)"
                        ) { send(event { $0.rowAction = .with { $0.key = key } }) }
                    }
                }
            case .merge:
                MoneyChoiceSheet(
                    title: categories.mergeTitle,
                    choices: categories.mergeOptions,
                    identifierPrefix: "money-category-merge"
                ) { key in send(event { $0.mergeInto = .with { $0.categoryID = key } }) }
            default:
                EmptyView()
            }
        }
    }

    @ViewBuilder
    private func confirm(_ state: Centraid_Screen_V1_MoneyCategoriesState) -> some View {
        ConfirmSheet(
            state.confirm,
            onConfirm: { send(event { $0.confirmAccepted = .init() }) },
            onDismiss: { send(event { $0.confirmDismissed = .init() }) }
        )
    }
}
