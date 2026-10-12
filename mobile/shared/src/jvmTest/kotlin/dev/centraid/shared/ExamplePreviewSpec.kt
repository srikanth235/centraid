package dev.centraid.shared

import centraid.core.v1.AgendaEvent
import centraid.core.v1.AgendaUpcoming
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandOutcome
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Error
import centraid.core.v1.ErrorCode
import centraid.core.v1.FoundContent
import centraid.core.v1.FoundResponse
import centraid.core.v1.Page
import centraid.core.v1.Response
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.ImportSource
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreConfiguration
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.design.copy.SharedCopy
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.apps.agenda.CalendarImport
import dev.centraid.shared.apps.agenda.PhoneEvent
import dev.centraid.shared.apps.agenda.PhoneSeries
import dev.centraid.shared.apps.people.ContactsImport
import dev.centraid.shared.apps.tasks.PhoneReminder
import dev.centraid.shared.apps.tasks.RemindersImport
import dev.centraid.shared.kit.PhoneImport
import dev.centraid.shared.apps.people.PeopleFold
import dev.centraid.shared.apps.people.PhoneContact
import dev.centraid.shared.custody.VaultSecrets
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.shell.ExamplePreview
import dev.centraid.shared.shell.Shelf
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldStartWith
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import okio.ByteString.Companion.encodeUtf8
import java.io.File
import kotlin.io.path.createTempDirectory

/**
 * ONBOARDING WITHOUT SAMPLE DATA, ON THE SHELF (docs/decisions.md,
 * "Onboarding without sample data").
 *
 * - A fresh install makes ONE vault — the member's, with the teaching starter
 *   rows — and no second "Sample" vault beside it.
 * - "See an example" opens an EPHEMERAL core: under its own directory and never
 *   the vault directory, opened as an example and never keyed, founded with the
 *   example scenario; every screen reads it ([Shelf.core]) while the member's
 *   foreground, roster, keys and pass are untouched.
 * - Leaving it LEAVES NOTHING BEHIND: the vault directory is byte-for-byte what
 *   it was, the example directory is gone, no index was spent.
 * - Contacts → People writes the member's own rows through the command plane.
 *
 * The Rust half — the example core refuses every write and backup door and
 * leaves a member's vault, backup ledger and search index unchanged — is
 * `crates/core/tests/example_preview.rs`. The JVM cannot load the real core
 * here (see `FoundDoorSpec`), so this drives a fake that answers the found and
 * the identify read the way the core does.
 */
