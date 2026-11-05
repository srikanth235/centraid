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
