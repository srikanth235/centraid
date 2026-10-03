package dev.centraid.shared

import centraid.core.v1.Envelope
import centraid.screen.v1.BackupLine
import centraid.screen.v1.BackupWaitingRow
import dev.centraid.core.CentraidCore
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.sync.BackupLines
import dev.centraid.shared.sync.BackupReading
import dev.centraid.shared.sync.BackupStatusDoor
import dev.centraid.shared.sync.BackupStatusStore
import dev.centraid.shared.sync.DestinationReading
import dev.centraid.shared.sync.WaitReason
import dev.centraid.shared.sync.freezeFor
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotStartWith
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest

/**
 * THE ONE HONEST LINE (#1080 ruling 7: "backed up" means a gateway acknowledged
 * it and the phone recorded that).
 *
 * The line is a pure function of the core's `backup_status`, so every sentence
 * is proved here without a core. The invariant the umbrella cares about — the
 * phone never claims more than was acknowledged — is the first two cases.
 */
class BackupStatusSpec : StringSpec({

    val now = 1_790_000_000_000L
    val minute = 60_000L

    fun gateway(seenAgoMs: Long? = minute) = DestinationReading(
        destinationId = "gw-1",
        label = "Home laptop",
        addrs = listOf("192.168.1.20:7443"),
        lastSeenMs = seenAgoMs?.let { now - it },
        lastAckMs = now - 2 * minute,
    )

    fun reading(
        destinations: List<DestinationReading> = listOf(gateway()),
        lastAckMs: Long? = now - 2 * minute,
        total: Long = 1_240,
        confirmed: Long = 1_240,
        waiting: Map<WaitReason, Long> = emptyMap(),
        frozen: Boolean = false,
    ) = BackupReading(
        destinations = destinations,
        lastSnapshotMs = lastAckMs,
        lastAckMs = lastAckMs,
        contentTotal = total,
        contentConfirmed = confirmed,
        pendingBytes = 0,
        spoolBytes = 0,
        waiting = waiting,
        frozen = frozen,
    )

    "nothing acknowledged is never 'backed up', whatever else the reading says" {
        val line = BackupLines.line(reading(lastAckMs = null, confirmed = 1_240), frozen = false, nowMs = now)
        line.sentence shouldBe SharedCopy.BACKUP_LINE_NEVER
        line.sentence shouldNotStartWith "Backed up"
        line.records_as_of_ms shouldBe 0L
        line.tone shouldBe BackupLine.Tone.TONE_ATTENTION
    }

    "records acknowledged with items still waiting say records, and say how many" {
        val line = BackupLines.line(
            reading(confirmed = 1_203, waiting = mapOf(WaitReason.WIFI to 30L, WaitReason.ICLOUD to 7L)),
            frozen = false,
            nowMs = now,
        )
        line.sentence shouldBe "Records backed up 2 minutes ago."
        line.detail shouldBe "1,203 of 1,240 photos and files"
        line.waiting.map { it.reason } shouldBe listOf(
            BackupWaitingRow.Reason.REASON_WIFI,
            BackupWaitingRow.Reason.REASON_ICLOUD,
        )
        line.waiting.map { it.label } shouldBe listOf("30 waiting for Wi-Fi", "7 waiting in iCloud")
        line.accessibility_label shouldBe
            "Records backed up 2 minutes ago. 1,203 of 1,240 photos and files. 30 waiting for Wi-Fi. 7 waiting in iCloud"
    }

    "everything acknowledged is backed up, quietly, at the gateway's time" {
        val line = BackupLines.line(reading(), frozen = false, nowMs = now)
        line.sentence shouldBe "Backed up 2 minutes ago."
        line.detail shouldBe "All 1,240 photos and files"
        line.records_as_of_ms shouldBe now - 2 * minute
        line.confirmed shouldBe 1_240L
        line.total shouldBe 1_240L
        line.tone shouldBe BackupLine.Tone.TONE_QUIET
    }

    "no gateway paired is an offer to pair, not a status" {
        val line = BackupLines.line(reading(destinations = emptyList()), frozen = false, nowMs = now)
        line.unpaired shouldBe true
        line.sentence shouldBe SharedCopy.BACKUP_LINE_UNPAIRED
        line.tone shouldBe BackupLine.Tone.TONE_ATTENTION
    }

    "a moved vault says so above everything else" {
        val line = BackupLines.line(reading(), frozen = true, nowMs = now)
        line.frozen shouldBe true
        line.sentence shouldBe SharedCopy.BACKUP_LINE_FROZEN
        line.tone shouldBe BackupLine.Tone.TONE_URGENT
    }

    "an old acknowledgement, or a gateway unreached for days, earns attention" {
        val days = 24L * 60L * minute
        BackupLines.line(reading(lastAckMs = now - 4 * days), frozen = false, nowMs = now).tone shouldBe
            BackupLine.Tone.TONE_ATTENTION
        BackupLines.line(reading(destinations = listOf(gateway(seenAgoMs = 5 * days))), frozen = false, nowMs = now)
            .tone shouldBe BackupLine.Tone.TONE_ATTENTION
        BackupLines.line(reading(destinations = listOf(gateway(seenAgoMs = null))), frozen = false, nowMs = now)
            .tone shouldBe BackupLine.Tone.TONE_ATTENTION
    }

    "a vault the core could not be asked about draws no line at all" {
        BackupLines.line(null, frozen = false, nowMs = now) shouldBe BackupLine()
    }

    "how long ago is elapsed time, and a clock ahead of ours is just now" {
        BackupLines.ago(now, now) shouldBe "just now"
        BackupLines.ago(now + 5 * minute, now) shouldBe "just now"
        BackupLines.ago(now - minute, now) shouldBe "1 minute ago"
        BackupLines.ago(now - 59 * minute, now) shouldBe "59 minutes ago"
        BackupLines.ago(now - 60 * minute, now) shouldBe "1 hour ago"
        BackupLines.ago(now - 5 * 60 * minute, now) shouldBe "5 hours ago"
        BackupLines.ago(now - 24 * 60 * minute, now) shouldBe "1 day ago"
        BackupLines.ago(now - 3 * 24 * 60 * minute, now) shouldBe "3 days ago"
    }

    "the store draws the foreground vault's line, and a background vault's read leaves it" {
        runTest {
            val core = CentraidCore.answering(Dispatchers.Unconfined) { Envelope(request_id = 0) }
            val holdings = listOf(
                Shelf.Holding(vaultId = "front", path = "/f", name = "f", core = core),
                Shelf.Holding(vaultId = "back", path = "/b", name = "b", core = core),
            )
            val answers = mapOf("front" to reading(), "back" to reading(lastAckMs = null))
            var asked = ""
            val store = BackupStatusStore(
                holdings = { holdings },
                foreground = { "front" },
                doorFor = { supplier ->
                    BackupStatusDoor {
                        supplier().shouldNotBeNull()
                        answers.getValue(asked)
                    }
                },
                nowMs = { now },
            )
            asked = "front"
            store.refresh("front")
            store.line.value.sentence shouldBe "Backed up 2 minutes ago."
            asked = "back"
            store.refresh("back")
            store.line.value.sentence shouldBe "Backed up 2 minutes ago."
            store.reading("back")?.lastAckMs.shouldBeNull()
        }
    }

    "a moved vault freezes with what is only here, since the last acknowledgement" {
        freezeFor(reading(), movedAtMs = null).shouldBeNull()
        val moved = freezeFor(reading(confirmed = 1_200), movedAtMs = now).shouldNotBeNull()
        moved.unacked shouldBe 40L
        moved.atIso shouldBe dev.centraid.shared.sync.rfc3339FromEpochMillis(now - 2 * minute)
        // THE LEDGER ALONE IS ENOUGH: a vault the core remembers as moved freezes
        // on the next read, with no pass needed.
        freezeFor(reading(frozen = true), movedAtMs = null).shouldNotBeNull().unacked shouldBe 0L
        // NOTHING EVER ACKNOWLEDGED: the move's own time dates it.
        freezeFor(reading(lastAckMs = null), movedAtMs = now).shouldNotBeNull().atIso shouldBe
            dev.centraid.shared.sync.rfc3339FromEpochMillis(now)
    }
})
