package dev.centraid.shared.apps.health

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.Envelope
import centraid.core.v1.HealthFollowView
import centraid.core.v1.HealthFollowViewRequest
import centraid.core.v1.Request
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.kit.PhoneImport
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.phone.GoneChoice
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneFollowReads
import dev.centraid.shared.sync.phone.PhoneIds
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneRecord
import dev.centraid.shared.sync.phone.PhoneSnapshot
import dev.centraid.shared.sync.phone.PhoneSource
import dev.centraid.shared.sync.phone.PhoneSync
import dev.centraid.shared.sync.epochMillisFromRfc3339
import dev.centraid.shared.sync.rfc3339FromEpochMillis

/**
 * THE HEALTH STORE → HEALTH (#1129): one way, store → vault (R-1127-1, R-1129-7). A pass reads
 * the window the vault implies (R-1129-4), sends the day totals that changed (R-1129-3, through
 * [HealthDays]) and follows the workouts through [PhoneSync] unchanged (R-1129-2).
 *
 * ## A workout's identity
 *
 * Its phone id is `local:<store id>`: the store's id means something on this phone only
 * (R-1127-10), so a new phone re-finds a workout by its [matchKey] — the vault's kind key and the
 * start to the minute, UTC — and relinks it rather than adding a second one: in the same pass the
 * old phone's link is lost (R-1129-15), or later, as an unlinked row, by adoption. A workout gone
 * from the phone is kept, unlinked (R-1129-14). One origin per store:
 * `store:apple-health` labelled "Apple Health", `store:health-connect` labelled "Health Connect".
 *
 * ## The fingerprint
 *
 * Both halves are [fields] over the same seven facts: the kind key, the store's word, the span,
 * every measure and who recorded it. **Numbers are in one canonical text form on both sides**
 * ([number]): an integer as an integer, a real rounded to three decimals with its trailing zeros
 * dropped, so a value that comes back from the vault a float's breadth away from what was sent is
 * the same fact and never reads as an edit. Instants are both spelled as the vault spells them.
 * Health has no field a member edits in Centraid, so a workout detaches only if its row moves
 * under the engine.
 *
 * `Outcome.added` counts rows added, adopted and re-found; `trashed` counts workouts the phone no
 * longer has, which stay in Health unlinked.
 */
public object HealthImport {
    /** What one pass did. [read] is false when the vault could not be read and nothing was done. */
    public data class Outcome(
        public val days: Int = 0,
        public val added: Int = 0,
        public val updated: Int = 0,
        public val trashed: Int = 0,
        public val refused: Int = 0,
        public val gone: List<OriginGone> = emptyList(),
        public val read: Boolean = true,
    )

    /** The store's origin, as the vault names it. */
    public fun origin(store: HealthStoreKind): PhoneOriginRef = PhoneOriginRef(store.origin, store.label)

    /** A workout's phone id: the store's own, local to this phone (R-1127-10). */
    public fun phoneId(storeId: String): String = PhoneIds.local(storeId)

    /** What a new phone re-adopts a workout by: `<kind key>|<start, to the minute, UTC>`. */
    public fun matchKey(kind: String, startedAt: String): String {
        val instant = canonicalInstant(startedAt) ?: return ""
        return "$kind|${instant.take(MINUTE)}"
    }

    /** The fingerprint's facts, the same for a store workout and a vault row. */
    internal fun fields(
        kind: String,
        phoneKind: String,
        startedAt: String,
        endedAt: String,
        movingSec: Long?,
        distanceM: Double?,
        energyKcal: Double?,
        avgHrBpm: Long?,
        elevationGainM: Double?,
        recordedBy: String?,
    ): PhoneFields = PhoneFields.of {
        exact("kind", kind)
        exact("phone_kind", phoneKind)
        exact("span", "${canonicalInstant(startedAt) ?: startedAt}|${canonicalInstant(endedAt) ?: endedAt}")
        movingSec?.let { exact("moving_sec", it.toString()) }
        distanceM?.let { exact("distance_m", number(it)) }
        energyKcal?.let { exact("energy_kcal", number(it)) }
        avgHrBpm?.let { exact("avg_hr_bpm", it.toString()) }
        elevationGainM?.let { exact("elevation_gain_m", number(it)) }
        recordedBy?.let { text("recorded_by", it) }
    }

    /**
     * A REAL IN ITS ONE CANONICAL TEXT FORM: rounded to [DECIMALS] places, trailing zeros and a
     * bare point dropped (`5234.567`, `5234.5`, `5234`). Three decimals of a metre, a kilocalorie
     * or a metre of climb is below anything a store measures.
     */
    public fun number(value: Double): String {
        if (!value.isFinite()) return value.toString()
        val negative = value < 0
        val scaled = kotlin.math.round(kotlin.math.abs(value) * SCALE).toLong()
        val whole = scaled / SCALE.toLong()
        val fraction = (scaled % SCALE.toLong()).toString().padStart(DECIMALS, '0').trimEnd('0')
        val text = if (fraction.isEmpty()) whole.toString() else "$whole.$fraction"
        return if (negative && scaled != 0L) "-$text" else text
    }

