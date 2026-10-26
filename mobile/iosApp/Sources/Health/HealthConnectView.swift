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

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_HealthConnectEvent) -> Void) -> Centraid_Core_V1_HealthConnectEvent {
        var event = Centraid_Core_V1_HealthConnectEvent()
        build(&event)
        return event
    }

    var body: some View {
        let state = state
        PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(state.headline)
                            .centraidType("display")
                            .foregroundStyle(Theme.color("text", scheme))
                            .accessibilityAddTraits(.isHeader)
                        Text(state.lede)
                            .centraidType("body")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(state.choicesTitle)
                            .centraidType("eyebrow")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .accessibilityAddTraits(.isHeader)
                        HealthCard(padding: 0) {
                            ForEach(Array(state.choices.enumerated()), id: \.offset) { index, choice in
                                if index > 0 { KitHairline() }
                                choiceRow(choice, working: state.working)
                            }
                        }
                    }
                    HealthNote(text: state.note)
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
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textSoft", scheme))
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
                .background(Theme.color("bg", scheme).ignoresSafeArea(edges: .bottom))
            }
        }
        // CONNECTED: Rust says the page is done.
        .onChange(of: state.finished) { _, finished in
            if finished { onBack() }
        }
    }

    /// ONE TYPE: its name over what it is, and the check that says whether Health may read it.
    private func choiceRow(_ choice: Centraid_Core_V1_HealthChoice, working: Bool) -> some View {
        let key = choice.key
        let toggle = { send(event { $0.toggled = .with { $0.key = key } }) }
        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(choice.label)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                Text(choice.detail)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture(perform: toggle)
            .accessibilityHidden(true)
            KitCheckBox(checked: choice.on, label: choice.label, identifier: "health-choice-\(key)", action: toggle)
        }
        .padding(.leading, 16)
        .padding(.trailing, 4)
        .padding(.vertical, 4)
        .frame(minHeight: 52)
        .disabled(working)
    }
}
