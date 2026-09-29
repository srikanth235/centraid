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

/// THE STATUS LINE WITH WORK IN IT (#1047): the one line, plus a determinate
/// bar while bytes move (`permille`, nil for none — never a spinner), at most
/// one inline text action, and a CLOSE KEY — an icon control whose words are
/// its accessibility label — when the line may be put away. It never clears
/// itself; the machine's state says when it is gone.
struct ProgressStatusLine: View {
    let sentence: String
    var permille: UInt32? = nil
    var refused: Bool = false
    var actionLabel: String = ""
    var onAct: () -> Void = {}
    var closeLabel: String = ""
    var onClose: () -> Void = {}
    var identifier: String = "status"

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if !sentence.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(sentence)
                        .centraidType("small")
                        .foregroundStyle(Theme.color(refused ? "net" : "textSoft", scheme))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("\(identifier)-sentence")
                    if !actionLabel.isEmpty {
                        Button(action: onAct) {
                            Text(actionLabel)
                                .centraidType("smallStrong")
                                .foregroundStyle(Theme.color("link", scheme))
                                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("\(identifier)-action")
                    }
                    if !closeLabel.isEmpty {
                        Button(action: onClose) {
                            CentraidIconView(iconKey: "X", tint: Theme.color("textSoft", scheme), size: 16)
                                .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(closeLabel)
                        .accessibilityIdentifier("\(identifier)-close")
                    }
                }
                if let permille {
                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.color("skel", scheme))
                            Capsule()
                                .fill(Theme.color("text", scheme))
                                .frame(width: proxy.size.width * CGFloat(min(permille, 1000)) / 1000)
                        }
                    }
                    .frame(height: 3)
                    .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 4)
        }
    }
}
