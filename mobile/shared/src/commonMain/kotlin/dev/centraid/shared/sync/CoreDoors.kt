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
import dev.centraid.shared.custody.PairRefusal
import dev.centraid.shared.custody.PairResult
import dev.centraid.shared.custody.RestoreAnswer
import dev.centraid.shared.custody.RestoreDoor
import dev.centraid.shared.custody.RestoreRefusal
import dev.centraid.shared.custody.RestoreResult
import dev.centraid.shared.custody.RestoredVaultAt
import dev.centraid.shared.custody.UnclaimedVaultAt
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
 * **Every door never throws, and drain is nullable-on-unreachable.** "Your
 * laptop did not answer" is a sentence a member reads, not an exception a pass
 * has to guess the meaning of, and `DrainPass` is written against exactly that.
 * Pair and restore answer a typed refusal instead (`PairResult`, #1047 E5;
 * `RestoreResult`, #1047 R3), because their screens have a different sentence
 * for a laptop that answered and refused, and restore one more for a backup
 * this phone would not accept.
 *
 * **The core is asked of a SUPPLIER and not held.** The shelf moves the
 * foreground holding on a vault switch, and a door bound to one handle would go
 * on draining a vault the member has left — the same reason `HomeRuntime` takes
 * its core as a supplier (R-HOME-2).
 */
public class CoreDrainDoor(private val core: () -> CentraidCore?) : DrainDoor {

    override suspend fun drain(input: DrainInput): DrainAnswer? {
        val open = core() ?: return null
        val answer = open.call(
            Envelope(request_id = 0, request = Request(drain = DrainRequest(deadline_ms = input.deadlineMs))),
        )
        return when (answer) {
            is CoreOutcome.Answered -> answer.value.response?.drain?.let { drained ->
                DrainAnswer(
                    pendingBytes = drained.pending_bytes,
                    stopped = when (drained.stopped) {
                        DrainStop.DRAIN_STOP_EMPTY -> DrainAnswer.Stopped.EMPTY
                        DrainStop.DRAIN_STOP_DEADLINE -> DrainAnswer.Stopped.DEADLINE
                        // UNSPECIFIED IS READ AS UNREACHABLE, DELIBERATELY: the
                        // safe reading of "I do not know why it stopped" leaves
                        // the claim behind rather than ahead.
                        else -> DrainAnswer.Stopped.UNREACHABLE
                    },
                    ackedAtMs = drained.acked_at_ms,
                )
            }
            is CoreOutcome.Failed -> {
                val failure = answer.failure
                // THE ONE REFUSAL THAT IS AN ANSWER: another phone claimed the
                // vault. Every other refusal is "no pass ran" — including "a
                // pass is already running", which the core refuses rather than
                // queues, exactly as [DrainPass]'s own try-lock does.
                if (failure.isRefusedWith(ErrorCode.ERROR_CODE_VAULT_MOVED)) {
                    DrainAnswer(
                        pendingBytes = 0,
                        stopped = DrainAnswer.Stopped.MOVED,
                        movedAtMs = (failure as CoreFailure.Refused).movedAtMs ?: 0L,
                    )
                } else {
                    null
                }
            }
        }
    }
}

/**
 * `pair_phone = 16`.
 *
 * **The device secret on the answer is kept, here, before anything else**
 * (#1047 E1, R-1047-E4): the core mints it at pair and hands it over exactly
 * once, and the certificate it wrote beside the vault names that key and no
 * other. [keep] stores it in the device-only store for this vault; the next
 * keyed open carries it.
 */
public class CorePairDoor(
    private val core: () -> CentraidCore?,
    private val keep: suspend (deviceSecretHex: String) -> Unit = {},
) : PairDoor {

    override suspend fun pair(payload: String): PairResult {
        val open = core() ?: return PairResult.Refused(PairRefusal.UNREACHABLE)
        val answer = open.call(
            Envelope(request_id = 0, request = Request(pair_phone = PairRequest(payload = payload))),
        )
        val paired = when (answer) {
            is CoreOutcome.Answered -> answer.value.response?.pair_phone
            // THE CODE SAYS WHICH REFUSAL (#1047 E5); the detail stays in the
            // logs. Anything this build does not name is read as silence, the
            // one refusal whose remedy — try again — is never harmful.
            is CoreOutcome.Failed -> return PairResult.Refused(
                when {
                    answer.failure.isRefusedWith(ErrorCode.ERROR_CODE_INVALID_REQUEST) -> PairRefusal.NOT_A_CODE
                    answer.failure.isRefusedWith(ErrorCode.ERROR_CODE_UNAUTHORIZED) -> PairRefusal.NOT_TAKEN
                    else -> PairRefusal.UNREACHABLE
                },
            )
        } ?: return PairResult.Refused(PairRefusal.UNREACHABLE)
        if (paired.device_secret.size == DEVICE_SECRET_BYTES) keep(paired.device_secret.hex())
        return PairResult.Paired(
            PairAnswer(
                gatewayEndpoint = paired.gateway_endpoint.hex(),
                // WHAT THE MEMBER COMPARES (W15-D5): the core's digits, which
                // `centraid-gateway serve` prints once the invite is redeemed.
                safetyNumber = paired.safety_number,
                recordPublished = paired.record_published,
            ),
        )
    }
}

/**
 * `restore = 17`, over a core that holds NO VAULT (#1047 E1).
 *
 * The core lays each vault down under the directory it was opened in, so the
 * supplier is the shelf's custody core, opened over the vault directory.
 */
public class CoreRestoreDoor(private val core: suspend () -> CentraidCore?) : RestoreDoor {

    override suspend fun restore(words: List<String>, endpoint: String?): RestoreResult = ask(
        RestoreRequest(
            // THE WORDS AS ONE STRING, because `RecoveryPhrase::parse` owns
            // what a phrase is and a second parser here would disagree with it.
            phrase = words.joinToString(" "),
            endpoint = endpoint?.let { hexToBytes(it) },
        ),
    )

    /**
     * THE SEED IN PLACE OF THE WORDS (Q-1047-18). `phrase` is left empty:
     * the core refuses a request carrying both.
     */
    override suspend fun restoreSeed(seedHex: String, endpoint: String?): RestoreResult {
        val seed = hexToBytes(seedHex, SEED_BYTES) ?: return RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
        return ask(RestoreRequest(seed = seed, endpoint = endpoint?.let { hexToBytes(it) }))
    }

    /** The vaults that stayed, by index, from the stored seed (R-1047-R6). */
    override suspend fun restoreStayed(seedHex: String, endpoint: String?, indices: List<Int>): RestoreResult {
        val seed = hexToBytes(seedHex, SEED_BYTES) ?: return RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
        return ask(RestoreRequest(seed = seed, endpoint = endpoint?.let { hexToBytes(it) }, indices = indices))
    }

    private suspend fun ask(request: RestoreRequest): RestoreResult {
        val open = core() ?: return RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
        val answer = open.call(Envelope(request_id = 0, request = Request(restore = request)))
        val restored = when (answer) {
            is CoreOutcome.Answered -> answer.value.response?.restore
            // THE CODE SAYS WHICH REFUSAL (#1047 R3); the detail stays in the
            // logs. Anything this build does not name is read as silence, the
            // one refusal whose remedy — try again — is never harmful.
            is CoreOutcome.Failed -> return RestoreResult.Refused(
                when {
                    answer.failure.isRefusedWith(ErrorCode.ERROR_CODE_INTERNAL) -> RestoreRefusal.DID_NOT_CHECK
                    answer.failure.isRefusedWith(ErrorCode.ERROR_CODE_UNAUTHORIZED) -> RestoreRefusal.NOT_TAKEN
                    else -> RestoreRefusal.UNREACHABLE
                },
            )
        } ?: return RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
        return RestoreResult.Restored(RestoreAnswer(
            vaults = restored.vaults.map {
                RestoredVaultAt(
                    path = it.path,
                    index = it.index,
                    rows = it.rows,
                    safetyNumber = it.safety_number,
                )
            },
            gapScanned = restored.gap_scanned,
            deviceSecretHex = restored.device_secret.takeIf { it.size == DEVICE_SECRET_BYTES }?.hex().orEmpty(),
            // A VAULT THAT STAYED WITH THE OLD PHONE (R-1047-R5), by index and
            // id. Its `reason` is the core's support log and stays there.
            unclaimed = restored.unclaimed.map { UnclaimedVaultAt(index = it.index, vaultId = it.vault_id) },
        ))
    }
}

private const val DEVICE_SECRET_BYTES: Int = 32

/** What `RecoveryPhrase::seed` makes of the 24 words (`RestoreRequest.seed`). */
private const val SEED_BYTES: Int = 64

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
 * [bytes] bytes from hex, or null: a 32-byte endpoint id a member typed, or
 * the 64-byte seed ([SEED_BYTES]) the secure store holds.
 *
 * **Null rather than a throw, and null rather than a partial read.** A member
 * copying an id off a laptop screen mistypes it, and the core refusing a
 * malformed endpoint would be a refusal arriving as a crash. The length is the
 * caller's: a seed read as an endpoint id was null, so every restore from the
 * seed answered "could not reach your laptop" without asking the core
 * (#1047 T1).
 */
internal fun hexToBytes(text: String, bytes: Int = 32): okio.ByteString? {
    val hex = text.trim().lowercase().filterNot { it == ' ' || it == '-' }
    if (hex.length != bytes * 2 || hex.any { it !in "0123456789abcdef" }) return null
    return ByteArray(bytes) { i ->
        ((hex[i * 2].digitToInt(16) shl 4) or hex[i * 2 + 1].digitToInt(16)).toByte()
    }.toByteString()
}
