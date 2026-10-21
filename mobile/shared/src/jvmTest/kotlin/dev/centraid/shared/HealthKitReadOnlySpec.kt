package dev.centraid.shared

import dev.centraid.shared.apps.health.HealthKinds
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldNotBeEmpty
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * NOTHING IS WRITTEN TO APPLE HEALTH (#1129, R-1129-7): the iOS adapter's share set is empty.
 *
 * Health reads the phone's health store one way. On iOS that is four facts in four files, and
 * each would be a write path on its own:
 *
 * | File | The fact |
 * |---|---|
 * | every `.swift` under `Sources/` | every `requestAuthorization` asks `toShare: []`; nothing saves or deletes a HealthKit object |
 * | `Resources/Centraid.entitlements` | `com.apple.developer.healthkit.access` is an empty array |
 * | `project.yml` | the same, at the source the entitlements are generated from; no `NSHealthUpdateUsageDescription`; the seeder is not part of the project |
 * | `Resources/Info.plist` | no `NSHealthUpdateUsageDescription` (iOS refuses a share request without one, so its absence is a second lock) |
 *
 * iOS does not compile in the JVM gate, so this scan stands in for review. It also holds one
 * cross-language fact: the reader's workout kind names are `HealthKinds.TABLE`'s iOS keys, so a
 * kind HealthKit sends is one the vault maps.
 */
class HealthKitReadOnlySpec : StringSpec({
    val ios = File(
        System.getProperty("centraid.mobileRoot") ?: error("centraid.mobileRoot is unset; see mobile/shared/build.gradle.kts"),
    ).resolve("iosApp")

    /** Swift outside comments, per file. */
    val sources = ios.resolve("Sources").walkTopDown()
        .filter { it.isFile && it.extension == "swift" && !it.path.contains("/Sources/Generated/") }
        .associate { file ->
            file.name to file.readLines().joinToString("\n") { line ->
                val marker = line.indexOf("//")
                if (marker >= 0) line.substring(0, marker) else line
            }
        }
    val healthKit = sources.filterValues { Regex("""^import HealthKit$""", RegexOption.MULTILINE).containsMatchIn(it) }
    val reader = sources["HealthKitReader.swift"] ?: error("Sources/Health/HealthKitReader.swift is missing")
    val entitlements = ios.resolve("Resources/Centraid.entitlements").readText()
    val project = ios.resolve("project.yml").readText()
    val plist = ios.resolve("Resources/Info.plist").readText()

    "the scan sees the reader and the one authorization call — a scan over nothing always passes" {
        healthKit.keys.contains("HealthKitReader.swift") shouldBe true
        val asks = healthKit.values.sumOf { Regex("""requestAuthorization\(""").findAll(it).count() }
        withClue("one HealthKit requestAuthorization in Sources/, at Connect") { asks shouldBe 1 }
    }

    "every authorization asks to share nothing" {
        val calls = healthKit.flatMap { (name, text) ->
            Regex("""requestAuthorization\(([^)]*)""").findAll(text).map { name to it.groupValues[1] }.toList()
        }
        calls.shouldNotBeEmpty()
        val offenders = calls.filterNot { (_, arguments) -> Regex("""toShare:\s*\[\]\s*,""").containsMatchIn(arguments) }
        withClue("requestAuthorization whose toShare is not []: $offenders") { offenders shouldBe emptyList() }
    }

    "nothing under Sources saves, deletes or builds a HealthKit object" {
        val writes = Regex("""\.(save|delete|deleteObjects|deleteObject)\s*\(|HKWorkoutBuilder|HKQuantitySample\(|HKCategorySample\(|HKWorkout\(""")
        val offenders = healthKit.flatMap { (name, text) -> writes.findAll(text).map { "$name: ${it.value}" }.toList() }
        withClue("a HealthKit write in the app: $offenders") { offenders shouldBe emptyList() }
    }

    "the entitlement carries HealthKit with an empty access list" {
        Regex("""<key>com\.apple\.developer\.healthkit</key>\s*<true/>""").containsMatchIn(entitlements) shouldBe true
        Regex("""<key>com\.apple\.developer\.healthkit\.access</key>\s*<array/>""").containsMatchIn(entitlements) shouldBe true
        Regex("""(?m)^\s*com\.apple\.developer\.healthkit\.access:\s*\[\]\s*$""").containsMatchIn(project) shouldBe true
    }

    "the bundle declares no reason to write, and the seeder is not part of it" {
        // The YAML outside its comments: the comments name what is absent, and why.
        val code = project.lines().filterNot { it.trimStart().startsWith("#") }.joinToString("\n")
        withClue("project.yml") { code.contains("NSHealthUpdateUsageDescription") shouldBe false }
        withClue("Info.plist") { plist.contains("NSHealthUpdateUsageDescription") shouldBe false }
        withClue("Info.plist names why Health reads") { plist.contains("NSHealthShareUsageDescription") shouldBe true }
        withClue("project.yml names the seeder outside a comment") { code.contains("HealthSeeder") shouldBe false }
    }

    "the reader's workout kind names are HealthKinds.TABLE's iOS keys" {
        val named = Regex("""case \.\w+: return "(\w+)"""").findAll(reader).map { it.groupValues[1] }.toSet()
        val fallback = Regex("""default: return "(\w+)"""").find(reader)?.groupValues?.get(1)
        val table = HealthKinds.TABLE.keys.filterNot { it.startsWith("EXERCISE_TYPE_") }.toSet()
        named shouldBe table - HealthKinds.OTHER
        fallback shouldBe HealthKinds.OTHER
    }
})
