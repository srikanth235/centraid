package dev.centraid.shared.apps.locker

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.LockerItem
import centraid.core.v1.LockerItemRequest
import centraid.screen.v1.Confirm
import centraid.screen.v1.Loading
import centraid.screen.v1.LockerChoice
import centraid.screen.v1.LockerEditorChrome
import centraid.screen.v1.LockerEditorData
import centraid.screen.v1.LockerEditorEvent
import centraid.screen.v1.LockerEditorState
import centraid.screen.v1.LockerInputRow
import centraid.screen.v1.SeatState
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.screen.Step

/**
 * ADD OR EDIT AN ITEM (#1047) — with an EXPLICIT SAVE (R-1047-L5): a secret
 * saved on a pause mid-typing is a wrong secret, so this editor is K4's
 * exception to autosave, for the same reason Tally's money editor is.
 *
 * **The draft is sent whole** (`locker.edit_item` REWRITES the type's columns,
 * it does not patch them): every plain field as typed, and every secret
 * either as typed or — left empty over a stored one — as the vault's
 * placeholder, which means "leave it alone". The core seals what was typed
 * before the vault sees it (`crates/core/src/locker/phone.rs`); nothing here
 * holds `K` or ciphertext, and the typed secret lives on this state only until
 * the save commits, the editor closes, or the Locker relocks.
 *
 * **The compromised flag** (R-1047-F7) is a toggle row the member sets on a
 * leaked secret, so Review lists the item for changing; nothing else produces
 * it. It is sent only when it CHANGED from what the vault holds, so an edit
 * that leaves it alone and carries a new password lets the vault's rule clear
 * it (a rotation answers the flag), and the row's note says so as it happens.
 *
 * **A one-time-code seed** is the setup key or the `otpauth://` link a site
 * showed (Q-1047-16). It is checked here so a refusal is said on the field
 * ([LockerSeeds]); the core reads it again and seals it as base32.
 */
