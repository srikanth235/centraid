package dev.centraid.shared.apps.people

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.PeopleTrash
import centraid.core.v1.PeopleTrashRequest
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.TrashListData
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashListState
import centraid.screen.v1.TrashRow
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.kit.ScreenBridge
import dev.centraid.shared.kit.TrashCopy
import dev.centraid.shared.kit.TrashMachine
import dev.centraid.shared.kit.TrashSpec
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * PEOPLE'S TRASH (#1029 app port): the kit's one trash screen, with People as
 * its parameter.
 *
 * `people.trash_person` and `people.restore_person` move a profile in and
 * out, and `people.purge_person` deletes a trashed person forever — the
 * party, the profile and everything that is only theirs (#1015 D1: "Delete
 * forever" wherever an app can destroy). The vault refuses it while money,
 * messages or other lasting records still name them, and that refusal is the
 * core's sentence on the status line. There is no command that empties the
 * whole trash, so no "Empty trash": the purge sweep erases the rest on each
 * row's day.
 */
public val PeopleTrashSpec: TrashSpec = TrashSpec(
    appId = "people",
    table = "people_profile",
    restoreCommand = "people.restore_person",
    purgeCommand = "people.purge_person",
    emptyCommand = null,
    idColumn = "party_id",
    titleColumn = "display_name",
    purgeWindowDays = 30,
    copy = TrashCopy(purgesOn = PeopleCopy.TRASH_ERASES, purgeBody = PeopleCopy.TRASH_PURGE_BODY),
    reReadOnAnyChange = true,
    backLabel = PeopleCopy.APP_TITLE,
)

/**
 * The kit's machine. A `people_profile` change is keyed by `profile_id` and a
 * row here by party, so the spec's [TrashSpec.reReadOnAnyChange] re-reads the
 * whole shelf — otherwise it would not move when someone was trashed or restored.
 */
public val PeopleTrashMachine: TrashMachine = TrashMachine(PeopleTrashSpec)

/**
 * WHAT PEOPLE'S TRASH READS: `people.trash` (the name lives on the party, so
 * the kit's one-table page read cannot say it). One window of 500, most
 * recently trashed first; there is no next page.
 */
public object PeopleTrashReads :
    ScreenQueries<TrashListState, TrashListEvent>,
    ScreenWrites<TrashListState, TrashListEvent> {
    override val screenId: String = "people.trash"

    override val tables: Set<String> = setOf(PeopleTrashSpec.table)

    override val appId: String = "people"

    override fun requests(state: TrashListState, now: DeviceClock.Reading): List<AppQueryRequest> =
        listOf(AppQueryRequest(people_trash = PeopleTrashRequest()))

    override fun arrived(answers: List<AppQueryResponse>): TrashListEvent {
        val trash = answers.firstNotNullOfOrNull { it.people_trash } ?: PeopleTrash()
        return TrashListEvent(
            data_ = TrashListEvent.DataArrived(data_ = TrashListData(rows = trash.people.map(::rowOf)), answered_cursor = ""),
        )
    }

    override fun refused(failure: ReadFailure): TrashListEvent =
        TrashListEvent(refused = TrashListEvent.ReadRefused(failure = failure))

    override fun denied(denial: AppQueryDenial): TrashListEvent =
        TrashListEvent(denied = PeopleFold.denied(denial))

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): TrashListEvent =
        TrashListEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))

    /** `Dana`, `Designer · Erased Mon 12 October`. */
    internal fun rowOf(row: centraid.core.v1.PeopleTrashRow): TrashRow {
        val purge = row.purge_at?.let(PeopleTrashSpec.copy::purgeMeta)
        return TrashRow(
            id = row.party_id,
            title = row.name,
            meta = listOfNotNull(row.role.takeIf { it.isNotBlank() }, purge).joinToString(" · "),
            icon_key = "User",
        )
    }
}

/** What both shells hold for People's trash. Restore sends the kit's `RestoreTapped`. */
public class PeopleTrashBridge : ScreenBridge<TrashListState, TrashListEvent>(
    machine = PeopleTrashMachine,
    events = TrashListEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, PeopleTrashReads, PeopleTrashReads, left = w.left) },
) {
    public fun open() {
        forward(TrashListEvent(opened = TrashListEvent.Opened()))
    }
}
