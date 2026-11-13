package dev.centraid.android.kit

/**
 * THE BAND'S GEOMETRY, IN DP (design/behaviour.md § App roots; the iOS band draws the same numbers): the
 * plate's inset and floor, its padding and corner, a place's height and spacing, its mark. Pure
 * layout: which places the band holds, their words and which is lit are Rust's (`ShellBand`).
 */
internal object BandPolicy {
    const val BAND_INSET: Int = 18
    const val BAND_FLOOR: Int = 21
    const val BAND_PLATE_PAD: Int = 4
    const val BAND_TOP_GAP: Int = 8
    const val BAND_RADIUS: Int = 999
    const val BAND_TAB_MIN_HEIGHT: Int = 46
    const val BAND_HEIGHT: Int = BAND_TAB_MIN_HEIGHT + 2 * BAND_PLATE_PAD
    const val BAND_MARK_SIZE: Int = 22
    const val BAND_ICON_SIZE: Int = 22
    const val BAND_TAB_TOP: Int = 5
    const val BAND_LABEL_GAP: Int = 1
    const val BAND_TAB_BOTTOM: Int = 3

    // THE SEARCH FIELD AT THE FOOT, the system Photos app's with its keyboard up: a 48 field and a
    // 48 close circle, 8 from the screen's sides and 8 above the keys, 8 apart (`BandMetrics` on
    // iOS). The magnifier is 17 and sits 10 into the field; the text starts 36 in.
    const val SEARCH_HEIGHT: Int = 48
    const val SEARCH_INSET: Int = 8
    const val SEARCH_GLYPH: Int = 17
    const val SEARCH_GLYPH_LEAD: Int = 10

    /**
     * HOW HIGH THE BAND'S PLATE FLOATS: Material 3's level 3 (6dp), the elevation of its floating
     * toolbar. The plate is opaque, so the shadow is what lifts it off the page the content runs
     * under. iOS draws the same controls as Liquid Glass; each platform uses its own primitive.
     */
    const val BAND_ELEVATION: Int = 6

    /** Breathing room under a scroller's last row, beyond the band (`BandMetrics`' foot margin). */
    const val FOOT_MARGIN: Int = 24
}
