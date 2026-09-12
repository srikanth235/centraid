package dev.centraid.shared

import com.lemonappdev.konsist.api.Konsist
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * `commonMain` HAS NO PLATFORM IMPORT (#1020, D-1020-E7; census §E seam 9).
 *
 * The rule with teeth, and the one whose demonstrated red is
 * `import android.os.Bundle` — the same red `crates/xtask`'s
 * `commonmain-no-platform-import` rule carries on the Rust side. Two enforcers
 * of one rule is deliberate: this one runs with the module and names the file
 * and the import, the xtask one runs on every gate profile and catches a
 * `mobile/` tree whose Gradle build was not invoked at all.
 *
 * ## Why it matters beyond tidiness
 *
 * Every platform service is an `expect`/`actual` seam because of this rule, and
 * the seams are what keep the Kotlin/Native link short — which is the thing the
 * issue's Tooling coverage section is protecting when it says the shared module
 * is "kept to state machines precisely so its Kotlin/Native link stays short".
 * A single `android.` import in `commonMain` does not fail an Android build; it
 * fails the iOS one, later, in someone else's week.
 */
class CommonMainIsPlatformFreeSpec : StringSpec({

    val mobileRoot = File(
        System.getProperty("centraid.mobileRoot")
            ?: error("centraid.mobileRoot is unset; see mobile/shared/build.gradle.kts"),
    )

    /**
     * The prefixes that are platform. Not a blanket "no import that is not
     * `kotlin`" — `commonMain` legitimately imports `kotlinx.coroutines`,
     * `okio` and Wire — but every package that only exists on one platform.
     */
    val forbidden = listOf(
        "android.",
        "androidx.",
        "java.",
        "javax.",
        "kotlinx.cinterop",
        "platform.", // Kotlin/Native's Apple frameworks
        "com.sun.",
        "dalvik.",
    )

    "no commonMain file in mobile/ imports a platform package" {
        val offenders = mutableListOf<String>()
        listOf("shared", "core").forEach { module ->
            // KONSIST'S PATHS ARE PROJECT-RELATIVE. It prefixes what it is
            // given with the root project's directory, so an absolute path
            // becomes `<root><root>/...` and the scope is empty — which for a
            // source-scanning lint means passing forever.
            mobileRoot.resolve("$module/src/commonMain").isDirectory.shouldBeTrue()
            Konsist.scopeFromDirectory("$module/src/commonMain").files.forEach { file ->
                file.imports.forEach { import ->
                    if (forbidden.any { import.name.startsWith(it) }) {
                        offenders += "mobile/$module/${file.name}: ${import.name}"
                    }
                }
            }
        }
        // The failure message IS the finding: the file and the import, so a
        // reader does not have to go looking for which of two hundred files.
        withClue(offenders) { offenders shouldBe emptyList() }
    }

    "the scope is not empty — a lint over nothing is a lint that always passes" {
        // The failure mode this repository has met before: a source-scanning
        // gate pointed at a moved directory, reporting no findings forever. The
        // count is asserted to be plausible rather than merely non-zero.
        val files = listOf("shared", "core").sumOf { module ->
            Konsist.scopeFromDirectory("$module/src/commonMain").files.size
        }
        (files >= 8).shouldBeTrue()
    }
})
