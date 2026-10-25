package dev.centraid.shared.shell

import centraid.screen.v1.HomeData
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.SeatState
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * What the SHELF tells Home, held for the shells (#1135).
 *
 * Home is a Rust screen now: the springboard, its tiles, the lockup's words, the
 * switcher and the appearance key are `crates/screens/src/shell`. What stays
 * here is the part only this module can know, because the vault files, the
 * backup store and the seat are the [HomeSession]'s: which vaults the phone
 * holds, which one is in front, the backup line, the ribbon of a stranded write
 * and the seat. A shell reads this state and TELLS Rust Home those facts; this
 * reducer decides nothing a person sees, and records each as it is given.
 *
 * It goes with the session's plumbing (custody, backup and sync move to Rust in
 * their own lanes), and the tiles' reads, the grid's packing, the search and the
 * appearance went with Home: see `docs/screens.md`.
 */
public object HomeMachine : ScreenMachine<HomeState, HomeEvent> {
    public const val SCREEN_ID: String = "home"

    override fun initial(): HomeState = HomeState()

    override fun reduce(state: HomeState, event: HomeEvent): Step<HomeState> =
        when {
            // THE RIBBON replaces itself and touches nothing else.
            event.status != null ->
                Step(state.copy(data_ = (state.data_ ?: HomeData()).copy(status = event.status.status)))
            event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))
            // THE ROSTER IS SHELL KNOWLEDGE and is recorded as given: Home does not
            // sort it, drop the open vault out of it, or decide that a vault it
            // cannot identify is not there.
            event.roster_changed != null -> Step(state.copy(vaults = event.roster_changed.vaults))
            // THE BACKUP LINE is finished by `BackupLines` from the core's
            // `backup_status` and recorded as is.
            event.backup_line != null -> Step(state.copy(backup_line = event.backup_line.line))
            event.vault_changed != null -> Step(state.copy(vault = event.vault_changed.vault))
            else -> Step(state)
        }

    override fun rowsChanged(table: String, keys: List<String>): HomeEvent? = null

    override fun seatChanged(seat: SeatState): HomeEvent = HomeEvent(seat_changed = HomeEvent.SeatChanged(seat = seat))
}
