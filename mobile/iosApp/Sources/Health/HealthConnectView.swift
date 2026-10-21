import SwiftUI

import CentraidShared

/// `health.connect` — what Health may read, and the one Ink button (#1129), on the kit.
///
/// **THE VIEW DECIDES NOTHING.** The headline, the lede, a switch a type with its words, the
/// note, the button's label and whether it is live, and the status line are
/// `HealthConnectState`'s. The tap sends `ConnectTapped`; asking the OS — for exactly
/// `HealthConnectState.chosen`, read only — and telling the vault are the shell's
/// (`HealthScreens.routeIntent`, `ShellModel.connectHealth`). Nothing is ever written back
/// (R-1129-7).
struct HealthConnectView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_HealthConnectState {
        (try? Centraid_Screen_V1_HealthConnectState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_HealthConnectEvent) -> Void) -> Data {
        healthEvent(Centraid_Screen_V1_HealthConnectEvent.self, build)
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
    }

    /// ONE TYPE: its name over what it is, and the check that says whether Health may read it.
    private func choiceRow(_ choice: Centraid_Screen_V1_HealthChoice, working: Bool) -> some View {
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
