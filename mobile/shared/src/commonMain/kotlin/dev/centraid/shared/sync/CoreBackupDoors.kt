package dev.centraid.shared.sync

import centraid.core.v1.BackupStatusRequest
import centraid.core.v1.Destination
import centraid.core.v1.Envelope
import centraid.core.v1.FetchOriginalRequest
import centraid.core.v1.FetchOutcome
import centraid.core.v1.ForgetDestinationRequest
import centraid.core.v1.HandoffPart
import centraid.core.v1.HandoffRequest
import centraid.core.v1.PinsRequest
import centraid.core.v1.ReconcileRequest
import centraid.core.v1.Request
import centraid.core.v1.Response
import centraid.core.v1.SettleRequest
import centraid.core.v1.Settled
import centraid.core.v1.WaitReason as WireWaitReason
import dev.centraid.core.CentraidCore
import dev.centraid.design.copy.SharedCopy
import dev.centraid.core.CoreOutcome

/**
 * THE BACKUP PLANE'S DOORS OVER THE CORE'S WIRE (#1080; `phone.proto`, arms
 * 18 and 23–28).
 *
 * Every door answers null for "no core" and for every refusal, which a shell
 * treats exactly as it treats a core that is not open. A gateway's id is a backup
 * DESTINATION's (#1080 ruling 8); a vault is never mounted by one (A13).
 */
public class CoreBackupStatus(private val core: () -> CentraidCore?) : BackupStatusDoor {

    /** `backup_status = 18`. It dials nothing: a screen must not wait on somebody else's network. */
    override suspend fun read(): BackupReading? {
        val status = askDoor(core, Request(backup_status = BackupStatusRequest()))?.backup_status ?: return null
        return BackupReading(
            destinations = status.destinations.map(::destinationOf),
            lastSnapshotMs = status.last_snapshot_ms,
            // `acked_at_ms` IS THE HEAD'S ACKNOWLEDGEMENT, on the gateway's clock.
            lastAckMs = status.acked_at_ms,
            contentTotal = status.content_total,
            contentConfirmed = status.content_confirmed,
            pendingBytes = status.pending_bytes,
            spoolBytes = status.spool_bytes,
            waiting = status.waiting
                .mapNotNull { row -> reasonOf(row.reason)?.let { it to row.count } }
                .groupBy({ it.first }, { it.second })
                .mapValues { (_, counts) -> counts.sum() },
            frozen = status.frozen,
        )
    }
}

/** The six doors beside the pass (arms 23–28). */
public class CoreBackupDoors(private val core: () -> CentraidCore?) : UploadDoors {

    /** `handoff = 23`: spool parts for the OS to upload, marked handed off, passed on whole. */
    override suspend fun handoff(maxBytes: Long, maxParts: Int): List<HandoffPart>? =
        askDoor(core, Request(handoff = HandoffRequest(max_bytes = maxBytes, max_parts = maxParts)))?.handoff?.parts

    /** `settle = 24`: what the OS reported. The core ignores names its ledger does not hold (A6). */
    override suspend fun settle(settled: List<Settled>): LedgerChange? =
        askDoor(core, Request(settle = SettleRequest(settled = settled)))
            ?.settle?.let { LedgerChange(confirmed = it.confirmed, requeued = it.requeued) }

    /** `reconcile = 27`: the ledger squared with what a gateway holds; the probe before a batch. */
    override suspend fun reconcile(): LedgerChange? =
        askDoor(core, Request(reconcile = ReconcileRequest()))?.reconcile?.let {
            LedgerChange(confirmed = it.confirmed, requeued = it.requeued, reachable = it.reachable)
        }

    /** `pins = 26`: the certificates the shell's own TLS pins, by byte equality. */
    public suspend fun pins(): List<UploadPin>? =
        askDoor(core, Request(pins = PinsRequest()))?.pins?.destinations?.map {
            UploadPin(gateway = it.gateway_id, certDer = it.cert_der.toByteArray(), addrs = it.addrs)
        }

