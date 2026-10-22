package dev.centraid.shared.sync

import centraid.core.v1.ActInverse
import centraid.core.v1.ActRequest
import centraid.core.v1.ActResponse
import centraid.core.v1.ActStatus
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.Envelope
import centraid.core.v1.LoadRequest
import centraid.core.v1.Request
import centraid.screen.v1.ReadFailure
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.screen.Reads

/**
 * THE ONE READ AND THE ONE WRITE, FROM KOTLIN (#1135).
 *
 * An app's screens name what they want with the generated catalogue
 * (`Load.Tasks.Board(…)`, `Act.Tasks.Complete(…)`, `catalog/ActionCatalog.kt`)
 * and these two functions send it over the core bridge as proto bytes. Nothing
 * else in Kotlin writes a query, a command or a JSON input for an app that has
 * moved onto this plane; the recipe is `docs/apps/one-action-plane-recipe.md`.
 *
 * Both answer typed values:
 *
 *  * [load] returns the app's own typed answer (an `AppQueryResponse`), a
 *    denial as a state, or a [ReadFailure];
 *  * [act] returns [ActOutcome.Executed] with the core's answer — the inverse
 *    that undoes it, `replayed` when the same key already ran — or
 *    [ActOutcome.Refused] with the check that stopped it and the member's
 *    sentence. **A vault another phone has taken over is refused HERE, by the
 *    core, with the check `vault_moved`**: no screen asks the shelf whether
 *    the vault is frozen before it writes.
 */
public object ActionPlane {
    /** The check [act] names when the core was not there to be asked. */
    public const val NO_CORE: String = "no_core"

    /** The check the core names for a vault another phone has taken over. */
    public const val VAULT_MOVED: String = "vault_moved"

    /**
     * Ask one query. [request]'s zone is the device's, stated by the caller
     * ([ScreenQueryRuntime] fills it from the clock); an empty one is refused
     * here for the reason `askCore` gives, before the core says it worse.
     */
    internal suspend fun load(handle: CentraidCore?, request: LoadRequest): LoadOutcome {
        if (handle == null) return LoadOutcome.Refused(Reads.noVault())
        if (request.zone.isBlank()) return LoadOutcome.Refused(Reads.refused(NO_ZONE))
        return when (val outcome = handle.call(Envelope(request_id = 0, request = Request(load = request)))) {
            is CoreOutcome.Failed -> LoadOutcome.Refused(fromCore(outcome.failure))
            is CoreOutcome.Answered -> {
                val answer = outcome.value.response?.load?.answer
                val error = outcome.value.error
                val denial = answer?.denied
                when {
                    answer == null && error != null -> LoadOutcome.Refused(sentenceFor(error.code))
                    answer == null -> LoadOutcome.Refused(Reads.refused(NEITHER))
                    denial != null -> LoadOutcome.Denied(denial)
                    else -> LoadOutcome.Loaded(answer)
                }
            }
        }
    }

    /** Take one action. [request] must carry its key (`ActRequest.keyed`). */
    internal suspend fun act(handle: CentraidCore?, request: ActRequest): ActOutcome {
        if (handle == null) return ActOutcome.Refused(NO_CORE, Reads.NO_VAULT)
        if (request.invoke_key.isEmpty()) return ActOutcome.Refused("no_key", "")
        return when (val outcome = handle.call(Envelope(request_id = 0, request = Request(act = request)))) {
            is CoreOutcome.Failed -> ActOutcome.Refused(NO_CORE, outcome.failure.sentence)
            is CoreOutcome.Answered -> {
                val answer = outcome.value.response?.act
                if (answer == null) {
                    // `Error.detail` is for logs; the code chooses the sentence.
                    ActOutcome.Refused("error", outcome.value.error?.let { sentenceFor(it.code).sentence }.orEmpty())
                } else if (answer.status == ActStatus.ACT_STATUS_EXECUTED) {
                    ActOutcome.Executed(answer)
                } else {
                    ActOutcome.Refused(answer.refusal?.check.orEmpty(), answer.reason)
                }
            }
        }
    }

    private const val NO_ZONE = "This phone did not report its time zone."
    private const val NEITHER = "No answer came back. Try again."
}

/** What one [ActionPlane.load] came back as. */
internal sealed interface LoadOutcome {
    data class Loaded(val answer: AppQueryResponse) : LoadOutcome

    data class Denied(val denial: centraid.core.v1.AppQueryDenial) : LoadOutcome

    data class Refused(val failure: ReadFailure) : LoadOutcome
}

/** What one [ActionPlane.act] came back as. */
public sealed interface ActOutcome {
    /** The effect is committed. [response] holds the inverse, if the action has one. */
    public data class Executed(val response: ActResponse) : ActOutcome {
        public val inverse: ActInverse? get() = response.inverse
    }

    /** Nothing was written. [check] says which rule stopped it; [sentence] is the member's. */
    public data class Refused(val check: String, val sentence: String) : ActOutcome
}

/** The request that takes [this] answer back, under the key [subject]/[intent] make. */
public fun ActInverse.request(app: String): ActRequest = ActRequest(app = app, action = action, input = input)
