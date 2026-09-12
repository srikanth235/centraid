package dev.centraid.shared

import dev.centraid.design.CentraidCopy
import dev.centraid.design.CentraidTokens
import dev.centraid.design.NATIVE_COLOR_ROLES
import dev.centraid.design.NATIVE_EFFECT_ROLES
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import java.io.File

/**
 * The emitted token table, re-asserted where it is READ (#1020, D-1020-E6;
 * census §E seam 11).
 *
 * `packages/design` asserts the role contract at lowering time with
 * `assertNativeColorRoleContract`, and the emitter asserts it again over what
 * it emits. This spec is the third place, and it is the one that matters to a
 * Kotlin reader: it checks that the table the shared module actually compiled
 * against has every role, in both schemes, with no hole and no placeholder.
 *
 * The DRIFT check is separate and lives in the gate step
 * (`bun contracts/tools/export-native-theme.ts && git diff --exit-code design
 * copy mobile`), because a test cannot run a bun script without making `bun` a
 * test dependency of a Gradle build.
 */
class NativeThemeSpec : StringSpec({

    "both schemes carry every colour role the contract names" {
        NATIVE_COLOR_ROLES.size shouldBe 51
        listOf(CentraidTokens.light, CentraidTokens.dark).forEach { theme ->
            theme.colors.keys.sorted() shouldContainExactly NATIVE_COLOR_ROLES.sorted()
            // NO HOLES. A role mapped to zero would paint transparent black,
            // which looks like a layout bug rather than a missing token.
            theme.colors.values.forEach { value -> (value != 0L).shouldBeTrue() }
            // Every colour is opaque or deliberately translucent, never a
            // value with a zero alpha byte: `packages/design`'s native
            // lowering has no `color-mix()` and no runtime override layer, so
            // an alpha of zero here could only be an emitter bug.
            theme.colors.values.forEach { value ->
                (((value ushr 24) and 0xFF) != 0L).shouldBeTrue()
            }
        }
    }

    "three NativeColors entries are not colours, and they are named" {
        // A FINDING, handled rather than hidden. `packages/design`'s native
        // lowering promises every value is "concrete and ready to render", and
        // `shadowLg`/`shadowSm`/`shadowAmbient` are CSS `box-shadow` strings
        // in a record typed as colours. The emitter splits them out; the
        // receipt files the issue against `packages/design`, because inventing
        // a shadow API would be this lane deciding a design question.
        NATIVE_EFFECT_ROLES.size shouldBe 3
        NATIVE_EFFECT_ROLES.forEach { role ->
            NATIVE_COLOR_ROLES.contains(role).shouldBeFalse()
            CentraidTokens.light.effects.containsKey(role).shouldBeTrue()
            // They are CSS, which is the point of keeping them apart.
            CentraidTokens.light.effects.getValue(role).contains("px").shouldBeTrue()
        }
    }

    "the two schemes are different tables, not one table twice" {
        CentraidTokens.light.scheme shouldBe "light"
        CentraidTokens.dark.scheme shouldBe "dark"
        CentraidTokens.light.colors shouldNotBe CentraidTokens.dark.colors
        // Spacing, radii and type do NOT change with the scheme — they are the
        // same grammar in both — and asserting it keeps an emitter that
        // accidentally re-derived them from reporting a difference.
        CentraidTokens.light.spacing shouldBe CentraidTokens.dark.spacing
        CentraidTokens.light.radii shouldBe CentraidTokens.dark.radii
    }

    "every type style is concrete and ready to render" {
        // `packages/design/src/native.ts:1-9`: no `var()`, no `calc()`, no
        // stylesheet parser in the mobile path. A family of `inherit` or a line
        // height of zero would be a value that needed resolving at render time.
        CentraidTokens.light.type.values.forEach { style ->
            style.family.isNotBlank().shouldBeTrue()
            (style.fontSize > 0.0).shouldBeTrue()
            (style.lineHeight >= style.fontSize).shouldBeTrue()
            (style.weight in 100..900).shouldBeTrue()
        }
    }

    "the emitted JSON, the Kotlin table and the Swift table are the same table" {
        // THE ONE ASSERTION THAT CATCHES A HALF-RUN EMITTER. All three
        // artifacts are committed; if someone regenerates one by hand the role
        // lists stop agreeing, and the Swift half is the one no test on this
        // machine can compile.
        val repositoryRoot = File(
            System.getProperty("centraid.repositoryRoot")
                ?: error("centraid.repositoryRoot is unset"),
        )
        val json = repositoryRoot.resolve("design/native-theme.json").readText()
        val swift = repositoryRoot.resolve("mobile/iosApp/Design/Theme.swift").readText()
        // ONCE PER SCHEME, COUNTED — not "appears somewhere".
        //
        // The first version of this assertion used `contains`, and a
        // falsification run renamed `"accent":` in the LIGHT scheme only: the
        // test still passed, because the dark scheme's copy satisfied
        // `contains`. A presence check over a file with two schemes in it
        // cannot tell a complete table from half of one.
        NATIVE_COLOR_ROLES.forEach { role ->
            withClue("design/native-theme.json: $role") {
                json.split("\"$role\":").size - 1 shouldBe 2
            }
            withClue("mobile/iosApp/Design/Theme.swift: $role") {
                swift.split("\"$role\":").size - 1 shouldBe 2
            }
        }
        // And the Swift file declares the same role list.
        val swiftRoles = Regex("^    \"([A-Za-z0-9]+)\",$", RegexOption.MULTILINE)
            .findAll(swift)
            .map { it.groupValues[1] }
            .toList()
        swiftRoles.sorted() shouldContainExactly NATIVE_COLOR_ROLES.sorted()
    }

    "copy crossed as strings, and the functions that did not are listed" {
        // v0 has no central copy file: the leaves are per-app modules of named
        // strings. What a leaf composes with a FUNCTION is a decision about how
        // a sentence is built, and a generated Kotlin port of one would be a
        // second implementation that drifts — so those are named in
        // `copy/<app>.json` and left for the kit.
        CentraidCopy.Notes.ANCHOR_DEGRADED.isNotBlank().shouldBeTrue()
        val repositoryRoot = File(
            System.getProperty("centraid.repositoryRoot") ?: error("unset"),
        )
        listOf("notes", "photos", "shared", "tally").forEach { app ->
            val manifest = repositoryRoot.resolve("copy/$app.json").readText()
            manifest.contains("\"functions\"").shouldBeTrue()
            manifest.contains("\"strings\"").shouldBeTrue()
        }
    }
})
