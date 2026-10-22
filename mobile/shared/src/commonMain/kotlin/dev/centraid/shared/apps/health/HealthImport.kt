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
import dev.centraid.shared.sync.epochMillisFromRfc3339
import dev.centraid.shared.sync.phone.PhoneDevice
import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneFollowReads
import dev.centraid.shared.sync.phone.PhoneIds
import dev.centraid.shared.sync.phone.PhoneSource
import dev.centraid.shared.sync.rfc3339FromEpochMillis

/**
 * THE HEALTH STORE → HEALTH (#1129, #1135): one way, store → vault (R-1127-1, R-1129-7). A pass
 * reads the window the vault implies (R-1129-4), sends the day totals that changed
 * (`measurement.record`, through [HealthDays], R-1129-3) and follows the workouts through
 * `follow.health`.
 *
 * ## A workout's identity
 *
 * Its source id is `local:<store id>` on this device: the store's id means something on this
 * phone only (R-1127-10), so the vault matches a workout a new phone sends by its kind and its
 * start to the minute, and relinks the row it already holds rather than adding a second one
 * (R-1129-15). One origin per store: `store:apple-health` labelled "Apple Health",
 * `store:health-connect` labelled "Health Connect".
 *
 * ## Who decides what a pass leaves behind
 *
 * The vault. A workout gone from a complete read keeps its row and loses its source
 * (R-1129-14), only for workouts dated inside the window the pass read (`since`), and a pass
 * never deletes one. There is no fingerprint here, no link and nothing to detach: the shell
 * states what the store holds and the vault merges it.
 */
public object HealthImport {
    /** The command a pass sends the day totals through. */
    public const val RECORD: String = "measurement.record"

    /** The command a pass follows the workouts through. */
    public const val FOLLOW: String = "follow.health"

    /** The command that stops following a store (every workout stays). */
    public const val STOP: String = "follow.stop"

    private const val SYSTEM: String = "health"

    /** What one pass did. [read] is false when the vault could not be read and nothing was done. */
    public data class Outcome(
        public val days: Int = 0,
        public val added: Int = 0,
        public val updated: Int = 0,
        public val forgotten: Int = 0,
        public val refused: Int = 0,
        public val read: Boolean = true,
    )

    /** A workout's source id: the store's own, local to this phone (R-1127-10). */
    public fun externalId(storeId: String): String = PhoneIds.local(storeId)

    /** `YYYY-MM-DDTHH:MM:SS.sssZ` for [epochMillis]: the form the vault holds an instant in. */
    public fun instantOf(epochMillis: Long): String {
        val millis = ((epochMillis % SECOND_MS) + SECOND_MS) % SECOND_MS
        return rfc3339FromEpochMillis(epochMillis).dropLast(1) + "." + millis.toString().padStart(3, '0') + "Z"
    }

    /** An instant as the vault spells it, or null for one it would refuse. */
    public fun canonicalInstant(instant: String): String? =
        epochMillisFromRfc3339(instant.trim())?.let(::instantOf)

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

    /**
     * ONE WORKOUT AS THE RECORD THE VAULT FOLLOWS, or null for one it should not be told of: no
     * id, no kind, an end before its start or a start before the window.
     */
    internal fun record(workout: PhoneWorkout, device: String, windowStart: Long): String? {
        val started = epochMillisFromRfc3339(workout.startedAt.trim()) ?: return null
        val ended = epochMillisFromRfc3339(workout.endedAt.trim()) ?: return null
        if (workout.id.isBlank() || workout.kind.isBlank() || ended < started || started < windowStart) return null
        val measures = buildString {
            append('{')
            val fields = listOfNotNull(
                workout.recordedBy?.let(PhoneFields::squash)?.takeIf { it.isNotEmpty() }
                    ?.let { "\"recorded_by\":${PhoneImport.quote(it)}" },
                workout.movingSec?.takeIf { it > 0 }?.let { "\"moving_s\":$it" },
                workout.distanceM?.takeIf { it.isFinite() && it >= 0.0 }?.let { "\"distance_m\":${number(it)}" },
                workout.energyKcal?.takeIf { it.isFinite() && it >= 0.0 }?.let { "\"energy_kcal\":${number(it)}" },
                workout.avgHrBpm?.takeIf { it > 0 }?.let { "\"heart_bpm\":$it" },
                workout.elevationGainM?.takeIf { it.isFinite() && it >= 0.0 }?.let { "\"climb_m\":${number(it)}" },
            )
            append(fields.joinToString(","))
            append('}')
        }
        return "{\"external_id\":${PhoneImport.quote(externalId(workout.id.trim()))}," +
            "\"device_id\":${PhoneImport.quote(device)}," +
            "\"fields\":{\"kind\":${PhoneImport.quote(HealthKinds.key(workout.kind))}," +
            "\"starts\":${PhoneImport.quote(instantOf(started))},\"ends\":${PhoneImport.quote(instantOf(ended))}," +
            "\"workout\":$measures}}"
    }

