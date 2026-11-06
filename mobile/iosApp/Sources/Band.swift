import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// THE BAND — invariant 1 (#1020, wave A; v0 `screens/home/HomeBand.tsx`).
///
/// One band, never app-themed, never scrolled away, frame destinations only.
/// Rust (`Navigation.band`) decides which destinations and in what order; this
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
///
/// One place in the band, as Rust worded it (`ShellBandTab`) or, for the two
/// places this shell still hosts itself, as `HomeView` words them for now.
struct BandPlace: Hashable {
    let id: String
    let label: String
    let spoken: String
    let iconKey: String
    let selected: Bool
}

struct HomeBand: View {
    let places: [BandPlace]
    let onSelect: (String) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 0) {
            ForEach(places, id: \.id) { place in
                BandTab(
                    iconKey: place.iconKey,
                    label: place.label,
                    // SPEAK WHAT IS PAINTED, and which place is the current one.
                    spoken: place.spoken,
                    selected: place.selected,
                    identifier: "home-band-\(place.id)",
                    onPress: { onSelect(place.id) }
                )
            }
        }
        .padding(BandMetrics.platePad)
        // THE BAND FLOATS (§G), never a flush bar, on the same ground as every
        // app's band: Liquid Glass on iOS 26, the fallback before it, and solid
        // `bgElev` with its `lineStrong` edge under Reduce Transparency or
        // Increase Contrast. A pill, so the ends are exact semicircles.
        .bandGround(Capsule())
        .padding(.horizontal, BandMetrics.inset)
        .padding(.top, BandMetrics.topGap)
        .padding(.bottom, BandMetrics.floorPadding)
        // `.contain`, or the plate's identifier REPLACES each tab's own: the
        // hierarchy showed every tab as `home-band`, so no flow could select
        // Chat or More by id.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home-band")
    }
}

private struct BandTab: View {
    let iconKey: String
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
                        tint: selected ? Surface.ink : Surface.meta,
                        size: BandMetrics.iconSize,
                        strokeWidth: CentraidGeometry.appMarkStroke
                    )
                }
                .frame(width: BandMetrics.markSize, height: BandMetrics.markSize)
                Text(label)
                    // The same 11/15 rung either way, so a tap cannot reflow
                    // the strip, and it HOLDS at every text size: `control`
                    // scales elsewhere, so the active half says `scales: false`.
                    .centraidType(selected ? "control" : "band", scales: false)
                    .foregroundStyle(selected ? Surface.ink : Surface.meta)
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

/// AN APP'S BAND — the `AppPlace` room's band (product-intuition/references/design-behaviour.md § Rooms),
/// copied from v0's (`apps/mobile/src/apps/photos/PhotosBand.tsx`,
/// `kit/band/BandCapsule.tsx`, `kit/band-surface.ts`).
///
/// **TWO PLATES, NOT ONE, AND A KEY AT EACH END.** On the leading edge, the HOME CAPSULE: the
/// frame's own plate, on the page colour and never the app's, because home is the one
/// thing an app may not take away (#883). Beside it, one plate of the app's own
/// destinations, and — where the app has search — a round SEARCH KEY at the trailing edge, the
/// Home circle's twin (`BandKey`), so search is always the same circle in the same place. A member always knows which half is
/// Centraid and which half is the app, and a back button that has scrolled or been swiped out of reach is
/// never the only way home.
///
/// **WHICH TAB IS LIT IS SAID THREE WAYS AT ONCE, all of them the system's:**
/// the held pair (`band` 400 → `control` 600, same rung, so nothing reflows),
/// the ink step (`textFaint` mark and `textSoft` label → full `text`), and the
/// rule. v0 said it with ink and the rule alone and set every label at 600,
/// which left four grey bold words and a hairline to hunt for; the held (design/mockups/DesignRules.dc.html)
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
/// **THE GROUND IS THE PLATFORM'S OWN, AND CONTENT RUNS UNDER IT** (`BandGround`): real Liquid
/// Glass on iOS 26 and later, the system material before it. The Home circle, the plate and the
/// search key are one glass family (`BandGlassGroup`). Under Reduce Transparency or Increase
/// Contrast it is the solid paper it used to be, so contrast then depends on nothing that was
/// photographed.
struct AppBand: View {
    /// The app's id, for the identifiers a flow taps (`photos-band-library`).
    let app: String
    let tabs: [BandView]
    let onSelect: (Data) -> Void
    var onMore: (() -> Void)? = nil
    /// A segmented control the page asks the band to carry (Photos' Years · Months · All). Empty
    /// is none, and the plate of places is what the band draws. With some, the places FOLD
    /// into one leading key, as the system's tab bar folds when an accessory takes the middle,
    /// and the control stands between that key and the search key; the key brings the plate
    /// back, and a pick of a place puts the control back.
    var segments: [BandSegment] = []
    var onSegment: (String) -> Void = { _ in }
    let onHome: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The app's search, when it has one (`AppPlace` hands it down; see `SearchSlot`).
    @Environment(\.bandSearchKey) private var searchKey
    @Namespace private var rule
    /// The plate of places is out in place of the segments (the member asked for it).
    @State private var placesOpen = false

