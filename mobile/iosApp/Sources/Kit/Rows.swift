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
    var chips: [Centraid_Core_V1_StatusChip] = []
    var hueKey: String = ""
    var dimmed: Bool = false
    var pending: Bool = false
    var pendingLabel: String = KitWords.PENDING
    var accessibility: String = ""
    var identifier: String = ""
    /// The row's own rule under it. A card that draws its rules BETWEEN rows (`KitHairline`) turns
    /// this off, so the last row never trails a line past the card's corner and no rule doubles.
    var divider: Bool = true
    var onTap: (() -> Void)? = nil

    @Environment(\.colorScheme) private var scheme

    /// A row the machine already folded into the kit's `ListRow`.
    init(_ row: Centraid_Core_V1_ListRow, onTap: (() -> Void)? = nil) {
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
        chip: Centraid_Core_V1_StatusChip? = nil,
        chips: [Centraid_Core_V1_StatusChip] = [],
        hueKey: String = "",
        dimmed: Bool = false,
        pending: Bool = false,
        pendingLabel: String = KitWords.PENDING,
        accessibility: String = "",
        identifier: String = "",
        divider: Bool = true,
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
        self.divider = divider
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

    private var trailingText: some View {
        Text(trailing)
            .centraidType("smallStrong")
            .monospacedDigit()
            .foregroundStyle(Theme.color(dimmed ? "textFaint" : trailingTone, scheme))
            .kitLineLimit(1)
    }

    private var row: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .kitType(.row)
                    .foregroundStyle(dimmed ? Surface.meta : Surface.ink)
                    .lineLimit(2)
                if !meta.isEmpty || pending {
                    Text(pending ? (meta.isEmpty ? pendingLabel : "\(meta) · \(pendingLabel)") : meta)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            // THE TRAILING COLUMN, AS THE MONEY BOARDS DRAW IT: the figure with its state chip UNDER
            // it, right-aligned; a chip alone stays beside the title's line.
            if !trailing.isEmpty, !chips.isEmpty {
                VStack(alignment: .trailing, spacing: 4) {
                    trailingText
                    HStack(spacing: 6) {
                        ForEach(Array(chips.enumerated()), id: \.offset) { _, chip in StatusChipView(chip) }
                    }
                }
            } else {
                ForEach(Array(chips.enumerated()), id: \.offset) { _, chip in StatusChipView(chip) }
                if !trailing.isEmpty { trailingText }
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
            if divider {
                Rectangle()
                    .fill(Surface.line)
                    .frame(height: CentraidGeometry.hairline)
                    .padding(.leading, CentraidGeometry.pageMargin)
            }
        }
        .contentShape(Rectangle())
    }
}

/// The press every tappable kit row shows: `bgPress` under the row while held.
struct KitRowPress: ButtonStyle {
    @Environment(\.colorScheme) private var scheme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Surface.fill : Color.clear)
    }
}

private struct OptionalLabel: ViewModifier {
    let label: String
    func body(content: Content) -> some View {
        if label.isEmpty { content } else { content.accessibilityLabel(label) }
    }
}

struct OptionalIdentifier: ViewModifier {
    let identifier: String
    func body(content: Content) -> some View {
        if identifier.isEmpty { content } else { content.accessibilityIdentifier(identifier) }
    }
}

/// A STATUS OR A SET CHOICE, AS A CHIP: a finished label in a hairline capsule
/// whose ink is the tone. `seam` is "not yet", `net` is "owe / leaves",
/// `warning` is a caution; everything else is soft ink.
struct StatusChipView: View {
    let chip: Centraid_Core_V1_StatusChip

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent

    init(_ chip: Centraid_Core_V1_StatusChip) { self.chip = chip }

    /// A tone's ink role. `neutral` is what NEUTRAL and UNSPECIFIED draw — soft
    /// ink on a chip, plain ink on a row's trailing figure.
    static func ink(_ tone: Centraid_Core_V1_StatusChip.Tone, neutral: String) -> String {
        switch tone {
        case .seam: return "seam"
        case .net: return "net"
        case .warning: return "warning"
        case .neutral, .accent, .unspecified, .UNRECOGNIZED: return neutral
        }
    }

