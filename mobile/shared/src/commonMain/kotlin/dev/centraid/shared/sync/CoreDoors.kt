package dev.centraid.shared.sync

import centraid.core.v1.BackupStatusRequest
import centraid.core.v1.DrainRequest
import centraid.core.v1.DrainStop
import centraid.core.v1.Envelope
import centraid.core.v1.ErrorCode
import centraid.core.v1.PairRequest
import centraid.core.v1.Request
import centraid.core.v1.RestoreRequest
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreFailure
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.custody.PairAnswer
import dev.centraid.shared.custody.PairDoor
import dev.centraid.shared.custody.RestoreAnswer
import dev.centraid.shared.custody.RestoreDoor
import okio.ByteString.Companion.toByteString

/**
 * THE FOUR REQUEST KINDS, AS THE SHELL'S DOORS (#1029 W18-2, over W15-1).
 *
 * W15 landed `drain = 15`, `pair_phone = 16`, `restore = 17` and
 * `backup_status = 18` on `Request.kind`, each answered at the same field
 * number on `Response.kind` (`crates/api-proto/proto/centraid/core/v1/phone.proto`).
 * This file is the whole of what crosses: one `Envelope` per call over the ABI
 * `CentraidCore` already holds, and a `when` over the answer.
 *
 * **Every door is nullable-on-unreachable and never throws.** "Your laptop did
 * not answer" is a sentence a member reads, not an exception a pass has to
 * guess the meaning of, and `DrainPass` and the two custody machines are
 * written against exactly that.
 *
 * **The core is asked of a SUPPLIER and not held.** The shelf moves the
 * foreground holding on a vault switch, and a door bound to one handle would go
 * on draining a vault the member has left — the same reason `HomeRuntime` takes
 * its core as a supplier (R-HOME-2).
 */
public class CoreDrainDoor(private val core: () -> CentraidCore?) : DrainDoor {

    override suspend fun drain(deadlineMs: Long): DrainAnswer? {
        val open = core() ?: return null
        val answer = open.call(
            Envelope(request_id = 0, request = Request(drain = DrainRequest(deadlineMs))),
        )
        return when (answer) {
            is CoreOutcome.Answered -> answer.value.response?.drain?.let { drained ->
                DrainAnswer(
                    ackedTxid = drained.acked_txid,
                    pendingBytes = drained.pending_bytes,
                    stopped = when (drained.stopped) {
                        DrainStop.DRAIN_STOP_EMPTY -> DrainAnswer.Stopped.EMPTY
                        DrainStop.DRAIN_STOP_DEADLINE -> DrainAnswer.Stopped.DEADLINE
                        // UNSPECIFIED IS READ AS UNREACHABLE, DELIBERATELY. A
                        // core from a build that grew a fourth reason answers a
                        // value this one has no name for, and the safe reading
                        // of "I do not know why it stopped" is the one that
                        // leaves the claim behind rather than ahead.
                        else -> DrainAnswer.Stopped.UNREACHABLE
                    },
                    lastAckedAtMs = drained.acked_at_ms,
                )
            }
            is CoreOutcome.Failed -> when {
                // A DRAIN IS ALREADY RUNNING. `phone.proto` says the core
                // refuses rather than queueing and tells the shell so; the pass
                // has its own try-lock, and this is the same answer arriving
                // from the other side of the ABI — from a background window that
                // cannot see a foreground pass.
                answer.failure.isRefusedWith(ErrorCode.ERROR_CODE_INVALID_REQUEST) -> null
                else -> null
            }
        }
    }
}

/** `pair_phone = 16`. */
public class CorePairDoor(private val core: () -> CentraidCore?) : PairDoor {

    override suspend fun pair(payload: String): PairAnswer? {
        val open = core() ?: return null
        val answer = open.call(
            Envelope(request_id = 0, request = Request(pair_phone = PairRequest(payload = payload))),
        )
        val paired = (answer as? CoreOutcome.Answered)?.value?.response?.pair_phone ?: return null
        return PairAnswer(
            // WHAT THE MEMBER COMPARES IS THE ENDPOINT THE PHONE WILL DIAL.
            // See `CustodyCopy.pairedLine`: the laptop's terminal prints this
            // same id, so the two are comparable by eye.
            gatewayEndpoint = paired.gateway_endpoint.hex(),
            recordPublished = paired.record_published,
        )
    }
}

/** `restore = 17`. */
public class CoreRestoreDoor(private val core: () -> CentraidCore?) : RestoreDoor {

    override suspend fun restore(words: List<String>, endpoint: String?): RestoreAnswer? {
        val open = core() ?: return null
        val answer = open.call(
            Envelope(
                request_id = 0,
                request = Request(
                    restore = RestoreRequest(
                        // THE WORDS AS ONE STRING, because
                        // `RecoveryPhrase::parse` owns what a phrase is and a
                        // second parser here would disagree with it.
                        phrase = words.joinToString(" "),
                        endpoint = endpoint?.let { hexToBytes(it) },
                    ),
                ),
            ),
        )
        val restored = (answer as? CoreOutcome.Answered)?.value?.response?.restore ?: return null
        return RestoreAnswer(
            vaults = restored.vaults.size,
            rows = restored.vaults.sumOf { it.rows },
            gapScanned = restored.gap_scanned,
        )
    }
}

/**
 * `backup_status = 18` — what the backup row draws.
 *
 * **It dials nothing**, which is `phone.proto`'s own rule: drawing a screen
 * must not depend on somebody else's network.
 */
public class CoreBackupStatus(private val core: () -> CentraidCore?) {

    public suspend fun read(): Reading? {
        val open = core() ?: return null
        val answer = open.call(
            Envelope(request_id = 0, request = Request(backup_status = BackupStatusRequest())),
        )
        val status = (answer as? CoreOutcome.Answered)?.value?.response?.backup_status ?: return null
        return Reading(
            ackedTxid = status.acked_txid,
            lastAckedAtMs = status.acked_at_ms,
            pendingBytes = status.pending_bytes,
            laptopPaired = status.laptop_paired,
        )
    }

    /**
     * What the core knows without asking anyone.
     *
     * [lastAckedAtMs] is the GATEWAY's clock and is the only moment a member may
     * be shown as "last backed up" — which is why [BackupClaim.line] takes it
     * and never a local one.
     */
    public data class Reading(
        public val ackedTxid: Long?,
        public val lastAckedAtMs: Long?,
        public val pendingBytes: Long,
        public val laptopPaired: Boolean,
    ) {
        /** The backup row's line, through the one fold that may say "backed up". */
        public fun line(unacked: Int, relative: String): String =
            BackupClaim.line(lastAckedAtMs, unacked, relative)
    }
}

/** Whether a failure is the core refusing with this code. */
internal fun CoreFailure.isRefusedWith(code: ErrorCode): Boolean =
    this is CoreFailure.Refused && this.code == code.value

/**
 * A 32-byte endpoint id from the hex a member typed, or null.
 *
 * **Null rather than a throw, and null rather than a partial read.** A member
 * copying an id off a laptop screen mistypes it, and the core refusing a
 * malformed endpoint would be a refusal arriving as a crash.
 */
internal fun hexToBytes(text: String): okio.ByteString? {
    val hex = text.trim().lowercase().filterNot { it == ' ' || it == '-' }
    if (hex.length != 64 || hex.any { it !in "0123456789abcdef" }) return null
    return ByteArray(32) { i ->
        ((hex[i * 2].digitToInt(16) shl 4) or hex[i * 2 + 1].digitToInt(16)).toByte()
    }.toByteString()
}
