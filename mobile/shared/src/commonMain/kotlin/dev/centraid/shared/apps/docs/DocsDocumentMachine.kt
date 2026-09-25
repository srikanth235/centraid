package dev.centraid.shared.apps.docs

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.DocsActivityRequest
import centraid.core.v1.DocsDocumentRequest
import centraid.core.v1.DocsDriveRequest
import centraid.core.v1.DocsShelf
import centraid.screen.v1.Confirm
import centraid.screen.v1.DocsActionList
import centraid.screen.v1.DocsChoiceList
import centraid.screen.v1.DocsDocumentChrome
import centraid.screen.v1.DocsDocumentData
import centraid.screen.v1.DocsDocumentEvent
import centraid.screen.v1.DocsDocumentState
import centraid.screen.v1.DocsRename
import centraid.screen.v1.DocsSheet
import centraid.screen.v1.Loading
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.dataOf
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * ONE DOCUMENT (#1046, docs port): a pushed page (#1015 D4: content pushes).
 *
 * The core says which surface opens it — the reader over the decoded text,
 * the media stage over the bytes (or why they are not on this device), or the
 * facts for a kind the phone cannot render — and this screen draws that with
 * the facts, the versions and the activity under it. The head's writes are
 * the drive row's (star, rename inline, move, labels, trash behind a confirm),
 * plus restore on a trashed document and an earlier version made current.
 * Editing the text is `docs.editor`, pushed by the shell on `EditRequested`.
 */
public object DocsDocumentMachine : ScreenMachine<DocsDocumentState, DocsDocumentEvent> {
    public const val SCREEN_ID: String = "docs.document"

    /**
     * The drive's tables, the version chain and the audit trail the activity
     * rail reads. `DocsDocumentReads.tables` is this set.
     */
    public val TABLES: Set<String> = DocsDriveMachine.TABLES + setOf("core_entity_revision", "access_provenance")

    override fun initial(): DocsDocumentState = decorate(
        DocsDocumentState(
            loading = Loading(first_load = true),
            write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
            sheet = DocsSheet(kind = DocsSheet.Kind.KIND_NONE),
        ),
    )

    override fun reduce(state: DocsDocumentState, event: DocsDocumentEvent): Step<DocsDocumentState> {
        val step = step(state, event)
        return Step(decorate(step.state), step.effects)
    }

    override fun rowsChanged(table: String, keys: List<String>): DocsDocumentEvent? =
        if (table in TABLES) DocsDocumentEvent(rows_changed = DocsDocumentEvent.RowsChanged(table = table)) else null

    override fun seatChanged(seat: SeatState): DocsDocumentEvent =
        DocsDocumentEvent(seat_changed = DocsDocumentEvent.SeatChanged(seat = seat))

    override fun ticked(token: String): DocsDocumentEvent = DocsDocumentEvent(tick = DocsDocumentEvent.Ticked(token = token))

    override fun left(): DocsDocumentEvent = DocsDocumentEvent(left = DocsDocumentEvent.Left())

    private fun step(state: DocsDocumentState, event: DocsDocumentEvent): Step<DocsDocumentState> = when {
        event.opened != null -> ReadGate.read(
            Gate,
            Content.with(
                initial().copy(
                    seat = state.seat,
                    document_id = event.opened.document_id,
                    title_hint = event.opened.title,
                    reading = state.reading,
                    read_queued = state.read_queued,
                ),
                ReadContent.Loading(firstLoad = true),
            ),
        )

        event.refreshed != null || event.rows_changed != null -> refresh(state)

        event.data_ != null -> landed(state) { s ->
            Step(Content.with(s.copy(refreshing = false), ReadContent.Data(event.data_.data_ ?: DocsDocumentData())))
        }

        event.refused != null -> landed(state) { s ->
            Step(Content.with(s.copy(refreshing = false), ReadContent.Failed(event.refused.failure ?: Reads.refused(""))))
        }

        event.denied != null -> landed(state) { s ->
            Step(Content.with(s.copy(refreshing = false), ReadContent.Denied(event.denied)))
        }

        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

        // THE VERBS SHEET: every verb the head offers, as a list.
        event.more_opened != null || event.action?.key == DocsWrites.KEY_MORE ->
            if (Content.dataOf(state)?.row == null) Step(state) else Step(state.copy(sheet = DocsSheet(kind = DocsSheet.Kind.KIND_MORE)))

        event.action != null -> action(
            // A verb picked from the sheet closes it.
            if (state.sheet?.kind == DocsSheet.Kind.KIND_MORE) state.copy(sheet = none()) else state,
            event.action.key,
        )

        event.choice != null -> choice(state, event.choice.key)

        event.sheet_closed != null -> Step(state.copy(sheet = none()))

        event.rename_edited != null -> DocsRenameLaw.edited(Rename, state, event.rename_edited.title)

        event.rename_closed != null || event.left != null -> DocsRenameLaw.closed(Rename, state)

        event.tick != null -> DocsRenameLaw.tick(Rename, state, event.tick.token)

        event.label_added != null -> labelAdded(state, event.label_added.label)

        event.label_removed != null -> {
            val tagId = event.label_removed.tag_id
            if (tagId.isEmpty()) {
                Step(state)
            } else {
                WriteLaw.submit(Writes, state, DocsWrites.UNTAG, DocsWrites.untag(tagId), InvokeKeys.of(DocsWrites.UNTAG, tagId))
            }
        }

        event.label_draft != null -> {
            val sheet = state.sheet
            val labels = sheet?.labels
            if (sheet == null || labels == null) {
                Step(state)
            } else {
                Step(state.copy(sheet = sheet.copy(labels = labels.copy(draft = event.label_draft.text))))
            }
        }

        event.version_restore != null -> versionRestore(state, event.version_restore.content_id)

        event.confirmed != null -> {
            val cleared = state.copy(confirm = null)
            if (state.confirm == null || state.document_id.isEmpty()) {
                Step(cleared)
            } else {
                WriteLaw.submit(
                    Writes,
                    cleared,
                    DocsWrites.TRASH,
                    DocsWrites.documentOnly(state.document_id),
                    InvokeKeys.of(DocsWrites.TRASH, state.document_id),
                )
            }
        }

        event.dismissed != null -> Step(state.copy(confirm = null))

        event.write_settled != null ->
            if (DocsRenameLaw.owns(Rename, state, event.write_settled.invoke_key)) {
                DocsRenameLaw.settled(Rename, state, event.write_settled)
            } else {
                WriteLaw.settled(Writes, state, event.write_settled)
            }

        // INTENTS, routed by the shell.
        else -> Step(state)
    }

    private fun refresh(state: DocsDocumentState): Step<DocsDocumentState> =
        if (state.document_id.isEmpty()) {
            Step(state)
        } else if (Content.dataOf(state) != null) {
            ReadGate.read(Gate, state.copy(refreshing = true))
        } else {
            ReadGate.read(Gate, Content.with(state, ReadContent.Loading(firstLoad = true)))
        }

    private fun landed(
        state: DocsDocumentState,
        fold: (DocsDocumentState) -> Step<DocsDocumentState>,
    ): Step<DocsDocumentState> {
        val (settled, superseded) = ReadGate.landed(Gate, state)
        return superseded ?: fold(settled)
    }

    private fun action(state: DocsDocumentState, key: String): Step<DocsDocumentState> {
        val row = Content.dataOf(state)?.row ?: return Step(state)
        val id = row.document_id
        // Only what the head offers is done: a key for a verb this document
        // does not have (restore on a live one, trash on a trashed one) is nothing.
        val offered = Content.dataOf(state)?.actions.orEmpty().firstOrNull { it.key == key && it.enabled }
            ?: return Step(state)
        return when (offered.key) {
            DocsWrites.KEY_STAR, DocsWrites.KEY_UNSTAR -> {
                val command = if (key == DocsWrites.KEY_STAR) DocsWrites.STAR else DocsWrites.UNSTAR
                WriteLaw.submit(Writes, state, command, DocsWrites.documentOnly(id), InvokeKeys.of(command, id))
            }
            DocsWrites.KEY_RESTORE ->
                WriteLaw.submit(Writes, state, DocsWrites.RESTORE, DocsWrites.documentOnly(id), InvokeKeys.of(DocsWrites.RESTORE, id))
            DocsWrites.KEY_RENAME -> DocsRenameLaw.opened(Rename, state, id, row.title)
            DocsWrites.KEY_MOVE -> Step(state.copy(sheet = DocsSheet(kind = DocsSheet.Kind.KIND_MOVE, document_id = id)))
            DocsWrites.KEY_LABELS -> Step(state.copy(sheet = DocsSheet(kind = DocsSheet.Kind.KIND_LABELS, document_id = id)))
            DocsWrites.KEY_TRASH -> Step(
                state.copy(
                    confirm = Confirm(
                        title = DocsCopy.TRASH_CONFIRM_TITLE,
                        body = DocsCopy.TRASH_CONFIRM_BODY,
                        confirm_label = DocsCopy.TRASH_CONFIRM,
                        destructive = true,
                    ),
                ),
            )
            // `edit` is the shell's route to the editor (`EditRequested`).
            else -> Step(state)
        }
    }

    private fun choice(state: DocsDocumentState, key: String): Step<DocsDocumentState> {
        val sheet = state.sheet ?: return Step(state)
        val row = Content.dataOf(state)?.row ?: return Step(state)
        val closed = state.copy(sheet = none())
        if (sheet.kind != DocsSheet.Kind.KIND_MOVE) return Step(state)
        val folderId = if (key == DocsWrites.KEY_TOP_LEVEL) "" else key
        if (folderId == row.folder_id) return Step(closed)
        return WriteLaw.submit(
            Writes,
            closed,
            DocsWrites.MOVE,
            DocsWrites.move(row.document_id, folderId),
            InvokeKeys.of(DocsWrites.MOVE, row.document_id, key),
        )
    }

    private fun labelAdded(state: DocsDocumentState, raw: String): Step<DocsDocumentState> {
        val row = Content.dataOf(state)?.row ?: return Step(state)
        val label = raw.trim()
        val sheet = state.sheet
        val cleared = if (sheet?.labels != null) state.copy(sheet = sheet.copy(labels = sheet.labels.copy(draft = ""))) else state
        if (label.isEmpty() || row.labels.any { it.label == label }) return Step(cleared)
        return WriteLaw.submit(
            Writes,
            cleared,
            DocsWrites.TAG,
            DocsWrites.tag(row.document_id, label),
            InvokeKeys.of(DocsWrites.TAG, row.document_id, label),
        )
    }

    private fun versionRestore(state: DocsDocumentState, contentId: String): Step<DocsDocumentState> {
        val data = Content.dataOf(state) ?: return Step(state)
        val row = data.row ?: return Step(state)
        val version = data.versions.firstOrNull { it.content_id == contentId } ?: return Step(state)
        // THE ROW SAID WHETHER IT CAN: an earlier version of a live document.
        if (version.restore_label.isEmpty()) return Step(state)
        return WriteLaw.submit(
            Writes,
            state,
            DocsWrites.RESTORE_VERSION,
            DocsWrites.restoreVersion(row.document_id, contentId),
            InvokeKeys.of(DocsWrites.RESTORE_VERSION, row.document_id, contentId),
        )
    }

    private fun none(): DocsSheet = DocsSheet(kind = DocsSheet.Kind.KIND_NONE)

    private fun decorate(state: DocsDocumentState): DocsDocumentState {
        val data = state.data_
        val rename = state.rename
        val shown = if (data != null && rename != null && data.row?.document_id == rename.document_id) {
            state.copy(data_ = data.copy(row = data.row.copy(title = rename.title)))
        } else {
            state
        }
        return shown.copy(
            chrome = DocsDocumentChrome(
                back = DocsCopy.BACK,
                retry = DocsCopy.RETRY,
                loading = DocsCopy.LOADING,
                more = DocsCopy.MORE,
                versions_heading = DocsCopy.VERSIONS_HEADING,
                activity_heading = DocsCopy.ACTIVITY_HEADING,
                facts_heading = DocsCopy.DETAILS_HEADING,
                rename_placeholder = DocsCopy.RENAME_PLACEHOLDER,
                rename_done = DocsCopy.DONE,
            ),
            rename = rename?.let { it.copy(status_label = DocsRenameLaw.status(it)) },
            sheet = sheetOf(shown),
        )
    }

    private fun sheetOf(state: DocsDocumentState): DocsSheet {
        val sheet = state.sheet ?: return none()
        val data = state.data_
        val row = data?.row
        if (data == null || row == null) return none()
        val base = DocsSheet(kind = sheet.kind, document_id = row.document_id, close_label = DocsCopy.CLOSE)
        return when (sheet.kind) {
            DocsSheet.Kind.KIND_MOVE -> base.copy(
                title = DocsCopy.MOVE_TITLE,
                choices = DocsChoiceList(choices = DocsDriveMachine.moveChoices(data.folders, row.folder_id)),
            )
            DocsSheet.Kind.KIND_LABELS -> base.copy(
                title = DocsCopy.LABELS_TITLE,
                labels = DocsDriveMachine.labelsSheet(row, data.labels, sheet.labels?.draft ?: ""),
            )
            DocsSheet.Kind.KIND_MORE -> base.copy(title = row.title, actions = DocsActionList(actions = data.actions))
            else -> none()
        }
    }

    internal object Content : ContentLens<DocsDocumentState, DocsDocumentData> {
        override fun content(state: DocsDocumentState): ReadContent<DocsDocumentData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: DocsDocumentState, content: ReadContent<DocsDocumentData>): DocsDocumentState =
            when (content) {
                is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
                is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
                is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
                is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
            }
    }

    private object Writes : WriteLens<DocsDocumentState> {
        override fun write(state: DocsDocumentState): WriteState = state.write ?: WriteState()

        override fun with(state: DocsDocumentState, write: WriteState): DocsDocumentState = state.copy(write = write)
    }

    private object Rename : RenameSlot<DocsDocumentState> {
        override val screenId: String = SCREEN_ID

        override fun rename(state: DocsDocumentState): DocsRename? = state.rename

        override fun with(state: DocsDocumentState, rename: DocsRename?): DocsDocumentState = state.copy(rename = rename)
    }

    private object Gate : ReadGateLens<DocsDocumentState> {
        override val screenId: String = SCREEN_ID

        override fun reading(state: DocsDocumentState): Boolean = state.reading

        override fun queued(state: DocsDocumentState): Boolean = state.read_queued

        override fun with(state: DocsDocumentState, reading: Boolean, queued: Boolean): DocsDocumentState =
            state.copy(reading = reading, read_queued = queued)
    }
}

