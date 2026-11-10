import SwiftUI

/// `money.home` — Spending · Activity · Cash flow, More a sheet (#1099), on the kit.
///
/// **THE VIEW DECIDES NOTHING.** `MoneyHomeState` carries the band, the header's
/// filter menu and the month under the title, every word, every figure and every row; this file lays them out and forwards
/// events. `AppPlace` owns the header, the search door and the band;
/// `ReadStateView` owns loading, failure and the denied gate (no band while
/// denied). The header's Plus is the app's create verb: rows enter by import.
/// Search is a door (R-CHROME-2): the bar never opens in place, it pushes the
/// search page. Where each intent leads is Rust's (`crates/screens`).
struct MoneyHomeView: View {
    let state: Centraid_Core_V1_MoneyHomeState
    let send: (Centraid_Core_V1_MoneyHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_MoneyHomeEvent) -> Void) -> Centraid_Core_V1_MoneyHomeEvent {
        var event = Centraid_Core_V1_MoneyHomeEvent()
        build(&event)
        return event
    }

    private func addStatement() { open(state.chrome.importRoute) }

    /// Rust's menu: Account and Category, nested. A pick or the clear row is an event; which is
    /// checked, and whether the funnel is lit, is on the state.
    private var filter: FilterSlot? {
        guard state.hasFilterMenu else { return nil }
        return FilterSlot(
            menu: state.filterMenu,
            onPick: { section, option in
                send(event {
                    $0.filterMenuPicked = .with {
                        $0.sectionKey = section
                        $0.optionKey = option
                    }
                })
            },
            onClear: { send(event { $0.filterMenuCleared = .init() }) }
        )
    }

    /// The month in view, under the title: a tap opens the month sheet.
    private var subtitle: SubtitleSlot? {
        guard state.hasSubtitle else { return nil }
        return SubtitleSlot(
            subtitle: state.subtitle,
            onTap: { send(event { $0.monthTapped = .init() }) }
        )
    }

    var body: some View {
        let content = state.readContent
        let chrome = state.chrome
        let sheetBinding = moneySheetBinding(sheetIsOpen(state)) { send(event { $0.sheetClosed = .init() }) }
        AppPlace(
            app: "money",
            title: chrome.title,
            // THE HEADER'S ONE ACTION is the app's create verb (R-CHROME-1).
            trailing: chrome.addLabel.isEmpty
                ? nil
                : RoomAction(iconKey: "Plus", label: chrome.addLabel, identifier: "money-add", action: addStatement),
            // A DOOR, NOT A FIELD (R-CHROME-2): the band's key pushes the search page; the field is
            // never open here.
            search: content.isDenied || chrome.searchPlaceholder.isEmpty ? nil : SearchSlot(
                field: KitSearchField(),
                placeholder: chrome.searchPlaceholder,
                onOpen: { open(chrome.searchRoute) },
                onTerm: { _ in },
                onClose: {}
            ),
            // THE HEADER'S FILTER BUTTON is account and category, no sort (R-CHROME-3); the month
            // stays under the title and opens its sheet.
            filter: filter,
            subtitle: subtitle,
            showsBand: !content.isDenied && !state.band.isEmpty
        ) {
            AppBand(
                app: "money",
                tabs: state.band.map { tab in
                    BandView(
                        label: tab.label,
                        event: Data(tab.key.utf8),
                        iconKey: tab.iconKey,
                        selected: tab.current,
                        key: tab.key
                    )
                },
                onSelect: { picked in
                    let key = String(decoding: picked, as: UTF8.self)
                    send(event { $0.band = .with { $0.key = key } })
                },
                onHome: onHome
            )
        } content: {
            ReadStateView(
                content: content,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { home in
                ScrollView {
                    // SPENDING AND CASH FLOW ARE BOUNDED AND EAGER; ACTIVITY IS THE
                    // LONG LIST AND STAYS LAZY. A `LazyVStack` here drew the
                    // Spending page with its "In" row missing and a blank band in
                    // its place (a figure row among sibling `ForEach(…, id:
                    // \.offset)` blocks), so only the page that can hold hundreds
                    // of rows pays for laziness.
                    if state.destination == .activity {
                        LazyVStack(alignment: .leading, spacing: 0) { page(home, state: state) }
                            .padding(.bottom, 16)
                    } else {
                        VStack(alignment: .leading, spacing: 0) { page(home, state: state) }
                            .padding(.bottom, 16)
                    }
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
    private func page(_ home: Centraid_Core_V1_MoneyHomeData, state: Centraid_Core_V1_MoneyHomeState) -> some View {
        switch state.destination {
        case .cashflow: cashflow(home.cashflow)
        case .spending:
            VStack(alignment: .leading, spacing: 16) { spending(home.spending) }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 8)
        default:
            VStack(alignment: .leading, spacing: 12) { activity(home.activity) }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 8)
        }
    }

    /// SPENDING: the chart card (spent so far, Week / Day, the bars and the sentence under the
    /// selected one), the categories with their progress, then the notes and the recurring row.
    @ViewBuilder
    private func spending(_ spending: Centraid_Core_V1_MoneySpendingData) -> some View {
        if spending.hasEmpty {
            EmptyStateView(spending.empty, onAction: addStatement)
        } else {
            ForEach(Array(spending.bars.enumerated()), id: \.offset) { index, bars in
                let hero = index < spending.heroes.count ? spending.heroes[index] : spending.heroes.first
                VStack(alignment: .leading, spacing: 12) {
                    if !bars.heading.isEmpty {
                        Text(bars.heading).kitType(.group).foregroundStyle(Surface.meta)
                    }
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(hero?.spentLabel ?? "")
                                .kitType(.meta)
                                .foregroundStyle(Surface.meta)
                            Text(hero?.spent ?? "")
                                .kitType(.title)
                                .monospacedDigit()
                                .foregroundStyle(Surface.ink)
                                .minimumScaleFactor(0.7)
                                .lineLimit(1)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("money-hero")
                        Spacer(minLength: 8)
                        KitSegmented(
                            options: bars.modes.map { (key: $0.key, label: $0.label) },
                            selected: bars.modes.first(where: { $0.selected })?.key ?? "",
                            identifier: "money-bars-mode",
                            onSelect: { key in send(event { $0.barsModePicked = .with { $0.key = key } }) }
                        )
                    }
                    MoneyBarsChart(bars: bars) { picked in
                        send(event { $0.barPicked = .with { $0.index = UInt32(picked) } })
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .kitCard()
            }
            ForEach(Array(spending.tables.enumerated()), id: \.offset) { _, table in
                if !table.heading.isEmpty {
                    Text(table.heading).kitType(.group).foregroundStyle(Surface.meta).padding(.horizontal, 4)
                }
                MoneyCardStack {
                    ForEach(Array(table.rows.enumerated()), id: \.offset) { index, line in
                        if index > 0 { KitHairline(inset: 16) }
                        MoneyCategoryProgressRow(line: line) { open(line.route) }
                            .accessibilityIdentifier("money-category-\(line.route.moneyTarget.categoryID)")
                    }
                    if table.hasMore {
                        KitHairline(inset: 16)
                        MoneyRestRow(line: table.more, identifier: "money-categories-more") {
                            send(event { $0.categoriesExpanded = .init() })
                        }
                    }
                    if table.hasUncategorised {
                        KitHairline(inset: 16)
                        let needsKey = table.uncategorised.key
                        MoneyRestRow(line: table.uncategorised, pending: true, identifier: "money-needs-category") {
                            send(event { $0.categoryPicked = .with { $0.key = needsKey } })
                        }
                    }
                }
            }
            if !spending.recurringLabel.isEmpty {
                MoneyCardStack {
                    CentraidRow(
                        title: spending.recurringLabel,
                        meta: spending.recurringMeta,
                        identifier: "money-recurring",
                        divider: false
                    ) { open(spending.recurringRoute) }
                }
            }
            ForEach(Array(spending.notes.enumerated()), id: \.offset) { _, note in
                Text(note).kitType(.meta).foregroundStyle(Surface.meta).padding(.horizontal, 4)
            }
            ForEach(Array(spending.definitions.enumerated()), id: \.offset) { _, fact in
                VStack(alignment: .leading, spacing: 2) {
                    Text(fact.label).kitType(.meta).fontWeight(.semibold).foregroundStyle(Surface.body)
                    Text(fact.detail).kitType(.meta).foregroundStyle(Surface.meta)
                }
                .padding(.horizontal, 4)
            }
            if !spending.windowNote.isEmpty {
                Text(spending.windowNote).kitType(.meta).foregroundStyle(Surface.meta).padding(.horizontal, 4)
            }
        }
    }

    /// ACTIVITY, home: the month's overview card, the review banner, then each day's rows in
    /// a card under its heading and what it came to.
    @ViewBuilder
    private func activity(_ activity: Centraid_Core_V1_MoneyActivityData) -> some View {
        if activity.hasEmpty {
            EmptyStateView(activity.empty, onAction: addStatement)
        } else {
            ForEach(Array(activity.heroes.enumerated()), id: \.offset) { index, hero in
                MoneyOverviewCard(
                    hero: hero,
                    daysLeft: activity.daysLeftLabel,
                    inOut: index < activity.inOutNet.count ? activity.inOutNet[index] : nil
                )
            }
            if !activity.needsTitle.isEmpty {
                // THE FILTER THAT LISTS THESE ROWS is the state's own `needs_key`.
                let needsKey = activity.needsKey
                MoneyReviewBanner(
                    count: activity.needsCount,
                    title: activity.needsTitle,
                    review: activity.reviewLabel,
                    spoken: activity.needsLabel
                ) {
                    send(event { $0.categoryPicked = .with { $0.key = needsKey } })
                }
            }
            ForEach(Array(activity.sections.enumerated()), id: \.offset) { _, section in
                MoneyDayHeading(section: section)
                MoneyCardStack {
                    ForEach(Array(section.rows.enumerated()), id: \.offset) { index, row in
                        if index > 0 { KitHairline(inset: 64) }
                        MoneyTxnRow(row: row) { open(row.route) }
                    }
                }
            }
            if !activity.window.isEmpty {
                Text(activity.window).kitType(.meta).foregroundStyle(Surface.meta).padding(.horizontal, 4)
            }
            ShowMoreFooter(visible: activity.more) { send(event { $0.showMore = .init() }) }
        }
    }

    @ViewBuilder
    private func cashflow(_ flow: Centraid_Core_V1_MoneyCashflowData) -> some View {
        if flow.hasEmpty {
            EmptyStateView(flow.empty, onAction: addStatement)
        } else {
            ForEach(Array(flow.series.enumerated()), id: \.offset) { _, series in
                MoneySection(title: series.heading)
                MoneyCashflowChart(
                    months: series.months,
                    summary: series.months.map(\.accessibilityLabel).joined(separator: ". ")
                )
                MoneyLegend(
                    incoming: series.inLabel,
                    outgoing: series.outLabel,
                    partial: series.partialLabel
                )
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    ForEach([series.inLabel, series.outLabel, series.netLabel], id: \.self) { label in
                        Text(label).kitType(.meta).foregroundStyle(Surface.meta)
                            .frame(width: 68, alignment: .trailing)
                    }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                // NEWEST FIRST under the chart, which runs oldest to newest.
                ForEach(Array(series.months.reversed().enumerated()), id: \.offset) { _, month in
                    MoneyMonthRow(month: month, identifier: "money-month-\(month.month)")
                }
            }
            ForEach(Array(flow.definitions.enumerated()), id: \.offset) { _, fact in
                FieldRow(key: fact.label, value: fact.detail)
            }
            MoneyNote(text: flow.windowNote)
        }
    }

    // MARK: - Sheets

    private func sheetIsOpen(_ state: Centraid_Core_V1_MoneyHomeState) -> Bool {
        switch state.sheet {
        case .more, .month: return true
        default: return false
        }
    }

    @ViewBuilder
    private func sheetContent(_ state: Centraid_Core_V1_MoneyHomeState, home: Centraid_Core_V1_MoneyHomeData?) -> some View {
        let chrome = state.chrome
        switch state.sheet {
        case .more:
            OptionSheet(title: chrome.moreTitle) {
                ForEach(Array(chrome.moreRows.enumerated()), id: \.offset) { _, row in
                    // THE KIT'S SHEET ROW, as the More board draws it: a tile, the verb and its
                    // line, a chevron, padded inside the card.
                    SheetRow(
                        iconKey: row.iconKey,
                        label: row.label,
                        detail: row.meta,
                        chevron: true,
                        identifier: "money-more-\(row.route.screen.replacingOccurrences(of: "money.", with: ""))"
                    ) {
                        // The sheet closes behind the page the row opens.
                        send(event { $0.moreOpened = .init() })
                        open(row.route)
                    }
                }
            }
        case .month:
            MoneyChoiceSheet(
                title: chrome.monthSheetTitle,
                choices: home?.monthOptions ?? [],
                identifierPrefix: "money-month-option"
            ) { key in send(event { $0.monthPicked = .with { $0.month = key } }) }
        default:
            EmptyView()
        }
    }
}
