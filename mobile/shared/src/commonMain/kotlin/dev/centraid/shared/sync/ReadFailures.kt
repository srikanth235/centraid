package dev.centraid.shared.sync

import centraid.core.v1.Error
import centraid.core.v1.ErrorCode
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.ReadFailureKind
import dev.centraid.core.CoreFailure
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.shell.Shelf

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
    // A SUPERSEDED PHONE IS NOT A STRANGER (#1029 F1, W5). `UNAUTHORIZED` means
    // "whoever you are, not here"; this means "you held this vault and a higher
    // epoch took it", and the two are different sentences because they are
    // different facts. It is a REFUSAL and not an unavailability: nothing here
    // is coming back on its own, and a member owed a retry button would press
    // it forever. The freeze itself is `Shelf.freeze` by way of [movedFrom];
    // this is only what a read that raced it says.
    ErrorCode.ERROR_CODE_VAULT_MOVED -> Reads.refused(Shelf.MOVED_SENTENCE)
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

/**
 * THE VAULT MOVED, AS THE ONE PLACE THAT SAYS SO (#1029 F1, W5, hand-off 2).
 *
 * `Shelf.freeze` has been the consumer since W2 and had no producer: nothing
 * could tell it a vault had moved, because there was no typed code to key on
 * and that lane declined to invent a number rather than mint a second
 * mechanism. `ERROR_CODE_VAULT_MOVED = 25` exists, and `lease.proto`'s
 * `VaultMoved` — `current_epoch`, `moved_at_ms` — rides on the refusal beside
 * it. **This is the mapping, and there is one.**
 *
 * It is HERE rather than inside the gateway client for the reason the two
 * functions above are here: a refusal becomes a member-facing fact in one
 * place, and two files answering "what does this code mean" drift the first
 * time one of them learns something.
 *
 * Answers null for every other refusal, which is what makes it safe to call on
 * every failure a request can produce.
 *
 * ## What it does NOT do
 *
 * **It does not freeze anything, and it does not decide anything** (F1:
 * cooperation, not enforcement). It reads a refusal and answers the two terms
 * `HomeSession.vaultMoved` takes; the freeze is the session's, which keeps
 * every structural change to the shelf behind the shelf's own gate. Nothing
 * here wipes, and nothing here takes a vault back.
 *
 * @param unacked how many changes THIS phone is still holding that the vault it
 *   moved to has not seen. It comes from the spool and never from the refusal:
 *   the gateway cannot know what this phone has not sent it, and a server-side
 *   number here would be a claim about the member's own device made by somebody
 *   else.
 */
internal fun movedFrom(error: Error, unacked: Long): Moved? {
    if (error.code != ErrorCode.ERROR_CODE_VAULT_MOVED) return null
    // A REFUSAL WITH NO `VaultMoved` IS STILL A MOVE. The code is the fact; the
    // message is the detail. A server that sent the code and omitted the
    // companion would otherwise be answered by a phone that went on writing,
    // which is the one outcome this whole path exists to prevent — so the date
    // falls back to the epoch and the line reads "N changes since 1970-01-01",
    // which is wrong-looking rather than silently absent.
    val movedAtMs = error.moved?.moved_at_ms ?: 0L
    return Moved(atIso = rfc3339FromEpochMillis(movedAtMs), unacked = unacked)
}

/** What a `VAULT_MOVED` refusal says, in the two terms `Shelf.freeze` takes. */
internal data class Moved(val atIso: String, val unacked: Long)
