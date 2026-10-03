package dev.centraid.shared.sync

import centraid.screen.v1.BackupLine
import centraid.screen.v1.BackupWaitingRow
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.custody.CustodyCopy

/**
 * THE ONE HONEST LINE, FROM THE CORE'S READING (#1080 ruling 7, the shells).
 *
 * A pure function of [BackupReading], so `BackupStatusSpec` proves every
 * sentence without a core. Its one rule is the umbrella's UI invariant: **the
 * line never says more than a gateway acknowledged.** "Backed up" with no
 * qualifier needs the records acknowledged AND every item confirmed; records
 * acknowledged with items still waiting say so, and say how many.
 */
public object BackupLines {

    /** An acknowledgement older than this, or a gateway unreached as long, earns attention. */
    public const val STALE_MS: Long = 3L * DAY_MS

    /**
     * The line for one vault. [reading] null is "the core could not be asked"
     * (a resting vault): the line is empty and the view draws nothing.
     * [nowMs] is this phone's clock, for "2 minutes ago" only.
     */
    public fun line(reading: BackupReading?, frozen: Boolean, nowMs: Long): BackupLine {
        if (frozen) {
            return finish(
                BackupLine(
                    frozen = true,
                    sentence = SharedCopy.BACKUP_LINE_FROZEN,
                    tone = BackupLine.Tone.TONE_URGENT,
                ),
            )
        }
        if (reading == null) return BackupLine()
        val waiting = waitingRows(reading)
        if (reading.destinations.isEmpty()) {
            return finish(
                BackupLine(
                    unpaired = true,
                    total = reading.contentTotal,
                    sentence = SharedCopy.BACKUP_LINE_UNPAIRED,
                    tone = BackupLine.Tone.TONE_ATTENTION,
                ),
            )
        }
        val acked = reading.lastAckMs
        val counts = counts(reading)
        if (acked == null) {
            return finish(
                BackupLine(
                    confirmed = reading.contentConfirmed,
                    total = reading.contentTotal,
                    waiting = waiting,
                    sentence = SharedCopy.BACKUP_LINE_NEVER,
                    detail = counts,
                    tone = BackupLine.Tone.TONE_ATTENTION,
                ),
            )
        }
        val whole = reading.unconfirmed == 0L
        val stale = nowMs - acked > STALE_MS || reading.destinations.none { seen ->
            val at = seen.lastSeenMs
            at != null && nowMs - at <= STALE_MS
        }
        return finish(
            BackupLine(
                records_as_of_ms = acked,
                confirmed = reading.contentConfirmed,
                total = reading.contentTotal,
                waiting = waiting,
                sentence = (if (whole) SharedCopy.BACKUP_LINE_DONE else SharedCopy.BACKUP_LINE_RECORDS)
                    .replace("{when}", ago(acked, nowMs)),
                detail = counts,
                tone = if (stale) BackupLine.Tone.TONE_ATTENTION else BackupLine.Tone.TONE_QUIET,
            ),
        )
    }

    /** "1,203 of 1,240 photos and files", "All 1,240 photos and files", or empty for none. */
    internal fun counts(reading: BackupReading): String = when {
        reading.contentTotal <= 0L -> ""
        reading.unconfirmed == 0L ->
            SharedCopy.BACKUP_LINE_ALL.replace("{total}", CustodyCopy.grouped(reading.contentTotal))
        else -> SharedCopy.BACKUP_LINE_COUNT
            .replace("{confirmed}", CustodyCopy.grouped(reading.contentConfirmed))
            .replace("{total}", CustodyCopy.grouped(reading.contentTotal))
    }

    /** One row per reason that holds items, in [WaitReason]'s order. */
    internal fun waitingRows(reading: BackupReading): List<BackupWaitingRow> =
        WaitReason.entries.mapNotNull { reason ->
            val count = reading.waiting[reason] ?: 0L
            if (count <= 0L) {
                null
            } else {
                BackupWaitingRow(
                    reason = wire(reason),
                    count = count,
                    label = waitingWords(reason).replace("{count}", CustodyCopy.grouped(count)),
                )
            }
        }

    private fun waitingWords(reason: WaitReason): String = when (reason) {
        WaitReason.WIFI -> SharedCopy.BACKUP_WAIT_WIFI
        WaitReason.CHARGER -> SharedCopy.BACKUP_WAIT_CHARGER
        WaitReason.GATEWAY -> SharedCopy.BACKUP_WAIT_GATEWAY
        WaitReason.ICLOUD -> SharedCopy.BACKUP_WAIT_ICLOUD
        WaitReason.BYTES -> SharedCopy.BACKUP_WAIT_BYTES
        WaitReason.WINDOW -> SharedCopy.BACKUP_WAIT_WINDOW
    }

    private fun wire(reason: WaitReason): BackupWaitingRow.Reason = when (reason) {
        WaitReason.WIFI -> BackupWaitingRow.Reason.REASON_WIFI
        WaitReason.CHARGER -> BackupWaitingRow.Reason.REASON_CHARGER
        WaitReason.GATEWAY -> BackupWaitingRow.Reason.REASON_GATEWAY
        WaitReason.ICLOUD -> BackupWaitingRow.Reason.REASON_ICLOUD
        WaitReason.BYTES -> BackupWaitingRow.Reason.REASON_BYTES
        WaitReason.WINDOW -> BackupWaitingRow.Reason.REASON_WINDOW
    }

    /** The accessibility label is the line read aloud: sentence, detail, then what waits. */
    private fun finish(line: BackupLine): BackupLine = line.copy(
        accessibility_label = (listOf(line.sentence.removeSuffix("."), line.detail) + line.waiting.map { it.label })
            .filter { it.isNotEmpty() }
            .joinToString(". "),
    )

    /**
     * HOW LONG AGO, BY ELAPSED TIME ONLY. `commonMain` has no calendar, so
     * there is no "yesterday at 14:02": a day here is 24 hours. A [thenMs]
     * ahead of [nowMs] — two clocks that disagree — reads as "just now"
     * rather than as a time in the future.
     */
    public fun ago(thenMs: Long, nowMs: Long): String {
        val elapsed = (nowMs - thenMs).coerceAtLeast(0)
        val minutes = elapsed / MINUTE_MS
        val hours = elapsed / HOUR_MS
        val days = elapsed / DAY_MS
        return when {
            minutes < 1 -> SharedCopy.BACKUP_AGO_NOW
            minutes == 1L -> SharedCopy.BACKUP_AGO_MINUTE
            hours < 1 -> SharedCopy.BACKUP_AGO_MINUTES.replace("{n}", minutes.toString())
            hours == 1L -> SharedCopy.BACKUP_AGO_HOUR
            days < 1 -> SharedCopy.BACKUP_AGO_HOURS.replace("{n}", hours.toString())
            days == 1L -> SharedCopy.BACKUP_AGO_DAY
            else -> SharedCopy.BACKUP_AGO_DAYS.replace("{n}", days.toString())
        }
    }
}

private const val MINUTE_MS: Long = 60_000
private const val HOUR_MS: Long = 60L * MINUTE_MS
private const val DAY_MS: Long = 24L * HOUR_MS
