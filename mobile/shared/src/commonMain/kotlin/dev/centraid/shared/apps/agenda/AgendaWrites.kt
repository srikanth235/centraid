package dev.centraid.shared.apps.agenda

import centraid.core.v1.AgendaUpcomingRequest
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.kit.time.epochDayOf
import dev.centraid.shared.kit.time.plusDays
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.rfc3339FromEpochMillis

/**
 * THE `schedule.*` COMMANDS AGENDA'S EVENT SCREENS WRITE, AND HOW (#1046).
 *
 * The inputs are built against `crates/vault/src/commands/schedule.rs`'s
 * schemas exactly — every one is `additionalProperties: false`, so a field the
 * schema does not name refuses the whole write (v0's `edit-occurrence` did,
 * a defect not carried).
 *
 * Invoke keys are `command:event_id:…` ([InvokeKeys]): content-derived, so a
 * double tap is one write, and the event id is the SUBJECT, which is how
 * [AgendaMarks] knows which event a write is about.
 */
public object AgendaWrites {
    public const val PROPOSE: String = "schedule.propose_event"
    public const val EDIT: String = "schedule.edit_event"
    public const val OCCURRENCE: String = "schedule.edit_event_occurrence"
    public const val RSVP: String = "schedule.respond_rsvp"
    public const val CANCEL: String = "schedule.cancel_event"

    /** How [AgendaMarks] tells a skipped occurrence (a cancellation) from an override. */
    public const val SKIP_MARK: String = "\"action\":\"skip\""

    /** The invoke key's subject for a write that makes an event. */
    public const val NEW_SUBJECT: String = "new"

    public fun key(command: String, subject: String, vararg intent: String): String =
        InvokeKeys.of(command, subject, *intent)

    /** The subject [key] put second. */
    public fun subjectOf(invokeKey: String): String = invokeKey.split(':').getOrElse(1) { "" }

    // ---------------------------------------------------------------------
    // Inputs
    // ---------------------------------------------------------------------

    public fun rsvp(eventId: String, partyId: String, partstat: String): String =
        Json().str("event_id", eventId).str("party_id", partyId).str("partstat", partstat).build()

    public fun cancel(eventId: String): String = Json().str("event_id", eventId).build()

    /** Skip one occurrence, or it and the ones after. The series itself is [cancel]. */
    public fun skip(eventId: String, originalStartLocal: String, scope: String): String =
        Json()
            .str("event_id", eventId)
            .str("original_start_local", originalStartLocal)
            .str("scope", scope)
            .str("action", "skip")
            .build()

    /** A tiny ordered JSON object writer: `commonMain` carries no JSON library. */
    public class Json {
        private val fields = mutableListOf<String>()

        public fun str(name: String, value: String): Json = apply {
            fields += "${jsonString(name)}:${jsonString(value)}"
        }

        public fun bool(name: String, value: Boolean): Json = apply {
            fields += "${jsonString(name)}:$value"
        }

        public fun strings(name: String, values: List<String>): Json = apply {
            fields += "${jsonString(name)}:[${values.joinToString(",") { jsonString(it) }}]"
        }

        /** `reminders`: `[{"minutes_before":N}]`, or `[]` for none. */
        public fun reminders(name: String, minutes: Int?): Json = apply {
            fields += "${jsonString(name)}:[${minutes?.let { "{\"minutes_before\":$it}" } ?: ""}]"
        }

        public fun build(): String = fields.joinToString(",", prefix = "{", postfix = "}")
    }

    // ---------------------------------------------------------------------
    // The read window
    // ---------------------------------------------------------------------

    private const val MILLIS_PER_DAY: Long = 86_400_000

    /**
     * `agenda.upcoming` around [day]: UTC midnight a day before it to UTC
     * midnight two days after — `AgendaReads`' pad, for its reason (the zone's
     * offset is the core's to know, and ±14 hours is inside a day). An
     * occurrence still running at `from` is answered, so a multi-day row picked
     * on a later day is in it too.
     */
    public fun around(day: String, now: DeviceClock.Reading): AgendaUpcomingRequest? {
        val from = plusDays(day, -1)?.let(::epochDayOf) ?: return null
        val to = plusDays(day, 2)?.let(::epochDayOf) ?: return null
        return AgendaUpcomingRequest(
            from = rfc3339FromEpochMillis(from * MILLIS_PER_DAY),
            to = rfc3339FromEpochMillis(to * MILLIS_PER_DAY),
            tz = now.zone,
        )
    }

    /** Today and a day on, from the core's own today (`from` empty): the calendars and the clock. */
    public fun today(now: DeviceClock.Reading): AgendaUpcomingRequest = AgendaUpcomingRequest(
        from = "",
        to = rfc3339FromEpochMillis(now.epochMillis + MILLIS_PER_DAY),
        tz = now.zone,
    )
}
