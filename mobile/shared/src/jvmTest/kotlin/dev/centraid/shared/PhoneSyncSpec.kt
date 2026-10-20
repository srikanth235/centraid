package dev.centraid.shared

import dev.centraid.shared.sync.phone.DetachReason
import dev.centraid.shared.sync.phone.GoneChoice
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneAction
import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneFingerprint
import dev.centraid.shared.sync.phone.PhoneIds
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneRecord
import dev.centraid.shared.sync.phone.PhoneSnapshot
import dev.centraid.shared.sync.phone.PhoneSource
import dev.centraid.shared.sync.phone.PhoneSync
import dev.centraid.shared.sync.phone.PhoneSyncPlanner
import dev.centraid.shared.sync.phone.VaultRow
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf

/**
 * `PhoneSync`, the shared diff engine (#1127, lane B): every branch of the plan, run against an
 * in-memory vault that keeps the commands' own rules (a link refreshes in place, a detach is set
 * once, a forgotten link is gone, and every WRITE is logged so "writes nothing" is a fact).
 *
 * People stand for the fields here; Agenda and Docs differ only in what their fields are.
 */
class PhoneSyncSpec : StringSpec({
    val google = PhoneOriginRef("account:google", "Google: ada@example.com")
    val icloud = PhoneOriginRef("account:icloud", "iCloud")
    val readAt = "2026-10-20T10:00:00.000Z"

    fun person(id: String, name: String, origin: PhoneOriginRef = google, vararg phones: String): PhoneRecord = PhoneRecord(
        phoneId = id,
        origin = origin.id,
        fields = PhoneFields.of {
            text("name", name)
            phones("phones", phones.toList())
        },
        matchKey = name.lowercase(),
        tiebreak = phones.map(PhoneFields::phoneNumber).toSet(),
    )

    fun snapshot(
        vararg records: PhoneRecord,
        origins: List<PhoneOriginRef> = listOf(google),
        complete: Boolean = true,
        at: String = readAt,
        source: PhoneSource = PhoneSource.CONTACTS,
    ) = PhoneSnapshot(source, complete, at, origins, records.toList())

    "a record the vault does not hold is added with its origin, and its link holds both digests" {
        val store = FakeStore()
        val report = PhoneSync.run(store, snapshot(person("uid:a", "Ada", google, "555 0100"), person("uid:b", "Bo")))
        report.added shouldBe 2
        store.origins.values.map { it.label } shouldContainExactly listOf("Google: ada@example.com")
        store.links.values.map { it.phoneId }.sorted() shouldContainExactly listOf("uid:a", "uid:b")
        val parts = PhoneFingerprint.parts(store.links.values.first { it.phoneId == "uid:a" }.fingerprint)!!
        parts.phone shouldBe person("uid:a", "Ada", google, "555 0100").fields.digest()
        store.rows.size shouldBe 2
    }

    "an unlinked vault row of the same name is adopted, not added, and its fields are left alone" {
        val store = FakeStore()
        val existing = store.seed("Ada", "(555) 0100", "x")
        val plan = plan(store, snapshot(person("lookup:7", "ada", google, "555-0100")))
        plan.actions.filterIsInstance<PhoneAction.Adopt>().single().entityId shouldBe existing
        plan.actions.filterIsInstance<PhoneAction.Add>().shouldBeEmpty()
        val before = store.rows.getValue(existing)
        val report = PhoneSync.run(store, snapshot(person("lookup:7", "ada", google, "555-0100")))
        report.adopted shouldBe 1
        report.added shouldBe 0
        store.rows.getValue(existing) shouldBe before
        store.writes.none { it.startsWith("add") || it.startsWith("update") } shouldBe true
    }

    "a vault row is never adopted twice" {
        val store = FakeStore()
        store.seed("Ada", "555 0100")
        val report = PhoneSync.run(
            store,
            snapshot(person("uid:1", "Ada", google, "555 0100"), person("uid:2", "Ada", google, "555 0100")),
        )
        report.adopted shouldBe 1
        report.added shouldBe 1
        store.rows.size shouldBe 2
    }

    "several rows of one name are told apart by a channel, and a tie adopts none" {
        val store = FakeStore()
        store.seed("Sam", "111")
        val second = store.seed("Sam", "222")
        val chosen = plan(store, snapshot(person("uid:s", "Sam", google, "222"))).actions
        chosen.filterIsInstance<PhoneAction.Adopt>().single().entityId shouldBe second
        val tied = plan(store, snapshot(person("uid:s", "Sam", google, "333"))).actions
        tied.filterIsInstance<PhoneAction.Adopt>().shouldBeEmpty()
        tied.filterIsInstance<PhoneAction.Add>().size shouldBe 1
    }

    "a trashed row is not adopted" {
        val store = FakeStore()
        store.seed("Ada", trashed = true)
        plan(store, snapshot(person("uid:a", "Ada"))).actions.filterIsInstance<PhoneAction.Add>().size shouldBe 1
    }

    "a phone change the vault row has not been edited under is written to the row" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada", google, "555 0100")))
        val changed = snapshot(person("uid:a", "Ada Lovelace", google, "555 0100", "555 0199"))
        plan(store, changed).actions.filterIsInstance<PhoneAction.Update>().size shouldBe 1
        val report = PhoneSync.run(store, changed)
        report.updated shouldBe 1
        store.rows.values.single().fields shouldBe changed.records.single().fields
        PhoneSync.run(store, changed).changed shouldBe 0
    }

    "a row the member edited detaches and is never overwritten, however the phone changes" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada", google, "555 0100")))
        val entity = store.rows.keys.single()
        store.edit(entity, PhoneFields.of { text("name", "Ada (work)") })
        val changed = snapshot(person("uid:a", "Ada Lovelace", google, "555 0100"))
        val plan = plan(store, changed)
        plan.actions.filterIsInstance<PhoneAction.Detach>().single().reason shouldBe DetachReason.EDITED
        PhoneSync.run(store, changed).detached shouldBe 1
        store.rows.getValue(entity).fields shouldBe PhoneFields.of { text("name", "Ada (work)") }
        store.links.values.single().detached shouldBe true
        // Detached for good: later phone changes, and the record going, write nothing to the row.
        val later = snapshot(person("uid:a", "Ada L", google, "555 0100"), at = "2026-10-20T11:00:00.000Z")
        PhoneSync.run(store, later)
        PhoneSync.run(store, snapshot(at = "2026-10-20T12:00:00.000Z"))
        store.rows.getValue(entity).fields shouldBe PhoneFields.of { text("name", "Ada (work)") }
        store.rows.getValue(entity).trashed shouldBe false
    }

    "a row the member trashed detaches too, so the phone cannot bring it back" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada")))
        store.rows.values.single().let { store.rows[it.entityId] = it.copy(trashed = true) }
        val plan = plan(store, snapshot(person("uid:a", "Ada")))
        plan.actions.filterIsInstance<PhoneAction.Detach>().single().reason shouldBe DetachReason.TRASHED
        PhoneSync.run(store, snapshot(person("uid:a", "Ada")))
        store.rows.size shouldBe 1
        store.links.values.single().detached shouldBe true
    }

    "a record gone from a present origin, on a complete read, trashes the row and forgets the link" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada"), person("uid:b", "Bo")))
        val after = snapshot(person("uid:b", "Bo"), at = "2026-10-20T11:00:00.000Z")
        val report = PhoneSync.run(store, after)
        report.trashed shouldBe 1
        store.rows.values.single { it.fields == person("uid:a", "Ada").fields }.trashed shouldBe true
        store.links.values.map { it.phoneId } shouldContainExactly listOf("uid:b")
        store.rows.values.count { it.trashed } shouldBe 1
    }

    "an incomplete read trashes, forgets and holds nothing" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada"), person("uid:b", "Bo")))
        val limited = snapshot(person("uid:b", "Bo"), complete = false, at = "2026-10-20T11:00:00.000Z")
        val plan = plan(store, limited)
        plan.actions.filterIsInstance<PhoneAction.Trash>().shouldBeEmpty()
        plan.actions.filterIsInstance<PhoneAction.Forget>().shouldBeEmpty()
        plan.gone.shouldBeEmpty()
        PhoneSync.run(store, limited).trashed shouldBe 0
        // Not even an origin that is missing from the partial read is asked about.
        val noOrigins = snapshot(complete = false, origins = emptyList(), at = "2026-10-20T11:30:00.000Z")
        plan(store, noOrigins).gone.shouldBeEmpty()
        store.rows.values.none { it.trashed } shouldBe true
        store.links.size shouldBe 2
    }

    "an origin missing altogether is held: one question with the label it had, and no write for its rows" {
        val store = FakeStore()
        PhoneSync.run(
            store,
            snapshot(
                person("uid:a", "Ada", google),
                person("uid:b", "Bo", google),
                person("uid:c", "Cy", icloud),
                origins = listOf(google, icloud),
            ),
        )
        val withoutGoogle = snapshot(person("uid:c", "Cy", icloud), origins = listOf(icloud), at = "2026-10-20T11:00:00.000Z")
        val plan = plan(store, withoutGoogle)
        plan.gone.size shouldBe 1
        val question = plan.gone.single()
        question.shouldBeInstanceOf<OriginGone>()
        question.label shouldBe "Google: ada@example.com"
        question.count shouldBe 2
        question.source shouldBe PhoneSource.CONTACTS
        plan.actions.filter { it is PhoneAction.Trash || it is PhoneAction.Forget || it is PhoneAction.Detach }.shouldBeEmpty()
        store.writes.clear()
        val report = PhoneSync.run(store, withoutGoogle)
        report.gone shouldContainExactly plan.gone
        report.trashed shouldBe 0
        store.rows.values.none { it.trashed } shouldBe true
        store.writes.any { it.startsWith("trash") || it.startsWith("forget") || it.startsWith("detach") } shouldBe false
    }

    "a held question stays until answered, and an origin that comes back answers it" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada")))
        val gone = snapshot(origins = emptyList(), at = "2026-10-20T11:00:00.000Z")
        plan(store, gone).gone.single().count shouldBe 1
        plan(store, gone).gone.single().count shouldBe 1
        plan(store, snapshot(person("uid:a", "Ada"), at = "2026-10-20T12:00:00.000Z")).gone.shouldBeEmpty()
    }

    "a record that moved to another origin is re-homed, not held or trashed" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada", google), origins = listOf(google, icloud)))
        val moved = snapshot(person("uid:a", "Ada", icloud), origins = listOf(icloud), at = "2026-10-20T11:00:00.000Z")
        val plan = plan(store, moved)
        plan.gone.shouldBeEmpty()
        plan.actions.filterIsInstance<PhoneAction.Rehome>().size shouldBe 1
        PhoneSync.run(store, moved).rehomed shouldBe 1
        store.origins.getValue(store.links.values.single().originId).phoneOrigin shouldBe "account:icloud"
    }

    "keeping a vanished origin's rows detaches every link and leaves the rows and the label" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada"), person("uid:b", "Bo")))
        val originId = store.origins.keys.single()
        val report = PhoneSync.resolveGone(store, originId, GoneChoice.KEEP)
        report.detached shouldBe 2
        store.links.values.all { it.detached } shouldBe true
        store.rows.values.none { it.trashed } shouldBe true
        store.origins.getValue(originId).label shouldBe "Google: ada@example.com"
        // Asked once: the detached links are no longer a question.
        plan(store, snapshot(origins = emptyList(), at = "2026-10-20T11:00:00.000Z")).gone.shouldBeEmpty()
        // And if the account comes back, nothing is added twice and nothing is re-attached.
        val back = snapshot(person("uid:a", "Ada"), person("uid:b", "Bo"), at = "2026-10-20T12:00:00.000Z")
        PhoneSync.run(store, back).changed shouldBe 0
        store.rows.size shouldBe 2
    }

    "trashing a vanished origin's rows trashes the untouched ones, forgets their links and retires the origin" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada"), person("uid:b", "Bo")))
        val originId = store.origins.keys.single()
        val report = PhoneSync.resolveGone(store, originId, GoneChoice.TRASH)
        report.trashed shouldBe 2
        store.rows.values.all { it.trashed } shouldBe true
        store.links.isEmpty() shouldBe true
        store.origins.isEmpty() shouldBe true
    }

    "trashing never discards a row the member edited: it is kept, detached" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada"), person("uid:b", "Bo")))
        val edited = store.rows.values.first { it.fields == person("uid:a", "Ada").fields }.entityId
        store.edit(edited, PhoneFields.of { text("name", "Ada, mine") })
        val originId = store.origins.keys.single()
        val report = PhoneSync.resolveGone(store, originId, GoneChoice.TRASH)
        report.trashed shouldBe 1
        report.detached shouldBe 1
        store.rows.getValue(edited).trashed shouldBe false
        store.links.values.single().detached shouldBe true
        store.origins.size shouldBe 1
    }

    "a second pass over the same snapshot writes nothing; a later one only touches" {
        val store = FakeStore()
        val first = snapshot(person("uid:a", "Ada", google, "555 0100"), person("uid:b", "Bo"))
        PhoneSync.run(store, first)
        store.writes.clear()
        PhoneSync.run(store, first).changed shouldBe 0
        plan(store, first).isEmpty() shouldBe true
        store.writes.shouldBeEmpty()
        val later = first.copy(readAt = "2026-10-21T01:00:00.000Z")
        val sightings = plan(store, later).actions
        sightings.size shouldBe 1
        sightings.single().shouldBeInstanceOf<PhoneAction.Touch>().phoneIds.sorted() shouldContainExactly listOf("uid:a", "uid:b")
        PhoneSync.run(store, later)
        store.writes shouldContainExactly listOf("touch")
    }

    "a detached link whose record is gone from a present origin is forgotten" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada")))
        store.edit(store.rows.keys.single(), PhoneFields.of { text("name", "Mine") })
        PhoneSync.run(store, snapshot(person("uid:a", "Ada"), at = "2026-10-20T11:00:00.000Z"))
        plan(store, snapshot(origins = listOf(google), at = "2026-10-20T12:00:00.000Z"))
            .actions.filterIsInstance<PhoneAction.Forget>().size shouldBe 1
    }

    "a refused write is counted by the phone id and the pass goes on" {
        val store = FakeStore().apply { refuseAdds = setOf("Bo") }
        val report = PhoneSync.run(store, snapshot(person("uid:a", "Ada"), person("uid:b", "Bo"), person("uid:c", "Cy")))
        report.added shouldBe 2
        report.refused shouldContainExactly listOf("uid:b")
    }

    "an unreadable vault plans and writes nothing" {
        val store = FakeStore().apply { unreadable = true }
        val report = PhoneSync.run(store, snapshot(person("uid:a", "Ada")))
        report.read shouldBe false
        store.writes.shouldBeEmpty()
    }

    "an id names its kind, and an id that names none is skipped" {
        PhoneIds.kind(PhoneIds.uid("abc@google.com")) shouldBe "uid"
        PhoneIds.kind(PhoneIds.lookup("0r1-4A")) shouldBe "lookup"
        PhoneIds.kind(PhoneIds.local("12")) shouldBe "local"
        PhoneIds.isPortable(PhoneIds.uid("x")) shouldBe true
        PhoneIds.isPortable(PhoneIds.lookup("x")) shouldBe true
        PhoneIds.isPortable(PhoneIds.local("x")) shouldBe false
        PhoneIds.isValid("12") shouldBe false
        PhoneIds.isValid("uid:") shouldBe false
        PhoneIds.isValid(":x") shouldBe false
        val store = FakeStore()
        val plan = plan(store, snapshot(person("12", "Ada"), person("uid:b", "Bo")))
        plan.invalid shouldContainExactly listOf("12")
        plan.actions.filterIsInstance<PhoneAction.Add>().map { it.record.phoneId } shouldContainExactly listOf("uid:b")
        // The same text under two kinds is two records: a local id never stands for a portable one.
        PhoneSync.run(store, snapshot(person("uid:7", "Ada"), person("local:7", "Bo"))).added shouldBe 2
    }

    "the fingerprint ignores order, spacing, phone punctuation and case where case means nothing" {
        val a = PhoneFields.of {
            text("name", "  Ada   Lovelace ")
            phones("phones", listOf("(555) 010-0142", "+1 555 010 0199"))
            emails("emails", listOf("ADA@Example.com", "ada@work.com"))
        }
        val b = PhoneFields.of {
            text("name", "Ada Lovelace")
            phones("phones", listOf("+1.555.010.0199", "555.010.0142", "5550100142"))
            emails("emails", listOf("ada@work.com", " ada@example.com "))
        }
        a.digest() shouldBe b.digest()
        a shouldBe b
        // An absent field and an empty one are the same.
        PhoneFields.of { text("name", "Ada") }.digest() shouldBe
            PhoneFields.of {
                text("name", "Ada")
                phones("phones", emptyList())
                text("nick", "  ")
            }.digest()
        // A real difference is a different digest.
        a.digest() shouldNotBe PhoneFields.of { text("name", "Ada Lovelace") }.digest()
        PhoneFields.of { text("name", "Ada") }.digest() shouldNotBe PhoneFields.of { text("name", "Ada.") }.digest()
        PhoneFields.phoneNumber("+1 555") shouldNotBe PhoneFields.phoneNumber("1 555")
    }

    "a fingerprint packs two digests and reads them back, and refuses what is not one" {
        PhoneFingerprint.parts(PhoneFingerprint.pack("aa", "bb")) shouldBe PhoneFingerprint.Parts("aa", "bb")
        PhoneFingerprint.parts("fp-1") shouldBe null
        PhoneFingerprint.parts("v1..bb") shouldBe null
        // A link in a shape no engine wrote is treated as edited, so it is never written over.
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada")))
        val link = store.links.values.single()
        store.links[link.linkId] = link.copy(fingerprint = "fp-1")
        plan(store, snapshot(person("uid:a", "Ada Z"))).actions.filterIsInstance<PhoneAction.Detach>().size shouldBe 1
    }

    "a row the read could not have seen is neither trashed nor forgotten" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada"), person("uid:b", "Bo")))
        val outside = store.rows.values.first { it.fields == person("uid:a", "Ada").fields }.entityId
        store.covered = { it.entityId != outside }
        val report = PhoneSync.run(store, snapshot(at = "2026-10-20T11:00:00.000Z"))
        report.trashed shouldBe 1
        store.rows.getValue(outside).trashed shouldBe false
        store.links.values.map { it.entityId } shouldContainExactly listOf(outside)
    }

    "the engine is the same for another source: a picked folder is an origin and a file a record" {
        val store = FakeStore(PhoneSource.FILES)
        val folder = PhoneOriginRef("folder:/Documents/Taxes", "Taxes")
        val file = { name: String, size: String ->
            PhoneRecord("local:$name", folder.id, PhoneFields.of { exact("name", name); text("size", size) }, matchKey = name)
        }
        val first = PhoneSnapshot(PhoneSource.FILES, true, readAt, listOf(folder), listOf(file("a.pdf", "10"), file("b.pdf", "20")))
        PhoneSync.run(store, first).added shouldBe 2
        val second = PhoneSnapshot(PhoneSource.FILES, true, "2026-10-20T11:00:00.000Z", listOf(folder), listOf(file("a.pdf", "11")))
        val report = PhoneSync.run(store, second)
        report.updated shouldBe 1
        report.trashed shouldBe 1
        val removed = PhoneSnapshot(PhoneSource.FILES, true, "2026-10-20T12:00:00.000Z", emptyList(), emptyList())
        PhoneSync.run(store, removed).gone.single().label shouldBe "Taxes"
    }
})

private infix fun <T> T.shouldNotBe(other: T) {
    (this == other) shouldBe false
}

private fun plan(store: FakeStore, snapshot: PhoneSnapshot) = PhoneSyncPlanner.plan(
    snapshot,
    store.origins.values.toList(),
    store.links.values.toList(),
    store.rows,
    store.score,
    store.covered,
)

