package dev.centraid.shared.shell

import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.core.v1.StageBegin
import centraid.core.v1.StageChunk
import centraid.core.v1.StageEnd
import centraid.core.v1.StageRequest
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import okio.ByteString.Companion.toByteString

/**
 * THE SHELL STREAMS BYTES IN; THE CORE NAMES THEM (#1025 S5; S4, D-1025-S4-6).
 *
 * The Kotlin side of `centraid.core.v1.StageRequest`, which S4 added to the
 * core and left with no caller above the C ABI.
 *
 * ## Why the shell cannot name its own bytes
 *
 * `MediaLibrary.Asset` carried a `sha256` documented as "THE identity" and it
 * was not one: the identity of a member's bytes is
 * `core_content_item.content_hash`, which is BLAKE3 and is UNIQUE — and
 * **neither `CryptoKit` nor `MessageDigest` nor `crypto.subtle` offers
 * BLAKE3**. So every shell that declared a digest was declaring a different
 * function's value under the vault's name. The field is deleted; this is what
 * replaces it. Nothing is lost, because there was never anything a sender could
 * assert that the receiver did not then compute for itself, and the receiver is
 * the one whose answer the column is UNIQUE on.
 *
 * ## Three frames, and what each refusal is for
 *
 * `begin` declares the media type and the length — the media type because the
 * core has no sniffer and a photograph promoted as `application/octet-stream`
 * is one a grid will not embed; the length because it is the allocation AND the
 * bound. `chunk` is numbered from zero and checked against the next expected
 * one, so a transposed frame names the frame rather than producing bytes nobody
 * asked for. `end` consumes the session and answers the handle.
 *
 * **The core states the chunk size**, in `StageBegun.chunk_bytes`, so the
 * sender's split and the assembler's agree before the first frame rather than
 * at the first refusal. This class therefore reads it rather than guessing, and
 * a shell that chose its own would be a second opinion about a ceiling only one
 * side enforces.
 */
public object Staging {
    /** What a completed stage answered. */
    public data class Staged(
        /**
         * `content_digest` over exactly what arrived — the value a
         * `media.add_asset` or `core.add_document` then names.
         */
        public val contentHash: String,
        public val byteSize: Long,
        /**
         * Whether this core ALREADY held these bytes.
         *
         * A camera roll re-scanned is the ordinary case, and a shell that could
         * not tell would re-send the roll.
         */
        public val alreadyHeld: Boolean,
    )

    /** Why a stage did not finish, in words a member reads. */
    public data class Refused(public val sentence: String)

    public sealed interface Outcome {
        public data class Ok(public val staged: Staged) : Outcome

        public data class No(public val refused: Refused) : Outcome
    }

    /**
     * Stream one original into the core and take its handle.
     *
     * [read] is asked for the next slice and answers an empty array when there
     * is none — a CALLBACK and not a `ByteArray`, because the point of a
     * streaming door is that a 900 MB video never exists in memory at once, and
     * a parameter that took the whole thing would undo that at the one call
     * site that matters.
     *
     * A refusal ends the stage where it happened. There is deliberately no
     * resume: a staging session is this core's, in this process, and a shell
     * that lost one has the bytes still — it starts again, and the core's
     * `already_held` makes the retry cheap if the first attempt did land.
     *
     * `already_held` is an answer this core gives this shell across the C ABI,
     * in one process, and it is the phone deduplicating on its own (#1029 §4).
     * It is not a question anybody asks a gateway: a gateway could not answer
     * without being told a plaintext hash, which is the confirmable commitment
     * the object format spends itself avoiding.
     */
    public suspend fun stage(
        core: CentraidCore,
        mediaType: String,
        byteSize: Long,
        read: suspend (max: Int) -> ByteArray,
    ): Outcome {
        val begun = when (val answer = core.send(StageRequest(begin = StageBegin(media_type = mediaType, byte_size = byteSize)))) {
            is CoreOutcome.Failed -> return refusal(answer)
            is CoreOutcome.Answered -> answer.value.response?.stage?.begun
        } ?: return Outcome.No(Refused(UNANSWERED))
        // THE CORE'S CEILING, not this shell's. See the class header.
        val chunkBytes = begun.chunk_bytes.toInt()
        var seq = 0L
        while (true) {
            val slice = read(chunkBytes)
            if (slice.isEmpty()) break
            when (
                val answer = core.send(
                    StageRequest(
                        chunk = StageChunk(
                            staging_id = begun.staging_id,
                            seq = seq,
                            payload = slice.toByteString(),
                        ),
                    ),
                )
            ) {
                is CoreOutcome.Failed -> return refusal(answer)
                is CoreOutcome.Answered -> Unit
            }
            seq += 1
        }
        val handle = when (
            val answer = core.send(StageRequest(end = StageEnd(staging_id = begun.staging_id)))
        ) {
            is CoreOutcome.Failed -> return refusal(answer)
            is CoreOutcome.Answered -> answer.value.response?.stage?.handle
        } ?: return Outcome.No(Refused(UNANSWERED))
        return Outcome.Ok(
            Staged(
                contentHash = handle.content_hash,
                byteSize = handle.byte_size,
                alreadyHeld = handle.already_held,
            ),
        )
    }

    private suspend fun CentraidCore.send(request: StageRequest) =
        call(Envelope(request = Request(stage = request)))

    /**
     * A failure's SENTENCE, never its detail.
     *
     * `CoreFailure` already carries a sentence the core decided was showable;
     * composing one here out of an error would be the hole in the rule that
     * `Error.detail` is logs-only.
     */
    private fun refusal(answer: CoreOutcome.Failed): Outcome.No =
        Outcome.No(Refused(answer.failure.sentence.ifEmpty { UNANSWERED }))

    private const val UNANSWERED = "Centraid could not take those bytes."
}
