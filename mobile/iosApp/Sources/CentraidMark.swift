import SwiftUI

/// The bare Centraid mark (#1173): four interlocking rounded rooms in a 3×3
/// courtyard around an open square heart, from `design/mockups/CourtyardIcon.dc.html`.
/// It is the assistant's avatar in Chat and shares its geometry with the app icon.
///
/// The geometry is the board's, on a 120 grid centred on (60, 60): an 84×84
/// courtyard (`[18..102]`) of four 54×24 rounded rooms (`rx = 8`) separated by
/// 6-unit gaps around an open 24×24 square heart (`[48..72]`). Gaps and heart
/// are empty space, so the mark sits cleanly on any surface. The four colours
/// are the brand colours from `design/tokens.toml` (`[brand]`); they do not
/// change in dark.
struct CentraidMark: View {
    var size: CGFloat = 32

    private static let roomRadius: CGFloat = 8
    /// The mark's own extent: the viewBox `14 14 92 92` (`centraid-mark.svg`).
    private static let extent: CGFloat = 92
    private static let origin: CGFloat = 14

    /// Four interlocking rooms clockwise from the top, in 120-grid coordinates.
    private static let rooms: [(String, CGRect)] = [
        (CentraidAsset.brandTeal, CGRect(x: 18, y: 18, width: 54, height: 24)),
        (CentraidAsset.brandViolet, CGRect(x: 78, y: 18, width: 24, height: 54)),
        (CentraidAsset.brandGold, CGRect(x: 48, y: 78, width: 54, height: 24)),
        (CentraidAsset.brandRose, CGRect(x: 18, y: 48, width: 24, height: 54)),
    ]

    var body: some View {
        Canvas { context, canvas in
            let scale = min(canvas.width, canvas.height) / Self.extent
            context.scaleBy(x: scale, y: scale)
            context.translateBy(x: -Self.origin, y: -Self.origin)
            let corner = CGSize(width: Self.roomRadius, height: Self.roomRadius)
            for (asset, rect) in Self.rooms {
                let path = Path(roundedRect: rect, cornerSize: corner)
                context.fill(path, with: .color(Color(asset)))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
