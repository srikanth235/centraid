import SwiftUI
import UIKit

/// THE REDESIGN'S SURFACES AND STATE COLOURS (#1173), read from the generated colour sets.
///
/// Two page colours: `page` for a page of cards and `plainPage` for a plain list. In dark there
/// is one page colour, so both resolve to it (the tokens say so, `surface.dark.plain_page`).
/// Cards are white (`card`) and carry the card radius; only floating glass casts a shadow, so
/// nothing here has one. A sheet sits one level up in dark (`sheet`, with `sheetCard` on it).
///
/// Light and dark are built into each set, so the appearance in force (the system's, or the
/// member's own override) chooses. A view never reads a hex.
enum Surface {
    static let page = Color(CentraidAsset.surfacePage)
    static let plainPage = Color(CentraidAsset.surfacePlainPage)
    static let card = Color(CentraidAsset.surfaceCard)
    static let sheet = Color(CentraidAsset.surfaceSheet)
    static let sheetCard = Color(CentraidAsset.surfaceSheetCard)
    static let fill = Color(CentraidAsset.surfaceFill)
    /// THE HAIRLINES, THE CARD EDGE AND THE SECONDARY TEXT STRENGTHEN UNDER INCREASED CONTRAST (#1185),
    /// one step along the tokens that exist: a row's rule takes the card edge's colour, an edge
    /// the meta ink, meta text the body ink. The colour follows the setting by itself, so no view
    /// reads the environment for it and every screen built from the kit inherits it.
    static let line = contrasting(CentraidAsset.surfaceLine, increased: CentraidAsset.textMeta)
    static let border = contrasting(CentraidAsset.surfaceBorder, increased: CentraidAsset.textMeta)
    /// Ink under a white letter or glyph; it keeps its ink in dark.
    static let tile = Color(CentraidAsset.surfaceTile)

    static let ink = Color(CentraidAsset.textInk)
    static let body = Color(CentraidAsset.textBody)
    static let meta = contrasting(CentraidAsset.textMeta, increased: CentraidAsset.textBody)

    /// A colour set, and the one a member who turned on Increase Contrast sees in its place.
    /// Both resolve against the trait collection they are drawn in, so the appearance in force
    /// (the member's own override too) still chooses the light or dark half of each set.
    private static func contrasting(_ normal: String, increased: String) -> Color {
        Color(UIColor { traits in
            let name = traits.accessibilityContrast == .high ? increased : normal
            guard let color = UIColor(named: name, in: nil, compatibleWith: traits) else {
                preconditionFailure("no colour set named '\(name)' in the asset catalog.")
            }
            return color
        })
    }
}

/// A STATE, and only a state: red, amber and green appear in words and badges to say overdue,
/// pending or done, never as decoration. `text` is the word's colour on the page or a card,
/// `fill` a solid under white glyphs, `tint` the pale ground of a badge.
enum StateColor: CaseIterable {
    case red, amber, green

    var text: Color {
        switch self {
        case .red: Color(CentraidAsset.stateRedText)
        case .amber: Color(CentraidAsset.stateAmberText)
        case .green: Color(CentraidAsset.stateGreenText)
        }
    }

    var fill: Color {
        switch self {
        case .red: Color(CentraidAsset.stateRed)
        case .amber: Color(CentraidAsset.stateAmber)
        case .green: Color(CentraidAsset.stateGreen)
        }
    }

    var tint: Color {
        switch self {
        case .red: Color(CentraidAsset.stateRedTint)
        case .amber: Color(CentraidAsset.stateAmberTint)
        case .green: Color(CentraidAsset.stateGreenTint)
        }
    }
}

/// THE TYPE SCALE (#1173): titles 34 bold, the centred heroes' title 24 bold, sections 20, rows 16, meta 13, plus the 12pt group
/// head and the 11pt badge, both in capitals. Sizes and weights are `CentraidScale`, the
/// generated file; the face is the one the shell ships (`centraidTypeFaces`), so a weight with
/// no file of its own draws at the nearest face that has one (700 draws at the semibold file).
/// Each rung scales with Dynamic Type through the same path as every other role.
enum KitType: String, CaseIterable {
    case title, hero, section, row, meta, group, badge

