package dev.centraid.shared

import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.string.shouldContain
import java.io.File

/**
 * THE PLATFORM FACTS NO MACHINE HERE CAN COMPILE (#1029 W18-3).
 *
 * `BackgroundTransferLawSpec`, which this file replaces. Two of its four rows
 * were about the `URLSession` seam the amendment of 2026-09-21 struck, and they
 * went with it; the two below survive because their subject does:
 *
 * | Fact | What happens when it is wrong |
 * |---|---|
 * | the Android worker is a CONCRETE class | WorkManager accepts the work, reports it enqueued, and every run fails inside the framework |
 * | the unique work name is kept and UPDATEd | a shipped build's unrunnable request is preserved for ever |
 *
 * The row that pinned `BGTaskScheduler` identifiers against `Info.plist` is not
 * lost either: `BackgroundIdentifierSpec` asks the stronger version of it, over
 * all three files the identifier is written in, plus the launch handler the old
 * row never checked for.
 *
 * The retired row about file-based `NSURLSession` uploads has no successor and
 * needs none — its subject is deleted, and the last assertion here is what keeps
 * it deleted.
 *
 * Neither mobile shell is built in this container: there is no Android SDK, and
 * a Kotlin/Native link needs a macOS host. A source scan is a poor substitute
 * for a compiler and does not pretend otherwise. What it catches is the specific
 * regression each row names, which is the whole of what these files got wrong
 * before — the abstract `Worker` shipped exactly this way, accepted by every
 * reviewer and by every gate.
 */
class BackgroundPassLawSpec : StringSpec({

    val mobileRoot = File(
        System.getProperty("centraid.mobileRoot")
            ?: error("centraid.mobileRoot is unset; see mobile/shared/build.gradle.kts"),
    )
    val androidServices = mobileRoot.resolve(
        "shared/src/androidMain/kotlin/dev/centraid/shared/platform/PlatformServices.android.kt",
    ).readText()

    /**
     * The CODE, with comments dropped.
     *
     * Every file here explains the trap it is avoiding by naming it, so a scan
     * over raw text finds `PeriodicWorkRequestBuilder<androidx.work.Worker>` in
     * the paragraph that says never to write it. `cargo xtask rules` splits on
     * `//` for the same reason.
     */
    fun code(source: String): String = source
        .lines()
        .map { it.substringBefore("//") }
        .filterNot { it.trimStart().startsWith("*") }
        .joinToString("\n")

    val androidCode = code(androidServices)

    "the Android periodic worker is a concrete class and never androidx.work.Worker" {
        // WHAT SHIPPED BEFORE. `PeriodicWorkRequestBuilder<androidx.work.Worker>`
        // names the ABSTRACT base class; WorkManager instantiates a worker
        // reflectively and that one has no runnable body, so the work was
        // enqueued and could never execute. The registration reported success,
        // which is how it survived.
        withClue("the abstract Worker is scheduled again") {
            androidCode.contains("PeriodicWorkRequestBuilder<androidx.work.Worker>")
                .shouldBeFalse()
            androidCode.contains("OneTimeWorkRequestBuilder<androidx.work.Worker>")
                .shouldBeFalse()
        }
        androidCode shouldContain "PeriodicWorkRequestBuilder<CentraidSyncWorker>"
        androidCode shouldContain "class CentraidSyncWorker"
        androidCode shouldContain "CoroutineWorker"
    }

    "the unique work name is kept, and the policy is what migrates the broken entry" {
        // KEEP would keep exactly the unrunnable request a shipped build left
        // behind. The name stays so nothing is orphaned; UPDATE is what
        // replaces the request under it.
        androidCode shouldContain "\"centraid-sync-pass\""
        androidCode shouldContain "ExistingPeriodicWorkPolicy.UPDATE"
        withClue("KEEP would preserve the worker that can never run") {
            androidCode.contains("ExistingPeriodicWorkPolicy.KEEP").shouldBeFalse()
        }
    }

    "the URLSession seam stays retired, on every platform" {
        // ITS DESTINATION NO LONGER EXISTS. A background `NSURLSession` and a
        // WorkManager upload worker both carried bytes to an HTTPS endpoint
        // while the app was not running; the gateway is the member's own laptop
        // reached over iroh by a client inside this process, so there is nothing
        // for the OS to carry bytes to. The amendment of 2026-09-21 struck the
        // seam, and this is what notices it coming back with no destination.
        val sources = mobileRoot.walkTopDown()
            .filter { it.isFile && (it.extension == "kt" || it.extension == "swift") }
            .filterNot { it.path.contains("/build/") }
            .filterNot { it.name == "BackgroundPassLawSpec.kt" }
        sources.forEach { file ->
            val text = code(file.readText())
            withClue("${file.name} names the retired background-upload seam") {
                text.contains("BackgroundTransfers").shouldBeFalse()
                text.contains("NSURLSessionUploadTask").shouldBeFalse()
                text.contains("backgroundSessionConfigurationWithIdentifier").shouldBeFalse()
            }
        }
    }
})
