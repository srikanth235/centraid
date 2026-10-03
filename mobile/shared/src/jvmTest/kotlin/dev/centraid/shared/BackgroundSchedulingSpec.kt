package dev.centraid.shared

import centraid.core.v1.Envelope
import dev.centraid.core.CentraidCore
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.platform.FakePowerAndLink
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.sync.BackgroundWindows
import dev.centraid.shared.sync.DrainAnswer
import dev.centraid.shared.sync.DrainDoor
import dev.centraid.shared.sync.DrainPass
import dev.centraid.shared.sync.LinkConditions
import dev.centraid.shared.sync.PassConditions
import dev.centraid.shared.sync.ShelfDrain
import dev.centraid.shared.sync.TransferRule
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.path.createTempDirectory

/**
 * SCHEDULING IS OBSERVABLE (#1080, the shells).
 *
 * The background drain never ran on either platform because nothing called
 * `BackgroundTasks.register()`: the windows were declared and never asked for.
 * These are the laws that keep it asked for — once per launch, from one place,
 * under constraints derived from the member's rule — proved through the JVM
 * fake's counters and, for the two native halves no machine here compiles, by
 * the narrow source scans `BackgroundIdentifierSpec` already uses.
 */
class BackgroundSchedulingSpec : StringSpec({

    val mobileRoot = File(
        System.getProperty("centraid.mobileRoot")
            ?: error("centraid.mobileRoot is unset; see mobile/shared/build.gradle.kts"),
    )

    /** The code with comments dropped, so a comment naming a trap is not the trap. */
    fun code(source: String): String = source
        .lines()
        .map { it.substringBefore("//") }
        .filterNot { it.trimStart().startsWith("*") }
        .joinToString("\n")

    suspend fun session(services: FakePlatformServices): HomeSession = HomeSession.open(
        vaultDir = createTempDirectory("centraid-launch").toString(),
        services = services,
        dispatcher = Dispatchers.Unconfined,
        uiThreadName = "test",
    )

    "the launch registers the background windows, once per session" {
        runTest {
            val services = FakePlatformServices()
            val opened = session(services)
            services.backgroundTasks.registrations shouldBe 1
            // AND WHAT THE OS SAID IS KEPT, for the sentence a member reads.
            opened.backgroundRegistration.value shouldBe services.backgroundTasks.answer
            opened.close()
        }
    }

    "register is called from exactly one place in commonMain, and it is the session's open" {
        val sites = mobileRoot.resolve("shared/src/commonMain").walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .flatMap { file ->
                code(file.readText()).lines()
                    .filter { "backgroundTasks.register(" in it }
                    .map { file.name }
            }
            .toList()
        withClue("call sites of backgroundTasks.register(): $sites") {
            sites shouldBe listOf("HomeSession.kt")
        }
    }

    "every pass asks for the next window, because a BGTaskRequest is one-shot" {
        runTest {
            val asked = AtomicInteger(0)
            val core = CentraidCore.answering(Dispatchers.Unconfined) { Envelope(request_id = 0) }
            ShelfDrain(
                holdings = { listOf(Shelf.Holding(vaultId = "a", path = "/a", name = "a", core = core)) },
                doorFor = { DrainDoor { DrainAnswer(0, DrainAnswer.Stopped.UNREACHABLE) } },
                nowMs = { 0 },
                reschedule = DrainPass.Rescheduler { asked.incrementAndGet() },
            ).scheduled(20_000)
            asked.get() shouldBe 1
        }
    }

    "Back up now holds the platform's long-run envelope and always releases it" {
        runTest {
            val services = FakePlatformServices()
            val opened = session(services)
            opened.backUpNow()
            services.backgroundTasks.backlogs shouldBe listOf(true, false)
            opened.close()
        }
    }

    "the periodic window waits for Wi-Fi unless the rule lets photographs cross cellular" {
        BackgroundWindows.periodic(TransferRule.WIFI_ONLY).link shouldBe BackgroundWindows.Link.UNMETERED
        BackgroundWindows.periodic(TransferRule.MANUAL).link shouldBe BackgroundWindows.Link.UNMETERED
        BackgroundWindows.periodic(TransferRule.WIFI_AND_CELLULAR_PHOTOS).link shouldBe
            BackgroundWindows.Link.CONNECTED
        TransferRule.entries.forEach { rule ->
            BackgroundWindows.periodic(rule).requiresCharging shouldBe false
            BackgroundWindows.nudge(rule).link shouldBe BackgroundWindows.periodic(rule).link
        }
    }

    "the night shift needs the charger and Wi-Fi" {
        BackgroundWindows.NIGHT_SHIFT.requiresCharging shouldBe true
        BackgroundWindows.NIGHT_SHIFT.link shouldBe BackgroundWindows.Link.UNMETERED
    }

    "the periodic name is kept, and every window has its own" {
        // A RENAME WOULD ORPHAN what a shipped build enqueued; `UPDATE` is what
        // migrates the request under the kept name.
        BackgroundWindows.PERIODIC shouldBe "centraid-sync-pass"
        val names = listOf(
            BackgroundWindows.periodic(TransferRule.WIFI_ONLY).name,
            BackgroundWindows.NIGHT_SHIFT.name,
            BackgroundWindows.nudge(TransferRule.WIFI_ONLY).name,
        )
        names.toSet().size shouldBe names.size
        BackgroundWindows.periodic(TransferRule.WIFI_ONLY).periodMinutes shouldBe 15
    }

    "Android maps BackgroundWindows onto WorkManager, under the rule it reads" {
        val android = code(
            mobileRoot.resolve(
                "shared/src/androidMain/kotlin/dev/centraid/shared/platform/AndroidBackgroundWork.kt",
            ).readText(),
        )
        // THE RULE IS READ AT EVERY ENQUEUE, launch and resubmit alike.
        android shouldContain "enqueuePeriodic(TransferRule.read(store))"
        android shouldContain "BackgroundWindows.periodic(rule)"
        android shouldContain "BackgroundWindows.NIGHT_SHIFT"
        android shouldContain "BackgroundWindows.nudge("
        android shouldContain "setRequiresCharging(window.requiresCharging)"
        android shouldContain "BackgroundWindows.Link.UNMETERED -> NetworkType.UNMETERED"
        // "BACK UP NOW" IS THE APP'S OWN LONG RUN (A11): the shared half says
        // when, through the body the `Application` installed, and enqueues no
        // worker of its own for it.
        android shouldContain "SyncPass.backlog?.invoke(start)"
        android shouldContain "fun installBacklog(body: (Boolean) -> Unit)"
        android shouldNotContain "CentraidBacklogWorker"
    }

    "changing the rule asks for the windows again, so Android's constraint follows it" {
        runTest {
            val services = FakePlatformServices()
            val opened = session(services)
            val before = services.backgroundTasks.resubmits
            opened.ruleChanged()
            services.backgroundTasks.resubmits shouldBe before + 1
            // AND THE BRIDGE'S SETTER IS WHERE A SHELL REACHES IT.
            code(
                mobileRoot.resolve("shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeBridge.kt").readText(),
            ) shouldContain "session?.ruleChanged()"
            opened.close()
        }
    }

    "the iOS processing request waits for the charger and a network" {
        val ios = code(
            mobileRoot.resolve(
                "shared/src/iosMain/kotlin/dev/centraid/shared/platform/PlatformServices.ios.kt",
            ).readText(),
        )
        ios shouldContain "requiresExternalPower = true"
        ios shouldContain "requiresNetworkConnectivity = true"
        ios shouldNotContain "requiresExternalPower = false"
    }

    "an unknown link is metered and an unknown charger is unplugged, on the wire and on the grid" {
        runTest {
            val services = FakePlatformServices(powerAndLink = FakePowerAndLink(metered = null, charging = null))
            val read = PassConditions.read(services)
            read.metered shouldBe null
            LinkConditions.metered shouldBe true
            LinkConditions.rule shouldBe TransferRule.DEFAULT
            val input = read.input(deadlineMs = 0, reason = dev.centraid.shared.sync.WakeReason.SCHEDULED)
            input.metered shouldBe true
            input.charging shouldBe false
            // AND A KNOWN UNMETERED LINK IS CARRIED AS IT IS.
            services.powerAndLink.metered = false
            PassConditions.read(services)
            LinkConditions.metered shouldBe false
        }
    }

    "videos are included until the member says otherwise, and the default stores nothing" {
        runTest {
            val services = FakePlatformServices()
            TransferRule.includeVideos(services.secureStore) shouldBe true
            TransferRule.writeIncludeVideos(services.secureStore, false)
            TransferRule.includeVideos(services.secureStore) shouldBe false
            TransferRule.writeIncludeVideos(services.secureStore, true)
            TransferRule.includeVideos(services.secureStore) shouldBe true
            services.secureStore.keys shouldBe emptySet()
        }
    }
})
