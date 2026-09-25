package dev.centraid.shared.apps.people

import centraid.screen.v1.Autosave
import centraid.screen.v1.Loading
import centraid.screen.v1.PeopleCadenceChoice
import centraid.screen.v1.PeopleEditorChrome
import centraid.screen.v1.PeopleEditorEvent
import centraid.screen.v1.PeopleEditorState
import centraid.screen.v1.PeopleHueChoice
import centraid.screen.v1.PeopleProfileDraft
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.apps.people.PeopleWords.fill
import dev.centraid.shared.design.PartyHueWheel
import dev.centraid.shared.kit.AutosaveLaw
import dev.centraid.shared.kit.AutosaveLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * THE PROFILE EDITOR (#1029 app port; #1015 D3: autosave everywhere, close =
 * done).
 *
 * Name, role, nickname and how you met autosave through the kit's
 * [AutosaveLaw] (900 ms, one key per edit, only the changed fields). A colour
 * is a choice and saves at once. The cadence is its OWN command
 * (`people.set_cadence`) and saves on the tap through [WriteLaw].
 *
 * A NEW PERSON is opened under an id the bridge minted: the first save — the
 * first one with a name — is `people.add_person` under that id (the cadence
 * rides it, `add_person` requires one), and every save after it is
 * `people.edit_person`. "Cancel" exists only before the first keystroke; after
 * it the close control is "Done" and closing saves what is there.
 */
public object PeopleEditorMachine : ScreenMachine<PeopleEditorState, PeopleEditorEvent> {
    public const val SCREEN_ID: String = "people.editor"

    public const val ADD_COMMAND: String = "people.add_person"
    public const val EDIT_COMMAND: String = "people.edit_person"
    public const val CADENCE_COMMAND: String = "people.set_cadence"

    /** The profile and its party: what the draft is read from. */
    public val TABLES: Set<String> = setOf("people_profile", "core_party")

    override fun initial(): PeopleEditorState = decorate(
        PeopleEditorState(
            loading = Loading(first_load = true),
            autosave = Autosave(phase = Autosave.Phase.PHASE_CLEAN),
            write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
        ),
    )

    override fun reduce(state: PeopleEditorState, event: PeopleEditorEvent): Step<PeopleEditorState> {
        val step = step(state, event)
        return Step(decorate(step.state), step.effects)
    }

    /**
     * `people_profile`'s key is its `profile_id`, not the party this editor
     * holds, so a profile change is taken as "re-read the table" (empty keys).
     */
    override fun rowsChanged(table: String, keys: List<String>): PeopleEditorEvent? = when (table) {
        "people_profile" -> PeopleEditorEvent(rows_changed = PeopleEditorEvent.RowsChanged(table = table))
        "core_party" -> PeopleEditorEvent(rows_changed = PeopleEditorEvent.RowsChanged(table = table, keys = keys))
        else -> null
    }

    override fun seatChanged(seat: SeatState): PeopleEditorEvent =
        PeopleEditorEvent(seat_changed = PeopleEditorEvent.SeatChanged(seat = seat))

    override fun ticked(token: String): PeopleEditorEvent = PeopleEditorEvent(tick = PeopleEditorEvent.Tick(token = token))

    override fun left(): PeopleEditorEvent = PeopleEditorEvent(left = PeopleEditorEvent.Left())

    // ---------------------------------------------------------------------

