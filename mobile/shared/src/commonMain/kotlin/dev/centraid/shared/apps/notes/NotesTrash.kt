package dev.centraid.shared.apps.notes

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.NotesRow
import centraid.core.v1.NotesTrashRequest
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.TrashListData
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashListState
import centraid.screen.v1.TrashRow
import dev.centraid.design.copy.NotesCopy
import dev.centraid.shared.kit.ScreenBridge
import dev.centraid.shared.kit.TrashMachine
import dev.centraid.shared.kit.TrashSpec
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * NOTES' TRASH: the kit's one trash screen with Notes' spec (#1015 D1).
 *
 * RESTORE ONLY. The vault has no Notes purge or empty command
 * (`knowledge.*` is nine verbs, none destroys), so the screen offers neither
 * "Delete forever" nor "Empty trash" and the purge sweep erases at 30 days.
 */
public val NotesTrashSpec: TrashSpec = TrashSpec(
    appId = "notes",
    table = "knowledge_note",
    restoreCommand = "knowledge.restore_note",
    purgeCommand = null,
    emptyCommand = null,
    idColumn = "note_id",
    titleColumn = "title",
    purgeWindowDays = 30,
    backLabel = NotesCopy.TITLE,
)

public val NotesTrashMachine: TrashMachine = TrashMachine(NotesTrashSpec)

/**
 * THE TRASH IS READ THROUGH THE CORE'S `notes.trash`, NOT THE PAGE DOOR the
 * kit's `TrashReads` uses: a People-journal entry must never reach the trash
 * (D-1020-N3), and only the core's arm knows the journal marker set.
 */
public object NotesTrashReads :
    ScreenQueries<TrashListState, TrashListEvent>,
    ScreenWrites<TrashListState, TrashListEvent> {
    override val screenId: String = NotesTrashMachine.screenId
    override val tables: Set<String> = setOf(NotesTrashSpec.table)
    override val appId: String = NotesTrashSpec.appId

    override fun requests(state: TrashListState, now: DeviceClock.Reading): List<AppQueryRequest> =
        listOf(AppQueryRequest(notes_trash = NotesTrashRequest(tz = now.zone)))

    /** One answer, at most 200 rows: a first page with no next. */
    override fun arrived(answers: List<AppQueryResponse>): TrashListEvent = TrashListEvent(
        data_ = TrashListEvent.DataArrived(
            data_ = TrashListData(rows = answers.firstNotNullOfOrNull { it.notes_trash }?.notes?.map(::rowOf) ?: emptyList()),
            answered_cursor = "",
        ),
    )

    private fun rowOf(row: NotesRow): TrashRow {
        return TrashRow(
            id = row.note_id,
            title = NotesFold.titleOf(row.title, row.preview),
            meta = NotesTrashSpec.copy.deletedMeta(row.deleted_at ?: ""),
            icon_key = "FileText",
        )
    }

    override fun refused(failure: ReadFailure): TrashListEvent =
        TrashListEvent(refused = TrashListEvent.ReadRefused(failure = failure))

    override fun denied(denial: AppQueryDenial): TrashListEvent = TrashListEvent(denied = NotesBand.denied(denial))

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): TrashListEvent =
        TrashListEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))
}

/** What both shells hold for Notes' trash. */
public class NotesTrashBridge : ScreenBridge<TrashListState, TrashListEvent>(
    machine = NotesTrashMachine,
    events = TrashListEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, NotesTrashReads, NotesTrashReads, left = w.left) },
)
