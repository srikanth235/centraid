import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

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
            // More is NOT a place — three dots in a bordered square, outside
            // the loop, because it opens a sheet and a destination mark would
            // promise a destination. The SQUARE carries that argument, not the
            // mark inside it, which is why `bordered` is its own flag and not
            // an absent icon: More draws the catalog's `more` silhouette
            // through the very same `CentraidIconView` the places use, at the
            // same size, stroke and ink.
            //
            // It was a literal "···" until Instrument Sans was bundled: the
            // face sets MIDDLE DOT with sidebearings tight enough that three
            // of them fuse into one dash at the band's 11pt rung. A glyph
            // whose shape depends on which face happens to be loaded is not a
            // mark; the catalog path is.
            BandTab(
                iconKey: "more",
                bordered: true,
                label: "More",
                spoken: "All apps and places",
                selected: false,
                identifier: "home-band-more",
                onPress: { onSelect("more") }
            )
        }
        .padding(BandMetrics.platePad)
        // THE BAND FLOATS (§G), never a flush bar. Its ground is the page's
        // elevated surface — not `bg`, because a page colour does not float,
        // and not `bgChrome`, which sinks on dark — and its edge is
        // `lineStrong`, never the lighter `line`.
        .background(Theme.color("bgElev", scheme))
        // A PILL (`BandPolicy.BAND_RADIUS`), drawn as `Capsule` so the ends are
        // exact semicircles at whatever height the plate takes.
        .clipShape(Capsule())
        .overlay(
            Capsule()
                .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
        )
        .padding(.horizontal, BandMetrics.inset)
        .padding(.top, BandMetrics.topGap)
        .padding(.bottom, BandMetrics.floorPadding)
        .accessibilityIdentifier("home-band")
    }
}

private struct BandTab: View {
    let iconKey: String
    /// The bordered square is More's alone — it says "this opens a sheet", so
    /// giving one to a place would promise a sheet the place does not open.
    var bordered: Bool = false
    let label: String
    let spoken: String
    let selected: Bool
    let identifier: String
    let onPress: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onPress) {
            VStack(spacing: BandMetrics.labelGap) {
                ZStack {
                    CentraidIconView(
                        iconKey: iconKey,
                        // Inactive is `textFaint` — never the label's token,
                        // never an app's hue. The band carries no identity.
                        tint: Theme.color(selected ? "text" : "textFaint", scheme),
                        size: BandMetrics.iconSize,
                        strokeWidth: CentraidGeometry.appMarkStroke
                    )
                    .frame(width: bordered ? BandMetrics.markSize : nil, height: bordered ? BandMetrics.markSize : nil)
                    .overlay {
                        if bordered {
                            RoundedRectangle(cornerRadius: 7)
                                .strokeBorder(
                                    Theme.color("lineStrong", scheme),
                                    lineWidth: CentraidGeometry.hairline
                                )
                        }
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
            .padding(.top, BandMetrics.tabTop)
            .padding(.bottom, BandMetrics.tabBottom)
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity, minHeight: BandMetrics.tabMinHeight)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
        .accessibilityLabel(spoken)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
    }
}

/// AN APP'S BAND — the `AppPlace` room's band (DESIGN.md, "The seven rooms"),
/// copied from v0's (`apps/mobile/src/apps/photos/PhotosBand.tsx`,
/// `kit/band/BandCapsule.tsx`, `kit/band-surface.ts`).
///
/// **TWO PLATES, NOT ONE.** On the leading edge, the HOME CAPSULE: the frame's
/// own plate, on the page colour and never the app's, because home is the one
/// thing an app may not take away (#883). Beside it, one plate of the app's own
/// destinations. A member always knows which half is Centraid and which half is
/// the app, and a back button that has scrolled or been swiped out of reach is
/// never the only way home.
///
/// **WHICH TAB IS LIT IS SAID THREE WAYS AT ONCE, all of them the system's:**
/// the held pair (`band` 400 → `control` 600, same rung, so nothing reflows),
/// the ink step (`textFaint` mark and `textSoft` label → full `text`), and the
/// rule. v0 said it with ink and the rule alone and set every label at 600,
/// which left four grey bold words and a hairline to hunt for; DESIGN.md's held
/// pair is what makes the lit tab legible at a glance.
///
/// **THE RULE SLIDES, AND IT SITS INSIDE THE PLATE.** Drawn on the plate's
/// top edge it merged with the hairline and read as a flaw in the border; it
/// now hangs one hairline below it, pill-ended, and moves from tab to tab on
/// the state-change curve (140 ms, `--ease`) so the eye follows the choice
/// rather than re-finding it. Reduced motion takes the slide away and keeps
/// the change.
///
/// **A PRESS IS SEEN AND FELT.** The pressed tab takes `bgPress` on the `md`
/// rung — a leaf token, never a container opacity — and a change of place is
/// the one selection tick (v0's `hapticSelect`, #1015 S15). Haptics are a
/// moment channel, not a visual state, so the tick fires on the change and not
/// on every touch.
///
/// **More is a tab in the plate** when the app has a More sheet, as v0 drew it,
/// and absent when it has none: a More that opened nothing would be a control
/// that lies.
///
/// Opaque, never glass: contrast must not depend on what was photographed.
struct AppBand: View {
    /// The app's id, for the identifiers a flow taps (`photos-band-library`).
    let app: String
    let tabs: [BandView]
    let onSelect: (Data) -> Void
    var onMore: (() -> Void)? = nil
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var rule

    /// The lit tab, as the thing the slide and the tick both key on.
    private var lit: String { tabs.first(where: \.selected)?.label ?? "" }

    var body: some View {
        HStack(spacing: BandMetrics.plateGap) {
            Button(action: onHome) {
                CentraidIconView(
                    iconKey: "Home",
                    tint: Theme.color("textSoft", scheme),
                    size: BandMetrics.iconSize,
                    strokeWidth: CentraidGeometry.appMarkStroke
                )
                // AS WIDE AS THE PLATE IS TALL — so the pill rung makes a
                // circle and not an oval. Both read one number.
                .frame(width: BandMetrics.height, height: BandMetrics.height)
                .contentShape(Circle())
            }
            // The frame's page colour, never the app's plate — and `bgPress`
            // while held, like every other press on the band.
            // A CIRCLE: the pill rung on a square is round, which is what
            // makes Home read as a button beside the app's plate and not as a
            // fifth tab that lost its label.
            .buttonStyle(BandPress(ground: "bg", inset: 0))
            .overlay(
                Capsule()
                    .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
            )
            .accessibilityLabel("Home")
            .accessibilityIdentifier("\(app)-band-home")

            // ONE plate; the gutter between the tabs is the seam.
            HStack(spacing: BandMetrics.groupGutter) {
                ForEach(tabs, id: \.self) { tab in
                    AppBandTab(
                        iconKey: tab.iconKey,
                        label: tab.label,
                        selected: tab.selected,
                        rule: rule,
                        identifier: "\(app)-band-\(tab.label.lowercased())",
                        onPress: { onSelect(tab.event) }
                    )
                }
                if let onMore {
                    AppBandTab(
                        iconKey: "MoreVert",
                        label: "More",
                        selected: false,
                        rule: rule,
                        identifier: "\(app)-band-more",
                        onPress: onMore
                    )
                }
            }
            .padding(BandMetrics.platePad)
            .frame(maxWidth: .infinity)
            .background(Theme.color("bgElev", scheme))
            .clipShape(Capsule())
            .overlay(
                Capsule()
                    .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
            )
            .animation(
                reduceMotion
                    ? nil
                    : .timingCurve(0.3, 0, 0.4, 1, duration: CentraidGeometry.durationOne / 1000),
                value: lit
            )
        }
        // The capsule takes the plate's height, whatever the plate's is.
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, BandMetrics.inset)
        .padding(.top, BandMetrics.topGap)
        .padding(.bottom, BandMetrics.floorPadding)
        .sensoryFeedback(.selection, trigger: lit)
        .accessibilityIdentifier("\(app)-band")
    }
}

