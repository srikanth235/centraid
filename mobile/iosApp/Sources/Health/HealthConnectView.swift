import SwiftUI

/// `health.connect` — what Health may read, and the one Ink button (#1129, #1135), on the kit.
///
/// **THE VIEW DECIDES NOTHING.** The headline, the lede, a switch a type with its words, the
/// note, the button's label and whether it is live, and the status line are
/// `HealthConnectState`'s (Rust makes them: `crates/screens`, module `health`). The tap sends
/// `ConnectTapped`; Rust asks the shell to read the store (`HealthRead`, with the member's tap
/// as the one place the OS is asked — for exactly the chosen types, read only), writes the
/// store's origin and runs the first pass. A connected page is `finished`, and the shell pops
/// it. Nothing is ever written back to the store (R-1129-7).
struct HealthConnectView: View {
    let state: Centraid_Core_V1_HealthConnectState
    let send: (Centraid_Core_V1_HealthConnectEvent) -> Void
    let onBack: () -> Void

    private let accent = AppAccent("health")
    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_HealthConnectEvent) -> Void) -> Centraid_Core_V1_HealthConnectEvent {
        var event = Centraid_Core_V1_HealthConnectEvent()
        build(&event)
        return event
    }

    var body: some View {
        let state = state
        PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack, showsTitle: true) {
            EmptyView()
        } content: {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .top, spacing: 14) {
                        CentraidIconView(iconKey: "Heart", tint: accent.text, size: 22, solid: true)
                            .frame(width: 44, height: 44)
                            .background(accent.wash(dark: scheme == .dark), in: RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(state.headline)
                                .kitType(.row)
                                .fontWeight(.semibold)
                                .foregroundStyle(Surface.ink)
                                .accessibilityAddTraits(.isHeader)
                            Text(state.lede)
                                .kitType(.meta)
                                .foregroundStyle(Surface.body)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .kitCard()
                    VStack(alignment: .leading, spacing: 6) {
                        Text(state.choicesTitle)
                            .kitType(.group)
                            .foregroundStyle(Surface.meta)
                            .accessibilityAddTraits(.isHeader)
                            .padding(.horizontal, 16)
                        VStack(spacing: 0) {
                            ForEach(Array(state.choices.enumerated()), id: \.offset) { index, choice in
                                if index > 0 { KitHairline() }
                                choiceRow(choice, working: state.working)
                            }
                        }
                        .kitCard()
                    }
                    HealthNote(text: state.note).padding(.horizontal, 16)
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 8)
                .padding(.bottom, 16)
            }
            .accessibilityIdentifier("health-connect-page")
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    if !state.status.isEmpty {
                        Text(state.status)
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                            .accessibilityIdentifier("health-connect-status")
                    }
                    KitInkButton(label: state.connectLabel, identifier: "health-connect") {
                        send(event { $0.connect = .init() })
                    }
                    .disabled(!state.canConnect)
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 8)
                .padding(.bottom, 12)
                .background(Surface.page.ignoresSafeArea(edges: .bottom))
            }
        }
        .appAccent("health")
        // CONNECTED: Rust says the page is done.
        .onChange(of: state.finished) { _, finished in
            if finished { onBack() }
        }
    }

    /// ONE TYPE: its name over what it is, and the switch that says whether Health may read it.
    private func choiceRow(_ choice: Centraid_Core_V1_HealthChoice, working: Bool) -> some View {
        let key = choice.key
        let on = Binding(
            get: { choice.on },
            set: { _ in send(event { $0.toggled = .with { $0.key = key } }) }
        )
        return Toggle(isOn: on) {
            VStack(alignment: .leading, spacing: 2) {
                Text(choice.label)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                Text(choice.detail)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            }
        }
        .tint(accent.fill)
        .accessibilityIdentifier("health-choice-\(key)")
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(minHeight: 52)
        .disabled(working)
    }
}
