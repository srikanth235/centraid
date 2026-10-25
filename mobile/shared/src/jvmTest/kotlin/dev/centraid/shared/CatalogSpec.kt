package dev.centraid.shared

import dev.centraid.design.CentraidCatalog
import dev.centraid.design.CentraidGeometry
import dev.centraid.shared.shell.SpringboardPolicy
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldContainExactlyInAnyOrder
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe

/**
 * THE EMITTED CATALOGUE, AND EVERY ICON KEY THAT NAMES ONE (#1020, wave A).
 *
 * `contracts/tools/export-native-catalog.ts` lowers `packages/design`'s app
 * table, the resolved identity marks and the shared silhouettes into Kotlin and
 * Swift. The emitter is gated on drift by `git diff --exit-code`; what that gate
 * cannot see is a CALLER naming an icon the set does not contain — a missing key
 * is a silently blank mark on both shells, not a failure.
 *
 * Two keys were exactly that when this file was written: Home's first moves named
 * `Notebook` and `CheckSquare`, neither of which exists in the design set,
 * because the port invented a second icon table instead of reading the app's own
 * mark the way v0 does. The Swift half of this claim is
 * `mobile/iosApp/Tests/IconSilhouetteTests.swift`, which asserts the same table
 * parses.
 */
class CatalogSpec : StringSpec({

    "every app on the springboard is in the emitted catalogue" {
        // The grid's order and the catalogue's order are different questions —
        // one is the hand-off's tile list, the other is the all-apps listing —
        // but they name the same apps, and a tile with no catalogue entry
        // draws no mark and no name.
        CentraidCatalog.apps.map { it.id } shouldContainExactlyInAnyOrder
            SpringboardPolicy.SPRINGBOARD_ORDER
    }

    "every catalogued app has a mark in BOTH schemes" {
        // The identity ring MOVES between light and dark: a light hue on a dark
        // page is the wrong hue, not merely the wrong brightness.
        CentraidCatalog.apps.forEach { app ->
            withClue(app.id) {
                CentraidCatalog.lightMarks[app.id] shouldNotBe null
                CentraidCatalog.darkMarks[app.id] shouldNotBe null
            }
        }
    }

    "a chip's wash is the app's hue over the page, never the hue itself" {
        // The wash is 13% (light) / 20% (dark) of the hue over `bg`, composited
        // by the emitter because no native platform has `color-mix()`. If the
        // two were ever equal the emitter would have stopped compositing and
        // every chip would be a saturated plate.
        CentraidCatalog.apps.forEach { app ->
            withClue(app.id) {
                val light = CentraidCatalog.lightMarks.getValue(app.id)
                light.chipBackground shouldNotBe light.hue
                val dark = CentraidCatalog.darkMarks.getValue(app.id)
                dark.chipBackground shouldNotBe dark.hue
                // And the two schemes do not share a ring.
                light.hue shouldNotBe dark.hue
            }
        }
    }

    "every icon key a caller names RESOLVES" {
        // The whole point. A key with no silhouette is a blank mark on both
        // shells and nothing fails.
        val named = buildSet {
            addAll(CentraidCatalog.apps.map { it.iconKey })
            // THE BAND'S MARKS are Rust's (`crates/screens/src/shell/band.rs`: Home, the
            // assistant's Sparkle, Backup); a mark the emitted set lacks draws blank.
            addAll(listOf("Home", "Sparkle", "Backup"))
            // The lockup's two verbs and the title row's one control.
            add("Search")
            add("NewChat")
            add("Settings")
        }
        named.forEach { key ->
            withClue("icon '$key' is named by a caller and is not in the emitted set") {
                CentraidCatalog.icons.containsKey(key).shouldBeTrue()
                CentraidCatalog.icons.getValue(key).isNotEmpty().shouldBeTrue()
            }
        }
    }

    "the geometry both shells read is present and sane" {
        // These are the values the token table does not carry and a view would
        // otherwise type in.
        CentraidGeometry.PAGE_MARGIN shouldBe 18
        CentraidGeometry.HAIRLINE shouldBe 1
        CentraidGeometry.TARGET_MIN_COARSE shouldBe 44
        (CentraidGeometry.ICON_CHIP_TINT_DARK > CentraidGeometry.ICON_CHIP_TINT_LIGHT)
            .shouldBeTrue()
    }
})