/// ONE APP TAB — the Home band's tab, geometry for geometry (mark, gap,
/// padding, rungs), plus the rule. Two bands built from two tab shapes would
/// be two bands; this is one band with a place marker added.
private struct AppBandTab: View {
    let iconKey: String
    let label: String
    let selected: Bool
    let rule: Namespace.ID
    let identifier: String
    let onPress: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onPress) {
            VStack(spacing: BandMetrics.labelGap) {
                CentraidIconView(
                    iconKey: iconKey,
                    // Inactive is `textFaint`, as on the Home band: the mark
                    // recedes further than the word, so the lit tab's mark is
                    // the one ink shape in the strip.
                    tint: Theme.color(selected ? "text" : "textFaint", scheme),
                    size: BandMetrics.iconSize,
                    strokeWidth: CentraidGeometry.appMarkStroke
                )
                .frame(width: BandMetrics.markSize, height: BandMetrics.markSize)
                Text(label)
                    // THE HELD PAIR: one rung, two weights, no reflow.
                    .centraidType(selected ? "control" : "band")
                    .foregroundStyle(Theme.color(selected ? "text" : "textSoft", scheme))
                    .lineLimit(1)
            }
            .padding(.top, BandMetrics.tabTop)
            .padding(.bottom, BandMetrics.tabBottom)
            .frame(maxWidth: .infinity, minHeight: BandMetrics.tabMinHeight)
            .overlay(alignment: .top) {
                if selected {
                    // AS WIDE AS THE MARK IT STANDS OVER, not the tab: a rule
                    // spanning the tab lay along the plate's edge and read as
                    // a darker stretch of the border. Mark-wide, it is plainly
                    // a marker for the one ink shape under it.
                    Capsule()
                        .fill(Theme.color("text", scheme))
                        .frame(width: BandMetrics.markSize, height: BandMetrics.activeRule)
                        // At the tab's top, which is `platePad` inside the
                        // plate's edge — clear of its hairline, and still
                        // above the mark (which starts `tabTop` down).
                        .padding(.top, CentraidGeometry.hairline)
                        .matchedGeometryEffect(id: "rule", in: rule)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(BandPress(ground: nil, inset: 0))
        .accessibilityIdentifier(identifier)
        .accessibilityLabel(label + (selected ? ", current place" : ""))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
    }
}

/// THE BAND'S PRESS: `bgPress` under the finger, on the pill rung like the
/// plate it sits in, eased on the state-change curve. A ground and not a
/// scale, a dim or an opacity — DESIGN.md refuses all three — so the tab stays
/// exactly where it was and only its floor answers.
private struct BandPress: ButtonStyle {
    /// The resting ground, or none for a tab that sits on its plate.
    let ground: String?
    /// How far the pressed ground stands in from the tab's top and bottom, so
    /// it sits inside the plate rather than touching its edges.
    let inset: CGFloat

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let fill: Color = configuration.isPressed
            ? Theme.color("bgPress", scheme)
            : ground.map { Theme.color($0, scheme) } ?? .clear
        return configuration.label
            .background(
                Capsule()
                    .fill(fill)
                    .padding(.vertical, inset)
            )
            .animation(
                reduceMotion
                    ? nil
                    : .timingCurve(0.3, 0, 0.4, 1, duration: CentraidGeometry.durationOne / 1000),
                value: configuration.isPressed
            )
    }
}

