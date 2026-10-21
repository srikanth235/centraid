package dev.centraid.shared

import centraid.core.v1.AppQueryResponse
import centraid.core.v1.HealthBucket
import centraid.core.v1.HealthKindCount
import centraid.core.v1.HealthMetric
import centraid.core.v1.HealthRange
import centraid.core.v1.HealthSeries
import centraid.core.v1.HealthToday
import centraid.core.v1.HealthTodayMetric
import centraid.core.v1.HealthTrend
import centraid.core.v1.HealthTrendRange
import centraid.core.v1.HealthTrends
import centraid.core.v1.HealthWorkout
import centraid.core.v1.HealthWorkoutRow
import centraid.core.v1.HealthWorkouts
import centraid.core.v1.HealthWorkoutsCursor
import centraid.screen.v1.HealthConnectEvent
import centraid.screen.v1.HealthDevice
import centraid.screen.v1.HealthHomeEvent
import centraid.screen.v1.HealthHomeState
import centraid.screen.v1.HealthMetricEvent
import centraid.screen.v1.HealthMetricState
import centraid.screen.v1.HealthTrendRow
import centraid.screen.v1.HealthWorkoutEvent
import centraid.screen.v1.StatusChip
import dev.centraid.shared.apps.health.HealthConnectMachine
import dev.centraid.shared.apps.health.HealthDevices
import dev.centraid.shared.apps.health.HealthHeld
import dev.centraid.shared.apps.health.HealthHomeMachine
import dev.centraid.shared.apps.health.HealthHomeReads
import dev.centraid.shared.apps.health.HealthInput
import dev.centraid.shared.apps.health.HealthMetricMachine
import dev.centraid.shared.apps.health.HealthRouting
import dev.centraid.shared.apps.health.HealthWorkoutMachine
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavMove
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain

/**
 * HEALTH'S SCREENS AS MACHINES (#1129): the words, the units, the empty and the connected states,
 * the band, More's rows and the routes, from the core's typed answers. Every figure in a fixture
 * is what `health.*` would answer; the machines only format.
 */
