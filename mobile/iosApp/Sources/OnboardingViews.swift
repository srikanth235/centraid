import SwiftUI

// ONBOARDING WITHOUT SAMPLE DATA (docs/decisions.md, "Onboarding without sample
// data"): what a made vault imports is asked at the point of use, and what came
// in is one line (`imports.made`). This is the shell's half: the banner it draws.

/// THE IMPORT'S STATUS LINE (DESIGN.md: "`StatusLine` is the one feedback
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

    /// The line, unless the member put it away.
    private var line: Centraid_Core_V1_ImportsMadeState? {
        guard let line = store.madeLine, !line.summary.isEmpty, line.summary != shell.importLinePutAway else { return nil }
        return line
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
                        identifier: "import"
                    )
                }
                .background(Theme.color("bg", scheme))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("import-banner")
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
        }
        // ENTRY AND SETTLE AT 280MS, a change of words at 140 (DESIGN.md's one motion grammar).
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
