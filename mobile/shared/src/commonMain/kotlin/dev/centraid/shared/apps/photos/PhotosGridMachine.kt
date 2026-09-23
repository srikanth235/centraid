package dev.centraid.shared.apps.photos

import centraid.screen.v1.SeatState
import centraid.screen.v1.BackupState
import centraid.screen.v1.Loading
import centraid.screen.v1.MediaPermission
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotosGridData
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.PhotosGridState
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * The Photos grid, with camera-roll backup (#1020, D-1020-E3).
 *
 * The screen where four of the census's traps meet: the OS grant is a state and
 * not a route, `more` is a sheet and not a destination, a failed read is not an
 * empty grid, and low disk PARKS rather than evicting.
 *
 * ## The distinction this screen exists to keep
 *
 * **The grid reads the VAULT; the backup reads the CAMERA ROLL.** They are two
 * planes with two permissions, and conflating them is how a denied media
 * permission blanks a library the member already owns. So a permission change
 * moves `backup` and never `content`.
 *
 * ## The whole library, one page at a time (#1029, photos port)
 *
 * The grid read ONE page and stopped, so a library past a hundred and twenty
 * photographs ended mid-March with nothing to say it did (v0 walked all of it,
 * `timeline-page.ts`). It now pages as the member scrolls, and it keeps **at
 * most one page read in flight**: `DataArrived` does not say which request it
 * answers, so a refresh that raced a next page would otherwise splice page
 * three onto a fresh page one. `reading` is the request outstanding and
 * `queued` the one wished for behind it; every answer is matched to its
 * question by elimination rather than by a tag the door cannot carry.
 *
 * A write, a sync or a return to the screen RE-READS IN PLACE (`restage`): the
 * pages the member had scrolled through are read again into a buffer and
 * swapped in whole, so a favourite neither blanks the grid to skeletons nor
 * throws the scroll back to the top.
 *
 * ## The library's own controls
 *
 * v0's `PhotosHome.tsx`: the zoom (Years · Months · All), the filter (All ·
 * Favorites), the tile size, and a selection with its writes — favourite,
 * add to album, trash. All of them are state here, not in a view, so both
 * shells show the same library the same way and a recomposition loses none of
 * it.
 */
public object PhotosGridMachine : ScreenMachine<PhotosGridState, PhotosGridEvent> {
    public const val SCREEN_ID: String = "photos.grid"

    override fun initial(): PhotosGridState = PhotosGridState(
        destination = PhotosGridState.Destination.DESTINATION_LIBRARY,
        permission = MediaPermission.MEDIA_PERMISSION_NOT_ASKED,
        loading = Loading(first_load = true),
        sheet = PhotosGridState.Sheet.SHEET_NONE,
        backup = BackupState(phase = BackupState.Phase.PHASE_IDLE),
        grain = PhotosGridState.Grain.GRAIN_ALL,
        filter = PhotosGridState.Filter.FILTER_ALL,
        rung = PhotosTimeline.DEFAULT_RUNG,
    )

