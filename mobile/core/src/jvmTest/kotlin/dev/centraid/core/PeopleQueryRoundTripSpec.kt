package dev.centraid.core

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.PeoplePerson
import centraid.core.v1.PeoplePersonRequest
import centraid.core.v1.PeopleRoster
import centraid.core.v1.PeopleRosterFilter
import centraid.core.v1.PeopleRosterRequest
import centraid.core.v1.PeopleRosterSort
import centraid.core.v1.PeopleSearch
import centraid.core.v1.PeopleSearchRequest
import centraid.core.v1.PeopleTouch
import centraid.core.v1.PeopleTouchRequest
import centraid.core.v1.PeopleTrash
import centraid.core.v1.PeopleTrashRequest
import dev.centraid.core.AbiRoundTripSpec.Companion.openRealCore
import dev.centraid.core.AbiRoundTripSpec.Companion.shouldBeAnsweredWith
import dev.centraid.core.AgendaQueryRoundTripSpec.Companion.appQuery
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import okio.ByteString.Companion.encodeUtf8

/**
 * PEOPLE'S QUERIES, KOTLIN TO RUST AND BACK (#1046).
 *
 * `people_roster`, `people_touch`, `people_person`, `people_search` and
 * `people_trash` (arms 20–24) run `crates/apps/people`'s folds in the core and
 * answer typed messages — the chips, the cadence facts and every annual date's
 * distance from `today` computed in Rust, because `commonMain` has no calendar.
 *
 * Over JNA, against the real `libcentraid_core_ffi` and the vault
 * `spike-fixture` founded — nothing faked. The writes are `Command` requests,
 * the command plane a screen uses. The fixture vault is shared by every spec in
 * the run, so each assertion is about the people made here and no others.
 */
