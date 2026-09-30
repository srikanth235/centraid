package dev.centraid.shared

import centraid.screen.v1.PhotoCell
import dev.centraid.shared.apps.photos.PhotosReads
import dev.centraid.shared.sync.TransferRule
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/**
 * WHAT A CELL SAYS THIS DEVICE HAS (#1025 S5, D-1025-S7-62).
 *
 * ## The defect this is a gate against
 *
 * For one slice the per-cell state was "a path is present, so the photograph is
 * held" (D-1025-S7-22, which said so and said it was temporary). That could not
 * tell three different things apart, and all three drew the same placeholder:
 * a photograph still on its way, a photograph the member's own rule is holding
 * back, and a device that has nothing of it at all. Only the middle one carries
 * a download arrow, so a grid that could not name it had nowhere to put one.
 *
 * ## And the trap inside the fix
 *
 * `thumbnail_path` FALLS BACK to the original's hash on a vault with no
 * derivative rows (`HELD_THUMBNAIL_COLUMN`, D-1025-S7-20) — which is every
 * vault founded before the derivatives slice. So a present path means the
 * original on some libraries and a `thumb` on others, and a cell that inferred
 * "held" from a path would tell a member their full-size photograph is on this
 * device whenever a thumbnail was. `original_held` is its own column for
 * exactly that reason, and this spec is where that stays true.
 *
 * ## No arithmetic is asserted here that Rust does not own
 *
 * Which tier a window actually FETCHES under which rule is
 * `centraid_blobs::Budget::admits_original`, and its own table test is the
 * authority. What this covers is the LABEL — the sentence and the affordance a
 * member sees — which is this side's, and which has to agree with that table.
 */
class PhotoCellStateSpec : StringSpec({

    fun held(
        thumbnail: Boolean = true,
        originalHeld: Boolean = false,
        originalHash: String = "aa",
        kind: PhotoCell.Kind = PhotoCell.Kind.KIND_PHOTO,
        rule: TransferRule = TransferRule.WIFI_ONLY,
        metered: Boolean = false,
    ): PhotoCell.Held = PhotosReads.heldOf(
        thumbnail = thumbnail,
        originalHeld = originalHeld,
        originalHash = originalHash,
        kind = kind,
        rule = rule,
        metered = metered,
    )

    "a held original outranks everything, including a rule that would withhold it" {
        // The bytes are here. A rule is about what to FETCH, and a cell whose
        // file has already landed is not waiting for anything — a download
        // arrow over it would ask for what is under the member's thumb.
        held(originalHeld = true, rule = TransferRule.MANUAL, metered = true) shouldBe
            PhotoCell.Held.HELD_ORIGINAL
    }

    "a path with no original is THUMBNAIL_ONLY and not a withholding" {
        // Nothing is holding it back — the window has simply not come round —
        // so there is no arrow. An affordance for something already queued is
        // an affordance that does nothing.
        held() shouldBe PhotoCell.Held.HELD_THUMBNAIL_ONLY
    }

    "the member's own rule is a DECISION, and it is the state that carries the arrow" {
        // Every cell of the table, against `crates/blobs`' own. A member on a
        // metered link under the default reads "waiting", not "missing".
        val table = listOf(
            Triple(TransferRule.WIFI_ONLY, false, false),
            Triple(TransferRule.WIFI_ONLY, true, true),
            Triple(TransferRule.WIFI_AND_CELLULAR_PHOTOS, false, false),
            // A PHOTOGRAPH crosses on cellular under this rule.
            Triple(TransferRule.WIFI_AND_CELLULAR_PHOTOS, true, false),
            // MANUAL WITHHOLDS ON AN UNMETERED LINK TOO. The case a metered
            // flag could never express, and the reason the rule is its own
            // field rather than a spelling of that flag.
            Triple(TransferRule.MANUAL, false, true),
            Triple(TransferRule.MANUAL, true, true),
        )
        for ((rule, metered, withheld) in table) {
            withClue("$rule metered=$metered, a photograph") {
                held(rule = rule, metered = metered) shouldBe
                    if (withheld) {
                        PhotoCell.Held.HELD_WITHHELD_BY_RULE
                    } else {
                        PhotoCell.Held.HELD_THUMBNAIL_ONLY
                    }
            }
        }
    }

    "a VIDEO on a metered link is withheld even when photographs are not" {
        // The fixed rule, which no member setting turns off: the two differ by
        // three orders of magnitude, and a member who said "photos on cellular"
        // did not say "a 900 MB video on cellular".
        held(
            kind = PhotoCell.Kind.KIND_VIDEO,
            rule = TransferRule.WIFI_AND_CELLULAR_PHOTOS,
            metered = true,
        ) shouldBe PhotoCell.Held.HELD_WITHHELD_BY_RULE
        held(
            kind = PhotoCell.Kind.KIND_VIDEO,
            rule = TransferRule.WIFI_AND_CELLULAR_PHOTOS,
            metered = false,
        ) shouldBe PhotoCell.Held.HELD_THUMBNAIL_ONLY
    }

    "nothing at all is ABSENT, under every rule, and never a withholding" {
        // A freshly paired phone mid-first-copy is every cell in this state and
        // it is not an error — and it must not draw an arrow, because there is
        // no thumbnail under it for one to sit on and nothing is being held
        // back that a later window will not bring.
        for (rule in TransferRule.entries) {
            withClue("$rule") {
                held(thumbnail = false, rule = rule, metered = true) shouldBe
                    PhotoCell.Held.HELD_ABSENT
            }
        }
    }

    "a cell with no original to ask for offers nothing, whatever the rule" {
        // This replica has no live content row naming an original, so there is
        // no hash to tap. An affordance nothing can serve is worse than none:
        // the member presses it and the core answers `nothingWanted`.
        held(originalHash = "", rule = TransferRule.MANUAL, metered = true) shouldBe
            PhotoCell.Held.HELD_THUMBNAIL_ONLY
        held(originalHash = "", thumbnail = false, rule = TransferRule.MANUAL) shouldBe
            PhotoCell.Held.HELD_ABSENT
    }

    "FETCHING is the reducer's and never this read's" {
        // A tap is not a fact a page read can see. `PhotosGridMachine` paints
        // it over the cell the member touched, and it outranks every state
        // here — which is why no combination of inputs to this function can
        // produce it.
        val everyState = buildSet {
            for (rule in TransferRule.entries) {
                for (metered in listOf(true, false)) {
                    for (thumbnail in listOf(true, false)) {
                        for (originalHeld in listOf(true, false)) {
                            for (hash in listOf("aa", "")) {
                                add(held(thumbnail, originalHeld, hash, rule = rule, metered = metered))
                            }
                        }
                    }
                }
            }
        }
        everyState.contains(PhotoCell.Held.HELD_FETCHING) shouldBe false
        everyState.contains(PhotoCell.Held.HELD_UNSPECIFIED) shouldBe false
    }
})
