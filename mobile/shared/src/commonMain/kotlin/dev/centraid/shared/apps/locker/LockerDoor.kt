package dev.centraid.shared.apps.locker

import centraid.core.v1.Envelope
import centraid.core.v1.LockerExportAsk
import centraid.core.v1.LockerExportFormat
import centraid.core.v1.LockerImportAsk
import centraid.core.v1.LockerImportPlan
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
import okio.ByteString.Companion.toByteString

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
 * answered (Q-1047-16). `export` is every secret in a file, receipted as one
 * mass reveal before a cell opens, and `import` a picked file's plan or its
 * publish, each secret sealed on the way in (#1047 T2). Every call answers the
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

    /**
     * One reveal as the item page asks it (#1047 T2): a custom field's value
     * when [fieldId] is set, and [copy] when the value goes to the clipboard
     * — which the receipt records. A door that knows neither asks [reveal].
     */
    public suspend fun reveal(itemId: String, column: String, fieldId: String, copy: Boolean): LockerDoorAnswer =
        if (fieldId.isEmpty()) reveal(itemId, column) else LockerDoorAnswer.Unreachable(LockerCopy.NO_ANSWER)

    /** A code, receipted as a copy when [copy]. */
    public suspend fun totp(itemId: String, copy: Boolean): LockerDoorAnswer = totp(itemId)

    /** Every secret, in a [format] file dated in [zone]. */
    public suspend fun export(format: LockerExportFormat, zone: String): LockerDoorAnswer =
        LockerDoorAnswer.Unreachable(LockerCopy.NO_ANSWER)

    /** A picked file's plan, or — [publish] — what writing it did. */
    public suspend fun import(content: ByteArray, publish: Boolean): LockerDoorAnswer =
        LockerDoorAnswer.Unreachable(LockerCopy.NO_ANSWER)
}

/** What one session step answered. */
public sealed interface LockerDoorAnswer {
    /** The session is [open] or not, and — on a reveal — what happened to it. */
    public data class Session(
        public val open: Boolean,
        public val revealed: Revealed? = null,
        public val refusal: LockerRevealRefusal = LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_UNSPECIFIED,
        public val code: Code? = null,
        /** An export's file (#1047 T2). */
        public val exported: Exported? = null,
        /** An import's plan, or what a publish wrote (#1047 T2). No row carries a secret. */
        public val plan: LockerImportPlan? = null,
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

    /**
     * EVERY SECRET, IN A FILE, for the save sheet and nowhere else. Not a
     * `data class`, for [Revealed]'s reason: its bytes are every secret.
     */
    public class Exported(
        public val content: ByteArray,
        public val fileName: String,
        public val mediaType: String,
        public val itemCount: Int,
        /** Sealed values that did not open and are not in the file. */
        public val unopened: Int,
    ) {
        override fun toString(): String = "Exported($fileName, $itemCount items, «concealed»)"
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

    override suspend fun reveal(itemId: String, column: String, fieldId: String, copy: Boolean): LockerDoorAnswer =
        step(LockerSessionRequest(reveal = LockerReveal(item_id = itemId, column = column, field_id = fieldId, copy = copy)))

    override suspend fun totp(itemId: String, copy: Boolean): LockerDoorAnswer =
        step(LockerSessionRequest(totp = LockerTotpAsk(item_id = itemId, copy = copy)))

    override suspend fun export(format: LockerExportFormat, zone: String): LockerDoorAnswer =
        step(LockerSessionRequest(export = LockerExportAsk(format = format, tz = zone)))

    override suspend fun import(content: ByteArray, publish: Boolean): LockerDoorAnswer =
        step(LockerSessionRequest(import_file = LockerImportAsk(content = content.toByteString(), publish = publish)))

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
            exported = response.exported?.let {
                LockerDoorAnswer.Exported(
                    content = it.content.toByteArray(),
                    fileName = it.file_name,
                    mediaType = it.media_type,
                    itemCount = it.item_count,
                    unopened = it.unopened,
                )
            },
            plan = response.import_plan,
        )
}