class HealthScreensSpec : StringSpec({
    val today = "2026-10-20"
    val apple = HealthDevice(
        store = HealthDevice.Store.STORE_APPLE_HEALTH,
        units = HealthDevice.Units.UNITS_METRIC,
        chosen = listOf("steps", "sleep_min", "weight_kg", "workouts"),
    )
    val run = HealthWorkoutRow(
        activity_id = "a1",
        kind_concept_id = "health:kind:run",
        kind_key = "run",
        kind_label = "run",
        phone_kind = "running",
        started_at = "2026-10-20T06:10:00.000Z",
        ended_at = "2026-10-20T06:41:00.000Z",
        moving_sec = 1_864,
        distance_m = 5_200.0,
        energy_kcal = 338.0,
        avg_hr_bpm = 148,
        elevation_gain_m = 42.0,
        recorded_by = "Apple Watch",
        // The core's readings in the device's zone (Europe/Berlin, +01:00 that morning).
        local_start = "2026-10-20T07:10",
        local_end = "2026-10-20T07:41",
        length_sec = 1_864,
    )

    fun metric(m: HealthMetric, value: Double?, typical: Double?, low: Double? = null, high: Double? = null, day: String? = today) =
        HealthTodayMetric(metric = m, value_ = value, day = if (value == null) null else day, typical = typical, low = low, high = high, typical_days = 30)

    val connectedToday = HealthToday(
        today = today,
        connected = true,
        metrics = listOf(
            metric(HealthMetric.HEALTH_METRIC_STEPS, 8_412.0, 7_100.0, 5_000.0, 9_000.0),
            metric(HealthMetric.HEALTH_METRIC_SLEEP_MIN, 432.0, 410.0, 380.0, 450.0),
            metric(HealthMetric.HEALTH_METRIC_ACTIVE_ENERGY_KCAL, 412.0, 380.0, 300.0, 450.0),
            metric(HealthMetric.HEALTH_METRIC_EXERCISE_MIN, null, 22.0, 10.0, 30.0),
            metric(HealthMetric.HEALTH_METRIC_RESTING_HR_BPM, 58.0, 59.0, 57.0, 61.0),
            metric(HealthMetric.HEALTH_METRIC_WEIGHT_KG, 71.4, 71.6, 71.2, 72.0, day = "2026-10-19"),
        ),
        workouts = listOf(run),
        metrics_with_data = listOf(HealthMetric.HEALTH_METRIC_STEPS, HealthMetric.HEALTH_METRIC_WEIGHT_KG),
    )

    fun home(device: HealthDevice = apple, destination: HealthHomeState.Destination = HealthHomeState.Destination.DESTINATION_TODAY): HealthHeld<HealthHomeState> {
        val machine = HealthHomeMachine
        return machine.reduce(machine.initial(), HealthInput.View(HealthHomeEvent(opened = HealthHomeEvent.Opened(destination = destination, device = device)))).state
    }

    fun HealthHeld<HealthHomeState>.answered(vararg answers: AppQueryResponse) =
        HealthHomeMachine.reduce(this, HealthInput.Answered(answers.toList())).state

    fun HealthHeld<HealthHomeState>.on(event: HealthHomeEvent) = HealthHomeMachine.reduce(this, HealthInput.View(event))

    "nothing connected: every tab is one sentence and Connect, naming the phone's store" {
        val held = home().answered(AppQueryResponse(health_today = HealthToday(today = today, connected = false)))
        val data = held.screen.data_.shouldNotBeNull()
        data.empty.shouldNotBeNull().headline shouldBe "Bring in your steps, sleep and workouts from Apple Health."
        data.empty!!.action_label shouldBe "Connect Apple Health"
        data.today_data.shouldBeNull()
        held.screen.band.map { it.label } shouldContainExactly listOf("Today", "Trends", "Workouts", "More")
        held.screen.more_rows.map { it.key } shouldContainExactly listOf("reads", "choose")
        HealthRouting.home(HealthHomeEvent(connect = HealthHomeEvent.ConnectOpened()), held.screen) shouldBe
            Destination.HealthConnect(parent = "Health")
    }

    "today: the day's numbers against the member's own typical, in the member's words" {
        val held = home().answered(AppQueryResponse(health_today = connectedToday))
        val today = held.screen.data_.shouldNotBeNull().today_data.shouldNotBeNull()
        today.hero.shouldNotBeNull().let { hero ->
            hero.value_ shouldBe "8,412"
            hero.when_label shouldBe "So far today"
            hero.typical shouldBe "7,100 typical"
            hero.bar.shouldNotBeNull().middle_label shouldBe "your typical day"
            hero.bar!!.end_label shouldBe "12,000"
            (hero.bar!!.low_bp < hero.bar!!.high_bp) shouldBe true
        }
        today.metrics.map { it.label } shouldContainExactly listOf("Sleep", "Active energy", "Exercise", "Resting heart rate", "Weight")
        today.metrics[0].value_ shouldBe "7 h 12 m"
        today.metrics[0].when_label shouldBe "Last night"
        today.metrics[0].typical shouldBe "6 h 50 m typical"
        today.metrics[1].unit shouldBe "kcal"
        today.metrics[2].value_ shouldBe ""
        today.metrics[2].when_label shouldBe "Nothing yet today"
        today.metrics[2].bar.shouldNotBeNull().has_value shouldBe false
        today.metrics[3].typical shouldBe "57–61 typical"
        today.metrics[4].value_ shouldBe "71.4"
        today.metrics[4].when_label shouldBe "Yesterday"
        today.workouts_heading shouldBe "Workouts today"
        today.workouts.single().let { line ->
            line.title shouldBe "Morning run"
            line.meta shouldBe "5.2 km · 31 min"
            line.when_label shouldBe "07:10"
        }
        // R-1129-13: where the numbers come from, and no time.
        today.foot shouldBe "Read from Apple Health"
    }

    "units are the phone's: imperial weighs in pounds and runs in miles" {
        val held = home(apple.copy(units = HealthDevice.Units.UNITS_IMPERIAL)).answered(AppQueryResponse(health_today = connectedToday))
        val today = held.screen.data_!!.today_data!!
        today.metrics[4].value_ shouldBe "157.4"
        today.metrics[4].unit shouldBe "lb"
        today.workouts.single().meta shouldBe "3.2 mi · 31 min"
    }

    "More: what Health may read, Chat's line, a chosen type that read nothing, and the stop behind a confirm" {
        val held = home().answered(AppQueryResponse(health_today = connectedToday))
        held.screen.more_rows.map { it.key } shouldContainExactly listOf("reads", "choose", "stop")
        held.screen.more_rows.last().label shouldBe "Stop reading Apple Health"
        held.screen.more_rows.last().tone shouldBe StatusChip.Tone.TONE_NET
        val facts = held.screen.reads_facts.map { it.label to it.detail }
        facts shouldContainExactly listOf(
            "Reads" to "daily totals and workouts",
            "Writes" to "nothing to Apple Health",
            "Chat" to "doesn’t read Health",
            // Sleep was chosen and read nothing in the year: HealthKit cannot say it was refused.
            "Nothing read" to "Sleep: see Settings › Health › Data Access",
        )
        val reads = held.on(HealthHomeEvent(more = HealthHomeEvent.MorePicked(key = "reads"))).state
        reads.screen.sheet shouldBe HealthHomeState.Sheet.SHEET_READS
        val stop = held.on(HealthHomeEvent(more = HealthHomeEvent.MorePicked(key = "stop"))).state
        stop.screen.sheet shouldBe HealthHomeState.Sheet.SHEET_STOP
        stop.screen.chrome!!.stop_title shouldBe "Stop reading Apple Health?"
        stop.on(HealthHomeEvent(stop = HealthHomeEvent.StopConfirmed())).state.screen.sheet shouldBe HealthHomeState.Sheet.SHEET_NONE
        HealthRouting.home(HealthHomeEvent(more = HealthHomeEvent.MorePicked(key = "choose")), held.screen) shouldBe
            Destination.HealthConnect(parent = "Health")
    }

    "Health Connect names a refused type exactly" {
        val android = HealthDevice(
            store = HealthDevice.Store.STORE_HEALTH_CONNECT,
            units = HealthDevice.Units.UNITS_METRIC,
            chosen = listOf("steps", "sleep_min"),
            refused = listOf("sleep_min"),
        )
        val facts = home(android).answered(AppQueryResponse(health_today = connectedToday)).screen.reads_facts
        facts.last().label shouldBe "Not allowed"
        facts.last().detail shouldBe "Sleep: change it in Health Connect"
        facts.none { it.label == "Nothing read" } shouldBe true
    }

    "trends: per-metric deltas against the period before, a sparkline with gaps, the range a segment" {
        val held = home(destination = HealthHomeState.Destination.DESTINATION_TRENDS).answered(
            AppQueryResponse(health_today = connectedToday),
            AppQueryResponse(
                health_trends = HealthTrends(
                    range = HealthTrendRange.HEALTH_TREND_RANGE_DAYS_30,
                    today = today,
                    trends = listOf(
                        HealthTrend(
                            metric = HealthMetric.HEALTH_METRIC_STEPS,
                            average = 7_310.0,
                            previous = 7_030.0,
                            change = 280.0,
                            change_pct = 280.0 / 7_030.0 * 100.0,
                            buckets = listOf(HealthBucket(value_ = 6_800.0), HealthBucket(), HealthBucket(value_ = 8_100.0)),
                        ),
                        HealthTrend(metric = HealthMetric.HEALTH_METRIC_EXERCISE_MIN, average = 26.0, previous = 21.0, change = 5.0, change_pct = 5.0 / 21.0 * 100.0),
                        HealthTrend(metric = HealthMetric.HEALTH_METRIC_RESTING_HR_BPM, average = 58.2, previous = 58.4, change = -0.2, change_pct = -0.2 / 58.4 * 100.0),
                        HealthTrend(metric = HealthMetric.HEALTH_METRIC_SLEEP_MIN, average = 418.0),
                    ),
                ),
            ),
        )
        val trends = held.screen.data_!!.trends.shouldNotBeNull()
        trends.compare_line shouldBe "Last 30 days, against the 30 days before"
        trends.rows[0].let {
            it.value_ shouldBe "7,310"
            it.unit shouldBe "a day"
            it.delta shouldBe "+4%"
            it.direction shouldBe HealthTrendRow.Direction.DIRECTION_UP
            it.points_bp shouldContainExactly listOf(0, -1, 10_000)
        }
        trends.rows[1].delta shouldBe "+5 min"
        trends.rows[1].unit shouldBe "min a day"
        trends.rows[2].direction shouldBe HealthTrendRow.Direction.DIRECTION_FLAT
        trends.rows[3].delta shouldBe ""
        trends.rows[3].unit shouldBe "a night"
        held.screen.segments.map { it.label to it.active } shouldContainExactly listOf("30 days" to true, "90 days" to false, "Year" to false)
        val moved = held.on(HealthHomeEvent(range = HealthHomeEvent.RangePicked(key = "year")))
        moved.state.screen.trend_range shouldBe HealthHomeState.TrendRange.TREND_RANGE_YEAR
        moved.effects shouldContainExactly listOf(ScreenEffect.ReadPage(HealthHomeMachine.SCREEN_ID, afterCursor = null))
    }

    "workouts: All and each kind present, this week then by month, newest first, a page at a time" {
        val older = run.copy(
            activity_id = "a2", kind_key = "cycle", started_at = "2026-09-30T16:00:00.000Z", ended_at = "2026-09-30T17:00:00.000Z", moving_sec = null,
            local_start = "2026-09-30T18:00", local_end = "2026-09-30T19:00", length_sec = 3_600,
        )
        val held = home(destination = HealthHomeState.Destination.DESTINATION_WORKOUTS).answered(
            AppQueryResponse(health_today = connectedToday),
            AppQueryResponse(
                health_workouts = HealthWorkouts(
                    workouts = listOf(run, older),
                    kinds = listOf(
                        HealthKindCount(kind_concept_id = "health:kind:run", kind_key = "run", kind_label = "run", count = 3),
                        HealthKindCount(kind_concept_id = "health:kind:cycle", kind_key = "cycle", kind_label = "cycle", count = 1),
                    ),
                    next = HealthWorkoutsCursor(started_at = older.started_at, activity_id = "a2"),
                ),
            ),
        )
        val data = held.screen.data_!!.workouts.shouldNotBeNull()
        data.sections.map { it.heading } shouldContainExactly listOf("This week", "September")
        data.sections[1].rows.single().let {
            it.title shouldBe "Evening ride"
            it.meta shouldBe "5.2 km · 1 h 00 min"
            it.when_label shouldBe "30 Sep"
        }
        data.more shouldBe true
        held.screen.chips.map { it.label } shouldContainExactly listOf("All", "Runs", "Rides")
        val picked = held.on(HealthHomeEvent(kind_picked = HealthHomeEvent.KindPicked(kind_concept_id = "health:kind:run")))
        picked.state.screen.kind_concept_id shouldBe "health:kind:run"
        picked.effects.single() shouldBe ScreenEffect.ReadPage(HealthHomeMachine.SCREEN_ID, afterCursor = null)
        HealthRouting.home(HealthHomeEvent(workout = HealthHomeEvent.WorkoutPicked(activity_id = "a2")), held.screen) shouldBe
            Destination.HealthWorkout("a2", "Health")
        HealthRouting.home(HealthHomeEvent(metric = HealthHomeEvent.MetricPicked(metric = "steps")), held.screen) shouldBe
            Destination.HealthMetric("steps", "Health")
        HealthRouting.home(HealthHomeEvent(metric = HealthHomeEvent.MetricPicked(metric = "nonsense")), held.screen).shouldBeNull()
    }

    "home reads health.today first, in the device's zone, and the core places the day" {
        val clock = dev.centraid.shared.platform.FakeDeviceClock(zone = "Europe/Berlin")
        HealthHomeReads.requests(home(), clock.read())!!.single().health_today!!.tz shouldBe "Europe/Berlin"
        HealthHomeReads.requests(home(destination = HealthHomeState.Destination.DESTINATION_WORKOUTS), clock.read())!!.let {
            it.size shouldBe 2
            it[0].health_today.shouldNotBeNull()
            it[1].health_workouts.shouldNotBeNull().limit shouldBe HealthHomeMachine.PAGE
            it[1].health_workouts!!.tz shouldBe "Europe/Berlin"
        }
    }

    "a metric: the week's bars, the typical line, its facts" {
        val machine = HealthMetricMachine
        val opened = machine.reduce(
            machine.initial(),
            HealthInput.View(HealthMetricEvent(opened = HealthMetricEvent.Opened(metric = "steps", parent = "Health", device = apple))),
        ).state
        opened.screen.chrome!!.title shouldBe "Steps"
        opened.screen.chrome!!.back_label shouldBe "Health"
        val days = listOf("2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20")
        val values = listOf(6_200.0, 9_100.0, null, 4_800.0, 11_200.0, 7_700.0, 8_412.0)
        val series = HealthSeries(
            metric = HealthMetric.HEALTH_METRIC_STEPS,
            range = HealthRange.HEALTH_RANGE_WEEK,
            today = today,
            buckets = days.zip(values).map { (d, v) -> HealthBucket(start = d, end = d, value_ = v, days = if (v == null) 0 else 1) },
            average = 7_902.0,
            previous_average = 7_500.0,
            typical = 7_100.0,
            best = HealthBucket(start = "2026-10-18", end = "2026-10-18", value_ = 11_200.0, days = 1),
            total = 47_412.0,
            above_typical = 4,
            counted = 6,
            versus_typical = 802.0,
            versus_typical_pct = 802.0 / 7_100.0 * 100.0,
        )
        val held = machine.reduce(opened, HealthInput.Answered(listOf(AppQueryResponse(health_series = series)))).state
        val data = held.screen.data_.shouldNotBeNull()
        data.caption shouldBe "Wed 14 – Tue 20 October"
        data.average shouldBe "7,902"
        data.average_unit shouldBe "a day"
        data.versus shouldBe "11% above your typical"
        data.bars.map { it.has_value } shouldContainExactly listOf(true, true, false, true, true, true, true)
        data.bars.last().current shouldBe true
        data.has_typical shouldBe true
        data.ticks shouldContainExactly listOf("W", "T", "F", "S", "S", "M", "T")
        data.facts.map { it.label to it.detail } shouldContainExactly listOf(
            "Best day" to "Sun 18 · 11,200",
            "Total" to "47,412 steps",
            "Days above typical" to "4 of 6",
        )
        data.foot shouldBe "Each day is the total Apple Health keeps."
        held.screen.segments.map { it.key } shouldContainExactly listOf("week", "month", "year")
        machine.reduce(held, HealthInput.View(HealthMetricEvent(range = HealthMetricEvent.RangePicked(key = "month")))).let {
            it.state.screen.range shouldBe HealthMetricState.Range.RANGE_MONTH
            it.effects.single() shouldBe ScreenEffect.ReadPage(HealthMetricMachine.SCREEN_ID, afterCursor = null)
        }
    }

    "a workout: the store's figures in the member's units, who recorded it, and no splits" {
        val machine = HealthWorkoutMachine
        val opened = machine.reduce(
            machine.initial(),
            HealthInput.View(HealthWorkoutEvent(opened = HealthWorkoutEvent.Opened(activity_id = "a1", parent = "Today", device = apple))),
        ).state
        val held = machine.reduce(opened, HealthInput.Answered(listOf(AppQueryResponse(health_workout = HealthWorkout(workout = run))))).state
        val data = held.screen.data_.shouldNotBeNull()
        held.screen.chrome!!.title shouldBe "Run"
        data.title shouldBe "Morning run"
        data.when_label shouldBe "Tue 20 October, 07:10 to 07:41"
        data.figures.map { Triple(it.label, it.value_, it.unit) } shouldContainExactly listOf(
            Triple("Distance", "5.2", "km"),
            Triple("Time", "31:04", ""),
            Triple("Average pace", "5:58", "/km"),
            Triple("Active energy", "338", "kcal"),
            Triple("Average heart rate", "148", "bpm"),
            Triple("Elevation gain", "42", "m"),
        )
        data.foot shouldBe "Recorded by Apple Watch, read from Apple Health. Route and splits stay in Apple Health."
        val gone = machine.reduce(opened, HealthInput.Answered(listOf(AppQueryResponse(health_workout = HealthWorkout())))).state
        gone.screen.data_!!.gone.shouldNotBeNull().headline shouldBe "This workout is no longer here."
    }

    "connect: every type on the first time, energy is two types, none chosen cannot connect" {
        val machine = HealthConnectMachine
        val opened = machine.reduce(
            machine.initial(),
            HealthConnectEvent(opened = HealthConnectEvent.Opened(parent = "Health", device = apple.copy(chosen = emptyList()))),
        ).state
        opened.choices.map { it.label } shouldContainExactly listOf("Steps", "Sleep", "Active energy and exercise", "Resting heart rate", "Weight", "Workouts")
        opened.choices.all { it.on } shouldBe true
        opened.chosen shouldContainExactly listOf("steps", "sleep_min", "active_energy_kcal", "exercise_min", "resting_hr_bpm", "weight_kg", "workouts")
        opened.connect_label shouldBe "Connect Apple Health"
        opened.can_connect shouldBe true
        opened.lede shouldContain "Nothing is written back."
        // What the member chose last time is what is on.
        val again = machine.reduce(machine.initial(), HealthConnectEvent(opened = HealthConnectEvent.Opened(device = apple))).state
        again.choices.filter { it.on }.map { it.key } shouldContainExactly listOf("steps", "sleep_min", "weight_kg", "workouts")
        var state = opened
        for (key in HealthConnectMachine.KEYS.keys) state = machine.reduce(state, HealthConnectEvent(toggled = HealthConnectEvent.Toggled(key = key))).state
        state.can_connect shouldBe false
        state.status shouldBe "Choose at least one to connect"
        machine.reduce(state, HealthConnectEvent(connect = HealthConnectEvent.ConnectTapped())).state.working shouldBe false
        val working = machine.reduce(opened, HealthConnectEvent(connect = HealthConnectEvent.ConnectTapped())).state
        working.working shouldBe true
        working.can_connect shouldBe false
        working.status shouldBe "Reading Apple Health…"
        machine.reduce(working, HealthConnectEvent(failed = HealthConnectEvent.Failed())).state.status shouldBe "Apple Health didn’t answer. Try again."
        HealthRouting.connect(HealthConnectEvent(connected = HealthConnectEvent.Connected()), working) shouldBe NavMove.Pop
    }

    "the phone's facts are stamped on a route's Opened, so a shell that sends bytes never spells them" {
        HealthDevices.update("health-connect", metric = false, chosen = listOf("steps"), refused = emptyList())
        try {
            val bytes = HealthRouting.opened(
                HealthHomeMachine.SCREEN_ID,
                HealthHomeEvent(opened = HealthHomeEvent.Opened(destination = HealthHomeState.Destination.DESTINATION_TRENDS)).encode(),
            )
            val opened = HealthHomeEvent.ADAPTER.decode(bytes).opened.shouldNotBeNull()
            opened.destination shouldBe HealthHomeState.Destination.DESTINATION_TRENDS
            opened.device!!.store shouldBe HealthDevice.Store.STORE_HEALTH_CONNECT
            opened.device!!.units shouldBe HealthDevice.Units.UNITS_IMPERIAL
        } finally {
            HealthDevices.update(HealthDevice(units = HealthDevice.Units.UNITS_METRIC))
        }
    }

    "a change to the days, the workouts, their kinds or the store's origin re-reads home, and nothing else does" {
        listOf("health_daily", "health_workout", "core_activity", "core_concept", "phone_origin").forEach {
            HealthHomeMachine.rowsChanged(it, emptyList()).shouldNotBeNull()
        }
        HealthHomeMachine.rowsChanged("core_party", emptyList()).shouldBeNull()
        HealthMetricMachine.rowsChanged("health_workout", emptyList()).shouldBeNull()
    }

    "Home's tile: today's steps and last night's sleep, connect when nothing is, and never a zero it was not told" {
        val tile = dev.centraid.shared.shell.HomeHealthTile.arrived(connectedToday).tile.shouldNotBeNull()
        tile.status shouldBe centraid.screen.v1.TileStatus.TILE_STATUS_CONTENT
        tile.body!!.health.shouldNotBeNull().let {
            it.figure shouldBe "8,412"
            it.caption shouldBe "steps today"
            it.line shouldBe "Slept 7 h 12 m"
        }
        val spoken = dev.centraid.shared.shell.HomeTileWords.spoken(
            centraid.screen.v1.HomeTile(app_id = "health", status = tile.status, body = tile.body),
        )
        spoken.second shouldBe "Open Health, 8,412 steps today, Slept 7 h 12 m"
        val quiet = dev.centraid.shared.shell.HomeHealthTile.arrived(connectedToday.copy(metrics = emptyList())).tile!!.body!!.health!!
        quiet.figure shouldBe ""
        quiet.caption shouldBe "Nothing yet today"
        quiet.line shouldBe ""
        dev.centraid.shared.shell.HomeHealthTile.arrived(HealthToday(today = today, connected = false)).tile!!.status shouldBe
            centraid.screen.v1.TileStatus.TILE_STATUS_EMPTY
        val clock = dev.centraid.shared.platform.FakeDeviceClock(zone = "America/New_York")
        dev.centraid.shared.shell.HomeHealthTile.request(clock).health_today!!.tz shouldBe "America/New_York"
        dev.centraid.shared.shell.SpringboardPolicy.SPRINGBOARD_ORDER.indexOf("health") shouldBe
            dev.centraid.shared.shell.SpringboardPolicy.SPRINGBOARD_ORDER.indexOf("money") + 1
        dev.centraid.shared.shell.SpringboardPolicy.tileSize("health") shouldBe centraid.screen.v1.TileSize.TILE_SIZE_SMALL
    }

    "each workout kind has its own mark from the registry, and a kind with none keeps the workout mark" {
        val kinds = listOf("run", "walk", "cycle", "swim", "hike", "yoga")
        val marks = kinds.map { dev.centraid.shared.apps.health.HealthFold.kindIcon(it) }
        marks.toSet().size shouldBe kinds.size
        (marks + listOf("strength", "other", "EXERCISE_TYPE_TENNIS").map { dev.centraid.shared.apps.health.HealthFold.kindIcon(it) }).forEach {
            dev.centraid.design.CentraidCatalog.icons.containsKey(it) shouldBe true
        }
        dev.centraid.shared.apps.health.HealthFold.kindIcon("strength") shouldBe "Gym"
        dev.centraid.shared.apps.health.HealthFold.kindIcon("EXERCISE_TYPE_TENNIS") shouldBe "Gym"
        dev.centraid.shared.apps.health.HealthFold.line(run, today, HealthDevice.Units.UNITS_METRIC).icon_key shouldBe "Activity"
    }

    "a chart's ticks are marked back from today at one step, so the last two never collide" {
        fun days(n: Int) = (n - 1 downTo 0).map { back ->
            val day = dev.centraid.shared.kit.time.plusDays("2026-10-21", -back)!!
            HealthBucket(start = day, end = day)
        }
        val month = HealthMetricMachine.ticks(HealthMetricState.Range.RANGE_MONTH, days(30))
        month shouldContainExactly listOf("23 Sep", "30 Sep", "7 Oct", "14 Oct", "21 Oct")
        val months = (0 until 12).map { i ->
            val m = ((10 + i) % 12) + 1
            val y = if (m >= 11) 2025 else 2026
            HealthBucket(start = "$y-${m.toString().padStart(2, '0')}-01")
        }
        HealthMetricMachine.ticks(HealthMetricState.Range.RANGE_YEAR, months) shouldContainExactly listOf("Jan", "Apr", "Jul", "Oct")
        HealthMetricMachine.ticks(HealthMetricState.Range.RANGE_WEEK, days(7)).size shouldBe 7
    }
})
