import SwiftUI

/// The bare Centraid mark (#1173): a squared circle of four quarters around an
/// open square heart, from `design/mockups/QuartersIcon.dc.html`. It is the
/// assistant's avatar in Chat and shares its geometry with the app icon.
///
/// The geometry is the board's, on a 120 grid centred on (60, 60): a circle of
/// radius 34 cut on the diagonals by 5-unit gaps, an open square heart whose
/// corners sit on the cuts. The cuts and the heart are erased, not drawn in a
/// tile colour, so the mark sits on any surface. The four colours are the brand
/// colours from `design/tokens.toml` (`[brand]`); they do not change in dark.
struct CentraidMark: View {
    var size: CGFloat = 32

    private static let centre: CGFloat = 60
    private static let radius: CGFloat = 34
    private static let cutWidth: CGFloat = 5
    private static let heartSide: CGFloat = 21.2
    private static let heartStroke: CGFloat = 2
    /// The mark's own extent: the viewBox `22 22 76 76` the avatar crops to.
    private static let extent: CGFloat = 76
    private static let origin: CGFloat = 22

    /// Each quarter is a wedge centred on one axis: top, right, bottom, left.
    private static let quarters: [(String, Double)] = [
        (CentraidAsset.brandTeal, -90),
        (CentraidAsset.brandOrange, 0),
        (CentraidAsset.brandBlue, 90),
        (CentraidAsset.brandPink, 180),
    ]

    var body: some View {
        Canvas { context, canvas in
            let scale = min(canvas.width, canvas.height) / Self.extent
            context.scaleBy(x: scale, y: scale)
            context.translateBy(x: -Self.origin, y: -Self.origin)
            let centre = CGPoint(x: Self.centre, y: Self.centre)
            for (asset, middle) in Self.quarters {
                var wedge = Path()
                wedge.move(to: centre)
                wedge.addArc(
                    center: centre, radius: Self.radius,
                    startAngle: .degrees(middle - 45), endAngle: .degrees(middle + 45),
                    clockwise: false)
                wedge.closeSubpath()
                context.fill(wedge, with: .color(Color(asset)))
            }
            // The cuts and the heart are erased, so the mark is see-through.
            context.blendMode = .clear
            for corner in [-135.0, -45.0, 45.0, 135.0] {
                var cut = Path()
                cut.move(to: centre)
                let radians = corner * .pi / 180
                cut.addLine(to: CGPoint(
                    x: centre.x + (Self.radius + 2) * CGFloat(cos(radians)),
                    y: centre.y + (Self.radius + 2) * CGFloat(sin(radians))))
                context.stroke(cut, with: .color(.black), lineWidth: Self.cutWidth)
            }
            let half = Self.heartSide / 2
            let heart = Path(CGRect(
                x: centre.x - half, y: centre.y - half,
                width: Self.heartSide, height: Self.heartSide))
            context.fill(heart, with: .color(.black))
            context.stroke(
                heart, with: .color(.black),
                style: StrokeStyle(lineWidth: Self.heartStroke, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .drawingGroup()
        .accessibilityHidden(true)
    }
}
