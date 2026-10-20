import SwiftUI

import CentraidShared

/// `health.metric` — one metric over a week, a month or a year (#1129), on the kit.
///
/// **THE VIEW DECIDES NOTHING.** The segments, the caption, the average and its unit, the line
/// against the typical, every bar's height and which bar is the current one, the ticks, the facts
/// and the foot are `HealthMetricState`'s; this lays them out. The current bucket's bar is the
/// app's one hue mark (R-1129-10).
struct HealthMetricView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_HealthMetricState {
        (try? Centraid_Screen_V1_HealthMetricState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_HealthMetricEvent) -> Void) -> Data {
        healthEvent(Centraid_Screen_V1_HealthMetricEvent.self, build)
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
    }

    @ViewBuilder
    private func page(_ metric: Centraid_Screen_V1_HealthMetricData) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(metric.caption)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(metric.average)
                    .centraidType("display")
                    .monospacedDigit()
                    .foregroundStyle(Theme.color("text", scheme))
                Text(metric.averageUnit)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            if !metric.versus.isEmpty {
                Text(metric.versus)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
        }
        .accessibilityElement(children: .combine)
        HealthCard {
            HealthBarChart(data: metric)
        }
        if !metric.facts.isEmpty {
            HealthCard(padding: 0) {
                ForEach(Array(metric.facts.enumerated()), id: \.offset) { index, fact in
                    if index > 0 { KitHairline() }
                    HealthFactRow(label: fact.label, detail: fact.detail)
                }
            }
        }
        HealthNote(text: metric.foot)
    }
}
