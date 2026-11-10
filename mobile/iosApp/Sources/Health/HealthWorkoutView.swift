import SwiftUI

/// `health.workout` — one workout (#1129, #1135), on the kit.
///
/// **THE VIEW DECIDES NOTHING.** The kind, the title, when, each figure the store measured with
/// its unit, and the foot that says who recorded it and where it was read from are
/// `HealthWorkoutState`'s (Rust makes them: `crates/screens`, module `health`). Splits stay on
/// the phone (R-1129-9). A workout no longer in the vault is the state's `gone`.
struct HealthWorkoutView: View {
    let state: Centraid_Core_V1_HealthWorkoutState
    let send: (Centraid_Core_V1_HealthWorkoutEvent) -> Void
    let onBack: () -> Void
    let onPhoneSays: (Centraid_Core_V1_PhoneSaysTaken) -> Void

    private let accent = AppAccent("health")

    private func event(_ build: (inout Centraid_Core_V1_HealthWorkoutEvent) -> Void) -> Centraid_Core_V1_HealthWorkoutEvent {
        var event = Centraid_Core_V1_HealthWorkoutEvent()
        build(&event)
        return event
    }

    var body: some View {
        let state = state
        // THE BOARD HAS NO BAR TITLE: the kind is the chip over the page's own title.
        PushedPage(title: "", parentTitle: state.chrome.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            ReadStateView(
                content: state.readContent,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) { workout in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        // THE PAGE'S STATUS LINE (a refused write says so here), as Trash's does.
                        if state.hasStatus {
                            StatusLineView(status: state.status, identifier: "health-workout-status") {}
                        }
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
        .appAccent("health")
    }

    @ViewBuilder
    private func page(_ workout: Centraid_Core_V1_HealthWorkoutData) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            // THE KIND IS A CHIP (HealthWorkout): the kind's mark and word on the app's pale tile.
            HStack(spacing: 6) {
                if !workout.kindIconKey.isEmpty {
                    CentraidIconView(iconKey: workout.kindIconKey, tint: accent.text, size: 14)
                        .accessibilityHidden(true)
                }
                Text(workout.kindLabel)
                    .kitType(.meta)
                    .fontWeight(.semibold)
                    .foregroundStyle(accent.text)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(accent.tint ?? accent.wash(dark: false)))
            .padding(.bottom, 6)
            Text(workout.title)
                .kitType(.title)
                .foregroundStyle(Surface.ink)
                .accessibilityAddTraits(.isHeader)
            Text(workout.whenLabel)
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
        }
        .accessibilityElement(children: .combine)
        // The figures are cards two to a row, one column at the largest text.
        KitCardGrid(items: workout.figures.enumerated().map { HealthFigureItem(index: $0.offset, figure: $0.element) }, gap: 8) { item in
            VStack(alignment: .leading, spacing: 2) {
                Text(item.figure.label)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(item.figure.value)
                        .font(.system(size: 28, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(Surface.ink)
                    Text(item.figure.unit)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .kitCard()
            .accessibilityElement(children: .combine)
        }
        PhoneSaysLines(lines: workout.figuresPhoneSays, padded: false, onTake: onPhoneSays)
        HealthNote(text: workout.foot)
    }
}

private struct HealthFigureItem: Identifiable {
    let index: Int
    let figure: Centraid_Core_V1_HealthFigure
    var id: Int { index }
}
