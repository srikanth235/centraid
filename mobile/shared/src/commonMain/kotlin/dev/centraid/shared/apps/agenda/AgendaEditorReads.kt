package dev.centraid.shared.apps.agenda

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
 * WHAT `agenda.editor` ASKS THE CORE (#1046): `agenda.upcoming` — the
 * occurrence being edited, every calendar, and the core's today and now — and
 * `agenda.parties`, the people an event can invite. CREATE with no day reads
 * from the core's own today. A write's answer also reaches the session's
 * [marks] (see [AgendaEventReads]).
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
        val upcoming = when {
            day.isNotEmpty() -> AgendaWrites.around(day, now) ?: return null
            // AN EDIT WITH NO DAY cannot say where its occurrence is.
            screen.mode == AgendaEditorState.Mode.MODE_EDIT -> return null
            else -> AgendaWrites.today(now)
        }
        return listOf(
            AppQueryRequest(agenda_upcoming = upcoming),
            AppQueryRequest(agenda_parties = AgendaPartiesRequest()),
        )
    }

    override fun arrived(answers: List<AppQueryResponse>): AgendaEditorInput = AgendaEditorInput.Answered(
        upcoming = answers.firstNotNullOfOrNull { it.agenda_upcoming },
        parties = answers.firstNotNullOfOrNull { it.agenda_parties },
        zone = askedIn,
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
