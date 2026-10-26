package dev.centraid.android.session

import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.core.v1.StageBegin
import centraid.core.v1.StageChunk
import centraid.core.v1.StageEnd
import centraid.core.v1.StageHandle
import centraid.core.v1.StageRequest
import centraid.core.v1.StageSource
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import okio.ByteString
import okio.ByteString.Companion.decodeHex
import okio.ByteString.Companion.toByteString

/**
 * THE STAGE DOOR, STREAMED (#1025 S5; #1080 ruling 6; #1135): bytes go in, the core names them.
 *
 * Three frames: `begin` declares the media type, the length (0 when the platform does not know it
 * before the read) and where the bytes live; `chunk` is numbered from zero and sized by the core's
 * own ceiling (`StageBegun.chunk_bytes`, never this shell's guess); `end` answers the handle. A
 * BLAKE3 is the vault's identity and no Android API computes one, so the shell never names its own
 * bytes. A refusal ends the stage where it happened; there is no resume, and the core's
 * `already_held` makes a retry cheap.
 *
 * On the shelf's front core a stage goes to the vault in front (`centraid_core::vaults`).
 */
internal object Stage {
    /** A finished stage, or the core's own sentence for why not (empty when it gave none). */
    sealed interface Outcome {
        data class Staged(val handle: StageHandle) : Outcome

        data class Refused(val sentence: String) : Outcome
    }

    /**
     * Stream into [core]. [read] answers the next slice of at most `max` bytes, empty at the end:
     * a callback, so a 900 MB video never exists in memory at once.
     */
    suspend fun stage(
        core: CentraidCore,
        mediaType: String,
        byteSize: Long,
        osLibrary: Boolean = false,
        osRef: String = "",
        forHash: String = "",
        tier: String = "",
        read: suspend (max: Int) -> ByteArray,
    ): Outcome {
        val begin = StageBegin(
            media_type = mediaType,
            byte_size = byteSize.coerceAtLeast(0L),
            source = if (osLibrary) StageSource.STAGE_SOURCE_OS_LIBRARY else StageSource.STAGE_SOURCE_OWNED,
            os_ref = osRef,
            for_hash = raw(forHash),
            tier = tier,
        )
        val begun = when (val answer = core.send(StageRequest(begin = begin))) {
            is CoreOutcome.Failed -> return Outcome.Refused(answer.failure.sentence)
            is CoreOutcome.Answered -> answer.value.response?.stage?.begun
        } ?: return Outcome.Refused("")
        val chunkBytes = begun.chunk_bytes.toInt().coerceAtLeast(1)
        var seq = 0L
        while (true) {
            val slice = read(chunkBytes)
            if (slice.isEmpty()) break
            val chunk = StageChunk(staging_id = begun.staging_id, seq = seq, payload = slice.toByteString())
            when (val answer = core.send(StageRequest(chunk = chunk))) {
                is CoreOutcome.Failed -> return Outcome.Refused(answer.failure.sentence)
                is CoreOutcome.Answered -> Unit
            }
            seq += 1
        }
        val handle = when (val answer = core.send(StageRequest(end = StageEnd(staging_id = begun.staging_id)))) {
            is CoreOutcome.Failed -> return Outcome.Refused(answer.failure.sentence)
            is CoreOutcome.Answered -> answer.value.response?.stage?.handle
        } ?: return Outcome.Refused("")
        return Outcome.Staged(handle)
    }

    /** Read a stream to its end in slices: `read` may short-read without being at the end. */
    fun slices(input: java.io.InputStream): suspend (Int) -> ByteArray = { max ->
        val buffer = ByteArray(max)
        var filled = 0
        while (filled < max) {
            val count = input.read(buffer, filled, max - filled)
            if (count < 0) break
            filled += count
        }
        if (filled == 0) ByteArray(0) else buffer.copyOf(filled)
    }

    /** 64 hex characters as the 32 raw bytes the wire carries; empty for anything else. */
    fun raw(hex: String): ByteString =
        if (hex.length == 64 && hex.all { it in "0123456789abcdefABCDEF" }) hex.lowercase().decodeHex() else ByteString.EMPTY

    /** 32 raw bytes as lowercase hex; empty for anything else. */
    fun hex(raw: ByteString): String = if (raw.size == 32) raw.hex() else ""

    private suspend fun CentraidCore.send(request: StageRequest) = call(Envelope(request = Request(stage = request)))
}
