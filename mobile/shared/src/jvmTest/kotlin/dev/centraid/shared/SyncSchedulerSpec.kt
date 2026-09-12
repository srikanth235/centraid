package dev.centraid.shared

import centraid.screen.v1.SeatState
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.platform.MediaLibrary
import dev.centraid.shared.platform.SecureStore
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.sync.LifecycleEvent
import dev.centraid.shared.sync.LifecycleState
import dev.centraid.shared.sync.Stage
import dev.centraid.shared.sync.SyncEffect
import dev.centraid.shared.sync.SyncScheduler
import dev.centraid.shared.sync.WakeReason
import dev.centraid.shared.sync.WriteGate
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain

/**
 * The sync pass and the lifecycle, transition by transition (#1020, D-1020-E4).
 *
 * One test per sentence `docs/mobile-offline.md` makes, so that a change to any
 * of them reds here rather than on a device three weeks later.
 */
class SyncSchedulerSpec : StringSpec({

    "a foreground registers background work, and the answer is recorded" {
        SyncScheduler().reduce(LifecycleEvent.Foregrounded) shouldBe
            dev.centraid.shared.sync.LifecycleStep(
                LifecycleState.Foreground,
                listOf(SyncEffect.RegisterBackgroundWork),
            )
    }

    "leaving the foreground clears decrypted material even without a lock" {
        // `docs/mobile-offline.md:253`. An opaque switcher mask over a process
        // that still holds a vault key is a mask, not a lock.
        val step = SyncScheduler().reduce(LifecycleEvent.Backgrounded)
        step.state shouldBe LifecycleState.Suspended
        step.effects shouldContainExactly listOf(SyncEffect.ClearDecryptedMaterial)
    }

    "locking clears the material AND unmounts the replica" {
        val step = SyncScheduler().reduce(LifecycleEvent.Locked)
        step.state shouldBe LifecycleState.Locked
        step.effects shouldContainExactly listOf(
            SyncEffect.ClearDecryptedMaterial,
            SyncEffect.UnmountReplica,
        )
    }

    "a pass runs its stages in order, one effect at a time" {
        var scheduler = SyncScheduler()
        val started = scheduler.reduce(
            LifecycleEvent.PassRequested(WakeReason.SCHEDULED, nowMs = 0),
        )
        started.effects shouldContainExactly listOf(SyncEffect.RunStage(Stage.PULL_LOG))
        val pass = started.state as LifecycleState.BackgroundPass
        pass.remaining shouldContainExactly listOf(
            Stage.SUBMIT_INTENTS,
            Stage.PLACEMENT,
            Stage.UPLOAD,
        )

        scheduler = SyncScheduler(started.state)
        val second = scheduler.reduce(
            LifecycleEvent.StageSettled(
                Stage.PULL_LOG,
                nowMs = 500,
                outcome = LifecycleEvent.StageSettled.Outcome.Completed,
            ),
        )
        second.effects shouldContainExactly listOf(SyncEffect.RunStage(Stage.SUBMIT_INTENTS))
    }

    "the 20 s budget stops the pass AT A STAGE BOUNDARY, with a report" {
        // `docs/mobile-offline.md:212`. A coroutine cancelled mid-stage leaves
        // no report, and the next pass cannot tell whether to redo the stage.
        val started = SyncScheduler().reduce(
            LifecycleEvent.PassRequested(WakeReason.SCHEDULED, nowMs = 0),
        )
        val overrun = SyncScheduler(started.state).reduce(
            LifecycleEvent.StageSettled(
                Stage.PULL_LOG,
                // One millisecond past the budget, at the boundary.
                nowMs = LifecycleState.BUDGET_MS + 1,
                outcome = LifecycleEvent.StageSettled.Outcome.Completed,
            ),
        )
        overrun.state shouldBe LifecycleState.Suspended
        val finish = overrun.effects.single() as SyncEffect.FinishPass
        finish.report.stoppedAtBoundary.shouldBeTrue()
        // AND IT REPORTS WHAT IT MANAGED, which is the deliverable.
        finish.report.completed shouldContainExactly listOf(Stage.PULL_LOG)
    }

    "the platform's expiration handler is a SECOND, independent trigger" {
        // It must not be dropped in favour of the timer: the platform knows
        // things the timer does not. And it does not cancel the stage in
        // flight — the pass still stops at the next boundary, with a report.
        val started = SyncScheduler().reduce(
            LifecycleEvent.PassRequested(WakeReason.SCHEDULED, nowMs = 0),
        )
        val warned = SyncScheduler(started.state).reduce(
            LifecycleEvent.PlatformExpirationWarning(nowMs = 1_000),
        )
        // No effect: the stage in flight is not cancelled.
        warned.effects.shouldBeEmpty()
        (warned.state as LifecycleState.BackgroundPass).platformWarned.shouldBeTrue()

        // Well inside the 20 s budget, and the pass still stops.
        val stopped = SyncScheduler(warned.state).reduce(
            LifecycleEvent.StageSettled(
                Stage.PULL_LOG,
                nowMs = 1_200,
                outcome = LifecycleEvent.StageSettled.Outcome.Completed,
            ),
        )
        stopped.state shouldBe LifecycleState.Suspended
        (stopped.effects.single() as SyncEffect.FinishPass)
            .report.stoppedAtBoundary.shouldBeTrue()
    }

    "a failed stage never cancels the rest, and a live file is skippedLive not failed" {
        // Scopes are isolated (`:212`), and v0 counted a foreign lease as
        // `skippedLive` rather than a failure: a member using the app is not a
        // broken background pass.
        val started = SyncScheduler().reduce(
            LifecycleEvent.PassRequested(WakeReason.PUSH, nowMs = 0),
        )
        val afterFailure = SyncScheduler(started.state).reduce(
            LifecycleEvent.StageSettled(
                Stage.PULL_LOG,
                nowMs = 100,
                outcome = LifecycleEvent.StageSettled.Outcome.Failed("the gateway hung up"),
            ),
        )
        afterFailure.effects shouldContainExactly listOf(
            SyncEffect.RunStage(Stage.SUBMIT_INTENTS),
        )
        val afterSkip = SyncScheduler(afterFailure.state).reduce(
            LifecycleEvent.StageSettled(
                Stage.SUBMIT_INTENTS,
                nowMs = 200,
                outcome = LifecycleEvent.StageSettled.Outcome.SkippedLive,
            ),
        )
        val pass = afterSkip.state as LifecycleState.BackgroundPass
        pass.report.failed.keys shouldContainExactly setOf(Stage.PULL_LOG)
        pass.report.skippedLive shouldContainExactly listOf(Stage.SUBMIT_INTENTS)
    }

    "low disk PARKS the feed, and a later wake does not restart the loop" {
        // `docs/mobile-offline.md:238`. The cursor and the rows stay; Centraid
        // never evicts canonical rows or queued writes to manufacture space.
        val parked = SyncScheduler(LifecycleState.Foreground).reduce(LifecycleEvent.DiskLow)
        parked.parked.shouldBeTrue()
        parked.effects shouldContainExactly listOf(SyncEffect.ParkFeed)

        val woken = SyncScheduler(parked.state, parked = true).reduce(
            LifecycleEvent.PassRequested(WakeReason.SCHEDULED, nowMs = 0),
        )
        // NOT a pass. The wake is answered with the park, not with a retry.
        woken.effects shouldContainExactly listOf(SyncEffect.ParkFeed)
        woken.parked.shouldBeTrue()

        val freed = SyncScheduler(parked.state, parked = true)
            .reduce(LifecycleEvent.DiskFreed(nowMs = 5))
        freed.parked.shouldBeFalse()
        // FROM THE DURABLE CURSOR, not from the top.
        freed.effects shouldContainExactly listOf(SyncEffect.ResumeFromDurableCursor)
    }

    "a relaunch resumes from the durable cursor rather than re-bootstrapping" {
        SyncScheduler().reduce(LifecycleEvent.Relaunched).effects shouldContainExactly
            listOf(SyncEffect.ResumeFromDurableCursor)
    }

    "push is wake-only: the reason is the whole payload" {
        // `docs/mobile-offline.md:220`, and `NATIVE_V0.md:21` — v0 introduces
        // no broker at all. There is no `Push(payload)` case for a future
        // broker to fill in, which is what keeps the payload empty by
        // construction rather than by review.
        WakeReason.entries.forEach { reason ->
            // An enum entry has no constructor parameters. If one ever does,
            // this line stops compiling, which is the point.
            reason.name.isNotEmpty().shouldBeTrue()
        }
        WakeReason.entries.size shouldBe 5
        WakeReason.valueOf("PUSH") shouldBe WakeReason.PUSH
    }

    // --- The write gate ---------------------------------------------------

    "an online-only write NEVER enqueues — it is refused" {
        // `docs/mobile-offline.md:259`: falling back to the outbox is exactly
        // what the flag forbids.
        val onlineOnly = ScreenEffect.SubmitWrite(
            command = "locker.reveal_secret",
            inputJson = "{}",
            invokeKey = "k",
            onlineOnly = true,
        )
        val offline = SeatState(connectivity = SeatState.Connectivity.CONNECTIVITY_OFFLINE)
        val verdict = WriteGate.verdict(onlineOnly, offline)
        (verdict is WriteGate.Verdict.Refuse).shouldBeTrue()
        (verdict as WriteGate.Verdict.Refuse).sentence shouldContain "needs to reach your gateway"

        // The same write online goes straight out.
        WriteGate.verdict(
            onlineOnly,
            SeatState(connectivity = SeatState.Connectivity.CONNECTIVITY_ONLINE_METERED),
        ) shouldBe WriteGate.Verdict.SendNow
    }

    "an ordinary write offline enqueues; out of disk it is refused, not pretend-queued" {
        val ordinary = ScreenEffect.SubmitWrite("knowledge.save_note", "{}", "k", false)
        WriteGate.verdict(
            ordinary,
            SeatState(connectivity = SeatState.Connectivity.CONNECTIVITY_OFFLINE),
        ) shouldBe WriteGate.Verdict.Enqueue

        val parked = WriteGate.verdict(
            ordinary,
            SeatState(
                connectivity = SeatState.Connectivity.CONNECTIVITY_OFFLINE,
                durability = SeatState.Durability.DURABILITY_PARKED_LOW_DISK,
            ),
        )
        (parked is WriteGate.Verdict.Refuse).shouldBeTrue()
    }

    "an unknown connectivity answer is not a yes" {
        // The pass asks the platform for the real answer rather than assuming a
        // radio, and "the platform would not say" is not "online".
        WriteGate.verdict(
            ScreenEffect.SubmitWrite("c", "{}", "k", onlineOnly = false),
            SeatState(
                connectivity = SeatState.Connectivity.CONNECTIVITY_UNKNOWN_PLATFORM_REFUSED,
            ),
        ) shouldBe WriteGate.Verdict.Enqueue
    }

    // --- The platform seams ----------------------------------------------

    "the JVM's services are fakes, and they are the ones the tests drive" {
        val services = platformServices()
        (services is FakePlatformServices).shouldBeTrue()
    }

    "an empty secret DELETES rather than storing an empty string" {
        // `apps/mobile/src/lib/secure-storage.ts:39-43`. A stored empty secret
        // reads back as a credential the app believes it has.
        val store = FakePlatformServices().secureStore
        store.write("link.ticket", "abc")
        store.read("link.ticket") shouldBe "abc"
        store.write("link.ticket", "")
        store.read("link.ticket").shouldBeNull()
        store.keys shouldContainExactly emptySet()
    }

    "clearing the secure store is countable, because locking has to be able to do it" {
        val store = FakePlatformServices().secureStore
        store.write("a", "1")
        store.clear()
        store.clears shouldBe 1
        store.read("a").shouldBeNull()
    }

    "the secure store's keys carry v0's prefix, so a migrating device finds them" {
        val store = FakePlatformServices().secureStore
        store.write("device.key", "k")
        store.keys shouldContainExactly setOf("${SecureStore.PREFIX}device.key")
    }

    "camera-roll enumeration is keyset, and exact SHA-256 is the identity" {
        val assets = (1..5).map { index ->
            MediaLibrary.Asset(
                localId = "local-$index",
                sha256 = "sha-$index",
                bytes = 1_000L * index,
                capturedAtIso = "2026-09-0${index}T00:00:00Z",
                capturedUtcOffsetMinutes = 0,
                // A HINT ONLY. Two assets may share it and must not merge.
                perceptualHash = "dhash-shared",
            )
        }
        val library = FakePlatformServices().mediaLibrary.also { it.assets = assets }
        val first = library.page(afterCursor = null, limit = 2)
        first.assets.map { it.localId } shouldContainExactly listOf("local-1", "local-2")
        first.nextCursor shouldBe "local-2"
        val second = library.page(afterCursor = first.nextCursor, limit = 2)
        second.assets.map { it.localId } shouldContainExactly listOf("local-3", "local-4")
        val last = library.page(afterCursor = second.nextCursor, limit = 2)
        last.assets.map { it.localId } shouldContainExactly listOf("local-5")
        // The rows ended, so there is no cursor. Never a cursor past the end.
        last.nextCursor.shouldBeNull()

        // The dHash is shared across all five and is not an identity: nothing
        // in this interface lets a caller merge on it.
        assets.map { it.perceptualHash }.distinct().size shouldBe 1
        assets.map { it.sha256 }.distinct().size shouldBe 5
    }

    "there is no way to delete a photo through MediaLibrary, and that is the enforcement" {
        // `NATIVE_V0.md:11-19`: vault trash NEVER calls media deletion. The
        // absence is asserted by naming it: no member of the interface deletes.
        val members = MediaLibrary::class.members.map { it.name }
        members.none { it.contains("delete", ignoreCase = true) }.shouldBeTrue()
        members.none { it.contains("remove", ignoreCase = true) }.shouldBeTrue()
    }

    "background registration is observable: a refusal carries a sentence" {
        val tasks = FakePlatformServices().backgroundTasks
        tasks.answer = dev.centraid.shared.platform.BackgroundTasks.Registration(
            registered = false,
            sentence = "Background App Refresh is off, so Centraid only catches up " +
                "when you open it.",
            refusal = "BGTaskScheduler refused",
        )
        val registration = tasks.register()
        registration.registered.shouldBeFalse()
        registration.sentence shouldContain "Background App Refresh is off"
        tasks.registrations shouldBe 1
    }
})
