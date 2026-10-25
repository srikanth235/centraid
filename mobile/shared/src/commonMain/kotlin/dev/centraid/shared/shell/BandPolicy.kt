package dev.centraid.shared.shell

/**
 * THE BAND'S PLATE, as numbers (#1135).
 *
 * Which places the band holds, in what order, their words and which is lit are
 * Rust's (`crates/screens/src/shell/band.rs`, carried in `Navigation.band`). What
 * stays here is the plate's geometry both native shells read, until the shells
 * hold their own numbers and this module goes. The pins, `PLACES` and the
 * overflow into More were machinery nothing drew and went with Home's port.
 */
public object BandPolicy {
    /**
     * THE RUNTIME TABS the band's places select (`Navigation.band`). Chat and
     * Backup are drawn natively in place of Home's springboard until lanes I and
     * H2 register their Rust tabs.
     */
    public const val PLACE_HOME: String = "home"
    public const val PLACE_CHAT: String = "chat"
    public const val PLACE_BACKUP: String = "backup"

    // ── the plate ────────────────────────────────────────────────────────────
    //
    // ONE DEFINITION, so the two bands cannot drift. The band FLOATS: it is
    // inset from all three edges and sits on the page's own elevated ground
    // with one hairline — not `bg`, because a page colour does not float, and
    // not `bgChrome`, which sinks on dark.

    // THE BAND IS SIZED TO THE PAGE IT SITS UNDER. Its STRUCTURE is the system
    // Photos app's (iOS 26, read off its view hierarchy): a pill whose tabs stand
    // 4 in from its edge, 21 from the screen's bottom edge. Its SIZE is Home's:
    // the system's 62pt bar and 28pt glyph were drawn for a full-bleed photo grid,
    // and over a page of 22pt-marked tiles they made the navigation heavier than
    // the content — a sixth, darker tile. So the mark is the tiles' own 22, the
    // tab is what a 22 mark and one label line need, and the sides are the page
    // margin, so the band's edges fall on the tiles' edges.

    /** The inset from the screen's side edges — the page margin (18). */
    public const val BAND_INSET: Int = 18

    /**
     * From the screen's BOTTOM EDGE to the plate — not from the safe area. The
     * system sits its bar in the home-indicator zone (13pt into it on a phone
     * with one); a band that stacked a gap on top of the safe area floated
     * visibly higher than every system bar a member has seen.
     */
    public const val BAND_FLOOR: Int = 21

    /** Between the plate's edge and the tabs inside it, on every side. */
    public const val BAND_PLATE_PAD: Int = 4

    /** The gap between the scrolling page and the plate. */
    public const val BAND_TOP_GAP: Int = 8

    /**
     * THE PILL RUNG (`radii.pill`), so every band plate is fully round at the
     * ends and the home capsule beside an app's plate is a circle.
     *
     * It was `lg` (12), v0's `BAND_RADIUS`. A band now reads as navigation
     * floating over the page rather than one more card in it: the cards and
     * tiles keep `lg`, and the only fully round surfaces on a screen are the
     * places a member moves between. There is no rung between `lg` and `pill`,
     * so "rounder" could only mean this or a number nobody chose. A renderer
     * clamps the radius to half the plate's height; 999 is the token's own
     * value, not a size.
     */
    public const val BAND_RADIUS: Int = 999

    /** A FLOOR, not a reserve: the band is a sibling, so nothing subtracts it. */
    public const val BAND_TAB_MIN_HEIGHT: Int = 46

    /** The plate's height: a tab and the pad above and below it. */
    public const val BAND_HEIGHT: Int = BAND_TAB_MIN_HEIGHT + 2 * BAND_PLATE_PAD

    /** The glyph slot, which is not the launcher's 26. */
    public const val BAND_MARK_SIZE: Int = 22

    /** The icon inside that slot — the slot's full size: a Home tile's mark. */
    public const val BAND_ICON_SIZE: Int = 22

    /**
     * A tab's own column: 5 over the mark, 1 between mark and label, and 3
     * under the label's one line of the `band` rung (11 / 15) — 5 + 22 + 1 +
     * 15 + 3 = 46, the tab's height.
     */
    public const val BAND_TAB_TOP: Int = 5
    public const val BAND_LABEL_GAP: Int = 1
    public const val BAND_TAB_BOTTOM: Int = 3
}
