import SwiftUI

/// The Binding Layer app mark (#1020, wave A; v0 `kit/components/AppMark.tsx`).
///
/// A quiet hue wash over the page with the single-tone shared icon stroke on it.
/// Both colours arrive already composited from
/// `contracts/tools/export-native-catalog.ts`, because `color-mix()` exists on
/// neither SwiftUI nor Compose and a blend computed twice is two blends.
///
/// THE RADIUS IS A SHARE OF THE SIZE, not a token: an identity mark is a rounded
/// square whose silhouette has to hold at 22 and at 44, which no static radius
/// can do. Nothing else — no gradient, no gloss, no shadow, no identity-coloured
/// chrome beyond the chip wash.
struct AppMark: View {
    let appID: String
    var size: CGFloat = 32

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if let app = CentraidCatalog.byID[appID], let mark = scheme.centraidMarks[appID] {
            ZStack {
                RoundedRectangle(cornerRadius: size * CentraidGeometry.iconChipRadiusRatio)
                    .fill(mark.chipBackground)
                CentraidIconView(
                    iconKey: app.iconKey,
                    tint: mark.markColor,
                    // Between 14 and 16 like v0: a mark smaller than 14 loses
                    // the silhouette, one larger than 16 crowds a 22pt chip.
                    size: min(16, max(14, (size * 0.55).rounded()))
                )
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
        }
    }
}
