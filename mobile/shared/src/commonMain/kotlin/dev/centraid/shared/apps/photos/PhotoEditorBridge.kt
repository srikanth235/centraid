package dev.centraid.shared.apps.photos

import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.ContentRef
import centraid.core.v1.ContentUrlRequest
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.screen.v1.PhotoEditorEvent
import centraid.screen.v1.PhotoEditorState
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.shell.Staging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okio.FileSystem
import okio.Path.Companion.toPath
import okio.ByteString.Companion.encodeUtf8
import okio.buffer
import okio.use

/**
 * What SwiftUI holds instead of the editor's `StateFlow`, AND the runtime that
 * serves its two doors and its one save (#1029, photos port).
 *
 * `PhotosCollectionsBridge`'s shape: BYTES, NOT OBJECTS, across the Swift
 * boundary, and NOT `suspend`, because a SwiftUI button cannot await. Android
 * sends to and collects [host] directly.
 *
 * ## The save, and who does which half
 *
 * v0's `photo-edit-save.ts` was one function: resolve the original, render it
 * with the plan, hand the file to the camera roll's own ingest. It is three
 * owners here, and the split is the architecture rather than a preference:
 *
 * 1. **The reducer** says "render this plan against this original" as a
 *    [ScreenEffect.RenderEdit]. It never decodes a pixel.
 * 2. **The platform** renders — CoreImage on iOS, `Bitmap` and `Matrix` on
 *    Android — because decoding a photograph is platform I/O. It is handed the
 *    request through [onRender] and answers with [rendered] or
 *    [renderRefused].
 * 3. **This bridge** ingests the rendered file down THE SAME BYTE PATH THE
 *    CAMERA ROLL USES: [Staging.stage] names the bytes, then `media.add_asset`
 *    commits the row over them, keyed on the content hash exactly as
 *    `CameraRoll.offer` keys it. A second ingest path would be a second answer
 *    to "how does a photograph enter the library", and v0 refused one in so
 *    many words ("It takes the SAME ingest path a camera-roll photograph
 *    does").
 *
 * **Lineage is named, never invented** (#711): `source_asset_id` is the
 * original's id, which is the one thing only the editor knows.
 */
