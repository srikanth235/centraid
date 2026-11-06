import SwiftUI

/// THE ONE STATUS LINE (product-intuition/references/design-behaviour.md § Status line): one clause, at most one verb
/// ("Undo"). The sentence and the verb are the machine's; what the verb does
/// is the screen's own event, which `onAct` sends.
struct StatusLineView: View {
    let status: Centraid_Core_V1_StatusLine
    var identifier: String = "status-action"
    let onAct: () -> Void

    @Environment(\.appAccent) private var accent

    var body: some View {
        if !status.sentence.isEmpty {
            HStack(spacing: 8) {
                Text(status.sentence)
                    .kitType(.row)
                    .foregroundStyle(status.refused ? StateColor.red.text : Surface.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !status.actionLabel.isEmpty {
                    Button(action: onAct) {
                        Text(status.actionLabel)
                            .kitType(.row)
                            .fontWeight(.semibold)
                            .foregroundStyle(accent.text)
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(identifier)
                }
            }
            // NO IDENTIFIER ON THE CONTAINER: one set here replaces the verb's.
            .modifier(KitStatusPill())
            .padding(.horizontal, CentraidGeometry.pageMargin)
        }
    }
}

/// THE ONE STATUS LINE'S SHAPE (#1173): a single pill on the card colour with a hairline edge,
/// docked above the band. It casts no shadow: only floating glass does. State is a sentence in
/// the pill, never a toast that overlays and goes.
struct KitStatusPill: ViewModifier {
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous)
        content
            .padding(.leading, 14)
            .padding(.trailing, 6)
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .background(Surface.card, in: shape)
            .overlay(shape.strokeBorder(Surface.border, lineWidth: CentraidGeometry.hairline))
            .padding(.vertical, 4)
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

    @Environment(\.appAccent) private var accent

    var body: some View {
        if !sentence.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(sentence)
                        .kitType(.row)
                        .foregroundStyle(refused ? StateColor.red.text : Surface.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("\(identifier)-sentence")
                    if !actionLabel.isEmpty {
                        Button(action: onAct) {
                            Text(actionLabel)
                                .kitType(.row)
                                .fontWeight(.semibold)
                                .foregroundStyle(accent.text)
                                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("\(identifier)-action")
                    }
                    if !closeLabel.isEmpty {
                        Button(action: onClose) {
                            CentraidIconView(iconKey: "X", tint: Surface.meta, size: 16)
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
                            Capsule().fill(Surface.fill)
                            Capsule()
                                .fill(accent.fill)
                                .frame(width: proxy.size.width * CGFloat(min(permille, 1000)) / 1000)
                        }
                    }
                    .frame(height: 3)
                    .accessibilityHidden(true)
                }
            }
            .modifier(KitStatusPill())
            .padding(.horizontal, CentraidGeometry.pageMargin)
        }
    }
}
