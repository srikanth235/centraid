import SwiftUI

/// `health.metric` — one metric over a week, a month, 6 months or a year (#1129, #1135, #1173), on
/// the kit, on a plain page.
///
/// **THE VIEW DECIDES NOTHING.** The segments, the average's label and figure, the caption, the line
/// against the typical, every bar's height and callout, the usual range, the ticks, the facts and
/// the "About" paragraph are `HealthMetricState`'s (Rust makes them: `crates/screens`, module
/// `health`); this lays them out. The scrubber's finger is the chart's own state.
struct HealthMetricView: View {
    let state: Centraid_Core_V1_HealthMetricState
    let send: (Centraid_Core_V1_HealthMetricEvent) -> Void
    let onBack: () -> Void

    private func event(_ build: (inout Centraid_Core_V1_HealthMetricEvent) -> Void) -> Centraid_Core_V1_HealthMetricEvent {
        var event = Centraid_Core_V1_HealthMetricEvent()
        build(&event)
        return event
    }

    var body: some View {
        let state = state
        PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            ReadStateView(
                content: state.readContent,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { metric in
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if !state.segments.isEmpty {
                            KitSegmented(
                                options: state.segments.map { (key: $0.key, label: $0.label) },
                                selected: state.segments.first(where: \.active)?.key ?? "",
                                identifier: "health-metric-range",
                                fills: true,
                                onSelect: { key in send(event { $0.range = .with { $0.key = key } }) }
                            )
                            .frame(maxWidth: .infinity)
                        }
                        if metric.hasEmpty {
                            EmptyStateView(metric.empty)
                        } else {
                            page(metric)
                        }
                    }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.top, 8)
                    .padding(.bottom, 32)
                }
                .refreshable { send(event { $0.refreshed = .init() }) }
                .accessibilityIdentifier("health-metric-page")
            }
        }
        .background(Surface.plainPage.ignoresSafeArea())
        .appAccent("health")
    }

    @ViewBuilder
    private func page(_ metric: Centraid_Core_V1_HealthMetricData) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(metric.averageLabel)
                .kitType(.group)
                .foregroundStyle(Surface.meta)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(metric.average)
                    .monospacedDigit()
                    .kitScaledFont(36, weight: .bold)
                    .foregroundStyle(Surface.ink)
                Text(metric.averageUnit)
                    .kitType(.row)
                    .foregroundStyle(Surface.meta)
            }
            Text(metric.caption)
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
            if !metric.versus.isEmpty {
                Text(metric.versus)
                    .kitType(.meta)
                    .foregroundStyle(metric.versusGood ? StateColor.green.text : Surface.meta)
                    .padding(.top, 2)
                    .accessibilityIdentifier("health-metric-versus")
            }
        }
        .accessibilityElement(children: .combine)
        HealthBarChart(data: metric)
        if !metric.facts.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(metric.facts.enumerated()), id: \.offset) { index, fact in
                    if index > 0 { KitHairline() }
                    HealthFactRow(label: fact.label, detail: fact.detail)
                }
            }
            .kitBorderedCard()
        }
        VStack(alignment: .leading, spacing: 4) {
            Text(metric.aboutHeading)
                .kitType(.row)
                .fontWeight(.semibold)
                .foregroundStyle(Surface.ink)
                .accessibilityAddTraits(.isHeader)
            HealthNote(text: metric.foot)
        }
        .padding(.horizontal, 4)
    }
}
