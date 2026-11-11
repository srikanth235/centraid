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
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void
    let onPhoneSays: (Centraid_Core_V1_PhoneSaysTaken) -> Void

    private let accent = AppAccent("health")

    @Environment(\.colorScheme) private var scheme

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
            VStack(spacing: 0) {
            // THE PAGE'S STATUS LINE (a refused write says so here), as Trash's does: above the
            // page, so "{title} moved to trash" with Undo (#1185) shows over the gone page too.
            if state.hasStatus {
                StatusLineView(status: state.status, identifier: "health-status-action") {
                    send(event { $0.statusActed = .init() })
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 4)
            }
            PageReadStateView(
                page: state.page,
                onRetry: { send(event { $0.refreshed = .init() }) }
            ) {
                let workout = state.data
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        VStack(alignment: .leading, spacing: 16) {
                            page(workout)
                        }
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.top, 4)
                        // LINKED TO (#1185): the kit's section, after the foot; Rust makes every word and row.
                        if workout.hasLinks {
                            LinkSectionView(section: workout.links, send: { link in
                                send(event { $0.link = link })
                            }, open: open)
                        }
                        // EVERY RECORD KEEPS ITS EARLIER VALUES (#1185): the last content row; Move to trash is pinned below.
                        EarlierEntryRow(entry: state.hasEarlier ? state.earlier : nil, open: open)
                        OriginLineView(line: state.hasOrigin ? state.origin : nil)
                    }
                    .padding(.bottom, 24)
                }
                .refreshable { send(event { $0.refreshed = .init() }) }
                .accessibilityIdentifier("health-workout-page")
                // MOVE TO TRASH, pinned at the foot as HealthWorkout.dc.html draws it: outlined and
                // destructive, asking nothing (the status line carries Undo). Empty while gone.
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if !workout.trashLabel.isEmpty {
                        KitChoiceStack {
                            if !workout.shareLabel.isEmpty {
                                KitOutlineButton(label: workout.shareLabel) {
                                    send(event { $0.shareRequested = .init() })
                                }
                                .accessibilityIdentifier("health-action-share")
                            }
                            KitOutlineButton(label: workout.trashLabel, tone: "net") {
                                send(event { $0.trash = .init() })
                            }
                            .accessibilityIdentifier("health-action-trash")
                        }
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.vertical, 8)
                        .background(Theme.color("bg", scheme))
                    }
                }
            }
            }
        }
        .linkPickerSheet(state.linkPicker) { link in send(event { $0.link = link }) }
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
                        .monospacedDigit()
                        .kitScaledFont(28, weight: .bold)
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