    private var folded: Bool { !segments.isEmpty && !placesOpen }

    /// The lit tab, as the thing the slide and the tick both key on.
    private var lit: String { tabs.first(where: \.selected)?.label ?? "" }

    var body: some View {
        BandGlassGroup(spacing: BandMetrics.groupSpacing) {
        HStack(spacing: BandMetrics.plateGap) {
            // The frame's page colour, never the app's plate — a CIRCLE, which is what makes
            // Home read as a button beside the app's plate and not as a fifth tab that lost its
            // label.
            BandKey(
                iconKey: "Home",
                spoken: KitWords.BAND_HOME,
                identifier: "\(app)-band-home",
                action: onHome
            )

            if folded {
                // THE PLACES, FOLDED: one key for where the member is, the same circle as Home
                // and search, and the segments in the middle.
                BandKey(
                    iconKey: tabs.first(where: \.selected)?.iconKey ?? tabs.first?.iconKey ?? "Image",
                    spoken: lit.isEmpty ? (tabs.first?.label ?? "") : lit,
                    identifier: "\(app)-band-places",
                    action: { placesOpen = true }
                )
                BandSegmented(segments: segments, onPick: onSegment)
            } else if !tabs.isEmpty || onMore != nil {
            // ONE plate; the gutter between the tabs is the seam. NO PLATE
            // AT ALL with no tabs (a locked Locker, #1047): an empty capsule
            // is a control that does nothing.
            HStack(spacing: BandMetrics.groupGutter) {
                ForEach(tabs, id: \.self) { tab in
                    AppBandTab(
                        iconKey: tab.iconKey,
                        label: tab.label,
                        selected: tab.selected,
                        rule: rule,
                        identifier: "\(app)-band-\(tab.key.isEmpty ? tab.label.lowercased() : tab.key)",
                        onPress: {
                            placesOpen = false
                            onSelect(tab.event)
                        }
                    )
                }
                if let onMore {
                    AppBandTab(
                        iconKey: "MoreHoriz",
                        label: KitWords.BAND_MORE,
                        selected: false,
                        rule: rule,
                        identifier: "\(app)-band-more",
                        onPress: onMore
                    )
                }
            }
            .padding(BandMetrics.platePad)
            .frame(maxWidth: .infinity)
            .bandGround(Capsule(), solid: "bgElev")
            .animation(
                reduceMotion
                    ? nil
                    : .timingCurve(0.3, 0, 0.4, 1, duration: CentraidGeometry.durationOne / 1000),
                value: lit
            )
            } else {
                Spacer(minLength: 0)
            }

            // THE APP'S SEARCH, at the trailing end — the same circle, the same glass and the
            // same size as Home's at the leading end, with the magnifier Home's own search key
            // wears. An app with no search slot hands none, and draws none. The id is the same
            // on both shells and in every app, because the key is the kit's and not the app's.
            if let searchKey {
                BandKey(
                    iconKey: "Search",
                    spoken: searchKey.label,
                    identifier: "band-search",
                    action: searchKey.onOpen
                )
            }
        }
        // The capsule takes the plate's height, whatever the plate's is.
        .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, BandMetrics.inset)
        .padding(.top, BandMetrics.topGap)
        .padding(.bottom, BandMetrics.floorPadding)
        .sensoryFeedback(.selection, trigger: lit)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: folded)
        // `.contain`, as on Home's band: without it the container's identifier
        // REPLACES each tab's own, and every tab reads `<app>-band` (#1128's
        // flows found it).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(app)-band")
    }
}

/// ONE SEGMENT of a band's segmented control: the machine's key, its word, whether it is lit.
struct BandSegment: Hashable {
    let id: String
    let label: String
    var selected: Bool = false
}

