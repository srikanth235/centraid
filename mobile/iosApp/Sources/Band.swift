import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// THE BAND — invariant 1 (#1020, wave A; v0 `screens/home/HomeBand.tsx`).
///
/// One band, never app-themed, never scrolled away, frame destinations only.
/// The shared `BandPolicy` decides which destinations and in what order; this
/// file draws them and names the one that was pressed. Where a press GOES is
/// the navigator's, which is why nothing here routes.
///
/// **NO ACTIVE BAR, NO TINTED CHIP, NO BADGE.** Selection is carried by the
/// label's weight and ink alone: `band` (400) in `textSoft` when it is not the
/// current place, `control` (600) in full ink when it is. A pill, a dot or a
/// count would each be a second thing to read in a strip that exists to be read
/// at a glance.
///
/// It is a `TabView`'s opposite on purpose. Apps are COVERS pushed over Home,
/// so the band is native-stack chrome drawn at the foot of Home — a tab bar
/// would make every app a peer of Home and leave nowhere for a cover to come
/// from.
struct HomeBand: View {
    let active: String
    let onSelect: (String) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 0) {
            ForEach(BandDestinations.tabs, id: \.id) { place in
                BandTab(
                    iconKey: place.iconKey,
                    label: place.short,
                    // SPEAK WHAT IS PAINTED. v0's band once spoke one noun for
                    // "Needs you" and painted another, so two members got two
                    // names for one place.
                    spoken: place.short + (place.id == active ? ", current place" : ""),
                    selected: place.id == active,
                    identifier: "home-band-\(place.id)",
                    onPress: { onSelect(place.id) }
                )
            }
            // More is NOT a place — a "···" in a bordered square, outside the
            // loop, because it opens a sheet and a destination mark would
            // promise a destination.
            BandTab(
                iconKey: nil,
                label: "More",
                spoken: "All apps and places",
                selected: false,
                identifier: "home-band-more",
                onPress: { onSelect("more") }
            )
        }
        .padding(.horizontal, 4)
        // THE BAND FLOATS (§G), never a flush bar. Its ground is the page's
        // elevated surface — not `bg`, because a page colour does not float,
        // and not `bgChrome`, which sinks on dark — and its edge is
        // `lineStrong`, never the lighter `line`.
        .background(Theme.color("bgElev", scheme))
        .clipShape(RoundedRectangle(cornerRadius: BandMetrics.radius))
        .overlay(
            RoundedRectangle(cornerRadius: BandMetrics.radius)
                .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
        )
        .padding(.horizontal, BandMetrics.inset)
        .padding(.top, BandMetrics.topGap)
        .padding(.bottom, BandMetrics.inset)
        .accessibilityIdentifier("home-band")
    }
}

private struct BandTab: View {
    let iconKey: String?
    let label: String
    let spoken: String
    let selected: Bool
    let identifier: String
    let onPress: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onPress) {
            VStack(spacing: 3) {
                ZStack {
                    if let iconKey {
                        CentraidIconView(
                            iconKey: iconKey,
                            // Inactive is `textFaint` — never the label's token,
                            // never an app's hue. The band carries no identity.
                            tint: Theme.color(selected ? "text" : "textFaint", scheme),
                            size: BandMetrics.iconSize,
                            strokeWidth: CentraidGeometry.appMarkStroke
                        )
                    } else {
                        Text("···")
                            .centraidType("mono")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .frame(width: 26, height: 26)
                            .overlay(
                                RoundedRectangle(cornerRadius: 7)
                                    .strokeBorder(
                                        Theme.color("lineStrong", scheme),
                                        lineWidth: CentraidGeometry.hairline
                                    )
                            )
                    }
                }
                .frame(width: BandMetrics.markSize, height: BandMetrics.markSize)
                Text(label)
                    // The same 11/15 rung either way, so a tap cannot reflow
                    // the strip.
                    .centraidType(selected ? "control" : "band")
                    .foregroundStyle(Theme.color(selected ? "text" : "textSoft", scheme))
                    .lineLimit(1)
                    .multilineTextAlignment(.center)
            }
            // The gutter is on the TAB and not the label, so the 44pt target is
            // unchanged by it.
            .padding(.top, 7)
            .padding(.bottom, 3)
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity, minHeight: BandMetrics.tabMinHeight)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
        .accessibilityLabel(spoken)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
    }
}

/// The plate's geometry, mirroring `BandPolicy`'s constants.
///
/// They are read across the Kotlin boundary where the framework is present and
/// restated here as the SPM host build's floor, because `swift test` runs with
/// no Kotlin toolchain at all — see `ShellModel.swift`'s import guard. The
/// values are asserted equal by `ScreenFixtureTests`.
enum BandMetrics {
    static let inset: CGFloat = 12
    static let topGap: CGFloat = 8
    static let radius: CGFloat = 12
    static let tabMinHeight: CGFloat = 52
    static let markSize: CGFloat = 30
    static let iconSize: CGFloat = 19
}

/// The band's destinations, READ FROM THE SHARED POLICY.
///
/// `BandPolicy.PLACES` is the one table — Home pinned by law, the next four
/// pinned places in table order, `gateway` reachable by link and never by band,
/// a sixth overflowing into More. Restating those ten rows here would be a
/// second table for one band, and the two would disagree the first time a name
/// changed; this reads the same rows Compose reads.
///
/// The SPM host build has no Kotlin toolchain at all (see `ShellModel.swift`'s
/// import guard), so there it resolves to no tabs. Nothing under `swift test`
/// renders the band, and an EMPTY band is the honest answer to "what does the
/// policy say" when the policy is not linked — a hard-coded copy would be the
/// duplicate this comment exists to refuse.
enum BandDestinations {
    struct Place {
        let id: String
        let short: String
        let iconKey: String
    }

    static var tabs: [Place] {
        #if canImport(CentraidShared)
        return BandPolicy.shared.bandTabs(pins: BandPolicy.shared.DEFAULT_PINS).map {
            // `short_`, not `short`: Kotlin/Native suffixes a name that
            // collides with an Objective-C keyword, and `short` is a C type.
            Place(id: $0.id, short: $0.short_, iconKey: $0.iconKey)
        }
        #else
        return []
        #endif
    }
}
