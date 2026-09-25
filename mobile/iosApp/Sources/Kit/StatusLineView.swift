import SwiftUI

/// THE ONE STATUS LINE (DESIGN.md: no toast): one clause, at most one verb
/// ("Undo"). The sentence and the verb are the machine's; what the verb does
/// is the screen's own event, which `onAct` sends.
struct StatusLineView: View {
    let status: Centraid_Screen_V1_StatusLine
    var identifier: String = "status-action"
    let onAct: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if !status.sentence.isEmpty {
            HStack(spacing: 8) {
                Text(status.sentence)
                    .centraidType("small")
                    .foregroundStyle(Theme.color(status.refused ? "net" : "textSoft", scheme))
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !status.actionLabel.isEmpty {
                    Button(action: onAct) {
                        Text(status.actionLabel)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("link", scheme))
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(identifier)
                }
            }
            // NO IDENTIFIER ON THE CONTAINER: one set here replaces the verb's.
            .padding(.horizontal, CentraidGeometry.pageMargin)
        }
    }
}
