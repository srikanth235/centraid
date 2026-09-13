package dev.centraid.shared.screen

/**
 * THE BAND — invariant 1 of the Binding Layer (#1020, wave A).
 *
 * One band, never app-themed, never scrolled away. It lists FRAME PLACES and
 * never installed apps: Home, the pinned places, and More. Apps are covers
 * pushed over Home, which is why this is native-stack chrome drawn at the foot
 * of Home rather than a bottom-tab navigator — a tab bar would make every app a
 * peer of Home and there would be nowhere for a cover to come from.
 *
 * Ported from v0's `apps/mobile/src/screens/home/places.ts` and `band.ts`, whose
 * seam it keeps: this file decides WHICH destinations the band offers and in
 * what order, and it never decides where a press goes — that is the navigator's.
 *
 * KEEP IT PURE. No storage, no platform, no clock: `bandTabs` takes the pinned
 * ids and returns a list, which is what lets both shells draw one band without
 * either of them holding the rule.
 */
public object BandPolicy {
    /**
     * The ten frame destinations, in FIXED order.
     *
     * Never sorted by recency: a band that reordered itself would move the
     * target under a member's thumb, which is the same law the springboard
     * follows. Readers FILTER this list and never reorder it.
     *
     * Starred was an eleventh until v0's `#1015` B15 — a row that navigated
     * nowhere and could still be pinned into a band slot. It is dropped rather
     * than shipped dead.
     */
    public val PLACES: List<Place> = listOf(
        Place(
            id = "home",
            name = "Home",
            short = "Home",
            iconKey = "Home",
            what = "The springboard — every app with something in it",
            // Pinned BY LAW: its row shows "by law", not a switch.
            law = true,
            pinnedByDefault = true,
        ),
        Place(
            id = "notifs",
            // ONE NOUN PER DESTINATION. v0 shipped four names for this one
            // place at once (`#1015` R-NY-4) because the band spoke one noun to
            // VoiceOver and painted another; [short] may only DROP words from
            // [name], never substitute a different noun.
            name = "Needs you",
            short = "Needs you",
            iconKey = "Bell",
            what = "Decisions waiting on you",
            law = false,
            pinnedByDefault = true,
        ),
        Place(
            id = "stats",
            name = "Activity",
            short = "Activity",
            // Bars, not a pulse: Activity is liveness, a chart is a settled reading.
            iconKey = "BarChart2",
            what = "Runs, failures, harnesses, models and spend",
            law = false,
            pinnedByDefault = true,
        ),
        Place(
            id = "data",
            name = "Vault",
            short = "Vault",
            // Records, not files — `Folder` is already documents the member filed.
            iconKey = "Database",
            what = "Contents, copies and sharing",
            law = false,
            pinnedByDefault = true,
        ),
        Place(
            id = "autos",
            name = "Rules",
            short = "Rules",
            iconKey = "Bolt",
            what = "The standing rules that run on your vault's home machine",
            law = false,
            pinnedByDefault = false,
        ),
        Place(
            id = "conn",
            name = "Connectors",
            short = "Connectors",
            iconKey = "Plug",
            what = "What is allowed to reach outside",
            law = false,
            pinnedByDefault = false,
        ),
        Place(
            id = "devices",
            name = "Copies",
            short = "Copies",
            // A desk machine AND a handset: one monitor standing for a set of
            // screens is wrong.
            iconKey = "Devices",
            what = "The machines holding a copy",
            law = false,
            pinnedByDefault = false,
        ),
        Place(
            id = "gateway",
            name = "System",
            short = "System",
            iconKey = "Cellular",
            what = "The machine this vault lives on",
            law = false,
            pinnedByDefault = false,
        ),
        Place(
            id = "storage",
            name = "On this phone",
            short = "On phone",
            iconKey = "Save",
            what = "Cached data, pending uploads and room",
            law = false,
            pinnedByDefault = false,
        ),
        Place(
            id = "settings",
            name = "Settings",
            short = "Settings",
            iconKey = "Settings",
            what = "The account, the themes, the keys",
            law = false,
            pinnedByDefault = false,
        ),
    )

    /**
     * Home plus four, and then More.
     *
     * A sixth destination puts every target under 44pt on a 390px screen, so
     * this is a constraint and not a preference. A sixth pinned place overflows
     * into More however many are pinned.
     */
    public const val BAND_PLACE_SLOTS: Int = 4

    /** The places pinned when nobody has said otherwise. */
    public val DEFAULT_PINS: List<String> =
        PLACES.filter { !it.law && it.pinnedByDefault }.map { it.id }

    /**
     * System is reachable by link and never by band.
     *
     * It is a custodian surface; its route still resolves, so a saved link never
     * dead-ends, but it does not spend one of five slots.
     */
    private const val NOT_IN_BAND: String = "gateway"

    public fun place(id: String): Place? = PLACES.firstOrNull { it.id == id }

    /** Home is pinned by law; everything else is pinned when the member says so. */
    public fun isPinned(pins: List<String>, id: String): Boolean {
        val place = place(id) ?: return false
        return place.law || pins.contains(id)
    }

    /**
     * The band's tabs: Home first, then pinned places in TABLE order, capped.
     *
     * `More` is not in this list — each shell draws it beside the tabs, because
     * it is not a place and a "···" in a bordered square is not a destination
     * mark.
     */
    public fun bandTabs(pins: List<String> = DEFAULT_PINS): List<Place> {
        val pinned = PLACES.filter { it.id != NOT_IN_BAND && isPinned(pins, it.id) }
        val home = pinned.firstOrNull() ?: return emptyList()
        return listOf(home) + pinned.drop(1).take(BAND_PLACE_SLOTS)
    }

    /** One frame destination that is not an app. */
    public data class Place(
        val id: String,
        val name: String,
        /**
         * The band tab is 61px wide: a declared short name, never an ellipsised
         * long one. See the `notifs` comment for the rule it must obey.
         */
        val short: String,
        val iconKey: String,
        val what: String,
        val law: Boolean,
        val pinnedByDefault: Boolean,
    )

    // ── the plate ────────────────────────────────────────────────────────────
    //
    // ONE DEFINITION, so the two bands cannot drift. The band FLOATS: it is
    // inset from all three edges and sits on the page's own elevated ground
    // with one hairline — not `bg`, because a page colour does not float, and
    // not `bgChrome`, which sinks on dark.

    /** The inset from the screen edge, and the lift over the home indicator. */
    public const val BAND_INSET: Int = 12

    /** The gap between the scrolling page and the plate. */
    public const val BAND_TOP_GAP: Int = 8

    public const val BAND_RADIUS: Int = 12

    /** A FLOOR, not a reserve: the band is a sibling, so nothing subtracts it. */
    public const val BAND_TAB_MIN_HEIGHT: Int = 52

    /** The glyph slot, which is not the launcher's 26. */
    public const val BAND_MARK_SIZE: Int = 30

    /** The icon inside that slot. */
    public const val BAND_ICON_SIZE: Int = 19
}
