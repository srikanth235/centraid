package dev.centraid.shared.apps.agenda

import centraid.core.v1.AgendaEventRequest
import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.screen.v1.AgendaEventEvent
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT `agenda.event` ASKS THE CORE, AND HOW ITS WRITES SETTLE (#1046).
 *
 * Two queries: `agenda.event` for the picked occurrence by its key, and
 * `agenda.upcoming` over today ([AgendaWrites.today]) for the calendars it
 * names — the detail answer carries only a `calendar_id`. A write's answer
 * goes to the machine AND to the session's [marks] — on the session's scope,
 * so a cancellation refused after the screen was left is still recorded, and
 * comes back as the parked card.
 */
public class AgendaEventReads(
    private val marks: AgendaMarks? = null,
) : ScreenQueries<AgendaEventScreen, AgendaEventInput>, ScreenWrites<AgendaEventScreen, AgendaEventInput> {
    override val screenId: String = AgendaEventMachine.SCREEN_ID

    override val tables: Set<String> = AgendaEventMachine.TABLES

    override val appId: String = "agenda"

    override fun requests(state: AgendaEventScreen, now: DeviceClock.Reading): List<AppQueryRequest>? {
        val screen = state.screen
        val eventId = screen.event_id.ifEmpty { return null }
        return listOf(
            AppQueryRequest(
                agenda_event = AgendaEventRequest(
                    event_id = eventId,
                    instance_key = screen.instance_key,
                    original_start_local = screen.original_start_local ?: "",
                    tz = now.zone,
                ),
            ),
            AppQueryRequest(agenda_upcoming = AgendaWrites.today(now)),
        )
    }

    override fun arrived(answers: List<AppQueryResponse>): AgendaEventInput = AgendaEventInput.Answered(
        upcoming = answers.firstNotNullOfOrNull { it.agenda_upcoming },
        detail = answers.firstNotNullOfOrNull { it.agenda_event },
    )

    override fun refused(failure: ReadFailure): AgendaEventInput = AgendaEventInput.View(
        AgendaEventEvent(refused = AgendaEventEvent.ReadRefused(failure = failure)),
    )

    override fun denied(denial: AppQueryDenial): AgendaEventInput = AgendaEventInput.Denied(denial)

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): AgendaEventInput {
        val settled = WriteLaw.settledOf(status, sentence, invokeKey)
        marks?.settled(invokeKey, settled.committed, sentence)
        return AgendaEventInput.View(AgendaEventEvent(write_settled = settled))
    }
}
