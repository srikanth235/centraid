import SwiftUI
import UniformTypeIdentifiers

#if canImport(CentraidShared)
import CentraidShared
#endif

/// `money.import` — pick a statement, read the plan, publish (#1099).
///
/// The file, the account a CSV goes into, then the plan the core made of it,
/// each statement with its verdicts; nothing is written until the last button.
/// **Choose is the machine's intent and the OS picker is this file's**: the tap
/// is forwarded, then `.fileImporter` opens, and the chosen file is read through
/// its own URL (never copied into app storage) and handed to the shell as
/// `(name, bytes)`. The bridge holds the bytes only until the page is left —
/// `onDeparted` is the registry's `departed`, which drops the file.
struct MoneyImportView: View {
    let data: Data
    let send: (Data) -> Void
    let onPicked: (String, Data) -> Void
    let onBack: () -> Void
    let onDeparted: () -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var importing = false

    /// What banks name their files. None of them agree on one type, so the
    /// extensions are asked for by name as well as the CSV and plain-text types.
    private static let statementTypes: [UTType] = {
        var types: [UTType] = [UTType.commaSeparatedText, UTType.plainText]
        for ext in ["ofx", "qfx"] {
            if let type = UTType(filenameExtension: ext) { types.append(type) }
        }
        return types
    }()

    private var state: Centraid_Screen_V1_MoneyImportState {
        (try? Centraid_Screen_V1_MoneyImportState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_MoneyImportEvent) -> Void) -> Data {
        moneyEvent(Centraid_Screen_V1_MoneyImportEvent.self, build)
    }

    var body: some View {
        let state = state
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
                    EmptyStateView(plan.empty, onAction: { send(event { $0.addAccount = .init() }) })
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
        .fileImporter(
            isPresented: $importing,
            allowedContentTypes: Self.statementTypes,
            allowsMultipleSelection: false
        ) { result in
            guard case let .success(urls) = result, let url = urls.first else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            // READ IN PLACE: the file's bytes, from the importer's own URL.
            if let bytes = try? Data(contentsOf: url) {
                onPicked(url.lastPathComponent, bytes)
            }
        }
        .onDisappear(perform: onDeparted)
    }

    @ViewBuilder
    private func page(_ plan: Centraid_Screen_V1_MoneyImportData, state: Centraid_Screen_V1_MoneyImportState) -> some View {
        // THE HEAD IS ONE EAGER BLOCK: a lazy stack drops rows from sibling blocks
        // like these (a count and its neighbour went missing), so only the plan's
        // lines, which can run to thousands, are left to be lazy.
        VStack(alignment: .leading, spacing: 0) {
            MoneyNote(text: plan.lede)
            FieldRow(key: plan.fileLabel, value: plan.fileValue, note: plan.fileNote)
            if !plan.chooseLabel.isEmpty {
                MoneyQuietButton(label: plan.chooseLabel, identifier: "money-import-choose") {
                    send(event { $0.choose = .init() })
                    importing = true
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
    private func statementView(_ statement: Centraid_Screen_V1_MoneyImportStatement, keepProposed: Bool) -> some View {
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
                chips: line.hasChip ? [line.chip] : [],
                accessibility: MoneyWords.spoken(line.accessibilityLabel, line.hasAmount_p ? line.amount : nil),
                identifier: "money-import-\(statement.key)-\(line.key)"
            )
        }
        ForEach(Array(statement.more.enumerated()), id: \.offset) { _, more in
            MoneyNote(text: more)
        }
    }
}
