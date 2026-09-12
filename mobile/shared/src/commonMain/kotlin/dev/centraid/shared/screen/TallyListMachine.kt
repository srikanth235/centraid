package dev.centraid.shared.screen

import centraid.screen.v1.Loading
import centraid.screen.v1.TallyListData
import centraid.screen.v1.TallyListEvent
import centraid.screen.v1.TallyListState

/**
 * The Tally list (#1020, D-1020-E3).
 *
 * v0 had a real store for this one — `apps/mobile/src/apps/tally/tally-store.ts`
 * — and its test pins the law this reducer is built around: **a failed read
 * never reads as an empty ledger.** Everything else on the screen (which band,
 * which page cursor, which pending-write overlay) v0 kept in React state, so
 * this machine invents it rather than porting it.
 */
public object TallyListMachine : ScreenMachine<TallyListState, TallyListEvent> {
    public const val SCREEN_ID: String = "tally.list"

    /**
     * The verb a seat WITHHOLDS rather than queueing: the occurrence id is
     * minted by the canonical engine, so a queued copy would be a second
     * authority for it (`docs/mobile-offline.md:257`).
     */
    public const val WITHHELD_VERB: String = "tally.materialize_recurring_expense"

    override fun initial(): TallyListState = TallyListState(
        destination = TallyListState.Destination.DESTINATION_ACTIVITY,
        loading = Loading(first_load = true),
    )

    override fun reduce(state: TallyListState, event: TallyListEvent): Step<TallyListState> =
        when {
            event.opened != null -> firstLoad(state)

            // A REFRESH OVER ROWS DOES NOT REPLACE THEM WITH A SPINNER.
            // `Loading(first_load = false)` exists for the case where there is
            // nothing to refresh over; a spinner painted over last night's rows
            // and a spinner over an empty frame are different screens, and
            // blanking the list on every pull-to-refresh is the bug.
            event.refreshed != null ->
                if (state.data_ == null) {
                    firstLoad(state)
                } else {
                    Step(
                        state.copy(loading = null, failure = null),
                        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
                    )
                }

            event.next_page != null -> Step(
                state,
                listOf(ScreenEffect.ReadPage(SCREEN_ID, event.next_page.after_cursor)),
            )

            // A BAND DESTINATION IS A PARAMETER, NOT A SECOND SCREEN
            // (`apps/mobile/src/navigation.ts:19-24`). The state machine is the
            // same machine; only the parameter and the rows change.
            event.destination != null -> firstLoad(
                state.copy(destination = event.destination.destination),
            )

            event.data_ != null -> Step(
                state.copy(
                    loading = null,
                    failure = null,
                    // AN EMPTY LEDGER IS A REAL ANSWER and reaches the screen
                    // as data with no rows — not as a failure, and not as the
                    // same thing a refusal produces.
                    data_ = merge(state.data_, event.data_.data_),
                ),
            )

            // A FAILED READ IS NOT AN EMPTY LIST. The rows are cleared and the
            // failure is the content: a screen that showed an empty ledger here
            // would be telling a member they owe nobody anything.
            event.refused != null -> Step(
                state.copy(
                    loading = null,
                    data_ = null,
                    failure = event.refused.failure,
                ),
                // NO RETRY EFFECT, EVER, FROM HERE. A retry is a wake — a
                // reachability change, a foreground, a freed disk — and the
                // shell's scheduler owns those. A reducer that re-read on its
                // own refusal is the 1 s retry loop `docs/mobile-offline.md:238`
                // parks the feed to stop, and it would keep re-applying the
                // failing batch.
            )

            // A change event touched rows this screen shows. Re-read the first
            // page rather than patching a row in place: the page's ORDER may
            // have changed, and a patched row in the wrong position is a list
            // that disagrees with its own sort.
            event.rows_changed != null ->
                if (event.rows_changed.expense_ids.none { it in shownIds(state) }) {
                    Step(state)
                } else {
                    Step(state, listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)))
                }

            event.seat_changed != null -> {
                val seat = event.seat_changed.seat
                Step(
                    state.copy(
                        seat = seat,
                        // WITHHELD, NOT QUEUED. The screen says so as a state
                        // rather than offering a verb whose answer would be a
                        // queued copy of an id the engine owns.
                        recurring_materialisation_withheld = Reads.isLocalOnly(seat),
                    ),
                )
            }

            else -> Step(state)
        }

    private fun firstLoad(state: TallyListState): Step<TallyListState> = Step(
        state.copy(
            loading = Loading(first_load = true),
            failure = null,
            data_ = null,
        ),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    /**
     * A page REPLACES on a first load and APPENDS on a later one. Both cases
     * exist and neither is the other: appending a first page duplicates the
     * list, replacing a later page loses it. The discriminator is not a flag on
     * the event — every path that asks for a first page clears `data_` first,
     * so `existing == null` IS "this is a first page", and there is no second
     * place for the two to disagree.
     */
    private fun merge(existing: TallyListData?, arriving: TallyListData?): TallyListData? {
        if (arriving == null) return existing
        if (existing == null) return arriving
        val known = existing.rows.map { it.expense_id }.toSet()
        val appended = arriving.rows.filterNot { it.expense_id in known }
        return arriving.copy(rows = existing.rows + appended)
    }

    private fun shownIds(state: TallyListState): Set<String> =
        state.data_?.rows?.map { it.expense_id }?.toSet() ?: emptySet()

    /**
     * The effect a screen emits when the member asks for the withheld verb.
     * Not a reducer case: the ask arrives from a sheet the list does not own,
     * and the answer is the same wherever it is asked from.
     */
    public fun withhold(): ScreenEffect = ScreenEffect.WithheldOffline(
        verb = WITHHELD_VERB,
        sentence = "Centraid adds this one when it can reach your gateway.",
    )
}
