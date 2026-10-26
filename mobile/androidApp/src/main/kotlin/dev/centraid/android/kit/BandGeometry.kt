package dev.centraid.android.kit

/**
 * THE BAND'S GEOMETRY, IN DP (DESIGN.md's invariant 1; the iOS band draws the same numbers): the
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
}