    /** `fetch_original = 25`: one original back by its content hash; the path when it landed. */
    public suspend fun fetchOriginal(contentHash: String): Pair<FetchedOriginal, String>? {
        val raw = ContentHash.raw(contentHash) ?: return null
        val fetched = askDoor(core, Request(fetch_original = FetchOriginalRequest(content_hash = raw)))?.fetch_original
            ?: return null
        val outcome = when (fetched.outcome) {
            FetchOutcome.FETCH_OUTCOME_LANDED -> FetchedOriginal.LANDED
            FetchOutcome.FETCH_OUTCOME_ALREADY_HELD -> FetchedOriginal.ALREADY_HELD
            FetchOutcome.FETCH_OUTCOME_NOT_IN_BACKUP -> FetchedOriginal.NOT_IN_BACKUP
            FetchOutcome.FETCH_OUTCOME_UNTRUSTED -> FetchedOriginal.UNTRUSTED
            FetchOutcome.FETCH_OUTCOME_DAMAGED -> FetchedOriginal.DAMAGED
            FetchOutcome.FETCH_OUTCOME_UNREACHABLE -> FetchedOriginal.UNREACHABLE
            // UNSPECIFIED READS AS UNREACHABLE: "try again" is never a harmful remedy.
            FetchOutcome.FETCH_OUTCOME_UNSPECIFIED -> FetchedOriginal.UNREACHABLE
        }
        return outcome to fetched.path
    }

    /**
     * `forget_destination = 28` (A5): whether the ledger dropped the gateway,
     * and whether the gateway confirmed this phone's token opens nothing there
     * any more. Null for no core and every refusal.
     */
    public suspend fun forget(gatewayId: String): ForgetAnswer? =
        askDoor(core, Request(forget_destination = ForgetDestinationRequest(gateway_id = gatewayId)))
            ?.forget_destination?.let { ForgetAnswer(forgotten = it.forgotten, revoked = it.revoked) }
}

/** What forgetting a gateway came to (`ForgetDestinationResponse`). */
public data class ForgetAnswer(
    /** The ledger held the gateway and dropped it. False: it held no such gateway. */
    public val forgotten: Boolean,
    /**
     * The gateway confirmed this phone's token opens nothing there any more,
     * an operator's earlier revoke included. False when it could not be
     * reached, another machine answered, or the core had no keys to name the
     * vault with: the token then stays live there until its operator runs
     * `centraid-gateway pairings revoke`.
     */
    public val revoked: Boolean,
)

/**
 * How fetching one original back by its content hash went (`FetchOutcome`),
 * and the line a screen shows when it did not come back. [fetched] means the
 * bytes are on this phone now, so the next read serves the original.
 */
public enum class FetchedOriginal(public val fetched: Boolean, public val sentence: String) {
    LANDED(true, ""),
    ALREADY_HELD(true, ""),
    UNREACHABLE(false, SharedCopy.FETCH_UNREACHABLE),
    NOT_IN_BACKUP(false, SharedCopy.FETCH_NOT_IN_BACKUP),

    /** The machine that answered at the gateway's address is not the pinned gateway. */
    UNTRUSTED(false, SharedCopy.FETCH_UNTRUSTED),

    /** The gateway's copy did not open: a sealed part failed its checks. */
    DAMAGED(false, SharedCopy.FETCH_DAMAGED),
}

/**
 * One envelope, its `Response` or null for no core and for every refusal. The
 * backup and free-up doors share it, so "no answer" means one thing in both.
 */
internal suspend fun askDoor(core: () -> CentraidCore?, request: Request): Response? {
    val open = core() ?: return null
    return (open.call(Envelope(request_id = 0, request = request)) as? CoreOutcome.Answered)?.value?.response
}

private fun destinationOf(destination: Destination): DestinationReading = DestinationReading(
    gatewayId = destination.gateway_id,
    label = destination.label,
    addrs = destination.addrs,
    // ZERO IS "NEVER" on the wire, and never a time.
    lastSeenMs = destination.last_seen_ms.takeIf { it > 0L },
    lastAckMs = destination.last_ack_ms.takeIf { it > 0L },
)

private fun reasonOf(reason: WireWaitReason): WaitReason? = when (reason) {
    WireWaitReason.WAIT_REASON_WIFI -> WaitReason.WIFI
    WireWaitReason.WAIT_REASON_CHARGER -> WaitReason.CHARGER
    WireWaitReason.WAIT_REASON_GATEWAY -> WaitReason.GATEWAY
    WireWaitReason.WAIT_REASON_ICLOUD -> WaitReason.ICLOUD
    WireWaitReason.WAIT_REASON_BYTES -> WaitReason.BYTES
    WireWaitReason.WAIT_REASON_WINDOW -> WaitReason.WINDOW
    WireWaitReason.WAIT_REASON_ASK -> WaitReason.ASK
    WireWaitReason.WAIT_REASON_UNTRUSTED -> WaitReason.UNTRUSTED
    WireWaitReason.WAIT_REASON_UNSPECIFIED -> null
}