public object LockerEditorMachine :
    LockerQueryMachine<LockerEditorState, LockerEditorEvent, LockerEditorData>("locker.editor", LOCKER_TABLES) {
    public const val SCREEN_ID: String = "locker.editor"

    /** The vault's "leave this secret alone" (`SEALED_PLACEHOLDER`). */
    public const val PLACEHOLDER: String = "«sealed»"

    private val SECRETS: Set<String> = setOf("password", "otp_seed", "card_number", "cvv", "content")

    override val lens: ContentLens<LockerEditorState, LockerEditorData> = Lens

    override fun blank(): LockerEditorState = LockerEditorState(write = WriteState(phase = WriteState.Phase.PHASE_IDLE))

    override fun seatOf(screen: LockerEditorState): SeatState = screen.seat ?: SeatState()

    override fun withSeat(screen: LockerEditorState, seat: SeatState): LockerEditorState = screen.copy(seat = seat)

    /** The columns a type's form shows, after the title. */
    public fun columnsOf(type: String): List<String> = when (type) {
        "login" -> listOf("username", "password", "url", "otp_seed", "notes")
        "card" -> listOf("cardholder", "card_number", "expiry", "cvv", "brand")
        "note" -> listOf("content")
        "identity" -> listOf("fullname", "email", "phone", "address")
        "wifi" -> listOf("network", "password")
        "password" -> listOf("password")
        else -> listOf("notes")
    }

    override fun view(held: LockerHeld<LockerEditorState>, event: LockerEditorEvent, entropy: ByteArray): Step<LockerHeld<LockerEditorState>> =
        when {
            event.opened != null -> opened(held, event.opened)
            event.type != null -> retyped(held, event.type.key)
            event.typed != null -> edited(held) { data ->
                data.copy(inputs = data.inputs.map { if (it.key == event.typed.key) it.copy(value_ = event.typed.value_) else it })
            }
            event.tags != null -> edited(held) { it.copy(tags_text = event.tags.text) }
            event.compromised != null -> edited(held) { it.copy(compromised = event.compromised.on) }
            event.generate != null -> generated(held, event.generate.key, entropy)
            event.save != null -> save(held)
            event.cancel != null ->
                if (dirty(held)) {
                    Step(
                        held.copy(
                            screen = held.screen.copy(
                                confirm = Confirm(
                                    title = LockerCopy.DISCARD_TITLE,
                                    body = LockerCopy.DISCARD_BODY,
                                    confirm_label = LockerCopy.DISCARD,
                                    destructive = true,
                                ),
                            ),
                        ),
                    )
                } else {
                    Step(closed(held))
                }
            event.confirmed != null -> Step(closed(held))
            event.dismissed != null -> Step(held.copy(screen = held.screen.copy(confirm = null)))
            else -> Step(held)
        }

    /** CLOSED IS EMPTY: the typed draft does not outlive the editor. */
    private fun closed(held: LockerHeld<LockerEditorState>): LockerHeld<LockerEditorState> =
        held.copy(screen = lens.with(held.screen.copy(confirm = null, done = true), ReadContent.Loading(firstLoad = true)))

    private fun opened(held: LockerHeld<LockerEditorState>, opened: LockerEditorEvent.Opened): Step<LockerHeld<LockerEditorState>> {
        val mode = opened.mode.takeIf { it != LockerEditorState.Mode.MODE_UNSPECIFIED } ?: LockerEditorState.Mode.MODE_ADD
        val screen = blank().copy(mode = mode, item_id = opened.item_id, seat = held.screen.seat)
        val fresh = LockerHeld(screen = screen, open = held.open, tokens = held.tokens)
        return if (mode == LockerEditorState.Mode.MODE_EDIT) {
            reload(fresh)
        } else {
            // A NEW ITEM READS NOTHING: its form is the type's, empty — or
            // carrying the generator's output as its password.
            val type = opened.type.takeIf { it in LockerFold.CREATABLE } ?: "login"
            val data = form(type, values = mapOf("password" to opened.password), stored = emptySet(), tags = "")
            Step(fresh.copy(screen = lens.with(screen, ReadContent.Data(data))))
        }
    }

    // THE FORM IS THE MEMBER'S: a change event never re-reads it (its own
    // save's commit is one), and a new item has nothing to read at all.
    override fun changed(held: LockerHeld<LockerEditorState>): Step<LockerHeld<LockerEditorState>> = Step(held)

    // A RELOCK CLOSES THE EDITOR. What was typed is gone — a secret typed and
    // not saved does not survive the Locker closing — and the shell pops it.
    override fun wiped(held: LockerHeld<LockerEditorState>): LockerEditorState =
        lens.with(blank().copy(mode = held.screen.mode, item_id = held.screen.item_id, done = true), ReadContent.Loading(firstLoad = true))

    override fun reopened(held: LockerHeld<LockerEditorState>): Step<LockerHeld<LockerEditorState>> =
        if (held.screen.done || held.screen.mode != LockerEditorState.Mode.MODE_EDIT) Step(held) else reload(held)

    override fun fold(held: LockerHeld<LockerEditorState>): LockerEditorData? {
        // A form already on screen is the member's, and a re-read never
        // replaces what they typed.
        (lens.content(held.screen) as? ReadContent.Data)?.let { return it.data }
        val item = held.answers.item?.item ?: return null
        return formOf(item)
    }

    private fun formOf(item: LockerItem): LockerEditorData {
        val values = columnsOf(item.type).associateWith { LockerItemMachine.plainValue(item, it) ?: "" }
        val stored = item.secrets.filter { it.present }.map { it.column }.toSet()
        return form(
            item.type,
            values = values + ("title" to item.title),
            stored = stored,
            tags = item.tags.joinToString(", "),
            add = false,
            compromised = item.compromised,
        )
    }

    /** The form for [type]. [stored] names secrets the vault already holds. */
    private fun form(
        type: String,
        values: Map<String, String>,
        stored: Set<String>,
        tags: String,
        add: Boolean = true,
        compromised: Boolean = false,
    ): LockerEditorData {
        val inputs = listOf("title") + columnsOf(type)
        val rows = inputs.map { key ->
            val secret = key in SECRETS
            val value = values[key] ?: ""
            LockerInputRow(
                key = key,
                label = LockerItemMachine.labelOf(key),
                value_ = value,
                placeholder = placeholderOf(key),
                secret = secret,
                kind = kindOf(key),
                note = noteOf(key, value, key in stored),
                generate_label = if (key == "password") LockerCopy.GENERATE else "",
            )
        }
        return validated(
            LockerEditorData(
                types = if (add) {
                    LockerFold.CREATABLE.map { LockerChoice(key = it, label = LockerFold.typeLabel(it), selected = it == type) }
                } else {
                    emptyList()
                },
                types_label = if (add) LockerCopy.TYPE else "",
                inputs = rows,
                tags_label = LockerCopy.TAGS,
                tags_text = tags,
                tags_hint = LockerCopy.TAGS_HINT,
                compromised_label = LockerCopy.COMPROMISED_TOGGLE,
                compromised = compromised,
            ),
        )
    }

    /**
     * What the compromised row's note says (R-1047-F7): a type with no
     * password has no rotation to clear it; a flag the vault holds, left on
     * over a newly typed password, is about to be cleared by that save.
     */
    private fun flagNote(held: LockerHeld<LockerEditorState>, data: LockerEditorData): String {
        val type = typeOf(held)
        val typedPassword = data.inputs.any { it.key == "password" && it.value_.isNotEmpty() }
        return when {
            "password" !in columnsOf(type) -> LockerCopy.COMPROMISED_NOTE_NO_PASSWORD
            storedFlag(held) && data.compromised && typedPassword -> LockerCopy.COMPROMISED_CLEARS
            else -> LockerCopy.COMPROMISED_NOTE
        }
    }

    /** The flag the vault holds for the item — `false` for a new one. */
    private fun storedFlag(held: LockerHeld<LockerEditorState>): Boolean =
        held.screen.mode == LockerEditorState.Mode.MODE_EDIT && held.answers.item?.item?.compromised == true

    private fun noteOf(key: String, value: String, stored: Boolean): String = when {
        key == "password" && value.isNotEmpty() -> strength(LockerPasswords.typedBits(value))
        key in SECRETS && stored && value.isEmpty() -> LockerCopy.KEPT_SEALED
        key == "otp_seed" -> LockerCopy.OTP_HINT
        key in SECRETS -> LockerCopy.SEALED_ON_SAVE
        else -> ""
    }

    private fun placeholderOf(key: String): String = when (key) {
        "url" -> LockerCopy.PLACEHOLDER_URL
        "expiry" -> LockerCopy.PLACEHOLDER_EXPIRY
        "email" -> LockerCopy.PLACEHOLDER_EMAIL
        else -> ""
    }

    private fun kindOf(key: String): LockerInputRow.Kind = when (key) {
        "url" -> LockerInputRow.Kind.KIND_URL
        "email" -> LockerInputRow.Kind.KIND_EMAIL
        "phone" -> LockerInputRow.Kind.KIND_PHONE
        "card_number", "cvv" -> LockerInputRow.Kind.KIND_NUMBER
        "notes", "content", "address" -> LockerInputRow.Kind.KIND_MULTILINE
        else -> LockerInputRow.Kind.KIND_TEXT
    }

    /** "Strong · about 95 bits". */
    internal fun strength(bits: Int): String {
        val label = when {
            bits < 40 -> LockerCopy.STRENGTH_WEAK
            bits < 60 -> LockerCopy.STRENGTH_FAIR
            bits < 80 -> LockerCopy.STRENGTH_STRONG
            else -> LockerCopy.STRENGTH_VERY_STRONG
        }
        return LockerFold.fill(LockerCopy.STRENGTH, "label" to label, "bits" to bits.toString())
    }

    private fun validated(data: LockerEditorData): LockerEditorData {
        val title = data.inputs.firstOrNull { it.key == "title" }?.value_ ?: ""
        val seed = data.inputs.firstOrNull { it.key == "otp_seed" }?.value_ ?: ""
        val seedRefusal = seed.takeIf { it.isNotBlank() }?.let(LockerSeeds::refusal)
        val blocked = when {
            title.isBlank() -> LockerCopy.TITLE_NEEDED
            seedRefusal != null -> seedRefusal
            else -> ""
        }
        return data.copy(
            can_save = blocked.isEmpty(),
            blocked = blocked,
            inputs = data.inputs.map { row ->
                when {
                    row.key == "password" && row.value_.isNotEmpty() -> row.copy(note = strength(LockerPasswords.typedBits(row.value_)))
                    row.key == "otp_seed" && seedRefusal != null -> row.copy(note = seedRefusal)
                    row.key == "otp_seed" && row.value_.isNotBlank() -> row.copy(note = LockerCopy.SEALED_ON_SAVE)
                    else -> row
                }
            },
        )
    }

    private fun edited(
        held: LockerHeld<LockerEditorState>,
        change: (LockerEditorData) -> LockerEditorData,
    ): Step<LockerHeld<LockerEditorState>> {
        val data = held.screen.data_ ?: return Step(held)
        val next = validated(change(data))
        return Step(held.copy(screen = held.screen.copy(data_ = next, write = WriteState(phase = WriteState.Phase.PHASE_IDLE))))
    }

    private fun retyped(held: LockerHeld<LockerEditorState>, type: String): Step<LockerHeld<LockerEditorState>> {
        val data = held.screen.data_ ?: return Step(held)
        if (held.screen.mode != LockerEditorState.Mode.MODE_ADD || type !in LockerFold.CREATABLE) return Step(held)
        // WHAT CARRIES ACROSS A TYPE IS WHAT THE NEW TYPE HAS: a login's
        // password becomes the Wi-Fi's; its username goes, as the vault
        // would drop it.
        val values = data.inputs.associate { it.key to it.value_ }
        return Step(held.copy(screen = held.screen.copy(data_ = form(type, values, emptySet(), data.tags_text, compromised = data.compromised))))
    }

    private fun generated(held: LockerHeld<LockerEditorState>, key: String, entropy: ByteArray): Step<LockerHeld<LockerEditorState>> {
        if (key != "password") return Step(held)
        val alphabet = LockerPasswords.alphabet(pin = false, digits = true, symbols = true)
        val password = LockerPasswords.generate(entropy, alphabet, LockerPasswords.DEFAULT_LENGTH) ?: return Step(held)
        return edited(held) { data ->
            data.copy(inputs = data.inputs.map { if (it.key == key) it.copy(value_ = password) else it })
        }
    }

    private fun typeOf(held: LockerHeld<LockerEditorState>): String =
        held.screen.data_?.types?.firstOrNull { it.selected }?.key
            ?: held.answers.item?.item?.type
            ?: "login"

    /** Anything the member changed. */
    internal fun dirty(held: LockerHeld<LockerEditorState>): Boolean {
        val data = held.screen.data_ ?: return false
        val baseline = when (held.screen.mode) {
            LockerEditorState.Mode.MODE_EDIT -> held.answers.item?.item?.let(::formOf) ?: return false
            else -> form(typeOf(held), emptyMap(), emptySet(), "")
        }
        return data.inputs.map { it.key to it.value_ } != baseline.inputs.map { it.key to it.value_ } ||
            data.tags_text != baseline.tags_text ||
            data.compromised != baseline.compromised ||
            (held.screen.mode == LockerEditorState.Mode.MODE_ADD && data.inputs.any { it.value_.isNotEmpty() })
    }

    private fun save(held: LockerHeld<LockerEditorState>): Step<LockerHeld<LockerEditorState>> {
        val data = held.screen.data_ ?: return Step(held)
        if (!data.can_save || held.screen.item_id.isEmpty()) return Step(held)
        val edit = held.screen.mode == LockerEditorState.Mode.MODE_EDIT
        val stored = held.answers.item?.item?.secrets?.filter { it.present }?.map { it.column }?.toSet() ?: emptySet()
        val type = typeOf(held)
        val fields = data.inputs.joinToString("") { row ->
            val value = when {
                row.key in SECRETS && row.value_.isEmpty() && row.key in stored -> PLACEHOLDER
                row.key == "title" -> row.value_.trim()
                else -> row.value_
            }
            ",${jsonString(row.key)}:${jsonString(value)}"
        }
        val tags = data.tags_text.split(',').map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        val tagJson = ",\"tags\":[${tags.joinToString(",") { jsonString(it) }}]"
        // SENT ONLY WHEN CHANGED: restating a held flag would pin it over the
        // vault's rule that a new password clears it (R-1047-F7).
        val flagJson = if (data.compromised != storedFlag(held)) ",\"compromised\":${data.compromised}" else ""
        val head = if (edit) {
            "\"item_id\":${jsonString(held.screen.item_id)}"
        } else {
            "\"item_id\":${jsonString(held.screen.item_id)},\"type\":${jsonString(type)}"
        }
        val command = if (edit) "locker.edit_item" else "locker.add_item"
        // THE KEY NAMES THE SITTING AND THE ATTEMPT, NEVER THE CONTENT: an
        // invoke key is logged, and this draft carries a secret.
        val token = held.tokens + 1
        val step = WriteLaw.submit(Writes, held.screen, command, "{$head$fields$tagJson$flagJson}", InvokeKeys.of(command, held.screen.item_id, token.toString()))
        return Step(held.copy(screen = step.state, tokens = token), step.effects)
    }

    override fun settled(held: LockerHeld<LockerEditorState>, settled: WriteSettled): Step<LockerHeld<LockerEditorState>> {
        val step = WriteLaw.settled(Writes, held.screen, settled)
        val committed = step.state.write?.phase == WriteState.Phase.PHASE_COMMITTED
        return Step(if (committed) closed(held.copy(screen = step.state)) else held.copy(screen = step.state), step.effects)
    }

    override fun decorate(held: LockerHeld<LockerEditorState>): LockerEditorState = held.screen.copy(
        data_ = held.screen.data_?.let { it.copy(compromised_note = flagNote(held, it)) },
        chrome = LockerEditorChrome(
            title = if (held.screen.mode == LockerEditorState.Mode.MODE_EDIT) LockerCopy.EDIT_TITLE else LockerCopy.ADD_TITLE,
            save_label = LockerCopy.SAVE,
            cancel_label = LockerCopy.CANCEL,
            lede = LockerCopy.EDITOR_LEDE,
        ),
    )

    private object Writes : WriteLens<LockerEditorState> {
        override fun write(state: LockerEditorState): WriteState = state.write ?: WriteState()

        override fun with(state: LockerEditorState, write: WriteState): LockerEditorState = state.copy(write = write)
    }

    internal object Lens : ContentLens<LockerEditorState, LockerEditorData> {
        override fun content(state: LockerEditorState): ReadContent<LockerEditorData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: LockerEditorState, content: ReadContent<LockerEditorData>): LockerEditorState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/** What the editor asks: the item it edits, on EDIT only. */
public object LockerEditorReads : LockerQueries<LockerEditorState, LockerEditorEvent>(
    screenId = "locker.editor",
    tables = LOCKER_TABLES,
    ask = { held, now ->
        held.screen.item_id
            .takeIf { it.isNotEmpty() && held.screen.mode == LockerEditorState.Mode.MODE_EDIT }
            ?.let { listOf(AppQueryRequest(locker_item = LockerItemRequest(item_id = it, tz = now.zone))) }
    },
)
