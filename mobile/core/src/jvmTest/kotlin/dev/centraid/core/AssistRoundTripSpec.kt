package dev.centraid.core

import centraid.core.v1.AssistEvent
import centraid.core.v1.AssistModelState
import centraid.core.v1.AssistRefusalReason
import centraid.core.v1.AssistRequest
import centraid.core.v1.AssistResponse
import centraid.core.v1.AssistSendRequest
import centraid.core.v1.AssistStartRequest
import centraid.core.v1.AssistStatusRequest
import centraid.core.v1.AssistSuggestRequest
import centraid.core.v1.Envelope
import centraid.core.v1.ErrorCode
import centraid.core.v1.Request
import dev.centraid.core.AbiRoundTripSpec.Companion.openRealCore
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeIn
import io.kotest.matchers.collections.shouldNotBeEmpty
import io.kotest.matchers.comparables.shouldBeLessThanOrEqualTo
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import java.io.File
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout

/**
 * THE ON-DEVICE CHAT'S REQUESTS AND EVENTS, KOTLIN TO RUST AND BACK.
 *
 * `Request.assist` is a request kind and `AssistEvent` an event kind, so the
 * five symbols carry the chat with no sixth. Over JNA, against the real
 * `libcentraid_core_ffi` and the vault `spike-fixture` founded: what is proved
 * here is that Wire's decoding of `assist.proto` agrees with prost's encoding
 * of it — the status, a typed refusal in an outcome, a typed failure on a bad
 * request — and that a turn's events arrive through the same `events` flow the
 * change stream does.
 *
 * No model is loaded: the cdylib under test is built without the engine (see
 * the status assertion below), and a refusal for want of a model is a state the chat has to
 * draw, so it is the one worth proving across the boundary.
 */
class AssistRoundTripSpec : StringSpec({

    suspend fun CentraidCore.assist(request: AssistRequest): CoreOutcome<Envelope> =
        call(Envelope(request_id = 1, request = Request(assist = request)))

    fun CoreOutcome<Envelope>.answer(): AssistResponse = when (this) {
        is CoreOutcome.Answered -> value.response?.assist ?: error("an AssistResponse, got $value")
        is CoreOutcome.Failed -> error("refused: $failure")
    }

    "the model's state, a refusal for want of a model, and the turn's own events cross intact" {
        val core = openRealCore()
        try {
            core.startReader()

            // --- the model file ----------------------------------------------
            val nowhere = core.assist(
                AssistRequest(status = AssistStatusRequest(model_path = "/nowhere/model.gguf")),
            ).answer().status!!
            nowhere.state shouldBe AssistModelState.ASSIST_MODEL_STATE_ABSENT
            nowhere.model_bytes shouldBe 0L

            val file = File.createTempFile("assist-spec", ".gguf").apply {
                writeBytes(ByteArray(16))
                deleteOnExit()
            }
            val present = core.assist(
                AssistRequest(status = AssistStatusRequest(model_path = file.path)),
            ).answer().status!!
            // The file is there, and what the core says of it depends on the
            // library: NO_ENGINE from the cdylib this module's own build makes
            // (`cargo build -p centraid-core-ffi`, no `--features llama`:
            // llama.cpp is a ~5 minute cmake build and no Kotlin spec loads a
            // model, R-CHAT-10), PRESENT from a core that carries the engine
            // (`-Pcentraid.coreLibDir` at a phone's build). Never ABSENT, and
            // the byte count below is the same either way. The engine-wired
            // answer is asserted in Rust: `crates/core-ffi/tests/assist.rs`.
            present.state shouldBeIn listOf(
                AssistModelState.ASSIST_MODEL_STATE_PRESENT,
                AssistModelState.ASSIST_MODEL_STATE_NO_ENGINE,
            )
            present.model_bytes shouldBe 16L

            // --- a session, scoped to an app the assistant reads --------------
            val started = core.assist(
                AssistRequest(start = AssistStartRequest(app = "tasks")),
            ).answer().started!!
            (started.session_id > 0L) shouldBe true

            // Locker is not an app a chat can be scoped to: the request's fault.
            val locker = core.assist(AssistRequest(start = AssistStartRequest(app = "locker")))
            locker.shouldBeInstanceOf<CoreOutcome.Failed>()
            val failure = locker.failure.shouldBeInstanceOf<CoreFailure.Refused>()
            failure.code shouldBe ErrorCode.ERROR_CODE_INVALID_REQUEST.value

            // --- a turn with no model, and the event that says so --------------
            val sawFailure = coroutineScope {
                val event = async(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) {
                    withTimeout(10_000) { core.events.first { it.assist?.failed != null } }
                }
                val sent = core.assist(
                    AssistRequest(
                        send = AssistSendRequest(
                            session_id = started.session_id,
                            text = "What is due today?",
                            tz = "UTC",
                            turn_id = 41,
                        ),
                    ),
                ).answer().sent!!
                sent.session_id shouldBe started.session_id
                sent.turn_id shouldBe 41L
                sent.refused?.reason shouldBe AssistRefusalReason.ASSIST_REFUSAL_REASON_MODEL_ABSENT
                event.await().assist!!
            }
            sawFailure.session_id shouldBe started.session_id
            sawFailure.turn_id shouldBe 41L
            sawFailure.failed?.reason shouldBe AssistRefusalReason.ASSIST_REFUSAL_REASON_MODEL_ABSENT

            // --- suggestions: at most three, read from whatever this vault holds -
            val suggestions = core.assist(
                AssistRequest(suggest = AssistSuggestRequest(app = "", tz = "UTC")),
            ).answer().suggestions!!
            suggestions.prompts.shouldNotBeEmpty()
            suggestions.prompts.size shouldBeLessThanOrEqualTo 3
        } finally {
            core.close()
        }
    }
})
