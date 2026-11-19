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
        content.lineLimit(dynamicTypeSize.isAccessibilitySize ? max(lines, wide) : lines)
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
    @ScaledMetric private var scaled: CGFloat
    let weight: Font.Weight

    init(size: CGFloat, weight: Font.Weight) {
        let style: Font.TextStyle =
            switch size {
            case ..<14: .footnote
            case ..<18.5: .body
            case ..<25: .title2
            case ..<32: .title
            default: .largeTitle
            }
        _scaled = ScaledMetric(wrappedValue: size, relativeTo: style)
        self.weight = weight
    }

    func body(content: Content) -> some View {
        content.font(.system(size: scaled, weight: weight))
    }
}
