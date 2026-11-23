package dev.centraid.android.session

import java.io.IOException
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import centraid.core.v1.Envelope
import centraid.core.v1.Response
import centraid.core.v1.StageAborted
import centraid.core.v1.StageBegun
import centraid.core.v1.StageRequest
import centraid.core.v1.StageResponse
import dev.centraid.core.CoreFailure
import dev.centraid.core.CoreOutcome
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class StageReadTest {
    @Test
    fun cancellingABlockedSliceClosesTheOriginalStream() = runTest {
        val input = ClosingReadStream()
        val read = async { Stage.slices(input)(64) }
        input.readStarted.await()

        read.cancelAndJoin()

        assertTrue(input.closed)
    }

    @Test
    fun cancellingAStageWhileItsFirstSliceIsBlockedClosesTheSourceAndAbortsTheSession() = runTest {
        val input = ClosingReadStream()
        val requests = mutableListOf<StageRequest>()
        val stage = async {
            Stage.stage(
                sendStage = { request ->
                    requests += request
                    when {
                        request.begin != null -> answered(StageResponse(begun = StageBegun(staging_id = STAGE_ID, chunk_bytes = 64)))
                        request.abort != null -> answered(StageResponse(aborted = StageAborted()))
                        else -> error("the cancelled stage should not send a chunk or end")
                    }
                },
                mediaType = "image/jpeg",
                byteSize = 10,
                read = Stage.slices(input),
            )
        }
        input.readStarted.await()

        stage.cancelAndJoin()

        assertTrue(input.closed)
        assertEquals(listOf("begin", "abort"), requests.map(::requestKind))
    }

    @Test
    fun anUnacknowledgedOrMalformedEndStillAbortsItsOpenSession() = runTest {
        val unacknowledged = stageWithEndAnswer(CoreOutcome.Failed(CoreFailure.Closed))
        val malformed = stageWithEndAnswer(answered(StageResponse()))

        assertTrue(unacknowledged.first is Stage.Outcome.Refused)
        assertEquals(listOf("begin", "end", "abort"), unacknowledged.second)
        assertTrue(malformed.first is Stage.Outcome.Refused)
        assertEquals(listOf("begin", "end", "abort"), malformed.second)
    }

    @Test
    fun anIncompleteArchiveDescriptorNeverFallsThroughToAnOwnedStage() = runTest {
        val requests = mutableListOf<StageRequest>()

        val outcome = Stage.stage(
            sendStage = { request ->
                requests += request
                answered(StageResponse())
            },
            mediaType = "image/jpeg",
            byteSize = 10,
            archivePhotoId = "photo-fixture",
            archiveHash = "a".repeat(64),
            read = { ByteArray(0) },
        )

        assertTrue(outcome is Stage.Outcome.Refused)
        assertTrue(requests.isEmpty())
    }

    private suspend fun stageWithEndAnswer(
        endAnswer: CoreOutcome<Envelope>,
    ): Pair<Stage.Outcome, List<String>> {
        val requests = mutableListOf<StageRequest>()

        val outcome = Stage.stage(
            sendStage = { request ->
                requests += request
                when {
                    request.begin != null -> answered(StageResponse(begun = StageBegun(staging_id = STAGE_ID, chunk_bytes = 64)))
                    request.end != null -> endAnswer
                    request.abort != null -> answered(StageResponse(aborted = StageAborted()))
                    else -> error("the empty stream should send only begin, end, and abort")
                }
            },
            mediaType = "image/jpeg",
            byteSize = 0,
            read = { ByteArray(0) },
        )

        return outcome to requests.map(::requestKind)
    }

    private fun answered(stage: StageResponse): CoreOutcome<Envelope> =
        CoreOutcome.Answered(Envelope(response = Response(stage = stage)))

    private fun requestKind(request: StageRequest): String = when {
        request.begin != null -> "begin"
        request.chunk != null -> "chunk"
        request.end != null -> "end"
        request.abort != null -> "abort"
        else -> "empty"
    }

    private class ClosingReadStream : InputStream() {
        val readStarted = CompletableDeferred<Unit>()
        private val releaseRead = CountDownLatch(1)

        @Volatile var closed = false
            private set

        override fun read(): Int {
            readStarted.complete(Unit)
            releaseRead.await()
            throw IOException("closed during read")
        }

        override fun close() {
            closed = true
            releaseRead.countDown()
        }
    }

    private companion object {
        const val STAGE_ID = "stage-fixture"
    }
}