    private fun step(state: PeopleEditorState, event: PeopleEditorEvent): Step<PeopleEditorState> = when {
        event.opened != null -> opened(state, event.opened)
        event.refreshed != null ->
            if (state.is_new && !state.created) Step(state) else Step(state, listOf(ScreenEffect.ReadPage(SCREEN_ID, null)))
        event.data_ != null -> when {
            event.data_.absent -> Step(
                state.copy(loading = null, failure = null, denied = null, draft = null, gone = PeopleSheetFold.gone()),
            )
            event.data_.draft != null -> AutosaveLaw.loaded(lens(state), state, event.data_.draft, revision = "")
            else -> Step(state)
        }
        event.refused != null -> {
            // A refused read over words being typed keeps the words.
            if (state.draft != null) {
                Step(state)
            } else {
                Step(state.copy(loading = null, failure = event.refused.failure ?: Reads.refused(""), gone = null))
            }
        }
        event.denied != null -> Step(state.copy(loading = null, failure = null, draft = null, gone = null, denied = event.denied))
        event.rows_changed != null ->
            if (state.is_new && !state.created) {
                Step(state)
            } else {
                AutosaveLaw.rowsChanged(lens(state), state, event.rows_changed.keys)
            }
        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))
        event.name != null -> edited(state) { it.copy(display_name = event.name.text) }
        event.role != null -> edited(state) { it.copy(role = event.role.text) }
        event.nickname != null -> edited(state) { it.copy(nickname = event.nickname.text) }
        event.met != null -> edited(state) { it.copy(met = event.met.text) }
        // ONLY A ROLE THE WHEEL NAMES: anything else would store nothing.
        event.hue != null && PeopleWords.wheelKey(event.hue.hue_key).isEmpty() -> Step(state)
        event.hue != null -> {
            // A COLOUR IS A CHOICE, NOT TYPING: it saves now.
            val step = edited(state) { it.copy(hue_key = event.hue.hue_key) }
            val flushed = AutosaveLaw.flush(lens(step.state), step.state)
            Step(flushed.state, step.effects.filterNot { it is ScreenEffect.Schedule } + flushed.effects)
        }
        event.cadence != null -> cadence(state, event.cadence.days)
        event.tick != null -> AutosaveLaw.tick(lens(state), state, event.tick.token)
        event.left != null -> AutosaveLaw.flush(lens(state), state)
        event.write_settled != null -> settled(state, event.write_settled)
        else -> Step(state)
    }

    private fun opened(state: PeopleEditorState, opened: PeopleEditorEvent.Opened): Step<PeopleEditorState> {
        val fresh = PeopleEditorState(
            seat = state.seat,
            autosave = state.autosave,
            write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
        )
        if (opened.party_id.isNotEmpty()) {
            return AutosaveLaw.opened(EditLens, fresh.copy(party_id = opened.party_id))
        }
        if (opened.minted_party_id.isEmpty()) {
            return Step(fresh.copy(loading = null, failure = Reads.refused(PeopleCopy.WRITE_FAILED)))
        }
        // A NEW PERSON has nothing to read: an empty draft, and no baseline —
        // the first save sends everything it has.
        val new = fresh.copy(party_id = opened.minted_party_id, is_new = true, created = false)
        val step = AutosaveLaw.opened(AddLens, new)
        return Step(step.state.copy(loading = null, draft = PeopleProfileDraft()))
    }

    private fun edited(state: PeopleEditorState, change: (PeopleProfileDraft) -> PeopleProfileDraft): Step<PeopleEditorState> {
        val step = AutosaveLaw.edited(lens(state), state, change)
        return if (step.state == state) step else Step(step.state.copy(touched = true), step.effects)
    }

    private fun cadence(state: PeopleEditorState, days: Long): Step<PeopleEditorState> {
        val draft = state.draft ?: return Step(state)
        if (days < 0 || days == draft.cadence_days) return Step(state)
        if (state.is_new && !state.created) {
            // Not a person yet: the cadence rides `add_person`.
            return edited(state) { it.copy(cadence_days = days) }
        }
        val key = InvokeKeys.of(CADENCE_COMMAND, state.party_id, "days=$days")
        val input = "{\"party_id\":${jsonString(state.party_id)},\"cadence_days\":$days}"
        val step = WriteLaw.submit(Writes, state, CADENCE_COMMAND, input, key)
        // Drawn at once; the vault's answer settles it. Kept out of the
        // autosaved fields: the baseline moves with the draft.
        return Step(
            step.state.copy(
                draft = draft.copy(cadence_days = days),
                baseline = state.baseline?.copy(cadence_days = days),
                touched = true,
            ),
            step.effects,
        )
    }

    private fun settled(state: PeopleEditorState, settled: WriteSettled): Step<PeopleEditorState> {
        val autosave = state.autosave ?: Autosave()
        if (settled.invoke_key.isNotEmpty() && settled.invoke_key == autosave.invoke_key) {
            val adding = state.is_new && !state.created
            val step = AutosaveLaw.settled(lens(state), state, settled)
            if (!adding || !settled.committed) return step
            // THE PERSON EXISTS NOW. `add_person` takes no how-you-met, so a
            // `met` already typed is still owed: the baseline forgets it and an
            // edit is scheduled to send it through `edit_person`.
            val created = step.state.copy(created = true, baseline = step.state.baseline?.copy(met = ""))
            val draft = created.draft
            if (draft == null || draft.met.isEmpty() || step.effects.any { it is ScreenEffect.SubmitWrite }) {
                return Step(created, step.effects)
            }
            val a = created.autosave ?: Autosave()
            val seq = a.edit_seq + 1
            return Step(
                created.copy(autosave = a.copy(phase = Autosave.Phase.PHASE_DIRTY, edit_seq = seq)),
                step.effects + ScreenEffect.Schedule(SCREEN_ID, AutosaveLaw.tokenOf(seq), AutosaveLaw.DEBOUNCE_MS),
            )
        }
        val write = state.write ?: return Step(state)
        if (settled.invoke_key != write.invoke_key) return Step(state)
        val step = WriteLaw.settled(Writes, state, settled)
        if (settled.committed) return step
        // A REFUSED CADENCE goes back to what the vault holds, on the next read.
        return Step(step.state, listOf(ScreenEffect.ReadPage(SCREEN_ID, null)))
    }

    // --- Decorate --------------------------------------------------------

    private fun decorate(state: PeopleEditorState): PeopleEditorState {
        val draft = state.draft
        val autosave = state.autosave ?: Autosave()
        val cadenceRefused = state.write?.phase == WriteState.Phase.PHASE_REFUSED
        return state.copy(
            chrome = PeopleEditorChrome(
                title = if (state.is_new) PeopleCopy.EDITOR_NEW else PeopleCopy.EDITOR_EDIT,
                name_field = PeopleCopy.FIELD_NAME,
                role_field = PeopleCopy.FIELD_ROLE,
                role_placeholder = PeopleCopy.FIELD_ROLE_PLACEHOLDER,
                nickname_field = PeopleCopy.FIELD_NICKNAME,
                met_field = PeopleCopy.FIELD_MET,
                colour_field = PeopleCopy.FIELD_COLOUR,
                cadence_field = PeopleCopy.FIELD_CADENCE,
                close_label = if (state.is_new && !state.touched) PeopleCopy.CANCEL else PeopleCopy.DONE,
                retry = PeopleCopy.RETRY,
                loading = PeopleCopy.LOADING,
            ),
            hues = if (draft == null) {
                emptyList()
            } else {
                PartyHueWheel.HUE_KEYS.map { key ->
                    PeopleHueChoice(
                        hue_key = PeopleWords.role(key),
                        selected = PeopleWords.role(key) == draft.hue_key,
                        accessibility_label = fill(PeopleCopy.HUE_A11Y, "hue" to key),
                    )
                }
            },
            cadences = if (draft == null) {
                emptyList()
            } else {
                PeopleWords.CADENCES.map { days ->
                    PeopleCadenceChoice(
                        days = days,
                        label = if (days == 0L) PeopleCopy.CADENCE_NEVER else fill(PeopleCopy.CADENCE_DAYS, "n" to days),
                        selected = days == draft.cadence_days,
                    )
                }
            },
            save_label = when {
                autosave.phase == Autosave.Phase.PHASE_REFUSED ->
                    autosave.failure?.sentence?.ifEmpty { null } ?: PeopleCopy.WRITE_FAILED
                cadenceRefused -> state.write?.failure?.sentence?.ifEmpty { null } ?: PeopleCopy.WRITE_FAILED
                autosave.phase == Autosave.Phase.PHASE_SAVING -> PeopleCopy.SAVING
                autosave.phase == Autosave.Phase.PHASE_SAVED -> PeopleCopy.SAVED
                else -> ""
            },
        )
    }

    // --- The lenses ------------------------------------------------------

    private fun lens(state: PeopleEditorState): AutosaveLens<PeopleEditorState, PeopleProfileDraft> =
        if (state.is_new && !state.created) AddLens else EditLens

    /** The shared parts; [command] and [input] are the two saves' own. */
    private abstract class Lens : AutosaveLens<PeopleEditorState, PeopleProfileDraft> {
        override val screenId: String = SCREEN_ID

        override fun subjectId(state: PeopleEditorState): String = state.party_id

        override fun content(state: PeopleEditorState): ReadContent<PeopleProfileDraft> = when {
            state.draft != null -> ReadContent.Data(state.draft)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: PeopleEditorState, content: ReadContent<PeopleProfileDraft>): PeopleEditorState =
            when (content) {
                is ReadContent.Loading ->
                    state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, draft = null, gone = null)
                is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, draft = null, gone = null)
                is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, draft = null, gone = null)
                is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, draft = content.data, gone = null)
            }

        override fun autosave(state: PeopleEditorState): Autosave = state.autosave ?: Autosave()

        override fun withAutosave(state: PeopleEditorState, autosave: Autosave): PeopleEditorState =
            state.copy(autosave = autosave)

        override fun baseline(state: PeopleEditorState): PeopleProfileDraft? = state.baseline

        override fun withBaseline(state: PeopleEditorState, baseline: PeopleProfileDraft?): PeopleEditorState =
            state.copy(baseline = baseline)

        override fun sending(state: PeopleEditorState): PeopleProfileDraft? = state.sending

        override fun withSending(state: PeopleEditorState, sending: PeopleProfileDraft?): PeopleEditorState =
            state.copy(sending = sending)

        /** A person needs a name: the command refuses an empty one. */
        override fun refusal(state: PeopleEditorState, draft: PeopleProfileDraft, baseline: PeopleProfileDraft?): ReadFailure? =
            if (draft.display_name.isBlank()) Reads.refused(PeopleCopy.NAME_NEEDED) else null
    }

    /** `people.edit_person`: only the fields that moved. The cadence is not one of them. */
    private object EditLens : Lens() {
        override val command: String = EDIT_COMMAND

        override fun input(state: PeopleEditorState, draft: PeopleProfileDraft, baseline: PeopleProfileDraft?): String? {
            val base = baseline ?: PeopleProfileDraft()
            val fields = buildList {
                if (draft.display_name.trim() != base.display_name.trim()) add("display_name" to draft.display_name.trim())
                if (draft.role != base.role) add("role" to draft.role)
                if (draft.nickname != base.nickname) add("nickname" to draft.nickname)
                if (draft.met != base.met) add("met" to draft.met)
                if (draft.hue_key != base.hue_key && draft.hue_key.isNotEmpty()) {
                    add("avatar_color" to PeopleWords.storedHue(draft.hue_key))
                }
            }
            if (fields.isEmpty()) return null
            return fields.joinToString(",", prefix = "{\"party_id\":${jsonString(state.party_id)},", postfix = "}") { (k, v) ->
                "${jsonString(k)}:${jsonString(v)}"
            }
        }
    }

    /** `people.add_person` under the minted id, with the cadence it requires. */
    private object AddLens : Lens() {
        override val command: String = ADD_COMMAND

        override fun input(state: PeopleEditorState, draft: PeopleProfileDraft, baseline: PeopleProfileDraft?): String =
            buildString {
                append("{\"party_id\":").append(jsonString(state.party_id))
                append(",\"display_name\":").append(jsonString(draft.display_name.trim()))
                append(",\"cadence_days\":").append(draft.cadence_days)
                if (draft.role.isNotEmpty()) append(",\"role\":").append(jsonString(draft.role))
                if (draft.nickname.isNotEmpty()) append(",\"nickname\":").append(jsonString(draft.nickname))
                if (draft.hue_key.isNotEmpty()) append(",\"avatar_color\":").append(jsonString(PeopleWords.storedHue(draft.hue_key)))
                append('}')
            }

        /** Before a name there is no person to add, and nothing to say yet. */
        override fun refusal(state: PeopleEditorState, draft: PeopleProfileDraft, baseline: PeopleProfileDraft?): ReadFailure? =
            if (draft.display_name.isBlank()) Reads.refused(PeopleCopy.NAME_NEEDED) else null
    }

    private object Writes : WriteLens<PeopleEditorState> {
        override fun write(state: PeopleEditorState): WriteState = state.write ?: WriteState()

        override fun with(state: PeopleEditorState, write: WriteState): PeopleEditorState = state.copy(write = write)
    }
}
