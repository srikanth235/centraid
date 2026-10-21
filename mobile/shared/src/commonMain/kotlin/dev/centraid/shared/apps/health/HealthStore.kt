package dev.centraid.shared.apps.health

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.Envelope
import centraid.core.v1.HealthWorkoutRequest
import centraid.core.v1.HealthWorkoutRow
import centraid.core.v1.HealthWorkoutsCursor
import centraid.core.v1.HealthWorkoutsRequest
import centraid.core.v1.Request
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.sync.phone.CorePhoneStore
import dev.centraid.shared.sync.phone.PhoneRecord
import dev.centraid.shared.sync.phone.PhoneSource
import dev.centraid.shared.sync.epochMillisFromRfc3339
import dev.centraid.shared.sync.phone.VaultRow
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * HEALTH'S SIDE OF A WORKOUT PASS (#1129, R-1129-2): the workouts as the vault holds them, read
 * through the read contract (`health.workouts`, `health.workout`), and the three writes the engine
 * asks, through the `health.*` commands. A followed workout is an ordinary `core.activity`; only
 * the link says where it came from.
 *
 * - **add** mints the activity id here, before the first attempt, so a re-offer lands the same
 *   row, and writes it with `health.follow_workout`.
 * - **update** is the same command on the same id: it writes what moved and nothing else.
 * - **trash KEEPS THE WORKOUT** (R-1129-14). An activity has no trash to give it thirty days in,
 *   and the vault is the workout's backup, so a workout gone from the phone stays: the engine
 *   forgets its link, and the member sees it in Health as before, now an ordinary workout that no
 *   longer follows the store (a later change on the phone does not reach it). The pass counts it
 *   as `trashed`. Only the member deletes one: from Health, or by answering "Delete them" to the
 *   store-gone question, which is the one place [purge] is set and `health.purge_workout` runs.
 * - **refindLost** is on (R-1129-15): a workout lost under one phone id and met under another in
 *   the same pass on THIS device (a store that re-issued its ids) is the same row, re-linked, never
 *   a second one. A new phone's own ids are another device's re-find (F-K-1), which every source has.
 * - **coverage** is the window the pass read ([since]): a workout that started before it is not
 *   one the phone deleted.
 */
internal class HealthStore(
    core: CentraidCore,
    device: String,
    private val since: Long? = null,
    private val purge: Boolean = false,
    private val mintId: () -> String = ::mint,
) : CorePhoneStore(core, PhoneSource.HEALTH, device) {
    override val refindLost: Boolean get() = true

    override suspend fun rows(): Map<String, VaultRow>? {
        val rows = linkedMapOf<String, VaultRow>()
        var after: HealthWorkoutsCursor? = null
        repeat(MAX_PAGES) {
            val page = ask(AppQueryRequest(health_workouts = HealthWorkoutsRequest(limit = PAGE, after = after)))
                ?.health_workouts ?: return null
            page.workouts.forEach { rows[it.activity_id] = vaultRow(it) }
            after = page.next ?: return rows
        }
        return null
    }

    override suspend fun row(entityId: String): VaultRow? =
        ask(AppQueryRequest(health_workout = HealthWorkoutRequest(activity_id = entityId)))
            ?.health_workout?.workout?.let(::vaultRow)

    override suspend fun add(record: PhoneRecord): String? {
        val workout = record.attributes as? WorkoutAttributes ?: return null
        val id = mintId()
        command(FOLLOW, HealthImport.followInput(id, workout)) ?: return null
        return id
    }

    override suspend fun update(entityId: String, record: PhoneRecord): Boolean {
        val workout = record.attributes as? WorkoutAttributes ?: return false
        return command(FOLLOW, HealthImport.followInput(entityId, workout)) != null
    }

    override suspend fun trash(entityId: String): Boolean =
        !purge || command(PURGE, "{\"activity_id\":${q(entityId)}}") != null

    override suspend fun coverage(): (VaultRow) -> Boolean {
        val from = since ?: return { true }
        return { row ->
            val started = (row.attributes as? HealthWorkoutRow)?.started_at?.let(::epochMillisFromRfc3339)
            started != null && started >= from
        }
    }

    private fun vaultRow(row: HealthWorkoutRow): VaultRow = VaultRow(
        entityId = row.activity_id,
        fields = HealthImport.fields(
            kind = row.kind_key,
            phoneKind = row.phone_kind,
            startedAt = row.started_at,
            endedAt = row.ended_at,
            movingSec = row.moving_sec,
            distanceM = row.distance_m,
            energyKcal = row.energy_kcal,
            avgHrBpm = row.avg_hr_bpm,
            elevationGainM = row.elevation_gain_m,
            recordedBy = row.recorded_by,
        ),
        matchKey = HealthImport.matchKey(row.kind_key, row.started_at),
        attributes = row,
    )

    /** One app query; null for a refusal, a denial or a failure. */
    private suspend fun ask(request: AppQueryRequest): AppQueryResponse? {
        val answer = core.call(Envelope(request_id = 0, request = Request(app_query = request)))
        val response = (answer as? CoreOutcome.Answered)?.value?.response?.app_query ?: return null
        return response.takeIf { it.denied == null }
    }

    companion object {
        const val FOLLOW: String = "health.follow_workout"
        const val PURGE: String = "health.purge_workout"
        const val RECORD: String = "health.record_days"
        private const val PAGE: Int = 200
        private const val MAX_PAGES: Int = 10_000

        @OptIn(ExperimentalUuidApi::class)
        fun mint(): String = Uuid.random().toString()
    }
}

/** What a workout's writer needs and the engine never reads: the vault's kind key and the workout as read. */
internal data class WorkoutAttributes(val kind: String, val workout: PhoneWorkout)
