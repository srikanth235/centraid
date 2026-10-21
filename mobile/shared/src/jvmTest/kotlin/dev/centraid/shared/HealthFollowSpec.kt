package dev.centraid.shared

import centraid.core.v1.AppQueryResponse
import centraid.core.v1.HealthDayValue
import centraid.core.v1.HealthFollowView
import dev.centraid.shared.apps.health.HealthDayTotal
import dev.centraid.shared.apps.health.HealthImport
import dev.centraid.shared.apps.health.HealthMetrics
import dev.centraid.shared.apps.health.HealthRead
import dev.centraid.shared.apps.health.HealthStoreKind
import dev.centraid.shared.apps.health.HealthWindow
import dev.centraid.shared.apps.health.PhoneWorkout
import dev.centraid.shared.shell.PhoneFollowWords
import dev.centraid.shared.sync.epochMillisFromRfc3339
import dev.centraid.shared.sync.phone.GoneReason
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneSource
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

/**
 * THE HEALTH STORE'S PASS (#1129, #1135): what the shell tells the vault, and nothing else. The
 * merge is the vault's (`follow.health`, `measurement.record`; `crates/vault/tests/money_health.rs`
 * holds what they do with it), so this holds the SHAPE of what is sent: the store's one origin,
 * a workout's identity and kind, the window it speaks for, and when a read may judge a workout gone.
 */