class ExamplePreviewSpec : StringSpec({

    /** The public BIP-39 all-`abandon` seed, the demo's. Never anybody's. */
    val seed = "408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf70" +
        "5489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840"

    class Phone {
        val dir: File = createTempDirectory("example-vaults").toFile()
        val tmp: File = createTempDirectory("example-tmp").toFile()
        val exampleDir = File(tmp, ExamplePreview.ROOT_NAME)
        val services = FakePlatformServices()
        val secrets = VaultSecrets(services.secureStore, services.syncedSecrets)
        val opens = mutableListOf<CoreConfiguration>()
        val founds = mutableListOf<FoundContent>()
        val zones = mutableListOf<String>()
        val ids = mutableMapOf<String, String>()
        val names = mutableMapOf<String, String>()
        val closed = mutableListOf<String>()
        var refuseExample = false
        private var minted = 0

        val shelf = Shelf(
            vaultDir = dir.path,
            services = services,
            dispatcher = Dispatchers.Unconfined,
            uiThreadName = "",
            exampleDir = exampleDir.path,
            opener = { configuration ->
                opens += configuration
                val path = configuration.databasePath
                if (configuration.create) File(path).also { it.parentFile.mkdirs(); it.writeText("") }
                CentraidCore.answering(Dispatchers.Unconfined) { asked ->
                        val request = asked.request
                        val found = request?.found
                        when {
                            found != null -> {
                                founds += found.content
                                zones += found.tz
                                if (found.content == FoundContent.FOUND_CONTENT_EXAMPLE && refuseExample) {
                                    Envelope(error = Error(code = ErrorCode.ERROR_CODE_INVALID_REQUEST, sentence = "no"))
                                } else {
                                    minted += 1
                                    val id = "v-$minted"
                                    ids[path] = id
                                    names[path] = found.display_name
                                    Envelope(response = Response(found = FoundResponse(vault_id = id)))
                                }
                            }
                            request?.page != null -> Envelope(
                                response = Response(
                                    page = Page(
                                        rows = ids[path]?.let { id ->
                                            listOf(Row(values = listOf(Value(text = id), Value(text = names[path].orEmpty()))))
                                        }.orEmpty(),
                                    ),
                                ),
                            )
                            else -> Envelope(response = Response())
                        }
                }
            },
        )

        /** Every file under the vault directory, with its bytes: what "unchanged" means. */
        fun vaultTree(): Map<String, String> = dir.walkTopDown().filter { it.isFile }
            .associate { it.relativeTo(dir).path to it.readText() }

        fun exampleDirectories(): List<String> = exampleDir.listFiles().orEmpty().map { it.name }
    }

    "a fresh install makes one vault, the member's, with the teaching starters, and no sample beside it" {
        runTest {
            val phone = Phone()
            phone.shelf.load()
            phone.shelf.holdsNoVault.value shouldBe true
            phone.shelf.found(starters = true).shouldBeInstanceOf<Shelf.FoundOutcome.Founded>()
            phone.founds shouldBe listOf(FoundContent.FOUND_CONTENT_STARTERS)
            // THE DEVICE'S ZONE RIDES THE FOUND, so the starter tasks are due today.
            phone.zones shouldBe listOf(phone.services.clock.read().zone)
            phone.shelf.all() shouldHaveSize 1
            phone.shelf.roster.value.map { it.example } shouldBe listOf(false)
            phone.dir.listFiles().orEmpty().filter { it.isDirectory } shouldHaveSize 1
            phone.exampleDirectories().shouldBeEmpty()
        }
    }

    "see an example opens an unkeyed example core outside the vault directory, and every screen reads it" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seed)
            phone.shelf.load()
            val own = (phone.shelf.found(starters = true) as Shelf.FoundOutcome.Founded).holding
            own.keyed.shouldBeTrue()
            val memberCore = phone.shelf.core().shouldNotBeNull()
            val indexBefore = phone.secrets.nextVaultIndex()

            phone.shelf.openExample().shouldBeTrue()

            val open = phone.opens.last()
            // AN EXAMPLE, NEVER KEYED, NEVER UNDER THE VAULT DIRECTORY.
            open.example.shouldBeTrue()
            open.vaultSeedHex.shouldBeNull()
            open.create.shouldBeTrue()
            open.databasePath shouldStartWith phone.exampleDir.path
            File(open.databasePath).startsWith(phone.dir).shouldBeFalse()
            phone.founds.last() shouldBe FoundContent.FOUND_CONTENT_EXAMPLE
            // EVERY SCREEN READS IT, AND THE MEMBER'S PLACE IS UNMOVED.
            phone.shelf.core() shouldNotBe memberCore
            phone.shelf.memberCore() shouldBe memberCore
            phone.shelf.foreground shouldBe own.vaultId
            phone.shelf.all().map { it.vaultId } shouldBe listOf(own.vaultId)
            phone.shelf.roster.value.map { it.vault_id } shouldBe listOf(own.vaultId)
            phone.shelf.previewing.value.shouldBeTrue()
            phone.shelf.exampleLockup().shouldNotBeNull().let {
                it.example.shouldBeTrue()
                it.vault_name shouldBe SharedCopy.EXAMPLE_NAME
            }
            // A WRITE IS REFUSED WITH THE EXAMPLE'S SENTENCE, before the core is asked.
            phone.shelf.readOnlySentence() shouldBe Shelf.EXAMPLE_SENTENCE
            // NO INDEX WAS SPENT ON IT.
            phone.secrets.nextVaultIndex() shouldBe indexBefore
        }
    }

    "leaving the example leaves nothing behind: the vault directory is byte-for-byte what it was" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seed)
            phone.shelf.load()
            phone.shelf.found(starters = true)
            val before = phone.vaultTree()
            val memberCore = phone.shelf.core()

            phone.shelf.openExample().shouldBeTrue()
            phone.exampleDirectories() shouldHaveSize 1
            phone.shelf.closeExample()

            phone.vaultTree() shouldBe before
            phone.exampleDirectories().shouldBeEmpty()
            phone.shelf.previewing.value.shouldBeFalse()
            phone.shelf.core() shouldBe memberCore
            phone.shelf.readOnlySentence().shouldBeNull()
            phone.shelf.all() shouldHaveSize 1
        }
    }

    "an example the core refused leaves no directory and the member's vault in front" {
        runTest {
            val phone = Phone()
            phone.shelf.load()
            phone.shelf.found(starters = true)
            val memberCore = phone.shelf.core()
            phone.refuseExample = true
            phone.shelf.openExample().shouldBeFalse()
            phone.exampleDirectories().shouldBeEmpty()
            phone.shelf.previewing.value.shouldBeFalse()
            phone.shelf.core() shouldBe memberCore
        }
    }

    "a launch sweeps what a process killed mid-preview left" {
        runTest {
            val phone = Phone()
            File(phone.exampleDir, "example-dead").also { it.mkdirs() }.resolve(Shelf.VAULT_FILE).writeText("x")
            phone.shelf.load()
            phone.exampleDirectories().shouldBeEmpty()
            phone.shelf.all().shouldBeEmpty()
        }
    }

    "a change to the shelf ends a preview: a found, a switch and a forget each close it" {
        runTest {
            val phone = Phone()
            phone.shelf.load()
            val first = (phone.shelf.found() as Shelf.FoundOutcome.Founded).holding
            phone.shelf.openExample().shouldBeTrue()
            val second = (phone.shelf.found() as Shelf.FoundOutcome.Founded).holding
            phone.shelf.previewing.value.shouldBeFalse()
            phone.exampleDirectories().shouldBeEmpty()

            phone.shelf.openExample().shouldBeTrue()
            phone.shelf.bringToFront(first.vaultId).shouldNotBeNull()
            phone.shelf.previewing.value.shouldBeFalse()
            phone.shelf.core() shouldBe first.core

            phone.shelf.openExample().shouldBeTrue()
            phone.shelf.forget(second.vaultId)
            phone.shelf.previewing.value.shouldBeFalse()
            phone.exampleDirectories().shouldBeEmpty()
        }
    }

    "the words are the owner's: a link, a banner with its one exit, and a refusal" {
        SharedCopy.SEE_EXAMPLE shouldBe "See an example"
        SharedCopy.EXAMPLE_BANNER shouldBe "Example — not your data"
        SharedCopy.EXAMPLE_DONE shouldBe "Done"
        Shelf.EXAMPLE_SENTENCE shouldBe SharedCopy.EXAMPLE_READ_ONLY
    }

    // --- Contacts → People ---------------------------------------------------

    "people's day one offers the example and the phone's contacts; a chip with nobody in it offers neither" {
        PeopleFold.dayOne().let {
            it.offers_example.shouldBeTrue()
            it.import_source shouldBe ImportSource.IMPORT_SOURCE_CONTACTS
        }
        PeopleFold.chipEmpty().let {
            it.offers_example.shouldBeFalse()
            it.import_source shouldBe ImportSource.IMPORT_SOURCE_UNSPECIFIED
        }
    }

    "an address book folds to one person per name, trimmed, with a real birthday or none" {
        val people = ContactsImport.people(
            listOf(
                PhoneContact(name = " Maya Chen ", phones = listOf("+1 555 0100", "+1 555 0100", " "), emails = listOf("m@x.org", "M@X.org")),
                PhoneContact(name = "maya chen", phones = listOf("+1 555 0199")),
                PhoneContact(name = "   "),
                PhoneContact(name = "Ray", birthday = "02-30"),
                PhoneContact(name = "Jake", birthday = "13-01"),
            ),
        )
        people.map { it.name } shouldBe listOf("Maya Chen", "Ray", "Jake")
        people[0].phones shouldBe listOf("+1 555 0100")
        people[0].emails shouldBe listOf("m@x.org")
        // THE SHAPE IS CHECKED HERE; WHETHER FEBRUARY 30 EXISTS IS THE COLUMN'S.
        people[1].birthday shouldBe "02-30"
        people[2].birthday shouldBe ""
    }

    "an import writes each person, then their channels and birthday, under the id it minted" {
        runTest {
            val asked = mutableListOf<Pair<String, String>>()
            val core = CentraidCore.answering(Dispatchers.Unconfined) { envelope ->
                val command = envelope.request?.command
                if (command == null) {
                    Envelope(response = Response())
                } else {
                    val input = command.input.utf8()
                    // THE CORE REFUSES A COMMAND WITH NO KEY (`api::invoke`).
                    command.invoke_key.isNotEmpty() shouldBe true
                    asked += command.name to input
                    val refused = command.name == "people.add_person" && input.contains("Refused")
                    Envelope(
                        response = Response(
                            command = CommandOutcome(
                                status = if (refused) CommandStatus.COMMAND_STATUS_DENIED else CommandStatus.COMMAND_STATUS_EXECUTED,
                            ),
                        ),
                    )
                }
            }
            var n = 0
            val outcome = ContactsImport.run(
                core,
                listOf(
                    PhoneContact(name = "Maya", phones = listOf("+1 555 0100"), emails = listOf("maya@example.org"), birthday = "04-12"),
                    PhoneContact(name = "Refused \"Quote\"", phones = listOf("+1 555 0101")),
                ),
                mintId = { "p-${++n}" },
            )
            outcome shouldBe ContactsImport.Outcome(added = 1, refused = 1)
            asked.map { it.first } shouldBe listOf(
                "people.add_person",
                "people.save_contact_channel",
                "people.save_contact_channel",
                "people.add_important_date",
                "people.add_person",
            )
            asked[0].second shouldBe "{\"party_id\":\"p-1\",\"display_name\":\"Maya\",\"cadence_days\":0}"
            asked[1].second shouldBe "{\"party_id\":\"p-1\",\"kind\":\"phone\",\"value\":\"+1 555 0100\"}"
            asked[3].second shouldBe "{\"party_id\":\"p-1\",\"label\":\"Birthday\",\"month_day\":\"04-12\"}"
            // A QUOTE IN A NAME IS ESCAPED, never a broken input.
            asked[4].second shouldBe "{\"party_id\":\"p-2\",\"display_name\":\"Refused \\\"Quote\\\"\",\"cadence_days\":0}"
            ContactsImport.sentence(outcome) shouldBe PeopleCopy.IMPORT_CONTACTS_ONE
            ContactsImport.sentence(ContactsImport.Outcome(added = 12, refused = 0)) shouldBe "12 people imported"
            ContactsImport.sentence(ContactsImport.Outcome(added = 0, refused = 0)) shouldBe PeopleCopy.IMPORT_CONTACTS_NONE
            // NOTHING LANDED IS A FAILURE, never "0 people imported".
            ContactsImport.sentence(ContactsImport.Outcome(added = 0, refused = 3)) shouldBe PeopleCopy.IMPORT_CONTACTS_FAILED
        }
    }

    // --- Calendar → Agenda, Reminders → Tasks -------------------------------

    "an event keeps the calendar's availability, and a busy one that collides is kept as free" {
        runTest {
            val asked = mutableListOf<Pair<String, String>>()
            val core = CentraidCore.answering(Dispatchers.Unconfined) { envelope ->
                val request = envelope.request
                when {
                    request?.page != null -> Envelope(
                        response = Response(page = Page(rows = listOf(Row(values = listOf(Value(text = "cal-1")))))),
                    )
                    request?.command != null -> {
                        val command = request.command!!
                        val input = command.input.utf8()
                        command.invoke_key.isNotEmpty() shouldBe true
                        asked += command.name to input
                        // THE CORE REFUSES A BUSY OVERLAP; a free one lands.
                        val refused = input.contains("Overlap") && input.contains("\"busy\":\"busy\"")
                        Envelope(
                            response = Response(
                                command = CommandOutcome(
                                    status = if (refused) CommandStatus.COMMAND_STATUS_DENIED else CommandStatus.COMMAND_STATUS_EXECUTED,
                                ),
                            ),
                        )
                    }
                    else -> Envelope(response = Response())
                }
            }
            val outcome = CalendarImport.run(
                core,
                listOf(
                    PhoneEvent(title = "Standup", start = "2026-10-12T09:00:00", end = "2026-10-12T09:30:00", tz = "America/New_York"),
                    PhoneEvent(title = "Standup", start = "2026-10-12T09:00:00", end = "2026-10-12T09:30:00", tz = "America/New_York"),
                    PhoneEvent(title = "Overlap", start = "2026-10-12T09:15:00", end = "2026-10-12T10:00:00"),
                    PhoneEvent(title = "Holiday", allDay = true, start = "2026-10-13", end = "2026-10-13", free = true),
                    PhoneEvent(title = "  ", start = "2026-10-14T09:00:00", end = "2026-10-14T10:00:00"),
                ),
                deviceTz = "Europe/London",
                now = NOW,
            )
            outcome shouldBe PhoneImport.Outcome(added = 3, refused = 0)
            asked.map { it.second } shouldBe listOf(
                "{\"summary\":\"Standup\",\"calendar_id\":\"cal-1\",\"dtstart\":\"2026-10-12T09:00:00\",\"dtend\":\"2026-10-12T09:30:00\",\"busy\":\"busy\",\"tz\":\"America/New_York\"}",
                // NO ZONE OF ITS OWN IS THE DEVICE'S; REFUSED BUSY, KEPT FREE.
                "{\"summary\":\"Overlap\",\"calendar_id\":\"cal-1\",\"dtstart\":\"2026-10-12T09:15:00\",\"dtend\":\"2026-10-12T10:00:00\",\"busy\":\"busy\",\"tz\":\"Europe/London\"}",
                "{\"summary\":\"Overlap\",\"calendar_id\":\"cal-1\",\"dtstart\":\"2026-10-12T09:15:00\",\"dtend\":\"2026-10-12T10:00:00\",\"busy\":\"free\",\"tz\":\"Europe/London\"}",
                "{\"summary\":\"Holiday\",\"calendar_id\":\"cal-1\",\"dtstart\":\"2026-10-13\",\"dtend\":\"2026-10-13\",\"busy\":\"free\",\"recurrence_semantics\":\"all-day\"}",
            )
            asked.all { it.first == "schedule.propose_event" } shouldBe true
            CalendarImport.sentence(outcome) shouldBe "3 events imported"
            CalendarImport.sentence(PhoneImport.Outcome(added = 0, refused = 2)) shouldBe AgendaCopy.IMPORT_CALENDAR_FAILED
            CalendarImport.sentence(PhoneImport.Outcome(added = 0, refused = 0)) shouldBe AgendaCopy.IMPORT_CALENDAR_NONE
        }
    }

    "a repeating series stays one series, its cancelled and moved occurrences its exceptions" {
        runTest {
            val asked = mutableListOf<Pair<String, String>>()
            // THE VAULT'S EXPANSION of the Monday series over the window:
            // every Monday from 5 October to 7 December, at 09:00 in New York.
            val mondays = listOf("10-05", "10-12", "10-19", "10-26", "11-02", "11-09", "11-16", "11-23", "11-30", "12-07")
                .map { "2026-$it" + "T09:00:00" }
            val core = CentraidCore.answering(Dispatchers.Unconfined) { envelope ->
                val request = envelope.request
                when {
                    request?.page != null -> Envelope(
                        response = Response(page = Page(rows = listOf(Row(values = listOf(Value(text = "cal-1")))))),
                    )
                    request?.app_query?.agenda_upcoming != null -> Envelope(
                        response = Response(
                            app_query = AppQueryResponse(
                                agenda_upcoming = AgendaUpcoming(
                                    events = mondays.map { AgendaEvent(event_id = "ev-1", dtstart = it, original_start_local = it) } +
                                        AgendaEvent(event_id = "ev-other", dtstart = "2026-10-20T09:00:00", original_start_local = "2026-10-20T09:00:00"),
                                ),
                            ),
                        ),
                    )
                    request?.command != null -> {
                        val command = request.command!!
                        val input = command.input.utf8()
                        asked += command.name to input
                        // THE VAULT REFUSES A RULE IT CANNOT HONOUR (`rrule.rs`).
                        val refused = input.contains("BYSETPOS")
                        Envelope(
                            response = Response(
                                command = CommandOutcome(
                                    status = if (refused) CommandStatus.COMMAND_STATUS_DENIED else CommandStatus.COMMAND_STATUS_EXECUTED,
                                    output = "{\"event_id\":\"ev-1\",\"attendees\":0}".encodeUtf8(),
                                ),
                            ),
                        )
                    }
                    else -> Envelope(response = Response())
                }
            }
            val standup = PhoneSeries(
                id = "series-1",
                rrule = "FREQ=WEEKLY;BYDAY=MO;WKST=MO",
                start = "2026-09-07T09:00:00",
                end = "2026-09-07T09:30:00",
            )
            fun monday(day: String) = PhoneEvent(
                title = "Standup",
                start = "2026-${day}T09:00:00",
                end = "2026-${day}T09:30:00",
                tz = "America/New_York",
                series = standup,
            )
            // 19 OCTOBER WAS CANCELLED ON THE PHONE; 12 OCTOBER WAS MOVED TO 10:00 AND RENAMED.
            val shown = mondays.map { it.substring(5, 10) }.filter { it != "10-19" && it != "10-12" }.map(::monday) +
                monday("10-12").copy(
                    title = "Standup (late)",
                    start = "2026-10-12T10:00:00",
                    end = "2026-10-12T10:30:00",
                    originalStart = "2026-10-12T09:00:00",
                    moved = true,
                )
            val lastFriday = PhoneSeries(id = "series-2", rrule = "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1", start = "2026-09-25T17:00:00", end = "2026-09-25T18:00:00")
            val drinks = listOf("10-30", "11-27").map {
                PhoneEvent(title = "Drinks", start = "2026-${it}T17:00:00", end = "2026-${it}T18:00:00", tz = "Europe/London", series = lastFriday)
            }
            val outcome = CalendarImport.run(core, shown + drinks, deviceTz = "Europe/London", now = NOW)
            outcome shouldBe PhoneImport.Outcome(added = 3, refused = 0)
            asked.map { it.second } shouldBe listOf(
                // ONE SERIES, its rule kept and its own first occurrence its start.
                "{\"summary\":\"Standup\",\"calendar_id\":\"cal-1\",\"dtstart\":\"2026-09-07T09:00:00\",\"dtend\":\"2026-09-07T09:30:00\",\"busy\":\"busy\",\"tz\":\"America/New_York\",\"rrule\":\"FREQ=WEEKLY;BYDAY=MO\"}",
                "{\"event_id\":\"ev-1\",\"original_start_local\":\"2026-10-19T09:00:00\",\"scope\":\"occurrence\",\"action\":\"skip\"}",
                "{\"event_id\":\"ev-1\",\"original_start_local\":\"2026-10-12T09:00:00\",\"scope\":\"occurrence\",\"action\":\"override\"," +
                    "\"dtstart\":\"2026-10-12T10:00:00\",\"dtend\":\"2026-10-12T10:30:00\",\"tz\":\"America/New_York\",\"summary\":\"Standup (late)\"}",
                // A REFUSED RULE FALLS BACK TO ITS OCCURRENCES, each its own event.
                "{\"summary\":\"Drinks\",\"calendar_id\":\"cal-1\",\"dtstart\":\"2026-09-25T17:00:00\",\"dtend\":\"2026-09-25T18:00:00\",\"busy\":\"busy\",\"tz\":\"Europe/London\",\"rrule\":\"FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1\"}",
                "{\"summary\":\"Drinks\",\"calendar_id\":\"cal-1\",\"dtstart\":\"2026-09-25T17:00:00\",\"dtend\":\"2026-09-25T18:00:00\",\"busy\":\"free\",\"tz\":\"Europe/London\",\"rrule\":\"FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1\"}",
                "{\"summary\":\"Drinks\",\"calendar_id\":\"cal-1\",\"dtstart\":\"2026-10-30T17:00:00\",\"dtend\":\"2026-10-30T18:00:00\",\"busy\":\"busy\",\"tz\":\"Europe/London\"}",
                "{\"summary\":\"Drinks\",\"calendar_id\":\"cal-1\",\"dtstart\":\"2026-11-27T17:00:00\",\"dtend\":\"2026-11-27T18:00:00\",\"busy\":\"busy\",\"tz\":\"Europe/London\"}",
            )
        }
    }

    "an occurrence the vault does not expand is kept as its own event, and no skip is written at the window's edge" {
        val series = CalendarImport.Series(
            event = PhoneEvent(title = "Yoga", start = "2026-09-01T07:00:00", end = "2026-09-01T08:00:00", tz = "Europe/London"),
            rrule = "FREQ=DAILY",
            occurrences = listOf(
                PhoneEvent(title = "Yoga", start = "2026-10-10T07:00:00", end = "2026-10-10T08:00:00", tz = "Europe/London"),
                PhoneEvent(title = "Yoga", start = "2026-10-11T07:00:00", end = "2026-10-11T08:00:00", tz = "Europe/London"),
            ),
        )
        // THE WINDOW IS 2 OCTOBER TO 10 DECEMBER; its first and last days are margin.
        val upcoming = listOf("2026-10-02T07:00:00", "2026-10-10T07:00:00", "2026-12-10T07:00:00").associateBy { it }
        CalendarImport.reconcile(series, "ev-1", upcoming, NOW, "Europe/London").shouldBeEmpty()
        CalendarImport.strays(series, upcoming, NOW).map { it.start } shouldBe listOf("2026-10-11T07:00:00")
    }

    "a moved occurrence keeps the series' zone, and one moved in from past the window is an override, not a stray" {
        val floating = PhoneSeries(id = "s", rrule = "FREQ=WEEKLY", start = "2026-09-07T09:00:00", end = "2026-09-07T09:30:00")
        val series = CalendarImport.Series(
            event = PhoneEvent(title = "Standup", start = "2026-09-07T09:00:00", end = "2026-09-07T09:30:00"),
            rrule = "FREQ=WEEKLY",
            occurrences = listOf(
                // NO ZONE OF ITS OWN: the series was proposed in the device's.
                PhoneEvent(
                    title = "Standup", start = "2026-10-12T11:00:00", end = "2026-10-12T11:30:00",
                    series = floating, originalStart = "2026-10-12T09:00:00", moved = true,
                ),
                // MOVED IN FROM 14 DECEMBER, past the window's end.
                PhoneEvent(
                    title = "Standup", start = "2026-12-01T09:00:00", end = "2026-12-01T09:30:00",
                    series = floating, originalStart = "2026-12-14T09:00:00", moved = true,
                ),
            ),
        )
        val upcoming = mapOf("2026-10-12T09:00:00" to "2026-10-12T09:00:00")
        val writes = CalendarImport.reconcile(series, "ev-1", upcoming, NOW, "Asia/Kolkata")
        writes.map { it.input } shouldBe listOf(
            "{\"event_id\":\"ev-1\",\"original_start_local\":\"2026-10-12T09:00:00\",\"scope\":\"occurrence\",\"action\":\"override\"," +
                "\"dtstart\":\"2026-10-12T11:00:00\",\"dtend\":\"2026-10-12T11:30:00\",\"tz\":\"Asia/Kolkata\"}",
            "{\"event_id\":\"ev-1\",\"original_start_local\":\"2026-12-14T09:00:00\",\"scope\":\"occurrence\",\"action\":\"override\"," +
                "\"dtstart\":\"2026-12-01T09:00:00\",\"dtend\":\"2026-12-01T09:30:00\",\"tz\":\"Asia/Kolkata\"}",
        )
        // A REFUSED OVERRIDE KEEPS THE MOVED OCCURRENCE AS ITS OWN EVENT.
        writes.map { it.fallback?.start } shouldBe listOf("2026-10-12T11:00:00", "2026-12-01T09:00:00")
        CalendarImport.strays(series, upcoming, NOW).shouldBeEmpty()
    }

    "a series whose expansion cannot be read writes nothing beyond the series" {
        runTest {
            val asked = mutableListOf<String>()
            val core = CentraidCore.answering(Dispatchers.Unconfined) { envelope ->
                val request = envelope.request
                when {
                    request?.page != null -> Envelope(
                        response = Response(page = Page(rows = listOf(Row(values = listOf(Value(text = "cal-1")))))),
                    )
                    request?.command != null -> {
                        asked += request.command!!.name
                        Envelope(
                            response = Response(
                                command = CommandOutcome(
                                    status = CommandStatus.COMMAND_STATUS_EXECUTED,
                                    output = "{\"event_id\":\"ev-1\"}".encodeUtf8(),
                                ),
                            ),
                        )
                    }
                    // THE READ FAILS: no answer at all.
                    else -> Envelope(response = Response())
                }
            }
            val weekly = PhoneSeries(id = "s", rrule = "FREQ=WEEKLY", start = "2026-09-07T09:00:00", end = "2026-09-07T09:30:00")
            val occurrences = listOf("10-12", "10-19").map {
                PhoneEvent(title = "Standup", start = "2026-${it}T09:00:00", end = "2026-${it}T09:30:00", tz = "Europe/London", series = weekly)
            }
            CalendarImport.run(core, occurrences, deviceTz = "Europe/London", now = NOW) shouldBe PhoneImport.Outcome(added = 1, refused = 0)
            asked shouldBe listOf("schedule.propose_event")
        }
    }

    "a rule loses only the parts that restate its anchor" {
        CalendarImport.rule("RRULE:FREQ=MONTHLY;BYMONTHDAY=7", "2026-09-07T09:00:00") shouldBe "FREQ=MONTHLY"
        CalendarImport.rule("FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=7;", "2026-09-07") shouldBe "FREQ=YEARLY"
        CalendarImport.rule("FREQ=MONTHLY;BYMONTHDAY=8", "2026-09-07") shouldBe "FREQ=MONTHLY;BYMONTHDAY=8"
        CalendarImport.rule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", "2026-09-07") shouldBe "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"
        CalendarImport.rule("", "2026-09-07") shouldBe ""
        // A WKST THAT MOVES NO DAY GOES; one that does stays, for the vault to judge.
        CalendarImport.rule("FREQ=WEEKLY;WKST=MO", "2026-09-07") shouldBe "FREQ=WEEKLY"
        CalendarImport.rule("FREQ=WEEKLY;INTERVAL=2;WKST=MO", "2026-09-07") shouldBe "FREQ=WEEKLY;INTERVAL=2"
        CalendarImport.rule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=MO", "2026-09-07") shouldBe "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=MO"
    }

    "a reminder becomes a task with its notes and due day, one per title and day" {
        val folded = RemindersImport.reminders(
            listOf(
                PhoneReminder(title = " Call the bank ", notes = "about the card", due = "2026-10-12"),
                PhoneReminder(title = "call the bank", due = "2026-10-12"),
                PhoneReminder(title = "Water the plants", due = "someday"),
                PhoneReminder(title = ""),
            ),
        )
        folded.map { it.title } shouldBe listOf("Call the bank", "Water the plants")
        RemindersImport.input(folded[0]) shouldBe
            "{\"title\":\"Call the bank\",\"description\":\"about the card\",\"due_at\":\"2026-10-12\"}"
        RemindersImport.input(folded[1]) shouldBe "{\"title\":\"Water the plants\"}"
        RemindersImport.sentence(PhoneImport.Outcome(added = 1, refused = 0)) shouldBe TasksCopy.IMPORT_REMINDERS_ONE
        RemindersImport.sentence(PhoneImport.Outcome(added = 0, refused = 1)) shouldBe TasksCopy.IMPORT_REMINDERS_FAILED
    }
})

/** 9 October 2026, 12:00 UTC: the import window is 2 October to 10 December. */
private const val NOW: Long = 1_791_547_200_000
