package dev.centraid.shared.apps.agenda

import dev.centraid.shared.screen.ScreenEffect
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * THE AGENDA WRITES THIS SESSION HOLDS AND HAS NOT SETTLED (#1046 waves 4
 * and 5) — one per shell, handed to all three Agenda bridges.
 *
 * Why a store and not events the shell forwards: the home's "pending" and
 * "cancellation asked" chips, and the detail's parked card, are about writes
 * whose screen may be gone. A shell that read one screen's state and forwarded
 * it to another would be a shell deciding which write means which chip. Here
 * the bridges feed it — [submitted] from a write effect, [settled] from the
 * write's answer, both on the SESSION's scope so a write outlives its screen —
 * and each machine is handed the list and folds it ([AgendaInput.Marks],
 * [AgendaEventInput.Held]). No view reads it.
 *
 * What a write IS comes from its command and its invoke key, which the Agenda
 * machines mint as `command:event_id:…` ([AgendaWrites.key]).
 */
public class AgendaMarks {
    /** What a held write does to its event. */
    public enum class Kind { RSVP, CANCEL, EDIT, CREATE }

    public enum class Phase { IN_FLIGHT, REFUSED }

    public data class Held(
        public val invokeKey: String,
        public val eventId: String,
        public val kind: Kind,
        public val command: String,
        public val inputJson: String,
        public val phase: Phase,
        /** The core's own sentence for a refusal; empty when it gave none. */
        public val sentence: String = "",
    )

    private val _held = MutableStateFlow<List<Held>>(emptyList())

    /** Answers that arrived before their write was recorded. */
    private val early = mutableMapOf<String, Pair<Boolean, String>>()

    public val held: StateFlow<List<Held>> = _held.asStateFlow()

    /**
     * A write left a screen. It REPLACES any write already held for the same
     * event and kind — a retry, or a second answer to the same question, is the
     * one that counts.
     */
    public fun submitted(write: ScreenEffect.SubmitWrite) {
        val held = heldOf(write) ?: return
        // AN ANSWER THAT OUTRAN ITS SUBMISSION (two collectors of one effect)
        // is applied here rather than leaving the write in flight for ever.
        early.remove(write.invokeKey)?.let { (committed, sentence) ->
            _held.update { list -> list.filterNot { it.eventId == held.eventId && it.kind == held.kind } }
            if (!committed) {
                _held.update { list -> list + held.copy(phase = Phase.REFUSED, sentence = sentence) }
            }
            return
        }
        _held.update { list ->
            list.filterNot { it.eventId == held.eventId && it.kind == held.kind } + held
        }
    }

    /** Its answer. A commit is forgotten — the re-read shows it; a refusal stays until dismissed. */
    public fun settled(invokeKey: String, committed: Boolean, sentence: String) {
        if (_held.value.none { it.invokeKey == invokeKey }) {
            if (early.size >= EARLY_LIMIT) early.clear()
            early[invokeKey] = committed to sentence
            return
        }
        _held.update { list ->
            if (committed) {
                list.filterNot { it.invokeKey == invokeKey }
            } else {
                list.map {
                    if (it.invokeKey == invokeKey) it.copy(phase = Phase.REFUSED, sentence = sentence) else it
                }
            }
        }
    }

    /** The member dismissed a parked card: every refusal held for [eventId]. */
    public fun dismissed(eventId: String) {
        _held.update { list -> list.filterNot { it.eventId == eventId && it.phase == Phase.REFUSED } }
    }

    public companion object {
        private const val EARLY_LIMIT: Int = 32

        /** What [write] is, or null for a write that is not an Agenda event's. */
        public fun heldOf(write: ScreenEffect.SubmitWrite): Held? {
            val kind = when (write.command) {
                AgendaWrites.RSVP -> Kind.RSVP
                AgendaWrites.CANCEL -> Kind.CANCEL
                AgendaWrites.EDIT -> Kind.EDIT
                AgendaWrites.OCCURRENCE ->
                    if (write.inputJson.contains(AgendaWrites.SKIP_MARK)) Kind.CANCEL else Kind.EDIT
                AgendaWrites.PROPOSE -> Kind.CREATE
                else -> return null
            }
            return Held(
                invokeKey = write.invokeKey,
                eventId = AgendaWrites.subjectOf(write.invokeKey),
                kind = kind,
                command = write.command,
                inputJson = write.inputJson,
                phase = Phase.IN_FLIGHT,
            )
        }

        /** Events with a write in flight that is not a cancellation: the home's "pending". */
        public fun pendingIds(held: List<Held>): List<String> = held
            .filter { it.phase == Phase.IN_FLIGHT && it.kind != Kind.CANCEL && it.kind != Kind.CREATE }
            .map { it.eventId }
            .distinct()

        /** Events with a cancellation in flight: the home's "cancellation asked". */
        public fun cancelIds(held: List<Held>): List<String> = held
            .filter { it.phase == Phase.IN_FLIGHT && it.kind == Kind.CANCEL }
            .map { it.eventId }
            .distinct()
    }
}
