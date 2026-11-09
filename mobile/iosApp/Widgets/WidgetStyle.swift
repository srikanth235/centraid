import SwiftUI

/// THE WIDGETS' COLOURS AND FACES, from the generated tables (#1173).
///
/// `Design/DesignScale.swift` names the colour sets and `Design/Theme.swift` the
/// faces; both compile into this extension on their own (they import SwiftUI and
/// CoreGraphics only), and `Resources/Assets.xcassets` is a resource of the
/// extension, so `Color(name)` resolves in the extension's own bundle. `Icon.swift`
/// is app code and is not compiled here: a widget draws no icons.
enum WidgetPalette {
    static let page = Color(CentraidAsset.surfaceCard)
    static let ink = Color(CentraidAsset.textInk)
    static let meta = Color(CentraidAsset.textMeta)
    static let agenda = Color(CentraidAsset.appCalendar)
    static let red = Color(CentraidAsset.stateRed)

    /// A snapshot's `tint` key as a colour. An unknown key is Agenda's own.
    static func tint(_ key: String) -> Color {
        key == "red" ? red : agenda
    }
}

/// The sans face at a size that follows Dynamic Type (`relativeTo`), the same
/// faces the app draws (`centraidTypeFaces`: 400 and 600).
enum WidgetType {
    static func sans(_ size: CGFloat, semibold: Bool = false, relativeTo style: Font.TextStyle) -> Font {
        let weight = semibold ? 600 : 400
        guard let face = centraidTypeFaces["sans"]?[weight] else {
            return Font.system(style, weight: semibold ? .semibold : .regular)
        }
        return Font.custom(face, size: size, relativeTo: style)
    }

    static let heading = sans(13, semibold: true, relativeTo: .footnote)
    static let meta = sans(13, relativeTo: .footnote)
    static let metaStrong = sans(13, semibold: true, relativeTo: .footnote)
    static let body = sans(16, semibold: true, relativeTo: .body)
    static let rowTitle = sans(14, semibold: true, relativeTo: .subheadline)
    static let bigTime = sans(26, semibold: true, relativeTo: .title)
    static let bigCount = sans(44, semibold: true, relativeTo: .largeTitle)
}