    /** An instant as the vault spells it, `YYYY-MM-DDTHH:MM:SS.sssZ`, or null for one it would refuse. */
    public fun canonicalInstant(instant: String): String? =
        epochMillisFromRfc3339(instant.trim())?.let(::instantOf)

    /** `YYYY-MM-DDTHH:MM:SS.sssZ` for [epochMillis]: the form `health.follow_workout` is sent (RP-R-4). */
    public fun instantOf(epochMillis: Long): String {
        val millis = ((epochMillis % SECOND_MS) + SECOND_MS) % SECOND_MS
        return rfc3339FromEpochMillis(epochMillis).dropLast(1) + "." + millis.toString().padStart(3, '0') + "Z"
    }

    /**
     * A READ OF THE STORE AS A WORKOUT SNAPSHOT. Its one origin is the store, while the store is on
     * the phone. **Complete only when the read says so, it found at least one workout, and the
     * member chose workouts and the OS allowed them** (R-1129-5): otherwise nothing is removed.
     * A store no longer on the phone is a complete read of no origin, which is what holds its
     * workouts for the member's answer (R-1127-9).
     */
    public fun snapshot(read: HealthRead, window: HealthWindow, readAt: String): PhoneSnapshot {
        if (!read.storePresent) return PhoneSnapshot(PhoneSource.HEALTH, complete = true, readAt = readAt, origins = emptyList(), records = emptyList())
        val origin = origin(read.store)
        val seen = mutableSetOf<String>()
        val records = read.workouts.mapNotNull { workout ->
            val started = epochMillisFromRfc3339(workout.startedAt.trim()) ?: return@mapNotNull null
            val ended = epochMillisFromRfc3339(workout.endedAt.trim()) ?: return@mapNotNull null
            val id = phoneId(workout.id.trim())
            if (workout.id.isBlank() || workout.kind.isBlank() || ended < started || started < window.workoutsSince || !seen.add(id)) {
                return@mapNotNull null
            }
            val kind = HealthKinds.key(workout.kind)
            val tidy = workout.copy(
                kind = workout.kind.trim(),
                startedAt = instantOf(started),
                endedAt = instantOf(ended),
                movingSec = workout.movingSec?.takeIf { it > 0 },
                distanceM = workout.distanceM?.takeIf { it.isFinite() && it >= 0.0 },
                energyKcal = workout.energyKcal?.takeIf { it.isFinite() && it >= 0.0 },
                avgHrBpm = workout.avgHrBpm?.takeIf { it > 0 },
                elevationGainM = workout.elevationGainM?.takeIf { it.isFinite() && it >= 0.0 },
                recordedBy = workout.recordedBy?.let(PhoneFields::squash)?.takeIf { it.isNotEmpty() },
            )
            PhoneRecord(
                phoneId = id,
                origin = origin.id,
                fields = fields(
                    kind, tidy.kind, tidy.startedAt, tidy.endedAt, tidy.movingSec, tidy.distanceM,
                    tidy.energyKcal, tidy.avgHrBpm, tidy.elevationGainM, tidy.recordedBy,
                ),
                matchKey = matchKey(kind, tidy.startedAt),
                attributes = WorkoutAttributes(kind, tidy),
            )
        }
        val workoutsAllowed = HealthMetrics.WORKOUTS in read.chosen && HealthMetrics.WORKOUTS !in read.refused
        val complete = read.workoutsComplete && workoutsAllowed && records.isNotEmpty()
        return PhoneSnapshot(PhoneSource.HEALTH, complete, readAt, listOf(origin), records)
    }

    /** `health.follow_workout`'s input for [workout] on [activityId]. */
    internal fun followInput(activityId: String, workout: WorkoutAttributes): String {
        val w = workout.workout
        return buildString {
            append("{\"activity_id\":").append(q(activityId))
            append(",\"kind\":").append(q(workout.kind))
            append(",\"phone_kind\":").append(q(w.kind))
            append(",\"started_at\":").append(q(w.startedAt))
            append(",\"ended_at\":").append(q(w.endedAt))
            w.recordedBy?.let { append(",\"recorded_by\":").append(q(it)) }
            w.movingSec?.let { append(",\"moving_sec\":").append(it) }
            w.distanceM?.let { append(",\"distance_m\":").append(it) }
            w.energyKcal?.let { append(",\"energy_kcal\":").append(it) }
            w.avgHrBpm?.let { append(",\"avg_hr_bpm\":").append(it) }
            w.elevationGainM?.let { append(",\"elevation_gain_m\":").append(it) }
            append("}")
        }
    }

    /** `health.record_days`' input: the values as the store stated them, never rounded. */
    internal fun recordInput(days: List<HealthDayTotal>): String = days.joinToString(",", "{\"days\":[", "]}") {
        "{\"day\":${q(it.day)},\"metric\":${q(it.metric)},\"value\":${it.value}}"
    }

