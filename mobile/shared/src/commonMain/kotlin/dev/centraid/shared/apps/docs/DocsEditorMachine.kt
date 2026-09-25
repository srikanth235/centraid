package dev.centraid.shared.apps.docs

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.DocsDocumentRequest
import centraid.screen.v1.Autosave
import centraid.screen.v1.DocsEditorChrome
import centraid.screen.v1.DocsEditorDraft
import centraid.screen.v1.DocsEditorEvent
import centraid.screen.v1.DocsEditorState
import centraid.screen.v1.Loading
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.kit.AutosaveLaw
import dev.centraid.shared.kit.AutosaveLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.dataOf
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * A TEXT DOCUMENT'S EDITOR (#1015 D3: autosave everywhere, close = done; D5:
 * the band is hidden).
 *
 * The kit's [AutosaveLaw] over the title and the body: an edit saves 900 ms
 * later, leaving saves whatever is unsaved, a refused save keeps the words
 * with the sentence over them, and a change from the vault never replaces
 * words being typed. Each save is ONE `core.edit_document`, which mints a new
 * version; once it commits the editor re-reads (the vault's own change event),
 * and `version_label` follows.
 *
 * Only a live text document whose text this vault holds opens here: anything
 * else arrives as a refusal ([DocsFold.editor]) and the editor says why.
 */
public object DocsEditorMachine : ScreenMachine<DocsEditorState, DocsEditorEvent> {
    public const val SCREEN_ID: String = "docs.editor"

    /**
     * What `docs.document` reads. Only `core_document`'s own rows are this
     * subject; the rest re-read through an empty key list, which every local
     * commit sends.
     */
    public val TABLES: Set<String> = DocsDriveMachine.TABLES + "core_entity_revision"

    private const val SUBJECT_TABLE: String = "core_document"

    override fun initial(): DocsEditorState = decorate(
        DocsEditorState(
            loading = Loading(first_load = true),
            autosave = Autosave(phase = Autosave.Phase.PHASE_CLEAN),
        ),
    )

    override fun reduce(state: DocsEditorState, event: DocsEditorEvent): Step<DocsEditorState> {
        val step = step(state, event)
        return Step(decorate(step.state), step.effects)
    }

    override fun rowsChanged(table: String, keys: List<String>): DocsEditorEvent? =
        if (table in TABLES) DocsEditorEvent(rows_changed = DocsEditorEvent.RowsChanged(table = table, ids = keys)) else null

    override fun seatChanged(seat: SeatState): DocsEditorEvent =
        DocsEditorEvent(seat_changed = DocsEditorEvent.SeatChanged(seat = seat))

    override fun ticked(token: String): DocsEditorEvent = DocsEditorEvent(tick = DocsEditorEvent.Ticked(token = token))

    override fun left(): DocsEditorEvent = DocsEditorEvent(left = DocsEditorEvent.Left())

    private fun step(state: DocsEditorState, event: DocsEditorEvent): Step<DocsEditorState> = when {
        event.opened != null -> AutosaveLaw.opened(
            Lens,
            state.copy(document_id = event.opened.document_id, title_hint = event.opened.title, version_label = ""),
        )

        event.refreshed != null -> AutosaveLaw.rowsChanged(Lens, state, emptyList())

        event.data_ != null -> {
            val arrived = event.data_
            val draft = arrived.draft
            when {
                arrived.refusal != null && Lens.dataOf(state) == null ->
                    Step(Lens.with(state, ReadContent.Failed(arrived.refusal)))
                // The document stopped being editable UNDER the words (trashed
                // elsewhere): the words stay; the next save says why it fails.
                arrived.refusal != null || draft == null -> Step(state)
                else -> {
                    val loaded = AutosaveLaw.loaded(Lens, state, draft, arrived.revision)
                    // The version follows the vault only when the words did.
                    val followed = if (Lens.dataOf(loaded.state) == draft && !AutosaveLaw.unsaved(Lens.autosave(loaded.state))) {
                        loaded.state.copy(version_label = arrived.version_label, format = arrived.format)
                    } else {
                        loaded.state
                    }
                    Step(followed, loaded.effects)
                }
            }
        }

        event.refused != null ->
            if (Lens.dataOf(state) != null) {
                // A failed RE-READ keeps the words: the read law and the write
                // law are different laws, and these words may be unsaved.
                Step(state)
            } else {
                Step(Lens.with(state, ReadContent.Failed(event.refused.failure ?: Reads.refused(""))))
            }

        event.rows_changed != null -> {
            val changed = event.rows_changed
            // Another table's keys are not document ids: only an empty list
            // (every local commit) or this document's row is this subject.
            if (changed.table != SUBJECT_TABLE && changed.ids.isNotEmpty()) {
                Step(state)
            } else {
                AutosaveLaw.rowsChanged(Lens, state, changed.ids)
            }
        }

        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

        event.title != null -> AutosaveLaw.edited(Lens, state) { it.copy(title = event.title.title) }

        event.body != null -> AutosaveLaw.edited(Lens, state) { it.copy(body = event.body.body) }

        event.tick != null -> AutosaveLaw.tick(Lens, state, event.tick.token)

        // CLOSE = DONE: whatever is unsaved is saved on the way out.
        event.left != null -> AutosaveLaw.flush(Lens, state)

        event.write_settled != null -> AutosaveLaw.settled(Lens, state, event.write_settled)

        else -> Step(state)
    }

    private fun decorate(state: DocsEditorState): DocsEditorState {
        val a = state.autosave ?: Autosave()
        return state.copy(
            status_label = when (a.phase) {
                Autosave.Phase.PHASE_DIRTY -> DocsCopy.EDITED
                Autosave.Phase.PHASE_SAVING -> DocsCopy.SAVING
                Autosave.Phase.PHASE_SAVED -> DocsCopy.SAVED
                Autosave.Phase.PHASE_REFUSED -> a.failure?.sentence?.ifEmpty { null } ?: DocsCopy.NOT_EDITABLE
                else -> ""
            },
            remote_note = if (a.remote_changed) DocsCopy.REMOTE_CHANGED else "",
            chrome = DocsEditorChrome(
                done = DocsCopy.DONE,
                title_placeholder = DocsCopy.EDITOR_TITLE_PLACEHOLDER,
                body_placeholder = DocsCopy.EDITOR_BODY_PLACEHOLDER,
                loading = DocsCopy.LOADING,
                retry = DocsCopy.RETRY,
            ),
        )
    }

    /** The editor's parts, for the kit's autosave law. */
    internal object Lens : AutosaveLens<DocsEditorState, DocsEditorDraft> {
        override val screenId: String = SCREEN_ID
        override val command: String = DocsWrites.EDIT

        override fun subjectId(state: DocsEditorState): String = state.document_id

        override fun content(state: DocsEditorState): ReadContent<DocsEditorDraft> = when {
            state.draft != null -> ReadContent.Data(state.draft)
            state.failure != null -> ReadContent.Failed(state.failure)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: DocsEditorState, content: ReadContent<DocsEditorDraft>): DocsEditorState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, draft = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, draft = null)
            is ReadContent.Denied -> state.copy(
                loading = null,
                failure = Reads.refused(content.denied.body.ifEmpty { content.denied.title }),
                draft = null,
            )
            is ReadContent.Data -> state.copy(loading = null, failure = null, draft = content.data)
        }

        override fun autosave(state: DocsEditorState): Autosave = state.autosave ?: Autosave()

        override fun withAutosave(state: DocsEditorState, autosave: Autosave): DocsEditorState = state.copy(autosave = autosave)

        override fun baseline(state: DocsEditorState): DocsEditorDraft? = state.baseline

        override fun withBaseline(state: DocsEditorState, baseline: DocsEditorDraft?): DocsEditorState =
            state.copy(baseline = baseline)

        override fun sending(state: DocsEditorState): DocsEditorDraft? = state.sending

        override fun withSending(state: DocsEditorState, sending: DocsEditorDraft?): DocsEditorState =
            state.copy(sending = sending)

        /**
         * `body_text` is REQUIRED by `core.edit_document`, so a change to
         * either field sends the body; the title only when it changed. A
         * blank title is not sent (the schema needs one): the document keeps
         * its name.
         */
        override fun input(state: DocsEditorState, draft: DocsEditorDraft, baseline: DocsEditorDraft?): String? {
            val titleChanged = draft.title.trim() != baseline?.title?.trim() && draft.title.isNotBlank()
            val bodyChanged = draft.body != baseline?.body
            if (!titleChanged && !bodyChanged) return null
            return DocsWrites.edit(state.document_id, draft.body, if (titleChanged) draft.title.trim() else null)
        }

        override fun refusal(state: DocsEditorState, draft: DocsEditorDraft, baseline: DocsEditorDraft?): ReadFailure? = null
    }
}