/**
 * WHAT ONE DOCUMENT ASKS THE CORE: the document, its activity, and the
 * drive's rail at its smallest window — the move and labels sheets need every
 * folder and label, and only `docs.drive` answers them.
 */
public object DocsDocumentReads :
    ScreenQueries<DocsDocumentState, DocsDocumentEvent>,
    ScreenWrites<DocsDocumentState, DocsDocumentEvent> {
    override val screenId: String = DocsDocumentMachine.SCREEN_ID

    override val tables: Set<String> = DocsDocumentMachine.TABLES

    override val appId: String = DocsWrites.APP_ID

    /** `docs.drive`'s smallest window: the rail is whole whatever the window. */
    public const val RAIL_WINDOW: Int = 20

    override fun requests(state: DocsDocumentState, now: DeviceClock.Reading): List<AppQueryRequest>? {
        val id = state.document_id.ifEmpty { return null }
        return listOf(
            AppQueryRequest(docs_document = DocsDocumentRequest(document_id = id, tz = now.zone)),
            AppQueryRequest(docs_activity = DocsActivityRequest(document_id = id, tz = now.zone)),
            AppQueryRequest(
                docs_drive = DocsDriveRequest(shelf = DocsShelf.DOCS_SHELF_STARRED, limit = RAIL_WINDOW, tz = now.zone),
            ),
        )
    }

    override fun arrived(answers: List<AppQueryResponse>): DocsDocumentEvent {
        val document = answers.firstNotNullOfOrNull { it.docs_document }
            ?: return refused(Reads.refused(NO_ANSWER))
        return DocsDocumentEvent(
            data_ = DocsDocumentEvent.DataArrived(
                data_ = DocsFold.document(
                    document,
                    answers.firstNotNullOfOrNull { it.docs_activity },
                    answers.firstNotNullOfOrNull { it.docs_drive },
                ),
            ),
        )
    }

    override fun refused(failure: ReadFailure): DocsDocumentEvent =
        DocsDocumentEvent(refused = DocsDocumentEvent.ReadRefused(failure = failure))

    override fun denied(denial: AppQueryDenial): DocsDocumentEvent = DocsDocumentEvent(denied = DocsDriveMachine.deniedOf())

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): DocsDocumentEvent =
        DocsDocumentEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))

    private const val NO_ANSWER: String = "The vault answered without the document."
}
