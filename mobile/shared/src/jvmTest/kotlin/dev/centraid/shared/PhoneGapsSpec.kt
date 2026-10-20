package dev.centraid.shared

import dev.centraid.shared.sync.phone.GoneChoice
import dev.centraid.shared.sync.phone.GoneReason
import dev.centraid.shared.sync.phone.PhoneAction
import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneRecord
import dev.centraid.shared.sync.phone.PhoneSnapshot
import dev.centraid.shared.sync.phone.PhoneSource
import dev.centraid.shared.sync.phone.PhoneSync
import dev.centraid.shared.sync.phone.PhoneSyncPlanner
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe

/**
 * THE ENGINE'S GAPS (#1127, lane C): a row the member PURGED is not brought back, a present origin
 * that LOSES MOST OF ITS ROWS in one read is held for the question instead of trashed, and a
 * record's SATELLITE (a series' skipped and moved occurrences) is followed on its own.
 */
class PhoneGapsSpec : StringSpec({
    val google = PhoneOriginRef("account:google", "Google: ada@example.com")
    val t1 = "2026-10-20T10:00:00.000Z"
    val t2 = "2026-10-20T11:00:00.000Z"
    val t3 = "2026-10-20T12:00:00.000Z"

    fun person(id: String, name: String = id, satellite: PhoneFields = PhoneFields.EMPTY) = PhoneRecord(
        phoneId = id,
        origin = google.id,
        fields = PhoneFields.of { text("name", name) },
        matchKey = name.lowercase(),
        satellite = satellite,
    )

    fun snapshot(vararg records: PhoneRecord, at: String = t1, complete: Boolean = true, origins: List<PhoneOriginRef> = listOf(google)) =
        PhoneSnapshot(PhoneSource.CONTACTS, complete, at, origins, records.toList())

    fun ids(count: Int) = List(count) { "uid:p$it" }

    fun everyone(count: Int) = ids(count).map { person(it) }.toTypedArray()

    fun planOf(store: FakeStore, snapshot: PhoneSnapshot) = PhoneSyncPlanner.plan(
        snapshot,
        store.origins.values.toList(),
        store.links.values.toList(),
        store.rows,
        store.score,
        store.covered,
    )

    /** One pass with the vault's clock half a second after the read, as the real one is. */
    suspend fun pass(store: FakeStore, snapshot: PhoneSnapshot): dev.centraid.shared.sync.phone.PhoneReport {
        store.now = snapshot.readAt.replace(".000Z", ".500Z")
        return PhoneSync.run(store, snapshot)
    }

    fun entityOf(store: FakeStore, phoneId: String) = store.links.values.first { it.phoneId == phoneId }.entityId!!

    // -----------------------------------------------------------------------------------------
    // Gap 3: the purged
    // -----------------------------------------------------------------------------------------

    "a record whose row the member purged is not added again, however many passes read it" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada"), person("uid:b", "Bo"))).added shouldBe 2
        store.purge(entityOf(store, "uid:a"))
        store.writes.clear()
        repeat(3) {
            val report = PhoneSync.run(store, snapshot(person("uid:a", "Ada"), person("uid:b", "Bo"), at = "2026-10-21T0$it:00:00.000Z"))
            report.added shouldBe 0
            report.adopted shouldBe 0
        }
        store.rows.values.map { it.fields.canonical() } shouldContainExactly listOf("name=Bo")
        store.writes.none { it == "add" || it == "link" } shouldBe true
    }

    "a purged row is not adopted back either: an unlinked row of the same name is a different person" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada")))
        store.purge(entityOf(store, "uid:a"))
        val other = store.seed("Ada")
        val report = PhoneSync.run(store, snapshot(person("uid:a", "Ada"), at = t2))
        report.adopted shouldBe 0
        store.links.values.single().entityId shouldBe null
        store.rows.keys shouldContainExactly listOf(other)
    }

    "the tombstone is forgotten once the phone record is gone too, and not on a read that may have missed it" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada"), person("uid:b", "Bo")))
        store.purge(entityOf(store, "uid:a"))

        PhoneSync.run(store, snapshot(person("uid:b", "Bo"), at = t2, complete = false)).forgotten shouldBe 0
        store.links.values.count { it.entityId == null } shouldBe 1

        val report = PhoneSync.run(store, snapshot(person("uid:b", "Bo"), at = t3))
        report.forgotten shouldBe 1
        report.trashed shouldBe 0
        store.links.values.map { it.phoneId } shouldContainExactly listOf("uid:b")
        // Gone from the phone and forgotten: if it ever returns it is a new record.
        PhoneSync.run(store, snapshot(person("uid:a", "Ada"), person("uid:b", "Bo"), at = "2026-10-20T13:00:00.000Z")).added shouldBe 1
    }

    "a tombstone in an origin that left the phone is held with it, and goes with either answer" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada"), person("uid:b", "Bo")))
        store.purge(entityOf(store, "uid:a"))
        val gone = snapshot(at = t2, origins = emptyList())
        val held = PhoneSync.run(store, gone)
        held.gone.single().count shouldBe 1
        held.forgotten shouldBe 0
        val originId = held.gone.single().originId
        PhoneSync.resolveGone(store, originId, GoneChoice.KEEP).detached shouldBe 1
        store.links.values.none { it.entityId == null } shouldBe true
    }

    // -----------------------------------------------------------------------------------------
    // Gap 4: the vanish guard
    // -----------------------------------------------------------------------------------------

    "a complete read that loses more than half of an origin's followed rows holds them instead of trashing" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(*everyone(10)))
        store.writes.clear()
        val report = PhoneSync.run(store, snapshot(*everyone(3), at = t2))
        report.trashed shouldBe 0
        report.forgotten shouldBe 0
        val question = report.gone.single()
        question.reason shouldBe GoneReason.VANISHED
        question.count shouldBe 7
        question.label shouldBe google.label
        question.seenBefore shouldBe t2
        store.rows.values.none { it.trashed } shouldBe true
        store.writes.none { it == "trash" || it == "forget" } shouldBe true
        // It is asked again until it is answered, not once.
        PhoneSync.run(store, snapshot(*everyone(3), at = t3)).gone.single().count shouldBe 7
    }

    "the numbers: five lost of nine is held; five of ten, or four of four, is a member tidying" {
        val nine = FakeStore().also { PhoneSync.run(it, snapshot(*everyone(9))) }
        PhoneSync.run(nine, snapshot(*everyone(4), at = t2)).gone.single().count shouldBe 5

        val ten = FakeStore().also { PhoneSync.run(it, snapshot(*everyone(10))) }
        val half = PhoneSync.run(ten, snapshot(*everyone(5), at = t2))
        half.gone.shouldBeEmpty()
        half.trashed shouldBe 5

        val four = FakeStore().also { PhoneSync.run(it, snapshot(*everyone(4))) }
        val few = PhoneSync.run(four, snapshot(at = t2))
        few.gone.shouldBeEmpty()
        few.trashed shouldBe 4
    }

    "an incomplete read never holds, and a vanish needs no origin to be missing" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(*everyone(10)))
        val partial = PhoneSync.run(store, snapshot(*everyone(2), at = t2, complete = false))
        partial.gone.shouldBeEmpty()
        partial.trashed shouldBe 0
        // The account is still listed and has no contact at all: that is a vanish, not a departure.
        val empty = PhoneSync.run(store, snapshot(at = t3))
        empty.gone.single().reason shouldBe GoneReason.VANISHED
        empty.gone.single().count shouldBe 10
    }

    "one origin vanishing does not hold another, and a row outside the read's coverage is not counted" {
        val store = FakeStore()
        val icloud = PhoneOriginRef("account:icloud", "iCloud")
        val keep = List(6) { person("uid:i$it").copy(origin = icloud.id) }.toTypedArray()
        PhoneSync.run(store, snapshot(*everyone(10), *keep, origins = listOf(google, icloud)))
        val report = PhoneSync.run(store, snapshot(*keep, origins = listOf(google, icloud), at = t2))
        report.gone.map { it.label } shouldContainExactly listOf(google.label)
        report.trashed shouldBe 0
    }

    "KEEP detaches only the rows the read lost, and the origin goes on following the rest" {
        val store = FakeStore()
        pass(store, snapshot(*everyone(10)))
        val report = pass(store, snapshot(*everyone(3), at = t2))
        val question = report.gone.single()
        val kept = PhoneSync.resolveGone(store, question.originId, GoneChoice.KEEP, question.seenBefore)
        kept.detached shouldBe 7
        store.links.values.count { it.detached } shouldBe 7
        store.links.values.filter { !it.detached }.map { it.phoneId }.sorted() shouldContainExactly ids(3)
        store.origins.values.map { it.originId } shouldContainExactly listOf(question.originId)
        // The next pass holds nothing: the lost rows follow no more, the rest are all there.
        val next = pass(store, snapshot(*everyone(3), at = t3))
        next.gone.shouldBeEmpty()
        next.trashed shouldBe 0
    }

    "TRASH trashes only the lost rows, keeps a row the member edited, and leaves the rest following" {
        val store = FakeStore()
        pass(store, snapshot(*everyone(10)))
        val edited = entityOf(store, "uid:p9")
        store.edit(edited, PhoneFields.of { text("name", "My own words") })
        val report = pass(store, snapshot(*everyone(3), at = t2))
        val question = report.gone.single()
        val trashed = PhoneSync.resolveGone(store, question.originId, GoneChoice.TRASH, question.seenBefore)
        trashed.trashed shouldBe 6
        trashed.detached shouldBe 1
        store.rows.getValue(edited).trashed shouldBe false
        store.rows.values.count { it.trashed } shouldBe 6
        store.links.values.filter { !it.detached }.map { it.phoneId }.sorted() shouldContainExactly ids(3)
    }

    "a record that comes back before the answer is touched again and not part of it" {
        val store = FakeStore()
        pass(store, snapshot(*everyone(10)))
        val question = pass(store, snapshot(*everyone(3), at = t2)).gone.single()
        // The account finished resyncing: all ten are back, and the question is stale.
        pass(store, snapshot(*everyone(10), at = t3)).gone.shouldBeEmpty()
        val answered = PhoneSync.resolveGone(store, question.originId, GoneChoice.TRASH, question.seenBefore)
        answered.trashed shouldBe 0
        store.rows.values.none { it.trashed } shouldBe true
    }

    // -----------------------------------------------------------------------------------------
    // Gap 2's engine half: the satellite
    // -----------------------------------------------------------------------------------------

    fun sat(vararg shown: String) = PhoneFields.of { set("shown", shown.toList()) }

    "a satellite that changed alone is followed once: no row write, a fresh fingerprint, then nothing" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada", sat("k1", "k2"))))
        store.writes.clear()
        val report = PhoneSync.run(store, snapshot(person("uid:a", "Ada", sat("k1")), at = t2))
        report.followed shouldBe 1
        report.updated shouldBe 0
        store.writes shouldContainExactly listOf("follow", "link")
        store.writes.clear()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada", sat("k1")), at = t2)).changed shouldBe 0
        store.writes.none { it == "follow" || it == "link" } shouldBe true
    }

    "a changed row follows its satellite too, and a refused follow is retried, not recorded" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada", sat("k1"))))
        store.writes.clear()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada Lovelace", sat("k2")), at = t2)).updated shouldBe 1
        store.writes shouldContainExactly listOf("update", "follow", "link")

        store.refuseFollow = true
        val refused = PhoneSync.run(store, snapshot(person("uid:a", "Ada Lovelace", sat("k3")), at = t3))
        refused.refused shouldContainExactly listOf("uid:a")
        refused.followed shouldBe 0
        store.refuseFollow = false
        PhoneSync.run(store, snapshot(person("uid:a", "Ada Lovelace", sat("k3")), at = "2026-10-20T13:00:00.000Z")).followed shouldBe 1
    }

    "a member's edit still detaches before the satellite is looked at" {
        val store = FakeStore()
        PhoneSync.run(store, snapshot(person("uid:a", "Ada", sat("k1"))))
        store.edit(entityOf(store, "uid:a"), PhoneFields.of { text("name", "Mine") })
        val plan = planOf(store, snapshot(person("uid:a", "Ada", sat("k2")), at = t2))
        plan.actions.filterIsInstance<PhoneAction.Detach>().size shouldBe 1
        plan.actions.filterIsInstance<PhoneAction.Satellite>().shouldBeEmpty()
    }
})
