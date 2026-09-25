import SwiftUI

// TALLY'S PIECES, SHARED BY EVERY TALLY SCREEN (#1046; handoff "README -
// Tally" §5). One ledger row, one hero, one person chip, one figure — the
// words and tones are the state's; this file maps them to geometry.

/// A figure's tone as a colour role. Positive is ink, "you owe" is `net`,
/// level is `ink2` — never a green (handoff §2).
enum TallyInk {
    static func role(_ tone: Centraid_Screen_V1_TallyTone) -> String {
        switch tone {
        case .owe: return "net"
        case .level: return "textSoft"
        case .owed, .plain, .unspecified, .UNRECOGNIZED: return "text"
        }
    }

    /// A person or group hue (`teal`, `slate`…) as its `c<Hue>` role.
    static func hue(_ key: String) -> String { AgendaHue.role(key) }
}

/// An amount, rendered by the kit, or nothing for an absent one.
func tallyMoney(_ money: Centraid_Screen_V1_Money) -> String { Money.render(money) }

/// The person chip: initials in the person's hue, 24pt on a row, 28 on a head.
struct TallyChipView: View {
    let person: Centraid_Screen_V1_TallyPersonChip
    var size: CGFloat = 24

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Text(person.initials)
            .centraidType("annotLabelOn")
            .foregroundStyle(Theme.color("onAccent", scheme))
            .frame(width: size, height: size)
            .background(Circle().fill(Theme.color(TallyInk.hue(person.hue), scheme)))
            .accessibilityHidden(true)
    }
}

/// A figure block: the amount in its tone, its label under it.
struct TallyFigureView: View {
    let figure: Centraid_Screen_V1_TallyFigure
    var rung: String = "smallStrong"

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .trailing, spacing: 0) {
            Text(tallyMoney(figure.amount))
                .centraidType(rung)
                .monospacedDigit()
                .foregroundStyle(Theme.color(TallyInk.role(figure.tone), scheme))
                .lineLimit(1)
            if !figure.label.isEmpty {
                Text(figure.label)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .lineLimit(1)
            }
        }
    }
}

