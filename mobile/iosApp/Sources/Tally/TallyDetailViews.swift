import SwiftUI

// TALLY'S DETAIL PAGES — a group, a friend, an expense (#1046). Each is a
// `PushedPage` over `ReadStateView`; the words, the tones, the empties and
// which verbs exist are the state's. The intents (a row, a member, a part,
// Add, Settle up, Edit) are forwarded and then routed here, by the shell.

// MARK: - Group

struct TallyGroupView: View {
    let data: Data
    let send: (Data) -> Void
    let push: (ShellModel.Route) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_TallyGroupState {
        (try? Centraid_Screen_V1_TallyGroupState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_TallyGroupEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_TallyGroupEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_TallyGroupState) -> ScreenContent<Centraid_Screen_V1_TallyGroupData> {
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
        let title: String = {
            if case let .data(group) = content, !group.name.isEmpty { return group.name }
            return state.title
        }()
        PushedPage(title: title, parentTitle: state.chrome.back, onBack: onBack) {
            if case let .data(group) = content, !group.hasGone, !state.chrome.addExpense.isEmpty {
                Button {
                    send(Self.event { $0.addExpense = .init() })
                    push(TallyScreens.addRoute(groupID: state.groupID))
                } label: {
                    Text(state.chrome.addExpense)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                }
                .accessibilityIdentifier("tally-group-add")
            }
        } content: {
            ReadStateView(
                content: content,
                loadingLabel: state.chrome.loading,
                onRetry: { send(Self.event { $0.refreshed = .init() }) }
            ) { group in
                if group.hasGone {
                    EmptyStateView(group.gone)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            TallyWriteLine(write: state.write)
                            TallyGroupMark(glyph: group.glyph, iconKey: group.iconKey, hue: group.hue)
                                .padding(.horizontal, CentraidGeometry.pageMargin)
                                .padding(.top, 8)
                            TallyNote(text: group.archivedMeta)
                            TallyHeroView(
                                hero: group.hero,
                                verbs: state.chrome.settleUp.isEmpty ? [] : [(state.chrome.settleUp, {
                                    send(Self.event { $0.settleUp = .init() })
                                    push(TallyScreens.settleUpRoute(state.groupID))
                                })]
                            )
                            SectionHeader(title: group.membersHeading, count: UInt32(group.members.count))
                            ForEach(group.members, id: \.person.partyID) { member in
                                TallyPersonRowView(
                                    person: member.person,
                                    title: member.person.name,
                                    meta: member.meta,
                                    figures: member.hasNet ? [member.net] : [],
                                    dimmed: member.departed,
                                    accessibility: member.accessibilityLabel,
                                    identifier: "tally-member-\(member.person.partyID)",
                                    onTap: member.person.isMe ? nil : {
                                        send(Self.event { $0.member = .with { $0.partyID = member.person.partyID } })
                                        push(TallyScreens.friendRoute(member.person.partyID, member.person.name))
                                    }
                                )
                            }
                            if group.hasSimplify { simplify(group.simplify) }
                            SectionHeader(title: group.ledgerHeading, count: UInt32(group.ledger.count))
                            if group.hasLedgerEmpty { EmptyStateView(group.ledgerEmpty) }
                            ForEach(group.ledger, id: \.rowKey) { row in
                                TallyLedgerRowView(row: row) { openRow(row) }
                            }
                            if !group.settlements.isEmpty {
                                SectionHeader(title: group.settlementsHeading, count: UInt32(group.settlements.count))
                                ForEach(group.settlements, id: \.rowKey) { row in
                                    TallyLedgerRowView(row: row) { openRow(row) }
                                }
                            }
                        }
                        .padding(.bottom, 16)
                    }
                    .refreshable { send(Self.event { $0.refreshed = .init() }) }
                }
            }
        }
    }

    @ViewBuilder
    private func simplify(_ simplify: Centraid_Screen_V1_TallySimplify) -> some View {
        SectionHeader(title: simplify.heading)
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: Binding(
                get: { simplify.optedIn },
                set: { _ in send(Self.event { $0.simplifyToggled = .init() }) }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(simplify.toggleLabel)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                    if !simplify.stateLine.isEmpty {
                        Text(simplify.stateLine)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    }
                }
            }
            .disabled(!simplify.toggleEnabled)
            .accessibilityIdentifier("tally-simplify-toggle")
            if !simplify.summary.isEmpty {
                Text(simplify.summary)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("text", scheme))
            }
            if !simplify.explanation.isEmpty {
                Text(simplify.explanation)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 6)
        ForEach(simplify.transfers, id: \.key) { transfer in
            TallyTransferRowView(transfer: transfer)
        }
    }

    private func openRow(_ row: Centraid_Screen_V1_TallyLedgerRow) {
        guard !row.expenseID.isEmpty else { return }
        send(Self.event { $0.expense = .with { $0.expenseID = row.expenseID } })
        push(TallyScreens.expenseRoute(row.expenseID))
    }
}

