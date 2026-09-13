package dev.centraid.shared.screen

import centraid.core.v1.Envelope
import centraid.core.v1.PageRequest
import centraid.core.v1.Request
import centraid.screen.v1.HomeEvent
import centraid.core.v1.ErrorCode
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.ReadFailureKind
import centraid.screen.v1.VaultLockup
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreFailure
import dev.centraid.core.CoreOutcome
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * THE EFFECT RUNNER — what turns Home's `ReadPage` into a real read
 * (#1020, wave A).
 *
 * `ScreenHost` publishes a state and then emits effects; up to now nothing on
 * either shell collected them, so `HomeMachine` asked for its tiles on every
 * open and no read was ever issued. Home has been drawing its seeded `LOADING`
 * state for that reason and no other.
 *
 * **The runner is the shell's, not the machine's.** A reducer that could read
 * is a reducer that can block, fail, retry and hold a handle, and then nothing
 * about a screen is testable without a vault. So the machine names what it
 * wants as DATA and this class is the only thing in the module that knows a
 * core exists.
 *
 * **ONE READ PER APP, FANNED OUT, EACH LANDING ON ITS OWN.** Home is the only
 * screen that reads more than one thing, and a Home that waited for the slowest
 * app would be a Home nobody sees. Each read sends its own event the moment it
 * answers.
 *
 * **A refused read is `TileRefused`, never an empty `TileArrived`.** That is
 * the fourth state's whole purpose: a tile whose read failed has not learned
 * that its app holds nothing, and grading it `EMPTY` would put the app into
 * first moves and tell a member to start filling something that may already be
 * full.
 */
public class HomeRuntime(
    private val core: CentraidCore,
    private val host: ScreenHost<centraid.screen.v1.HomeState, HomeEvent>,
    private val scope: CoroutineScope,
) {
    /**
     * Collect this host's effects and serve them for as long as [scope] lives.
     *
     * Started before the first event is sent, because `ScreenHost` buffers only
     * `EFFECT_BUFFER` effects and a runner attached after the open would miss
     * the read the open asked for.
     */
    public fun start(): Job = scope.launch {
        host.effects.collect { effect ->
            when (effect) {
                is ScreenEffect.ReadPage ->
                    if (effect.screenId == HomeMachine.SCREEN_ID) readAllTiles()
                // Every other effect belongs to a screen this runtime does not
                // serve, or to a plane that is not built. Ignored rather than
                // failed: a runner that threw on an effect it does not own
                // would take the screen down over somebody else's business.
                else -> Unit
            }
        }
    }

    /**
     * The vault's own lockup, read once, and sent.
     *
     * The statement itself is [VaultRoster.QUERY] and the decoding is
     * [VaultRoster.identify], shared with the roster survey so the two cannot
     * come to name the same vault differently.
     *
     * A core that cannot say what it is holding sends an EMPTY lockup rather
     * than none: the member still gets "No vault yet" over a Home that is
     * reading something, which is honest, and the alternative is a lockup that
     * silently never appears.
     */
    public suspend fun readLockup() {
        val lockup = VaultRoster.identify(core) ?: VaultLockup()
        host.send(HomeEvent(vault_changed = HomeEvent.VaultChanged(vault = lockup)))
    }

    /** Every tile's read, fanned out. */
    public fun readAllTiles(): Unit = HomeReads.READS.forEach { read ->
        scope.launch {
            when (val answer = page(read.query, HomeReads.LIMIT)) {
                is Read.Rows -> host.send(
                    HomeReads.arrived(
                        appId = read.appId,
                        rows = answer.rows,
                        capped = answer.rows.size >= HomeReads.LIMIT,
                        thumbnails = thumbnails(read.appId, answer.rows),
                    ),
                )
                is Read.Refused -> host.send(
                    HomeEvent(
                        tile_refused = HomeEvent.TileRefused(
                            app_id = read.appId,
                            failure = answer.failure,
                        ),
                    ),
                )
            }
        }
    }

    /**
     * WHERE THE PHOTOGRAPHS ARE, for the cells this tile will draw.
     *
     * One batched trip through the byte door for the whole mosaic, made BEFORE
     * the tile's event is sent: a tile body is a finished message, and a cell
     * that arrived blank and acquired its photograph a moment later would be
     * two states for one row and a visible pop on every open.
     *
     * **Only Photos, and only the cells that are drawn.** Locating rows nobody
     * is about to look at is a stat of a file per row to decorate a launcher.
     *
     * **A location that will not resolve is simply absent.** The door answers
     * with a member-facing sentence and this drops it: a mosaic cell has room
     * for a photograph and no room for a reason, and the tile already says how
     * many there are. `PhotosGridScreen` is where a member asks why.
     */
    private suspend fun thumbnails(
        appId: String,
        rows: List<centraid.core.v1.Row>,
    ): Map<String, String> {
        if (appId != "photos") return emptyMap()
        val drawn = rows.take(HomeReads.PHOTO_CELLS)
        if (drawn.isEmpty()) return emptyMap()
        val request = Envelope(
            request_id = 0,
            request = Request(
                content_urls = centraid.core.v1.ContentUrlRequest(
                    refs = drawn.map { row ->
                        centraid.core.v1.ContentRef(
                            content_id = row.values.getOrNull(3)?.text.orEmpty(),
                            // READ AS THE ASSET. The media type of bytes belongs
                            // to the representation and not to the byte row, so
                            // the door is told who is reading — two assets over
                            // one sha carry two readings (#996 R20(b)).
                            owner_type = "media.asset",
                            owner_id = row.values.getOrNull(0)?.text.orEmpty(),
                        )
                    },
                ),
            ),
        )
        val answered = when (val outcome = core.call(request)) {
            is CoreOutcome.Failed -> return emptyMap()
            is CoreOutcome.Answered -> outcome.value.response?.content_urls ?: return emptyMap()
        }
        // ZIPPED BY POSITION, which the door guarantees: one answer per ref, in
        // the order they were asked, including the ones that resolved to
        // nothing. A caller that filtered first and zipped after would pair a
        // photograph with another photograph's bytes.
        return drawn.indices.mapNotNull { index ->
            val url = answered.urls.getOrNull(index) ?: return@mapNotNull null
            val path = url.path
            if (path.isNullOrEmpty()) return@mapNotNull null
            // EMBEDDABLE IS A SECURITY ANSWER, not a hint. `image/svg+xml` is
            // executed by a renderer in the embedding page's origin, so the
            // door refuses to call it embeddable and this refuses to draw it —
            // the cell stays a placeholder rather than becoming a surface for
            // somebody else's script.
            if (!url.embeddable) return@mapNotNull null
            // A STILL IMAGE, AND ONLY A STILL IMAGE. A video's thumbnail is its
            // POSTER — a derivative keyed to the content — and the door answers
            // with the original bytes, which neither `UIImage(data:)` nor
            // `BitmapFactory` can turn into a frame. Handing a mosaic an MP4
            // draws a blank cell that looks like a failed render rather than
            // like a video with no poster yet, so the cell keeps its
            // placeholder and stays honest until the poster variant lands.
            if (!url.media_type.startsWith("image/")) return@mapNotNull null
            drawn[index].values.getOrNull(0)?.text?.takeIf { it.isNotEmpty() }?.let { it to path }
        }.toMap()
    }

    private sealed interface Read {
        data class Rows(val rows: List<centraid.core.v1.Row>) : Read
        data class Refused(val failure: ReadFailure) : Read
    }

    /**
     * One page, or the sentence a member gets.
     *
     * Every failure below becomes a `ReadFailure` rather than an exception,
     * because the screen has a place to put a sentence and nowhere to put a
     * stack trace — and because a tile that threw would take Home down, and
     * Home is the navigation.
     */
    private suspend fun page(
        query: centraid.core.v1.PageQuery,
        limit: Int,
    ): Read {
        val request = Envelope(
            request_id = 0,
            request = Request(page = PageRequest(query = query, limit = limit)),
        )
        return when (val outcome = core.call(request)) {
            is CoreOutcome.Failed -> Read.Refused(fromCore(outcome.failure))
            is CoreOutcome.Answered -> {
                val page = outcome.value.response?.page
                val error = outcome.value.error
                when {
                    page != null -> Read.Rows(page.rows)
                    // `Error.detail` IS FOR LOGS AND NEVER FOR A MEMBER. It
                    // carries whatever the failing layer said, including a
                    // SQLite `RAISE(ABORT)` — and one reached a member's screen
                    // through exactly this field in wave 3 (lane E, finding 2).
                    // The code chooses the sentence; the detail is dropped here
                    // because this runtime has nowhere to log it that a support
                    // bundle would read.
                    error != null -> Read.Refused(sentenceFor(error.code))
                    else -> Read.Refused(
                        Reads.refused("The vault answered with neither a page nor a reason."),
                    )
                }
            }
        }
    }
}

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
