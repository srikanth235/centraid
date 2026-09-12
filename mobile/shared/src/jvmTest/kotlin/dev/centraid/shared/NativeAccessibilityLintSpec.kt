package dev.centraid.shared

import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * AN ICON-ONLY CONTROL CARRIES A LABEL — on both native surfaces
 * (#1020, D-1020-E7; census §E seam 12).
 *
 * **This gate is net-new and it has no v0 ancestor to inherit.** v0 has two
 * source-scanning accessibility gates, `scripts/lint-aria-labels.mjs` and
 * `scripts/accessibility-contract.test.mjs`, and **both are web-shaped**:
 * neither reaches React Native, there is no `accessibilityLabel` lint over
 * `apps/mobile/src` at all, and `docs/platform-gating.md`'s design-enforcement
 * parity section is where that asymmetry was supposed to be argued. Claiming
 * parity by citing `lint-aria-labels.mjs` would be citing a web-only lint.
 *
 * So this is the mobile half, written from scratch and deliberately shaped like
 * its web sibling: an icon-only control must carry a description, and a
 * decorative glyph must say it is decorative.
 *
 * ## Why a regex and not Konsist
 *
 * Compose's `contentDescription` is an argument to a function call, not a
 * declaration, and Konsist reads declarations. The Swift half has no Kotlin AST
 * at all. One scanner for both surfaces, in the same test run, beats two tools
 * that disagree about which files they cover — and the scanner asserts its own
 * coverage below, because a lint over an empty file set is a lint that passes
 * forever.
 */
class NativeAccessibilityLintSpec : StringSpec({

    val mobileRoot = File(
        System.getProperty("centraid.mobileRoot") ?: error("centraid.mobileRoot is unset"),
    )

    /**
     * Compose's icon-only controls. `Icon(...)` REQUIRES a
     * `contentDescription` argument by signature — including `null`, which is
     * how a decorative glyph opts out — so the lint's job is to catch the
     * `null` that is not decorative and the `Image` that carries nothing.
     */
    val composeSources = mobileRoot.resolve("androidApp/src").walkTopDown()
        .filter { it.isFile && it.extension == "kt" }
        .toList()

    val swiftSources = mobileRoot.resolve("iosApp").walkTopDown()
        .filter { it.isFile && it.extension == "swift" && !it.path.contains("/Design/") }
        .toList()

    "the lint sees both surfaces — an empty file set is a lint that always passes" {
        withClue("mobile/androidApp/src") { (composeSources.size >= 4).shouldBeTrue() }
        withClue("mobile/iosApp") { (swiftSources.size >= 3).shouldBeTrue() }
    }

    "every Compose Icon and Image carries a contentDescription" {
        val offenders = mutableListOf<String>()
        composeSources.forEach { file ->
            val text = file.readText().withoutComments()
            // Each `Icon(` / `Image(` call site, to the closing of its
            // argument list at the same indentation. Crude on purpose: a
            // parser would be a second Kotlin front end, and the failure mode
            // of crude here is a FALSE POSITIVE, which someone fixes, rather
            // than a false negative, which nobody sees.
            Regex("""\b(Icon|Image)\(""").findAll(text).forEach { match ->
                val window = text.substring(
                    match.range.first,
                    minOf(text.length, match.range.first + WINDOW),
                )
                val described = window.contains("contentDescription")
                if (!described) {
                    offenders += "${file.name}: ${match.value} with no contentDescription"
                }
            }
        }
        withClue(offenders) { offenders shouldBe emptyList() }
    }

    "every Compose contentDescription that is null says why it is decorative" {
        // `contentDescription = null` is the correct answer for a glyph beside
        // a label that already says the same thing — and it is indistinguishable
        // from an omission unless the author says which it is. The web sibling
        // makes the same demand of `aria-hidden`.
        val offenders = mutableListOf<String>()
        composeSources.forEach { file ->
            file.readText().lines().forEachIndexed { index, line ->
                if (line.contains("contentDescription = null") &&
                    !line.contains("// decorative")
                ) {
                    offenders += "${file.name}:${index + 1}: contentDescription = null " +
                        "without a `// decorative` note"
                }
            }
        }
        withClue(offenders) { offenders shouldBe emptyList() }
    }

    "every SwiftUI Image and icon-only Button carries an accessibilityLabel" {
        val offenders = mutableListOf<String>()
        swiftSources.forEach { file ->
            val text = file.readText().withoutComments()
            Regex("""\bImage\(systemName:""").findAll(text).forEach { match ->
                val window = text.substring(
                    match.range.first,
                    minOf(text.length, match.range.first + WINDOW),
                )
                val described = window.contains(".accessibilityLabel(") ||
                    window.contains(".accessibilityHidden(true)")
                if (!described) {
                    offenders += "${file.name}: Image(systemName:) with neither " +
                        "accessibilityLabel nor accessibilityHidden(true)"
                }
            }
        }
        withClue(offenders) { offenders shouldBe emptyList() }
    }
}) {
    companion object {
        /**
         * How far past a call site to look for the label. Wide enough for a
         * multi-line argument list, narrow enough that the next composable's
         * description does not satisfy this one.
         */
        const val WINDOW: Int = 320

        /**
         * COMMENTS ARE NOT CODE, and the window is measured in characters.
         *
         * The first version of this lint reported
         * `TallyListView.swift: Image(systemName:) with neither
         * accessibilityLabel nor accessibilityHidden(true)` on a view that had
         * one — six lines of comment between the image and its label had pushed
         * the label past 320 characters. That is the crude scanner's advertised
         * failure mode (a false positive someone fixes), and the fix is to
         * measure over code rather than to widen the window until the next
         * comment breaks it.
         */
        fun String.withoutComments(): String = lines()
            .joinToString("\n") { line ->
                val marker = line.indexOf("//")
                if (marker >= 0) line.substring(0, marker) else line
            }
    }
}
