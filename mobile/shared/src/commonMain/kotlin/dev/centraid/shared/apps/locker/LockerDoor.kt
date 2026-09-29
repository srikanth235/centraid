package dev.centraid.shared.apps.locker

import centraid.core.v1.Envelope
import centraid.core.v1.LockerRelock
import centraid.core.v1.LockerReveal
import centraid.core.v1.LockerRevealRefusal
import centraid.core.v1.LockerSessionRequest
import centraid.core.v1.LockerSessionResponse
import centraid.core.v1.LockerSessionState
import centraid.core.v1.LockerStateAsk
import centraid.core.v1.LockerTotpAsk
import centraid.core.v1.LockerUnlock
import centraid.core.v1.Request
import dev.centraid.core.CentraidCore
import dev.centraid.design.copy.LockerCopy
import dev.centraid.core.CoreOutcome

/**
 * THE LOCKER SESSION, AS THE SHELL'S DOOR (#1047, D-5): `Request.locker = 21`
 * (`locker.proto`), one envelope per call over the ABI the session already
 * holds.
 *
 * **What crosses.** `unlock` is the report that the OS prompt succeeded — the
 * core cannot see the prompt, so it loads `K`, receipts the unlock as
 * `locker.auth` and opens a session. `relock` zeroes the key. `reveal` is one
 * sealed cell's plaintext, receipted before it exists. `totp` is the one-time
 * code an item's seed makes now, receipted before it exists; the seed is never
 * answered (Q-1047-16). Every call answers the
 * session's state, so a gate never guesses whether idle ended a session.
 *
 * **Nullable on unreachable, never a throw** (`CoreDoors`' rule): no vault, or
 * a failure, is [LockerDoorAnswer.Unreachable] with the core's own sentence —
 * a sentence a member reads, not an exception a machine interprets.
 */
public interface LockerDoor {
    public suspend fun state(): LockerDoorAnswer

    public suspend fun unlock(): LockerDoorAnswer

    public suspend fun relock(): LockerDoorAnswer

    public suspend fun reveal(itemId: String, column: String): LockerDoorAnswer

    /** The code [itemId]'s seed makes now. A door that cannot make one says so. */
    public suspend fun totp(itemId: String): LockerDoorAnswer = LockerDoorAnswer.Unreachable(LockerCopy.NO_ANSWER)
}

/** What one session step answered. */
public sealed interface LockerDoorAnswer {
    /** The session is [open] or not, and — on a reveal — what happened to it. */
    public data class Session(
        public val open: Boolean,
        public val revealed: Revealed? = null,
        public val refusal: LockerRevealRefusal = LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_UNSPECIFIED,
        public val code: Code? = null,
    ) : LockerDoorAnswer

    /** No core, or the core refused; [sentence] is the member's. */
    public data class Unreachable(public val sentence: String) : LockerDoorAnswer

    /**
     * ONE CELL'S PLAINTEXT, WITH A LIFE. Not a `data class`: a generated
     * `toString` would print the value into a log line.
     */
    public class Revealed(
        public val itemId: String,
        public val column: String,
        public val value: String,
        public val receiptId: String,
        public val expiresInMs: Long,
    ) {
        override fun toString(): String = "Revealed($itemId, $column, «concealed»)"
    }

    /**
     * ONE ONE-TIME CODE, WITH ITS LIFE: six digits good for [remainingSeconds]
     * more. Not a `data class`, for [Revealed]'s reason.
     */
    public class Code(
        public val itemId: String,
        public val code: String,
        public val periodSeconds: Int,
        public val remainingSeconds: Int,
        public val receiptId: String,
    ) {
        override fun toString(): String = "Code($itemId, «concealed», $remainingSeconds s)"
    }
}

/** The door over the session's core, taken as a SUPPLIER (a vault switch is a new core). */
public class CoreLockerDoor(private val core: () -> CentraidCore?) : LockerDoor {
    override suspend fun state(): LockerDoorAnswer = step(LockerSessionRequest(state = LockerStateAsk()))

    override suspend fun unlock(): LockerDoorAnswer = step(LockerSessionRequest(unlock = LockerUnlock()))

    override suspend fun relock(): LockerDoorAnswer = step(LockerSessionRequest(relock = LockerRelock()))

    override suspend fun reveal(itemId: String, column: String): LockerDoorAnswer =
        step(LockerSessionRequest(reveal = LockerReveal(item_id = itemId, column = column)))

    override suspend fun totp(itemId: String): LockerDoorAnswer =
        step(LockerSessionRequest(totp = LockerTotpAsk(item_id = itemId)))

    private suspend fun step(request: LockerSessionRequest): LockerDoorAnswer {
        val open = core() ?: return LockerDoorAnswer.Unreachable(LockerCopy.NO_VAULT)
        return when (val answer = open.call(Envelope(request_id = 0, request = Request(locker = request)))) {
            is CoreOutcome.Answered ->
                answer.value.response?.locker?.let(::sessionOf)
                    ?: LockerDoorAnswer.Unreachable(LockerCopy.NO_ANSWER)
            is CoreOutcome.Failed -> LockerDoorAnswer.Unreachable(answer.failure.sentence)
        }
    }

    private fun sessionOf(response: LockerSessionResponse): LockerDoorAnswer.Session =
        LockerDoorAnswer.Session(
            open = response.state == LockerSessionState.LOCKER_SESSION_STATE_UNLOCKED,
            revealed = response.revealed?.let {
                LockerDoorAnswer.Revealed(
                    itemId = it.item_id,
                    column = it.column,
                    value = it.value_,
                    receiptId = it.receipt_id,
                    expiresInMs = it.expires_in_ms,
                )
            },
            refusal = response.refusal,
            code = response.totp?.let {
                LockerDoorAnswer.Code(
                    itemId = it.item_id,
                    code = it.code,
                    periodSeconds = it.period_seconds,
                    remainingSeconds = it.remaining_seconds,
                    receiptId = it.receipt_id,
                )
            },
        )
}