/// The plate's geometry, mirroring `BandPolicy`'s constants.
///
/// They are read across the Kotlin boundary where the framework is present and
/// restated here as the SPM host build's floor, because `swift test` runs with
/// no Kotlin toolchain at all — see `ShellModel.swift`'s import guard. The
/// values are asserted equal by `ScreenFixtureTests`.
enum BandMetrics {
    // `BandPolicy`'s measures, restated for the SPM host build, which links no
    // Kotlin: the system Photos app's structure at Home's size. See
    // `BandPolicy.kt` for where each number comes from.
    /// From the screen's side edges — the page margin, so the band's edges fall
    /// on the tiles'.
    static let inset: CGFloat = CentraidGeometry.pageMargin
    /// From the screen's BOTTOM EDGE, into the home-indicator zone — see
    /// `floorPadding`.
    static let floor: CGFloat = 21
    static let topGap: CGFloat = 8
    /// The pill rung — `BandPolicy.BAND_RADIUS`. Drawn as `Capsule`, which is
    /// what a radius past half the height resolves to.
    static let radius: CGFloat = 999
    /// Between the plate's edge and the tabs, on every side.
    static let platePad: CGFloat = 4
    static let tabMinHeight: CGFloat = 46
    /// The plate, and so the home circle's side: a tab and its pad.
    static let height: CGFloat = tabMinHeight + 2 * platePad
    /// A Home tile's mark, so the band is never drawn heavier than the page.
    static let markSize: CGFloat = 22
    static let iconSize: CGFloat = 22
    /// A tab's column: 5 + mark + 1 + one `band` line (15) + 3 = 46.
    static let tabTop: CGFloat = 5
    static let labelGap: CGFloat = 1
    static let tabBottom: CGFloat = 3
    /// Between the home circle and the app's plate.
    static let plateGap: CGFloat = 8
    /// Between tabs inside the plate.
    static let groupGutter: CGFloat = 2
    /// The selection rule's thickness; it is as wide as the mark it marks.
    static let activeRule: CGFloat = 2

    // THE SEARCH BAR'S, read off the system Photos app with its keyboard up:
    // a 48 field and a 48 close circle, 8 from the screen's sides, 8 apart and
    // 8 above the keyboard; the magnifier (17) sits 10 into the field and the
    // text starts 36 in.
    static let searchHeight: CGFloat = 48
    static let searchInset: CGFloat = 8
    static let searchGlyph: CGFloat = 17
    static let searchGlyphLead: CGFloat = 10
    static let searchTextLead: CGFloat = 36
    // AND WITH THE KEYBOARD DOWN: the row moves into the band's slot — the
    // same 62 box, 21 from the edges — and its 48 circles and field sit
    // centred in it (7 in), 12 apart, with the tab the member came from as a
    // circle on the leading end.
    static let searchRestPad: CGFloat = (height - searchHeight) / 2
    static let searchRestGap: CGFloat = 12

    /// THE BOTTOM PADDING THAT PUTS THE PLATE `floor` FROM THE SCREEN'S EDGE.
    ///
    /// A band is laid out inside the safe area, whose bottom on a phone with a
    /// home indicator is 34 up. The system's bar sits 21 from the glass, so the
    /// band pads by the difference — negative there, drawing 13 into the
    /// indicator's zone exactly as the system does — and by the whole 21 on a
    /// phone with no indicator.
    @MainActor static var floorPadding: CGFloat {
        #if canImport(UIKit)
        let bottom = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .safeAreaInsets.bottom ?? 0
        return floor - bottom
        #else
        return floor
        #endif
    }
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
