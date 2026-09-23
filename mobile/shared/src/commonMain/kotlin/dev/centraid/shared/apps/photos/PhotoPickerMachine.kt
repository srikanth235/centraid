package dev.centraid.shared.apps.photos

import centraid.screen.v1.Loading
import centraid.screen.v1.PhotoPickerEvent
import centraid.screen.v1.PhotoPickerState
import centraid.screen.v1.PhotosGridData
import centraid.screen.v1.SeatState
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * ADDING PHOTOGRAPHS TO AN ALBUM (#1029, the photos port; v0's
 * `PhotoPicker.tsx`).
 *
 * Not `PhotoShelfState` with `selecting = true`, and the distinction is the
 * whole reason this is a screen: the picked set is the picker's own and the
 * album is a route parameter. A shelf that could be picked from would carry an
 * album id on every surface that shows one, and "add to album" would become a
 * verb the favourites shelf also has to have an answer for.
 *
 * ## An album REFERS; it does not copy
 *
 * v0 states this to the member in one line above the grid and this machine
 * keeps it ([REFERS_NOT_COPIES]), because it is the fact that makes the screen
 * safe to use: nothing is duplicated, nothing moves, and removing the reference
 * later takes nothing away from the library.
 *
 * ## What is already in the album is drawn as TAKEN, not hidden
 *
 * `already_in_album_asset_ids` rides in with `Opened` and is never picked from.
 * Hiding those rows instead would leave a member hunting for the photograph
 * they added last week and concluding the picker is broken; drawn as taken,
 * they find it and find out why it will not tick.
 */
public object PhotoPickerMachine : ScreenMachine<PhotoPickerState, PhotoPickerEvent> {
    public const val SCREEN_ID: String = "photos.picker"

    /** v0's sentence, verbatim. The one thing this screen tells a member. */
    public const val REFERS_NOT_COPIES: String =
        "An album refers to a photograph where it lives."

    /** Also v0's, and it is not the library's empty sentence: the library HAS rows. */
    public const val NOTHING_LEFT: String =
        "Everything in your library is already in this album."

    override fun initial(): PhotoPickerState = PhotoPickerState(
        loading = Loading(first_load = true),
    )

