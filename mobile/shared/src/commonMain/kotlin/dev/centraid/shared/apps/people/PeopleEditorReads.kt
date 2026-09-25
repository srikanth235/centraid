package dev.centraid.shared.apps.people

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.PeoplePersonRequest
import centraid.core.v1.PeopleSheet
import centraid.screen.v1.PeopleEditorEvent
import centraid.screen.v1.PeopleEditorState
import centraid.screen.v1.PeopleProfileDraft
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT THE PROFILE EDITOR READS (#1029 app port): the person's sheet, of
 * which it keeps the profile fields. A new person that is not yet added reads
 * nothing — there is nothing in the vault to read.
 */
public object PeopleEditorReads :
    ScreenQueries<PeopleEditorState, PeopleEditorEvent>,
    ScreenWrites<PeopleEditorState, PeopleEditorEvent> {
    override val screenId: String = PeopleEditorMachine.SCREEN_ID

    override val tables: Set<String> = PeopleEditorMachine.TABLES

    override val appId: String = "people"

    override fun requests(state: PeopleEditorState, now: DeviceClock.Reading): List<AppQueryRequest>? {
        if (state.party_id.isEmpty() || (state.is_new && !state.created)) return null
        return listOf(AppQueryRequest(people_person = PeoplePersonRequest(party_id = state.party_id, tz = now.zone)))
    }

    override fun arrived(answers: List<AppQueryResponse>): PeopleEditorEvent {
        val person = answers.firstNotNullOfOrNull { it.people_person }
        val sheet = person?.sheet
        return PeopleEditorEvent(
            data_ = PeopleEditorEvent.DataArrived(draft = sheet?.let(::draftOf), absent = sheet == null),
        )
    }

    override fun refused(failure: ReadFailure): PeopleEditorEvent =
        PeopleEditorEvent(refused = PeopleEditorEvent.ReadRefused(failure = failure))

    override fun denied(denial: AppQueryDenial): PeopleEditorEvent =
        PeopleEditorEvent(denied = PeopleFold.denied(denial))

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): PeopleEditorEvent =
        PeopleEditorEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))

    /** The profile's fields as the editor holds them; the hue as a wheel key. */
    public fun draftOf(sheet: PeopleSheet): PeopleProfileDraft {
        val person = sheet.person ?: centraid.core.v1.PeopleRosterRow()
        return PeopleProfileDraft(
            display_name = person.name,
            role = person.role,
            nickname = sheet.nickname,
            met = sheet.met,
            hue_key = PeopleWords.hueKeyOf(person.avatar_color),
            cadence_days = person.cadence_days,
        )
    }
}
