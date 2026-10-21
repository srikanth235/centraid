package dev.centraid.shared.apps.health

import centraid.screen.v1.HealthChoice
import centraid.screen.v1.HealthConnectEvent
import centraid.screen.v1.HealthConnectState
import centraid.screen.v1.HealthDevice
import centraid.screen.v1.HealthPageChrome
import centraid.screen.v1.SeatState
import dev.centraid.design.copy.HealthCopy
import dev.centraid.shared.nav.ScreenIds
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * CONNECT (#1129): what Health may read, one switch a type, and the one Ink button. It reads
 * nothing from the vault: the member's choice is the phone's (R-1129-6, like a followed folder's
 * access), so the screen starts from what the shell last stated ([HealthDevice.chosen], every type
 * the first time) and hands the shell the keys to ask the OS for ([HealthConnectState.chosen]).
 * Active energy and exercise are one switch, as the store's own sheet groups them. The OS is
 * asked only here, at the member's tap, for read types only (R-1129-7, R-1127-15).
 */
public object HealthConnectMachine : ScreenMachine<HealthConnectState, HealthConnectEvent> {
    public const val SCREEN_ID: String = ScreenIds.HEALTH_CONNECT

    public const val CHOICE_STEPS: String = "steps"
    public const val CHOICE_SLEEP: String = "sleep_min"
    public const val CHOICE_ENERGY: String = "energy"
    public const val CHOICE_HEART: String = "resting_hr_bpm"
    public const val CHOICE_WEIGHT: String = "weight_kg"
    public const val CHOICE_WORKOUTS: String = "workouts"

    /** A switch → the type keys it stands for. */
    internal val KEYS: Map<String, List<String>> = linkedMapOf(
        CHOICE_STEPS to listOf(HealthMetrics.STEPS.key),
        CHOICE_SLEEP to listOf(HealthMetrics.SLEEP.key),
        CHOICE_ENERGY to listOf(HealthMetrics.ENERGY.key, HealthMetrics.EXERCISE.key),
        CHOICE_HEART to listOf(HealthMetrics.RESTING_HR.key),
        CHOICE_WEIGHT to listOf(HealthMetrics.WEIGHT.key),
        CHOICE_WORKOUTS to listOf(HealthMetrics.WORKOUTS),
    )

    override fun initial(): HealthConnectState = decorate(HealthConnectState(device = HealthDevice(units = HealthDevice.Units.UNITS_METRIC)), parent = "")

    override fun reduce(state: HealthConnectState, event: HealthConnectEvent): Step<HealthConnectState> = Step(
        when {
            event.opened != null -> {
                val device = event.opened.device ?: state.device
                val chosen = device?.chosen.orEmpty()
                decorate(
                    state.copy(
                        device = device,
                        choices = KEYS.map { (key, keys) -> HealthChoice(key = key, on = chosen.isEmpty() || keys.any { it in chosen }) },
                        working = false,
                        status = "",
                    ),
                    parent = event.opened.parent,
                )
            }
            event.toggled != null && !state.working -> decorate(
                state.copy(choices = state.choices.map { if (it.key == event.toggled.key) it.copy(on = !it.on) else it }, status = ""),
            )
            // The shell asks the OS for `chosen`, then connects; nothing more is tapped meanwhile.
            event.connect != null && state.can_connect -> decorate(state.copy(working = true, status = ""))
            event.connected != null -> decorate(state.copy(working = false, status = ""))
            event.failed != null -> decorate(
                state.copy(
                    working = false,
                    status = event.failed.sentence.ifEmpty {
                        HealthFold.fill(HealthCopy.CONNECT_FAILED, "store" to HealthFold.store(HealthFold.device(state.device)))
                    },
                ),
            )
            else -> state
        },
    )

    /** Every word, the switches' words, the keys to ask for, and whether the button is live. */
    private fun decorate(state: HealthConnectState, parent: String? = null): HealthConnectState {
        val store = HealthFold.store(HealthFold.device(state.device))
        val choices = (state.choices.ifEmpty { KEYS.keys.map { HealthChoice(key = it, on = true) } }).map { it.copy(label = label(it.key), detail = detail(it.key)) }
        val chosen = choices.filter { it.on }.flatMap { KEYS[it.key].orEmpty() }
        val status = when {
            state.status.isNotEmpty() -> state.status
            state.working -> HealthFold.fill(HealthCopy.CONNECT_WORKING_STATUS, "store" to store)
            chosen.isEmpty() -> HealthCopy.CONNECT_NONE_STATUS
            else -> ""
        }
        return state.copy(
            chrome = HealthPageChrome(
                title = HealthCopy.CONNECT_TITLE,
                back_label = parent?.ifEmpty { HealthCopy.APP_TITLE } ?: state.chrome?.back_label ?: HealthCopy.APP_TITLE,
                retry = HealthCopy.RETRY,
            ),
            headline = HealthCopy.CONNECT_HEADLINE,
            lede = HealthFold.fill(HealthCopy.CONNECT_BODY, "store" to store),
            choices_title = HealthCopy.READS_TITLE,
            choices = choices,
            note = HealthFold.fill(HealthCopy.CONNECT_NOTE, "store" to store) + " " + HealthCopy.CONNECT_DEPTH_NOTE,
            connect_label = HealthFold.fill(HealthCopy.CONNECT_ACTION, "store" to store),
            can_connect = chosen.isNotEmpty() && !state.working,
            chosen = chosen,
            status = status,
        )
    }

    private fun label(key: String): String = when (key) {
        CHOICE_STEPS -> HealthCopy.CHOICE_STEPS
        CHOICE_SLEEP -> HealthCopy.CHOICE_SLEEP
        CHOICE_ENERGY -> HealthCopy.CHOICE_ENERGY
        CHOICE_HEART -> HealthCopy.CHOICE_HEART
        CHOICE_WEIGHT -> HealthCopy.CHOICE_WEIGHT
        else -> HealthCopy.CHOICE_WORKOUTS
    }

    private fun detail(key: String): String = when (key) {
        CHOICE_STEPS -> HealthCopy.CHOICE_STEPS_DETAIL
        CHOICE_SLEEP -> HealthCopy.CHOICE_SLEEP_DETAIL
        CHOICE_ENERGY -> HealthCopy.CHOICE_ENERGY_DETAIL
        CHOICE_HEART -> HealthCopy.CHOICE_HEART_DETAIL
        CHOICE_WEIGHT -> HealthCopy.CHOICE_WEIGHT_DETAIL
        else -> HealthCopy.CHOICE_WORKOUTS_DETAIL
    }

    override fun rowsChanged(table: String, keys: List<String>): HealthConnectEvent? = null

    override fun seatChanged(seat: SeatState): HealthConnectEvent? = null
}