// MARK: - Friend

struct TallyFriendView: View {
    let data: Data
    let send: (Data) -> Void
    let push: (ShellModel.Route) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_TallyFriendState {
        (try? Centraid_Screen_V1_TallyFriendState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_TallyFriendEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_TallyFriendEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_TallyFriendState) -> ScreenContent<Centraid_Screen_V1_TallyFriendData> {
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
        let title: String = {
            if case let .data(friend) = content, !friend.person.name.isEmpty { return friend.person.name }
            return state.title
        }()
        PushedPage(title: title, parentTitle: state.chrome.back, onBack: onBack) {
            if case let .data(friend) = content, !friend.hasGone, !state.chrome.addExpense.isEmpty {
                Button {
                    send(Self.event { $0.addExpense = .init() })
                    push(TallyScreens.addRoute(partyID: state.partyID))
                } label: {
                    Text(state.chrome.addExpense)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                }
                .accessibilityIdentifier("tally-friend-add")
            }
        } content: {
            ReadStateView(
                content: content,
                loadingLabel: state.chrome.loading,
                onRetry: { send(Self.event { $0.refreshed = .init() }) }
            ) { friend in
                if friend.hasGone {
                    EmptyStateView(friend.gone)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            TallyHeroView(
                                hero: friend.hero,
                                verbs: state.chrome.settleUp.isEmpty ? [] : [(state.chrome.settleUp, {
                                    send(Self.event { $0.settleUp = .init() })
                                    push(TallyScreens.settleUpRoute())
                                })]
                            )
                            if !friend.parts.isEmpty {
                                SectionHeader(title: friend.partsHeading, count: UInt32(friend.parts.count))
                                ForEach(Array(friend.parts.enumerated()), id: \.offset) { _, part in
                                    TallyPersonRowView(
                                        title: part.title,
                                        figures: part.hasNet ? [part.net] : [],
                                        accessibility: part.accessibilityLabel,
                                        identifier: "tally-part-\(part.groupID)",
                                        onTap: part.groupID.isEmpty ? nil : {
                                            send(Self.event { $0.group = .with { $0.groupID = part.groupID } })
                                            push(TallyScreens.groupRoute(part.groupID, part.title))
                                        }
                                    )
                                }
                                TallyNote(text: friend.partsNote)
                            }
                            SectionHeader(title: friend.ledgerHeading, count: UInt32(friend.ledger.count))
                            if friend.hasLedgerEmpty { EmptyStateView(friend.ledgerEmpty) }
                            ForEach(friend.ledger, id: \.rowKey) { row in
                                TallyLedgerRowView(row: row) {
                                    guard !row.expenseID.isEmpty else { return }
                                    send(Self.event { $0.expense = .with { $0.expenseID = row.expenseID } })
                                    push(TallyScreens.expenseRoute(row.expenseID))
                                }
                            }
                        }
                        .padding(.bottom, 16)
                    }
                    .refreshable { send(Self.event { $0.refreshed = .init() }) }
                }
            }
        }
    }
}

// MARK: - Expense