    /** What the vault holds for the follower in [tz]: the window and every day in it. Null when unreadable. */
    public suspend fun view(core: CentraidCore, tz: String): HealthFollowView? {
        val answer = core.call(
            Envelope(request_id = 0, request = Request(app_query = AppQueryRequest(health_follow_view = HealthFollowViewRequest(tz = tz)))),
        )
        val response = (answer as? CoreOutcome.Answered)?.value?.response?.app_query ?: return null
        return response.health_follow_view
    }

    /**
     * THE WINDOW THE NEXT PASS READS (R-1129-4), as the core placed it in the device's zone out
     * of what the vault holds now, with the days the vault holds in it. Null when the vault would
     * not say.
     */
    public suspend fun window(core: CentraidCore, clock: DeviceClock): HealthWindow? {
        val view = view(core, clock.read().zone) ?: return null
        val since = epochMillisFromRfc3339(view.workouts_since) ?: return null
        val held = view.days.mapNotNull { day ->
            HealthMetrics.ofWire(day.metric)?.let { HealthDayTotal(day.day, it.key, day.value_) }
        }
        return HealthWindow(view.today, view.totals_from, view.workouts_from, since, held)
    }

    /**
     * ONE PASS over [read] for [window]: the days that changed, then the workouts. A store no
     * longer on the phone sends no days (there is nothing to read them from) and holds its
     * workouts for the member's answer.
     */
    public suspend fun run(core: CentraidCore, read: HealthRead, window: HealthWindow, readAt: String): Outcome {
        var days = 0
        var refused = 0
        if (read.storePresent) {
            for (batch in HealthDays.changes(read.days, window.held, window.totalsFrom, window.today).chunked(HealthDays.BATCH)) {
                if (PhoneImport.executed(core, HealthStore.RECORD, recordInput(batch)) != null) days += batch.size else refused += batch.size
            }
        }
        val report = PhoneSync.run(HealthStore(core, window.workoutsSince), snapshot(read, window, readAt))
        return Outcome(
            days = days,
            added = report.added + report.adopted + report.refound,
            updated = report.updated,
            trashed = report.trashed,
            refused = refused + report.refused.size,
            gone = report.gone,
            read = report.read,
        )
    }

    /** A pass as the follower runs it: the window, the shell's read, the pass. Null when there was nothing to do. */
    public suspend fun pass(core: CentraidCore, reader: HealthReader, clock: DeviceClock): Outcome? {
        val window = window(core, clock) ?: return null
        val read = PhoneFollowReads.await<HealthRead> { reader.read(window, it) } ?: return null
        return run(core, read, window, rfc3339Millis(clock))
    }

    /**
     * The member's answer to the store's workouts held (R-1127-9): [GoneChoice.KEEP] is the default;
     * the other is the member's own "Delete them", the one answer that purges (R-1129-14).
     */
    public suspend fun resolveGone(core: CentraidCore, originId: String, choice: GoneChoice, seenBefore: String? = null): Outcome {
        val report = PhoneSync.resolveGone(HealthStore(core, purge = true), originId, choice, seenBefore)
        return Outcome(trashed = report.trashed, refused = report.refused.size, read = report.read)
    }

    /**
     * CONNECT: the store's origin is written at once — that is what makes Health followed
     * (R-1127-14) — and the first pass runs (a year of days, 90 days of workouts, R-1129-4).
     * Null when the vault refused the origin.
     */
    public suspend fun connect(core: CentraidCore, store: HealthStoreKind, reader: HealthReader, clock: DeviceClock): Outcome? {
        val origin = origin(store)
        HealthStore(core).origin(origin.id, origin.label) ?: return null
        return pass(core, reader, clock) ?: Outcome()
    }

    /**
     * STOP READING: every health link is forgotten and every health origin retired. **Every day
     * and every workout stays**, an ordinary row from now on. False when the vault refused part of
     * it (the rest is done, and stopping again finishes it).
     */
    public suspend fun stop(core: CentraidCore): Boolean {
        val store = HealthStore(core)
        val links = store.links() ?: return false
        val origins = store.origins() ?: return false
        var clean = true
        for (link in links) clean = store.forget(link.linkId) && clean
        for (origin in origins) clean = store.retireOrigin(origin.originId) && clean
        return clean
    }

    /** Whether the vault follows a health store: it holds an origin for one. */
    public suspend fun connected(core: CentraidCore): Boolean? = PhoneFollowReads.imported(core, PhoneSource.HEALTH)

    private fun rfc3339Millis(clock: DeviceClock): String = instantOf(clock.read().epochMillis)

    private fun q(value: String): String = PhoneImport.quote(value)

    private const val MINUTE: Int = 16
    private const val DECIMALS: Int = 3
    private const val SCALE: Double = 1_000.0
    private const val SECOND_MS: Long = 1_000L
}
