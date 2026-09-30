package dev.centraid.shared.apps.docs

import centraid.screen.v1.DocsCapture
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsIngestEvent
import centraid.screen.v1.DocsIngestState
import centraid.screen.v1.SeatState
import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * ADDING A DOCUMENT (#1047, R-1047-Q4): Upload, Scan and Text from the
 * drive's Add sheet, as one pure reducer. [DocsIngestBridge] does the I/O
 * each phase asks for — the platform's picker, the stage frames, the write —
 * and reports back with events; this decides nothing but the state.
 *
 * ```
 *   Requested ─┬─ UPLOAD/SCAN ─> PICKING ─Picked─> STAGING ─Staged─> FILING ─Settled─> FILED
 *              └─ TEXT ─────────────────────────────────────────────> FILING
 *   any refusal ─> FAILED ─Retried─> (STAGING with the file held, else PICKING; TEXT: FILING)
 * ```
 *
 * One ingest at a time: a request while one is picking, staging or filing is
 * nothing. A FILED text document opens its editor, anything else its page —
 * once per [DocsIngestState.request_seq], which the shell acknowledges with
 * `Routed`. The shell observes this at its ROOT, so the push happens wherever
 * the member is when the filing lands, with [DocsIngestState.parent] as its
 * back word.
 */
public object DocsIngestMachine : ScreenMachine<DocsIngestState, DocsIngestEvent> {
    public const val SCREEN_ID: String = "docs.ingest"

    private const val PERMILLE: Long = 1000

    override fun initial(): DocsIngestState = DocsIngestState(phase = DocsIngestState.Phase.PHASE_IDLE)

    override fun reduce(state: DocsIngestState, event: DocsIngestEvent): Step<DocsIngestState> =
        Step(decorate(step(state, event)))

    override fun rowsChanged(table: String, keys: List<String>): DocsIngestEvent? = null

    override fun seatChanged(seat: SeatState): DocsIngestEvent? = null

    /** Whether an ingest is under way, so a second request is nothing. */
    public fun busy(state: DocsIngestState): Boolean = state.phase in BUSY

    private val BUSY = setOf(
        DocsIngestState.Phase.PHASE_PICKING,
        DocsIngestState.Phase.PHASE_STAGING,
        DocsIngestState.Phase.PHASE_FILING,
    )

    /** The Add sheet's row key as the kind it asks for; null for a row that is not an ingest. */
    public fun kindOf(actionKey: String): DocsDriveEvent.AddRequested.Kind? = when (actionKey) {
        DocsWrites.KEY_UPLOAD -> DocsDriveEvent.AddRequested.Kind.KIND_UPLOAD
        DocsWrites.KEY_SCAN -> DocsDriveEvent.AddRequested.Kind.KIND_SCAN
        DocsWrites.KEY_TEXT -> DocsDriveEvent.AddRequested.Kind.KIND_TEXT
        else -> null
    }

    /**
     * WHY THE SCANNER FAILED, IN THE MEMBER'S WORDS: the camera grant the
     * shell reads after the scanner gives up. A member who declined the OS's
     * camera question is told where to turn it on — the same sentence the Add
     * sheet's greyed Scan row says — not that a file could not be read.
     */
    public fun scanRefusal(camera: DocsCapture.Permission): String = when (camera) {
        DocsCapture.Permission.PERMISSION_DENIED -> DocsCopy.CAMERA_DENIED
        DocsCapture.Permission.PERMISSION_RESTRICTED -> DocsCopy.CAMERA_RESTRICTED
        else -> DocsCopy.INGEST_NO_FILE
    }

    private fun step(state: DocsIngestState, event: DocsIngestEvent): DocsIngestState = when {
        event.requested != null -> requested(state, event.requested)

        event.picked != null && state.phase == DocsIngestState.Phase.PHASE_PICKING -> state.copy(
            phase = DocsIngestState.Phase.PHASE_STAGING,
            title = titleOf(state.kind, event.picked.name),
            staged_bytes = 0,
            total_bytes = event.picked.byte_size,
            file_held = true,
        )

        // THE MEMBER CLOSED THE PICKER: nothing happened, so nothing is said.
        event.pick_cancelled != null && state.phase == DocsIngestState.Phase.PHASE_PICKING -> idle(state)

        event.pick_refused != null && state.phase == DocsIngestState.Phase.PHASE_PICKING ->
            failed(state, event.pick_refused.sentence.ifEmpty { DocsCopy.INGEST_NO_PICKER })

        event.progressed != null && state.phase == DocsIngestState.Phase.PHASE_STAGING -> state.copy(
            staged_bytes = event.progressed.staged_bytes,
        )

        event.staged != null && state.phase == DocsIngestState.Phase.PHASE_STAGING -> state.copy(
            phase = DocsIngestState.Phase.PHASE_FILING,
            staged_bytes = state.total_bytes.coerceAtLeast(state.staged_bytes),
        )

        event.settled != null && state.phase in SETTLING -> if (event.settled.committed) {
            state.copy(phase = DocsIngestState.Phase.PHASE_FILED, failure = null, routed = false)
        } else {
            failed(state, event.settled.sentence.ifEmpty { DocsCopy.INGEST_NO_FILE })
        }

        event.retried != null && state.phase == DocsIngestState.Phase.PHASE_FAILED -> state.copy(
            phase = when {
                state.kind == DocsDriveEvent.AddRequested.Kind.KIND_TEXT -> DocsIngestState.Phase.PHASE_FILING
                state.file_held -> DocsIngestState.Phase.PHASE_STAGING
                else -> DocsIngestState.Phase.PHASE_PICKING
            },
            staged_bytes = 0,
            failure = null,
        )

        event.dismissed != null && state.phase !in BUSY -> idle(state)

        event.routed != null && event.routed.request_seq == state.request_seq -> state.copy(routed = true)

        else -> state
    }

    private val SETTLING = setOf(DocsIngestState.Phase.PHASE_STAGING, DocsIngestState.Phase.PHASE_FILING)

    private fun requested(state: DocsIngestState, requested: DocsIngestEvent.Requested): DocsIngestState {
        if (busy(state) || requested.document_id.isEmpty()) return state
        val text = requested.kind == DocsDriveEvent.AddRequested.Kind.KIND_TEXT
        if (!text && requested.kind != DocsDriveEvent.AddRequested.Kind.KIND_UPLOAD &&
            requested.kind != DocsDriveEvent.AddRequested.Kind.KIND_SCAN
        ) {
            return state
        }
        return DocsIngestState(
            phase = if (text) DocsIngestState.Phase.PHASE_FILING else DocsIngestState.Phase.PHASE_PICKING,
            kind = requested.kind,
            folder_id = requested.folder_id,
            title = if (text) DocsCopy.INGEST_TEXT_TITLE else "",
            document_id = requested.document_id,
            open_editor = text,
            request_seq = state.request_seq + 1,
            parent = requested.parent.ifBlank { DocsCopy.APP_TITLE },
        )
    }

    private fun idle(state: DocsIngestState): DocsIngestState = DocsIngestState(
        phase = DocsIngestState.Phase.PHASE_IDLE,
        request_seq = state.request_seq,
        routed = state.routed,
    )

    private fun failed(state: DocsIngestState, sentence: String): DocsIngestState = state.copy(
        phase = DocsIngestState.Phase.PHASE_FAILED,
        failure = Reads.refused(sentence),
    )

    /** The file's name as its title; a scan with none is "Scanned document". */
    internal fun titleOf(kind: DocsDriveEvent.AddRequested.Kind, name: String): String =
        name.trim().ifEmpty {
            if (kind == DocsDriveEvent.AddRequested.Kind.KIND_SCAN) DocsCopy.INGEST_SCAN_TITLE else DocsCopy.UNTITLED
        }

    /** The words and the bar, from the phase — every state, every step. */
    private fun decorate(state: DocsIngestState): DocsIngestState {
        val status = when (state.phase) {
            DocsIngestState.Phase.PHASE_STAGING, DocsIngestState.Phase.PHASE_FILING ->
                DocsCopy.INGEST_ADDING.replace("{title}", state.title)
            DocsIngestState.Phase.PHASE_FILED -> DocsCopy.INGEST_ADDED.replace("{title}", state.title)
            DocsIngestState.Phase.PHASE_FAILED -> state.failure?.sentence ?: DocsCopy.INGEST_NO_FILE
            else -> ""
        }
        val failed = state.phase == DocsIngestState.Phase.PHASE_FAILED
        // One text action (Try again, on a failure) and a close key on any
        // settled line (DESIGN.md's StatusLine); the line never clears itself.
        val settled = failed || state.phase == DocsIngestState.Phase.PHASE_FILED
        return state.copy(
            status_label = status,
            progress_permille = when {
                state.phase == DocsIngestState.Phase.PHASE_FILING ||
                    state.phase == DocsIngestState.Phase.PHASE_FILED -> PERMILLE.toInt()
                state.total_bytes > 0 ->
                    ((state.staged_bytes.coerceAtMost(state.total_bytes) * PERMILLE) / state.total_bytes).toInt()
                else -> 0
            },
            retry_label = if (failed) DocsCopy.RETRY else "",
            dismiss_label = if (settled) DocsCopy.INGEST_DISMISS else "",
        )
    }

    // ---------------------------------------------------------------------
    // The writes' inputs and keys
    // ---------------------------------------------------------------------

    /**
     * The write that files this ingest, as `(command, input, key)`. Keyed on
     * the document id this phone minted: a retry is the same write, and the
     * core's replay ledger answers a duplicate rather than filing twice.
     */
    internal fun filing(state: DocsIngestState, stagedSha: String): Triple<String, String, String>? = when {
        state.kind == DocsDriveEvent.AddRequested.Kind.KIND_TEXT -> Triple(
            DocsWrites.CREATE_TEXT,
            DocsWrites.createText(state.document_id, state.title, state.folder_id),
            InvokeKeys.of(DocsWrites.CREATE_TEXT, state.document_id),
        )
        stagedSha.isNotEmpty() -> Triple(
            DocsWrites.ADD,
            DocsWrites.upload(state.document_id, stagedSha, state.title, state.folder_id),
            InvokeKeys.of(DocsWrites.ADD, state.document_id, stagedSha),
        )
        else -> null
    }

    /**
     * A media type for a file the platform named none for, off its name —
     * the core has no sniffer, and bytes promoted as
     * `application/octet-stream` are ones no stage will draw.
     */
    public fun mediaTypeOf(name: String, stated: String): String {
        if (stated.isNotBlank()) return stated.trim()
        val extension = name.substringAfterLast('.', "").lowercase()
        return MEDIA_TYPES[extension] ?: OCTET_STREAM
    }

    private const val OCTET_STREAM: String = "application/octet-stream"

    private val MEDIA_TYPES: Map<String, String> = mapOf(
        "pdf" to "application/pdf",
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "heic" to "image/heic",
        "gif" to "image/gif",
        "webp" to "image/webp",
        "txt" to "text/plain",
        "md" to "text/markdown",
        "csv" to "text/csv",
        "mp4" to "video/mp4",
        "mov" to "video/quicktime",
        "mp3" to "audio/mpeg",
        "m4a" to "audio/mp4",
        "doc" to "application/msword",
        "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" to "application/vnd.ms-excel",
        "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
}
