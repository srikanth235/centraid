import SwiftUI

/// THE EMITTED TABLE, REACHABLE FROM A VIEW (#1020, wave A).
///
/// `CentraidTokens` in `Design/Theme.swift` is generated and holds both schemes;
/// this is the thin accessor that picks one and looks a role up. It is the Swift
/// half of Android's `LocalCentraidTokens` — the same rule on both sides: a view
/// reads a ROLE, never a literal, because a literal in a view is a colour nobody
/// chose and a fifth lowering with no drift gate.
///
/// `SwiftUI`'s own semantic colours (`.primary`, `.secondary`, `.quaternary`) are
/// deliberately absent from Home. They are Apple's ramp, not this system's, and
/// the first build of this screen used them — which is precisely why it did not
/// look like the product.
enum Theme {
    static func tokens(_ scheme: ColorScheme) -> CentraidTheme {
        scheme == .dark ? CentraidTokens.dark : CentraidTokens.light
    }

    /// A role, or a loud failure.
    ///
    /// A trap and not a fallback colour: a role renamed in `packages/design` and
    /// not here would otherwise paint something plausible and wrong, and
    /// `centraidColorRoles` is the list a test checks this against.
    static func color(_ role: String, _ scheme: ColorScheme) -> Color {
        guard let value = tokens(scheme).colors[role] else {
            preconditionFailure(
                "no such colour role '\(role)' in the emitted native theme. Roles come "
                    + "from packages/design; regenerate with "
                    + "`bun contracts/tools/export-native-theme.ts`."
            )
        }
        return value
    }

    /// A type role, WITH ITS OWN LINE HEIGHT.
    ///
    /// The hand-off specifies both, and a rung rendered at the platform's
    /// default leading is a rung at the wrong measure — most visible on the tile
    /// bodies, where three stacked lines drift a whole row out of alignment.
    /// SwiftUI has no line-height property, so the difference is applied as
    /// `lineSpacing` and the leading half is trimmed back off the top.
    static func style(_ role: String, _ scheme: ColorScheme) -> CentraidTypeStyle {
        guard let value = tokens(scheme).type[role] else {
            preconditionFailure("no such type role '\(role)' in the emitted native theme.")
        }
        return value
    }

    static func spacing(_ rung: String, _ scheme: ColorScheme) -> CGFloat {
        tokens(scheme).spacing[rung] ?? 0
    }

    static func radius(_ name: String, _ scheme: ColorScheme) -> CGFloat {
        tokens(scheme).radii[name] ?? 0
    }
}

private struct CentraidTypeModifier: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    let role: String

    func body(content: Content) -> some View {
        let style = Theme.style(role, scheme)
        return content
            .font(.system(size: style.fontSize, weight: Font.Weight(centraid: style.weight)))
            .lineSpacing(max(0, style.lineHeight - style.fontSize))
    }
}

extension View {
    /// Apply a type role from the emitted table.
    func centraidType(_ role: String) -> some View {
        modifier(CentraidTypeModifier(role: role))
    }
}

extension Font.Weight {
    /// The table carries CSS numeric weights; SwiftUI names its rungs.
    init(centraid weight: Int) {
        switch weight {
        case ..<200: self = .ultraLight
        case ..<300: self = .thin
        case ..<400: self = .light
        case ..<500: self = .regular
        case ..<600: self = .medium
        case ..<700: self = .semibold
        case ..<800: self = .bold
        default: self = .heavy
        }
    }
}

extension ColorScheme {
    /// The app marks in force. Both schemes are emitted; the hue ring moves
    /// between them, so a light chip on a dark page would be the wrong hue and
    /// not merely the wrong brightness.
    var centraidMarks: [String: CentraidAppMark] {
        self == .dark ? CentraidCatalog.darkMarks : CentraidCatalog.lightMarks
    }
}
