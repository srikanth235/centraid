import SwiftUI

// ONBOARDING WITHOUT SAMPLE DATA: what a made vault imports is asked at the point of use, and what came
// in is one line (`imports.made`). This is the shell's half: the banner it draws.

/// THE IMPORT'S STATUS LINE (product-intuition/references/design-behaviour.md § Status line
/// channel … docked to the bottom of the frame … no floating overlay, no
/// auto-dismiss"): what a made vault brought in (`imports.made`, Rust's line),
/// above the band, on Home and on every app. One fragment, at most one action
/// ("Open People", which takes the member to what came in), and a close key once
/// the work is done. It never clears on a timer: the close key, the action or the
/// member's next move puts it away (`ShellModel.importLineMoved`).
struct ShellBanner: View {
    @ObservedObject var shell: ShellModel
    @ObservedObject var store: ScreenStore
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// "Include completed reminders": the member's option for the reminders import, kept here
    /// until they tap the import (it travels with that tap, Rust holds none of it before).
    @State private var includeCompleted = false

    /// The line, unless the member put it away.
    private var line: Centraid_Core_V1_ImportsMadeState? {
        guard let line = store.madeLine, !line.summary.isEmpty, line.summary != shell.importLinePutAway else { return nil }
        return line
    }

    /// THE CHIP'S WORDS DO NOT SHRINK: when the chip and the verb do not fit one line the verb
    /// goes under it, never past the edge.
    @ViewBuilder
    private func remindersRow(_ line: Centraid_Core_V1_ImportsMadeState) -> some View {
        let chip = KitChip(
            label: line.completedLabel,
            selected: includeCompleted,
            identifier: "import-completed-toggle"
        ) {
            includeCompleted.toggle()
        }
        let verb = KitLink(label: line.remindersLabel, identifier: "import-reminders") {
            var request = Centraid_Core_V1_ImportsMadeEvent()
            request.remindersRequested = .with { $0.includeCompleted = includeCompleted }
            store.sendRoot(RustScreens.madeTab, .importsMade(request))
        }
        let hasChip = !line.completedLabel.isEmpty
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                if hasChip { chip }
                Spacer(minLength: 0)
                verb
            }
            VStack(alignment: .leading, spacing: 0) {
                if hasChip { chip }
                verb
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    var body: some View {
        let line = line
        VStack(spacing: 0) {
            if let line {
                VStack(spacing: 0) {
                    KitHairline()
                    ProgressStatusLine(
                        sentence: line.summary,
                        actionLabel: line.running ? "" : line.openLabel,
                        onAct: {
                            shell.putImportLineAway(line.summary)
                            if line.hasOpenRoute { shell.open(line.openRoute) }
                        },
                        closeLabel: line.running ? "" : KitWords.DISMISS,
                        onClose: { shell.putImportLineAway(line.summary) },
                        identifier: "import",
                        leadingIcon: line.running ? "" : "Check"
                    )
                    // THE ACTION WEARS THE COLOUR OF THE APP IT OPENS ("Open People" is People's).
                    .environment(\.appAccent, AppAccent(line.hasOpenRoute ? String(line.openRoute.screen.split(separator: ".").first ?? "") : ""))
                    // THE REMINDERS IMPORT (iOS), offered once the made vault's imports are over:
                    // the option and the verb are Rust's words, the tap asks the OS and imports.
                    if !line.running, !line.remindersLabel.isEmpty {
                        remindersRow(line)
                            .padding(.horizontal, CentraidGeometry.pageMargin)
                    }
                }
                .background(Theme.color("bg", scheme))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("import-banner")
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
        }
        // ENTRY AND SETTLE AT 280MS, a change of words at 140 (design/tokens.toml (motion)).
        .animation(reduceMotion ? nil : .easeOut(duration: 0.28), value: line == nil)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: line?.summary ?? "")
    }
}

/// THE IMPORT LINE ON A PUSHED PAGE: handed to `AppPlace`, which draws it above
/// its band; a page with no `AppPlace` (a row's page, an editor) gets it docked
/// at its own foot instead, so it is in the same place everywhere.
struct ShellLineHost: ViewModifier {
    @ObservedObject var shell: ShellModel
    @State private var placeDraws = false

    @ViewBuilder
    func body(content: Content) -> some View {
        if let store = shell.screens {
            content
                .environment(\.shellStatusLine, AnyView(ShellBanner(shell: shell, store: store)))
                .onPreferenceChange(PlaceDrawsShellLine.self) { placeDraws = $0 }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if !placeDraws { ShellBanner(shell: shell, store: store) }
                }
        } else {
            content
        }
    }
}
