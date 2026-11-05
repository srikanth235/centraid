import SwiftUI

/// One native welcome page. Rust supplies every word and both routes; making a
/// vault and restoring remain explicit actions, never a step in a feature tour.
struct FirstLaunchView: View {
    let gate: Centraid_Core_V1_HomeFirstLaunch
    @ObservedObject var store: ScreenStore
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                CentraidBrandMark(size: 104)
                    .padding(.top, 36)
                VStack(spacing: 8) {
                    Text(gate.title)
                        .centraidType("display")
                        .foregroundStyle(Theme.color("text", scheme))
                        .accessibilityAddTraits(.isHeader)
                    Text(gate.body)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 22) {
                    ForEach(Array(gate.slides.enumerated()), id: \.offset) { index, feature in
                        HStack(alignment: .top, spacing: 16) {
                            CentraidIconView(iconKey: feature.iconKey, tint: Theme.color("shellText", scheme), size: 20)
                                .frame(width: 40, height: 40)
                                .background(Theme.color("shellTint", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(feature.title)
                                    .centraidType("bodyStrong")
                                    .foregroundStyle(Theme.color("text", scheme))
                                Text(feature.body)
                                    .centraidType("body")
                                    .foregroundStyle(Theme.color("textSoft", scheme))
                            }
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("first-launch-feature-\(index)")
                    }
                }
                .padding(.vertical, 12)
                WordsControls(
                    primary: gate.makeLabel,
                    primaryEnabled: true,
                    secondary: gate.restoreLabel,
                    prefix: "first-launch",
                    onPrimary: { store.sendHome(.make(.init())) },
                    onSecondary: { store.sendHome(.restore(.init())) }
                )
                .padding(.top, 12)
            }
            .padding(.horizontal, 32)
            .padding(.bottom, 32)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.color("bgList", scheme).ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .accessibilityIdentifier("first-launch")
    }
}

/// The core has not read the shelf yet; do not claim that it is empty.
struct BarePaper: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Theme.color("bg", scheme).ignoresSafeArea()
    }
}
