package dev.centraid.shared

import centraid.core.v1.AppQueryResponse
import centraid.core.v1.HealthDayValue
import centraid.core.v1.HealthFollowView
import centraid.core.v1.HealthWorkout
import centraid.core.v1.HealthWorkoutRow
import centraid.core.v1.HealthWorkouts
import dev.centraid.shared.apps.health.HealthDayTotal
import dev.centraid.shared.apps.health.HealthImport
import dev.centraid.shared.apps.health.HealthMetrics
import dev.centraid.shared.apps.health.HealthRead
import dev.centraid.shared.apps.health.HealthStoreKind
import dev.centraid.shared.apps.health.HealthWindow
import dev.centraid.shared.apps.health.PhoneWorkout
import dev.centraid.shared.kit.time.LocalDays
import dev.centraid.shared.shell.PhoneFollowWords
import dev.centraid.shared.sync.phone.GoneChoice
import dev.centraid.shared.sync.phone.GoneReason
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneSource
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.shouldBe

/**
 * A VAULT THAT KEEPS THE `health.*` AND `phone.*` COMMANDS' OWN RULES (#1129), answering the read
 * contract the store reads: `health.workouts`, `health.workout`, `health.follow_view`. The real
 * [HealthImport] and its `HealthStore` run over it.
 */
private class HealthBench {
    class Link(val id: String, val phoneId: String, var origin: String, var entity: String?, var fingerprint: String, var detachedAt: String?)

    val script = ScriptedCore()
    val workouts = linkedMapOf<String, HealthWorkoutRow>()
    val days = linkedMapOf<Pair<String, String>, Double>()
    val origins = linkedMapOf<String, Pair<String, String>>()
    val links = linkedMapOf<String, Link>()
    private var next = 0

    /** Every write, in order, the touches left out. */
    val writes: List<String> get() = script.commands.map { it.first }.filter { it != "phone.touch" }

    init {
        script.pages = { name, _ ->
            when (name) {
                "phone.links" -> links.values.map {
                    listOf(it.id, it.phoneId, it.origin, it.entity.orEmpty(), it.fingerprint, it.detachedAt.orEmpty(), SIGHTED)
                }
                "phone.origins" -> origins.map { (id, o) -> listOf(id, o.first, o.second) }
                "phone.follow.imported" -> origins.keys.take(1).map { listOf(it) }
                else -> emptyList()
            }
        }
        script.queries = { query ->
            when {
                query.health_workouts != null -> AppQueryResponse(
                    health_workouts = HealthWorkouts(workouts = workouts.values.sortedByDescending { it.started_at }.map(::drifted)),
                )
                query.health_workout != null -> AppQueryResponse(
                    health_workout = HealthWorkout(workout = workouts[query.health_workout!!.activity_id]?.let(::drifted)),
                )
                query.health_follow_view != null -> {
                    val since = query.health_follow_view!!.since
                    AppQueryResponse(
                        health_follow_view = HealthFollowView(
                            latest_day = days.keys.maxOfOrNull { it.first },
                            latest_workout_started_at = workouts.values.maxOfOrNull { it.started_at },
                            days = days.filter { it.key.first >= since }.map { (key, value) ->
                                HealthDayValue(day = key.first, metric = HealthMetrics.ofKey(key.second)!!.wire, value_ = value)
                            },
                        ),
                    )
                }
                else -> null
            }
        }
        script.answers = { name, input -> execute(name, input) }
    }

    private fun text(input: String, key: String): String? = Regex("\"$key\":\"([^\"]*)\"").find(input)?.groupValues?.get(1)

    private fun number(input: String, key: String): String? = Regex("\"$key\":([-0-9.eE+]+)").find(input)?.groupValues?.get(1)