    /**
     * `follow.health`'s input for a read: the store's origin and the workouts it holds. **Complete
     * only when the read says so, it found at least one workout, and the member chose workouts and
     * the OS allowed them** (R-1129-5): otherwise nothing is judged gone. A store no longer on the
     * phone sends no workouts and is not complete.
     */
    internal fun followInput(read: HealthRead, window: HealthWindow, device: String): String {
        val records = if (read.storePresent) {
            read.workouts.distinctBy { it.id.trim() }
                .mapNotNull { workout -> record(workout, device, window.workoutsSince) }
        } else {
            emptyList()
        }
        val workoutsAllowed = HealthMetrics.WORKOUTS in read.chosen && HealthMetrics.WORKOUTS !in read.refused
        val complete = read.storePresent && read.workoutsComplete && workoutsAllowed && records.isNotEmpty()
        return "{\"origin\":${origin(read.store, device)},\"records\":${records.joinToString(",", "[", "]")}," +
            "\"complete\":$complete,\"since\":${PhoneImport.quote(instantOf(window.workoutsSince))}}"
    }

    private fun origin(store: HealthStoreKind, device: String): String =
        "{\"ref\":${PhoneImport.quote(store.origin)},\"label\":${PhoneImport.quote(store.label)}," +
            "\"device_id\":${PhoneImport.quote(device)}}"

    /** `measurement.record`'s input: the values as the store stated them, never rounded. */
    internal fun recordInput(days: List<HealthDayTotal>): String = days.joinToString(",", "{\"days\":[", "]}") {
        "{\"day\":${PhoneImport.quote(it.day)},\"metric\":${PhoneImport.quote(it.metric)},\"value\":${it.value}}"
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
     * longer on the phone sends no days (there is nothing to read them from) and no workouts.
     */
    public suspend fun run(core: CentraidCore, read: HealthRead, window: HealthWindow, device: String? = null): Outcome {
        var days = 0
        var refused = 0
        if (read.storePresent) {
            for (batch in HealthDays.changes(read.days, window.held, window.totalsFrom, window.today).chunked(HealthDays.BATCH)) {
                if (PhoneImport.executed(core, RECORD, recordInput(batch)) != null) days += batch.size else refused += batch.size
            }
        }
        val answer = PhoneImport.executed(core, FOLLOW, followInput(read, window, device ?: PhoneDevice.id()))
            ?: return Outcome(days = days, refused = refused + 1, read = false)
        return Outcome(
            days = days,
            added = count(answer, "added") + count(answer, "matched"),
            updated = count(answer, "updated"),
            forgotten = count(answer, "forgotten"),
            refused = refused + count(answer, "refused"),
        )
    }

    /** A pass as the follower runs it: the window, the shell's read, the pass. Null when there was nothing to do. */
    public suspend fun pass(core: CentraidCore, reader: HealthReader, clock: DeviceClock): Outcome? {
        val window = window(core, clock) ?: return null
        val read = PhoneFollowReads.await<HealthRead> { reader.read(window, it) } ?: return null
        return run(core, read, window)
    }

    /**
     * CONNECT: the store's origin is written at once (a follow of no workouts) — that is what
     * makes Health followed (R-1127-14) — and the first pass runs (a year of days, 90 days of
     * workouts, R-1129-4). Null when the vault refused the origin.
     */
    public suspend fun connect(core: CentraidCore, store: HealthStoreKind, reader: HealthReader, clock: DeviceClock): Outcome? {
        val origin = "{\"origin\":${origin(store, PhoneDevice.id())},\"records\":[]}"
        PhoneImport.executed(core, FOLLOW, origin) ?: return null
        return pass(core, reader, clock) ?: Outcome()
    }

    /**
     * STOP READING: every health origin is forgotten (`follow.stop`). **Every day and every
     * workout stays**, an ordinary row from now on. False when the vault refused part of it (the
     * rest is done, and stopping again finishes it).
     */
    public suspend fun stop(core: CentraidCore): Boolean {
        var clean = true
        for (store in HealthStoreKind.entries) {
            val input = "{\"system\":${PhoneImport.quote(SYSTEM)},\"ref\":${PhoneImport.quote(store.origin)}}"
            clean = PhoneImport.executed(core, STOP, input) != null && clean
        }
        return clean
    }

    /** Whether the vault follows a health store: it holds an origin for one. */
    public suspend fun connected(core: CentraidCore): Boolean? = PhoneFollowReads.imported(core, PhoneSource.HEALTH)

    private fun count(answer: String, key: String): Int =
        Regex("\"$key\"\\s*:\\s*(\\d+)").find(answer)?.groupValues?.get(1)?.toIntOrNull() ?: 0

    private const val DECIMALS: Int = 3
    private const val SCALE: Double = 1_000.0
    private const val SECOND_MS: Long = 1_000L
}
