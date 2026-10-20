import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

import CentraidShared

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
                    spoken: place.short + (place.id == active ? ", " + SharedCopy.shared.BAND_CURRENT_SPOKEN : ""),
                    selected: place.id == active,
                    identifier: "home-band-\(place.id)",
                    onPress: { onSelect(place.id) }
                )
            }
            // BACKUP, the band's last place: a tab like Chat, drawn in place of
            // the springboard — where the backup stands, the backup devices
            // and the 24 words — so a member never hunts for the one thing
            // that brings the vault back. Every app is a tile on Home.
            BandTab(
                iconKey: "Backup",
                label: HomeWords.shared.BAND_BACKUP,
                spoken: HomeWords.shared.BAND_BACKUP_SPOKEN + (active == BandPolicy.shared.PLACE_BACKUP ? ", " + SharedCopy.shared.BAND_CURRENT_SPOKEN : ""),
                selected: active == BandPolicy.shared.PLACE_BACKUP,
                identifier: "home-band-backup",
                onPress: { onSelect(BandPolicy.shared.PLACE_BACKUP) }
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
                        tint: Theme.color(selected ? "text" : "textFaint", scheme),
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
            .accessibilityLabel(HomeWords.shared.BAND_HOME)
            .accessibilityIdentifier("\(app)-band-home")

            // ONE plate; the gutter between the tabs is the seam. NO PLATE
            // AT ALL with no tabs (a locked Locker, #1047): an empty capsule
            // is a control that does nothing.
            if !tabs.isEmpty || onMore != nil {
            HStack(spacing: BandMetrics.groupGutter) {
                ForEach(tabs, id: \.self) { tab in
                    AppBandTab(
                        iconKey: tab.iconKey,
                        label: tab.label,
                        selected: tab.selected,
                        rule: rule,
                        identifier: "\(app)-band-\(tab.key.isEmpty ? tab.label.lowercased() : tab.key)",
                        onPress: { onSelect(tab.event) }
                    )
                }
                if let onMore {
                    AppBandTab(
                        iconKey: "MoreHoriz",
                        label: HomeWords.shared.BAND_MORE,
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
            } else {
                Spacer(minLength: 0)
            }
        }
        // The capsule takes the plate's height, whatever the plate's is.
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, BandMetrics.inset)
        .padding(.top, BandMetrics.topGap)
        .padding(.bottom, BandMetrics.floorPadding)
        .sensoryFeedback(.selection, trigger: lit)
        // `.contain`, as on Home's band: without it the container's identifier
        // REPLACES each tab's own, and every tab reads `<app>-band` (#1128's
        // flows found it).
        .accessibilityElement(children: .contain)
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
                    // THE HELD PAIR: one rung, two weights, no reflow — and it
                    // holds at every text size (`control` scales elsewhere).
                    .centraidType(selected ? "control" : "band", scales: false)
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
        .accessibilityLabel(label + (selected ? ", " + SharedCopy.shared.BAND_CURRENT_SPOKEN : ""))
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

/// The plate's geometry. The measures `BandPolicy` owns are read from it, so
/// Compose and SwiftUI draw one band; the rest are this shell's own.
enum BandMetrics {
    // `BandPolicy`'s measures: the system Photos app's structure at Home's size.
    // See `BandPolicy.kt` for where each number comes from.
    /// From the screen's side edges — the page margin, so the band's edges fall
    /// on the tiles'.
    static let inset = CGFloat(BandPolicy.shared.BAND_INSET)
    /// From the screen's BOTTOM EDGE, into the home-indicator zone — see
    /// `floorPadding`.
    static let floor = CGFloat(BandPolicy.shared.BAND_FLOOR)
    static let topGap = CGFloat(BandPolicy.shared.BAND_TOP_GAP)
    /// The pill rung. Drawn as `Capsule`, which is what a radius past half the
    /// height resolves to.
    static let radius = CGFloat(BandPolicy.shared.BAND_RADIUS)
    /// Between the plate's edge and the tabs, on every side.
    static let platePad = CGFloat(BandPolicy.shared.BAND_PLATE_PAD)
    static let tabMinHeight = CGFloat(BandPolicy.shared.BAND_TAB_MIN_HEIGHT)
    /// The plate, and so the home circle's side: a tab and its pad.
    static let height = CGFloat(BandPolicy.shared.BAND_HEIGHT)
    /// A Home tile's mark, so the band is never drawn heavier than the page.
    static let markSize = CGFloat(BandPolicy.shared.BAND_MARK_SIZE)
    static let iconSize = CGFloat(BandPolicy.shared.BAND_ICON_SIZE)
    /// A tab's column: 5 + mark + 1 + one `band` line (15) + 3 = 46.
    static let tabTop = CGFloat(BandPolicy.shared.BAND_TAB_TOP)
    static let labelGap = CGFloat(BandPolicy.shared.BAND_LABEL_GAP)
    static let tabBottom = CGFloat(BandPolicy.shared.BAND_TAB_BOTTOM)
    // THIS SHELL'S OWN: the policy states no gap between the home circle and the
    // plate, nor the search bar's measures.
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
enum BandDestinations {
    struct Place {
        let id: String
        let short: String
        let iconKey: String
    }

    static var tabs: [Place] {
        var places = BandPolicy.shared.bandTabs(pins: BandPolicy.shared.DEFAULT_PINS).map {
            // `short_`, not `short`: Kotlin/Native suffixes a name that
            // collides with an Objective-C keyword, and `short` is a C type.
            Place(id: $0.id, short: $0.short_, iconKey: $0.iconKey)
        }
        // CHAT IS THE BAND'S SECOND PLACE, BETWEEN HOME AND MORE. It is added
        // here and not to `BandPolicy.PLACES` because the on-device chat has
        // only this shell so far: a shared policy row would draw a Chat tab on
        // Android that opens nothing, which is a control that lies. When
        // Android ships chat the row moves into the policy and this line goes.
        //
        // ITS MARK IS THE ASSISTANT'S, NOT A SPEECH BUBBLE: the chat is the
        // on-device assistant, and `Sparkle` is the design system's `ask`
        // concept (`ICON_CONCEPTS`), so the tab and every ask key agree.
        if let home = places.firstIndex(where: { $0.id == BandPolicy.shared.PLACE_HOME }) {
            places.insert(Place(id: BandPolicy.shared.PLACE_CHAT, short: ChatCopy.shared.TAB_LABEL, iconKey: "Sparkle"), at: home + 1)
        }
        return places
    }
}
