import SwiftUI

// ONE ROW SHAPE, ONE SECTION HEAD, ONE FIELD ROW (K5; handoff README l.22-27:
// "one row shape per app reused by every list in it; the section head with a
// count and a text verb; the field row of key, value and note; the chip").

/// THE LIST ROW: title over meta, a trailing figure, its chips in draw order,
/// a 2pt hue rule at the inline start, 44pt minimum.
///
/// `hueKey` is a colour role (`cTeal`, `net`, …) — empty draws no rule.
/// `dimmed` recedes the ink (a settled expense, a done task); `pending` says a
/// write for this row is in flight, which is the screen's knowledge and never
/// a column in the vault.
struct CentraidRow: View {
    let title: String
    var meta: String = ""
    var trailing: String = ""
    var trailingTone: String = "text"
    var chips: [Centraid_Screen_V1_StatusChip] = []
    var hueKey: String = ""
    var dimmed: Bool = false
    var pending: Bool = false
    var pendingLabel: String = "Saving"
    var accessibility: String = ""
    var identifier: String = ""
    var onTap: (() -> Void)? = nil

    @Environment(\.colorScheme) private var scheme

    /// A row the machine already folded into the kit's `ListRow`.
    init(_ row: Centraid_Screen_V1_ListRow, onTap: (() -> Void)? = nil) {
        self.init(
            title: row.title,
            meta: row.meta,
            trailing: row.trailing,
            trailingTone: StatusChipView.ink(row.trailingTone, neutral: "text"),
            chips: row.chips,
            hueKey: row.hueKey,
            dimmed: row.dimmed,
            pending: row.pending,
            accessibility: row.accessibilityLabel,
            identifier: row.id.isEmpty ? "" : "row-\(row.id)",
            onTap: onTap
        )
    }

    init(
        title: String,
        meta: String = "",
        trailing: String = "",
        trailingTone: String = "text",
        chip: Centraid_Screen_V1_StatusChip? = nil,
        chips: [Centraid_Screen_V1_StatusChip] = [],
        hueKey: String = "",
        dimmed: Bool = false,
        pending: Bool = false,
        pendingLabel: String = "Saving",
        accessibility: String = "",
        identifier: String = "",
        onTap: (() -> Void)? = nil
    ) {
        self.title = title
        self.meta = meta
        self.trailing = trailing
        self.trailingTone = trailingTone
        self.chips = (chip.map { [$0] } ?? []) + chips
        self.hueKey = hueKey
        self.dimmed = dimmed
        self.pending = pending
        self.pendingLabel = pendingLabel
        self.accessibility = accessibility
        self.identifier = identifier
        self.onTap = onTap
    }

    var body: some View {
        Group {
            if let onTap {
                Button(action: onTap) { row }.buttonStyle(KitRowPress())
            } else {
                row
            }
        }
        .accessibilityElement(children: .combine)
        .modifier(OptionalLabel(label: accessibility))
        .modifier(OptionalIdentifier(identifier: identifier))
    }

    private var row: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .centraidType("body")
                    .foregroundStyle(Theme.color(dimmed ? "textFaint" : "text", scheme))
                    .lineLimit(2)
                if !meta.isEmpty || pending {
                    Text(pending ? (meta.isEmpty ? pendingLabel : "\(meta) · \(pendingLabel)") : meta)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color(dimmed ? "textFaint" : "textSoft", scheme))
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            ForEach(Array(chips.enumerated()), id: \.offset) { _, chip in StatusChipView(chip) }
            if !trailing.isEmpty {
                Text(trailing)
                    .centraidType("smallStrong")
                    .monospacedDigit()
                    .foregroundStyle(Theme.color(dimmed ? "textFaint" : trailingTone, scheme))
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(minHeight: CentraidGeometry.targetMinCoarse)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) {
            if let hue = KitHue.role(hueKey) {
                Rectangle()
                    .fill(Theme.color(hue, scheme))
                    .frame(width: 2)
                    .padding(.vertical, 8)
            }
        }
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Theme.color("line", scheme))
                .frame(height: CentraidGeometry.hairline)
                .padding(.leading, CentraidGeometry.pageMargin)
        }
        .contentShape(Rectangle())
    }
}

/// The press every tappable kit row shows: `bgPress` under the row while held.
struct KitRowPress: ButtonStyle {
    @Environment(\.colorScheme) private var scheme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Theme.color("bgPress", scheme) : Color.clear)
    }
}

private struct OptionalLabel: ViewModifier {
    let label: String
    func body(content: Content) -> some View {
        if label.isEmpty { content } else { content.accessibilityLabel(label) }
    }
}

private struct OptionalIdentifier: ViewModifier {
    let identifier: String
    func body(content: Content) -> some View {
        if identifier.isEmpty { content } else { content.accessibilityIdentifier(identifier) }
    }
}

/// A STATUS OR A SET CHOICE, AS A CHIP: a finished label in a hairline capsule
/// whose ink is the tone. `seam` is "not yet", `net` is "owe / leaves",
/// `warning` is a caution; everything else is soft ink.
struct StatusChipView: View {
    let chip: Centraid_Screen_V1_StatusChip

    @Environment(\.colorScheme) private var scheme

    init(_ chip: Centraid_Screen_V1_StatusChip) { self.chip = chip }

    private var tone: String { Self.ink(chip.tone, neutral: "textSoft") }