    override fun reduce(state: PhotosGridState, event: PhotosGridEvent): Step<PhotosGridState> =
        when {
            // OPENING A LIBRARY THAT IS ALREADY DRAWN RE-READS IT IN PLACE. The
            // shells send `Opened` every time the library band comes back —
            // from Collections, from the lightbox — and a first-page reload
            // there blanked the grid to skeletons and threw away every page
            // the member had scrolled.
            //
            // AN OPEN OVER A FIRST READ STILL OUTSTANDING ASKS AGAIN rather than
            // queueing behind it. `ScreenHost.effects` drops what it emits with
            // nobody listening, so a first `ReadPage` sent before the runner
            // attached is gone — and a ledger that waited on it would wait for
            // ever. A second answer to the same question folds in by id.
            event.opened != null -> when {
                state.data_ == null && state.reading == FIRST ->
                    Step(state, listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)))
                state.data_ == null -> request(state, FIRST)
                else -> request(state, REFRESH)
            }

            // A BAND DESTINATION IS A PARAMETER (`navigation.ts:19-24`).
            //
            // LEAVING THE LIBRARY RESETS WHAT ONLY THE LIBRARY HAS (v0's
            // `PhotosHome`): a selection must not outlive the grid it was made
            // on, and the zoom comes back to All. The photographs themselves
            // stay read — Collections and Search do not draw them, and a
            // return is a refresh, not a reload.
            event.destination != null -> {
                val destination = event.destination.destination
                val library = destination == PhotosGridState.Destination.DESTINATION_LIBRARY ||
                    destination == PhotosGridState.Destination.DESTINATION_UNSPECIFIED
                val moved = if (library) {
                    state.copy(destination = destination)
                } else {
                    leaveSelection(state).copy(
                        destination = destination,
                        grain = PhotosGridState.Grain.GRAIN_ALL,
                        place_day = "",
                    )
                }
                if (library && moved.data_ == null && moved.reading == NONE) {
                    request(moved, FIRST)
                } else {
                    Step(moved)
                }
            }

            // THE MACHINE KNOWS ITS OWN CURSOR. The event's `after_cursor` is
            // what the view last saw, and the state is what the walk is
            // actually at — which walk, and where in it.
            event.next_page != null -> request(state, MORE)

            // A change event touched assets this grid shows — a row the
            // gateway changed, or a FILE THAT LANDED, which since
            // D-1025-S7-20 is the same event over the same table. Re-read
            // rather than patching a cell in place: the page's ORDER is by
            // capture time and a patched cell in the wrong position is a grid
            // that disagrees with its own sort. Assets it is NOT showing move
            // nothing — a roll gains rows all day during a backup.
            // **AN EMPTY ID LIST MEANS "RE-READ THIS TABLE", NOT "NOTHING OF
            // MINE"** (#1029, photos port). `none {}` over an empty list is
            // vacuously TRUE, so this arm read an empty `pk_set` as a change
            // worth ignoring and answered `Step(state)` — and
            // `ChangeFeed::tables_changed` emits `pk_set: Vec::new()` for
            // EVERY locally committed command, saying so in its own words:
            // "an empty `pk_set` reads as re-read this table, which is what a
            // screen does" (`crates/core/src/events.rs:293`).
            //
            // So the library grid never redrew from the member's own writes.
            // Favourite a photograph, archive one, delete one: the row moved
            // in the vault, the core announced it, and this screen decided the
            // announcement was about somebody else. Only a sync from another
            // device — which arrives WITH keys — ever moved it.
            event.rows_changed != null -> changed(state, event.rows_changed)

            event.data_ != null -> arrived(state, event.data_.data_ ?: PhotosGridData())

            event.refused != null -> refusedRead(state, event.refused.failure)

            // AN OS PERMISSION IS A STATE, NOT A ROUTE (#712,
            // `navigation.ts:41-42`) — and it moves the BACKUP, never the grid.
            event.permission != null -> {
                val permission = event.permission.permission
                Step(
                    state.copy(
                        permission = permission,
                        backup = (state.backup ?: BackupState()).copy(
                            phase = if (canEnumerate(permission)) {
                                state.backup?.phase ?: BackupState.Phase.PHASE_IDLE
                            } else {
                                BackupState.Phase.PHASE_IDLE
                            },
                            paused_reason = pausedReason(permission),
                        ),
                    ),
                    // The ask is not re-issued from here: the answer arrived,
                    // and asking again on every answer is a permission prompt
                    // loop.
                )
            }

            event.permission_requested != null -> Step(
                state,
                listOf(ScreenEffect.RequestMediaPermission),
            )

            // A DISCRIMINATED UNION, NOT A BAG OF OPTIONALS
            // (`navigation.ts:43-46`). Opening a state view is a navigation
            // effect the shell performs; the grid's own state does not change,
            // which is why there is no `state_view` field on the state.
            event.state_view != null -> Step(state)

            // `more` IS A SHEET, NEVER A DESTINATION. It cannot change the
            // band, and the type system is what says so: `Sheet` and
            // `Destination` are two enums and neither admits the other's
            // values.
            //
            // A TRASH CONFIRM OVER NOTHING IS NOT ASKED. The bar disables the
            // verb with nothing picked; this is the same rule one layer down.
            event.sheet != null ->
                if (event.sheet.sheet == PhotosGridState.Sheet.SHEET_CONFIRM_TRASH &&
                    state.selected.isEmpty()
                ) {
                    Step(state)
                } else {
                    Step(state.copy(sheet = event.sheet.sheet))
                }

            event.backup != null -> Step(state.copy(backup = event.backup.backup))

            // THE MEMBER TAPPED THE DOWNLOAD ARROW (#1025 S5, D-1025-S7-63).
            //
            // The cell goes to `HELD_FETCHING` HERE and not when the answer
            // comes back: the round trip is the whole duration a member is
            // waiting through, and an affordance that stays un-pressed until it
            // finishes is one a member taps again.
            //
            // Painted over the cell in place rather than by re-reading, which
            // is the one case where patching a cell is right: nothing about its
            // POSITION changed — the sort is by capture time and a tap does not
            // move a photograph in time — and a re-read here would throw away
            // every page the member had scrolled.
            event.fetch_original != null -> {
                val tapped = event.fetch_original
                Step(
                    state.copy(data_ = paint(state.data_, tapped.asset_id, PhotoCell.Held.HELD_FETCHING)),
                    listOf(
                        ScreenEffect.FetchOriginal(
                            SCREEN_ID,
                            tapped.asset_id,
                            tapped.content_hash,
                        ),
                    ),
                )
            }

            // THE ANSWER CAME BACK. A fetch that LANDED redraws through the row
            // change its own bytes caused, so this is here for the other two
            // outcomes — a gateway that was not reached, and a refusal by code
            // — and what it does is stop the spinner. A cell left spinning
            // because nobody said "it did not happen" is the state this
            // deletes.
            event.fetch_settled != null -> {
                val settled = event.fetch_settled
                if (settled.fetched) {
                    Step(state)
                } else {
                    Step(
                        state.copy(
                            data_ = paint(
                                state.data_,
                                settled.asset_id,
                                // BACK TO WHAT THE READ SAID, and the read said
                                // the rule was holding it — which is still true
                                // and is still the state that carries the
                                // arrow, so the member can try again.
                                PhotoCell.Held.HELD_WITHHELD_BY_RULE,
                            ),
                        ),
                    )
                }
            }

            event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

            // THE ZOOM MOVED, AND IT LANDS WHERE THE MEMBER WAS (v0's
            // `changeGrain` → `anchorForGrain`). Switching up a grain must not
            // dump the scroll: the day the member was looking at becomes the
            // period that holds it, and back down again.
            event.grain != null -> {
                val grain = event.grain.grain
                Step(
                    state.copy(
                        grain = grain,
                        place_day = PhotosTimeline.anchor(grain, event.grain.at_day, loadedDays(state)),
                    ),
                )
            }

            // A CARD IS A DOOR ONE GRAIN IN, at that period's first day (v0's
            // `openPeriod`). Off the grain on screen, never a captured copy.
            event.period != null -> Step(
                state.copy(
                    grain = PhotosTimeline.narrower(state.grain),
                    place_day = event.period.anchor_day,
                ),
            )

            event.rung != null -> Step(state.copy(rung = PhotosTimeline.clampRung(event.rung.rung)))

            // THE FILTER NARROWS THE READ, NOT THE DRAWING. Favorites is a
            // different statement (`PhotosReads`' `STARRED`), so the library is
            // read again from its first page under it — filtering the pages
            // already loaded would show "No favorites yet" over a library whose
            // favourites simply had not been paged in.
            event.filter != null ->
                if (event.filter.filter == state.filter) {
                    Step(state)
                } else {
                    request(state.copy(filter = event.filter.filter, place_day = ""), FIRST)
                }

            // SELECT IS A MODE (Apple Photos, and v0's room). Entering it picks
            // nothing; leaving it empties the set, closes the album sheet and
            // takes back a confirm that was asking about it.
            event.selection_mode != null ->
                if (event.selection_mode.selecting) {
                    Step(state.copy(selecting = true, selected = emptyList(), write_failure = null, export_notice = ""))
                } else {
                    Step(leaveSelection(state))
                }

            // A tap while selecting — or a long press on a tile, which is how a
            // member enters the mode WITH that photograph picked.
            event.selection_toggled != null -> {
                val id = event.selection_toggled.asset_id
                val picked = if (id in state.selected) state.selected - id else state.selected + id
                Step(state.copy(selecting = true, selected = picked))
            }

            // A drag across tiles or a day's "Select": a set joins or leaves
            // at once, and the order it was picked in is kept.
            event.selection_set != null -> {
                val ids = event.selection_set.asset_ids
                val picked = if (event.selection_set.selected) {
                    state.selected + ids.filterNot { it in state.selected }.distinct()
                } else {
                    state.selected.filterNot { it in ids }
                }
                Step(state.copy(selecting = true, selected = picked))
            }

            // ONE VALUE FOR THE WHOLE SELECTION, never a per-item toggle
            // (`photos-selection-writes.ts`' `batchFavorite`). The selection
            // stays: favouriting is not the end of a member's job with it.
            event.favorite_selected != null -> {
                val on = event.favorite_selected.favorite
                Step(
                    state.copy(write_failure = null, export_notice = ""),
                    state.selected.map { assetId -> favoriteWrite(assetId, on) },
                )
            }

            // TRASH IS CONFIRMED FIRST, and the confirm is the view's sheet over
            // `SHEET_CONFIRM_TRASH`. The mode ends as the writes go: every
            // photograph picked is on its way out of the grid, and a bar still
            // counting them would be counting nothing.
            event.trash_confirmed != null -> {
                val picked = state.selected
                Step(
                    leaveSelection(state).copy(write_failure = null),
                    picked.map { assetId ->
                        ScreenEffect.SubmitWrite(
                            command = PhotoLightboxMachine.DELETE_COMMAND,
                            inputJson = "{\"asset_id\":" + PhotoShelfMachine.jsonString(assetId) + "}",
                            invokeKey = PhotoLightboxMachine.DELETE_COMMAND + ":" + assetId,
                        )
                    },
                )
            }

            // THE ALBUM SHEET — `AlbumChoice.kt`'s five steps, in order.
            event.album_choice_opened != null ->
                if (state.selected.isEmpty()) {
                    Step(state)
                } else {
                    Step(state.copy(album_choice_open = true, export_notice = ""), AlbumChoice.openEffects())
                }

            event.album_choice_dismissed != null -> Step(state.copy(album_choice_open = false))

            event.album_choices != null -> Step(state.copy(album_choices = event.album_choices.choices))

            // The pick goes in and the mode ends — v0's `addSelectionToAlbum`
            // cleared the selection once the writes were sent.
            event.album_chosen != null -> {
                val picked = state.selected
                Step(
                    leaveSelection(state).copy(write_failure = null),
                    AlbumChoice.addEffects(picked, event.album_chosen.album_id),
                )
            }

            // "New album…" — the create alone, and the sheet STAYS OPEN: the new
            // album joins the list when its commit re-reads it.
            event.album_created != null -> Step(
                state.copy(write_failure = null),
                AlbumChoice.createEffects(event.album_created.title),
            )

            // WHAT "SEND A COPY" CAME TO. The shell did the hand-off
            // (`LibraryCopies`); the selection stays, as it does after Apple
            // Photos' share sheet, because sending is not the end of a member's
            // job with it.
            event.export_settled != null -> Step(state.copy(export_notice = event.export_settled.sentence))

            // THE MORE SHEET'S "FREE UP SPACE" ROW, as the census found it
            // (`KeepOriginals.attachGrid`). Stored whole: the sentences are
            // derived once, there.
            event.free_up_counted != null -> Step(state.copy(free_up = event.free_up_counted.free_up))

            // A COMMITTED WRITE IS A RE-READ, and the change feed is what
            // carries it — so a commit changes nothing here. A REFUSAL lands on
            // `write_failure`, its own slot: a denied favourite must not
            // replace the library with an error, and it must not be silent.
            event.write_settled != null ->
                if (event.write_settled.committed) {
                    Step(state)
                } else {
                    Step(
                        state.copy(
                            write_failure = Reads.refused(
                                event.write_settled.sentence.ifEmpty {
                                    PhotoLightboxMachine.WRITE_REFUSED_WITHOUT_A_REASON
                                },
                            ),
                        ),
                    )
                }

            else -> Step(state)
        }

    /**
     * Can the backup enumerate the camera roll?
     *
     * `LIMITED` COUNTS. iOS's limited selection is a real library the member
     * chose, and a backup that treated it as a denial would back up nothing
     * while the member watched their selected photos sit there.
     */
    public fun canEnumerate(permission: MediaPermission): Boolean = when (permission) {
        MediaPermission.MEDIA_PERMISSION_GRANTED,
        MediaPermission.MEDIA_PERMISSION_LIMITED,
        -> true

        MediaPermission.MEDIA_PERMISSION_UNSPECIFIED,
        MediaPermission.MEDIA_PERMISSION_NOT_ASKED,
        MediaPermission.MEDIA_PERMISSION_DENIED,
        MediaPermission.MEDIA_PERMISSION_RESTRICTED,
        -> false
    }

    /**
     * FOUR REASONS, FOUR SENTENCES. "Not asked" has a button, "denied" has a
     * trip to Settings, and "restricted" has neither — one sentence for all
     * three would be a sentence that is wrong for two of them.
     */
    private fun pausedReason(permission: MediaPermission): String = when (permission) {
        MediaPermission.MEDIA_PERMISSION_GRANTED -> ""
        MediaPermission.MEDIA_PERMISSION_LIMITED ->
            "Centraid imports the photos you selected."
        MediaPermission.MEDIA_PERMISSION_NOT_ASKED ->
            "Centraid needs access to your photos to back them up."
        MediaPermission.MEDIA_PERMISSION_DENIED ->
            "Photo access is off. Turn it on in Settings to import your camera roll."
        MediaPermission.MEDIA_PERMISSION_RESTRICTED ->
            "This device does not allow photo access."
        MediaPermission.MEDIA_PERMISSION_UNSPECIFIED -> ""
    }

    private val NONE: PhotosGridState.ReadMode = PhotosGridState.ReadMode.READ_MODE_NONE
    private val FIRST: PhotosGridState.ReadMode = PhotosGridState.ReadMode.READ_MODE_FIRST
    private val MORE: PhotosGridState.ReadMode = PhotosGridState.ReadMode.READ_MODE_MORE
    private val REFRESH: PhotosGridState.ReadMode = PhotosGridState.ReadMode.READ_MODE_REFRESH

    /**
     * ASK FOR A READ — now, or behind the one in flight.
     *
     * A FIRST read outranks a refresh, which outranks a next page: a new
     * filter makes both of the others questions about a library that is no
     * longer on screen. A next page is never QUEUED, only dropped: the view
     * asks again when the page it is at the end of changes, and a queued
     * "more" behind a refresh would page from a cursor the refresh replaced.
     *
     * A FIRST read that has to wait still clears the grid NOW, so the member
     * sees the new filter's skeletons at once rather than the old filter's
     * photographs until an unrelated read comes home.
     */
    private fun request(state: PhotosGridState, mode: PhotosGridState.ReadMode): Step<PhotosGridState> {
        if (state.reading == NONE) return start(state, mode)
        return when (mode) {
            FIRST -> Step(
                state.copy(
                    queued = FIRST,
                    loading = Loading(first_load = true),
                    failure = null,
                    data_ = null,
                    restage = null,
                    restage_target = 0,
                ),
            )
            REFRESH ->
                if (state.queued == FIRST) Step(state) else Step(state.copy(queued = REFRESH))
            else -> Step(state)
        }
    }

    /** Start [mode] with nothing in flight. */
    private fun start(state: PhotosGridState, mode: PhotosGridState.ReadMode): Step<PhotosGridState> =
        when (mode) {
            FIRST -> Step(
                state.copy(
                    loading = Loading(first_load = true),
                    failure = null,
                    data_ = null,
                    restage = null,
                    restage_target = 0,
                    reading = FIRST,
                    reading_undated = false,
                    queued = NONE,
                ),
                listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
            )

            MORE -> {
                val data = state.data_
                when {
                    data == null || data.complete -> Step(state)
                    // A DATED WALK WITH NO CURSOR HAS ENDED, and that is the
                    // `undated_walk` flag's job to say — so this is a state the
                    // fold never makes, answered by asking for nothing.
                    !data.undated_walk && data.next_cursor == null -> Step(state)
                    else -> Step(
                        state.copy(reading = MORE, reading_undated = data.undated_walk, queued = NONE),
                        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = data.next_cursor)),
                    )
                }
            }

            REFRESH -> {
                val data = state.data_
                if (data == null) {
                    start(state, FIRST)
                } else {
                    Step(
                        state.copy(
                            reading = REFRESH,
                            reading_undated = false,
                            queued = NONE,
                            restage = PhotosGridData(thumbnail_pack_absent = data.thumbnail_pack_absent),
                            restage_target = data.cells.size,
                        ),
                        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
                    )
                }
            }

            else -> Step(state)
        }

    /**
     * ONE PAGE CAME HOME. Which question it answers is [PhotosGridState.reading],
     * because only one is ever outstanding.
     *
     * An answer to a question nobody is asking any more — the filter changed
     * while it was in flight — is DROPPED, and the queued first read goes out
     * in its place. An answer with nothing in flight is taken as a page to
     * append, which is what it was before the machine kept a ledger and what a
     * fixture that drives the reducer without a runner still sends.
     */
    private fun arrived(state: PhotosGridState, page: PhotosGridData): Step<PhotosGridState> {
        val undated = state.reading_undated
        val mode = state.reading
        val settled = state.copy(reading = NONE, reading_undated = false)
        if (state.queued == FIRST) return start(settled, FIRST)
        val next = when (mode) {
            REFRESH -> {
                val buffer = fold(state.restage, page, undated)
                if (buffer.complete || buffer.cells.size >= state.restage_target) {
                    // THE WHOLE EXTENT IS READ AGAIN: swap it in, and let go of
                    // any pick that is no longer in the library.
                    val kept = buffer.cells.map { it.asset_id }.toSet()
                    settled.copy(
                        loading = null,
                        failure = null,
                        data_ = buffer,
                        restage = null,
                        restage_target = 0,
                        selected = state.selected.filter { it in kept },
                    )
                } else {
                    // NOT YET AS FAR AS THE MEMBER HAD SCROLLED: keep walking,
                    // behind the library they are still looking at.
                    return Step(
                        settled.copy(
                            restage = buffer,
                            reading = REFRESH,
                            reading_undated = buffer.undated_walk,
                        ),
                        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = buffer.next_cursor)),
                    )
                }
            }

            FIRST -> settled.copy(loading = null, failure = null, data_ = fold(null, page, undated))

            else -> settled.copy(loading = null, failure = null, data_ = fold(state.data_, page, undated))
        }
        return drain(next)
    }

    /**
     * A READ WAS REFUSED.
     *
     * A refused FIRST read replaces the library with its sentence — a failed
     * read is not an empty grid. A refused next page or refresh leaves the
     * library EXACTLY as it is: the photographs on screen are still true, and
     * trading them for an error because page nine could not be read would be
     * the refusal taking more than it was about.
     */
    private fun refusedRead(
        state: PhotosGridState,
        failure: centraid.screen.v1.ReadFailure?,
    ): Step<PhotosGridState> {
        val parked = Reads.isParked(failure)
        // LOW DISK PARKS THE BACKUP TOO. One cause, two planes, and the member
        // sees one sentence about each rather than a grid that fails and a
        // backup that keeps claiming to run.
        val backup = if (parked) {
            (state.backup ?: BackupState()).copy(
                phase = BackupState.Phase.PHASE_PARKED_LOW_DISK,
                paused_reason = failure?.sentence ?: "",
            )
        } else {
            state.backup
        }
        val settled = state.copy(reading = NONE, reading_undated = false, backup = backup)
        val next = when (state.reading) {
            MORE, REFRESH -> settled.copy(restage = null, restage_target = 0)
            else -> settled.copy(loading = null, data_ = null, failure = failure)
        }
        // A PARKED FEED ASKS FOR NOTHING MORE: a retry loop that keeps
        // re-applying the failing batch is the regression the device contract
        // test already pins (census §E seam 8).
        return if (parked) Step(next.copy(queued = NONE)) else drain(next)
    }

    /** Send the read that was waiting, if one was. */
    private fun drain(state: PhotosGridState): Step<PhotosGridState> {
        val queued = state.queued
        if (state.reading != NONE || queued == NONE) return Step(state)
        return start(state.copy(queued = NONE), queued)
    }

    /**
     * WHAT A TABLE MOVING MEANS HERE. `media_asset` is the library; `core_tag`
     * is the star, which only the Favorites filter reads; the collection
     * tables are the album sheet's list, which only matters while it is open.
     */
    private fun changed(
        state: PhotosGridState,
        rows: PhotosGridEvent.RowsChanged,
    ): Step<PhotosGridState> = when {
        rows.table == STAR_TABLE ->
            if (state.filter == PhotosGridState.Filter.FILTER_FAVORITES) {
                request(state, REFRESH)
            } else {
                Step(state)
            }

        AlbumChoice.movesChoices(rows.table) ->
            if (state.album_choice_open) Step(state, AlbumChoice.openEffects()) else Step(state)

        rows.asset_ids.isNotEmpty() && rows.asset_ids.none { it in shownIds(state) } -> Step(state)

        else -> request(state, if (state.data_ == null) FIRST else REFRESH)
    }

    /**
     * THE MODE ENDS: nothing picked, no album sheet, no confirm left asking
     * about a selection that is gone.
     */
    private fun leaveSelection(state: PhotosGridState): PhotosGridState = state.copy(
        selecting = false,
        selected = emptyList(),
        album_choice_open = false,
        // A NOTICE ABOUT A COPY OF A PICK THAT IS GONE is about nothing on screen.
        export_notice = "",
        sheet = if (state.sheet == PhotosGridState.Sheet.SHEET_CONFIRM_TRASH) {
            PhotosGridState.Sheet.SHEET_NONE
        } else {
            state.sheet
        },
    )

    /**
     * `media.set_favorite`, the lightbox's own verb — keyed on the value AND
     * the asset, with the asset LAST so a settle names the photograph it was
     * about ([PhotosReads.settled]).
     */
    private fun favoriteWrite(assetId: String, on: Boolean): ScreenEffect.SubmitWrite {
        val value = if (on) "1" else "0"
        return ScreenEffect.SubmitWrite(
            command = PhotoLightboxMachine.FAVORITE_COMMAND,
            inputJson = "{\"asset_id\":" + PhotoShelfMachine.jsonString(assetId) + ",\"favorite\":" + value + "}",
            invokeKey = PhotoLightboxMachine.FAVORITE_COMMAND + ":" + value + ":" + assetId,
        )
    }

    /**
     * One cell's [PhotoCell.Held], changed in place.
     *
     * The ONLY patch this reducer makes, and it is safe for the reason a
     * `rows_changed` re-read is not: a held state is not an order column, so
     * nothing about where the cell sits can have moved.
     */
    private fun paint(
        data: PhotosGridData?,
        assetId: String,
        held: PhotoCell.Held,
    ): PhotosGridData? = data?.copy(
        cells = data.cells.map { cell ->
            if (cell.asset_id == assetId) cell.copy(held = held) else cell
        },
    )

    /**
     * ONE PAGE ONTO WHAT IS ALREADY READ, and where the walk now stands.
     *
     * The dated walk ends when a page comes back with no cursor; the library
     * is not complete then, because the undated tail is still to walk
     * (`PhotosGridData.undated_walk`). The undated walk ending is the end.
     */
    private fun fold(existing: PhotosGridData?, page: PhotosGridData, undated: Boolean): PhotosGridData {
        val base = existing ?: PhotosGridData(thumbnail_pack_absent = page.thumbnail_pack_absent)
        val known = base.cells.map { it.asset_id }.toSet()
        val cells = live(base.cells + page.cells.filterNot { it.asset_id in known })
        return when {
            undated -> base.copy(
                cells = cells,
                next_cursor = page.next_cursor,
                undated_walk = true,
                complete = page.next_cursor == null,
            )
            page.next_cursor != null -> base.copy(
                cells = cells,
                next_cursor = page.next_cursor,
                undated_walk = false,
                complete = false,
            )
            else -> base.copy(cells = cells, next_cursor = null, undated_walk = true, complete = false)
        }
    }

    /**
     * A LIVE PHOTO IS ONE CELL (v0's `mergePhotoAssets`). Its still and its
     * paired movie share a capture group; the movie folds into the still, and
     * the still says `live`. A movie whose still is not among the cells read
     * so far stays a cell of its own until the still arrives — it IS a video,
     * and hiding it on a guess would lose it if the still never comes.
     */
    private fun live(cells: List<PhotoCell>): List<PhotoCell> {
        val stills = cells.mapNotNullTo(HashSet()) { cell ->
            cell.capture_group_id?.takeIf { it.isNotEmpty() && cell.kind == PhotoCell.Kind.KIND_PHOTO }
        }
        if (stills.isEmpty()) return cells
        val movies = cells.mapNotNullTo(HashSet()) { cell ->
            cell.capture_group_id?.takeIf { it in stills && cell.kind == PhotoCell.Kind.KIND_VIDEO }
        }
        if (movies.isEmpty()) return cells
        return cells.mapNotNull { cell ->
            val group = cell.capture_group_id
            when {
                group == null -> cell
                cell.kind == PhotoCell.Kind.KIND_VIDEO && group in stills -> null
                cell.kind == PhotoCell.Kind.KIND_PHOTO && group in movies -> cell.copy(live = true)
                else -> cell
            }
        }
    }

    /**
     * `media_asset` — the roll's rows. Not `media_asset_phash`, which is a
     * duplicates hint nothing on this grid draws, and not the face tables,
     * which move on their own schedule and would redraw the library every time
     * recognition finished a batch.
     *
     * `core_tag` and the collection tables are passed on with their NAME and
     * no ids: the star is the Favorites filter's business and the albums the
     * sheet's, and only the reducer knows whether either is on screen.
     */
    override fun rowsChanged(
        table: String,
        keys: List<String>,
    ): PhotosGridEvent? = when {
        table == TABLE ->
            PhotosGridEvent(rows_changed = PhotosGridEvent.RowsChanged(asset_ids = keys, table = table))
        table == STAR_TABLE || AlbumChoice.movesChoices(table) ->
            PhotosGridEvent(rows_changed = PhotosGridEvent.RowsChanged(table = table))
        else -> null
    }

    /**
     * `media_asset` — the roll's rows, AND the table the core names when a
     * window's files land (D-1025-S7-20).
     *
     * There used to be a second table here, `core_content_item`, with an event
     * kind of its own: the core had content ids to give and this grid is keyed
     * by asset ids, so the ids matched nothing and the only honest reduction
     * was "re-read everything". The seat does the join now — a landed byte is a
     * row — so there is one table, one event, and a cell that fills in because
     * its own row changed.
     */
    private const val TABLE: String = "media_asset"

    /** Where a star lives (#916): a `core_tag` row on the flags scheme. */
    private const val STAR_TABLE: String = "core_tag"

    private fun shownIds(state: PhotosGridState): Set<String> =
        state.data_?.cells?.map { it.asset_id }?.toSet() ?: emptySet()

    /** The capture days read so far, newest first — what a grain anchors on. */
    private fun loadedDays(state: PhotosGridState): List<String> =
        state.data_?.cells?.map { it.day }?.distinct() ?: emptyList()

    override fun seatChanged(seat: SeatState): PhotosGridEvent = PhotosGridEvent(seat_changed = PhotosGridEvent.SeatChanged(seat = seat))
}