    /// The role name `Theme.style` resolves.
    var role: String { "kit\(rawValue.prefix(1).uppercased())\(rawValue.dropFirst())" }

    var size: CGFloat {
        switch self {
        case .title: CentraidScale.titleSize
        case .hero: CentraidScale.heroSize
        case .section: CentraidScale.sectionSize
        case .row: CentraidScale.rowSize
        case .meta: CentraidScale.metaSize
        case .group: CentraidScale.groupSize
        case .badge: CentraidScale.badgeSize
        }
    }

    var weight: Int {
        switch self {
        case .title: CentraidScale.titleWeight
        case .hero: CentraidScale.heroWeight
        case .section: CentraidScale.sectionWeight
        case .row: CentraidScale.rowWeight
        case .meta: CentraidScale.metaWeight
        case .group: CentraidScale.groupWeight
        case .badge: CentraidScale.badgeWeight
        }
    }

    var caps: Bool {
        switch self {
        case .title: CentraidScale.titleCaps
        case .hero: CentraidScale.heroCaps
        case .section: CentraidScale.sectionCaps
        case .row: CentraidScale.rowCaps
        case .meta: CentraidScale.metaCaps
        case .group: CentraidScale.groupCaps
        case .badge: CentraidScale.badgeCaps
        }
    }

    /// The line box: a tight title, an open row.
    var lineHeight: CGFloat { (size * (self == .title || self == .hero || self == .section ? 1.18 : 1.32)).rounded() }

    /// The style `Theme.style` hands back for this rung. Weight snaps to a face that exists.
    var style: CentraidTypeStyle {
        CentraidTypeStyle(
            family: "sans",
            fontSize: size,
            lineHeight: lineHeight,
            weight: weight >= 600 ? 600 : 400
        )
    }

    static func named(_ role: String) -> KitType? {
        allCases.first { $0.role == role }
    }
}

extension View {
    /// A rung of the scale, with its capitals when the rung says so.
    func kitType(_ rung: KitType, scales: Bool = true) -> some View {
        centraidType(rung.role, scales: scales)
            .textCase(rung.caps ? .uppercase : nil)
    }

    /// A white card on a card page: the card radius, no shadow, no border.
    func kitCard() -> some View {
        background(Surface.card, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
    }

    /// A card on a plain list page, where its white needs an edge to be read.
    func kitBorderedCard() -> some View {
        let shape = RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous)
        return background(Surface.card, in: shape)
            .overlay(shape.strokeBorder(Surface.border, lineWidth: CentraidGeometry.hairline))
    }
}

/// ONE BADGE SHAPE (#1173): 11pt capitals on a pale tint, in the state's colour. The same view
/// draws "Compromised", "Overdue" and "Pending" everywhere, so a state is one thing to learn.
struct KitBadge: View {
    let label: String
    let state: StateColor

    var body: some View {
        Text(label)
            .kitType(.badge)
            .kitHeld()
            .foregroundStyle(state.text)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(state.tint, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

/// THE PILL'S OUTLINE: a capsule while the label is on one line, and a rounded key with a bounded
/// corner once it wraps. A true capsule's radius is half its height, so a two-line label at the
/// largest text sits against the curve with no room inside it (#1202); capping the radius keeps
/// the words inside the straight edge.
struct KitPillShape: InsettableShape {
    var inset: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        RoundedRectangle(cornerRadius: min(rect.height / 2, 26), style: .continuous)
            .path(in: rect.insetBy(dx: inset, dy: inset))
    }

    func inset(by amount: CGFloat) -> KitPillShape {
        KitPillShape(inset: inset + amount)
    }
}

/// A PILL THAT HUGS ITS LABEL, in the app's fill under a white label: an empty state's one
/// action, a permission's "Allow". The full-width one is `KitInkButton`.
struct KitPillButton: View {
    let label: String
    var iconKey: String = ""
    let action: () -> Void

    @Environment(\.appAccent) private var accent
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if !iconKey.isEmpty { CentraidIconView(iconKey: iconKey, tint: .white, size: 16) }
                Text(label)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(enabled ? Color.white : Surface.meta)
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .background(enabled ? accent.fill : Surface.fill, in: KitPillShape())
            .contentShape(KitPillShape())
        }
        .buttonStyle(.plain)
    }
}

