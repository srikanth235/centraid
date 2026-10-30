package dev.centraid.android.screens.money

/*
 * MONEY'S PURE GEOMETRY (#1152). The arithmetic the category table and the
 * cash-flow chart draw with, held out of the composables so a JVM test reads it
 * without a device. Nothing here measures money: the bars scale by Rust's own
 * basis points (`in_bp`, `out_bp`: a share of the series' largest side), never
 * by a maximum found in this shell (R-1047-K1).
 */
internal object MoneyGeometry {
    /** Basis points in a whole: the scale `in_bp`, `out_bp`, `fill_bp` and `tick_bp` are given on. */
    const val BASIS: Int = 10_000

    /** The height of the chart's plot, in dp: a bar at `BASIS` fills it. */
    const val PLOT_HEIGHT: Float = 132f

    /** The shortest bar drawn, in dp: a month with a side of nothing still shows a stub. */
    const val MIN_BAR: Float = 2f

    /** The width of one bar, in dp. */
    const val BAR_WIDTH: Float = 8f

    /** The outline of a partial month's bar, in dp. */
    const val PARTIAL_STROKE: Float = 1.5f

    /** The width of each figure column in the category table and the month table, in dp. */
    const val COLUMN_WIDTH: Float = 68f

    /** What stands where a line with no plan has nothing to compare to (an em dash). */
    const val DASH: String = "—"

    /** What joins the amounts of the Needs row, one per currency (a middle dot). */
    const val AMOUNT_JOINER: String = " · "

    /** What joins the months' spoken words into the chart's one label. */
    const val SUMMARY_JOINER: String = ". "

    /**
     * A BAR'S HEIGHT FROM THE STATE'S BASIS POINTS, in dp: a share of [plot],
     * clamped to the scale, and never shorter than [MIN_BAR].
     */
    fun barHeight(basisPoints: Int, plot: Float = PLOT_HEIGHT): Float =
        maxOf(MIN_BAR, plot * basisPoints.coerceIn(0, BASIS) / BASIS)

    /** THE MONTH TABLE RUNS NEWEST FIRST under a chart that runs oldest to newest. */
    fun <T> newestFirst(oldestFirst: List<T>): List<T> = oldestFirst.asReversed()

    /** THE CHART'S ONE SPOKEN LABEL: every month's own words, joined. */
    fun chartSummary(spokenMonths: List<String>): String = spokenMonths.joinToString(SUMMARY_JOINER)

    /** The three figure columns of a category line. */
    data class CategoryFigures(val planned: String, val spent: String, val left: String)

    /**
     * PLANNED · SPENT · LEFT for one line: a line with no plan has only what was
     * spent, a dash standing for planned and for left.
     */
    fun categoryFigures(hasPlan: Boolean, planned: String, spent: String, left: String): CategoryFigures =
        CategoryFigures(
            planned = if (hasPlan) planned else DASH,
            spent = spent,
            left = if (hasPlan) left else DASH,
        )

    /** The Needs row's right-hand words: each currency's amount, in the state's order. */
    fun needsAmounts(amounts: List<String>): String = amounts.joinToString(AMOUNT_JOINER)
}
