package dev.centraid.shared

import dev.centraid.shared.apps.health.HealthKinds
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * NOTHING IS WRITTEN TO HEALTH CONNECT, AND THE OS IS ASKED ONLY AT CONNECT (#1129, R-1129-7,
 * R-1127-15) — held over the Android shell's sources, which no JVM build compiles.
 *
 * - The manifest declares health permissions that READ only, and every permission the reader
 *   asks for is one it declares.
 * - No Android source calls Health Connect's writes (`insertRecords`, `updateRecords`,
 *   `deleteRecords`) or names a write permission.
 * - The permission sheet is built in one file (`kit/HealthConnectReader.kt`) and launched from one
 *   (`screens/health/HealthConnectAct.kt`, Connect's tap): never at launch, never from a read.
 * - The reader's exercise-type names are the constants' own names, and cover every Health Connect
 *   word [HealthKinds.TABLE] maps to a kind.
 */
class HealthConnectReadOnlySpec : StringSpec({

    val mobileRoot = File(System.getProperty("centraid.mobileRoot") ?: error("centraid.mobileRoot is unset"))
    val app = mobileRoot.resolve("androidApp/src/main")
    val manifest = app.resolve("AndroidManifest.xml")
    val kotlin = app.resolve("kotlin/dev/centraid/android")
    val reader = kotlin.resolve("kit/HealthConnectReader.kt")
    val act = kotlin.resolve("screens/health/HealthConnectAct.kt")
    val sources = mobileRoot.resolve("androidApp/src").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

    "the spec reads real files — a check over nothing passes forever" {
        withClue(manifest.path) { manifest.isFile.shouldBeTrue() }
        withClue(reader.path) { reader.isFile.shouldBeTrue() }
        withClue(act.path) { act.isFile.shouldBeTrue() }
        withClue("android sources") { (sources.size > 50).shouldBeTrue() }
    }

    "the manifest asks Health Connect to read and never to write" {
        val declared = Regex("""android\.permission\.health\.([A-Z_]+)""").findAll(manifest.readText()).map { it.groupValues[1] }.toSet()
        withClue(declared) {
            declared.filterNot { it.startsWith("READ_") } shouldBe emptyList()
            declared.shouldContainAll(
                listOf("READ_STEPS", "READ_ACTIVE_CALORIES_BURNED", "READ_EXERCISE", "READ_SLEEP", "READ_RESTING_HEART_RATE", "READ_WEIGHT"),
            )
        }
    }

    "every permission the reader asks for is a read the manifest declares" {
        val asked = Regex("""PREFIX \+ "([A-Z_]+)"""").findAll(reader.readText()).map { it.groupValues[1] }.toList()
        val declared = manifest.readText()
        withClue(asked) {
            (asked.size >= 6).shouldBeTrue()
            asked.filterNot { it.startsWith("READ_") } shouldBe emptyList()
            asked.filterNot { "android.permission.health.$it\"" in declared } shouldBe emptyList()
        }
    }

    "no Android source writes to Health Connect" {
        // The client's writes anywhere in the shell; a write permission's name in Health's own files.
        val writes = Regex("""\b(insertRecords|updateRecords|deleteRecords|upsertMedicalResources|getWritePermission)\b""")
        val healthFiles = sources.filter { it == reader || it.path.contains("/screens/health/") }
        val offenders = sources.flatMap { file -> writes.findAll(file.readText()).map { "${file.name}: ${it.value}" }.toList() } +
            healthFiles.flatMap { file -> Regex("""\bWRITE_[A-Z_]+""").findAll(file.readText()).map { "${file.name}: ${it.value}" }.toList() }
        withClue("health files") { (healthFiles.size >= 3).shouldBeTrue() }
        withClue(offenders) { offenders shouldBe emptyList() }
    }

    "the permission sheet is built in the reader and launched only from Connect's tap" {
        val builds = sources.filter { "createRequestPermissionResultContract" in it.readText() }.map { it.name }
        val launches = sources.filter { it != reader && Regex("""\.permissionsFor\(""").containsMatchIn(it.readText()) }.map { it.name }
        withClue("builds the sheet") { builds shouldBe listOf(reader.name) }
        withClue("launches the sheet") { launches shouldBe listOf(act.name) }
    }

    "the reader names each exercise type by its own constant, and every kind the table maps" {
        val text = reader.readText()
        val pairs = Regex("""ExerciseSessionRecord\.(EXERCISE_TYPE_[A-Z_]+) to "(EXERCISE_TYPE_[A-Z_]+)"""").findAll(text)
            .map { it.groupValues[1] to it.groupValues[2] }.toList()
        withClue(pairs.filter { it.first != it.second }) { pairs.all { it.first == it.second }.shouldBeTrue() }
        val named = pairs.map { it.second }.toSet()
        val mapped = HealthKinds.TABLE.keys.filter { it.startsWith("EXERCISE_TYPE_") }
        withClue(mapped - named) { (mapped - named) shouldBe emptyList() }
    }
})