/// A SMALL GLYPH TILE: a white glyph on a solid fill, the radius a ratio of the side so every
/// size keeps one shape. The default fill is the app's; a destructive row passes the state's.
struct KitTile: View {
    let iconKey: String
    var size: CGFloat = 32
    var fill: Color? = nil

    @Environment(\.appAccent) private var accent
    @ScaledMetric private var scaleBase: CGFloat = 1

    init(iconKey: String, size: CGFloat = 32, fill: Color? = nil) {
        self.iconKey = iconKey
        self.size = size
        self.fill = fill
    }

    /// THE TILE GROWS WITH THE TEXT BESIDE IT (#1202), up to twice its size, so a glyph is not
    /// the one small thing in a row of large words.
    private var side: CGFloat { size * min(scaleBase, 2) }

    var body: some View {
        CentraidIconView(iconKey: iconKey, tint: .white, size: (side * 0.5).rounded())
            .frame(width: side, height: side)
            .background(fill ?? accent.fill, in: RoundedRectangle(cornerRadius: side * CentraidGeometry.iconChipRadiusRatio, style: .continuous))
            .accessibilityHidden(true)
    }
}

// MARK: - Clamped text (#1202)

extension View {
    /// TEXT THAT HOLDS AT `xxxLarge` (#1202), for a badge or a chart's axis words. A status chip is
    /// a capsule of capitals, and at the largest text "COMPROMISED" is wider than the row it sits
    /// in and was cut to "COMPR..."; a chart's labels sit in a column a fixed fraction of the
    /// card wide. Held at the size the LargeText board draws, the word is whole and still larger
    /// than body text; the band's labels and the calendar grids hold the same way. Totals and
    /// every figure a member reads in a row do not hold: they stay whole by wrapping or shrinking.
    func kitHeld() -> some View {
        dynamicTypeSize(...Theme.reflowSize)
    }
}

extension View {
    /// A ONE-LINE CLAMP THAT OPENS AT ACCESSIBILITY TEXT SIZES. A title, a date or a meta line
    /// holds to `lines` where the row has the room, and takes up to `wide` once the text is
    /// large, so what the member reads is not cut to an ellipsis (a word dropped from the end
    /// of a name is a word lost). The row grows with its text; a fixed height is a bug.
    func kitLineLimit(_ lines: Int = 1, wide: Int = 3) -> some View {
        modifier(KitLineLimit(lines: lines, wide: wide))
    }
}

private struct KitLineLimit: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let lines: Int
    let wide: Int

    func body(content: Content) -> some View {
        content.lineLimit(dynamicTypeSize >= .xLarge ? nil : lines)
    }
}

// MARK: - Whole tokens (#1202)

/// A SENTENCE THAT NEVER BREAKS AN ADDRESS. Words wrap as words do; a token with no space in it
/// that carries a digit and a dot or colon (a network address, "192.168.1.5:18455") is a line of
/// its own that shrinks to fit rather than split mid-number. The caller passes the rung's styling
/// on the result, so it reads as one text.
struct KitWholeTokens: View {
    let text: String

    /// A run of words, or one token that must stay whole.
    private struct Piece: Identifiable {
        let id: Int
        let text: String
        let whole: Bool
    }

    private static func isAddress(_ token: Substring) -> Bool {
        token.contains { $0.isNumber } && token.contains { $0 == "." || $0 == ":" } && token.count >= 7
    }

