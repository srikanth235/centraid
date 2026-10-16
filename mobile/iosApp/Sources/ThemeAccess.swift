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
    /// READ SO THE VIEW RE-RENDERS WHEN THE MEMBER CHANGES THE SYSTEM TEXT SIZE.
    /// The app root caps it (DESIGN.md, Dynamic Type); a place the root's cap
    /// does not reach is capped again by `Theme.resolve`.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let role: String
    let scales: Bool

    func body(content: Content) -> some View {
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
        //
        // AT A LARGER TEXT SIZE THE BOX SCALES WITH THE FACE. `resolve` hands back
        // the token's line height multiplied by the same factor the size was, so
        // the leading stays the token's proportion at every setting and not the
        // token's absolute 22 under a 21pt face.
        let resolved = Theme.resolve(role, scheme, dynamicTypeSize, scales: scales)
        let delta = max(0, resolved.lineHeight - resolved.font.lineHeight)
        return content
            .font(Font(resolved.font))
            .lineSpacing(delta)
            .padding(.vertical, delta / 2)
    }
}

/// A TYPE ROLE AT THE MEMBER'S TEXT SIZE: the face that draws it and the line
/// box that goes with it.
struct CentraidResolvedType {
    let font: UIFont
    let lineHeight: CGFloat
}

extension Theme {
    /// THE LARGEST SYSTEM TEXT SIZE THE SHELL DRAWS (DESIGN.md, Dynamic Type).
    ///
    /// The app root caps the environment at this once, but a SHEET DOES NOT
    /// INHERIT THAT CAP: a presentation is a hosting controller of its own and
    /// reads the system's size afresh (seen on the simulator at
    /// `accessibility5`, where a sheet's title and rows drew at accessibility
    /// size and overlapped). So `SheetPresentation` states the cap again on a
    /// sheet's root, and `resolve` clamps as a backstop for every role drawn
    /// anywhere a cap did not reach.
    static let textSizeCap: DynamicTypeSize = .xxxLarge

    /// THE ROLES THAT HOLD THEIR SIZE AT EVERY SETTING (DESIGN.md, Dynamic Type).
    ///
    /// `band` is the only one, and the hold is arithmetic and not preference:
    /// invariant 1 caps a band at five destinations plus More, and those six
    /// labels come to 338px inside a 358px band at 11/15 on a 390pt phone — a
    /// larger face does not fit at any padding. The band's ACTIVE half is
    /// `control`, which scales everywhere else, so a band's call site says
    /// `scales: false` for the half it draws.
    static func holdsSize(_ role: String) -> Bool {
        role == "band"
    }

    /// A ROLE, RESOLVED AT A TEXT SIZE — the ONE place a role's face is chosen.
    ///
    /// `centraidType` draws what this answers and `uiFont` hands UIKit the same
    /// face, so a UIKit field and the SwiftUI text beside it cannot be set at two
    /// different sizes. Every role scales with Dynamic Type through `UIFontMetrics`
    /// on the system text style whose default point size is nearest the role's, so
    /// each rung follows the curve Apple draws for a rung of that size rather than
    /// one curve for the whole ramp; a role that holds, or a call that says
    /// `scales: false`, stays at the token's size.
    static func resolve(
        _ role: String,
        _ scheme: ColorScheme,
        _ size: DynamicTypeSize,
        scales: Bool = true
    ) -> CentraidResolvedType {
        let token = Theme.style(role, scheme)
        let base = face(for: token)
        let size = min(size, textSizeCap)
        guard scales, !holdsSize(role) else {
            return CentraidResolvedType(font: base, lineHeight: token.lineHeight)
        }
        // `UIFontMetrics` reads a trait collection and not the SwiftUI
        // environment, so the environment's size is handed over as the category
        // it stands for.
        let traits = UITraitCollection(preferredContentSizeCategory: size.contentSizeCategory)
        let font = UIFontMetrics(forTextStyle: textStyle(forPointSize: token.fontSize))
            .scaledFont(for: base, compatibleWith: traits)
        // The line box keeps its proportion to the face: the token's box times
        // the factor the size grew by.
        return CentraidResolvedType(
            font: font,
            lineHeight: token.lineHeight * font.pointSize / base.pointSize
        )
    }

    /// The system text style a role's point size stands for. The ramp's rungs
    /// (11, 13, 15, 17, 20, 27, 32) sit on Apple's defaults for these styles
    /// (caption2, footnote, subheadline, body, title3, title1, largeTitle), so a
    /// rung scales as the system's own text of that size does.
    private static func textStyle(forPointSize size: CGFloat) -> UIFont.TextStyle {
        switch size {
        case ..<12: return .caption2
        case ..<14: return .footnote
        case ..<16: return .subheadline
        case ..<18.5: return .body
        case ..<21: return .title3
        case ..<25: return .title2
        case ..<30: return .title1
        default: return .largeTitle
        }
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
    ///
    /// The face at the TOKEN'S size — the unscaled base every scaled font is
    /// derived from.
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

    /// A type role's resolved face AT THE MEMBER'S TEXT SIZE, for the few UIKit
    /// controls a SwiftUI view hosts — the same face `centraidType` draws, so a
    /// UIKit field and the SwiftUI text beside it cannot be set in two different
    /// faces or at two different sizes. The size is a parameter and not read here
    /// because UIKit has no SwiftUI environment: a caller passes its own
    /// `@Environment(\.dynamicTypeSize)` (a representable's `context.environment`),
    /// which is the value the app root capped.
    static func uiFont(_ role: String, _ scheme: ColorScheme, _ size: DynamicTypeSize) -> UIFont {
        resolve(role, scheme, size).font
    }

    /// A role's face at the TOKEN'S size, with no Dynamic Type applied, for a
    /// caller that does its own scaling (the chat's reading text).
    static func baseFont(_ role: String, _ scheme: ColorScheme) -> UIFont {
        face(for: style(role, scheme))
    }
}

extension View {
    /// Apply a type role from the emitted table. It follows the system text size
    /// (capped once at the app root); `scales: false` holds the token's size, which
    /// the band's active half needs because its `control` role scales everywhere
    /// else. The `band` role itself never scales whatever is passed.
    func centraidType(_ role: String, scales: Bool = true) -> some View {
        modifier(CentraidTypeModifier(role: role, scales: scales))
    }
}

extension DynamicTypeSize {
    /// The UIKit category this SwiftUI size stands for — the one place the two
    /// are paired, so `UIFontMetrics` scales at the size the environment holds.
    /// `.large` is the system's own default for a size this build has not heard of.
    var contentSizeCategory: UIContentSizeCategory {
        switch self {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        @unknown default: return .large
        }
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
