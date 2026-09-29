package dev.centraid.shared.apps.docs

import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.screen.v1.DocsCapture
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsIngestEvent
import centraid.screen.v1.DocsIngestState
import dev.centraid.core.CoreOutcome
import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.shell.Staging
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okio.ByteString.Companion.encodeUtf8
import okio.FileSystem
import okio.Path.Companion.toPath
import okio.buffer
import okio.use
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * WHAT A DOCS INGEST DOES OUTSIDE THE REDUCER: stream a file into the core
 * and run one write. A seam so a spec drives [DocsIngestBridge] without a
 * core or a file.
 */
public interface DocsIngestPort {
    /** The vault is frozen here (moved to another device): refuse before any byte moves. */
    public suspend fun readOnly(): Boolean

    /**
     * Stream the file at [path] through the stage frames as [mediaType],
     * telling [progress] the bytes sent so far. Answers the core's hash, or
     * the sentence that stopped it.
     */
    public suspend fun stage(path: String, mediaType: String, progress: suspend (Long) -> Unit): Staging.Outcome

    /** Run [command]; committed, else the core's sentence. */
    public suspend fun write(command: String, input: String, invokeKey: String): Pair<Boolean, String>
}

/**
 * ADDING A DOCUMENT, BOTH SHELLS (#1047, R-1047-Q4): the drive's Add sheet
 * hands its Upload, Scan and Text rows here, and this does the rest.
 *
 * ## The platform seam: picking and scanning
 *
 * [onPick] is the shell's: asked with the kind, it presents the OS file
 * picker (Upload — `UIDocumentPickerViewController` on iOS, the Storage Access
 * Framework's `OpenDocument` on Android) or the document scanner (Scan —
 * VisionKit's `VNDocumentCameraViewController`, ML Kit's document scanner or
 * the camera), writes what the member chose to a file on this device, and
 * answers exactly once:
 *
 * - [picked] with that file's absolute path, its name (the title it is filed
 *   under), its media type (empty: read off the name) and whether this bridge
 *   OWNS the file — a copy the shell made (an Android `content://` stream
 *   copied into the cache, iOS's `asCopy` import, a scan's PDF), which is
 *   deleted once the document is filed or the member dismisses;
 * - [pickCancelled] when the member closed the picker;
 * - [pickRefused] with a sentence when the OS would not (the permission is
 *   the drive's `DocsCapture`, reported by the shell).
 *
 * A path and not bytes, for `Staging.stage`'s reason: a 900 MB scan never
 * exists in memory at once. Unset, Upload and Scan say this phone cannot
 * pick, rather than spin.
 *
 * ## Then
 *
 * The bytes go through the stage frames — the camera roll's door — and the
 * core names them; `core.add_document{document_id, staged_sha, title,
 * folder_id}` files them. Text is `core.create_text_document`. When the state
 * reaches FILED the shell pushes `Destination.DocsEditor` (`open_editor`) or
 * `Destination.DocsDocument` with `document_id` and `parent`, then calls
 * [routed] — observed at the shell's ROOT (Android `AppRoutes.Global`, the
 * iOS app root), never on the drive page, so the push does not wait for the
 * member to come back to the drive.
 *
 * Bytes across to SwiftUI, nothing `suspend`, one host for the bridge's life.
 */