class HealthFollowSpec : StringSpec({
    val window = HealthWindow(
        today = "2026-10-20",
        totalsFrom = "2026-10-13",
        workoutsFrom = "2026-10-13",
        workoutsSince = epochMillisFromRfc3339("2026-10-13T00:00:00Z")!!,
    )
    val device = "device-a"

    fun run(minute: Int, kind: String = "running", id: String = "run-$minute") = PhoneWorkout(
        id = id,
        kind = kind,
        startedAt = "2026-10-15T07:${(10 + minute).toString().padStart(2, '0')}:00Z",
        endedAt = "2026-10-15T07:${(40 + minute).toString().padStart(2, '0')}:00.5Z",
        movingSec = 1_800,
        distanceM = 5_234.5671,
        energyKcal = 338.0,
        avgHrBpm = 148,
        elevationGainM = 0.0,
        recordedBy = "  Apple   Watch ",
    )

    fun read(
        vararg workouts: PhoneWorkout,
        days: List<HealthDayTotal> = emptyList(),
        chosen: List<String> = listOf("steps", "workouts"),
        refused: List<String> = emptyList(),
        complete: Boolean = true,
        present: Boolean = true,
    ) = HealthRead(
        store = HealthStoreKind.APPLE_HEALTH,
        days = days,
        workouts = workouts.toList(),
        chosen = chosen,
        refused = refused,
        workoutsComplete = complete,
        storePresent = present,
    )

    fun input(read: HealthRead) = HealthImport.followInput(read, window, device)

    "a workout is one record: the store's id on this device, the vault's kind key, instants the way the vault spells them, the figures as stated" {
        val sent = input(read(run(0)))
        sent shouldContain "\"origin\":{\"ref\":\"store:apple-health\",\"label\":\"Apple Health\",\"device_id\":\"device-a\"}"
        sent shouldContain "\"external_id\":\"local:run-0\",\"device_id\":\"device-a\""
        sent shouldContain "\"kind\":\"run\""
        sent shouldContain "\"starts\":\"2026-10-15T07:10:00.000Z\",\"ends\":\"2026-10-15T07:40:00.500Z\""
        sent shouldContain "\"workout\":{\"recorded_by\":\"Apple Watch\",\"moving_s\":1800,\"distance_m\":5234.567,\"energy_kcal\":338,\"heart_bpm\":148,\"climb_m\":0}"
        sent shouldContain "\"since\":\"2026-10-13T00:00:00.000Z\""
    }

    "a word the table does not name rides as itself, for the vault to mint a kind from" {
        input(read(run(0, kind = "pilates"))) shouldContain "\"kind\":\"pilates\""
    }

    "a workout the vault should not be told of is left out: no id, no kind, an end before its start, a start before the window" {
        val sent = input(
            read(
                run(0),
                run(1, id = " "),
                run(2, kind = " "),
                run(3).copy(endedAt = "2026-10-15T07:00:00Z"),
                run(4).copy(startedAt = "2026-10-10T07:00:00Z", endedAt = "2026-10-10T08:00:00Z"),
                run(5, id = "run-0"),
            ),
        )
        Regex("\"external_id\"").findAll(sent).count() shouldBe 1
    }

    "a read is complete only when it says so, found a workout, and the member chose workouts and the OS allowed them" {
        input(read(run(0))) shouldContain "\"complete\":true"
        input(read(run(0), complete = false)) shouldContain "\"complete\":false"
        input(read()) shouldContain "\"complete\":false"
        input(read(run(0), chosen = listOf("steps"))) shouldContain "\"complete\":false"
        input(read(run(0), refused = listOf("workouts"))) shouldContain "\"complete\":false"
    }

    "a store no longer on the phone sends no workouts and judges none gone" {
        val sent = input(read(run(0), present = false))
        sent shouldContain "\"records\":[]"
        sent shouldContain "\"complete\":false"
    }

    "a pass sends the days that changed in one record, then the workouts; a second pass sends no days" {
        val core = ScriptedCore()
        val days = listOf(HealthDayTotal("2026-10-19", "steps", 6_350.0), HealthDayTotal("2026-10-20", "steps", 1_200.0))
        core.answers = { name, _ -> if (name == "follow.health") "{\"added\":1,\"matched\":1,\"updated\":2,\"forgotten\":3,\"refused\":0}" else "{}" }
        val first = HealthImport.run(core.core(), read(run(0), days = days), window, device)
        core.commands.map { it.first } shouldContainExactly listOf("measurement.record", "follow.health")
        core.commands[0].second shouldBe "{\"days\":[{\"day\":\"2026-10-19\",\"metric\":\"steps\",\"value\":6350.0},{\"day\":\"2026-10-20\",\"metric\":\"steps\",\"value\":1200.0}]}"
        first shouldBe HealthImport.Outcome(days = 2, added = 2, updated = 2, forgotten = 3)
        core.commands.clear()
        HealthImport.run(core.core(), read(run(0), days = days), window.copy(held = days), device).days shouldBe 0
        core.commands.map { it.first } shouldContainExactly listOf("follow.health")
    }

    "a refused follow is a pass that read nothing, and the days it carried are still counted" {
        val core = ScriptedCore()
        core.refuses = { it == "follow.health" }
        val outcome = HealthImport.run(core.core(), read(run(0)), window, device)
        outcome.read shouldBe false
        outcome.added shouldBe 0
    }

    "connect writes the store's origin at once, with no workouts, then passes; stop forgets both stores' origins and nothing else" {
        val core = ScriptedCore()
        core.queries = { query ->
            query.health_follow_view?.let {
                AppQueryResponse(
                    health_follow_view = HealthFollowView(
                        today = "2026-10-20",
                        totals_from = "2026-10-13",
                        workouts_from = "2026-10-13",
                        workouts_since = "2026-10-12T22:00:00.000Z",
                    ),
                )
            }
        }
        val clock = dev.centraid.shared.platform.FakeDeviceClock(epochMillis = epochMillisFromRfc3339("2026-10-20T10:00:00Z")!!)
        val reader = object : dev.centraid.shared.apps.health.HealthReader {
            override fun read(window: HealthWindow, deliver: (HealthRead?) -> Unit) = deliver(read())
        }
        HealthImport.connect(core.core(), HealthStoreKind.APPLE_HEALTH, reader, clock)
        core.commands.first().first shouldBe "follow.health"
        core.commands.first().second shouldContain "\"records\":[]"
        core.commands.first().second shouldNotContain "complete"
        core.commands.clear()
        HealthImport.stop(core.core()) shouldBe true
        core.commands.map { it.first } shouldContainExactly listOf("follow.stop", "follow.stop")
        core.commands.map { it.second } shouldContainExactly listOf(
            "{\"system\":\"health\",\"ref\":\"store:apple-health\"}",
            "{\"system\":\"health\",\"ref\":\"store:health-connect\"}",
        )
    }

    "the window is the core's, asked in the device's zone, with the days it holds" {
        val core = ScriptedCore()
        val zones = mutableListOf<String>()
        core.queries = { query ->
            query.health_follow_view?.let {
                zones += it.tz
                AppQueryResponse(
                    health_follow_view = HealthFollowView(
                        latest_day = "2026-10-18",
                        days = listOf(HealthDayValue(day = "2026-10-18", metric = HealthMetrics.ofKey("steps")!!.wire, value_ = 10.0)),
                        today = "2026-10-20",
                        totals_from = "2026-10-13",
                        workouts_from = "2026-10-13",
                        workouts_since = "2026-10-12T22:00:00.000Z",
                    ),
                )
            }
        }
        val clock = dev.centraid.shared.platform.FakeDeviceClock(epochMillis = epochMillisFromRfc3339("2026-10-20T10:00:00Z")!!)
        val placed = HealthImport.window(core.core(), clock)!!
        zones shouldContainExactly listOf(clock.read().zone)
        placed shouldBe HealthWindow(
            "2026-10-20",
            "2026-10-13",
            "2026-10-13",
            epochMillisFromRfc3339("2026-10-12T22:00:00Z")!!,
            listOf(HealthDayTotal("2026-10-18", "steps", 10.0)),
        )
    }

    "canonical numbers: integers as integers, reals to three places, trailing zeros dropped" {
        HealthImport.number(5_234.0) shouldBe "5234"
        HealthImport.number(5_234.5) shouldBe "5234.5"
        HealthImport.number(5_234.5671) shouldBe "5234.567"
        HealthImport.number(5_234.5670000001) shouldBe "5234.567"
        HealthImport.number(0.0004) shouldBe "0"
    }

    "every source has its question's words: HEALTH is in every exhaustive mapping" {
        PhoneSource.entries.forEach { source ->
            val asked = PhoneFollowWords.question(OriginGone(source, "o", "p", "L", 2, GoneReason.LEFT))
            asked.body.isNotEmpty() shouldBe true
            asked.keepLabel shouldBe "Keep"
        }
        PhoneSource.valueOf("HEALTH").wire shouldBe "health"
        listOf<String>().shouldBeEmpty()
    }
})