    private fun execute(name: String, input: String): String? {
        when (name) {
            "phone.origin" -> {
                val phone = text(input, "phone_origin")!!
                val id = origins.entries.firstOrNull { it.value.first == phone }?.key ?: "o${++next}"
                origins[id] = phone to text(input, "label")!!
                return "{\"origin_id\":\"$id\"}"
            }
            "phone.link" -> {
                val phone = text(input, "phone_id")!!
                val link = links.values.firstOrNull { it.phoneId == phone } ?: Link("l${++next}", phone, "", null, "", null).also { links[it.id] = it }
                link.origin = text(input, "origin_id")!!
                link.entity = text(input, "entity_id")
                link.fingerprint = text(input, "fingerprint")!!
                return "{\"link_id\":\"${link.id}\"}"
            }
            "phone.touch", "phone.detach" -> return "{}"
            "phone.forget" -> {
                links.remove(text(input, "link_id"))
                return "{}"
            }
            "phone.retire_origin" -> {
                origins.remove(text(input, "origin_id"))
                return "{}"
            }
            "health.follow_workout" -> {
                val id = text(input, "activity_id")!!
                val kind = text(input, "kind")!!
                workouts[id] = HealthWorkoutRow(
                    activity_id = id,
                    kind_concept_id = "health:kind:$kind",
                    kind_key = kind,
                    kind_label = kind,
                    phone_kind = text(input, "phone_kind")!!,
                    // The vault's own spelling, whatever the engine sent.
                    started_at = HealthImport.canonicalInstant(text(input, "started_at")!!)!!,
                    ended_at = HealthImport.canonicalInstant(text(input, "ended_at")!!)!!,
                    moving_sec = number(input, "moving_sec")?.toLong(),
                    distance_m = number(input, "distance_m")?.toDouble(),
                    energy_kcal = number(input, "energy_kcal")?.toDouble(),
                    avg_hr_bpm = number(input, "avg_hr_bpm")?.toLong(),
                    elevation_gain_m = number(input, "elevation_gain_m")?.toDouble(),
                    recorded_by = text(input, "recorded_by"),
                )
                return "{\"activity_id\":\"$id\"}"
            }
            "health.purge_workout" -> {
                val id = text(input, "activity_id")!!
                workouts.remove(id)
                links.values.filter { it.entity == id }.forEach { it.entity = null }
                return "{\"activity_id\":\"$id\"}"
            }
            "health.record_days" -> {
                Regex("\\{\"day\":\"([^\"]+)\",\"metric\":\"([^\"]+)\",\"value\":([^}]+)\\}").findAll(input).forEach {
                    days[it.groupValues[1] to it.groupValues[2]] = it.groupValues[3].toDouble()
                }
                return "{\"written\":1,\"unchanged\":0}"
            }
        }
        return null
    }

    /** What a read adds to a stored distance: a float's breadth, as a REAL round trip may. */
    var drift: Double = 0.0

    private fun drifted(row: HealthWorkoutRow) = row.copy(distance_m = row.distance_m?.let { it + drift })

    companion object {
        const val SIGHTED = "2026-10-20T00:00:00.000Z"
    }
}