public class DocsIngestBridge internal constructor(
    private var port: DocsIngestPort?,
    dispatcher: CoroutineDispatcher,
) {
    public constructor() : this(null, Dispatchers.Main)

    /** The host, exposed because Android drives it directly. */
    public val host: ScreenHost<DocsIngestState, DocsIngestEvent> = ScreenHost(DocsIngestMachine)

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val serial = Mutex()
    private var onState: ((ByteArray) -> Unit)? = null

    /** The picked file, held between picking and filing (and for Try again). */
    private var file: Picked? = null
    private var stagedSha: String = ""

    private data class Picked(val path: String, val mediaType: String, val owned: Boolean)

    /**
     * THE SHELL'S PICKER OR SCANNER. See the class header: answer with
     * [picked], [pickCancelled] or [pickRefused], exactly once.
     */
    public var onPick: ((kind: DocsDriveEvent.AddRequested.Kind) -> Unit)? = null

    /** Put the bridge on the session's core, and start publishing. */
    public fun attach(session: HomeSession) {
        if (port == null) port = CorePort(session)
        scope.launch { host.state.collect { state -> onState?.invoke(state.encode()) } }
    }

    /** Publish every state to [onState], starting with the current one. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(host.state.value.encode())
    }

    /** The current state, encoded. */
    public fun current(): ByteArray = host.state.value.encode()

    /**
     * The drive's `AddRequested`: [kind] into [folderId] (empty: the top
     * level), from the drive page titled [parent] (the filed document's back
     * word; empty: "Docs"). A request while another ingest runs is nothing.
     */
    public fun request(kind: DocsDriveEvent.AddRequested.Kind, folderId: String, parent: String) {
        run(
            DocsIngestEvent(
                requested = DocsIngestEvent.Requested(kind = kind, folder_id = folderId, document_id = mintId(), parent = parent),
            ),
        )
    }

    /**
     * The Add sheet's row, by its `DocsAction.key`: Upload, Scan and Text
     * start an ingest; any other row (New folder) is the drive's alone.
     */
    public fun requestFor(actionKey: String, folderId: String, parent: String) {
        val kind = DocsIngestMachine.kindOf(actionKey) ?: return
        request(kind, folderId, parent)
    }

    /** The platform's answer: a file on this device. See the class header. */
    public fun picked(path: String, name: String, mediaType: String, owned: Boolean) {
        scope.launch {
            serial.withLock {
                if (host.state.value.phase != DocsIngestState.Phase.PHASE_PICKING) {
                    if (owned) discard(path)
                    return@withLock
                }
                val size = withContext(Dispatchers.Default) { sizeOf(path) }
                discardHeld()
                file = Picked(path, DocsIngestMachine.mediaTypeOf(name, mediaType), owned)
                stagedSha = ""
                apply(DocsIngestEvent(picked = DocsIngestEvent.Picked(name = name, media_type = mediaType, byte_size = size)))
            }
        }
    }

    /** The member closed the picker or the scanner. */
    public fun pickCancelled() {
        run(DocsIngestEvent(pick_cancelled = DocsIngestEvent.PickCancelled()))
    }

    /** The OS would not pick, in the member's words. */
    public fun pickRefused(sentence: String) {
        run(DocsIngestEvent(pick_refused = DocsIngestEvent.PickRefused(sentence = sentence)))
    }

    /**
     * The scanner gave up. [camera] is the camera grant as the shell reads it
     * now (a `DocsCapture.Permission` value, a number so Swift can pass it):
     * the machine picks the sentence ([DocsIngestMachine.scanRefusal]).
     */
    public fun scanRefused(camera: Int) {
        val permission = DocsCapture.Permission.fromValue(camera) ?: DocsCapture.Permission.PERMISSION_UNSPECIFIED
        pickRefused(DocsIngestMachine.scanRefusal(permission))
    }

    /** Try again, after a failure. */
    public fun retry() {
        run(DocsIngestEvent(retried = DocsIngestEvent.Retried()))
    }

    /** Put the status away (a failure, or a filed document's line). */
    public fun dismiss() {
        run(DocsIngestEvent(dismissed = DocsIngestEvent.Dismissed()))
    }

    /** The shell pushed the filed document for [requestSeq]. */
    public fun routed(requestSeq: Int) {
        run(DocsIngestEvent(routed = DocsIngestEvent.Routed(request_seq = requestSeq)))
    }

    /** Forward one encoded event (SwiftUI): the same doors as the calls above. */
    public fun send(event: ByteArray) {
        forward(DocsIngestEvent.ADAPTER.decode(event))
    }

    /** Forward one event (Compose). */
    public fun forward(event: DocsIngestEvent) {
        run(event)
    }

    /** Release the scope, and any file this bridge owns. */
    public fun close() {
        discardHeld()
        scope.cancel()
    }

    // -----------------------------------------------------------------------
    // The loop: reduce, then do what the new phase asks
    // -----------------------------------------------------------------------

    private fun run(event: DocsIngestEvent) {
        scope.launch { serial.withLock { apply(event) } }
    }

    /** Reduce [event], then act on the phase it entered. Under [serial]. */
    private suspend fun apply(event: DocsIngestEvent) {
        val before = host.state.value
        host.send(event)
        val after = host.state.value
        if (after.phase == before.phase && event.retried == null && event.requested == null) return
        when (after.phase) {
            DocsIngestState.Phase.PHASE_PICKING -> pick(after)
            DocsIngestState.Phase.PHASE_STAGING -> stage()
            DocsIngestState.Phase.PHASE_FILING -> file(after)
            DocsIngestState.Phase.PHASE_FILED, DocsIngestState.Phase.PHASE_IDLE -> discardHeld()
            else -> Unit
        }
    }

    private suspend fun pick(state: DocsIngestState) {
        val picker = onPick
        if (picker == null) {
            apply(DocsIngestEvent(pick_refused = DocsIngestEvent.PickRefused(sentence = DocsCopy.INGEST_NO_PICKER)))
            return
        }
        picker(state.kind)
    }

    private suspend fun stage() {
        val held = file
        val io = port
        val refusal = when {
            io == null -> DocsCopy.INGEST_NO_VAULT
            held == null -> DocsCopy.INGEST_NO_FILE
            io.readOnly() -> Shelf.MOVED_SENTENCE
            else -> null
        }
        if (refusal != null || io == null || held == null) {
            apply(settled(false, refusal ?: DocsCopy.INGEST_NO_FILE))
            return
        }
        val outcome = io.stage(held.path, held.mediaType) { sent ->
            host.send(DocsIngestEvent(progressed = DocsIngestEvent.Progressed(staged_bytes = sent)))
        }
        when (outcome) {
            is Staging.Outcome.No -> apply(settled(false, outcome.refused.sentence))
            is Staging.Outcome.Ok -> {
                stagedSha = outcome.staged.contentHash
                apply(DocsIngestEvent(staged = DocsIngestEvent.Staged(staged_sha = stagedSha)))
            }
        }
    }

    private suspend fun file(state: DocsIngestState) {
        val io = port ?: return apply(settled(false, DocsCopy.INGEST_NO_VAULT))
        if (io.readOnly()) return apply(settled(false, Shelf.MOVED_SENTENCE))
        val (command, input, key) = DocsIngestMachine.filing(state, stagedSha)
            ?: return apply(settled(false, DocsCopy.INGEST_NO_FILE))
        val (committed, sentence) = io.write(command, input, key)
        apply(settled(committed, sentence))
    }

    private fun settled(committed: Boolean, sentence: String) =
        DocsIngestEvent(settled = DocsIngestEvent.Settled(committed = committed, sentence = sentence))

    private fun discardHeld() {
        val held = file ?: return
        file = null
        stagedSha = ""
        if (held.owned) discard(held.path)
    }

    private fun discard(path: String) {
        runCatching { FileSystem.SYSTEM.delete(path.toPath(), mustExist = false) }
    }

    private fun sizeOf(path: String): Long =
        runCatching { FileSystem.SYSTEM.metadata(path.toPath()).size }.getOrNull() ?: 0L

    /** The session's core: the stage frames and the command door. */
    private class CorePort(private val session: HomeSession) : DocsIngestPort {
        override suspend fun readOnly(): Boolean = session.shelf.foregroundHolding()?.readOnly == true

        override suspend fun stage(
            path: String,
            mediaType: String,
            progress: suspend (Long) -> Unit,
        ): Staging.Outcome {
            val core = session.shelf.core() ?: return no(DocsCopy.INGEST_NO_VAULT)
            val file = path.toPath()
            val size = runCatching { FileSystem.SYSTEM.metadata(file).size }.getOrNull()
                ?: return no(DocsCopy.INGEST_NO_FILE)
            return try {
                FileSystem.SYSTEM.source(file).buffer().use { source ->
                    var sent = 0L
                    Staging.stage(core = core, mediaType = mediaType, byteSize = size) { max ->
                        if (source.exhausted()) {
                            ByteArray(0)
                        } else {
                            source.request(max.toLong())
                            source.readByteArray(minOf(source.buffer.size, max.toLong())).also {
                                sent += it.size
                                progress(sent)
                            }
                        }
                    }
                }
            } catch (why: okio.IOException) {
                no(DocsCopy.INGEST_NO_FILE)
            }
        }

        override suspend fun write(command: String, input: String, invokeKey: String): Pair<Boolean, String> {
            val core = session.shelf.core() ?: return false to DocsCopy.INGEST_NO_VAULT
            val answer = core.call(
                Envelope(
                    request_id = 0,
                    request = Request(command = Command(name = command, invoke_key = invokeKey, input = input.encodeUtf8())),
                ),
            )
            return when (answer) {
                is CoreOutcome.Failed -> false to answer.failure.sentence
                is CoreOutcome.Answered -> {
                    val done = answer.value.response?.command
                    when {
                        done == null -> false to ""
                        done.status != CommandStatus.COMMAND_STATUS_EXECUTED -> false to done.reason
                        else -> true to ""
                    }
                }
            }
        }

        private fun no(sentence: String): Staging.Outcome = Staging.Outcome.No(Staging.Refused(sentence))
    }

    internal companion object {
        /** The row id this phone mints for a new document, so the key and the row agree. */
        @OptIn(ExperimentalUuidApi::class)
        fun mintId(): String = Uuid.random().toString()

        /** A bridge over [port], for a spec. */
        internal fun over(port: DocsIngestPort, dispatcher: CoroutineDispatcher): DocsIngestBridge =
            DocsIngestBridge(port, dispatcher)
    }
}
