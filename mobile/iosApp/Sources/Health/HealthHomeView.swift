import SwiftUI

import CentraidShared

/// `health.home` — Today · Trends · Workouts, More a sheet (#1129, #1135), on the kit.
///
/// **THE VIEW DECIDES NOTHING.** `HealthHomeState` carries the band, the segments, the chips,
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

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_HealthHomeEvent) -> Void) -> Centraid_Core_V1_HealthHomeEvent {
        var event = Centraid_Core_V1_HealthHomeEvent()
        build(&event)
        return event
    }

    var body: some View {
        let state = state
        let content = state.readContent
        let chrome = state.chrome
        let chips: [RoomChip] = content.isDenied ? [] : state.chips.map { chip in
            let key = chip.key
            return RoomChip(
                identifier: "health-chip-\(key.isEmpty ? "all" : key)",
                label: chip.label,
                selected: chip.active,
                action: { send(event { $0.kindPicked = .with { $0.kindConceptID = key } }) }
            )
        }
        AppPlace(
            app: AppIds.shared.HEALTH,
            title: chrome.title,
            trailing: nil,
            chips: chips,
            showsBand: !content.isDenied && !state.band.isEmpty
        ) {
            AppBand(
                app: AppIds.shared.HEALTH,
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
                StatusLineView(status: state.status.legacy, identifier: "health-status-action") {}
            }
        }
        .sheet(isPresented: healthSheetBinding(sheetIsOpen(state)) { send(event { $0.sheetClosed = .init() }) }) {
            sheetContent(state)
        }
    }

    private func segments(_ segments: [Centraid_Core_V1_HealthChip]) -> some View {
        KitSegmented(
            options: segments.map { (key: $0.key, label: $0.label) },
            selected: segments.first(where: \.active)?.key ?? "",
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
            EmptyStateView(home.empty.legacy, actionIdentifier: "health-connect-open") {
                open(home.connect)
            }
        } else {
            if !home.dayLabel.isEmpty, state.destination == .today {
                Text(home.dayLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            switch state.destination {
            case .trends: trends(home.trends)
            case .workouts: workouts(home.workouts, chrome: state.chrome)
            default: today(home.todayData)
            }
        }
    }

    @ViewBuilder
    private func today(_ today: Centraid_Core_V1_HealthTodayData) -> some View {
        hero(today.hero)
        if !today.metrics.isEmpty {
            HealthCard(padding: 0) {
                if !today.metricsHeading.isEmpty {
                    Text(today.metricsHeading)
                        .centraidType("eyebrow")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .accessibilityAddTraits(.isHeader)
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                }
                ForEach(Array(today.metrics.enumerated()), id: \.offset) { index, line in
                    if index > 0 { KitHairline() }
                    HealthMetricLineView(line: line) { open(line.route) }
                }
            }
        }
        if !today.workoutsHeading.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(today.workoutsHeading)
                    .centraidType("eyebrow")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .accessibilityAddTraits(.isHeader)
                HealthCard(padding: 0) {
                    ForEach(Array(today.workouts.enumerated()), id: \.offset) { index, row in
                        if index > 0 { KitHairline() }
                        HealthWorkoutRow(row: row) { open(row.route) }
                    }
                }
            }
        }
        HealthNote(text: today.foot)
            .accessibilityIdentifier("health-today-foot")
    }

    /// STEPS, DRAWN LARGE: the figure, when, the typical, and the day on the member's own range.
    private func hero(_ hero: Centraid_Core_V1_HealthMetricLine) -> some View {
        Button { open(hero.route) } label: {
            HealthCard(padding: 20) {
                HStack(alignment: .firstTextBaseline) {
                    Text(hero.label)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                    Spacer(minLength: 8)
                    Text(hero.whenLabel)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(hero.value)
                        .centraidType("display")
                        .monospacedDigit()
                        .foregroundStyle(Theme.color("text", scheme))
                    if !hero.unit.isEmpty {
                        Text(hero.unit)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    }
                }
                .padding(.top, 4)
                if !hero.typical.isEmpty {
                    Text(hero.typical)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                if hero.hasBar {
                    HealthRangeBarView(bar: hero.bar, hero: true).padding(.top, 16)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(hero.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("health-hero")
    }

    @ViewBuilder
    private func trends(_ trends: Centraid_Core_V1_HealthTrendsData) -> some View {
        if trends.hasEmpty {
            EmptyStateView(trends.empty.legacy)
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
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("text", scheme))
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(row.value)
                                .centraidType("title")
                                .monospacedDigit()
                                .foregroundStyle(Theme.color("text", scheme))
                            Text(row.unit)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                        }
                        if !row.delta.isEmpty {
                            Text(row.delta)
                                .centraidType("annotLabelOn")
                                .foregroundStyle(Theme.color("textSoft", scheme))
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
            EmptyStateView(workouts.empty.legacy)
        } else {
            ForEach(Array(workouts.sections.enumerated()), id: \.offset) { _, section in
                VStack(alignment: .leading, spacing: 4) {
                    Text(section.heading)
                        .centraidType("eyebrow")
                        .foregroundStyle(Theme.color("textSoft", scheme))
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
                state.stop.legacy,
                cancelLabel: chrome.stopCancel,
                onConfirm: { send(event { $0.stop = .init() }) },
                onDismiss: close
            )
        default:
            EmptyView()
        }
    }
}
