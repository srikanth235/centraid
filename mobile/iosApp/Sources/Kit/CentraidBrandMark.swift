import SwiftUI

/// The assistant's bare four-quarter mark. The transparent heart and diagonal
/// cuts come from the generated asset, so this works over cards and glass.
struct CentraidBrandMark: View {
    let size: CGFloat

    var body: some View {
        Image(decorative: "CentraidBrandMark", bundle: .main)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The Welcome app-icon tile uses the same 120-unit construction as the
/// generated icon; the bare asset occupies its 76-unit inner viewport.
struct CentraidBrandTile: View {
    let size: CGFloat
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 27 / 120)
        CentraidBrandMark(size: size * 76 / 120)
            .frame(width: size, height: size)
            .background(Theme.color(scheme == .dark ? "brandDark_tile" : "brandLight_tile", scheme), in: shape)
            .overlay(shape.strokeBorder(Theme.color("brandEdge", scheme), lineWidth: size * 1.5 / 120))
            .accessibilityHidden(true)
    }
}
