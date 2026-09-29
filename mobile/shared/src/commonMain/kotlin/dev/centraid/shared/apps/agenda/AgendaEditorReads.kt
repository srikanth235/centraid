package dev.centraid.shared.apps.agenda

import centraid.core.v1.AgendaEventRequest
import centraid.core.v1.AgendaPartiesRequest
import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.screen.v1.AgendaEditorEvent
import centraid.screen.v1.AgendaEditorState
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT `agenda.editor` ASKS THE CORE (#1046): `agenda.upcoming` — every
 * calendar, and the core's today and now — and `agenda.parties`, the people
 * an event can invite. An EDIT also reads its event BY ID (`agenda.event`,
 * the detail's own query): a search hit on a repeating event is the series
 * row, keyed by its event id, which no padded window lists (#1047). CREATE
 * with no day reads from the core's own today. A write's answer also reaches
 * the session's [marks] (see [AgendaEventReads]).
 *
 * THE ZONE A READ WAS ASKED IN rides back with its answer: the device's zone
 * is known only here (`requests` is handed the clock), and a timed save
 * states it as `tz` beside the member's wall clock.
 */
public class AgendaEditorReads(
    private val marks: AgendaMarks? = null,
) : ScreenQueries<AgendaEditorScreen, AgendaEditorInput>, ScreenWrites<AgendaEditorScreen, AgendaEditorInput> {
    override val screenId: String = AgendaEditorMachine.SCREEN_ID

    override val tables: Set<String> = AgendaEditorMachine.TABLES

    override val appId: String = "agenda"

    @kotlin.concurrent.Volatile
    private var askedIn: String = ""

    override fun requests(state: AgendaEditorScreen, now: DeviceClock.Reading): List<AppQueryRequest>? {
        askedIn = now.zone
        val screen = state.screen
        val day = screen.day
        val edit = screen.mode == AgendaEditorState.Mode.MODE_EDIT
        // AN EDIT WITH NO EVENT names nothing to read.
        if (edit && screen.event_id.isEmpty()) return null
        val upcoming = if (day.isNotEmpty()) AgendaWrites.around(day, now) ?: return null else AgendaWrites.today(now)
        val event = if (edit) {
            AppQueryRequest(
                agenda_event = AgendaEventRequest(
                    event_id = screen.event_id,
                    instance_key = screen.instance_key,
                    original_start_local = screen.original_start_local ?: "",
                    tz = now.zone,
                ),
            )
        } else {
            null
        }
        return listOfNotNull(
            event,
            AppQueryRequest(agenda_upcoming = upcoming),
            AppQueryRequest(agenda_parties = AgendaPartiesRequest()),
        )
    }

    override fun arrived(answers: List<AppQueryResponse>): AgendaEditorInput = AgendaEditorInput.Answered(
        upcoming = answers.firstNotNullOfOrNull { it.agenda_upcoming },
        parties = answers.firstNotNullOfOrNull { it.agenda_parties },
        zone = askedIn,
        detail = answers.firstNotNullOfOrNull { it.agenda_event },
    )

    override fun refused(failure: ReadFailure): AgendaEditorInput = AgendaEditorInput.View(
        AgendaEditorEvent(refused = AgendaEditorEvent.ReadRefused(failure = failure)),
    )

    override fun denied(denial: AppQueryDenial): AgendaEditorInput = AgendaEditorInput.Denied(denial)

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): AgendaEditorInput {
        val settled = WriteLaw.settledOf(status, sentence, invokeKey)
        marks?.settled(invokeKey, settled.committed, sentence)
        return AgendaEditorInput.View(AgendaEditorEvent(write_settled = settled))
    }
}
