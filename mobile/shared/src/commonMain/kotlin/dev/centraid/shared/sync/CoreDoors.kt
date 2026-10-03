package dev.centraid.shared.sync

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
 * THE PASS, PAIRING AND RESTORE, AS THE SHELL'S DOORS (#1080; #1029 W15).
 *
 * `drain = 15`, `pair_phone = 16` and `restore = 17` on `Request.kind`, each
 * answered at the same number on `Response.kind` (`phone.proto`). One
 * `Envelope` per call over the ABI `CentraidCore` already holds, and a `when`
 * over the answer. The backup plane's own doors — status and the six beside
 * the pass — are `CoreBackupDoors`.
 *
 * **No door throws.** "The gateway did not answer" is a sentence a member
 * reads, so the pass answers a [DrainAnswer.Stopped] and pair and restore a
 * typed refusal (`PairResult`, #1047 E5; `RestoreResult`, #1047 R3).
 *
 * **The core is asked of a SUPPLIER and not held**: a vault switch moves the
 * foreground, and a door bound to one handle would go on asking a vault the
 * member has left (R-HOME-2).
 */
public class CoreDrainDoor(private val core: () -> CentraidCore?) : DrainDoor {

    override suspend fun drain(input: DrainInput): DrainAnswer? {
        val open = core() ?: return null
        val answer = open.call(
            Envelope(
                request_id = 0,
                request = Request(
                    drain = DrainRequest(
                        deadline_ms = input.deadlineMs,
                        rule = input.rule.toWire(),
                        metered = input.metered,
                        charging = input.charging,
                        wants_snapshot = input.wantsSnapshot,
                        // THE MEMBER'S TAP AND NOTHING ELSE (#1080 A24).
                        asked = input.asked,
                        // THE WIRE CARRIES THE NEGATION (A3), so proto3's zero
                        // value is the complete backup.
                        exclude_videos = !input.includeVideos,
                    ),
                ),
            ),
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
                    confirmedParts = drained.confirmed_parts,
                    waitingBytesParts = drained.waiting_bytes_parts,
                    needBytes = drained.need_bytes.mapNotNull { need ->
                        ContentHash.hex(need.content_hash).takeIf { it.isNotEmpty() }?.let { hash ->
                            NeededBytes(hash, need.os_ref, need.media_type, need.size)
                        }
                    },
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
 * `pair_phone = 16`: the scanned pairing payload, as the member read it off
 * `centraid-gateway pair` (`{v: 2, …}` as JSON, or its square).
 *
 * The answer the member checks is the gateway's label and address and the
 * safety number the core computed over the vault's identity key and the
 * certificate's fingerprint (A7) — the digits the gateway prints when the
 * pairing lands. Nothing secret comes back: the bearer token stays in the
 * core's ledger.
 */
public class CorePairDoor(private val core: () -> CentraidCore?) : PairDoor {

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
        val destination = paired.destination
        return PairResult.Paired(
            PairAnswer(
                safetyNumber = paired.safety_number,
                destinationLabel = destination?.label.orEmpty(),
                destinationAddress = destination?.addrs?.firstOrNull().orEmpty(),
            ),
        )
    }
}

/**
 * `restore = 17`, over a core that holds NO VAULT (#1047 E1).
 *
 * The core lays each vault down under the directory it was opened in, so the
 * supplier is the shelf's custody core, opened over the vault directory. The
 * gateway to restore from is named by the same pairing payload pairing reads
 * (`RestoreRequest.payload`, A1).
 */
public class CoreRestoreDoor(private val core: suspend () -> CentraidCore?) : RestoreDoor {

    override suspend fun restore(words: List<String>, payload: String?): RestoreResult = ask(
        RestoreRequest(
            // THE WORDS AS ONE STRING, because `RecoveryPhrase::parse` owns
            // what a phrase is and a second parser here would disagree with it.
            phrase = words.joinToString(" "),
            payload = payload.orEmpty(),
        ),
    )

    /**
     * THE SEED IN PLACE OF THE WORDS (Q-1047-18). `phrase` is left empty:
     * the core refuses a request carrying both.
     */
    override suspend fun restoreSeed(seedHex: String, payload: String?): RestoreResult {
        val seed = hexToBytes(seedHex, SEED_BYTES) ?: return RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
        return ask(RestoreRequest(seed = seed, payload = payload.orEmpty()))
    }

    /** The vaults that stayed, by index, from the stored seed (R-1047-R6). */
    override suspend fun restoreStayed(seedHex: String, payload: String?, indices: List<Int>): RestoreResult {
        val seed = hexToBytes(seedHex, SEED_BYTES) ?: return RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
        return ask(RestoreRequest(seed = seed, payload = payload.orEmpty(), indices = indices))
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
            // A VAULT THAT STAYED WITH THE OLD PHONE (R-1047-R5), by index and
            // id. Its `reason` is the core's support log and stays there.
            unclaimed = restored.unclaimed.map { UnclaimedVaultAt(index = it.index, vaultId = it.vault_id) },
        ))
    }
}

/** What `RecoveryPhrase::seed` makes of the 24 words (`RestoreRequest.seed`). */
private const val SEED_BYTES: Int = 64

/** Whether a failure is the core refusing with this code. */
internal fun CoreFailure.isRefusedWith(code: ErrorCode): Boolean =
    this is CoreFailure.Refused && this.code == code.value

/**
 * [bytes] bytes from hex, or null: a 32-byte hash, or the 64-byte seed
 * ([SEED_BYTES]) the secure store holds.
 *
 * **Null rather than a throw, and null rather than a partial read.** A value
 * read off a screen is mistyped, and the core refusing a malformed one would be
 * a refusal arriving as a crash. The length is the caller's: a seed read as a
 * 32-byte value was null, so every restore from the seed answered "could not
 * reach your laptop" without asking the core (#1047 T1).
 */
internal fun hexToBytes(text: String, bytes: Int = 32): okio.ByteString? {
    val hex = text.trim().lowercase().filterNot { it == ' ' || it == '-' }
    if (hex.length != bytes * 2 || hex.any { it !in "0123456789abcdef" }) return null
    return ByteArray(bytes) { i ->
        ((hex[i * 2].digitToInt(16) shl 4) or hex[i * 2 + 1].digitToInt(16)).toByte()
    }.toByteString()
}
