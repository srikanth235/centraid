import SwiftUI

import CentraidShared

// ONBOARDING WITHOUT SAMPLE DATA (docs/decisions.md, "Onboarding without sample
// data"): where the phone already holds an app's data, its day-one empty state
// offers a one-tap import asked at the point of use. These are the shell's
// halves: the environment door the kit's `EmptyStateView` reads, the banner the
// import draws.

/// THE IMPORT'S STATUS LINE (DESIGN.md: "`StatusLine` is the one feedback
/// channel … docked to the bottom of the frame … no floating overlay, no
/// auto-dismiss"): an import's progress and outcome, above the band, on Home
/// and on every app. One fragment, at most one action ("Open People", which
/// takes the member to what came in), and a close key once the work is done.
/// It never clears on a timer: the close key, the action or the member's next
/// move puts it away (`ShellModel.importLineMoved`).
struct ShellBanner: View {
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            if !shell.importNotice.isEmpty {
                VStack(spacing: 0) {
                    KitHairline()
                    ProgressStatusLine(
                        sentence: shell.importNotice,
                        actionLabel: shell.importing ? "" : PhoneImport.shared.openLabel(app: shell.importOpens),
                        onAct: { shell.openImported() },
                        closeLabel: shell.importing ? "" : KitWords.shared.DISMISS,
                        onClose: { shell.dismissImportNotice() },
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
        .animation(reduceMotion ? nil : .easeOut(duration: 0.28), value: shell.importNotice.isEmpty)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: shell.importNotice)
    }
}

/// THE IMPORT LINE ON A PUSHED PAGE: handed to `AppPlace`, which draws it above
/// its band; a page with no `AppPlace` (a row's page, an editor) gets it docked
/// at its own foot instead, so it is in the same place everywhere.
struct ShellLineHost: ViewModifier {
    @ObservedObject var shell: ShellModel
    @State private var placeDraws = false

    func body(content: Content) -> some View {
        content
            .environment(\.shellStatusLine, AnyView(ShellBanner(shell: shell)))
            .onPreferenceChange(PlaceDrawsShellLine.self) { placeDraws = $0 }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !placeDraws { ShellBanner(shell: shell) }
            }
    }
}

/// THE QUESTION A HELD ACCOUNT OR CALENDAR LEAVES (R-1127-9), in the kit's
/// `ConfirmSheet` (DESIGN.md: a destructive confirm is never an alert). The
/// shared question chose every word and built the confirm: Move to trash is
/// its destructive verb, and KEEP, THE DEFAULT, is the sheet's cancel and what
/// a swipe away means.
struct PhoneFollowQuestionHost: ViewModifier {
    @ObservedObject var shell: ShellModel

    /// One sheet per question: a second question is a new sheet, not the first one's words swapped.
    private struct Asked: Identifiable {
        let question: PhoneFollowQuestion
        var id: String { question.originId }
    }

    func body(content: Content) -> some View {
        content.sheet(item: Binding(
            get: { shell.followQuestion.map(Asked.init) },
            set: { if $0 == nil, shell.followQuestion != nil { shell.answerFollowQuestion(keep: true) } }
        )) { asked in
            ConfirmSheet(
                (try? Centraid_Screen_V1_Confirm(serializedBytes: asked.question.confirmBytes.data)) ?? .init(),
                cancelLabel: asked.question.keepLabel,
                onConfirm: { shell.answerFollowQuestion(keep: false) },
                onDismiss: { shell.answerFollowQuestion(keep: true) }
            )
        }
    }
}
