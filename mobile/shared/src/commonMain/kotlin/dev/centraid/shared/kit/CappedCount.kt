package dev.centraid.shared.kit

import dev.centraid.design.copy.PhotosCopy

/**
 * **A COUNT THAT MAY BE A FLOOR, SPELLED ONCE.**
 *
 * The page door has no `COUNT(*)`, so a count off a page that filled is "at
 * least" that many, and a bare number over it would claim a total nobody
 * counted. Seven screens in two shells spelled this by hand, in three shapes;
 * this is the one function they all call, over primitives so SwiftUI reaches it
 * through the framework as `CappedCount.shared.phrase(...)`.
 *
 * The words are `copy/photos.json`'s (`PHOTOS_COUNT_*`); this closes the holes.
 * A noun is picked by the count alone — singular at exactly one, capped or not,
 * because "at least 1 photo" is the true sentence — and an empty noun leaves a
 * bare number, which is what a card under a place draws.
 */
public object CappedCount {
    /** `5 photos`, or `At least 5 photos` — the sentence-initial form. */
    public fun phrase(count: Long, capped: Boolean, one: String, many: String): String =
        floor(quantity(count, one, many), capped)

    /** The same, mid-sentence and for a screen reader: `5 photos`, or `at least 5 photos`. */
    public fun spoken(count: Long, capped: Boolean, one: String, many: String): String {
        val said = quantity(count, one, many)
        return if (capped) PhotosCopy.PHOTOS_COUNT_AT_LEAST_SPOKEN.replace("{quantity}", said) else said
    }

    /** What a tile or a row draws: `5 photos`, or `5+ photos`. */
    public fun shown(count: Long, capped: Boolean, one: String, many: String): String {
        val number = if (capped) PhotosCopy.PHOTOS_COUNT_PLUS.replace("{count}", count.toString()) else count.toString()
        return joined(number, noun(count, one, many))
    }

    /** A quantity already spelled by the vault (`4.2 MB`) given its floor: `At least 4.2 MB`, or itself. */
    public fun floor(quantity: String, capped: Boolean): String =
        if (capped) PhotosCopy.PHOTOS_COUNT_AT_LEAST.replace("{quantity}", quantity) else quantity

    private fun quantity(count: Long, one: String, many: String): String = joined(count.toString(), noun(count, one, many))

    private fun noun(count: Long, one: String, many: String): String = if (count == 1L) one else many

    private fun joined(number: String, noun: String): String = if (noun.isEmpty()) number else "$number $noun"
}
