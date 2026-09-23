package dev.centraid.shared.apps.photos

import centraid.core.v1.ContentRef
import centraid.core.v1.ContentUrlRequest
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoLightboxEvent
import centraid.screen.v1.PhotoLightboxState
import dev.centraid.core.CoreOutcome
import dev.centraid.design.CentraidCopy
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * What SwiftUI holds instead of the lightbox's `StateFlow` (#1029, photos port).
 *
 * `PhotosBridge`'s shape, for the same two reasons, which are worth restating
 * because both are load-bearing at this boundary:
 *
 * * **BYTES, NOT OBJECTS.** The state crosses as an encoded
 *   `PhotoLightboxState` and the event arrives as an encoded
 *   `PhotoLightboxEvent`; Swift decodes it with SwiftProtobuf from the same
 *   schema Wire reads here, so one fixture proves both sides.
 * * **NOT `suspend`.** A SwiftUI button cannot await, and a view that could
 *   await a reducer would be a view holding the main thread while a screen
 *   thinks. The launch is what keeps [send]'s ordering — one coroutine, one
 *   queue — without the caller knowing there is one.
 *
 * Android does NOT use the byte hand-off: Compose collects [host]'s
 * `StateFlow` directly, because on that side it already is the right shape.
 *
 * ## SEVEN READS ON ONE HOST, AND ONE ROUTE
 *
 * The lightbox is seven reads (`PhotoLightboxReads`' own doc says why), and
 * `ScreenRuntime` serves the effects whose `screenId` matches ITS `ScreenReads`.
 * So the asset read goes through [HomeSession.attachScreen] — which also puts
 * the host on the change stream and gives the write half its read-only gate —
 * and the six legs go through [HomeSession.attachReads], which is the same
 * thing WITHOUT the route.
 *
 * **`attachScreen` IS CALLED EXACTLY ONCE**, and that is not an accident of
 * style. It calls `ChangeStream.route(host)`, registration is additive and
 * there is no removal, so a second attach of the same host would deliver every
 * `rows_changed` twice and this screen would re-read its photograph once per
 * leg on every sync.
 */
public class PhotoLightboxBridge {
    /**
     * The host, exposed because Android drives it directly.
     *
     * One per bridge and never re-created: `ChangeStream.route` registers a
     * host for the life of the session, so a second host would leave the routed
     * one drawing into nothing.
     */
    public val host: ScreenHost<PhotoLightboxState, PhotoLightboxEvent> =
        ScreenHost(PhotoLightboxMachine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    /**
     * Put this screen on the session's core, and start publishing.
     *
     * The attach is the session's because the core is: R-1020-24 is one core
     * per process, so a bridge that opened its own would be refused by
     * `SingleHandleGuard`.
     */
    public fun attach(session: HomeSession) {
        session.attachScreen(host, PhotoLightboxReads, PhotoLightboxReads)
        // THE SIX OTHER STATEMENTS, through [HomeSession.attachReads] — which
        // is `attachScreen` WITHOUT the `changes.route(host)`. Its own doc
        // carries the reason in full: the route is registration with no
        // removal, by design, so attaching per leg would route this host seven
        // times and every change event would deliver seven re-reads for ever.
        // One route for the screen, one runtime per further read.
        PhotoLightboxMachine.Leg.entries.forEach { leg ->
            session.attachReads(host, PhotoLightboxLeg(leg))
        }
        // THE STRIP, THE PLACE PICKER AND A LIVE PHOTO'S MOVIE: the same
        // door, the same one-runtime-per-read rule, answering on their own
        // event arms (`PhotoLightboxSideRead`).
        PhotoLightboxMachine.Side.entries.forEach { side ->
            session.attachReads(host, PhotoLightboxSideRead(side))
        }
        // "ADD TO ALBUM" — the shared sheet's list, served beside this
        // screen's own reads exactly as `AlbumChoice.attach` asks.
        AlbumChoice.attach(session, host, scope) { choices ->
            PhotoLightboxEvent(album_choices = AlbumChoicesArrivedOf(choices))
        }
        scope.launch {
            host.state.collect { state ->
                onState?.invoke(state.encode())
                locate(session, state)
            }
        }
    }

    /**
     * WHAT WAS LAST ASKED OF THE BYTE DOOR, so a state that re-publishes for
     * any other reason — a chrome tap, a sheet — does not ask again.
     *
     * `held` is in it because it is the one thing that changes the answer:
     * a fetch that lands turns an absent original into a present one, and the
     * next state after it is the one that has to be located.
     */
    private var lastLocated: String = ""

    /**
     * FIND THE ORIGINAL ON THIS DEVICE, AND A LIVE PHOTO'S MOVIE (the fix for
     * `docs/photos/README.md`'s "`original_path` cannot be filled at all").
     *
     * The page door answers for hashes and never for paths, and no
     * `ScreenEffect` carries a byte-door request, so the bridge asks — the
     * same seat `HomeRuntime` takes when it folds reads the runtime cannot
     * serve. It asks by the CONTENT ID the content leg brought and names the
     * asset as the owner, because `embeddable` is an answer about the owner's
     * reading of the bytes and not about the bytes. The answer goes back as
     * an event the machine keys on the asset, so this never decides what the
     * screen shows — only what the vault said.
     */
    private fun locate(session: HomeSession, state: PhotoLightboxState) {
        val detail = state.detail ?: return
        if (detail.content_id.isEmpty() || detail.held != PhotoCell.Held.HELD_ORIGINAL) return
        val key = listOf(
            detail.asset_id,
            detail.content_id,
            detail.live_content_id,
            detail.held.name,
        ).joinToString("\u0000")
        if (key == lastLocated) return
        lastLocated = key
        val refs = buildList {
            add(ContentRef(content_id = detail.content_id, owner_type = OWNER_TYPE, owner_id = detail.asset_id))
            if (detail.live_content_id.isNotEmpty()) {
                add(
                    ContentRef(
                        content_id = detail.live_content_id,
                        owner_type = OWNER_TYPE,
                        owner_id = detail.live_asset_id,
                    ),
                )
            }
        }
        scope.launch {
            val core = session.shelf.core() ?: return@launch
            val outcome = core.call(Envelope(request = Request(content_urls = ContentUrlRequest(refs = refs))))
            // A FAILED LOOKUP IS NOT A FAILED PHOTOGRAPH. The thumbnail stays,
            // which is what the stage drew before anybody asked, and the key
            // is let go so the next state may ask again.
            val urls = (outcome as? CoreOutcome.Answered)?.value?.response?.content_urls?.urls
            if (urls == null) {
                lastLocated = ""
                return@launch
            }
            val original = urls.getOrNull(0)
            val live = urls.getOrNull(1)
            host.send(
                PhotoLightboxEvent(
                    located = PhotoLightboxEvent.OriginalLocated(
                        asset_id = detail.asset_id,
                        original_path = original?.path,
                        embeddable = original?.embeddable ?: false,
                        media_type = original?.media_type.orEmpty(),
                        live_path = live?.path?.takeIf { live.embeddable },
                    ),
                ),
            )
        }
    }

    /**
     * THE MEMBER TAPPED A PHOTOGRAPH.
     *
     * `neighbours` is the SHELF'S ORDER, handed in by whoever opened this
     * lightbox, so a swipe is a reduce and not a read. A lightbox that worked
     * its own neighbours out would page the library once per photograph a
     * member flicked past — and would order them differently from the grid they
     * came out of the moment the two predicates drifted.
     */
    public fun opened(assetId: String, neighbours: List<String>) {
        opened(assetId, neighbours, albumId = "")
    }

    /**
     * THE SAME TAP, FROM INSIDE AN ALBUM. The album rides the open so "Make
     * key photo" knows which cover it is setting; an overload rather than a
     * default argument, because a Kotlin default does not cross into Swift.
     */
    public fun opened(assetId: String, neighbours: List<String>, albumId: String) {
        scope.launch {
            host.send(
                PhotoLightboxEvent(
                    opened = PhotoLightboxEvent.Opened(
                        asset_id = assetId,
                        neighbour_asset_ids = neighbours,
                        album_id = albumId,
                    ),
                ),
            )
        }
    }

    /** Publish every state to [onState], starting with the current one. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        // The FIRST state, immediately. A view that subscribed and then waited
        // for a change would draw nothing at all until a read landed.
        onState(host.state.value.encode())
    }

    /** Forward one encoded event. */
    public fun send(event: ByteArray) {
        scope.launch { host.send(PhotoLightboxEvent.ADAPTER.decode(event)) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }

    private companion object {
        /** The owner a Photos asset reads its bytes as (`ContentRef.owner_type`). */
        const val OWNER_TYPE: String = "media.asset"
    }
}

/** The arm `AlbumChoice.attach` lands its list on. */
private fun AlbumChoicesArrivedOf(
    choices: List<centraid.screen.v1.AlbumChoiceEntry>,
): centraid.screen.v1.AlbumChoicesArrived = centraid.screen.v1.AlbumChoicesArrived(choices = choices)

/**
 * HOW MUCH OF THE PLACE TRAVELS WITH THE COPY (v0's `share-place.ts`, #816).
 *
 * The `SHEET_SHARE` decision, ported as its own type because it is a decision
 * about what LEAVES THE VAULT and not a rendering choice. The proto's own words:
 * "a share is a decision about bytes, so it is a sheet with a choice and never
 * a direct hand-off."
 *
 * `NONE` is the default, and the receipt is stated every time — `none`
 * included — because silence reads as safety and a member who was never told
 * what went has not been told anything.
 */
public enum class SharePlacePrecision {
    /** The copy leaves with no location in it. */
    NONE,

    /** The place's NAME travels as words; the location still comes out of the
     *  file. Words are no licence for the fix underneath. */
    NAME,

    /** The original file, with the spot it was taken. */
    EXACT,
}

/** One row of the share sheet: what it is called, and what it actually does. */
public data class SharePlaceOption(
    public val precision: SharePlacePrecision,
    public val label: String,
    public val detail: String,
)

/**
 * The rows the share sheet offers for THIS photograph.
 *
 * `NAME` is offered only when there is a name to send — v0's own rule, and the
 * reason this takes the place name rather than a boolean: a sheet that offered
 * "Place name only" for a photograph with no place would be a choice that does
 * nothing, which is the promise `viewer-menu.ts` refuses to make.
 *
 * `EXACT` is offered either way, and its DETAIL changes rather than the row
 * disappearing: with no place row this device knows of, the original file may
 * still carry whatever the camera recorded, and a member choosing "the original
 * file" should be told that is what it means.
 */
public fun sharePlaceOptions(placeName: String): List<SharePlaceOption> =
    sharePlaceOptions(placeName, located = false)

/**
 * The rows, knowing whether the vault holds a coordinate for the place.
 *
 * `EXACT`'s detail is v0's two sentences: with a coordinate on the row, the
 * file carries "the spot it was taken"; without one, the camera may still have
 * written something, and a member choosing the original should be told so.
 */
public fun sharePlaceOptions(placeName: String, located: Boolean): List<SharePlaceOption> = buildList {
    add(
        SharePlaceOption(
            SharePlacePrecision.NONE,
            "No place",
            "The copy leaves with no location in it.",
        ),
    )
    if (placeName.isNotEmpty()) {
        add(
            SharePlaceOption(
                SharePlacePrecision.NAME,
                "Place name only",
                placeName + " travels as words; the location still comes out of the file.",
            ),
        )
    }
    add(
        SharePlaceOption(
            SharePlacePrecision.EXACT,
            "Exact location",
            if (located) {
                "The original file, with the spot it was taken."
            } else {
                "The original file, with whatever the camera recorded."
            },
        ),
    )
}

/**
 * THE WORDS THAT TRAVEL BESIDE A `NAME` COPY, and nothing for the other two.
 * The name goes as a message the receiving app shows, never inside the file.
 */
public fun sharePlaceMessage(precision: SharePlacePrecision, placeName: String): String? =
    if (precision == SharePlacePrecision.NAME && placeName.isNotEmpty()) placeName else null

/**
 * WHETHER THE COPY'S BYTES OWE A STRIP. `NAME` strips too: words are no
 * licence for the fix underneath (v0's `sharePlaceStripsLocation`).
 */
public fun sharePlaceStripsLocation(precision: SharePlacePrecision): Boolean =
    precision != SharePlacePrecision.EXACT

/**
 * A COPY THAT WOULD HAVE CARRIED A PLACE IT WAS TOLD NOT TO IS NOT SENT —
 * v0's `SHARE_PLACE_NOT_REMOVABLE`, word for word. Never a copy that hides a
 * place it carries.
 */
public const val SHARE_PLACE_NOT_REMOVABLE: String =
    "The location could not be taken out of this file, so nothing was sent."

/** The copy cannot be made because the original is not on this device. */
public const val SHARE_ORIGINAL_NOT_HERE: String =
    "The original is not on this device, so nothing was sent."

/** `PHOTOS_ERROR_EXPORT_FAILED` out of `copy/photos.json`, and its retry word. */
public const val EXPORT_FAILED: String = CentraidCopy.Photos.PHOTOS_ERROR_EXPORT_FAILED + " Retry."

/** What "Download" says when the original went into the device's photos. */
public const val EXPORT_SAVED: String = "Saved to this device's photos."

/** "Copy exact location" — a copy the member asked for, and only then. */
public const val EXACT_LOCATION_COPIED: String = "Exact location copied."

/**
 * `51.72340, -2.93810` — v0's `exactLocation`, five places, and the ONE
 * spelling of a coordinate this app lets out: onto the member's own clipboard,
 * because they asked. Never drawn on screen.
 */
public fun exactLocation(latitude: Double, longitude: Double): String =
    fivePlaces(latitude) + ", " + fivePlaces(longitude)

/** `%.5f` without a formatter `commonMain` does not have. Rounded, not cut. */
private fun fivePlaces(value: Double): String {
    val negative = value < 0.0
    val scaled = kotlin.math.round(kotlin.math.abs(value) * 100_000.0).toLong()
    val whole = scaled / 100_000L
    val fraction = (scaled % 100_000L).toString().padStart(5, '0')
    return (if (negative && scaled != 0L) "-" else "") + whole + "." + fraction
}

/** The sheet's one question, asked EVERY time (#816). */
public const val SHARE_PLACE_TITLE: String = "Send a copy — how much of the place?"

/** What a member is told AFTERWARDS, `NONE` included. */
public fun sharePlaceReceipt(precision: SharePlacePrecision, placeName: String): String =
    when (precision) {
        SharePlacePrecision.EXACT -> "Sent with the exact location."
        SharePlacePrecision.NAME ->
            if (placeName.isEmpty()) {
                "Sent with no location."
            } else {
                "Sent with the place name only — " + placeName + "."
            }
        SharePlacePrecision.NONE -> "Sent with no location."
    }
