package dev.centraid.shared

import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldNotBeEmpty
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * NAVIGATION IS STATED ONCE: A SWIFT FILE READS THE SHARED CONSTANT.
 *
 * A screen id, a More row's key, a band place and an action's key are facts of
 * the machine that owns them, and both shells need them. The SwiftUI shell
 * cannot import a Kotlin `const val` into a `case`; the failure it fell into
 * was to re-type the string, so the same fact lived in two languages and a
 * rename in one compiled in the other (a More row that no longer routed).
 *
 * This scan is what stands in for review: every `SCREEN_ID`-like constant in
 * `commonMain` is a string no Swift source may spell as a literal outside a
 * comment, and neither is a routing key (`MORE_*`, `BAND_*`, `VERB_*`,
 * `ACTION_*`, `PLACE_*`) as the pattern of a `case` or a comparison. Swift
 * reads `TasksHomeMachine.shared.SCREEN_ID`, `TasksHomeMachine.shared.MORE_TRASH`
 * and so on, and the build breaks when one is renamed.
 */
class ShellRoutingStatedOnceSpec : StringSpec({
    val mobileRoot = File(
        System.getProperty("centraid.mobileRoot")
            ?: error("centraid.mobileRoot is unset; see mobile/shared/build.gradle.kts"),
    )
    val common = mobileRoot.resolve("shared/src/commonMain/kotlin")
        .walkTopDown()
        .filter { it.extension == "kt" }
        .joinToString("\n") { it.readText() }

    // `const val SCREEN_ID`, `ASSETS_SCREEN_ID`… and `ScreenIds`, which a machine's `SCREEN_ID` aliases.
    val screenIds = (
        Regex("""const val \w*SCREEN_ID: String = "([^"]+)"""").findAll(common) +
            Regex("""const val \w+: String = "([^"]+)"""")
                .findAll(mobileRoot.resolve("shared/src/commonMain/kotlin/dev/centraid/shared/nav/ScreenIds.kt").readText())
        )
        .map { it.groupValues[1] }
        .toSet()
    val keys = Regex("""const val (?:MORE|BAND|VERB|ACTION|PLACE)_\w+: String = "([^"]+)"""")
        .findAll(common)
        .map { it.groupValues[1] }
        .toSet()

    // Swift outside comments, line by line, with the file named for the failure.
    val swift = mobileRoot.resolve("iosApp/Sources")
        .walkTopDown()
        .filter { it.extension == "swift" }
        .flatMap { file ->
            file.readLines().mapIndexedNotNull { index, line ->
                if (line.trimStart().startsWith("//")) null else "${file.name}:${index + 1}: ${line.trim()}"
            }
        }
        .toList()

    "the scan sees the constants it polices" {
        screenIds.shouldNotBeEmpty()
        keys.shouldNotBeEmpty()
        screenIds.contains("tasks.home") shouldBe true
        keys.contains("catch_up") shouldBe true
    }

    "no Swift source spells a screen id as a literal" {
        val spelled = swift.filter { line -> screenIds.any { id -> line.contains("\"$id\"") } }
        withClue("a Swift literal for a shared SCREEN_ID; read the machine's constant:\n${spelled.joinToString("\n")}") {
            spelled shouldBe emptyList()
        }
    }

    "no Swift source routes on a literal where a shared key exists" {
        val patterns = keys.map { key ->
            Regex("""(?:\bcase |[=!]= |, )"${Regex.escape(key)}"\s*[:)]|(?:[=!]= )"${Regex.escape(key)}"""")
        }
        val spelled = swift.filter { line -> patterns.any { it.containsMatchIn(line) } }
        withClue("a Swift routing literal for a shared MORE_/BAND_/VERB_/ACTION_/PLACE_ key:\n${spelled.joinToString("\n")}") {
            spelled shouldBe emptyList()
        }
    }
})
