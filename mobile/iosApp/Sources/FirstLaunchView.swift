import SwiftUI

/// THE WELCOME SCREEN (#1173): what a device that holds no vault opens onto, in
/// place of Home. One native screen, not a deck: the mark, a title, one sentence,
/// the three things the app is (apps on this phone, an assistant on this phone,
/// encrypted backups) and two doors, `Get started` and `Restore backup`. The board
/// is `design/mockups/Welcome.dc.html`.
///
/// ## Nothing here decides anything
///
/// Whether this screen is up, and every word on it, is Rust's Home
/// (`HomeState.first_launch`, set while the shelf holds no vault). Its two doors
/// are Home's events: Make (`MakePressed`) and Restore (`RestorePressed`), which
/// Rust turns into the words' pages pushed over this screen, so **cancelling out
/// of either lands back here**, and the screen goes only when a vault is held.
/// Pairing a backup device stays out of first run: Home leads there once a vault
/// exists.
struct FirstLaunchView: View {
    let gate: Centraid_Core_V1_HomeFirstLaunch
    @ObservedObject var store: ScreenStore
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @ScaledMetric(relativeTo: .largeTitle) private var titleSize = 30
    @ScaledMetric(relativeTo: .body) private var bodySize = CentraidScale.rowSize
    @ScaledMetric(relativeTo: .callout) private var detailSize = 15
    /// THE PRIMARY'S LABEL AND THE CLAIMS' TILES FOLLOW THE TEXT SIZE (#1202): the label stayed
    /// at 17 in a pill while the words around it grew, and the tiles stayed 40.
    @ScaledMetric(relativeTo: .body) private var primarySize = 17
    @ScaledMetric(relativeTo: .body) private var claimTile = 40

    /// The icon in each claim's tile, in the order Rust lists the claims: apps,
    /// assistant, backups.
    /// The icon tile's corner, 27 of 120 of its side, as on the icon board.
    private static let tileRadius: CGFloat = 104 * 0.225

    private static let claimIcons = ["Grid", "Sparkle", "Lock"]

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 0) {
                    markTile
                        .padding(.top, 56)
                    Text(gate.title)
                        .font(.system(size: titleSize, weight: .bold))
                        .foregroundStyle(Color(CentraidAsset.textInk))
                        .multilineTextAlignment(.center)
                        .padding(.top, 28)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("first-launch-title")
                    Text(gate.body)
                        .font(.system(size: bodySize))
                        .foregroundStyle(Color(CentraidAsset.textMeta))
                        .multilineTextAlignment(.center)
                        .padding(.top, 8)
                    VStack(alignment: .leading, spacing: 22) {
                        ForEach(Array(gate.slides.enumerated()), id: \.offset) { index, claim in
                            claimRow(index: index, claim: claim)
                        }
                    }
                    .padding(.top, 36)
                    // THE DOORS SCROLL WITH THE PAGE AT ACCESSIBILITY SIZES (#1202): pinned, their two
                    // large keys took the screen and left the claims no room to be read or scrolled to.
                    if dynamicTypeSize.isAccessibilitySize {
                        doors
                            .padding(.top, 28)
                            .padding(.bottom, 24)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 32)
            }
            .scrollBounceBehavior(.basedOnSize)
            // THE CONTENT STOPS AT THE STATUS BAR (#1202): scrolled, the first claim's icon ran
            // under the clock.
            .hardTopScrollEdge()

            if !dynamicTypeSize.isAccessibilitySize {
                doors
                    .padding(.horizontal, 32)
                    .padding(.bottom, 24)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(page).ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("first-launch")
    }

    /// The plain list page in light, the page in dark (the board draws no card).
    private var page: String {
        CentraidAsset.surfacePlainPage
    }

    /// The app icon: the mark on a white tile with a hairline edge. The tile is
    /// white in dark too, as it is on the icon board.
    private var markTile: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Self.tileRadius, style: .continuous)
                .fill(Color.white)
            RoundedRectangle(cornerRadius: Self.tileRadius, style: .continuous)
                .strokeBorder(Color(CentraidAsset.surfaceBorder), lineWidth: 1)
            CentraidMark(size: 104 * 76 / 120)
        }
        .frame(width: 104, height: 104)
        .accessibilityHidden(true)
    }

    private func claimRow(index: Int, claim: Centraid_Core_V1_HomeFirstLaunchSlide) -> some View {
        // THE TILE SITS OVER THE WORDS AT ACCESSIBILITY SIZES (#1202): beside them it left the body
        // a column too narrow for "documents", which broke as "document/s".
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 16))
        return layout {
            ZStack {
                RoundedRectangle(cornerRadius: CentraidScale.cardRadius * 0.75, style: .continuous)
                    .fill(Color(CentraidAsset.shellText).opacity(scheme == .dark ? 0.18 : 0.12))
                CentraidIconView(
                    iconKey: Self.claimIcons[min(index, Self.claimIcons.count - 1)],
                    tint: Color(CentraidAsset.shellText),
                    size: claimTile / 2, strokeWidth: 2)
            }
            .frame(width: claimTile, height: claimTile)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(claim.title)
                    .font(.system(size: bodySize, weight: .semibold))
                    .foregroundStyle(Color(CentraidAsset.textInk))
                Text(claim.body)
                    .font(.system(size: detailSize))
                    .foregroundStyle(Color(CentraidAsset.textMeta))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("first-launch-claim-\(index)")
    }

    /// Teal is the shell's colour: a filled pill for the act, a quiet teal link for
    /// the way back. The pill's fill is the dark fill in dark, so white text holds.
    private var doors: some View {
        VStack(spacing: 10) {
            Button { store.sendHome(.make(.init())) } label: {
                Text(gate.makeLabel)
                    .font(.system(size: primarySize, weight: .semibold))
                    .foregroundStyle(Color.white)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(KitPillShape().fill(Color(CentraidAsset.shell)))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("first-launch-primary")
            Button { store.sendHome(.restore(.init())) } label: {
                Text(gate.restoreLabel)
                    .font(.system(size: bodySize, weight: .semibold))
                    .foregroundStyle(Color(CentraidAsset.shellText))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("first-launch-secondary")
        }
    }
}

/// THE FRAME BEFORE HOME HAS DRAWN (the core opening, the shelf reading its
/// directory): the page and nothing on it, so neither the welcome screen nor Home
/// is drawn for an answer that has not arrived.
struct BarePaper: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Theme.color("bg", scheme).ignoresSafeArea()
    }
}
