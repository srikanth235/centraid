package dev.centraid.shared.apps.photos

import centraid.core.v1.Envelope
import centraid.core.v1.PageQuery
import centraid.core.v1.PageRequest
import centraid.core.v1.Request
import centraid.core.v1.Row
import centraid.screen.v1.ReadFailure
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.sync.fromCore
import dev.centraid.shared.sync.sentenceFor

/**
 * ONE PAGE OFF THE CORE, OR THE SENTENCE THE MEMBER READS.
 *
 * The half of [dev.centraid.shared.sync.ScreenRuntime] a composing bridge still
 * needs, lifted out so the screens in this app that read more than one table do
 * not each re-derive it. Copied in shape from `HomeRuntime.page`, which is the
 * other composing runtime in this module and answers the same question the same
 * way.
 *
 * `Error.detail` IS FOR LOGS AND NEVER FOR A MEMBER: it carries whatever the
 * failing layer said, including a SQLite `RAISE(ABORT)`, and one reached a
 * member's screen through exactly that field in #1020 wave 3. The CODE chooses
 * the sentence.
 */
internal sealed interface PhotosPage {
    public data class Rows(val rows: List<Row>, val nextCursor: String?) : PhotosPage

    public data class Refused(val failure: ReadFailure) : PhotosPage
}

internal suspend fun CentraidCore?.photosPage(
    query: PageQuery,
    limit: Int,
    after: centraid.core.v1.PageCursor? = null,
): PhotosPage {
    val handle = this
        // NO VAULT IS NOT A CRASH, and not an empty list either: a device
        // before its first pairing has not learned that it holds nothing.
        ?: return PhotosPage.Refused(Reads.refused("No vault is open on this phone."))
    val outcome = handle.call(
        Envelope(
            request_id = 0,
            request = Request(page = PageRequest(query = query, limit = limit, after = after)),
        ),
    )
    return when (outcome) {
        is CoreOutcome.Failed -> PhotosPage.Refused(fromCore(outcome.failure))
        is CoreOutcome.Answered -> {
            val page = outcome.value.response?.page
            val error = outcome.value.error
            when {
                page != null -> PhotosPage.Rows(
                    rows = page.rows,
                    nextCursor = page.next?.let { "${it.sort_key}|${it.pk}" },
                )
                error != null -> PhotosPage.Refused(sentenceFor(error.code))
                else -> PhotosPage.Refused(
                    Reads.refused("Centraid got no answer. Try again."),
                )
            }
        }
    }
}
