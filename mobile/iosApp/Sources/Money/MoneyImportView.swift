import SwiftUI

/// `money.import` — pick a statement, read the plan, publish (#1099).
///
/// The file, the account a CSV goes into, then the plan the core made of it,
/// each statement with its verdicts; nothing is written until the last button.
/// **Choose is Rust's**: the tap is forwarded, Rust asks for a file as a generic
/// `PickBytes` effect (`ScreenStore` performs it) and holds the bytes only until
/// the page is left, so nothing here reads, keeps or drops a file.
struct MoneyImportView: View {
    let state: Centraid_Core_V1_MoneyImportState
    let send: (Centraid_Core_V1_MoneyImportEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_MoneyImportEvent) -> Void) -> Centraid_Core_V1_MoneyImportEvent {
        var event = Centraid_Core_V1_MoneyImportEvent()
        build(&event)
        return event
    }

    var body: some View {
        let content = state.readContent
        let sheetBinding = moneySheetBinding(state.sheet == .account) { send(event { $0.sheetClosed = .init() }) }
        PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            ReadStateView(
                content: content,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { plan in
                if plan.hasEmpty {
                    EmptyStateView(plan.empty.legacy, onAction: { open(plan.accountsRoute) })
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) { page(plan, state: state) }
                            .padding(.bottom, 16)
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                MoneyStatusFoot(
                    status: MoneyWords.line(state.hasStatus ? state.status : nil),
                    identifier: "money-import-status"
                )
            }
        }
        .sheet(isPresented: sheetBinding) {
            MoneyChoiceSheet(
                title: content.loaded?.accountSheetTitle ?? "",
                choices: content.loaded?.accountOptions ?? [],
                identifierPrefix: "money-import-account-option"
            ) { key in send(event { $0.accountPicked = .with { $0.accountID = key } }) }
        }
        // IMPORTED: Rust says the page is done, the shell pops.
        .onChange(of: state.finished) { _, finished in if finished { onBack() } }
    }

    @ViewBuilder
    private func page(_ plan: Centraid_Core_V1_MoneyImportData, state: Centraid_Core_V1_MoneyImportState) -> some View {
        // THE HEAD IS ONE EAGER BLOCK: a lazy stack drops rows from sibling blocks
        // like these (a count and its neighbour went missing), so only the plan's
        // lines, which can run to thousands, are left to be lazy.
        VStack(alignment: .leading, spacing: 0) {
            MoneyNote(text: plan.lede)
            FieldRow(key: plan.fileLabel, value: plan.fileValue, note: plan.fileNote)
            if !plan.chooseLabel.isEmpty {
                MoneyQuietButton(label: plan.chooseLabel, identifier: "money-import-choose") {
                    send(event { $0.choose = .init() })
                }
            }
            if plan.needsAccount {
                MoneyChoiceField(key: plan.accountLabel, value: plan.accountValue, identifier: "money-import-account") {
                    send(event { $0.accountSheetOpened = .init() })
                }
            }
            MoneyNote(text: plan.refusal, ink: "net")
        }
        ForEach(Array(plan.statements.enumerated()), id: \.offset) { _, statement in
            statementView(statement, keepProposed: state.keepProposed)
        }
        if !plan.publishLabel.isEmpty {
            // PUBLISH AND DISCARD ARE ALTERNATIVES: one stack, the note that
            // says what publishing does between them.
            MoneyChoiceStack {
                MoneyInkButton(label: plan.publishLabel, identifier: "money-import-publish") {
                    send(event { $0.publish = .init() })
                }
                if !plan.publishNote.isEmpty {
                    MoneyNote(text: plan.publishNote)
                }
                if !plan.discardLabel.isEmpty {
                    MoneyQuietButton(label: plan.discardLabel, identifier: "money-import-discard") {
                        send(event { $0.discard = .init() })
                    }
                }
            }
        } else if !plan.discardLabel.isEmpty {
            MoneyQuietButton(label: plan.discardLabel, identifier: "money-import-discard") {
                send(event { $0.discard = .init() })
            }
        }
        if !plan.doneLabel.isEmpty {
            MoneyInkButton(label: plan.doneLabel, identifier: "money-import-done") {
                send(event { $0.done = .init() })
            }
        }
    }

    /// One statement: its span and totals, its counts and warnings, the checkpoint
    /// it was checked against, the questions it asks, then each line with its verdict.
    @ViewBuilder
    private func statementView(_ statement: Centraid_Core_V1_MoneyImportStatement, keepProposed: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            MoneySection(title: statement.title)
            MoneyNote(text: statement.refusal, ink: "net")
            MoneyNote(text: statement.span)
            ForEach(Array(statement.totals.enumerated()), id: \.offset) { _, figure in
                MoneyFigureRow(figure: figure)
            }
            MoneyCountTiles(counts: statement.counts)
            ForEach(Array(statement.warnings.enumerated()), id: \.offset) { _, warning in
                MoneyNote(text: warning)
            }
            if statement.hasCheckpoint {
                MoneyFigureRow(figure: statement.checkpoint)
            }
            MoneyNote(text: statement.checkpointLabel)
            if statement.hasQuestion {
                MoneyHeading(text: statement.question.prompt)
                MoneyNote(text: statement.question.samples.joined(separator: ", "))
                MoneyChoiceChips(choices: statement.question.options, identifierPrefix: "money-import-order") { order in
                    send(event { $0.dateOrder = .with { $0.order = order } })
                }
            }
            if !statement.signOptions.isEmpty {
                MoneyHeading(text: statement.signLabel)
                MoneyChoiceChips(choices: statement.signOptions, identifierPrefix: "money-import-sign") { choice in
                    send(event { $0.sign = .with { $0.choice = choice } })
                }
            }
            if statement.hasProposed_p {
                MoneyToggleRow(label: statement.keepProposedLabel, on: keepProposed, identifier: "money-import-keep") {
                    send(event { $0.keepProposed = .init() })
                }
            }
        }
        ForEach(Array(statement.rows.enumerated()), id: \.offset) { _, line in
            CentraidRow(
                title: line.title.isEmpty ? line.lineLabel : line.title,
                meta: MoneyWords.meta(line.title.isEmpty ? "" : line.lineLabel, line.meta, line.reason),
                trailing: line.hasAmount_p ? MoneyWords.amount(line.amount) : "",
                chips: line.hasChip ? [line.chip.legacy] : [],
                accessibility: MoneyWords.spoken(line.accessibilityLabel, line.hasAmount_p ? line.amount : nil),
                identifier: "money-import-\(statement.key)-\(line.key)"
            )
        }
        ForEach(Array(statement.more.enumerated()), id: \.offset) { _, more in
            MoneyNote(text: more)
        }
    }
}
