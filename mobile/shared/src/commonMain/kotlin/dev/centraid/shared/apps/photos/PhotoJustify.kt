package dev.centraid.shared.apps.photos

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** One photograph's recorded pixel box; either side 0 is an unknown box. */
public class PhotoBox(public val width: Int, public val height: Int) {
    /**
     * The real aspect ratio; an unknown box packs SQUARE — a missing record
     * is the one case there is nothing to be faithful to.
     */
    internal val aspect: Double
        get() = if (width > 0 && height > 0) width.toDouble() / height.toDouble() else 1.0
}

/** One packed tile: the input it came from, and its box in the row. */
public class PackedTile(public val index: Int, public val width: Double, public val height: Double)

/**
 * JUSTIFIED ROWS FROM REAL ASPECT RATIOS (v0's `justify.ts`, §4.1), PACKED
 * ONCE FOR BOTH SHELLS.
 *
 * Rows pack to a target height and scale to fill the width exactly; nothing
 * crops to a square and nothing reflows when bytes land. The constants are
 * v0's: a 2 gutter, a 28% overshoot before a row closes, and a trailing partial
 * row kept at natural height capped at 1.25× so one wide photograph cannot
 * become a banner. A full row's rounding remainder folds into its LAST tile so
 * the row fills the width to the point; the trailing row deliberately does not.
 *
 * The inputs are primitives so SwiftUI can call it: Swift holds SwiftProtobuf
 * cells and cannot hand them to a Kotlin function, which is how the packing
 * came to be written twice. The answer names tiles by their index in the
 * input, and each shell puts its own cell back under it.
 */
public object PhotoJustify {
    /** The gutter between tiles, both axes — the 4 base rung halved. */
    public const val GAP: Int = 2

    /** How far past the width a row packs before it closes. */
    public const val OVERSHOOT: Double = 0.28

    /** The trailing row's height, as a multiple of the target. */
    public const val LAST_ROW_CAP: Double = 1.25

    /**
     * The rows [boxes] pack into at [containerWidth], each as wide as the
     * container, in the order given. Nothing is re-sorted.
     */
    public fun rows(boxes: List<PhotoBox>, containerWidth: Double, targetHeight: Double): List<List<PackedTile>> =
        pack(boxes.map { it.aspect }, containerWidth, targetHeight)

    private fun pack(aspects: List<Double>, containerWidth: Double, targetHeight: Double): List<List<PackedTile>> {
        if (containerWidth <= 0.0 || targetHeight <= 0.0) return emptyList()
        val rows = mutableListOf<List<PackedTile>>()
        val members = mutableListOf<Int>()
        var sum = 0.0
        aspects.forEachIndexed { index, ratio ->
            members += index
            sum += ratio
            val spare = containerWidth - GAP * (members.size - 1)
            if (sum * targetHeight >= spare + targetHeight * OVERSHOOT) {
                val height = rounded(spare / sum)
                val widths = members.map { rounded(height * aspects[it]) }.toMutableList()
                widths[widths.lastIndex] = widths.last() + (spare - widths.sum())
                rows += members.mapIndexed { at, member -> PackedTile(member, widths[at], height) }
                members.clear()
                sum = 0.0
            }
        }
        if (members.isNotEmpty()) {
            val natural = (containerWidth - GAP * (members.size - 1)) / sum
            val height = min(targetHeight * LAST_ROW_CAP, natural)
            rows += members.map { PackedTile(it, rounded(height * aspects[it]), rounded(height)) }
        }
        return rows
    }

    /** Half rounds up, which is what both shells' own rounding did for a positive size. */
    private fun rounded(value: Double): Double = floor(value + 0.5)

    /**
     * THE GRID IS THE LOADING STATE (v0's `PhotosGridSkeleton.tsx`, §14): the
     * placeholders' rows at the rung's own geometry, packed by [rows], so the
     * photographs land where their placeholders stood.
     *
     * The aspect sequence is FIXED — random aspects would flicker — and nothing
     * moves: DESIGN.md's `Loading` is static skeletons, and a shimmer is
     * attention-seeking about work the product can simply describe. BOTH
     * HALVES OF THE COUNT ROUND UP: too few reads as "the library ends here".
     */
    public fun skeleton(containerWidth: Double, targetHeight: Double, viewportHeight: Double): List<List<PackedTile>> {
        val unit = max(targetHeight, 1.0)
        val perRow = max(1, (containerWidth / unit).toInt()) + 1
        val rowCount = max(1, (viewportHeight / unit).toInt() + 1)
        return pack(
            List(perRow * rowCount) { SKELETON_ASPECTS[it % SKELETON_ASPECTS.size] },
            containerWidth,
            targetHeight,
        )
    }

    /** v0's `SKELETON_ASPECTS`, in order. */
    private val SKELETON_ASPECTS: List<Double> =
        listOf(1.5, 1.0, 4.0 / 3, 0.75, 1.5, 16.0 / 9, 1.0, 2.0 / 3, 4.0 / 3, 1.0, 1.5, 0.75)
}