    override fun reduce(state: PhotoPickerState, event: PhotoPickerEvent): Step<PhotoPickerState> =
        when {
            // THE ALBUM AND ITS NAME ARRIVE WITH THE OPEN, so the head says
            // "Add to Portugal" before any read has landed. And so does what
            // the album already holds — the picker cannot ask for it, because
            // this screen's one read is over `media_asset` and the membership
            // is `core_collection_entry`; the surface that pushed this screen
            // was already showing the album and has the answer.
            event.opened != null -> {
                val opened = event.opened
                openLoad(
                    state.copy(
                        collection_id = opened.collection_id,
                        collection_name = opened.collection_name,
                        already_in_album_asset_ids = opened.already_in_album_asset_ids,
                        // A REOPENED PICKER PICKS NOTHING. Carrying a picked set
                        // across opens would add photographs to an album the
                        // member chose them for a different one.
                        picked_asset_ids = emptyList(),
                        // AND CARRIES NO REFUSAL. A sentence about an add that
                        // failed on another album is a sentence about a screen
                        // the member has left.
                        write_failure = null,
                    ),
                )
            }

            event.next_page != null -> Step(
                state,
                listOf(ScreenEffect.ReadPage(SCREEN_ID, event.next_page.after_cursor)),
            )

            event.data_ != null -> Step(
                state.copy(
                    loading = null,
                    failure = null,
                    data_ = merge(state.data_, event.data_.data_),
                ),
            )

            // A FAILED READ IS NOT AN EMPTY LIBRARY, and on this screen the
            // difference decides what the member does next: an empty library
            // means there is nothing to add, and a refused read means they must
            // not conclude that. No re-read is emitted.
            event.refused != null -> Step(
                state.copy(
                    loading = null,
                    data_ = null,
                    failure = event.refused.failure,
                ),
            )

            // A CHANGE ON `media_asset` — the library gained or lost a row.
            //
            // Re-read rather than patch, for the grid's reason: the page's
            // ORDER is by capture time and a patched cell in the wrong position
            // is a grid that disagrees with its own sort. Rows this picker is
            // not showing move nothing.
            event.rows_changed != null ->
                // AN EMPTY ID LIST MEANS "RE-READ THIS TABLE", NOT "NOTHING
                // OF MINE" (#1029, photos port). `none {}` over an empty list
                // is vacuously TRUE, and `ChangeFeed::tables_changed` emits
                // `pk_set: Vec::new()` for EVERY locally committed command —
                // it says so itself: "an empty `pk_set` reads as re-read this
                // table, which is what a screen does"
                // (`crates/core/src/events.rs:293`). Without the guard this
                // screen ignores the member's own writes and only ever moves
                // for a sync from another device, which arrives WITH keys.
                if (
                    event.rows_changed.asset_ids.isNotEmpty() &&
                    event.rows_changed.asset_ids.none { it in shownIds(state) }
                ) {
                    Step(state)
                } else {
                    firstLoad(state)
                }

            // A PICK IS A TOGGLE, AND IT REFUSES WHAT THE ALBUM ALREADY HOLDS.
            //
            // The guard is here and not only in the two views because it is the
            // rule and not the drawing: a member who could pick a taken cell
            // would send `media.add_to_album` for a row the album has, and the
            // command's own precondition would refuse it — which is a refusal
            // the member reads as a failure rather than as a no-op.
            event.pick != null -> {
                val asset = event.pick.asset_id
                if (asset in state.already_in_album_asset_ids) {
                    Step(state)
                } else {
                    val picked = state.picked_asset_ids
                    Step(
                        state.copy(
                            picked_asset_ids = if (asset in picked) {
                                picked - asset
                            } else {
                                picked + asset
                            },
                        ),
                    )
                }
            }

            // ONE `media.add_to_album` PER PICKED ASSET.
            //
            // The command takes one `album_id` and one `asset_id` and its
            // schema is `additionalProperties: false`, so there is no batch to
            // send and — this is the part v0 got wrong — **no `position`**. v0
            // sent one, computed from the album's current entry count; the
            // vault's schema would refuse it as an additional property, and the
            // whole add would fail on a field that was only ever there to
            // preserve an ordering the vault assigns itself.
            //
            // The picked set is NOT cleared here. A confirm that was refused
            // must leave the member their picks: clearing them optimistically
            // would mean re-choosing thirty photographs to find out which of
            // them the album already had.
            event.confirm != null -> {
                val writes = state.picked_asset_ids.map { assetId ->
                    ScreenEffect.SubmitWrite(
                        command = ADD_COMMAND,
                        inputJson = addInput(state.collection_id, assetId),
                        // THE KEY IS THE PAIR, because the intent is the pair:
                        // "this photograph, in this album". It is stable across
                        // a retry of the same confirm and different for every
                        // other one, which is what `invoke_key` is for.
                        invokeKey = "$ADD_COMMAND:${state.collection_id}:$assetId",
                    )
                }
                if (writes.isEmpty()) {
                    Step(state)
                } else {
                    // THE LAST REFUSAL GOES WHEN A NEW ATTEMPT STARTS. A member
                    // who has just pressed Add is owed the outcome of THAT
                    // press; the previous one's sentence under it is a screen
                    // answering a question nobody asked twice.
                    Step(state.copy(write_failure = null), writes)
                }
            }

            // ONE ADD CAME BACK.
            //
            // A committed add moves the photograph from picked to taken, HERE
            // and not by re-reading: `already_in_album_asset_ids` is this
            // screen's own knowledge — the membership lives in
            // `core_collection_entry` and this screen's read is over
            // `media_asset` — so nothing a re-read could fetch would say it.
            // The cell stops being pickable and starts drawing as taken, which
            // is the same state it would have had if the member had opened the
            // picker a second later.
            //
            // **THE SETTLE IS KEYED TO ITS ROW.** A confirm submits one
            // `media.add_to_album` per picked asset, and a screen that moved
            // the WHOLE picked set to taken on the first commit would tell a
            // member their photographs are in an album when some of the adds
            // were refused. So one id moves. An EMPTY id means the settle is
            // about the batch rather than about one row, and then nothing
            // moves: a screen that cannot tell which pick landed must not act
            // as though it can.
            //
            // **A REFUSAL LANDS IN `write_failure` AND NOWHERE ELSE.** Not in
            // `failure`, which is the READ's slot: a denied add put there would
            // replace the grid with an error message and the picker would lose
            // its library mid-pick, taking the member's picks off the screen
            // they were choosing from. `data_` and `picked_asset_ids` are
            // untouched, which is the whole point of the field.
            event.write_settled != null -> {
                val settled = event.write_settled
                if (settled.committed) {
                    val landed = settled.asset_id
                    Step(
                        state.copy(
                            already_in_album_asset_ids = if (landed.isEmpty()) {
                                state.already_in_album_asset_ids
                            } else {
                                (state.already_in_album_asset_ids + landed).distinct()
                            },
                            // THE PICK THAT LANDED STOPS BEING A PICK. It is
                            // drawn as taken from here on, which is the state
                            // it would have had if the member had opened the
                            // picker a second later — and the picks that did
                            // NOT land stay picked, which is the whole reason
                            // the id is on the event.
                            picked_asset_ids = state.picked_asset_ids - landed,
                            // A COMMIT CLEARS THE LAST REFUSAL. A sentence
                            // about an add that failed, still under one that
                            // worked, is a screen contradicting itself.
                            write_failure = null,
                        ),
                    )
                } else {
                    Step(
                        state.copy(
                            // THE CORE'S OWN SENTENCE when it has one —
                            // `CommandOutcome.reason` is the author's words for
                            // a denial or a failed precondition. Nothing here
                            // composes one out of an error: `Error.detail` is
                            // logs-only, and one reached a member's screen
                            // through exactly that field in #1020 wave 3.
                            write_failure = Reads.refused(
                                settled.sentence.ifEmpty {
                                    PhotoShelfMachine.WRITE_REFUSED_SENTENCE
                                },
                            ),
                        ),
                    )
                }
            }

            // THE ALBUM'S OWN MEMBERSHIP, READ BY THIS SCREEN — and UNIONED,
            // never replaced. A commit that landed while the walk was in flight
            // is in the taken set already, and a list that predates it must not
            // hand that photograph back as pickable. A list for another album
            // is a picker that was reopened under a slow read, and is dropped.
            event.members != null ->
                if (event.members.collection_id != state.collection_id) {
                    Step(state)
                } else {
                    val taken = (state.already_in_album_asset_ids + event.members.asset_ids).distinct()
                    Step(
                        state.copy(
                            already_in_album_asset_ids = taken,
                            // A PICK OF A PHOTOGRAPH THE ALBUM TURNS OUT TO HOLD
                            // IS NOT A PICK. Left in, it would be an add the
                            // vault refuses on `not_already_in_album`.
                            picked_asset_ids = state.picked_asset_ids.filterNot { it in taken },
                        ),
                    )
                }

            event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

            else -> Step(state)
        }

