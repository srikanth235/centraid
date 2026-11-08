import SwiftUI

/// THE EDITOR'S STATUS LINE, from the machine's `Autosave` (K5; #1015 D3).
///
/// There is no Save button, so this line is the member's only answer to "are
/// my words safe": saved, saving, edited and not yet sent, refused (with the
/// refusal's own sentence — the words stay in the editor), or changed
/// elsewhere. It reads the law's words and `refused`, and never guesses either.
///
/// `SAVE_STATE_QUEUED` is gone with the explicit save: nothing under autosave
/// produces a queued phase, so there is no "Waiting for your gateway" here.
struct AutosaveStatus: View {
    let autosave: Centraid_Core_V1_Autosave
    /// In the bar's trailing slot ("Done | Edit person | Saved"): the words at their own width.
    var inline = false

    @Environment(\.colorScheme) private var scheme

    init(_ autosave: Centraid_Core_V1_Autosave, inline: Bool = false) {
        self.autosave = autosave
        self.inline = inline
    }

    /// The words, for the view and for a test: the machine's own
    /// (`Autosave.label`, set by the kit's law with every phase — #1047).
    static func label(_ autosave: Centraid_Core_V1_Autosave) -> String {
        autosave.label
    }

    /// A refusal inks `net` (`Autosave.refused`, the law's say; the conflict
    /// phase nothing reaches says nothing more).
    private var tone: String { autosave.refused ? "net" : "textFaint" }

    var body: some View {
        let label = Self.label(autosave)
        Text(label.isEmpty ? " " : label)
            .centraidType("annotLabel")
            .foregroundStyle(Theme.color(tone, scheme))
            .frame(maxWidth: inline ? nil : .infinity, alignment: inline ? .trailing : .leading)
            .fixedSize(horizontal: inline, vertical: false)
            .accessibilityIdentifier("kit-autosave-status")
            .accessibilityHidden(label.isEmpty)
    }
}