struct TallyExpenseView: View {
    let data: Data
    let send: (Data) -> Void
    let push: (ShellModel.Route) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_TallyExpenseState {
        (try? Centraid_Screen_V1_TallyExpenseState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_TallyExpenseEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_TallyExpenseEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_TallyExpenseState) -> ScreenContent<Centraid_Screen_V1_TallyExpenseData> {
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
        let expense: Centraid_Screen_V1_TallyExpenseData? = {
            if case let .data(expense) = content, !expense.hasGone { return expense }
            return nil
        }()
        PushedPage(title: expense?.title ?? "", parentTitle: state.chrome.back, onBack: onBack) {
            if let expense, !expense.trashed, !expense.editLabel.isEmpty {
                Button {
                    send(Self.event { $0.edit = .init() })
                    push(TallyScreens.editRoute(state.expenseID))
                } label: {
                    Text(expense.editLabel)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                }
                .accessibilityIdentifier("tally-expense-edit")
            }
        } content: {
            ReadStateView(
                content: content,
                loadingLabel: state.chrome.loading,
                onRetry: { send(Self.event { $0.refreshed = .init() }) }
            ) { expense in
                if expense.hasGone {
                    EmptyStateView(expense.gone)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            TallyWriteLine(write: state.write)
                            head(expense)
                            ForEach(expense.fields, id: \.key) { field in
                                FieldRow(key: field.key, value: field.value, note: field.note)
                            }
                            shares(expense.payersHeading, expense.payers)
                            shares(expense.splitsHeading, expense.splits)
                            if !expense.lines.isEmpty {
                                SectionHeader(title: expense.linesHeading, count: UInt32(expense.lines.count))
                                ForEach(expense.lines, id: \.lineItemID) { line in
                                    CentraidRow(
                                        title: line.title,
                                        meta: line.meta,
                                        trailing: tallyMoney(line.amount),
                                        identifier: "tally-line-\(line.lineItemID)"
                                    )
                                }
                            }
                            if !expense.memo.isEmpty {
                                SectionHeader(title: expense.memoHeading)
                                Text(expense.memo)
                                    .centraidType("body")
                                    .foregroundStyle(Theme.color("text", scheme))
                                    .padding(.horizontal, CentraidGeometry.pageMargin)
                                    .padding(.vertical, 6)
                            }
                            if !expense.memoLabel.isEmpty {
                                HStack {
                                    KitOutlineButton(label: expense.memoLabel) {
                                        send(Self.event { $0.memoOpened = .init() })
                                    }
                                    .disabled(state.write.phase == .inFlight)
                                    .accessibilityIdentifier("tally-expense-memo")
                                    Spacer()
                                }
                                .padding(.horizontal, CentraidGeometry.pageMargin)
                                .padding(.top, 8)
                            }
                            if !expense.revisions.isEmpty {
                                SectionHeader(title: expense.revisionsHeading, count: UInt32(expense.revisions.count))
                                ForEach(expense.revisions, id: \.revisionID) { revision in
                                    revisionRow(revision)
                                }
                            }
                            verbs(expense)
                        }
                        .padding(.bottom, 16)
                    }
                    .refreshable { send(Self.event { $0.refreshed = .init() }) }
                }
            }
        }
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
        // THE MEMO SHEET IS UP WHILE THE STATE HOLDS A DRAFT; closing it, by
        // Done or by a swipe, is the machine's `MemoClosed` (#1015 D3: close
        // is done — changed words are written then).
        .sheet(isPresented: Binding(
            get: { state.hasMemoDraft },
            set: { open in if !open, state.hasMemoDraft { send(Self.event { $0.memoClosed = .init() }) } }
        )) {
            TallyMemoSheet(
                title: expense?.memoLabel ?? "",
                draft: state.memoDraft,
                placeholder: state.chrome.memoPlaceholder,
                doneLabel: state.chrome.memoDone,
                onChange: { text in send(Self.event { $0.memoChanged = .with { $0.text = text } }) },
                onDone: { send(Self.event { $0.memoClosed = .init() }) }
            )
        }
    }

    private func head(_ expense: Centraid_Screen_V1_TallyExpenseData) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(tallyMoney(expense.amount))
                .centraidType("display")
                .monospacedDigit()
                .foregroundStyle(Theme.color(expense.trashed ? "textFaint" : "text", scheme))
            if expense.hasYours, !expense.yours.label.isEmpty {
                Text([expense.yours.label, tallyMoney(expense.yours.amount)].filter { !$0.isEmpty }.joined(separator: " "))
                    .centraidType("small")
                    .foregroundStyle(Theme.color(TallyInk.role(expense.yours.tone), scheme))
            }
            if expense.trashed, !expense.trashLine.isEmpty {
                Text(expense.trashLine)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("net", scheme))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func shares(_ heading: String, _ rows: [Centraid_Screen_V1_TallyShareRow]) -> some View {
        if !rows.isEmpty {
            SectionHeader(title: heading, count: UInt32(rows.count))
            // IDS UNIQUE ACROSS BOTH LISTS: payers and splits sit in one
            // `LazyVStack`, and two rows sharing an offset id drew the first
            // split blank.
            ForEach(Array(zip(rows.indices.map { "\(heading)-\($0)" }, rows)), id: \.0) { _, share in
                HStack(spacing: 12) {
                    TallyChipView(person: share.person)
                    Text(share.person.name)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(tallyMoney(share.amount))
                        .centraidType("smallStrong")
                        .monospacedDigit()
                        .foregroundStyle(Theme.color("text", scheme))
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                .overlay(alignment: .bottom) { KitHairline() }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(share.accessibilityLabel), \(tallyMoney(share.amount))")
            }
        }
    }

    private func revisionRow(_ revision: Centraid_Screen_V1_TallyRevisionRow) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(revision.title)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(2)
                let meta = [revision.meta, revision.hasBeforeAmount ? tallyMoney(revision.beforeAmount) : ""]
                    .filter { !$0.isEmpty }.joined(separator: " · ")
                if !meta.isEmpty {
                    Text(meta)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
            }
            Spacer(minLength: 8)
            if !revision.stateLabel.isEmpty {
                Text(revision.stateLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            if !revision.undoLabel.isEmpty {
                Button {
                    send(Self.event { $0.undo = .with { $0.revisionID = revision.revisionID } })
                } label: {
                    Text(revision.undoLabel)
                        .centraidType("annotLabelOn")
                        .foregroundStyle(Theme.color("link", scheme))
                        .frame(minWidth: CentraidGeometry.targetMinCoarse, minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(state.write.phase == .inFlight)
                .accessibilityIdentifier("tally-undo-\(revision.revisionID)")
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .overlay(alignment: .bottom) { KitHairline() }
    }

    @ViewBuilder
    private func verbs(_ expense: Centraid_Screen_V1_TallyExpenseData) -> some View {
        let label = expense.trashed ? expense.restoreLabel : expense.trashLabel
        if !label.isEmpty {
            HStack {
                KitOutlineButton(label: label, tone: expense.trashed ? "text" : "net") {
                    send(Self.event {
                        if expense.trashed { $0.restore = .init() } else { $0.trash = .init() }
                    })
                }
                .disabled(state.write.phase == .inFlight)
                .accessibilityIdentifier(expense.trashed ? "tally-expense-restore" : "tally-expense-trash")
                Spacer()
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 20)
        }
    }
}

/// The memo's sheet: one multi-line field whose keystrokes live in the view's
/// `@State` (seeded once from the machine's draft) and go over as
/// `MemoChanged`; Done is the sheet's primary.
private struct TallyMemoSheet: View {
    let title: String
    let draft: String
    let placeholder: String
    let doneLabel: String
    let onChange: (String) -> Void
    let onDone: () -> Void

    @State private var text: String = ""
    @State private var seeded = false
    @FocusState private var focused: Bool

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        SheetRoom(title: title, primary: SheetPrimary(label: doneLabel, action: onDone)) {
            TextField(placeholder, text: $text, axis: .vertical)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
                .lineLimit(3...8)
                .focused($focused)
                .onChange(of: text) { _, typed in if seeded, typed != draft { onChange(typed) } }
                .accessibilityLabel(placeholder)
                .accessibilityIdentifier("tally-memo-field")
        }
        .presentationDetents([.medium])
        .onAppear {
            text = draft
            seeded = true
            focused = true
        }
    }
}
