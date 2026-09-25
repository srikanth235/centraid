package dev.centraid.shared

import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldNotBeEmpty
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * ONE FACT IN THREE FILES, COMPARED (#1029 W18-1).
 *
 * A `BGTaskScheduler` identifier is declared in three places and each of them is
 * written by a different toolchain:
 *
 * | File | Who writes it | What it is |
 * |---|---|---|
 * | `PlatformServices.ios.kt` | Kotlin | the ids the shell submits |
 * | `iosApp/project.yml` | XcodeGen input | **the source** of the bundle's plist |
 * | `iosApp/Resources/Info.plist` | XcodeGen output, committed | what a reader sees |
 *
 * **An identifier missing from any one of them terminates the app.**
 * `BGTaskScheduler` raises an `NSInternalInconsistencyException` when an id is
 * registered or submitted that the *bundle* does not declare, and again when one
 * is submitted with no registered launch handler. The app does not fail the
 * task; it dies, on launch, with no backup and nothing a member can report.
 *
 * That is exactly what shipped: `dev.centraid.upload-pass` was in the committed
 * plist and **not** in `project.yml`, which is the file the plist is generated
 * from — so the generated bundle declared one identifier and the shell submitted
 * two. And `grep -rn 'forTaskWithIdentifier' mobile/iosApp/Sources` was empty,
 * so neither identifier had a handler at all.
 *
 * iOS does not compile in this container, so this scan is what stands in for the
 * compiler. It is a poor substitute and does not pretend otherwise: what it
 * catches is the specific regression each assertion names, which is the whole of
 * what these files have got wrong so far.
 */
class BackgroundIdentifierSpec : StringSpec({

    val mobileRoot = File(
        System.getProperty("centraid.mobileRoot")
            ?: error("centraid.mobileRoot is unset; see mobile/shared/build.gradle.kts"),
    )
    val iosServices = mobileRoot.resolve(
        "shared/src/iosMain/kotlin/dev/centraid/shared/platform/PlatformServices.ios.kt",
    ).readText()
    val plist = mobileRoot.resolve("iosApp/Resources/Info.plist").readText()
    val projectYml = mobileRoot.resolve("iosApp/project.yml").readText()
    val swiftSources = mobileRoot.resolve("iosApp/Sources")
        .walkTopDown()
        .filter { it.extension == "swift" }
        .joinToString("\n") { it.readText() }

    /** The ids the Kotlin companion submits, in declaration order. */
    val submitted = Regex("""const val \w*IDENTIFIER = "([^"]+)"""")
        .findAll(iosServices)
        .map { it.groupValues[1] }
        .toList()

    /**
     * The array under one key, from either file, as a set.
     *
     * The plist half reads `<string>…</string>` between the key and the array's
     * close; the YAML half reads `- …` items until a line that is not one. Both
     * are deliberately narrow: a parser that accepted more would accept a
     * malformed declaration the generator would not.
     */
    fun plistArray(key: String): Set<String> {
        val start = plist.indexOf("<key>$key</key>")
        if (start < 0) return emptySet()
        val end = plist.indexOf("</array>", start)
        if (end < 0) return emptySet()
        return Regex("""<string>([^<]+)</string>""")
            .findAll(plist.substring(start, end))
            .map { it.groupValues[1] }
            .toSet()
    }

    fun yamlList(key: String): Set<String> {
        val lines = projectYml.lines()
        val at = lines.indexOfFirst { it.trimStart().startsWith("$key:") }
        if (at < 0) return emptySet()
        return lines.drop(at + 1)
            .takeWhile { it.isBlank() || it.trimStart().startsWith("-") || it.trimStart().startsWith("#") }
            .mapNotNull { line ->
                line.trimStart().removePrefix("-").trim().takeIf {
                    line.trimStart().startsWith("-") && it.isNotEmpty()
                }
            }
            .toSet()
    }

    val key = "BGTaskSchedulerPermittedIdentifiers"

    "the scan finds the identifiers at all" {
        // A REGEX THAT MATCHES NOTHING PASSES EVERY ASSERTION BELOW. This is the
        // one that notices the companion was respelled.
        withClue("no identifiers were found in PlatformServices.ios.kt; this scan is stale") {
            submitted.shouldNotBeEmpty()
        }
    }

    "every identifier the shell submits is declared in project.yml, which is the source" {
        // THE DEFECT THIS TEST WAS WRITTEN FOR. `dev.centraid.upload-pass` was
        // in the plist and not here, and the plist is xcodegen's OUTPUT — so the
        // built bundle declared one id and the shell submitted two.
        submitted.forEach { identifier ->
            withClue("$identifier is submitted but is not in project.yml's $key") {
                (identifier in yamlList(key)) shouldBe true
            }
        }
    }

    "every identifier the shell submits is declared in Info.plist" {
        submitted.forEach { identifier ->
            withClue("$identifier is submitted but is not in the plist's $key") {
                (identifier in plistArray(key)) shouldBe true
            }
        }
    }

    "the generated plist and its source declare the same set, in both directions" {
        // DRIFT EITHER WAY IS A FINDING. An id in the plist alone is a
        // declaration the next `xcodegen generate` deletes; an id in the source
        // alone is a committed plist a reader would be misled by.
        withClue("Info.plist and project.yml disagree about $key") {
            plistArray(key) shouldBe yamlList(key)
        }
    }

    "every identifier has a registered launch handler in the Swift shell" {
        // A SUBMIT WITH NO HANDLER IS THE SAME EXCEPTION AND THE SAME
        // TERMINATION. Before W18-1 `forTaskWithIdentifier` appeared nowhere in
        // `mobile/iosApp/Sources`, so a granted window had nothing to run and the
        // first submit could kill the app.
        withClue("no BGTaskScheduler registration in mobile/iosApp/Sources") {
            swiftSources.contains("forTaskWithIdentifier:") shouldBe true
        }
        submitted.forEach { identifier ->
            withClue("$identifier is submitted but the Swift shell never names it") {
                swiftSources.contains("\"$identifier\"") shouldBe true
            }
        }
    }

    "a handler completes the task on the expiration path as well" {
        // A TASK THAT ENDS WITHOUT `setTaskCompleted` IS KILLED AND ITS APP IS
        // PENALISED IN SCHEDULING — a backup that gets rarer every time it
        // fails. The expiration handler is the path that is forgotten.
        withClue("no expirationHandler in the Swift shell") {
            swiftSources.contains("expirationHandler") shouldBe true
        }
        val afterExpiration = swiftSources.substringAfter("expirationHandler")
        withClue("the expiration path does not call setTaskCompleted") {
            afterExpiration.contains("setTaskCompleted") shouldBe true
        }
    }
})