    /// A tone's ink role. `neutral` is what NEUTRAL and UNSPECIFIED draw — soft
    /// ink on a chip, plain ink on a row's trailing figure.
    static func ink(_ tone: Centraid_Screen_V1_StatusChip.Tone, neutral: String) -> String {
        switch tone {
        case .seam: return "seam"
        case .net: return "net"
        case .warning: return "warning"
        case .neutral, .unspecified, .UNRECOGNIZED: return neutral
        }
    }

    var body: some View {
        Text(chip.label)
            .centraidType("annotLabel")
            .foregroundStyle(Theme.color(tone, scheme))
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .overlay(
                Capsule().strokeBorder(Theme.color(tone == "textSoft" ? "line" : tone, scheme), lineWidth: CentraidGeometry.hairline)
            )
    }
}

/// THE SECTION HEAD: a title, its count, and a text verb at the end ("See
/// all", "Clear"). Never a chevron-only control — the verb is a word.
struct SectionHeader: View {
    let head: Centraid_Screen_V1_SectionHead
    var onVerb: (() -> Void)? = nil

    @Environment(\.colorScheme) private var scheme

    init(_ head: Centraid_Screen_V1_SectionHead, onVerb: (() -> Void)? = nil) {
        self.head = head
        self.onVerb = onVerb
    }

    init(title: String, count: UInt32? = nil, verb: String = "", onVerb: (() -> Void)? = nil) {
        var head = Centraid_Screen_V1_SectionHead()
        head.title = title
        if let count { head.count = count }
        head.verbLabel = verb
        self.init(head, onVerb: onVerb)
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(head.title)
                .centraidType("eyebrow")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .accessibilityAddTraits(.isHeader)
            if head.hasCount {
                Text("\(head.count)")
                    .centraidType("eyebrow")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
            Spacer(minLength: 0)
            if !head.verbLabel.isEmpty, let onVerb {
                Button(action: onVerb) {
                    Text(head.verbLabel)
                        .centraidType("annotLabelOn")
                        .foregroundStyle(Theme.color("link", scheme))
                        .frame(minHeight: CentraidGeometry.targetMinFine)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 16)
        .padding(.bottom, 4)
    }
}

/// THE NEXT PAGE, ASKED FOR. A paged list's foot: shown only while the data
/// names a next cursor, and quiet while a page-one re-read is in flight (the
/// kit's `PagedList` refuses a next page then anyway).
struct ShowMoreFooter: View {
    let visible: Bool
    var loading: Bool = false
    var label: String = "Show more"
    let onMore: () -> Void

    var body: some View {
        if visible {
            HStack {
                Spacer()
                KitOutlineButton(label: label, action: onMore)
                    .disabled(loading)
                    .opacity(loading ? 0.5 : 1)
                    .accessibilityIdentifier("kit-show-more")
                Spacer()
            }
            .padding(.vertical, 12)
        }
    }
}

/// THE FIELD ROW: key over value, with an optional note under — a detail
/// page's read-only fact.
struct FieldRow: View {
    let key: String
    let value: String
    var note: String = ""

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(key)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
            Text(value)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
            if !note.isEmpty {
                Text(note)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .overlay(alignment: .bottom) { KitHairline() }
        .accessibilityElement(children: .combine)
    }
}

/// A FIELD THE MEMBER TYPES INTO, inside an editor. The text is the view's own
/// `@State` (the only place a keystroke exists before the machine hears it);
/// `onEdit` hands each difference over as the screen's edit event.
struct EditableFieldRow: View {
    let key: String
    @Binding var text: String
    var placeholder: String = ""
    var identifier: String = ""
    let onEdit: (String) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(key)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
            TextField(placeholder, text: $text)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
                .onChange(of: text) { _, typed in onEdit(typed) }
                .accessibilityLabel(key)
                .modifier(OptionalIdentifier(identifier: identifier))
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .overlay(alignment: .bottom) { KitHairline() }
    }
}

/// A FIELD WHOSE VALUE IS A CHOICE: tapping opens the choice (a sheet — a
/// choice never pushes, #1015 D4).
struct ChoiceFieldRow: View {
    let key: String
    let value: String
    var identifier: String = ""
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onTap) {
            HStack {
                Text(key)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                Spacer(minLength: 8)
                Text(value)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .lineLimit(1)
                CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme), size: 14)
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
            .overlay(alignment: .bottom) { KitHairline() }
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .combine)
        .modifier(OptionalIdentifier(identifier: identifier))
    }
}

/// The row divider every kit row draws: a hairline inset by the page margin.
struct KitHairline: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Rectangle()
            .fill(Theme.color("line", scheme))
            .frame(height: CentraidGeometry.hairline)
            .padding(.leading, CentraidGeometry.pageMargin)
    }
}

/// A ROW'S HUE, AS THE THEME SPELLS IT. Machines send the colour role
/// (`cRose`); a few still send the wheel key (`rose`). Both resolve here, and
/// anything the emitted table lacks draws no rule — `Theme.color` traps on an
/// unknown role, and a row must never crash on what the vault stored.
enum KitHue {
    static func role(_ key: String) -> String? {
        guard !key.isEmpty else { return nil }
        if centraidColorRoles.contains(key) { return key }
        let wheel = "c" + key.prefix(1).uppercased() + key.dropFirst()
        return centraidColorRoles.contains(wheel) ? wheel : nil
    }
}
