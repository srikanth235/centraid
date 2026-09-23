import SwiftUI
import UIKit

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
    /// SwiftUI has no line-height property, so the shortfall against the face's
    /// own natural height is applied as `lineSpacing` plus half of it as padding
    /// above and below — see `CentraidTypeModifier` for why both are needed.
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
        // TWO QUANTITIES THAT ARE NOT THE SAME NUMBER, AND THE BUG THAT CAME OF
        // CONFUSING THEM. The token's `lineHeight` is the CSS line box: the whole
        // vertical slot one line of text occupies, 22pt at a 15pt body. SwiftUI's
        // `lineSpacing` is the gap ADDED BETWEEN two lines, on top of whatever
        // leading the face already carries. Subtracting `fontSize` from
        // `lineHeight` therefore gets both cases wrong: a single-line `Text` got
        // no correction at all and stood at the face's natural height (~18pt at
        // 15), and a two-line one got 22 - 15 = 7 stacked on top of the natural
        // ~18 and came out near 25. The Home Docs tile measured 27pt of row pitch
        // where the reference says 31 — 22 of line box plus 4/4 of padding plus
        // the one-point hairline.
        //
        // So resolve the face and ask it what it actually stands at, take the
        // shortfall against the token's box, and spend it in two places: between
        // the lines with `lineSpacing`, and half above and half below with the
        // vertical padding, so ONE line also fills exactly `lineHeight`. Clamped
        // at zero because a token tighter than the face cannot be honoured by
        // adding space, and negative spacing would overlap the rungs.
        //
        // The arithmetic below is unchanged by the face landing — which was the
        // point of measuring the font rather than assuming a ratio. `natural` is
        // whatever the RESOLVED face stands at, so swapping SF Pro for Instrument
        // Sans moves the measurement and the drawing together.
        let uiFont = Self.face(for: style)
        let delta = max(0, style.lineHeight - uiFont.lineHeight)
        return content
            .font(Font(uiFont))
            .lineSpacing(delta)
            .padding(.vertical, delta / 2)
    }

    /// THE FACE THE TOKEN ASKS FOR, OR A CRASH — NEVER A QUIET SUBSTITUTE.
    ///
    /// Every type token has said `family: "sans"` since the first one, and this
    /// view drew `.system(...)` regardless: SF Pro, for the project's whole
    /// life, on every screen. Nothing failed, because `UIFont(name:size:)`
    /// answers nil for an unregistered face and SwiftUI is happy to render the
    /// system font instead. A `??` here would restore exactly that silence, so
    /// there is none: a missing face is a build that shipped without its
    /// `UIAppFonts` entry or without `Resources/Fonts`, and it says so by name.
    ///
    /// `code` is the exception and keeps the platform monospace: it ships no
    /// file (see `centraidTypeFaces`, which has no `code` row), and a monospace
    /// role is about the metric, not about this system's voice.
    static func face(for style: CentraidTypeStyle) -> UIFont {
        if style.family == "code" {
            return UIFont.monospacedSystemFont(
                ofSize: style.fontSize,
                weight: UIFont.Weight(centraid: style.weight)
            )
        }
        guard let name = centraidTypeFaces[style.family]?[style.weight] else {
            preconditionFailure(
                "no face for family '\(style.family)' at weight \(style.weight) in the "
                    + "emitted table. Faces come from packages/design/fonts; regenerate "
                    + "with `bun contracts/tools/export-native-theme.ts`."
            )
        }
        guard let uiFont = UIFont(name: name, size: style.fontSize) else {
            preconditionFailure(
                "the font '\(name)' is not registered. Its file must be in "
                    + "Resources/Fonts AND listed under UIAppFonts in "
                    + "mobile/iosApp/project.yml; re-run `xcodegen generate` after "
                    + "`bun contracts/tools/export-native-theme.ts`."
            )
        }
        return uiFont
    }
}

extension Theme {
    /// A type role's resolved face, for the few UIKit controls a SwiftUI view
    /// hosts — the same face `centraidType` draws, so a UIKit field and the
    /// SwiftUI text beside it cannot be set in two different faces.
    static func uiFont(_ role: String, _ scheme: ColorScheme) -> UIFont {
        CentraidTypeModifier.face(for: style(role, scheme))
    }
}

extension View {
    /// Apply a type role from the emitted table.
    func centraidType(_ role: String) -> some View {
        modifier(CentraidTypeModifier(role: role))
    }
}

extension UIFont.Weight {
    /// The CSS weight ladder, for the ONE `code` role that has no file.
    ///
    /// There is no `Font.Weight` twin any more, and that is the point: the sans
    /// faces are resolved BY NAME out of `centraidTypeFaces`, so the weight is
    /// carried by the file rather than by a synthetic rung, and the font that is
    /// measured is by construction the font that is drawn. This ladder survives
    /// only for `UIFont.monospacedSystemFont`, which takes a weight and not a
    /// name.
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
