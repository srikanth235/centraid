package dev.centraid.shared.apps.locker

import centraid.screen.v1.LockerChoice
import centraid.screen.v1.LockerClipboard
import centraid.screen.v1.LockerGeneratorEvent
import centraid.screen.v1.LockerGeneratorState
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusLine
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * THE GENERATOR (#1047): a string without an item (the handoff's Generate
 * tab). It reads nothing and writes nothing — "Put it on an item" is an
 * intent the shell turns into the editor with the output preset — and its
 * randomness is the platform CSPRNG's, attached by the bridge to every event
 * ([LockerPasswords]). Characters or a PIN; words wait for a word list this
 * layer does not carry (recorded in `docs/decisions.md`, R-1047-L6).
 */
public object LockerGeneratorMachine : ScreenMachine<LockerHeld<LockerGeneratorState>, LockerInput<LockerGeneratorEvent>> {
    public const val SCREEN_ID: String = "locker.generator"

    private const val CHARACTERS: String = "characters"
    private const val PIN: String = "pin"

    /** How the generator stands: kind, length, what it includes. */
    private data class Options(val kind: String, val length: Int, val digits: Boolean, val symbols: Boolean)

    private fun optionsOf(state: LockerGeneratorState): Options = Options(
        kind = state.kinds.firstOrNull { it.selected }?.key ?: CHARACTERS,
        length = state.length.takeIf { it > 0 } ?: LockerPasswords.DEFAULT_LENGTH,
        digits = state.include.firstOrNull { it.key == "digits" }?.selected ?: true,
        symbols = state.include.firstOrNull { it.key == "symbols" }?.selected ?: true,
    )

    override fun initial(): LockerHeld<LockerGeneratorState> =
        LockerHeld(screen = worded(Options(CHARACTERS, LockerPasswords.DEFAULT_LENGTH, digits = true, symbols = true), output = ""))

    override fun reduce(
        state: LockerHeld<LockerGeneratorState>,
        event: LockerInput<LockerGeneratorEvent>,
    ): Step<LockerHeld<LockerGeneratorState>> = when (event) {
        is LockerInput.View -> view(state, event.event, event.entropy)
        is LockerInput.Lock ->
            // A RELOCK DROPS THE CANDIDATE, like anything a Locker screen held.
            if (event.open) Step(state.copy(open = true)) else Step(state.copy(open = false, screen = state.screen.copy(output = "", strength = "", clipboard = null, status = null)))
        else -> Step(state)
    }

    private fun view(
        held: LockerHeld<LockerGeneratorState>,
        event: LockerGeneratorEvent,
        entropy: ByteArray,
    ): Step<LockerHeld<LockerGeneratorState>> {
        val options = optionsOf(held.screen)
        val next = when {
            event.opened != null -> options
            event.kind_picked != null -> when (event.kind_picked.key) {
                PIN -> options.copy(kind = PIN, length = LockerPasswords.PIN_DEFAULT)
                CHARACTERS -> options.copy(kind = CHARACTERS, length = LockerPasswords.DEFAULT_LENGTH)
                else -> options
            }
            event.length != null -> options.copy(length = event.length.length.coerceIn(minOf(options.kind), maxOf(options.kind)))
            event.include != null -> when (event.include.key) {
                "digits" -> options.copy(digits = !options.digits)
                "symbols" -> options.copy(symbols = !options.symbols)
                else -> options
            }
            event.regenerate != null -> options
            event.copy != null -> return copied(held)
            event.clipboard_done != null ->
                return if (held.screen.clipboard?.token == event.clipboard_done.token) {
                    Step(held.copy(screen = held.screen.copy(clipboard = null)))
                } else {
                    Step(held)
                }
            // INTENT ("Put it on an item"): the shell opens the editor.
            else -> return Step(held)
        }
        val alphabet = LockerPasswords.alphabet(pin = next.kind == PIN, digits = next.digits, symbols = next.symbols)
        // AN EXHAUSTED DRAW KEEPS THE LAST OUTPUT rather than padding a short
        // one: the next event brings fresh bytes.
        val output = LockerPasswords.generate(entropy, alphabet, next.length) ?: held.screen.output
        return Step(held.copy(screen = worded(next, output)))
    }

    private fun copied(held: LockerHeld<LockerGeneratorState>): Step<LockerHeld<LockerGeneratorState>> {
        val output = held.screen.output.takeIf { it.isNotEmpty() } ?: return Step(held)
        val token = held.tokens + 1
        return Step(
            held.copy(
                tokens = token,
                screen = held.screen.copy(
                    clipboard = LockerClipboard(token = token, value_ = output, expires_in_ms = LockerItemMachine.CLIPBOARD_MS, sensitive = true),
                    status = StatusLine(sentence = LockerCopy.GENERATED_COPIED),
                ),
            ),
        )
    }

    private fun minOf(kind: String): Int = if (kind == PIN) LockerPasswords.PIN_MIN else LockerPasswords.MIN_LENGTH

    private fun maxOf(kind: String): Int = if (kind == PIN) LockerPasswords.PIN_MAX else LockerPasswords.MAX_LENGTH

    private fun worded(options: Options, output: String): LockerGeneratorState {
        val pin = options.kind == PIN
        val alphabet = LockerPasswords.alphabet(pin = pin, digits = options.digits, symbols = options.symbols)
        val bits = LockerPasswords.bits(alphabet.length, options.length)
        return LockerGeneratorState(
            title = LockerCopy.GENERATOR_TITLE,
            output = output,
            strength = if (output.isEmpty()) "" else LockerEditorMachine.strength(bits),
            kinds = listOf(
                LockerChoice(key = CHARACTERS, label = LockerCopy.KIND_CHARACTERS, selected = !pin),
                LockerChoice(key = PIN, label = LockerCopy.KIND_PIN, selected = pin),
            ),
            kinds_label = LockerCopy.KIND,
            length = options.length,
            length_min = minOf(options.kind),
            length_max = maxOf(options.kind),
            length_label = LockerFold.fill(LockerCopy.LENGTH, "n" to options.length.toString()),
            include = if (pin) {
                emptyList()
            } else {
                listOf(
                    LockerChoice(key = "digits", label = LockerCopy.INCLUDE_DIGITS, selected = options.digits),
                    LockerChoice(key = "symbols", label = LockerCopy.INCLUDE_SYMBOLS, selected = options.symbols),
                )
            },
            include_label = if (pin) "" else LockerCopy.INCLUDE,
            lookalike_note = if (pin) "" else LockerCopy.LOOKALIKES,
            regenerate_label = LockerCopy.REGENERATE,
            copy_label = LockerCopy.COPY,
            use_label = if (pin) "" else LockerCopy.USE_ON_ITEM,
            accessibility_label = LockerCopy.GENERATOR_A11Y,
        )
    }

    override fun rowsChanged(table: String, keys: List<String>): LockerInput<LockerGeneratorEvent>? = null

    override fun seatChanged(seat: SeatState): LockerInput<LockerGeneratorEvent> = LockerInput.Seat(seat)
}

/** The generator reads nothing: no request, ever. */
public object LockerGeneratorReads : LockerQueries<LockerGeneratorState, LockerGeneratorEvent>(
    screenId = LockerGeneratorMachine.SCREEN_ID,
    tables = emptySet(),
    ask = { _, _ -> null },
)
