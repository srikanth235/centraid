package dev.centraid.shared.apps.agenda

import centraid.core.v1.AgendaUpcomingRequest
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.kit.time.epochDayOf
import dev.centraid.shared.kit.time.plusDays
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.rfc3339FromEpochMillis
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * THE `event.*` COMMANDS AGENDA'S EVENT SCREENS WRITE, AND HOW (#1046, #1135).
 *
 * The inputs are built against `crates/vault/src/commands/event.rs`'s
 * schemas exactly — every one is `additionalProperties: false`, so a field the
 * schema does not name refuses the whole write (v0's `edit-occurrence` did,
 * a defect not carried).
 *
 * Invoke keys are `command:event_id:…` ([InvokeKeys]): the event id is the
 * SUBJECT, which is how [AgendaMarks] knows which event a write is about. The
 * key only correlates the answer: a double tap while a write is in flight is
 * one write ([dev.centraid.shared.kit.WriteLaw]), and the editor ends its
 * sitting on the commit, because the core remembers no key (R-1088-12).
 */
public object AgendaWrites {
    public const val PROPOSE: String = "event.propose"
    public const val EDIT: String = "event.edit"
    public const val OCCURRENCE: String = "event.edit_occurrence"
    public const val RSVP: String = "event.respond"
    public const val CANCEL: String = "event.cancel"

    /** The add sheet's task kind (#1128): Tasks' own command, written from the Agenda sheet. */
    public const val ADD_TASK: String = "task.add"

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

    public fun rsvp(eventId: String, personId: String, state: String): String =
        Json().str("id", eventId).str("person_id", personId).str("state", state).build()

    public fun cancel(eventId: String): String = Json().str("id", eventId).build()

    /**
     * `task.add` from the add sheet (#1128): the id the bridge
     * minted (the vault's guard against a second copy of one add), the title,
     * and the due — a bare day, or a floating local `YYYY-MM-DDTHH:MM`
     * (`due` takes an instant, a floating time or a date; Tasks' detail
     * writes a time the same way).
     */
    /** A fresh task id: a v4 UUID, the shape `add_task` honours. */
    @OptIn(ExperimentalUuidApi::class)
    public fun mintTaskId(): String = Uuid.random().toString()

    public fun addTask(taskId: String, title: String, due: String): String =
        Json().str("id", taskId).str("title", title).str("due", due).build()

    /** Skip one occurrence, or it and the ones after. The series itself is [cancel]. */
    public fun skip(eventId: String, originalStart: String, scope: String): String =
        Json()
            .str("id", eventId)
            .str("original_start", originalStart)
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

        /** A key stated as `null`: the command clears what it names. */
        public fun clear(name: String): Json = apply {
            fields += "${jsonString(name)}:null"
        }

        public fun strings(name: String, values: List<String>): Json = apply {
            fields += "${jsonString(name)}:[${values.joinToString(",") { jsonString(it) }}]"
        }

        /** `reminders`: the minutes before it starts, `[N]`, or `[]` for none. */
        public fun reminders(name: String, minutes: Int?): Json = apply {
            fields += "${jsonString(name)}:[${minutes ?: ""}]"
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