public class PhotoEditorBridge {
    /**
     * The host, exposed because Android drives it directly.
     *
     * One per bridge and never re-created, for every other bridge's reason.
     */
    public val host: ScreenHost<PhotoEditorState, PhotoEditorEvent> =
        ScreenHost(PhotoEditorMachine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null
    private var session: HomeSession? = null

    /**
     * THE RENDERS ASKED FOR AND NOT YET ANSWERED, by key. The platform answers
     * with the key alone; what the commit needs beside the bytes — the
     * original's id and the new title — is held here rather than round-tripped
     * through a shell that has no use for it.
     */
    private val pending = mutableMapOf<String, ScreenEffect.RenderEdit>()

    /**
     * RENDER THIS PLAN AGAINST THIS ORIGINAL, and answer with [rendered].
     *
     * `plan` is an encoded `PhotoEditPlan`. A CALLBACK AND NOT AN EFFECT the
     * view sees, for the lightbox hand-off's reason (`PhotoHandOff.kt`,
     * `PhotoHandOff.swift`): decoding and drawing a photograph is platform
     * I/O, which is the shell's, and a view is not where that runs.
     * Unset means this build cannot render, and a save says so rather than
     * spinning.
     */
    public var onRender: ((key: String, sourcePath: String, plan: ByteArray) -> Unit)? = null

    /**
     * Put this screen on the session's core, and start publishing.
     *
     * **NOT ROUTED onto the change stream.** The editor reads its photograph
     * once and never re-reads it: a sync that moved the original's row while a
     * member is cropping must not reset the crop under their finger, and the
     * save names the original by id, not by anything a re-read would refresh.
     */
    public fun attach(session: HomeSession) {
        this.session = session
        // UNDISPATCHED, for `PhotosCollectionsBridge.attach`'s reason: the
        // effects flow has no replay, and a collector that was only scheduled
        // would lose the first `ReadPage` to the race.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            host.effects.collect { effect ->
                when {
                    effect is ScreenEffect.ReadPage &&
                        effect.screenId == PhotoEditorMachine.SCREEN_ID ->
                        scope.launch { serve(session) }

                    effect is ScreenEffect.RenderEdit &&
                        effect.screenId == PhotoEditorMachine.SCREEN_ID -> render(effect)

                    else -> Unit
                }
            }
        }
        scope.launch { host.state.collect { state -> onState?.invoke(state.encode()) } }
    }

    /** The member tapped Edit on this photograph. */
    public fun opened(assetId: String) {
        scope.launch {
            host.send(PhotoEditorEvent(opened = PhotoEditorEvent.Opened(asset_id = assetId)))
        }
    }

    /**
     * THE PLATFORM DREW IT. [path] is a JPEG this bridge now owns and deletes
     * once the commit has answered, whichever way — v0's
     * `deleteSourceAfterSettle`.
     *
     * No date crosses back: the new photograph takes the ORIGINAL's, which
     * the request already carries, so the shell's clock is not asked.
     */
    public fun rendered(key: String, path: String, width: Int, height: Int) {
        scope.launch {
            val request = pending.remove(key)
            if (request == null) {
                withContext(Dispatchers.Default) { discard(path) }
                return@launch
            }
            val outcome = withContext(Dispatchers.Default) {
                try {
                    ingest(request, path, width, height)
                } finally {
                    discard(path)
                }
            }
            host.send(outcome)
        }
    }

    /** The platform could not draw it, and says why in a member's words. */
    public fun renderRefused(key: String, sentence: String) {
        scope.launch {
            if (pending.remove(key) != null) host.send(settled(key, false, "", sentence))
        }
    }

    /** Publish every state to [onState], starting with the current one. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(host.state.value.encode())
    }

    /** Forward one encoded event. */
    public fun send(event: ByteArray) {
        scope.launch { host.send(PhotoEditorEvent.ADAPTER.decode(event)) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }

    // -----------------------------------------------------------------------
    // The read
    // -----------------------------------------------------------------------

    /**
     * THE ROW, THEN THE BYTES' WHEREABOUTS.
     *
     * The byte door is asked only after the page door answered, because the
     * row is what names the content id — and a refusal of the SECOND is not a
     * refusal of the photograph: the stage still draws the thumbnail, and Save
     * says which absence stops it.
     */
    private suspend fun serve(session: HomeSession) {
        val assetId = host.state.value.asset_id
        if (assetId.isEmpty()) return
        val core = session.shelf.core()
        when (val page = core.photosPage(PhotoEditorReads.query(assetId), limit = 1)) {
            is PhotosPage.Refused -> host.send(PhotoEditorReads.refused(page.failure))
            is PhotosPage.Rows -> {
                val row = page.rows.firstOrNull()
                if (row == null) {
                    host.send(PhotoEditorReads.missing())
                    return
                }
                val (path, reason) = original(core, PhotoEditorReads.contentId(row), assetId)
                host.send(PhotoEditorReads.arrived(row, path, reason))
            }
        }
    }

    /** The byte door's answer for one original: a path, or its sentence. */
    private suspend fun original(
        core: CentraidCore?,
        contentId: String,
        assetId: String,
    ): Pair<String?, String> {
        if (core == null || contentId.isEmpty()) return Pair(null, "")
        val outcome = core.call(
            Envelope(
                request_id = 0,
                request = Request(
                    content_urls = ContentUrlRequest(
                        refs = listOf(
                            ContentRef(
                                content_id = contentId,
                                owner_type = PhotoEditorReads.OWNER_TYPE,
                                owner_id = assetId,
                            ),
                        ),
                    ),
                ),
            ),
        )
        val url = (outcome as? CoreOutcome.Answered)?.value?.response?.content_urls?.urls?.firstOrNull()
            ?: return Pair(null, "")
        return Pair(url.path, url.absent_reason)
    }

    // -----------------------------------------------------------------------
    // The save
    // -----------------------------------------------------------------------

    /**
     * Hand the request to the platform, or refuse it with a sentence.
     *
     * A FROZEN VAULT REFUSES BEFORE ANYTHING IS DRAWN (#1029 F1). Rendering a
     * photograph the vault will then decline is seconds of a member's time
     * spent on nothing.
     */
    private suspend fun render(request: ScreenEffect.RenderEdit) {
        if (session?.shelf?.foregroundHolding()?.readOnly == true) {
            host.send(settled(request.key, false, "", Shelf.MOVED_SENTENCE))
            return
        }
        val renderer = onRender
        if (renderer == null) {
            host.send(settled(request.key, false, "", NO_RENDERER))
            return
        }
        pending[request.key] = request
        renderer(request.key, request.sourcePath, request.plan.toByteArray())
    }

    /**
     * STAGE THE RENDERED FILE, COMMIT THE ROW OVER IT, THEN GIVE IT THE
     * ORIGINAL'S PLACE. Three writes, in this order and no other:
     *
     * 1. `StageRequest` (`Staging.stage`) — the bytes, named by the core.
     * 2. `media.add_asset` — the row, carrying the original's `captured_at`,
     *    `tz_offset_min` and caption (as `title`) and its `source_asset_id`.
     *    `CameraRoll.offer`, for a file this phone drew rather than one Photos
     *    handed it, and keyed on the CONTENT HASH for that function's reason:
     *    the same bytes saved twice are one intent, the core's replay ledger
     *    short-circuits the second, and `add_asset` dedupes on the content row
     *    besides.
     * 3. `media.set_asset_place` — only when the original has a place. Not on
     *    the ingest, because `add_asset` can only MINT a place from a
     *    coordinate, and the original's place is a row that already exists —
     *    a second `core_place` a metre away would be a second pin for one spot.
     *    Keyed on `(new asset, place)`, which is the whole of its intent.
     *
     * **A REFUSED PLACE DOES NOT UNSAVE THE PHOTOGRAPH.** The edit is in the
     * library by then; reporting the save as failed would invite a member to
     * save a second copy. It settles committed, and the place is one tap away
     * in the info sheet.
     */
    private suspend fun ingest(
        request: ScreenEffect.RenderEdit,
        path: String,
        width: Int,
        height: Int,
    ): PhotoEditorEvent {
        val key = request.key
        val open = session
        if (open?.shelf?.foregroundHolding()?.readOnly == true) {
            return settled(key, false, "", Shelf.MOVED_SENTENCE)
        }
        val core = open?.shelf?.core() ?: return settled(key, false, "", NO_VAULT)
        val file = path.toPath()
        val size = runCatching { FileSystem.SYSTEM.metadata(file).size }.getOrNull()
            ?: return settled(key, false, "", NO_FILE)
        val staged = try {
            FileSystem.SYSTEM.source(file).buffer().use { source ->
                Staging.stage(core = core, mediaType = MEDIA_TYPE, byteSize = size) { max ->
                    if (source.exhausted()) {
                        ByteArray(0)
                    } else {
                        source.request(max.toLong())
                        source.readByteArray(minOf(source.buffer.size, max.toLong()))
                    }
                }
            }
        } catch (why: okio.IOException) {
            return settled(key, false, "", NO_FILE)
        }
        val hash = when (staged) {
            is Staging.Outcome.No -> return settled(key, false, "", staged.refused.sentence)
            is Staging.Outcome.Ok -> staged.staged.contentHash
        }
        val input = addInput(
            hash = hash,
            capturedAt = request.capturedAt,
            tzOffsetMinutes = request.tzOffsetMinutes?.coerceIn(-TZ_LIMIT, TZ_LIMIT),
            sourceAssetId = request.sourceAssetId,
            title = request.title,
            width = width,
            height = height,
        )
        val answer = core.call(
            Envelope(
                request_id = 0,
                request = Request(
                    command = Command(
                        name = ADD_COMMAND,
                        invoke_key = "$ADD_COMMAND:$hash",
                        input = input.encodeUtf8(),
                    ),
                ),
            ),
        )
        return when (answer) {
            is CoreOutcome.Failed -> settled(key, false, "", answer.failure.sentence)
            is CoreOutcome.Answered -> {
                val command = answer.value.response?.command
                when {
                    command == null -> settled(key, false, "", "")
                    command.status != CommandStatus.COMMAND_STATUS_EXECUTED ->
                        settled(key, false, "", command.reason)
                    else -> {
                        val saved = assetIdOf(command.output.utf8())
                        if (saved.isNotEmpty() && request.placeId.isNotEmpty()) {
                            place(core, saved, request.placeId)
                        }
                        settled(key, true, saved, "")
                    }
                }
            }
        }
    }

    /** The third write. See [ingest] for why its refusal is not the save's. */
    private suspend fun place(core: CentraidCore, assetId: String, placeId: String) {
        core.call(
            Envelope(
                request_id = 0,
                request = Request(
                    command = Command(
                        name = PLACE_COMMAND,
                        invoke_key = "$PLACE_COMMAND:$assetId:$placeId",
                        input = placeInput(assetId, placeId).encodeUtf8(),
                    ),
                ),
            ),
        )
    }

    private fun settled(key: String, committed: Boolean, assetId: String, sentence: String) =
        PhotoEditorEvent(
            save_settled = PhotoEditorEvent.SaveSettled(
                save_key = key,
                committed = committed,
                asset_id = assetId,
                sentence = sentence,
            ),
        )

    private fun discard(path: String) {
        runCatching { FileSystem.SYSTEM.delete(path.toPath(), mustExist = false) }
    }

    internal companion object {
        const val ADD_COMMAND: String = "media.add_asset"
        const val PLACE_COMMAND: String = "media.set_asset_place"
        const val MEDIA_TYPE: String = "image/jpeg"

        /** `media.add_asset`'s own bound on `tz_offset_min`. */
        const val TZ_LIMIT: Int = 1080

        const val NO_RENDERER: String = "This phone cannot draw the edit."
        const val NO_VAULT: String = "No vault is open on this device."
        const val NO_FILE: String = "Centraid could not read the edited photograph."

        /**
         * `media.add_asset`'s input, HAND-SPELLED for `CameraRoll.inputFor`'s
         * reason: it is the hash preimage the core rehashes, and key order is
         * not something this layer leaves to a library.
         */
        fun addInput(
            hash: String,
            capturedAt: String,
            tzOffsetMinutes: Int?,
            sourceAssetId: String,
            title: String,
            width: Int,
            height: Int,
        ): String = buildString {
            append("{\"staged_sha\":").append(PhotoLightboxMachine.jsonString(hash))
            append(",\"kind\":\"photo\"")
            // THE ORIGINAL'S DATE, AS THE VAULT WROTE IT, and nothing when it
            // recorded none: a photograph with no capture time stays one.
            if (capturedAt.isNotEmpty()) {
                append(",\"captured_at\":").append(PhotoLightboxMachine.jsonString(capturedAt))
            }
            if (tzOffsetMinutes != null) append(",\"tz_offset_min\":").append(tzOffsetMinutes)
            // EDIT LINEAGE (#711), and only when there is an original to name.
            if (sourceAssetId.isNotEmpty()) {
                append(",\"source_asset_id\":").append(PhotoLightboxMachine.jsonString(sourceAssetId))
            }
            if (title.isNotEmpty()) {
                append(",\"title\":").append(PhotoLightboxMachine.jsonString(title))
            }
            if (width > 0) append(",\"width\":").append(width)
            if (height > 0) append(",\"height\":").append(height)
            append('}')
        }

        /** `media.set_asset_place`'s input, hand-spelled for the same reason. */
        fun placeInput(assetId: String, placeId: String): String =
            "{\"asset_id\":" + PhotoLightboxMachine.jsonString(assetId) +
                ",\"place_id\":" + PhotoLightboxMachine.jsonString(placeId) + "}"

        /**
         * The new asset's id off the command's output — `{"asset_id": …}` from
         * `add_asset_handler`, which answers the ADOPTED id on a dedupe too.
         * Empty when the output says nothing, and the shell then returns to
         * the photograph it came from rather than to a guess.
         */
        fun assetIdOf(output: String): String =
            ASSET_ID.find(output)?.groupValues?.getOrNull(1).orEmpty()

        private val ASSET_ID = Regex("\"asset_id\"\\s*:\\s*\"([^\"]+)\"")
    }
}
