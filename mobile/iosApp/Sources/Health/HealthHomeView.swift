import SwiftUI

/// `health.home` — Summary · Trends · Workouts, More a sheet (#1129, #1135, #1173), on the kit.
///
/// **THE VIEW DECIDES NOTHING.** `HealthHomeState` carries the band, the segments, the filter menu,
/// every word, figure and unit, and every length as basis points; this file lays them out and
/// forwards events (Rust makes them: `crates/screens`, module `health`). `AppPlace` owns the
/// header and the band; `ReadStateView` owns loading, failure and the denied gate (no band while
/// denied). A row that opens a page carries its `Route` and a tap hands it to `open`. Health has
/// no create verb and no search: its rows enter by reading the phone's store, which Rust asks
/// the shell to do (`HealthRead`, `ScreenStore`).
struct HealthHomeView: View {
    let state: Centraid_Core_V1_HealthHomeState
    let send: (Centraid_Core_V1_HealthHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onHome: () -> Void

    private let accent = AppAccent("health")

    private func event(_ build: (inout Centraid_Core_V1_HealthHomeEvent) -> Void) -> Centraid_Core_V1_HealthHomeEvent {
        var event = Centraid_Core_V1_HealthHomeEvent()
        build(&event)
        return event
    }

    var body: some View {
        let state = state
        let content = state.readContent
        let chrome = state.chrome
        AppPlace(
            app: "health",
            title: chrome.title,
            trailing: nil,
            filter: filter,
            subtitle: subtitle,
            showsBand: !content.isDenied && !state.band.isEmpty
        ) {
            AppBand(
                app: "health",
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
            VStack(spacing: 0) {
                ReadStateView(
                    content: content,
                    onRetry: { send(event { $0.refreshed = .init() }) }
                ) { home in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if !state.segments.isEmpty {
                                segments(state.segments)
                            }
                            page(home, state: state)
                        }
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.top, 8)
                        .padding(.bottom, 24)
                    }
                    .refreshable { send(event { $0.refreshed = .init() }) }
                    .accessibilityIdentifier("health-home-list")
                }
                StatusLineView(status: state.status, identifier: "health-status-action") {}
            }
        }
        .sheet(isPresented: healthSheetBinding(sheetIsOpen(state)) { send(event { $0.sheetClosed = .init() }) }) {
            sheetContent(state)
        }
    }

    /// THE SUMMARY'S SUBTITLE: the day and where it was read from, Rust's words, plain.
    private var subtitle: SubtitleSlot? {
        guard case let .data(home)? = state.content, !home.dayLabel.isEmpty else { return nil }
        return SubtitleSlot(subtitle: .with {
            $0.label = home.dayLabel
            $0.spoken = home.dayLabel
        })
    }

    /// THE HEADER'S FILTER BUTTON: Workouts' kind, Rust's menu. A pick or the clear row is an
    /// event; which kind is checked, and whether the funnel is lit, is on the state.
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

    private func segments(_ segments: [Centraid_Core_V1_HealthChip]) -> some View {
        KitSegmented(
            options: segments.map { (key: $0.key, label: $0.label) },
            selected: segments.first(where: { $0.active })?.key ?? "",
            identifier: "health-range",
            onSelect: { key in send(event { $0.range = .with { $0.key = key } }) }
        )
        .frame(maxWidth: .infinity)
    }

    // MARK: - The three destinations

    @ViewBuilder
    private func page(_ home: Centraid_Core_V1_HealthHomeData, state: Centraid_Core_V1_HealthHomeState) -> some View {
        if home.hasEmpty {
            // NOT CONNECTED: one sentence and Connect, on every tab.
            EmptyStateView(home.empty, actionIdentifier: "health-connect-open") {
                open(home.connect)
            }
        } else {
            switch state.destination {
            case .trends: trends(home.trends)
            case .workouts: workouts(home.workouts, chrome: state.chrome)
            default: today(home.todayData)
            }
        }
    }

    /// THE SUMMARY: the pinned cards (the first two wide with a sparkline, the rest two to a row,
    /// one column at the largest text), the highlights, and today's workouts.
    @ViewBuilder
    private func today(_ today: Centraid_Core_V1_HealthTodayData) -> some View {
        let pinned = [today.hero] + today.metrics
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(today.metricsHeading)
                    .kitType(.section)
                    .foregroundStyle(Surface.ink)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                Text(today.metricsNote)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            }
            .padding(.horizontal, 4)
            ForEach(pinned.filter(\.wide), id: \.metric) { line in
                HealthPinnedCard(
                    line: line,
                    identifier: line.metric == "steps" ? "health-hero" : "health-metric-\(line.metric)"
                ) { open(line.route) }
            }
            KitCardGrid(items: pinned.filter { !$0.wide }, gap: 8) { line in
                HealthPinnedCard(line: line, identifier: "health-metric-\(line.metric)") { open(line.route) }
            }
        }
        if !today.highlights.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(today.highlightsHeading)
                    .kitType(.section)
                    .foregroundStyle(Surface.ink)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.horizontal, 4)
                ForEach(today.highlights, id: \.metric) { highlight in
                    HealthHighlightCard(highlight: highlight) { open(highlight.route) }
                }
            }
        }
        if !today.workoutsHeading.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(today.workoutsHeading)
                    .kitType(.section)
                    .foregroundStyle(Surface.ink)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.horizontal, 4)
                VStack(spacing: 0) {
                    ForEach(Array(today.workouts.enumerated()), id: \.offset) { index, row in
                        if index > 0 { KitHairline() }
                        HealthWorkoutRow(row: row) { open(row.route) }
                    }
                }
                .kitCard()
            }
        }
    }

    @ViewBuilder
    private func trends(_ trends: Centraid_Core_V1_HealthTrendsData) -> some View {
        if trends.hasEmpty {
            EmptyStateView(trends.empty)
        } else {
            HealthNote(text: trends.compareLine)
            ForEach(Array(trends.rows.enumerated()), id: \.offset) { _, row in
                trendRow(row)
            }
        }
    }

    private func trendRow(_ row: Centraid_Core_V1_HealthTrendRow) -> some View {
        Button { open(row.route) } label: {
            HealthCard {
                HStack(spacing: 14) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.label)
                            .kitType(.row)
                            .fontWeight(.semibold)
                            .foregroundStyle(accent.text)
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(row.value)
                                .font(.system(size: 22, weight: .bold))
                                .monospacedDigit()
                                .foregroundStyle(Surface.ink)
                            Text(row.unit)
                                .kitType(.meta)
                                .foregroundStyle(Surface.meta)
                        }
                        if !row.delta.isEmpty {
                            Text(row.delta)
                                .kitType(.meta)
                                .foregroundStyle(Surface.meta)
                        }
                    }
                    Spacer(minLength: 0)
                    HealthSparkline(points: row.pointsBp, average: row.averageBp)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("health-trend-\(row.metric)")
    }

    @ViewBuilder
    private func workouts(_ workouts: Centraid_Core_V1_HealthWorkoutsData, chrome: Centraid_Core_V1_HealthHomeChrome) -> some View {
        if workouts.hasEmpty {
            EmptyStateView(workouts.empty)
        } else {
            ForEach(Array(workouts.sections.enumerated()), id: \.offset) { _, section in
                VStack(alignment: .leading, spacing: 4) {
                    Text(section.heading)
                        .kitType(.group)
                        .foregroundStyle(Surface.meta)
                        .accessibilityAddTraits(.isHeader)
                    HealthCard(padding: 0) {
                        ForEach(Array(section.rows.enumerated()), id: \.offset) { index, row in
                            if index > 0 { KitHairline() }
                            HealthWorkoutRow(row: row) { open(row.route) }
                        }
                    }
                }
            }
            ShowMoreFooter(visible: workouts.more, label: chrome.showMore) { send(event { $0.showMore = .init() }) }
        }
    }

    // MARK: - Sheets

    private func sheetIsOpen(_ state: Centraid_Core_V1_HealthHomeState) -> Bool {
        switch state.sheet {
        case .more, .reads, .stop: return true
        default: return false
        }
    }

    @ViewBuilder
    private func sheetContent(_ state: Centraid_Core_V1_HealthHomeState) -> some View {
        let chrome = state.chrome
        let close = { send(event { $0.sheetClosed = .init() }) }
        switch state.sheet {
        case .more:
            OptionSheet(title: chrome.moreTitle) {
                ForEach(Array(state.moreRows.enumerated()), id: \.offset) { _, row in
                    let key = row.key
                    SheetRow(
                        iconKey: row.iconKey,
                        label: row.label,
                        destructive: row.tone == .net,
                        identifier: "health-more-\(key)"
                    ) {
                        // The sheet goes either way; a row with a route also opens its page.
                        send(event { $0.more = .with { $0.key = key } })
                        if row.hasRoute { open(row.route) }
                    }
                }
            }
        case .reads:
            SheetRoom(
                title: chrome.readsTitle,
                outlines: [SheetOutline(label: chrome.closeLabel, identifier: "health-reads-close", action: close)],
                titleIdentifier: "health-reads"
            ) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(state.readsFacts.enumerated()), id: \.offset) { _, fact in
                            FieldRow(key: fact.label, value: fact.detail)
                        }
                    }
                }
            }
        case .stop:
            ConfirmSheet(
                state.stop,
                cancelLabel: chrome.stopCancel,
                onConfirm: { send(event { $0.stop = .init() }) },
                onDismiss: close
            )
        default:
            EmptyView()
        }
    }
}