/// THE HERO: display-rung figures (one line per currency — never summed
/// across currencies), the section label, the sentence that says where the
/// figure came from, and up to two quiet verbs.
struct TallyHeroView: View {
    let hero: Centraid_Screen_V1_TallyHero
    var verbs: [(label: String, action: () -> Void)] = []

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !hero.label.isEmpty {
                Text(hero.label)
                    .centraidType("eyebrow")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .accessibilityAddTraits(.isHeader)
            }
            ForEach(Array(hero.lines.enumerated()), id: \.offset) { _, line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(tallyMoney(line.amount))
                        .centraidType("display")
                        .monospacedDigit()
                        .foregroundStyle(Theme.color(TallyInk.role(line.tone), scheme))
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    if !line.label.isEmpty {
                        Text(line.label)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if !hero.sub.isEmpty {
                Text(hero.sub)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            if !verbs.isEmpty {
                HStack(spacing: 8) {
                    ForEach(Array(verbs.enumerated()), id: \.offset) { _, verb in
                        KitOutlineButton(label: verb.label, action: verb.action)
                    }
                }
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 12)
        .accessibilityIdentifier("tally-hero")
    }
}

/// THE LEDGER ROW, used by every list in the app: optional person chip ·
/// title · meta · figure block (the amount, and "yours" under it).
struct TallyLedgerRowView: View {
    let row: Centraid_Screen_V1_TallyLedgerRow
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                if row.hasPayer, !row.payer.initials.isEmpty {
                    TallyChipView(person: row.payer)
                } else if !row.iconKey.isEmpty {
                    CentraidIconView(iconKey: row.iconKey, tint: Theme.color("textSoft", scheme), size: 18)
                        .frame(width: 24, height: 24)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .centraidType("body")
                        .foregroundStyle(Theme.color(row.settlement ? "textSoft" : "text", scheme))
                        .lineLimit(1)
                    if !row.meta.isEmpty {
                        Text(row.meta)
                            .centraidType("annotLabel")
                            .monospacedDigit()
                            .foregroundStyle(Theme.color("textFaint", scheme))
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 0) {
                    Text(tallyMoney(row.amount))
                        .centraidType("smallStrong")
                        .monospacedDigit()
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                    if row.hasYours, !row.yours.label.isEmpty {
                        Text([row.yours.label, tallyMoney(row.yours.amount)].filter { !$0.isEmpty }.joined(separator: " "))
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color(TallyInk.role(row.yours.tone), scheme))
                            .lineLimit(1)
                    }
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .overlay(alignment: .bottom) { KitHairline() }
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel.isEmpty ? row.title : "\(row.accessibilityLabel), \(tallyMoney(row.amount))")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("tally-row-\(row.rowKey)")
    }
}

/// A person row with a figure block: a friend, a member, a friend's part.
struct TallyPersonRowView: View {
    var person: Centraid_Screen_V1_TallyPersonChip? = nil
    let title: String
    var meta: String = ""
    let figures: [Centraid_Screen_V1_TallyFigure]
    var dimmed: Bool = false
    let accessibility: String
    let identifier: String
    var onTap: (() -> Void)? = nil

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Group {
            if let onTap {
                Button(action: onTap) { row }.buttonStyle(KitRowPress())
            } else {
                row
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
        .accessibilityAddTraits(onTap == nil ? [] : .isButton)
        .accessibilityIdentifier(identifier)
    }

    /// The state's words, with the rendered amounts after them.
    private var spoken: String {
        let amounts = figures.map { tallyMoney($0.amount) }.filter { !$0.isEmpty }
        return ([accessibility.isEmpty ? title : accessibility] + amounts).joined(separator: ", ")
    }

    private var row: some View {
        HStack(spacing: 12) {
            if let person { TallyChipView(person: person, size: 28) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .centraidType("body")
                    .foregroundStyle(Theme.color(dimmed ? "textFaint" : "text", scheme))
                    .lineLimit(1)
                if !meta.isEmpty {
                    Text(meta)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                ForEach(Array(figures.enumerated()), id: \.offset) { _, figure in
                    TallyFigureView(figure: figure)
                }
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .overlay(alignment: .bottom) { KitHairline() }
        .contentShape(Rectangle())
    }
}

/// A transfer: from → to, the amount, its line.
struct TallyTransferRowView: View {
    let transfer: Centraid_Screen_V1_TallyTransferRow
    var onTap: (() -> Void)? = nil

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let row = HStack(spacing: 8) {
            TallyChipView(person: transfer.from)
            CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme), size: 12)
                .accessibilityHidden(true)
            TallyChipView(person: transfer.to)
            VStack(alignment: .leading, spacing: 2) {
                Text(transfer.line)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(2)
                if !transfer.meta.isEmpty {
                    Text(transfer.meta)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
            }
            Spacer(minLength: 8)
            Text(tallyMoney(transfer.amount))
                .centraidType("smallStrong")
                .monospacedDigit()
                .foregroundStyle(Theme.color(transfer.yours ? "net" : "text", scheme))
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .overlay(alignment: .bottom) { KitHairline() }
        .contentShape(Rectangle())

        Group {
            if let onTap {
                Button(action: onTap) { row }.buttonStyle(KitRowPress())
            } else {
                row
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(transfer.accessibilityLabel), \(tallyMoney(transfer.amount))")
        .accessibilityIdentifier("tally-transfer-\(transfer.key)")
    }
}

/// A write that was refused, said where the member is looking.
struct TallyWriteLine: View {
    let write: Centraid_Screen_V1_WriteState

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if write.phase == .refused, write.hasFailure {
            VStack(alignment: .leading, spacing: 2) {
                Text(write.failure.sentence)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("net", scheme))
                if !write.failure.remedy.isEmpty {
                    Text(write.failure.remedy)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 6)
            .accessibilityIdentifier("tally-write-refused")
        }
    }
}

/// A plain sentence under a section, in soft ink.
struct TallyNote: View {
    let text: String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 6)
        }
    }
}
