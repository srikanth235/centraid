package dev.centraid.shared

import dev.centraid.shared.apps.agenda.CalendarImport
import dev.centraid.shared.apps.agenda.PhoneEvent
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.sync.phone.PhoneDevice
import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneFingerprint
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneRecord
import dev.centraid.shared.sync.phone.PhoneReport
import dev.centraid.shared.sync.phone.PhoneSnapshot
import dev.centraid.shared.sync.phone.PhoneSync
import dev.centraid.shared.sync.phone.PhoneSource
import dev.centraid.shared.sync.phone.PhoneSyncPlanner
import dev.centraid.shared.sync.phone.StoredLink
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe

/**
 * A VAULT RESTORED ONTO A NEW PHONE (#1129, F-K-1), for the engine's sources (Agenda's, and the
 * person-shaped records the engine's own tests use); Docs' and Health's are in `FilesFollowSpec` and
 * `HealthFollowSpec`. People's is the vault's merge: `crates/vault/tests/people.rs`. Device A makes the links; device B, holding the
 * same records under its own `local:` ids, re-finds every one by its match key, one to one:
 * nothing is added twice, nothing is trashed, and no question is asked. A record of A that B does
 * not hold is forgotten and its row kept; a match key two records share is not guessed at.
 */
class NewPhoneSpec : StringSpec({
    val readAt = "2026-10-20T10:00:00.000Z"
    val later = "2026-10-21T10:00:00.000Z"

    // A person-shaped record, as the engine is handed one: a name, its numbers, an origin. (People itself
    // no longer goes through the engine: the vault merges a followed contact, #1135.)
    fun contact(name: String, id: String, vararg phones: String, origin: String = "") = PhoneRecord(
        phoneId = id,
        origin = origin.ifEmpty { "local:this-phone" },
        fields = PhoneFields.of {
            text("name", name)
            phones("phones", phones.toList())
        },
        matchKey = name.lowercase(),
        tiebreak = phones.map(PhoneFields::phoneNumber).toSet(),
    )

    suspend fun FakeStore.contacts(at: String, vararg records: PhoneRecord, complete: Boolean = true): PhoneReport {
        now = at.replace("10:00:00.000Z", "23:59:59.000Z")
        val origins = records.map { PhoneOriginRef(it.origin, it.origin) }.distinctBy { it.id }
        return PhoneSync.run(this, PhoneSnapshot(PhoneSource.CONTACTS, complete, at, origins, records.toList()))
    }

    val names = listOf("Ada Lovelace", "Bo Diddley", "Cy Twombly", "Di Fossey", "Ed Hopper", "Flo Jo")

    "people-shaped records: device B re-finds all six of device A's people under its own ids, and adds, trashes and asks nothing" {
        val store = FakeStore(PhoneSource.CONTACTS).apply { device = "device-a" }
        store.contacts(readAt, *names.mapIndexed { i, n -> contact(n, "local:a$i", "555010$i") }.toTypedArray())
        val rows = store.rows.keys.toSet()
        store.links.values.map { it.deviceId }.toSet() shouldBe setOf("device-a")

        // THE RESTORE: the vault comes back on device B, whose address book names the same people its own way.
        store.device = "device-b"
        store.writes.clear()
        val outcome = store.contacts(later, *names.mapIndexed { i, n -> contact(n, "local:b$i", "555010$i") }.toTypedArray())
        outcome.added shouldBe 0
        outcome.trashed shouldBe 0
        outcome.gone.shouldBeEmpty()
        store.rows.keys shouldBe rows
        store.rows.values.none { it.trashed } shouldBe true
        store.links.values.map { it.phoneId }.sorted() shouldContainExactly names.indices.map { "local:b$it" }
        store.links.values.map { it.deviceId }.toSet() shouldBe setOf("device-b")
        store.writes.count { it == "relink" } shouldBe 6
        store.writes.none { it == "add" || it == "trash" || it == "forget" } shouldBe true
        // The origin is B's now, and the next pass on B is quiet.
        store.origins.values.single().deviceId shouldBe "device-b"
        store.writes.clear()
        store.contacts(later, *names.mapIndexed { i, n -> contact(n, "local:b$i", "555010$i") }.toTypedArray())
        store.writes.filter { it != "touch" }.shouldBeEmpty()
    }

    "people-shaped records: before, a restore with the same ids under another device read as six deletes" {
        // The same shape with no device on either side is #1127's: the old links are lost here and the new records added.
        val store = FakeStore(PhoneSource.CONTACTS)
        store.contacts(readAt, *names.mapIndexed { i, n -> contact(n, "local:a$i") }.toTypedArray())
        val outcome = store.contacts(later, *names.mapIndexed { i, n -> contact(n, "local:b$i") }.toTypedArray())
        outcome.added shouldBe 6
        outcome.gone.single().count shouldBe 6
    }

    "people-shaped records: a person of device A that device B does not hold is forgotten, kept and never trashed or asked about" {
        val store = FakeStore(PhoneSource.CONTACTS).apply { device = "device-a" }
        store.contacts(readAt, contact("Ada Lovelace", "local:a1"), contact("Bo Diddley", "local:a2"))
        val bo = store.links.values.single { it.phoneId == "local:a2" }.entityId!!
        store.device = "device-b"
        store.writes.clear()
        val outcome = store.contacts(later, contact("Ada Lovelace", "local:b1"))
        outcome.trashed shouldBe 0
        outcome.added shouldBe 0
        outcome.gone.shouldBeEmpty()
        store.rows.getValue(bo).trashed shouldBe false
        store.links.values.none { it.entityId == bo } shouldBe true
        store.writes.count { it == "forget" } shouldBe 1
        store.writes.none { it == "trash" } shouldBe true
    }

    "people-shaped records: an incomplete read on device B re-finds what it sees and forgets nothing" {
        val store = FakeStore(PhoneSource.CONTACTS).apply { device = "device-a" }
        store.contacts(readAt, contact("Ada Lovelace", "local:a1"), contact("Bo Diddley", "local:a2"))
        store.device = "device-b"
        store.writes.clear()
        store.contacts(later, contact("Ada Lovelace", "local:b1"), complete = false)
        store.links.values.map { it.phoneId to it.deviceId }.toSet() shouldBe setOf("local:b1" to "device-b", "local:a2" to "device-a")
        store.writes.none { it == "forget" || it == "trash" || it == "add" } shouldBe true
    }

    "people-shaped records: two people of one name are never merged on device B, whichever side has two" {
        val store = FakeStore(PhoneSource.CONTACTS).apply { device = "device-a" }
        store.contacts(readAt, contact("Sam Lee", "local:a1", "5550101"), contact("Sam Lee", "local:a2", "5550202"), contact("Ada", "local:a3"))
        store.device = "device-b"
        store.writes.clear()
        val outcome = store.contacts(later, contact("Sam Lee", "local:b1", "5550101"), contact("Sam Lee", "local:b2", "5550202"), contact("Ada", "local:b3"))
        // Ada is re-found; neither Sam is guessed at: two old rows kept, two new ones added, four Sams and no merge.
        outcome.added shouldBe 2
        outcome.trashed shouldBe 0
        store.rows.values.count { it.matchKey == "sam lee" } shouldBe 4
        store.links.values.map { it.entityId }.toSet().size shouldBe store.links.size
        store.writes.count { it == "relink" } shouldBe 1

        // One on device A, two on device B: still nothing guessed.
        val one = FakeStore(PhoneSource.CONTACTS).apply { device = "device-a" }
        one.contacts(readAt, contact("Sam Lee", "local:a1"))
        one.device = "device-b"
        one.writes.clear()
        one.contacts(later, contact("Sam Lee", "local:b1"), contact("Sam Lee", "local:b2"))
        one.writes.none { it == "relink" } shouldBe true
        one.rows.size shouldBe 3
    }

    "people-shaped records: a portable id is the same record on every device and is neither re-found nor forgotten" {
        val store = FakeStore(PhoneSource.CONTACTS).apply { device = "device-a" }
        store.contacts(readAt, contact("Ada", "lookup:0r1"))
        store.links.values.single().deviceId shouldBe null
        store.device = "device-b"
        store.writes.clear()
        store.contacts(later, contact("Ada", "lookup:0r1"))
        store.writes.filter { it != "touch" && it != "origin" }.shouldBeEmpty()
        store.links.values.single().phoneId shouldBe "lookup:0r1"
    }

    "people-shaped records: what device A held for a row — trashed, edited, deleted forever — device B holds too" {
        val store = FakeStore(PhoneSource.CONTACTS).apply { device = "device-a" }
        store.contacts(readAt, contact("Ada", "local:a1"), contact("Bo", "local:a2"), contact("Cy", "local:a3"))
        val (ada, bo, cy) = listOf("local:a1", "local:a2", "local:a3").map { id -> store.links.values.single { it.phoneId == id }.entityId!! }
        store.trash(ada)
        store.edit(bo, PhoneFields.of { text("name", "Robert") })
        store.purge(cy)
        store.device = "device-b"
        store.writes.clear()
        val outcome = store.contacts(later, contact("Ada", "local:b1"), contact("Bo", "local:b2"), contact("Cy", "local:b3"))
        // Nothing comes back: the trashed and edited rows stop following, the purged one stays gone.
        outcome.added shouldBe 0
        store.rows.containsKey(cy) shouldBe false
        store.links.values.single { it.phoneId == "local:b1" }.detached shouldBe true
        store.links.values.single { it.phoneId == "local:b2" }.detached shouldBe true
        store.links.values.single { it.phoneId == "local:b3" }.entityId shouldBe null
    }

    "another device's origin that left is never asked about, and is retired once no link names it" {
        val store = FakeStore(PhoneSource.CONTACTS).apply { device = "device-a" }
        store.contacts(readAt, contact("Ada", "local:a1", origin = "container:a-icloud"), contact("Bo", "local:a2", origin = "container:a-icloud"))
        store.device = "device-b"
        store.writes.clear()
        val outcome = store.contacts(later, contact("Ada", "local:b1", origin = "container:b-icloud"), contact("Bo", "local:b2", origin = "container:b-icloud"))
        outcome.gone.shouldBeEmpty()
        store.origins.values.map { it.phoneOrigin } shouldContainExactly listOf("container:b-icloud")
        store.links.values.map { it.originId }.toSet() shouldBe setOf(store.origins.keys.single())
    }

    val now = 1_792_000_000_000L

    fun event(title: String, id: String, day: Int = 21) = PhoneEvent(
        title = title, start = "2026-10-${day}T12:00:00", end = "2026-10-${day}T13:00:00", tz = "UTC",
        phoneId = id, origin = "calendar:work", originLabel = "Work",
    )

    "calendar: device B re-finds device A's events with no UID, and adds, trashes and asks nothing" {
        val store = FakeStore(PhoneSource.CALENDAR).apply { device = "device-a" }
        val titles = listOf("Lunch", "Dentist", "Review", "Gym", "Call mum", "Standup notes")
        CalendarImport.sync(store, titles.mapIndexed { i, t -> event(t, "local:ek-a$i", 21 + i) }, emptyList(), complete = true, now = now)
        val rows = store.rows.keys.toSet()
        store.device = "device-b"
        store.writes.clear()
        // B's calendar is a new id too: an EventKit calendar identifier means nothing on another phone.
        val fresh = titles.mapIndexed { i, t -> event(t, "local:ek-b$i", 21 + i).copy(origin = "calendar:b-work") }
        val outcome = CalendarImport.sync(store, fresh, emptyList(), complete = true, now = now)
        outcome.added shouldBe 0
        outcome.trashed shouldBe 0
        outcome.gone.shouldBeEmpty()
        store.rows.keys shouldBe rows
        store.links.values.map { it.phoneId }.sorted() shouldContainExactly titles.indices.map { "local:ek-b$it" }
        store.writes.count { it == "relink" } shouldBe 6
        store.origins.values.map { it.phoneOrigin } shouldContainExactly listOf("calendar:b-work")
    }

    "calendar: an event of device A missing on device B is forgotten and kept; two events of one title are not merged" {
        val store = FakeStore(PhoneSource.CALENDAR).apply { device = "device-a" }
        CalendarImport.sync(
            store,
            listOf(event("Lunch", "local:a1", 21), event("Lunch", "local:a2", 22), event("Dentist", "local:a3", 23)),
            emptyList(),
            complete = true,
            now = now,
        )
        val dentist = store.links.values.single { it.phoneId == "local:a3" }.entityId!!
        store.device = "device-b"
        store.writes.clear()
        val outcome = CalendarImport.sync(store, listOf(event("Lunch", "local:b1", 21), event("Lunch", "local:b2", 22)), emptyList(), complete = true, now = now)
        outcome.trashed shouldBe 0
        outcome.gone.shouldBeEmpty()
        store.rows.getValue(dentist).trashed shouldBe false
        store.links.values.none { it.entityId == dentist } shouldBe true
        store.writes.none { it == "relink" || it == "trash" } shouldBe true
        store.rows.values.count { it.fields.canonical().contains("title=Lunch") } shouldBe 4
    }

    "a uid event is the same record on device B: no relink, no forget" {
        val store = FakeStore(PhoneSource.CALENDAR).apply { device = "device-a" }
        CalendarImport.sync(store, listOf(event("Lunch", "uid:lunch@google")), emptyList(), complete = true, now = now)
        store.device = "device-b"
        store.writes.clear()
        CalendarImport.sync(store, listOf(event("Lunch", "uid:lunch@google")), emptyList(), complete = true, now = now)
        store.writes.none { it == "relink" || it == "forget" || it == "add" } shouldBe true
    }

    "a link's fingerprint carries its record's match key, as a digest" {
        val parts = PhoneFingerprint.parts(PhoneFingerprint.pack("p", "s", "v", PhoneFingerprint.key("ada lovelace")))!!
        parts.key shouldBe PhoneFingerprint.key("ada lovelace")
        parts.key shouldNotBe "ada lovelace"
        PhoneFingerprint.key("") shouldBe PhoneFingerprint.NO_KEY
    }

    "a link of another device is forgotten where this device's own would be trashed, and no device makes it this one's" {
        val fields = PhoneFields.of { text("name", "Ada") }
        val row = dev.centraid.shared.sync.phone.VaultRow("r1", fields, matchKey = "ada")
        val origin = dev.centraid.shared.sync.phone.StoredOrigin("o1", "container:a", "A", deviceId = "device-a")
        val link = StoredLink("l1", "local:x", "o1", "r1", PhoneFingerprint.pack("p", "s", fields.digest()), false, readAt, deviceId = "device-a")
        val snapshot = dev.centraid.shared.sync.phone.PhoneSnapshot(
            PhoneSource.CONTACTS, true, later, listOf(dev.centraid.shared.sync.phone.PhoneOriginRef("container:a", "A")), emptyList(),
        )
        fun plan(device: String?) = PhoneSyncPlanner.plan(snapshot, listOf(origin), listOf(link), mapOf("r1" to row), device = device).actions
        plan(device = null).filterIsInstance<dev.centraid.shared.sync.phone.PhoneAction.Trash>().size shouldBe 1
        plan(device = "device-a").filterIsInstance<dev.centraid.shared.sync.phone.PhoneAction.Trash>().size shouldBe 1
        val there = plan(device = "device-b")
        there.filterIsInstance<dev.centraid.shared.sync.phone.PhoneAction.Forget>().size shouldBe 1
        there.none { it is dev.centraid.shared.sync.phone.PhoneAction.Trash } shouldBe true
    }

    "the device id is minted once per platform store and read back" {
        val services = FakePlatformServices()
        val first = PhoneDevice.read(services)
        first.length shouldBe 32
        PhoneDevice.read(services) shouldBe first
        PhoneDevice.read(FakePlatformServices()) shouldNotBe first
        services.secureStore.read(PhoneDevice.KEY) shouldBe first
    }

    "an origin present on device B but registered by device A becomes B's" {
        val store = FakeStore(PhoneSource.CONTACTS).apply { device = "device-a" }
        store.contacts(readAt, contact("Ada", "local:a1", origin = "account:google/ada"))
        store.device = "device-b"
        store.contacts(later, contact("Ada", "local:b1", origin = "account:google/ada"))
        store.origins.values.single().deviceId shouldBe "device-b"
        store.links.values.single().phoneId shouldBe "local:b1"
        store.origins.values.single().phoneOrigin shouldBe "account:google/ada"
    }
})