/// THE BAND'S SEGMENTED CONTROL: a plate of words between the folded place key and the search
/// key, the plate's own height and ground, each segment a 44pt-wide target at least. The lit one
/// takes the held pair (`band` 400 to `control` 600, one rung, so a tap reflows nothing) and the
/// selected ground, `bgSunken`, never an accent.
struct BandSegmented: View {
    let segments: [BandSegment]
    let onPick: (String) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: BandMetrics.groupGutter) {
            ForEach(segments, id: \.id) { segment in
                Button { onPick(segment.id) } label: {
                    Text(segment.label)
                        .centraidType(segment.selected ? "control" : "band", scales: false)
                        .foregroundStyle(segment.selected ? Surface.ink : Surface.meta)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity, minHeight: BandMetrics.tabMinHeight)
                        .background(
                            Capsule().fill(segment.selected ? Surface.fill : .clear)
                        )
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(segment.id)
                .accessibilityLabel(segment.label)
                .accessibilityAddTraits(segment.selected ? [.isButton, .isSelected] : [.isButton])
            }
        }
        .padding(BandMetrics.platePad)
        .frame(maxWidth: .infinity)
        .bandGround(Capsule(), solid: "bgElev")
    }
}

/// A ROUND KEY ON THE BAND: Home at the leading end and the app's search at the trailing end are
/// this one view — as wide as the plate is tall, so the pill rung makes a circle and not an oval,
/// on the same glass (`bandGround`, `bg` when solid). On iOS 26 the glass itself answers the
/// finger; wherever it is not glass, `bgPress` is the held ground, like every other press on the band.
struct BandKey: View {
    let iconKey: String
    let spoken: String
    let identifier: String
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let liquid = BandMetrics.usesLiquidGlass(reduceTransparency: reduceTransparency, contrast: contrast)
        Button(action: action) {
            CentraidIconView(
                iconKey: iconKey,
                tint: Surface.ink,
                size: BandMetrics.iconSize,
                strokeWidth: CentraidGeometry.appMarkStroke
            )
            .frame(width: BandMetrics.height, height: BandMetrics.height)
            .contentShape(Circle())
        }
        .buttonStyle(BandPress(inset: 0, paints: !liquid))
        .bandGround(Circle(), solid: "bg", interactive: true)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier(identifier)
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
                    tint: selected ? Surface.ink : Surface.meta,
                    size: BandMetrics.iconSize,
                    strokeWidth: CentraidGeometry.appMarkStroke
                )
                .frame(width: BandMetrics.markSize, height: BandMetrics.markSize)
                Text(label)
                    // THE HELD PAIR: one rung, two weights, no reflow — and it
                    // holds at every text size (`control` scales elsewhere).
                    .centraidType(selected ? "control" : "band", scales: false)
                    .foregroundStyle(selected ? Surface.ink : Surface.meta)
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
                        .fill(Surface.ink)
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
        .buttonStyle(BandPress(inset: 0))
        .accessibilityIdentifier(identifier)
        .accessibilityLabel(label + (selected ? ", " + KitWords.BAND_CURRENT : ""))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
    }
}

/// THE BAND'S PRESS: `bgPress` under the finger, on the pill rung like the
/// plate it sits in, eased on the state-change curve. A ground and not a
/// scale, a dim or an opacity — product-intuition/references/design-behaviour.md § Controls refuses all three — so the tab stays
/// exactly where it was and only its floor answers.
private struct BandPress: ButtonStyle {
    /// How far the pressed ground stands in from the tab's top and bottom, so
    /// it sits inside the plate rather than touching its edges.
    let inset: CGFloat
    /// False for a key on Liquid Glass, whose own glass answers the finger.
    var paints: Bool = true

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        // THE RESTING GROUND IS THE PLATE'S (`BandGround`), so the style paints only the press.
        let fill: Color = configuration.isPressed && paints ? Surface.fill : .clear
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

/// THE BAND'S GROUND, ONCE FOR EVERY BAND (design/mockups/DesignRules.dc.html): the platform's own
/// glass over whatever the page scrolls under it, or the paper it falls back to. This is the ONE
/// place the shell asks which OS it is on; no band, key or bar decides that for itself.
///
/// **iOS 26 AND LATER: REAL LIQUID GLASS** (`.glassEffect`), on floating controls only: the app
/// band's plate, its round keys, the search field and its ✕, and the Photos selection bars.
/// Content (lists, cards, sheets) stays paper. A control that is a key says `interactive` so the
/// glass answers the finger itself; a plate holding several tabs does not, because the press is
/// each tab's. The glass draws its own edge and its own depth, so nothing is added to it: no
/// tint, no hairline, no shadow.
///
/// **THE FALLBACK IS ONE SIMPLE RULE, NOT A SECOND DESIGN.** iOS 17.5 to 25 has no glass, so the
/// plate is the system's own material (`.thinMaterial`) with no tint laid over it. Reduce
/// Transparency and Increase Contrast, on any OS, both mean "do not make me read through a blur",
/// so either one puts the plate on `solid` (the token it was always drawn on, which the caller
/// names) and `BandStrip` puts the page colour back under the strip. Either fallback keeps the
/// plate's hairline; glass has no need of one.
struct BandGround<S: InsettableShape>: ViewModifier {
    let shape: S
    /// The token the plate is drawn on when it is not glass.
    let solid: String
    /// A key the glass should answer to the finger (a round key, not a plate of tabs).
    let interactive: Bool

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        if #available(iOS 26, *), BandMetrics.isGlass(reduceTransparency: reduceTransparency, contrast: contrast) {
            content.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            content
                .background {
                    if BandMetrics.isGlass(reduceTransparency: reduceTransparency, contrast: contrast) {
                        shape.fill(.thinMaterial)
                    } else {
                        shape.fill(Surface.card)
                    }
                }
                .overlay(
                    shape.strokeBorder(Surface.border, lineWidth: CentraidGeometry.hairline)
                )
        }
    }
}

