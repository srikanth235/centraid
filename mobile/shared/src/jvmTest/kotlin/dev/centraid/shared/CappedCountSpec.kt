package dev.centraid.shared

import dev.centraid.design.copy.PhotosCopy
import dev.centraid.shared.kit.CappedCount
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/**
 * A COUNT THAT MAY BE A FLOOR IS SPELLED ONCE: the shape every Photos screen
 * draws, in both shells, for a count read off a page that may have filled.
 */
class CappedCountSpec : StringSpec({

    val one = PhotosCopy.TILE_COUNT_ONE
    val many = PhotosCopy.TILE_COUNT_MANY

    "an exact count is the number and its noun, singular at exactly one" {
        CappedCount.phrase(1, false, one, many) shouldBe "1 photo"
        CappedCount.phrase(0, false, one, many) shouldBe "0 photos"
        CappedCount.phrase(12, false, one, many) shouldBe "12 photos"
        CappedCount.spoken(12, false, one, many) shouldBe "12 photos"
        CappedCount.shown(12, false, one, many) shouldBe "12 photos"
    }

    "a floor says at least, and its singular is still singular" {
        CappedCount.phrase(500, true, one, many) shouldBe "At least 500 photos"
        CappedCount.phrase(1, true, one, many) shouldBe "At least 1 photo"
        CappedCount.spoken(500, true, one, many) shouldBe "at least 500 photos"
        CappedCount.shown(500, true, one, many) shouldBe "500+ photos"
    }

    "no noun leaves the bare number, which is what a card draws" {
        CappedCount.shown(7, true, "", "") shouldBe "7+"
        CappedCount.shown(7, false, "", "") shouldBe "7"
        CappedCount.spoken(7, true, "", "") shouldBe "at least 7"
        CappedCount.spoken(7, false, "", "") shouldBe "7"
    }

    "a quantity the vault already spelled takes the same floor" {
        CappedCount.floor("4.2 MB", true) shouldBe "At least 4.2 MB"
        CappedCount.floor("4.2 MB", false) shouldBe "4.2 MB"
    }
})