    /// THE ONE BADGE SHAPE (#1173): 11pt capitals on a pale tint. A tone that says a state wears
    /// that state's colour (not yet and caution are amber, owe and leaves are red); a plain chip
    /// is quiet ink on the fill.
    var body: some View {
        switch chip.tone {
        case .seam, .warning: KitBadge(label: chip.label, state: .amber)
        case .net: KitBadge(label: chip.label, state: .red)
        case .accent:
            // THE APP'S OWN GOOD NEWS: the accent's chip ground under the accent's text.
            Text(chip.label)
                .kitType(.badge)
                .foregroundStyle(accent.text)
                .kitLineLimit(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(accent.tint ?? accent.wash(dark: scheme == .dark), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        case .neutral, .unspecified, .UNRECOGNIZED:
            Text(chip.label)
                .kitType(.badge)
                .foregroundStyle(Surface.meta)
                .kitLineLimit(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(Surface.fill, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
    }
}

/// A SECTION HEAD'S WORDS: a title, an optional count and a text verb, every
/// one of them the state's.
struct KitSectionHead {
    var title = ""
    var count: UInt32?
    var verbLabel = ""
}

/// THE SECTION HEAD: a title, its count, and a text verb at the end ("See
/// all", "Clear"). Never a chevron-only control — the verb is a word.
struct SectionHeader: View {
    let head: KitSectionHead
    var onVerb: (() -> Void)? = nil

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent

    /// A head the board sets in sentence case (Catch up's piles): the row rung in semibold, the
    /// count in meta, instead of the 12pt capitals every other head wears.
    var sentenceCase = false

    init(_ head: KitSectionHead, sentenceCase: Bool = false, onVerb: (() -> Void)? = nil) {
        self.head = head
        self.sentenceCase = sentenceCase
        self.onVerb = onVerb
    }

    init(title: String, count: UInt32? = nil, verb: String = "", sentenceCase: Bool = false, onVerb: (() -> Void)? = nil) {
        self.init(KitSectionHead(title: title, count: count, verbLabel: verb), sentenceCase: sentenceCase, onVerb: onVerb)
    }

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var verb: some View {
        Button(action: onVerb ?? {}) {
            Text(head.verbLabel)
                .kitType(.meta)
                .fontWeight(.semibold)
                .foregroundStyle(accent.text)
                .multilineTextAlignment(.leading)
                .frame(minHeight: CentraidGeometry.targetMinFine)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// THE TITLE AND ITS COUNT AS ONE WRAPPING RUN (#1202): two views side by side in a narrow
    /// column interleaved their letters ("CHANNE 2 LS"). One `Text` breaks at a word, title first.
    private var titleAndCount: some View {
        let words = head.count.map { "\(head.title) \($0)" } ?? head.title
        return Text(words)
            .kitType(sentenceCase ? .row : .group)
            .fontWeight(sentenceCase ? .semibold : nil)
            .foregroundStyle(Surface.meta)
            .multilineTextAlignment(.leading)
            .accessibilityAddTraits(.isHeader)
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

    private var trailingText: some View {
        Text(trailing)
            .centraidType("smallStrong")
            .monospacedDigit()
            .foregroundStyle(Theme.color(dimmed ? "textFaint" : trailingTone, scheme))
            .kitLineLimit(1)
    }

    private var row: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .kitType(.row)
                    .foregroundStyle(dimmed ? Surface.meta : Surface.ink)
                    .lineLimit(2)
                if !meta.isEmpty || pending {
                    Text(pending ? (meta.isEmpty ? pendingLabel : "\(meta) · \(pendingLabel)") : meta)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            // THE TRAILING COLUMN, AS THE MONEY BOARDS DRAW IT: the figure with its state chip UNDER
            // it, right-aligned; a chip alone stays beside the title's line.
            if !trailing.isEmpty, !chips.isEmpty {
                VStack(alignment: .trailing, spacing: 4) {
                    trailingText
                    HStack(spacing: 6) {
                        ForEach(Array(chips.enumerated()), id: \.offset) { _, chip in StatusChipView(chip) }
                    }
                }
            } else {
                ForEach(Array(chips.enumerated()), id: \.offset) { _, chip in StatusChipView(chip) }
                if !trailing.isEmpty { trailingText }
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
            if divider {
                Rectangle()
                    .fill(Surface.line)
                    .frame(height: CentraidGeometry.hairline)
                    .padding(.leading, CentraidGeometry.pageMargin)
            }
        }
        .contentShape(Rectangle())
    }
}

/// The press every tappable kit row shows: `bgPress` under the row while held.
struct KitRowPress: ButtonStyle {
    @Environment(\.colorScheme) private var scheme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Surface.fill : Color.clear)
    }
}

private struct OptionalLabel: ViewModifier {
    let label: String
    func body(content: Content) -> some View {
        if label.isEmpty { content } else { content.accessibilityLabel(label) }
    }
}

struct OptionalIdentifier: ViewModifier {
    let identifier: String
    func body(content: Content) -> some View {
        if identifier.isEmpty { content } else { content.accessibilityIdentifier(identifier) }
    }
}

/// A STATUS OR A SET CHOICE, AS A CHIP: a finished label in a hairline capsule
/// whose ink is the tone. `seam` is "not yet", `net` is "owe / leaves",
/// `warning` is a caution; everything else is soft ink.
struct StatusChipView: View {
    let chip: Centraid_Core_V1_StatusChip

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent

    init(_ chip: Centraid_Core_V1_StatusChip) { self.chip = chip }

    /// A tone's ink role. `neutral` is what NEUTRAL and UNSPECIFIED draw — soft
    /// ink on a chip, plain ink on a row's trailing figure.
    static func ink(_ tone: Centraid_Core_V1_StatusChip.Tone, neutral: String) -> String {
        switch tone {
        case .seam: return "seam"
        case .net: return "net"
        case .warning: return "warning"
        case .neutral, .accent, .unspecified, .UNRECOGNIZED: return neutral
        }
    }

    /// THE ONE BADGE SHAPE (#1173): 11pt capitals on a pale tint. A tone that says a state wears
    /// that state's colour (not yet and caution are amber, owe and leaves are red); a plain chip
    /// is quiet ink on the fill.
    var body: some View {
        switch chip.tone {
        case .seam, .warning: KitBadge(label: chip.label, state: .amber)
        case .net: KitBadge(label: chip.label, state: .red)
        case .accent:
            // THE APP'S OWN GOOD NEWS: the accent's chip ground under the accent's text.
            Text(chip.label)
                .kitType(.badge)
                .foregroundStyle(accent.text)
                .kitLineLimit(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(accent.tint ?? accent.wash(dark: scheme == .dark), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        case .neutral, .unspecified, .UNRECOGNIZED:
            Text(chip.label)
                .kitType(.badge)
                .foregroundStyle(Surface.meta)
                .kitLineLimit(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(Surface.fill, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
    }
}

/// A SECTION HEAD'S WORDS: a title, an optional count and a text verb, every
/// one of them the state's.
struct KitSectionHead {
    var title = ""
    var count: UInt32?
    var verbLabel = ""
}

/// THE SECTION HEAD: a title, its count, and a text verb at the end ("See
/// all", "Clear"). Never a chevron-only control — the verb is a word.
struct SectionHeader: View {
    let head: KitSectionHead
    var onVerb: (() -> Void)? = nil

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent

    /// A head the board sets in sentence case (Catch up's piles): the row rung in semibold, the
    /// count in meta, instead of the 12pt capitals every other head wears.
    var sentenceCase = false

    init(_ head: KitSectionHead, sentenceCase: Bool = false, onVerb: (() -> Void)? = nil) {
        self.head = head
        self.sentenceCase = sentenceCase
        self.onVerb = onVerb
    }

    init(title: String, count: UInt32? = nil, verb: String = "", sentenceCase: Bool = false, onVerb: (() -> Void)? = nil) {
        self.init(KitSectionHead(title: title, count: count, verbLabel: verb), sentenceCase: sentenceCase, onVerb: onVerb)
    }

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var verb: some View {
        Button(action: onVerb ?? {}) {
            Text(head.verbLabel)
                .kitType(.meta)
                .fontWeight(.semibold)
                .foregroundStyle(accent.text)
                .multilineTextAlignment(.leading)
                .frame(minHeight: CentraidGeometry.targetMinFine)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// THE TITLE AND ITS COUNT AS ONE WRAPPING RUN (#1202): two views side by side in a narrow
    /// column interleaved their letters ("CHANNE 2 LS"). One `Text` breaks at a word, title first.
    private var titleAndCount: some View {
        let title = Text(head.title)
            .kitType(sentenceCase ? .row : .group)
            .fontWeight(sentenceCase ? .semibold : nil)
        var run = title
        if let count = head.count {
            run = run + Text(" ") + Text("\(count)").kitType(sentenceCase ? .meta : .group)
        }
        return run
            .foregroundStyle(Surface.meta)
            .multilineTextAlignment(.leading)
            .accessibilityAddTraits(.isHeader)
    }

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 0) {
                    titleAndCount
                    if !head.verbLabel.isEmpty, onVerb != nil { verb }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(head.title)
                        .kitType(sentenceCase ? .row : .group)
                        .fontWeight(sentenceCase ? .semibold : nil)
                        .foregroundStyle(Surface.meta)
                        .accessibilityAddTraits(.isHeader)
                    if let count = head.count {
                        Text("\(count)")
                            .kitType(sentenceCase ? .meta : .group)
                            .foregroundStyle(Surface.meta)
                    }
                    Spacer(minLength: 0)
                    if !head.verbLabel.isEmpty, onVerb != nil { verb }
                }
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
    var label: String = KitWords.SHOW_MORE
    let onMore: () -> Void

    var body: some View {
        if visible {
            HStack {
                Spacer()
                KitOutlineButton(label: label, action: onMore)
                    .disabled(loading)
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
    /// A dot of this hue before the value (a task's list); empty draws none.
    var hueKey: String = ""
    var identifier: String = ""
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: onTap) {
            // THE VALUE UNDER ITS LABEL AT ACCESSIBILITY SIZES (#1202): side by side they broke
            // "Calendar" and "Repeats" mid-word and cut the value to its first letters.
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                : AnyLayout(HStackLayout(spacing: 0))
            HStack(spacing: 8) {
                layout {
                    Text(key)
                        .centraidType("body")
                        .foregroundStyle(Theme.color(enabled ? "text" : "textDisabled", scheme))
                    if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
                    HStack(spacing: 6) {
                        if !hueKey.isEmpty {
                            Circle()
                                .fill(Theme.color(KitHue.role(hueKey) ?? "cSlate", scheme))
                                .frame(width: 8, height: 8)
                        }
                        Text(value)
                            .centraidType("body")
                            .foregroundStyle(Theme.color(enabled ? "textSoft" : "textDisabled", scheme))
                            .kitLineLimit(1, wide: 4)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                CentraidIconView(iconKey: "ChevronRight", tint: Theme.color(enabled ? "textFaint" : "textDisabled", scheme), size: 14)
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 8 : 0)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
            .overlay(alignment: .bottom) { KitHairline() }
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .combine)
        .modifier(OptionalIdentifier(identifier: identifier))
    }
}

/// The row divider every kit row draws: a hairline inset by the page margin,
/// or by `inset` where the row's words start further in (Tasks' circle).
struct KitHairline: View {
    var inset: CGFloat = CentraidGeometry.pageMargin

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Rectangle()
            .fill(Surface.line)
            .frame(height: CentraidGeometry.hairline)
            .padding(.leading, inset)
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
        let wheel = "c" + String(key.prefix(1)).uppercased() + String(key.dropFirst())
        return centraidColorRoles.contains(wheel) ? wheel : nil
    }
}

/// A CONTAINER AS A SEARCH RESULT (#1097): the notebook, album, project, group
/// or folder a member typed the name of. ONE ROW for Home's search and for the
/// four owning apps' own search results — its glyph by kind, its title, its kind
/// in a soft word — drawn above the result rows. The machine finished every
/// word and the glyph (`SearchContainer`); a tap hands the row's `route` to
/// the page, which pushes it, and decides nothing itself. Its id is
/// `search-container-<entity>-<id>`, the same everywhere.
struct SearchContainerRow: View {
    let container: Centraid_Core_V1_SearchContainer
    let onOpen: (Centraid_Core_V1_Route) -> Void

    @Environment(\.appAccent) private var accent

    /// A matched container is one pill above the rows (#1173): its glyph in the app's colour,
    /// the kind in meta, then its name.
    var body: some View {
        Button {
            guard container.hasRoute else { return }
            onOpen(container.route)
        } label: {
            HStack(spacing: 6) {
                CentraidIconView(iconKey: container.iconKey, tint: accent.text, size: 16)
                Text(container.kindLabel)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .kitLineLimit(1)
                Text(container.title)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                    .kitLineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.leading, 8)
            .padding(.trailing, 12)
            .frame(minHeight: CentraidGeometry.targetMinFine)
            .background(Surface.card, in: Capsule())
            .overlay(Capsule().strokeBorder(Surface.border, lineWidth: CentraidGeometry.hairline))
            .padding(.horizontal, CentraidGeometry.pageMargin + 2)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(container.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("search-container-\(container.entity)-\(container.id)")
    }
}

/// THE CONTAINERS OF ONE ANSWER, in a plain stack: a handful at most, drawn
/// ABOVE a screen's lazy list and never inside it. Rows inserted into a lazy
/// stack above its first item moved the scroll position and left the answer
/// scrolled out of sight (Tasks' own search, #1097).
struct SearchContainerList: View {
    let containers: [Centraid_Core_V1_SearchContainer]
    let onOpen: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(containers, id: \.id) { container in
                SearchContainerRow(container: container, onOpen: onOpen)
            }
        }
    }
}


/// A META LINE OF PARTS (#1202): the parts joined by a dot while they fit on one line, and one part
/// to a line when they do not, so a separator never dangles at a line's end and a part never
/// breaks at its own spaces ("Last / touch 30 days ago"). `accented` parts are set in the app's colour.
struct MetaLine: View {
    let parts: [String]
    var accented: [String] = []
    var lines = 3
    var alignment: HorizontalAlignment = .leading

    @Environment(\.appAccent) private var accent

    /// `text` is split on its own dots, so a part that Rust already joined stays a unit each.
    init(_ text: String, accented: [String] = [], lines: Int = 3, alignment: HorizontalAlignment = .leading) {
        self.alignment = alignment
        self.parts = text.components(separatedBy: " · ").filter { !$0.isEmpty }
        self.accented = accented.filter { !$0.isEmpty }
        self.lines = lines
    }

    init(parts: [String], accented: [String] = [], lines: Int = 3, alignment: HorizontalAlignment = .leading) {
        self.alignment = alignment
        self.parts = parts.flatMap { $0.components(separatedBy: " · ") }.filter { !$0.isEmpty }
        self.accented = accented.filter { !$0.isEmpty }
        self.lines = lines
    }

    private var joined: Text {
        var line = Text(parts.joined(separator: " · "))
        for part in accented {
            line = line + Text(parts.isEmpty ? "" : " · ") + Text(part).foregroundStyle(accent.text)
        }
        return line
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            joined.lineLimit(1).fixedSize(horizontal: true, vertical: false)
            VStack(alignment: alignment, spacing: 0) {
                ForEach(Array((parts.map { ($0, false) } + accented.map { ($0, true) }).prefix(lines).enumerated()), id: \.offset) { _, part in
                    if part.1 {
                        Text(part.0).foregroundStyle(accent.text).kitLineLimit(1)
                    } else {
                        Text(part.0).kitLineLimit(1)
                    }
                }
            }
        }
    }
}