class HealthFollowSpec : StringSpec({
    val window = HealthWindow(
        today = "2026-10-20",
        totalsFrom = "2026-10-13",
        workoutsFrom = "2026-10-13",
        workoutsSince = LocalDays.epochMillisOf("2026-10-13T00:00:00Z")!!,
    )
    val readAt = "2026-10-20T10:00:00.000Z"

    fun run(minute: Int, kind: String = "running", distance: Double? = 5_200.0, id: String = "run-$minute") = PhoneWorkout(
        id = id,
        kind = kind,
        startedAt = "2026-10-${(15 + minute % 5).toString().padStart(2, '0')}T07:${(10 + minute).toString().padStart(2, '0')}:00Z",
        endedAt = "2026-10-${(15 + minute % 5).toString().padStart(2, '0')}T07:${(40 + minute).toString().padStart(2, '0')}:00Z",
        distanceM = distance,
        energyKcal = 338.0,
        avgHrBpm = 148,
        recordedBy = "Apple Watch",
    )

    fun read(vararg workouts: PhoneWorkout, days: List<HealthDayTotal> = emptyList(), complete: Boolean = true) = HealthRead(
        store = HealthStoreKind.APPLE_HEALTH,
        days = days,
        workouts = workouts.toList(),
        chosen = listOf("steps", "workouts"),
        workoutsComplete = complete,
    )

    suspend fun HealthBench.pass(read: HealthRead) = HealthImport.run(script.core(), read, window, readAt)

    "a new workout is added as an activity, linked under the store's one origin" {
        val bench = HealthBench()
        val outcome = bench.pass(read(run(0)))
        outcome.added shouldBe 1
        bench.workouts.values.single().kind_key shouldBe "run"
        bench.workouts.values.single().phone_kind shouldBe "running"
        bench.origins.values.single() shouldBe ("store:apple-health" to "Apple Health")
        bench.links.values.single().phoneId shouldBe "local:run-0"
        bench.writes shouldContainExactly listOf("phone.origin", "health.follow_workout", "phone.link")
    }

    "the engine sends instants the way the vault spells them" {
        val bench = HealthBench()
        bench.pass(read(run(0)))
        val sent = bench.script.commands.first { it.first == "health.follow_workout" }.second
        sent.contains("\"started_at\":\"2026-10-15T07:10:00.000Z\"") shouldBe true
    }

    "a second pass over the same store writes nothing" {
        val bench = HealthBench()
        bench.pass(read(run(0), run(1)))
        bench.script.commands.clear()
        bench.pass(read(run(0), run(1)))
        bench.writes.shouldBeEmpty()
    }

    "numbers round-trip without a detach: a distance the vault holds a float's breadth away is the same fact" {
        val bench = HealthBench()
        bench.pass(read(run(0, distance = 5_234.567)))
        // The link holds the row as it read back right after the write; now it reads back a breadth off.
        bench.drift = 1e-9
        bench.script.commands.clear()
        val outcome = bench.pass(read(run(0, distance = 5_234.567)))
        bench.writes.shouldBeEmpty()
        outcome.updated shouldBe 0
        bench.links.values.single().detachedAt shouldBe null
    }

    "a corrected distance on the phone updates the same activity" {
        val bench = HealthBench()
        bench.pass(read(run(0)))
        val id = bench.workouts.keys.single()
        bench.script.commands.clear()
        val outcome = bench.pass(read(run(0, distance = 5_310.0)))
        outcome.updated shouldBe 1
        bench.workouts.keys.single() shouldBe id
        bench.workouts.getValue(id).distance_m shouldBe 5_310.0
        bench.writes shouldContainExactly listOf("health.follow_workout", "phone.link")
    }

    "a workout deleted on the phone, inside the window, is kept and its link forgotten (R-1129-14)" {
        val bench = HealthBench()
        bench.pass(read(run(0), run(1)))
        val kept = bench.links.values.first { it.phoneId == "local:run-0" }.entity
        bench.script.commands.clear()
        val outcome = bench.pass(read(run(1)))
        outcome.trashed shouldBe 1
        bench.workouts.keys shouldContain kept!!
        bench.workouts.size shouldBe 2
        bench.links.values.map { it.phoneId } shouldContainExactly listOf("local:run-1")
        bench.writes shouldContainExactly listOf("phone.forget")
        // An ordinary workout now: the next pass leaves it be.
        bench.script.commands.clear()
        bench.pass(read(run(1)))
        bench.writes.shouldBeEmpty()
    }

    "a new phone: every old id gone, the same workouts under new ids, are re-linked and nothing is added, held or purged" {
        val bench = HealthBench()
        val old = (0 until 6).map { run(it, id = "old-$it") }
        bench.pass(read(*old.toTypedArray()))
        val rows = bench.workouts.keys.toSet()
        bench.script.commands.clear()
        // The restored vault still holds the old phone's links; the new phone names the same workouts its own way,
        // and one of them came back with a corrected distance.
        val fresh = (0 until 6).map { run(it, id = "new-$it", distance = if (it == 2) 5_310.0 else 5_200.0) }
        val outcome = bench.pass(read(*fresh.toTypedArray()))
        outcome.gone.shouldBeEmpty()
        outcome.added shouldBe 6
        outcome.trashed shouldBe 0
        bench.workouts.keys shouldBe rows
        bench.links.values.map { it.phoneId }.sorted() shouldContainExactly (0 until 6).map { "local:new-$it" }
        bench.writes.count { it == "health.follow_workout" } shouldBe 1
        bench.writes.count { it == "phone.forget" } shouldBe 6
        bench.writes.count { it == "phone.link" } shouldBe 6
        bench.writes.none { it == "health.purge_workout" } shouldBe true
        // And the next pass is quiet.
        bench.script.commands.clear()
        bench.pass(read(*fresh.toTypedArray()))
        bench.writes.shouldBeEmpty()
    }

    "re-finding is Health's alone: a contacts store with the same shape adds and holds as #1127 does" {
        fun shape(refind: Boolean): dev.centraid.shared.sync.phone.PhonePlan {
            val names = (0 until 6).map { "Person $it" }
            val origin = dev.centraid.shared.sync.phone.StoredOrigin("o1", "container:a", "A")
            val rows = names.mapIndexed { i, n ->
                "r$i" to dev.centraid.shared.sync.phone.VaultRow("r$i", dev.centraid.shared.sync.phone.PhoneFields.of { text("name", n) }, matchKey = n.lowercase())
            }.toMap()
            val links = names.indices.map { i ->
                dev.centraid.shared.sync.phone.StoredLink(
                    "l$i", "local:old-$i", "o1", "r$i",
                    dev.centraid.shared.sync.phone.PhoneFingerprint.pack("p", dev.centraid.shared.sync.phone.PhoneFields.EMPTY.digest(), rows.getValue("r$i").fields.digest()),
                    detached = false, lastSeenAt = "2026-10-19T00:00:00.000Z",
                )
            }
            val snapshot = dev.centraid.shared.sync.phone.PhoneSnapshot(
                PhoneSource.CONTACTS, complete = true, readAt = readAt,
                origins = listOf(dev.centraid.shared.sync.phone.PhoneOriginRef("container:a", "A")),
                records = names.mapIndexed { i, n ->
                    dev.centraid.shared.sync.phone.PhoneRecord("local:new-$i", "container:a", dev.centraid.shared.sync.phone.PhoneFields.of { text("name", n) }, matchKey = n.lowercase())
                },
            )
            return dev.centraid.shared.sync.phone.PhoneSyncPlanner.plan(snapshot, listOf(origin), links, rows, refindLost = refind)
        }
        val contacts = shape(refind = false)
        contacts.actions.count { it is dev.centraid.shared.sync.phone.PhoneAction.Add } shouldBe 6
        contacts.actions.none { it is dev.centraid.shared.sync.phone.PhoneAction.Refind } shouldBe true
        contacts.gone.single().reason shouldBe GoneReason.VANISHED
        val opted = shape(refind = true)
        opted.actions.count { it is dev.centraid.shared.sync.phone.PhoneAction.Refind } shouldBe 6
        opted.actions.none { it is dev.centraid.shared.sync.phone.PhoneAction.Add } shouldBe true
        opted.gone.shouldBeEmpty()
    }

    "a workout that started before the window read is not one the phone deleted" {
        val bench = HealthBench()
        val old = run(0).copy(id = "old", startedAt = "2026-09-01T07:00:00Z", endedAt = "2026-09-01T07:30:00Z")
        // A first pass, whose window reached back further, brought the old one in.
        val wide = window.copy(workoutsFrom = "2026-08-01", workoutsSince = LocalDays.epochMillisOf("2026-08-01T00:00:00Z")!!)
        HealthImport.run(bench.script.core(), read(old, run(1)), wide, readAt)
        bench.workouts.size shouldBe 2
        bench.script.commands.clear()
        bench.pass(read(run(1)))
        bench.workouts.size shouldBe 2
        bench.writes.shouldBeEmpty()
    }

    "an empty workout read removes nothing (R-1129-5)" {
        val bench = HealthBench()
        bench.pass(read(run(0), run(1)))
        bench.script.commands.clear()
        bench.pass(read())
        bench.workouts.size shouldBe 2
        bench.writes.shouldBeEmpty()
    }

    "a read the shell says may have missed some removes nothing" {
        val bench = HealthBench()
        bench.pass(read(run(0), run(1)))
        bench.script.commands.clear()
        bench.pass(read(run(1), complete = false))
        bench.workouts.size shouldBe 2
    }

    "workouts the member did not choose, or the OS refused, are never removed" {
        val bench = HealthBench()
        bench.pass(read(run(0), run(1)))
        bench.script.commands.clear()
        bench.pass(read(run(1)).copy(chosen = listOf("steps")))
        bench.pass(read(run(1)).copy(refused = listOf("workouts")))
        bench.workouts.size shouldBe 2
    }

    "a vanish of five or more holds them for the member's question" {
        val bench = HealthBench()
        val all = (0 until 6).map { run(it, id = "w$it") }
        bench.pass(read(*all.toTypedArray()))
        bench.script.commands.clear()
        val outcome = bench.pass(read(all.last()))
        outcome.gone.single().reason shouldBe GoneReason.VANISHED
        outcome.gone.single().count shouldBe 5
        bench.workouts.size shouldBe 6
        bench.writes.shouldBeEmpty()
    }

    "a store no longer on the phone is an origin gone; deleting them purges" {
        val bench = HealthBench()
        bench.pass(read(run(0), run(1)))
        val outcome = bench.pass(read().copy(storePresent = false))
        val gone = outcome.gone.single()
        gone.reason shouldBe GoneReason.LEFT
        gone.count shouldBe 2
        gone.label shouldBe "Apple Health"
        bench.workouts.size shouldBe 2
        HealthImport.resolveGone(bench.script.core(), gone.originId, GoneChoice.TRASH)
        bench.workouts.size shouldBe 0
        bench.origins.isEmpty() shouldBe true
    }

    "a new phone re-adopts a workout by its kind and start minute instead of adding a second" {
        val bench = HealthBench()
        bench.pass(read(run(0)))
        val id = bench.workouts.keys.single()
        // The old phone's link went with the old phone.
        bench.links.clear()
        bench.script.commands.clear()
        val outcome = bench.pass(read(run(0, id = "a-new-uuid")))
        outcome.added shouldBe 1
        bench.workouts.keys.single() shouldBe id
        bench.links.values.single().phoneId shouldBe "local:a-new-uuid"
        bench.writes shouldContainExactly listOf("phone.link")
    }

    "the days that changed go in one record_days, and a second pass sends none" {
        val bench = HealthBench()
        val days = listOf(HealthDayTotal("2026-10-19", "steps", 6_350.0), HealthDayTotal("2026-10-20", "steps", 1_200.0))
        bench.pass(read(days = days)).days shouldBe 2
        bench.days[("2026-10-19" to "steps")] shouldBe 6_350.0
        bench.script.commands.clear()
        bench.pass(read(days = days)).days shouldBe 0
        bench.writes.shouldBeEmpty()
    }

    "the window is derived from what the vault holds" {
        val bench = HealthBench()
        val clock = dev.centraid.shared.platform.FakeDeviceClock(epochMillis = LocalDays.epochMillisOf("2026-10-20T10:00:00Z")!!)
        HealthImport.window(bench.script.core(), clock) shouldBe HealthWindow(
            "2026-10-20",
            "2025-10-20",
            "2026-07-22",
            LocalDays.epochMillisOf("2026-07-22T00:00:00Z")!!,
        )
        bench.days[("2026-10-18" to "steps")] = 10.0
        bench.workouts["a"] = HealthWorkoutRow(activity_id = "a", kind_key = "run", started_at = "2026-10-19T23:30:00.000Z", ended_at = "2026-10-20T00:10:00.000Z")
        // East of UTC, the workout's start is already the 20th on the phone.
        clock.utcOffsetMinutes = 120
        HealthImport.window(bench.script.core(), clock)!!.let {
            it.totalsFrom shouldBe "2026-10-11"
            it.workoutsFrom shouldBe "2026-10-13"
            it.workoutsSince shouldBe LocalDays.epochMillisOf("2026-10-12T22:00:00Z")!!
        }
    }

    "the follow-gone question for the health store counts workouts and deletes, since a workout has no trash" {
        val asked = PhoneFollowWords.question(OriginGone(PhoneSource.HEALTH, "o1", "store:apple-health", "Apple Health", 31, GoneReason.LEFT))
        asked.title shouldBe "Apple Health is no longer on this phone"
        asked.body shouldBe "Keep its 31 workouts in Health?"
        asked.trashLabel shouldBe "Delete them"
        PhoneFollowWords.question(OriginGone(PhoneSource.HEALTH, "o1", "p", "Apple Health", 1, GoneReason.VANISHED)).body shouldBe
            "Keep the 1 workout missing from it in Health?"
    }

    "every source has its question's words: HEALTH is in every exhaustive mapping" {
        PhoneSource.entries.forEach { source ->
            val asked = PhoneFollowWords.question(OriginGone(source, "o", "p", "L", 2, GoneReason.LEFT))
            asked.body.isNotEmpty() shouldBe true
            asked.keepLabel shouldBe "Keep"
        }
        PhoneSource.valueOf("HEALTH").wire shouldBe "health"
    }

    "canonical numbers: integers as integers, reals to three places, trailing zeros dropped" {
        HealthImport.number(5_234.0) shouldBe "5234"
        HealthImport.number(5_234.5) shouldBe "5234.5"
        HealthImport.number(5_234.5671) shouldBe "5234.567"
        HealthImport.number(5_234.5670000001) shouldBe "5234.567"
        HealthImport.number(0.0004) shouldBe "0"
    }
})