class PeopleQueryRoundTripSpec : StringSpec({

    "the roster, the sheet, Touch, search and the trash shelf answer typed" {
        val core = openRealCore()
        try {
            val ada = core.write(
                "people.add_person",
                """{"display_name":"Ada Roundtrip","cadence_days":30,"role":"Mentor"}""",
                key = "people-round-trip-ada",
            )
            val gone = core.write(
                "people.add_person",
                """{"display_name":"Gone Roundtrip","cadence_days":0}""",
                key = "people-round-trip-gone",
            )
            core.write(
                "people.star_person",
                """{"party_id":"$ada"}""",
                key = "people-round-trip-star",
            )
            // TOMORROW, in the device's zone: `in_days` is 1 whatever the date.
            val tomorrow = LocalDate.now(ZoneId.of(TZ)).plusDays(1)
            val monthDay = "%02d-%02d".format(tomorrow.monthValue, tomorrow.dayOfMonth)
            core.write(
                "people.add_important_date",
                """{"party_id":"$ada","label":"Birthday","month_day":"$monthDay",""" +
                    """"reminder_on":true}""",
                key = "people-round-trip-birthday",
            )
            core.write(
                "people.log_interaction",
                """{"party_id":"$ada","kind":"call","text":"Caught up"}""",
                key = "people-round-trip-touch",
            )
            core.write(
                "people.trash_person",
                """{"party_id":"$gone"}""",
                key = "people-round-trip-trash",
            )

            // --- the roster ------------------------------------------------
            val roster = core.roster(PeopleRosterFilter.PEOPLE_ROSTER_FILTER_STARRED)
            val row = roster.people.single { it.party_id == ada }
            row.name shouldBe "Ada Roundtrip"
            row.role shouldBe "Mentor"
            row.starred shouldBe true
            row.due shouldBe false
            row.reminders.single().month_day shouldBe monthDay
            // THE DISTANCE IS THE CORE'S, against its own `today`.
            val today = LocalDate.parse(roster.today)
            row.reminders.single().in_days shouldBe
                ChronoUnit.DAYS.between(today, nextOccurrence(today, tomorrow))
            roster.people.map { it.party_id } shouldNotContain gone
            (roster.count_starred >= 1) shouldBe true

            // --- the sheet -------------------------------------------------
            val sheet = core.person(ada).sheet ?: error("Ada has a sheet")
            sheet.person?.party_id shouldBe ada
            sheet.dates.single().label shouldBe "Birthday"
            sheet.touches_known shouldBe true
            sheet.touches.single().text shouldBe "Caught up"
            // A TRASHED PERSON HAS NO SHEET — an absence, not a denial.
            core.person(gone).sheet shouldBe null

            // --- Touch -----------------------------------------------------
            val touch = core.touch()
            touch.today shouldBe roster.today
            touch.upcoming.map { it.person?.party_id } shouldContain ada
            touch.recent.map { it.party_id } shouldContain ada

            // --- search and the shelf --------------------------------------
            core.search("Roundtrip").people.map { it.party_id } shouldBe listOf(ada)
            core.trash().people.map { it.party_id } shouldContain gone

            // --- the refusals ----------------------------------------------
            core.appQuery(
                AppQueryRequest(people_search = PeopleSearchRequest(term = "Ada", limit = 0)),
            ).shouldBeInstanceOf<CoreOutcome.Failed>()
            core.appQuery(
                AppQueryRequest(people_touch = PeopleTouchRequest(tz = "Mars/Olympus_Mons")),
            ).shouldBeInstanceOf<CoreOutcome.Failed>()
        } finally {
            core.close()
        }
    }
}) {
    companion object {
        /** The device's zone, as a shell reads it off the platform and states it. */
        private const val TZ = "America/New_York"

        /** `monthDay`'s next occurrence on or after `today` — the core's rule. */
        private fun nextOccurrence(today: LocalDate, date: LocalDate): LocalDate {
            val thisYear = date.withYear(today.year)
            return if (thisYear.isBefore(today)) thisYear.plusYears(1) else thisYear
        }

        private suspend fun <T> CentraidCore.answer(
            query: AppQueryRequest,
            pick: (centraid.core.v1.AppQueryResponse) -> T?,
        ): T {
            var answer: T? = null
            appQuery(query).shouldBeAnsweredWith { envelope ->
                val response = envelope.response?.app_query ?: error("an AppQueryResponse")
                answer = pick(response) ?: error("the wrong arm: $response")
            }
            return answer!!
        }

        suspend fun CentraidCore.roster(filter: PeopleRosterFilter): PeopleRoster = answer(
            AppQueryRequest(
                people_roster = PeopleRosterRequest(
                    filter = filter,
                    sort = PeopleRosterSort.PEOPLE_ROSTER_SORT_NAME,
                    tz = TZ,
                ),
            ),
        ) { it.people_roster }

        suspend fun CentraidCore.person(partyId: String): PeoplePerson = answer(
            AppQueryRequest(people_person = PeoplePersonRequest(party_id = partyId, tz = TZ)),
        ) { it.people_person }

        suspend fun CentraidCore.touch(): PeopleTouch = answer(
            AppQueryRequest(people_touch = PeopleTouchRequest(tz = TZ)),
        ) { it.people_touch }

        suspend fun CentraidCore.search(term: String): PeopleSearch = answer(
            AppQueryRequest(people_search = PeopleSearchRequest(term = term, limit = 10)),
        ) { it.people_search }

        suspend fun CentraidCore.trash(): PeopleTrash = answer(
            AppQueryRequest(people_trash = PeopleTrashRequest()),
        ) { it.people_trash }

        /** One command through the command plane; answers its `party_id`, if any. */
        suspend fun CentraidCore.write(name: String, input: String, key: String): String {
            var partyId = ""
            call(
                Envelope(
                    request_id = 1,
                    request = centraid.core.v1.Request(
                        command = Command(
                            name = name,
                            input = input.encodeUtf8(),
                            invoke_key = key,
                        ),
                    ),
                ),
            ).shouldBeAnsweredWith { envelope ->
                val outcome = envelope.response?.command ?: error("a CommandOutcome")
                outcome.status shouldBe CommandStatus.COMMAND_STATUS_EXECUTED
                partyId = Regex("\"party_id\":\"([^\"]+)\"")
                    .find(outcome.output.utf8())
                    ?.groupValues
                    ?.get(1)
                    .orEmpty()
            }
            return partyId
        }
    }
}
