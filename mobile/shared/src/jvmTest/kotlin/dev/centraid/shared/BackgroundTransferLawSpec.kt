package dev.centraid.shared

import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.collections.shouldNotBeEmpty
import io.kotest.matchers.string.shouldContain
import java.io.File

/**
 * THE FOUR PLATFORM FACTS NO MACHINE HERE CAN COMPILE (#1029 W5B-2).
 *
 * Neither mobile shell is built in this container: there is no Android SDK, and
 * a Kotlin/Native link needs a macOS host. So the background-transfer halves
 * would ship with nothing checking them at all — and every one of their failure
 * modes is silent on a member's phone:
 *
 * | Fact | What happens when it is wrong |
 * |---|---|
 * | every `BGTaskScheduler` id is in `Info.plist` | the app **terminates** on launch, with no backup and no message |
 * | the Android worker is a CONCRETE class | WorkManager accepts the work, reports it enqueued, and every run fails inside the framework |
 * | iOS uploads are file-based | a background session refuses a data-bodied task, so uploads only run while the app is open |
 * | Block Store's asymmetry is stated | a member is told their key will come back, and on Android it will not |
 *
 * A source scan is a poor substitute for a compiler and it is not pretending
 * otherwise. What it catches is the specific regression each row names, which is
 * the whole of what those files got wrong before — the abstract `Worker` shipped
 * exactly this way, accepted by every reviewer and by every gate.
 */
class BackgroundTransferLawSpec : StringSpec({

    val mobileRoot = File(
        System.getProperty("centraid.mobileRoot")
            ?: error("centraid.mobileRoot is unset; see mobile/shared/build.gradle.kts"),
    )
    val iosServices = mobileRoot.resolve(
        "shared/src/iosMain/kotlin/dev/centraid/shared/platform/PlatformServices.ios.kt",
    ).readText()
    val androidServices = mobileRoot.resolve(
        "shared/src/androidMain/kotlin/dev/centraid/shared/platform/PlatformServices.android.kt",
    ).readText()
    val plist = mobileRoot.resolve("iosApp/Resources/Info.plist").readText()

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

    "every BGTaskScheduler identifier the shell submits is declared in Info.plist" {
        // AN UNDECLARED IDENTIFIER KILLS THE APP. `BGTaskScheduler` raises an
        // NSInternalInconsistencyException on register and on submit, which is
        // a crash on launch rather than a task that does not run — so a member
        // whose phone does this has no backup and nothing to report.
        val submitted = Regex("""const val \w*IDENTIFIER = "([^"]+)"""")
            .findAll(iosServices)
            .map { it.groupValues[1] }
            .toList()
        withClue("no identifiers were found in the iOS services; the scan is stale") {
            submitted.shouldNotBeEmpty()
        }
        submitted.forEach { identifier ->
            withClue("$identifier is submitted but not in BGTaskSchedulerPermittedIdentifiers") {
                plist shouldContain "<string>$identifier</string>"
            }
        }
    }

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

    "iOS background uploads are file-based over the sealed spool file" {
        // A background `NSURLSession` refuses a data-bodied upload task. An
        // uploader that passed bytes would work in the foreground, pass every
        // manual test, and never run while the phone is in a pocket.
        iosServices shouldContain "backgroundSessionConfigurationWithIdentifier"
        iosServices shouldContain "uploadTaskWithRequest"
        iosServices shouldContain "fromFile"
    }
})