    private var pieces: [Piece] {
        var out: [Piece] = []
        var run: [Substring] = []
        func flush() {
            if !run.isEmpty { out.append(Piece(id: out.count, text: run.joined(separator: " "), whole: false)); run = [] }
        }
        for token in text.split(separator: " ", omittingEmptySubsequences: true) {
            if Self.isAddress(token) {
                flush()
                out.append(Piece(id: out.count, text: String(token), whole: true))
            } else {
                run.append(token)
            }
        }
        flush()
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(pieces) { piece in
                if piece.whole {
                    Text(piece.text).lineLimit(1).minimumScaleFactor(0.5)
                } else {
                    Text(piece.text).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// A SENTENCE THAT HOLDS A QUOTED COMMAND WHOLE (#1202). Words wrap as words do; what sits between
/// a pair of quotes ("centraid-gateway pair") is a line of its own that shrinks to fit, with its
/// hyphens drawn non-breaking, so the command never breaks at a hyphen or inside a word. Display
/// only: a screen reader says the original sentence.
struct KitQuotedSentence: View {
    let text: String
    var centered = false

    private struct Piece: Identifiable {
        let id: Int
        let text: String
        let quoted: Bool
    }

    private var pieces: [Piece] {
        var out: [Piece] = []
        var run = ""
        var quote = ""
        var opening = ""
        var inside = false
        func flush() {
            let trimmed = run.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { out.append(Piece(id: out.count, text: trimmed, quoted: false)) }
            run = ""
        }
        for character in text {
            if !inside, character == "\u{201C}" || character == "\"" {
                inside = true
                opening = String(character)
                quote = ""
            } else if inside, character == "\u{201D}" || character == "\"" {
                let closing = String(character)
                inside = false
                if quote.contains("-") {
                    // A hyphenated quote is a command or a name: its own line, whole.
                    flush()
                    let words = quote.replacingOccurrences(of: "-", with: "\u{2011}")
                    out.append(Piece(id: out.count, text: opening + words + closing, quoted: true))
                } else {
                    run += opening + quote + closing
                }
                quote = ""
            } else if inside {
                quote.append(character)
            } else {
                run.append(character)
            }
        }
        if inside { run += opening + quote }
        flush()
        return out
    }

    var body: some View {
        VStack(alignment: centered ? .center : .leading, spacing: 0) {
            ForEach(pieces) { piece in
                if piece.quoted {
                    Text(piece.text).lineLimit(1).minimumScaleFactor(0.5)
                } else {
                    Text(piece.text).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .multilineTextAlignment(centered ? .center : .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
    }
}

// MARK: - Scaled tiles (#1202)

extension View {
    /// A SQUARE THAT GROWS WITH THE TEXT IT HOLDS. An initial tile or avatar at a fixed size is
    /// cut to a sliver of its letter at the largest text; sized as a `@ScaledMetric` relative to
    /// the text style the letter follows, the tile and the letter grow together. The letter
    /// still shrinks (never past half) rather than clip, should a long one come.
    func kitScaledSquare(_ side: CGFloat, relativeTo style: Font.TextStyle = .body) -> some View {
        modifier(KitScaledSquare(side: side, style: style))
    }
}

private struct KitScaledSquare: ViewModifier {
    @ScaledMetric private var scaled: CGFloat

    init(side: CGFloat, style: Font.TextStyle) {
        _scaled = ScaledMetric(wrappedValue: side, relativeTo: style)
    }

    func body(content: Content) -> some View {
        content
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            .frame(width: scaled, height: scaled)
    }
}

// MARK: - Reduce Motion (#1185)

/// THE ONE WAY THE SHELL MOVES THINGS. A member who turned on Reduce Motion gets the change and
/// none of the movement: an animation is dropped (the change lands at once) and a transition is
/// a plain fade. Every animation in the kit and the screens goes through these, so the setting is
/// honoured by the shell and not screen by screen; the Android twin is `motion(...)` in
/// `ReducedMotion.kt`.
extension View {
    /// `.animation(_:value:)`, dropped under Reduce Motion.
    func kitAnimation<Value: Equatable>(_ animation: Animation?, value: Value) -> some View {
        modifier(KitAnimation(animation: animation, value: value))
    }

    /// `.transition(_:)`, a plain fade under Reduce Motion.
    func kitTransition(_ transition: AnyTransition) -> some View {
        modifier(KitTransition(transition: transition))
    }
}

/// `withAnimation`, dropped under Reduce Motion, for a change made outside a view body (an
/// event handler or a scroll).
@MainActor
func kitWithAnimation<Result>(_ animation: Animation? = .default, _ body: () throws -> Result) rethrows -> Result {
    try withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : animation, body)
}

private struct KitAnimation<Value: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let animation: Animation?
    let value: Value

    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : animation, value: value)
    }
}

private struct KitTransition: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let transition: AnyTransition

    func body(content: Content) -> some View {
        content.transition(reduceMotion ? .opacity : transition)
    }
}

// MARK: - Text size (#1185)

extension View {
    /// A system-face size that follows the member's text size, for the text that is not a type
    /// role (a figure, a chat chip). `.font(.system(size:))` holds its size at every setting; this
    /// scales from the point size given, along the curve of the system style nearest to it, and
    /// the app root's cap (`Theme.textSizeCap`) still bounds it.
    func kitScaledFont(_ size: CGFloat, weight: Font.Weight = .regular) -> some View {
        modifier(KitScaledFont(size: size, weight: weight))
    }
}

private struct KitScaledFont: ViewModifier {
    let size: CGFloat
    let weight: Font.Weight

    func body(content: Content) -> some View {
        content.kitSystemFont(size, weight: weight)
    }
}

// MARK: - System face that carries a text style (#1202)

extension Font {
    /// A SYSTEM-FACE SIZE THAT THE ACCESSIBILITY AUDIT READS AS DYNAMIC TYPE. `.system(size:)` has no
    /// text style, so the audit reports it as unsupported however it is scaled; `UIFontMetrics` on the
    /// nearest text style makes the font a scaled one. The size handed in is the member's, already
    /// capped by the root (and by `kitHeld` where a badge holds), so the hold still holds.
    static func kitScaled(_ size: CGFloat, weight: Font.Weight = .regular, at category: DynamicTypeSize) -> Font {
        let style: UIFont.TextStyle =
            switch size {
            case ..<12: .caption2
            case ..<14: .footnote
            case ..<16: .subheadline
            case ..<18.5: .body
            case ..<21: .title3
            case ..<25: .title2
            case ..<30: .title1
            default: .largeTitle
            }
        let traits = UITraitCollection(preferredContentSizeCategory: min(category, Theme.textSizeCap).contentSizeCategory)
        let base = UIFont.systemFont(ofSize: size, weight: UIFont.Weight(weight))
        return Font(UIFontMetrics(forTextStyle: style).scaledFont(for: base, compatibleWith: traits))
    }
}

extension UIFont.Weight {
    init(_ weight: Font.Weight) {
        switch weight {
        case .ultraLight: self = .ultraLight
        case .thin: self = .thin
        case .light: self = .light
        case .medium: self = .medium
        case .semibold: self = .semibold
        case .bold: self = .bold
        case .heavy: self = .heavy
        case .black: self = .black
        default: self = .regular
        }
    }
}

extension View {
    /// `Font.kitScaled`, reading the text size from the environment.
    func kitSystemFont(_ size: CGFloat, weight: Font.Weight = .regular) -> some View {
        modifier(KitSystemFont(size: size, weight: weight))
    }
}

private struct KitSystemFont: ViewModifier {
    @Environment(\.dynamicTypeSize) private var category
    let size: CGFloat
    let weight: Font.Weight

    func body(content: Content) -> some View {
        content.font(.kitScaled(size, weight: weight, at: category))
    }
}
