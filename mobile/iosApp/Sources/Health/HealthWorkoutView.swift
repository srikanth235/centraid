import SwiftUI

import CentraidShared

/// `health.workout` — one workout (#1129), on the kit.
///
/// **THE VIEW DECIDES NOTHING.** The kind, the title, when, each figure the store measured with
/// its unit, and the foot that says who recorded it and where it was read from are
/// `HealthWorkoutState`'s. Splits stay on the phone (R-1129-9). A workout no longer in the vault
/// is the state's `gone`.
struct HealthWorkoutView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_HealthWorkoutState {
        (try? Centraid_Screen_V1_HealthWorkoutState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_HealthWorkoutEvent) -> Void) -> Data {
        healthEvent(Centraid_Screen_V1_HealthWorkoutEvent.self, build)
    }

    private let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]

    var body: some View {
        let state = state
        PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            ReadStateView(
                content: state.readContent,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { workout in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if workout.hasGone {
                            EmptyStateView(workout.gone)
                        } else {
                            page(workout)
                        }
                    }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.top, 4)
                    .padding(.bottom, 24)
                }
                .refreshable { send(event { $0.refreshed = .init() }) }
                .accessibilityIdentifier("health-workout-page")
            }
        }
    }

    @ViewBuilder
    private func page(_ workout: Centraid_Screen_V1_HealthWorkoutData) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(workout.kindLabel)
                .centraidType("eyebrow")
                .foregroundStyle(Theme.color("textSoft", scheme))
            Text(workout.title)
                .centraidType("display")
                .foregroundStyle(Theme.color("text", scheme))
                .accessibilityAddTraits(.isHeader)
            Text(workout.whenLabel)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
        }
        .accessibilityElement(children: .combine)
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
            ForEach(Array(workout.figures.enumerated()), id: \.offset) { _, figure in
                HealthCard(padding: 14) {
                    Text(figure.label)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(figure.value)
                            .centraidType("title")
                            .monospacedDigit()
                            .foregroundStyle(Theme.color("text", scheme))
                        Text(figure.unit)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    }
                    .padding(.top, 2)
                }
                .accessibilityElement(children: .combine)
            }
        }
        HealthNote(text: workout.foot)
    }
}