/// THE BAND'S SHAPES THAT SIT TOGETHER, so on iOS 26 their glass is one family: it is sampled
/// together, and shapes that come within `spacing` of each other morph into one another as they
/// arrive and leave. Before iOS 26 (and wherever glass is off) there is no container and the
/// content is drawn as it is.
struct BandGlassGroup<Content: View>: View {
    let spacing: CGFloat
    @ViewBuilder let content: () -> Content

    var body: some View {
        if #available(iOS 26, *) {
            GlassEffectContainer(spacing: spacing) { content() }
        } else {
            content()
        }
    }
}

/// WHAT THE BAND STANDS ON: nothing under glass, so the content that scrolls
/// beneath the plates shows around and through them; the page colour under the
/// solid fallback, so the strip is the slab it was.
struct BandStrip: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        content.background {
            if !BandMetrics.isGlass(reduceTransparency: reduceTransparency, contrast: contrast) {
                Surface.page.ignoresSafeArea(edges: .bottom)
            }
        }
    }
}

extension View {
    /// A band plate's ground, in `shape`: the platform's glass, or `solid` where glass is off.
    /// `interactive` is for a round key, whose glass answers the finger.
    func bandGround<S: InsettableShape>(_ shape: S, solid: String = "bgElev", interactive: Bool = false) -> some View {
        modifier(BandGround(shape: shape, solid: solid, interactive: interactive))
    }

    /// The strip a band stands on (see `BandStrip`).
    func bandStrip() -> some View {
        modifier(BandStrip())
    }
}

/// The plate's geometry, the same measures Compose draws (`BandPolicy` in `BandGeometry.kt`), so
/// the two shells draw one band.
enum BandMetrics {
    /// Glass unless the member asked not to read through a blur, by either of
    /// the two settings that say so: Reduce Transparency, or Increase Contrast.
    static func isGlass(reduceTransparency: Bool, contrast: ColorSchemeContrast) -> Bool {
        !reduceTransparency && contrast != .increased
    }

    /// Whether the plate is REAL Liquid Glass: glass, on an OS that has it. Only a round key asks,
    /// to know whether the glass answers the finger or the pressed ground (`BandPress`) must.
    static func usesLiquidGlass(reduceTransparency: Bool, contrast: ColorSchemeContrast) -> Bool {
        if #available(iOS 26, *) {
            return isGlass(reduceTransparency: reduceTransparency, contrast: contrast)
        }
        return false
    }

    // THE SYSTEM PHOTOS APP'S STRUCTURE AT HOME'S SIZE: a pill whose tabs stand 4
    // in from its edge, 21 from the screen's bottom edge; the mark is the tiles'
    // own 22, the tab what a 22 mark and one label line need, and the sides the
    // page margin, so the band's edges fall on the tiles' edges.
    /// From the screen's side edges — the page margin, so the band's edges fall
    /// on the tiles'.
    static let inset: CGFloat = 18
    /// From the screen's BOTTOM EDGE, into the home-indicator zone — see
    /// `floorPadding`.
    static let floor: CGFloat = 21
    static let topGap: CGFloat = 8
    /// The pill rung. Drawn as `Capsule`, which is what a radius past half the
    /// height resolves to.
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
    // THIS SHELL'S OWN: the policy states no gap between the home circle and the
    // plate, nor the search bar's measures.
    /// Between the home circle and the app's plate.
    static let plateGap: CGFloat = 8
    /// How near two glass shapes must come before they melt into one another (`BandGlassGroup`).
    /// Under `plateGap`, so the band's resting shapes stay three and only a shape arriving or
    /// leaving morphs.
    static let groupSpacing: CGFloat = 4
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
