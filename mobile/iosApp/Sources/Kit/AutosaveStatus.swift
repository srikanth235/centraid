import SwiftUI

/// THE EDITOR'S STATUS LINE, from the machine's `Autosave` (K5; #1015 D3).
///
/// There is no Save button, so this line is the member's only answer to "are
/// my words safe": saved, saving, edited and not yet sent, refused (with the
/// refusal's own sentence — the words stay in the editor), or changed
/// elsewhere. It reads the phase and never guesses one.
///
/// `SAVE_STATE_QUEUED` is gone with the explicit save: nothing under autosave
/// produces a queued phase, so there is no "Waiting for your gateway" here.
struct AutosaveStatus: View {
    let autosave: Centraid_Screen_V1_Autosave

    @Environment(\.colorScheme) private var scheme

    init(_ autosave: Centraid_Screen_V1_Autosave) { self.autosave = autosave }

    /// The words, for the view and for a test.
    static func label(_ autosave: Centraid_Screen_V1_Autosave) -> String {
        switch autosave.phase {
        case .clean, .saved: return "Saved"
        case .dirty: return "Edited"
        case .saving: return "Saving\u{2026}"
        case .refused:
            return autosave.hasFailure && !autosave.failure.sentence.isEmpty
                ? autosave.failure.sentence
                : "Not saved"
        case .conflict: return "Changed on another device"
        case .unspecified, .UNRECOGNIZED: return ""
        }
    }

    private var tone: String {
        switch autosave.phase {
        case .refused, .conflict: return "net"
        default: return "textFaint"
        }
    }

    var body: some View {
        let label = Self.label(autosave)
        Text(label.isEmpty ? " " : label)
            .centraidType("annotLabel")
            .foregroundStyle(Theme.color(tone, scheme))
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("kit-autosave-status")
            .accessibilityHidden(label.isEmpty)
    }
}
