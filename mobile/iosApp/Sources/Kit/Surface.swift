import SwiftUI

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
    static let line = Color(CentraidAsset.surfaceLine)
    static let border = Color(CentraidAsset.surfaceBorder)
    /// Ink under a white letter or glyph; it keeps its ink in dark.
    static let tile = Color(CentraidAsset.surfaceTile)

    static let ink = Color(CentraidAsset.textInk)
    static let body = Color(CentraidAsset.textBody)
    static let meta = Color(CentraidAsset.textMeta)
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
                Text(label).kitType(.row).fontWeight(.semibold)
            }
            .foregroundStyle(enabled ? Color.white : Surface.meta)
            .padding(.horizontal, 20)
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .background(enabled ? accent.fill : Surface.fill, in: Capsule())
            .contentShape(Capsule())
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

    var body: some View {
        CentraidIconView(iconKey: iconKey, tint: .white, size: (size * 0.5).rounded())
            .frame(width: size, height: size)
            .background(fill ?? accent.fill, in: RoundedRectangle(cornerRadius: size * CentraidGeometry.iconChipRadiusRatio, style: .continuous))
            .accessibilityHidden(true)
    }
}
