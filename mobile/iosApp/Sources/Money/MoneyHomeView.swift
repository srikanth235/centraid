import SwiftUI

/// `money.home` — Spending · Activity · Cash flow, More a sheet (#1099), on the kit.
///
/// **THE VIEW DECIDES NOTHING.** `MoneyHomeState` carries the band, the header's
/// filter menu and the month under the title, every word, every figure and every row; this file lays them out and forwards
/// events. `AppPlace` owns the header, the search door and the band;
/// `PageReadStateView` owns loading, failure and the denied gate (no band while
/// denied). The header's Plus is the app's create verb: rows enter by import.
/// Search is the band's key, in place like every app's (owner, 2026-11-19): the field takes the
/// band's place at the foot and its answer replaces the tab. Where each intent leads is Rust's
/// (`crates/screens`).
struct MoneyHomeView: View {
    let state: Centraid_Core_V1_MoneyHomeState
    let send: (Centraid_Core_V1_MoneyHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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

    /// The vault refused Money: the page's gate. It has no band or search.
    private var isDenied: Bool {
        if case .refused? = state.page.state { return true }
        return false
    }

    /// The field as Rust holds it: open or closed, the term typed so far and the corrected line.
    private var searchSlot: SearchSlot {
        var field = KitSearchField()
        field.open = state.search.open
        field.term = state.search.term
        field.corrected = state.search.corrected
        // Rust's `corrected` here is the finished sentence, so the field says it as it is.
        field.correctedLabel = state.search.corrected
        return SearchSlot(
            field: field,
            placeholder: state.chrome.searchPlaceholder,
            closeLabel: state.chrome.searchClose,
            onOpen: { send(event { $0.searchOpened = .init() }) },
            onTerm: { term in send(event { $0.searchTerm = .with { $0.term = term } }) },
            onClose: { send(event { $0.searchClosed = .init() }) }
        )
    }

    /// THE ANSWER over an open search: the hint while nothing is typed, then the count, the lines
    /// (each routes to its transaction) and the Ask row.
    private var searchResults: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if state.search.hasResults {
                    let found = state.search.results
                    if !found.hint.isEmpty {
                        Text(found.hint)
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                            .padding(.horizontal, 4)
                    }
                    if !found.countLabel.isEmpty {
                        Text(found.countLabel)
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                            .padding(.horizontal, 4)
                            .accessibilityIdentifier("money-search-count")
                    }
                    if !found.rows.isEmpty {
                        MoneyCardStack {
                            ForEach(Array(found.rows.enumerated()), id: \.offset) { index, row in
                                if index > 0 { KitHairline(inset: 64) }
                                MoneyTxnRow(row: row) { open(row.route) }
                            }
                        }
                    }
                }
                if state.search.hasAsk { SearchAskRow(ask: state.search.ask) }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 8)
            .padding(.bottom, 16)
        }
        .accessibilityIdentifier("money-search-results")
    }

    var body: some View {
        let chrome = state.chrome
        let sheetBinding = moneySheetBinding(sheetIsOpen(state)) { send(event { $0.sheetClosed = .init() }) }
        AppPlace(
            app: "money",
            title: chrome.title,
            // THE HEADER'S ONE ACTION is the app's create verb (R-CHROME-1).
            trailing: headerAction,
            // THE BAND'S SEARCH KEY opens the field in place (R-CHROME-2): its term and answer are Rust's.
            search: isDenied || chrome.searchPlaceholder.isEmpty ? nil : searchSlot,
            // THE HEADER'S FILTER BUTTON is account and category, no sort (R-CHROME-3); the month
            // stays under the title and opens its sheet.
            filter: filter,
            subtitle: subtitle,
            showsBand: !isDenied && !state.band.isEmpty
        ) {
            band
        } content: {
            pageContent
        }
        .sheet(isPresented: sheetBinding) {
            sheetContent(state, home: state.loaded)
        }
    }

    // The body's parts live apart: one expression holding all of them was more than the Swift
    // type checker could solve ("failed to produce diagnostic").
    private var headerAction: RoomAction? {
        let label = state.chrome.addLabel
        if label.isEmpty { return nil }
        return RoomAction(iconKey: "Plus", label: label, identifier: "money-add", action: addStatement)
    }

    private var band: AppBand {
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
    }

    /// A term that found nothing still offers the Ask row under the empty sentence.
    private func emptyExtra() -> AnyView {
        if state.search.open, state.search.hasAsk {
            return AnyView(SearchAskRow(ask: state.search.ask))
        }
        return AnyView(EmptyView())
    }

    /// The most rows of Activity drawn eagerly; a longer month is a lazy list.
    private static let eagerRowLimit = 150

    @ViewBuilder
    private var homeList: some View {
        if case let .data(home)? = state.content {
            ScrollView {
                // SPENDING AND CASH FLOW ARE BOUNDED AND EAGER; ACTIVITY IS EAGER UP TO A MONTH'S
                // WORTH OF ROWS (#1202) AND LAZY BEYOND IT. A `LazyVStack` here drew the Spending page
                // with its "In" row missing and a blank band in its place (a figure row among sibling
                // `ForEach(…, id: \.offset)` blocks), and under the audit's text-size sweep a lazy
                // Activity page lost every one of its words ("partially unsupported", 28 of them on
                // the first screen), so only a page that can hold hundreds of rows pays for laziness.
                if state.destination == .activity, home.activity.sections.reduce(0, { $0 + $1.rows.count }) > Self.eagerRowLimit {
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

    /// The empty card's action: the statement import, unless a search is open (a ternary of `nil`
    /// and a method reference defeats the type checker in the initializer below).
    private var emptyAction: (() -> Void)? {
        if state.search.open { return nil }
        return { addStatement() }
    }

    private var pageContent: some View {
        PageReadStateView(
            page: state.page,
            onRetry: { send(event { $0.refreshed = .init() }) },
            onEmptyAction: emptyAction,
            emptyExtra: emptyExtra
        ) {
            if state.search.open {
                searchResults
            } else {
                homeList
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            MoneyStatusFoot(
                status: MoneyWords.line(state.hasStatus ? state.status : nil),
                identifier: "money-home-status"
            )
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
        ForEach(Array(spending.bars.enumerated()), id: \.offset) { index, bars in
            let hero = index < spending.heroes.count ? spending.heroes[index] : spending.heroes.first
            VStack(alignment: .leading, spacing: 12) {
                if !bars.heading.isEmpty {
                    Text(bars.heading).kitType(.group).foregroundStyle(Surface.meta)
                }
                // THE WEEK / MONTH CONTROL UNDER THE TOTAL AT ACCESSIBILITY SIZES (#1202): beside it
                // the amount was cut to "$2,745...." and the control to "W...". The total shrinks
                // before it would ever be cut.
                let heroLayout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
                    : AnyLayout(HStackLayout(alignment: .top))
                heroLayout {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(hero?.spentLabel ?? "")
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                        Text(hero?.spent ?? "")
                            .kitType(.title)
                            .monospacedDigit()
                            .foregroundStyle(Surface.ink)
                            .minimumScaleFactor(dynamicTypeSize.isAccessibilitySize ? 0.4 : 0.7)
                            .lineLimit(1)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("money-hero")
                    if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
                    KitSegmented(
                        options: bars.modes.map { (key: $0.key, label: $0.label) },
                        selected: bars.modes.first(where: { $0.selected })?.key ?? "",
                        identifier: "money-bars-mode",
                        fills: dynamicTypeSize.isAccessibilitySize,
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

    /// ACTIVITY, home: the month's overview card, the review banner, then each day's rows in
    /// a card under its heading and what it came to.
    @ViewBuilder
    private func activity(_ activity: Centraid_Core_V1_MoneyActivityData) -> some View {
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

    @ViewBuilder
    private func cashflow(_ flow: Centraid_Core_V1_MoneyCashflowData) -> some View {
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
            if !dynamicTypeSize.isAccessibilitySize {
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    ForEach([series.inLabel, series.outLabel, series.netLabel], id: \.self) { label in
                        Text(label).kitType(.meta).foregroundStyle(Surface.meta)
                            .frame(width: 68, alignment: .trailing)
                    }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
            }
            // NEWEST FIRST under the chart, which runs oldest to newest.
            ForEach(Array(series.months.reversed().enumerated()), id: \.offset) { _, month in
                MoneyMonthRow(
                    month: month,
                    identifier: "money-month-\(month.month)",
                    labels: [series.inLabel, series.outLabel, series.netLabel]
                )
            }
        }
        ForEach(Array(flow.definitions.enumerated()), id: \.offset) { _, fact in
            FieldRow(key: fact.label, value: fact.detail)
        }
        MoneyNote(text: flow.windowNote)
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
