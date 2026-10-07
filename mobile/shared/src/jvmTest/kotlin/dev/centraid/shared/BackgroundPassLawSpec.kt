package dev.centraid.shared

import dev.centraid.shared.sync.BackgroundWindows
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import java.io.File

/**
 * THE PLATFORM FACTS NO MACHINE HERE CAN COMPILE (#1029 W18-3).
 *
 * `BackgroundTransferLawSpec`, which this file replaces.
 *
 * | Fact | What happens when it is wrong |
 * |---|---|
 * | the Android worker is a CONCRETE class | WorkManager accepts the work, reports it enqueued, and every run fails inside the framework |
 * | the unique work name is kept and UPDATEd | a shipped build's unrunnable request is preserved for ever |
 * | ONE background `URLSession`, the iOS shell's, pinning by DER | two sessions under one identifier are undefined; a session trusting a CA trusts whoever holds a certificate for the address |
 *
 * The row that pinned `BGTaskScheduler` identifiers against `Info.plist` is not
 * lost either: `BackgroundIdentifierSpec` asks the stronger version of it, over
 * all three files the identifier is written in, plus the launch handler the old
 * row never checked for.
 *
 * The third row was "the `URLSession` seam stays retired" while the gateway
 * was reached over iroh from inside this process (the amendment of
 * 2026-09-21). #1080 ruling 2 gave the seam a destination again — the
 * member's own gateway, over HTTPS, with the certificate the pairing pinned —
 * so the row asserts the session now exists, once, and how it trusts.
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
    /** Every androidMain file: the windows live in `AndroidBackgroundWork.kt`. */
    val androidServices = mobileRoot.resolve("shared/src/androidMain").walkTopDown()
        .filter { it.isFile && it.extension == "kt" }
        .joinToString("\n") { it.readText() }

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
        BackgroundWindows.PERIODIC shouldBe "centraid-sync-pass"
        androidCode shouldContain "enqueueUniquePeriodicWork("
        androidCode shouldContain "ExistingPeriodicWorkPolicy.UPDATE"
        withClue("KEEP would preserve the worker that can never run") {
            androidCode.contains("ExistingPeriodicWorkPolicy.KEEP").shouldBeFalse()
        }
    }

    "one background URLSession carries the uploads, and it pins the gateway by DER" {
        // #1080 RULING 2: the OS moves the bytes while the app is suspended,
        // through ONE background session — two live sessions under one
        // identifier are undefined, and a second identifier is a second queue
        // nobody settles. It is the iOS shell's (`BackgroundUploads.swift`);
        // the Kotlin half only hands it parts (`UploadLoop`).
        val swift = mobileRoot.resolve("iosApp/Sources").walkTopDown()
            .filter { it.isFile && it.extension == "swift" }
            .associate { it.name to code(it.readText()) }
        val makesOne = "URLSessionConfiguration.background(withIdentifier:"
        val sessions = swift.filterValues { makesOne in it }
        withClue("Swift files that make a background URLSession: ${sessions.keys}") {
            sessions.keys shouldBe setOf("BackgroundUploads.swift")
            sessions.values.single().split(makesOne).size shouldBe 2
        }
        val mover = sessions.values.single()
        // A RELAUNCH FOR FINISHED TASKS is what settles them with the app closed.
        mover shouldContain "sessionSendsLaunchEvents = true"
        // TRUST IS THE PAIRING'S: the certificate's own bytes, compared in the
        // challenge, never a certificate authority's say-so.
        mover shouldContain "didReceive challenge: URLAuthenticationChallenge"
        mover shouldContain "SecCertificateCopyData("
        // AND NO KOTLIN MAKES ONE, nor names v0's retired seam.
        val kotlin = mobileRoot.resolve("shared/src").walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filterNot { it.name == "BackgroundPassLawSpec.kt" }
        kotlin.forEach { file ->
            val text = code(file.readText())
            withClue("${file.name} makes a background session in Kotlin") {
                text.contains("backgroundSessionConfigurationWithIdentifier").shouldBeFalse()
                text.contains("BackgroundTransfers").shouldBeFalse()
            }
        }
    }
})
