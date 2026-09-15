package dev.centraid.shared.sync

import centraid.core.v1.ErrorCode
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.ReadFailureKind
import dev.centraid.core.CoreFailure
import dev.centraid.shared.screen.Reads

/**
 * HOW A REFUSAL BECOMES A SENTENCE, IN ONE PLACE (#1025 S5, lane L5).
 *
 * These two functions were at the bottom of `shell/HomeRuntime.kt` and served
 * Home alone. The three app screens need the same mapping, and a second copy is
 * the shape that goes quietly wrong: two files answering "what does a member
 * read when a read is refused" drift the first time one of them learns a new
 * code, and nothing fails — the member simply reads two different sentences for
 * one cause depending on which screen they were on. So they moved here, beside
 * [ScreenRuntime] which is the other thing both shells' reads share, and
 * `HomeRuntime` imports them.
 */

/**
 * The member-facing sentence for a core error CODE.
 *
 * Nine codes and four sentences, which is the right ratio: a member needs to
 * know whether to wait, to reconnect, to update or to tell somebody, and the
 * difference between `MALFORMED_FRAME` and `UNSUPPORTED_MESSAGE` is a
 * difference between two bugs rather than between two things to do.
 */
internal fun sentenceFor(code: ErrorCode): ReadFailure = when (code) {
    ErrorCode.ERROR_CODE_UNAUTHORIZED -> Reads.refused("You do not have access to this.")
    ErrorCode.ERROR_CODE_NO_RELAY_REACHABLE,
    ErrorCode.ERROR_CODE_PEER_UNREACHABLE,
    -> Reads.unavailable("Centraid could not reach your gateway.")
    ErrorCode.ERROR_CODE_TIMEOUT -> Reads.unavailable("That read took too long to answer.")
    ErrorCode.ERROR_CODE_VERSION_WINDOW -> ReadFailure(
        kind = ReadFailureKind.READ_FAILURE_KIND_REFUSED,
        sentence = "This copy of Centraid and this vault no longer speak the same version.",
        remedy = "Update Centraid.",
    )
    else -> Reads.refused("That read did not answer.")
}

/**
 * A [CoreFailure] as the sentence a screen shows.
 *
 * **Every `CoreFailure` already carries a `sentence`**, written for a member by
 * the layer that refused — so this maps the KIND to a read-failure kind and
 * keeps the words. Re-writing them here would be a second vocabulary for one
 * refusal, and the `detail` field beside them is the logs-only one that must
 * never be rendered.
 */
internal fun fromCore(failure: CoreFailure): ReadFailure = when (failure) {
    // The core is gone: this is not a refusal of a read, it is the absence of
    // anything to read from, and "reopen" is the only true remedy.
    is CoreFailure.Closed, is CoreFailure.Poisoned -> ReadFailure(
        kind = ReadFailureKind.READ_FAILURE_KIND_CORE_RESTARTED,
        sentence = failure.sentence,
    )

    is CoreFailure.StaleArtifact -> ReadFailure(
        kind = ReadFailureKind.READ_FAILURE_KIND_REFUSED,
        sentence = failure.sentence,
        remedy = "Update Centraid.",
    )

    else -> Reads.refused(failure.sentence)
}