    /**
     * The `ReadPage.screenId` that asks for the album's membership — served
     * beside the library page by `PhotoPickerBridge`, because this screen's
     * page is `media_asset` and the membership is `core_collection_entry`.
     */
    public const val MEMBERS_READ_ID: String = "photos.picker.members"

    /**
     * AN OPEN READS TWO THINGS: the library, and what the album already holds.
     *
     * The membership used to arrive with the open, from whoever pushed this
     * screen — and nobody could supply it: the album shelf holds one page of
     * the album at most and both shells passed an empty list, so every cell
     * drew as addable and an add of a photograph already there was refused on
     * `not_already_in_album`. The picker reads it itself now.
     */
    private fun openLoad(state: PhotoPickerState): Step<PhotoPickerState> {
        val load = firstLoad(state)
        return load.copy(effects = load.effects + ScreenEffect.ReadPage(MEMBERS_READ_ID, afterCursor = null))
    }

    /**
     * The registered command, spelled once.
     *
     * `media.add_to_album` — `crates/vault/src/commands/media.rs`. See
     * `NotesEditorMachine.SAVE_COMMAND` for what a command name that is not in
     * the registry costs: a member reading "That request does not make sense to
     * this build" on every attempt, for ever, with nothing red anywhere.
     */
    public const val ADD_COMMAND: String = "media.add_to_album"

    internal fun addInput(collectionId: String, assetId: String): String =
        "{\"album_id\":${PhotoShelfMachine.jsonString(collectionId)}," +
            "\"asset_id\":${PhotoShelfMachine.jsonString(assetId)}}"

    private fun firstLoad(state: PhotoPickerState): Step<PhotoPickerState> = Step(
        state.copy(
            loading = Loading(first_load = true),
            failure = null,
            data_ = null,
        ),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    private fun merge(existing: PhotosGridData?, arriving: PhotosGridData?): PhotosGridData? {
        if (arriving == null) return existing
        if (existing == null) return arriving
        val known = existing.cells.map { it.asset_id }.toSet()
        return arriving.copy(
            cells = existing.cells + arriving.cells.filterNot { it.asset_id in known },
        )
    }

    private fun shownIds(state: PhotoPickerState): Set<String> =
        state.data_?.cells?.map { it.asset_id }?.toSet() ?: emptySet()

    /**
     * `media_asset` — the library this picker offers, and nothing else.
     *
     * NOT `core_collection_entry`, although the album's membership lives there
     * and this screen renders it: `already_in_album_asset_ids` arrived with the
     * route and is moved by this machine's own settle, so a change event over
     * that table would ask for a re-read that could not answer the question.
     * The shelf behind this picker is the surface that listens to it.
     */
    override fun rowsChanged(table: String, keys: List<String>): PhotoPickerEvent? =
        when (table) {
            TABLE -> PhotoPickerEvent(rows_changed = PhotoPickerEvent.RowsChanged(asset_ids = keys))
            else -> null
        }

    private const val TABLE: String = "media_asset"

    override fun seatChanged(seat: SeatState): PhotoPickerEvent =
        PhotoPickerEvent(seat_changed = PhotoPickerEvent.SeatChanged(seat = seat))
}