/** WHAT THE EDITOR READS: the document, for its text and its version. */
public object DocsEditorReads :
    ScreenQueries<DocsEditorState, DocsEditorEvent>,
    ScreenWrites<DocsEditorState, DocsEditorEvent> {
    override val screenId: String = DocsEditorMachine.SCREEN_ID

    override val tables: Set<String> = DocsEditorMachine.TABLES

    override val appId: String = DocsWrites.APP_ID

    override fun requests(state: DocsEditorState, now: DeviceClock.Reading): List<AppQueryRequest>? {
        val id = state.document_id.ifEmpty { return null }
        return listOf(AppQueryRequest(docs_document = DocsDocumentRequest(document_id = id, tz = now.zone)))
    }

    override fun arrived(answers: List<AppQueryResponse>): DocsEditorEvent {
        val document = answers.firstNotNullOfOrNull { it.docs_document }
            ?: return refused(Reads.refused(DocsCopy.GONE))
        return DocsEditorEvent(data_ = DocsFold.editor(document))
    }

    override fun refused(failure: ReadFailure): DocsEditorEvent =
        DocsEditorEvent(refused = DocsEditorEvent.ReadRefused(failure = failure))

    override fun denied(denial: AppQueryDenial): DocsEditorEvent =
        refused(Reads.refused(DocsCopy.DENIED_TITLE))

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): DocsEditorEvent =
        DocsEditorEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))
}
