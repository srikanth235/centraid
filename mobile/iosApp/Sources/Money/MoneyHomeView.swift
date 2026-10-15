import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// `money.home` — Spending · Activity · Cash flow, More a sheet (#1099), on the kit.
///
/// **THE VIEW DECIDES NOTHING.** `MoneyHomeState` carries the band, the chips,
/// every word, every figure and every row; this file lays them out and forwards
/// events. `AppPlace` owns the header, the search door and the band;
/// `ReadStateView` owns loading, failure and the denied gate (no band while
/// denied). The header's Plus is the app's create verb: rows enter by import.
/// Search is a door (R-CHROME-2): the bar never opens in place, it pushes the
/// search page. Where each intent leads is `MoneyScreens.routeIntent`.
struct MoneyHomeView: View {
    let data: Data
    let send: (Data) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_MoneyHomeState {
        (try? Centraid_Screen_V1_MoneyHomeState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_MoneyHomeEvent) -> Void) -> Data {
        moneyEvent(Centraid_Screen_V1_MoneyHomeEvent.self, build)
    }

    private func addStatement() { send(event { $0.add = .init() }) }

    var body: some View {
        let state = state
        let content = state.readContent
        let chrome = state.chrome
        let sheetBinding = moneySheetBinding(sheetIsOpen(state)) { send(event { $0.sheetClosed = .init() }) }
        let chips: [RoomChip] = content.isDenied ? [] : state.chips.map { chip in
            RoomChip(
                identifier: "money-chip-\(chip.key)",
                label: chip.label,
                selected: chip.active,
                chevron: true,
                action: { send(event { $0.chip = .with { $0.key = chip.key } }) }
            )
        }
        AppPlace(
            app: "money",
            title: chrome.title,
            // THE HEADER'S ONE ACTION is the app's create verb (R-CHROME-1).
            trailing: chrome.addLabel.isEmpty
                ? nil
                : RoomAction(iconKey: "Plus", label: chrome.addLabel, identifier: "money-add", action: addStatement),
            // A DOOR, NOT A FIELD (R-CHROME-2): the field is never open here.
            search: content.isDenied || chrome.searchPlaceholder.isEmpty ? nil : SearchSlot(
                field: Centraid_Screen_V1_SearchField(),
                placeholder: chrome.searchPlaceholder,
                onOpen: { send(event { $0.searchOpened = .init() }) },
                onTerm: { _ in },
                onClose: {}
            ),
            // THE FILTER ROW is month, account and category; no sort chip (R-CHROME-3).
            chips: chips,
            showsBand: !content.isDenied && !state.band.isEmpty
        ) {
            AppBand(
                app: "money",
                tabs: state.band.map { tab in
                    BandView(
                        label: tab.label,
                        event: event { $0.band = .with { $0.key = tab.key } },
                        iconKey: tab.iconKey,
                        selected: tab.current
                    )
                },
                onSelect: send,
                onHome: onHome
            )
        } content: {
            ReadStateView(
                content: content,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { home in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) { page(home, state: state) }
                        .padding(.bottom, 16)
                }
                .refreshable { send(event { $0.refreshed = .init() }) }
                .accessibilityIdentifier("money-home-list")
            }
        }
        .sheet(isPresented: sheetBinding) {
            sheetContent(state, home: content.loaded)
        }
    }

    // MARK: - The three destinations

    @ViewBuilder
    private func page(_ home: Centraid_Screen_V1_MoneyHomeData, state: Centraid_Screen_V1_MoneyHomeState) -> some View {
        if home.showsMonth { monthStepper(home, chrome: state.chrome) }
        switch state.destination {
        case .activity: activity(home.activity)
        case .cashflow: cashflow(home.cashflow)
        default: spending(home.spending)
        }
    }

    private func monthStepper(_ home: Centraid_Screen_V1_MoneyHomeData, chrome: Centraid_Screen_V1_MoneyHomeChrome) -> some View {
        HStack(spacing: 0) {
            KitIconKey(iconKey: "ChevronLeft", label: chrome.previousMonthLabel, identifier: "money-month-previous") {
                send(event { $0.monthStepped = .with { $0.months = -1 } })
            }
            Text(home.monthLabel)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("text", scheme))
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
            KitIconKey(iconKey: "ChevronRight", label: chrome.nextMonthLabel, identifier: "money-month-next") {
                send(event { $0.monthStepped = .with { $0.months = 1 } })
            }
            .disabled(!home.canStepNext)
        }
        .padding(.horizontal, CentraidGeometry.pageMargin - 8)
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func spending(_ spending: Centraid_Screen_V1_MoneySpendingData) -> some View {
        if spending.hasEmpty {
            EmptyStateView(spending.empty, onAction: addStatement)
        } else {
            ForEach(Array(spending.heroes.enumerated()), id: \.offset) { _, hero in
                MoneyHeroView(hero: hero)
            }
            MoneyNote(text: spending.daysLeftLabel)
            ForEach(Array(spending.inOutNet.enumerated()), id: \.offset) { _, group in
                ForEach(Array(group.figures.enumerated()), id: \.offset) { _, figure in
                    MoneyFigureRow(figure: figure)
                }
            }
            ForEach(Array(spending.tables.enumerated()), id: \.offset) { _, table in
                MoneySection(title: table.heading)
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, line in
                    categoryLine(line, currency: table.currency)
                }
            }
            ForEach(Array(spending.notes.enumerated()), id: \.offset) { _, note in
                MoneyNote(text: note)
            }
            if !spending.recurringLabel.isEmpty {
                CentraidRow(
                    title: spending.recurringLabel,
                    meta: spending.recurringMeta,
                    identifier: "money-recurring"
                ) { send(event { $0.recurring = .init() }) }
            }
            ForEach(Array(spending.definitions.enumerated()), id: \.offset) { _, fact in
                FieldRow(key: fact.label, value: fact.detail)
            }
            MoneyNote(text: spending.windowNote)
        }
    }

    private func categoryLine(_ line: Centraid_Screen_V1_MoneyCategoryLine, currency: String) -> some View {
        // A line with a plan reads what is left; a line without one, what was spent.
        let figure = line.hasPlan_p ? line.left : line.spent
        let categoryID = line.categoryID
        return CentraidRow(
            title: line.label,
            meta: line.hasPlan_p ? MoneyWords.amount(line.planned) : "",
            trailing: MoneyWords.amount(figure),
            trailingTone: line.over ? "net" : "text",
            accessibility: MoneyWords.spoken(line.accessibilityLabel, figure),
            identifier: "money-category-\(categoryID)"
        ) {
            send(event { $0.categoryLine = .with {
                $0.categoryID = categoryID
                $0.currency = currency
            } })
        }
    }

    @ViewBuilder
    private func activity(_ activity: Centraid_Screen_V1_MoneyActivityData) -> some View {
        if activity.hasEmpty {
            EmptyStateView(activity.empty, onAction: addStatement)
        } else {
            if !activity.needsLabel.isEmpty {
                MoneyNote(text: activity.needsLabel)
                ForEach(Array(activity.needsCategory.enumerated()), id: \.offset) { _, figure in
                    MoneyFigureRow(figure: figure)
                }
            }
            ForEach(Array(activity.sections.enumerated()), id: \.offset) { _, section in
                MoneySection(title: section.heading)
                ForEach(Array(section.rows.enumerated()), id: \.offset) { _, row in
                    let txnID = row.txnID
                    MoneyRowView(row: row) {
                        send(event { $0.transaction = .with { $0.txnID = txnID } })
                    }
                }
            }
            MoneyNote(text: activity.window)
            ShowMoreFooter(visible: activity.more) { send(event { $0.showMore = .init() }) }
        }
    }

    @ViewBuilder
    private func cashflow(_ flow: Centraid_Screen_V1_MoneyCashflowData) -> some View {
        if flow.hasEmpty {
            EmptyStateView(flow.empty, onAction: addStatement)
        } else {
            ForEach(Array(flow.series.enumerated()), id: \.offset) { _, series in
                MoneySection(title: series.heading)
                ForEach(Array(series.months.enumerated()), id: \.offset) { _, month in
                    CentraidRow(
                        title: month.label,
                        meta: MoneyWords.meta(month.rateLabel, month.partial ? MoneyCopy.shared.PARTIAL_MONTH : ""),
                        trailing: MoneyWords.amount(month.net),
                        trailingTone: StatusChipView.ink(month.netTone, neutral: "text"),
                        dimmed: month.partial,
                        accessibility: MoneyWords.spoken(month.accessibilityLabel, month.net),
                        identifier: "money-month-\(month.month)"
                    )
                    MoneyFigureRow(label: MoneyCopy.shared.IN, amount: month.incoming)
                    MoneyFigureRow(label: MoneyCopy.shared.OUT, amount: month.outgoing)
                }
            }
            ForEach(Array(flow.definitions.enumerated()), id: \.offset) { _, fact in
                FieldRow(key: fact.label, value: fact.detail)
            }
            MoneyNote(text: flow.windowNote)
        }
    }

    // MARK: - Sheets

    private func sheetIsOpen(_ state: Centraid_Screen_V1_MoneyHomeState) -> Bool {
        switch state.sheet {
        case .more, .month, .account, .category: return true
        default: return false
        }
    }

    @ViewBuilder
    private func sheetContent(_ state: Centraid_Screen_V1_MoneyHomeState, home: Centraid_Screen_V1_MoneyHomeData?) -> some View {
        let chrome = state.chrome
        switch state.sheet {
        case .more:
            OptionSheet(title: chrome.moreTitle) {
                ForEach(Array(chrome.moreRows.enumerated()), id: \.offset) { _, row in
                    let key = row.key
                    MoneySheetRow(
                        iconKey: row.iconKey,
                        label: row.label,
                        detail: row.meta,
                        identifier: "money-more-\(key)"
                    ) { send(event { $0.more = .with { $0.key = key } }) }
                }
            }
        case .month:
            MoneyChoiceSheet(
                title: chrome.monthSheetTitle,
                choices: home?.monthOptions ?? [],
                identifierPrefix: "money-month-option"
            ) { key in send(event { $0.monthPicked = .with { $0.month = key } }) }
        case .account:
            MoneyChoiceSheet(
                title: chrome.accountSheetTitle,
                choices: home?.activity.accountOptions ?? [],
                identifierPrefix: "money-account-option"
            ) { key in send(event { $0.accountPicked = .with { $0.accountID = key } }) }
        case .category:
            MoneyChoiceSheet(
                title: chrome.categorySheetTitle,
                choices: home?.activity.categoryOptions ?? [],
                identifierPrefix: "money-category-option"
            ) { key in send(event { $0.categoryPicked = .with { $0.key = key } }) }
        default:
            EmptyView()
        }
    }
}
