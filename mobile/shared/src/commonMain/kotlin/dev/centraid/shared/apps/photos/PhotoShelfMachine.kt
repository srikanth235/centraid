package dev.centraid.shared.apps.photos

import centraid.screen.v1.Loading
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotoShelfEvent
import centraid.screen.v1.PhotoShelfState
import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosGridData
import centraid.screen.v1.SeatState
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * A PHOTO SHELF: the library under a predicate (#1029, the photos port).
 *
 * One machine for four of v0's routes. `PhotoStateView` (favourites, archive,
 * trash, videos, one person), `AlbumDetail`, `PlaceDetail` and a memory's
 * members were four screens reading one table in one order and drawing one
 * cell, and they drifted exactly where four copies drift: `AlbumDetail.tsx`
 * grew a selection mode the state views never got, `PlaceDetail.tsx` its own
 * empty sentence, and `PhotoStateView`'s trash a countdown none of the others
 * could show. The [PhotoShelf] oneof is the parameter that replaced them, and
 * it is why there is no `AlbumState`.
 *
 * ## What this machine owns, and what it refuses to own
 *
 * The PREDICATE is [PhotoShelfReads]' — a shelf is a statement, and a reducer
 * that spelled one would be a second place the library is defined. What is
 * here is the three things only a reducer knows: which shelf is open, what the
 * member has picked, and which of the three writes a tap means.
 *
 * ## The empty sentence is derived HERE, once
 *
 * [emptySentence] is on the machine rather than in the two views because the
 * sentence differs per shelf and a per-view copy is a per-view chance to leave
 * one out — which is precisely what v0 did: `PlaceDetail.tsx` had a sentence
 * the state views did not, so a member with an empty archive and a member with
 * an empty place read copy of two different qualities. Two shells, one table.
 */
public object PhotoShelfMachine : ScreenMachine<PhotoShelfState, PhotoShelfEvent> {
    public const val SCREEN_ID: String = "photos.shelf"

    override fun initial(): PhotoShelfState = PhotoShelfState(
        loading = Loading(first_load = true),
    )

    override fun reduce(state: PhotoShelfState, event: PhotoShelfEvent): Step<PhotoShelfState> =
        when {
            // THE SHELF ARRIVES WITH THE OPEN, names and all (law 2's sibling).
            // A head that waited for the page read would paint under the
            // previous shelf's title for a whole round trip; `PhotoShelf.Album`
            // and its two siblings carry the name for exactly that reason, so
            // it is stored before the read is asked for.
            event.opened != null -> firstLoad(
                state.copy(
                    shelf = event.opened.shelf,
                    // A NEW SHELF STARTS WITH NOTHING PICKED. Carrying a
                    // selection across shelves would let a Restore fire at
                    // assets the member chose on a different predicate, which
                    // is a write against rows they are no longer looking at.
                    selected_asset_ids = emptyList(),
                    selecting = false,
                    // A NEW SHELF STARTS WITH NO REFUSAL EITHER. A sentence
                    // about a delete that failed on the trash, still on screen
                    // over the favourites, is a sentence about a shelf the
                    // member has left.
                    write_failure = null,
                    export_notice = "",
                    album_choice_open = false,
                    album_choices = emptyList(),
                    album_gone = false,
                    // THE KEEP SWITCH STARTS CHECKING, on an album and nowhere
                    // else; `KeepOriginals.attachShelf` asks the list.
                    keep_originals = KeepOriginals.opened(event.opened.shelf),
                    // THE WINDOW IS A FACT ABOUT THE SHELF, so it is known the
                    // moment the shelf is — no read, no clock. 0 on every shelf
                    // but the trash, which is what the field's own comment
                    // says: a sentence about a purge over the favourites would
                    // be a sentence about something that is not going to
                    // happen.
                    purge_window_days = if (isTrash(event.opened.shelf)) {
                        PURGE_WINDOW_DAYS
                    } else {
                        0
                    },
                ),
            )

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

            // A FAILED READ IS NOT AN EMPTY SHELF. The rows go, the sentence
            // comes, and NO re-read is emitted: a reducer that retried its own
            // refusal is the 1 s loop the low-disk park exists to stop.
            event.refused != null -> Step(
                state.copy(
                    loading = null,
                    data_ = null,
                    failure = event.refused.failure,
                ),
            )

            // A ROW MOVED UNDER THIS SHELF.
            //
            // Two cases, and the empty list is the second one. A change on
            // `media_asset` names ASSET ids, so the shelf re-reads only when it
            // is showing one of them — a roll gaining rows all day during a
            // backup must not redraw an album. A change on one of the four
            // MEMBERSHIP tables names entry, tag, region or member-row ids,
            // which are not asset ids and match nothing this shelf holds; the
            // machine's `rowsChanged` turns those into an EMPTY list, which is
            // this screen's own spelling of "the membership moved and I cannot
            // tell whose" — and the honest answer to that is to read again.
            // The core never delivers an empty key list, so the two cannot be
            // confused.
            //
            // A THIRD CASE: ONLY THE ALBUM LIST MOVED. `core_collection` names
            // no photograph on any shelf, so the page stays; what moves is the
            // "Add to album" list, and only while that sheet is up — which is
            // how an album made from the sheet's own "New album…" appears in it.
            // An entry moving re-reads it too, because a count is entries.
            event.rows_changed != null -> {
                val changed = event.rows_changed
                val moved = changed.asset_ids
                val choices = if (state.album_choice_open && moved.isEmpty()) {
                    AlbumChoice.openEffects()
                } else {
                    emptyList()
                }
                when {
                    changed.albums_only -> Step(state, choices)
                    moved.isNotEmpty() && moved.none { it in shownIds(state) } -> Step(state)
                    else -> firstLoad(state).let { it.copy(effects = it.effects + choices) }
                }
            }

            // THE PICK SURVIVES A PAGE IT HAS NOT LOADED (the state carries it,
            // not the cell — `TallyListState.pending_expense_ids`' reason): a
            // member who picked a photograph and scrolled past the page it was
            // on must still be able to act on it.
            event.selection != null -> {
                val asset = event.selection.asset_id
                val picked = state.selected_asset_ids
                Step(
                    state.copy(
                        selected_asset_ids = if (asset in picked) {
                            picked - asset
                        } else {
                            picked + asset
                        },
                        // A FIRST PICK ENTERS SELECTION MODE. v0 passed its
                        // selection bar unconditionally and the screen sat
                        // permanently in the mode — the header read "Choose
                        // photographs" and the band sat dimmed before a single
                        // photograph had been picked (R-A-14). Presence is the
                        // mode.
                        selecting = true,
                    ),
                )
            }

            // THE ONE WAY OUT, and it empties the selection. A mode a member
            // left while their picks survived is a mode they are still in
            // without the chrome that says so.
            event.selection_mode != null -> {
                val selecting = event.selection_mode.selecting
                Step(
                    state.copy(
                        selecting = selecting,
                        selected_asset_ids = if (selecting) {
                            state.selected_asset_ids
                        } else {
                            emptyList()
                        },
                    ),
                )
            }

            // OUT OF THE TRASH, OR OUT OF THE ARCHIVE — one event, because the
            // SHELF already says which and the vault has one verb for the
            // first. An archived asset is un-archived through `update_asset`;
            // a trashed one is restored. [restoreWrites] is where that fork
            // lives, once.
            event.restore != null -> written(state, restoreWrites(state))

            // INTO THE TRASH, or OUT OF THE VAULT. `permanent` is the screen's
            // word and not an inference off the shelf, even though the shelf
            // could supply it: the two are one tap apart and only one of them
            // is reversible, so the surface that asked has to have said so.
            event.delete != null -> written(state, deleteWrites(state, event.delete.permanent))

            event.archive != null -> written(state, archiveWrites(state, event.archive.archived))

            // A STAR IS `media.set_favorite`, one per picked photograph — the
            // lightbox's verb, not `update_asset`'s general edit
            // (`PhotoLightboxMachine.FAVORITE_COMMAND`'s note).
            event.favorite != null -> written(state, favoriteWrites(state, event.favorite.favorite))

            // "ADD TO ALBUM" — the shared sheet (`AlbumChoice.kt`). It opens
            // over a pick and never over nothing: a list of albums with no
            // photograph to put in one is a sheet with no verb.
            event.album_choice_opened != null ->
                if (state.selected_asset_ids.isEmpty()) {
                    Step(state)
                } else {
                    Step(
                        state.copy(album_choice_open = true, export_notice = ""),
                        AlbumChoice.openEffects(),
                    )
                }

            event.album_choice_dismissed != null -> Step(state.copy(album_choice_open = false))

            // THE LIST, LESS THE ALBUM THIS SHELF IS. Adding an album's own
            // photographs to itself is a batch of refusals on
            // `not_already_in_album`, and v0's sheet left it out for that
            // reason (`AlbumDetail.tsx`, `otherAlbums`).
            event.album_choices != null -> Step(
                state.copy(
                    album_choices = event.album_choices.choices.filter {
                        it.album_id != state.shelf?.album?.collection_id
                    },
                ),
            )

            event.album_chosen != null -> written(
                state.copy(album_choice_open = false),
                AlbumChoice.addEffects(state.selected_asset_ids, event.album_chosen.album_id),
            )

            // THE SHEET STAYS UP. The vault mints the new album's id and no
            // settle carries it back, so the album joins the list when its
            // commit moves `core_collection` and the member's next tap puts the
            // pick in it (`AlbumChoice.kt`).
            event.album_choice_created != null ->
                written(state, AlbumChoice.createEffects(event.album_choice_created.title))

            event.album_renamed != null -> written(state, renameWrites(state, event.album_renamed.title))

            event.album_delete != null -> written(state, albumDeleteWrites(state))

            event.cover != null -> written(state, coverWrites(state, event.cover.asset_id))

            event.remove_from_album != null -> written(state, removeWrites(state))

            // EMPTY TRASH PURGES THE WHOLE TRASH, and this shelf holds one page
            // of it — so the list is asked for first, and the purges follow it.
            // Only the trash has the verb.
            event.empty_trash != null ->
                if (isTrash(state.shelf)) {
                    Step(
                        state.copy(write_failure = null, export_notice = ""),
                        listOf(ScreenEffect.ReadPage(TRASH_LIST_READ_ID, afterCursor = null)),
                    )
                } else {
                    Step(state)
                }

            // ONE `media.purge_asset` PER TRASHED PHOTOGRAPH, keyed as the
            // selection's Delete-forever keys them, so a photograph purged
            // either way is the same intent.
            event.trash_listed != null ->
                if (isTrash(state.shelf)) {
                    written(state, event.trash_listed.asset_ids.distinct().map(::purgeWrite))
                } else {
                    Step(state)
                }

            event.export_settled != null -> Step(state.copy(export_notice = event.export_settled.sentence))

            // "KEEP ORIGINALS ON THIS PHONE" (`KeepOriginals.kt`). The flip is
            // shown at once and the list's answer is what settles it; either
            // half that does not apply — a flip before the list answered, an
            // answer about an album the member has left — changes nothing.
            event.keep_originals_toggled != null ->
                KeepOriginals.toggled(state.keep_originals, event.keep_originals_toggled.keep)
                    ?.let { Step(state.copy(keep_originals = it)) }
                    ?: Step(state)

            event.keep_originals_settled != null -> {
                val settled = event.keep_originals_settled
                KeepOriginals.settled(
                    state.keep_originals,
                    state.shelf?.album?.collection_id,
                    settled.album_id,
                    settled.keep,
                    settled.refusal,
                )?.let { Step(state.copy(keep_originals = it)) } ?: Step(state)
            }

            // A WRITE CAME BACK.
            //
            // **A COMMITTED WRITE MOVES NO ROWS HERE.** The commit's own change
            // event names the asset row that moved, and this shelf is showing
            // it, so `rows_changed` re-reads — which is what actually takes the
            // restored photograph off the trash shelf. Reducing the row away
            // here as well would be a second answer to "what is on this shelf",
            // and the two would disagree the first time a precondition refused
            // half a batch. What a commit DOES do is clear the last refusal:
            // a sentence about a delete that failed, still on screen after one
            // that worked, is a screen contradicting itself.
            //
            // **A REFUSAL LANDS IN `write_failure` AND NOWHERE ELSE.** Not in
            // `failure`, which is the READ's slot and one of the three states a
            // read can be in: a denied delete put there would replace a shelf
            // full of photographs with an error message, so a member would lose
            // the very selection they were deleting from.
            // `NoteDraft.save_failure` is the same field for the same reason,
            // and `NotesEditorMachine` states the rule in the same words — a
            // failed save does not replace the editor.
            //
            // `data_` is untouched in BOTH arms, which is the whole point of
            // the field.
            //
            // **AND THE SETTLE IS KEYED TO ITS ROW.** A selection of twelve
            // submits twelve writes; a screen told only "something committed"
            // has to guess, and the guess it would make — clear the lot — marks
            // the two the vault refused a precondition on as done while they
            // quietly stay where they were. So only `asset_id` leaves the
            // selection. An EMPTY id means the settle is about the batch rather
            // than about one row, and then the selection is left alone: a
            // screen that cannot tell which row settled must not act as though
            // it can.
            event.write_settled != null -> {
                val settled = event.write_settled
                val left = if (settled.committed && settled.asset_id.isNotEmpty()) {
                    state.selected_asset_ids - settled.asset_id
                } else {
                    state.selected_asset_ids
                }
                // THE ALBUM'S OWN VERBS SETTLE ABOUT NO ROW. A committed rename
                // retitles the head — the name rode the route, and nothing else
                // on this screen reads `core_collection` — and a committed
                // delete closes the shelf, because the album it is showing is
                // gone.
                val album = state.shelf?.album
                val retitled = if (
                    settled.committed &&
                    settled.command == RENAME_ALBUM_COMMAND &&
                    settled.album_title.isNotEmpty() &&
                    album != null
                ) {
                    state.shelf?.copy(album = album.copy(name = settled.album_title))
                } else {
                    state.shelf
                }
                Step(
                    state.copy(
                        shelf = retitled,
                        album_gone = state.album_gone ||
                            (settled.committed && settled.command == DELETE_ALBUM_COMMAND),
                        selected_asset_ids = left,
                        // THE BAR GOES WHEN THE LAST ROW HAS SETTLED, and not
                        // a moment before. Presence is the mode, so an empty
                        // selection with the mode still on is a bar with
                        // nothing to act on.
                        selecting = state.selecting && left.isNotEmpty(),
                        write_failure = if (settled.committed) {
                            null
                        } else {
                            // THE CORE'S OWN SENTENCE when it has one, and a
                            // sentence of this shell's when it does not. Nothing
                            // here composes one out of an error: `Error.detail`
                            // is logs-only, and one reached a member's screen
                            // through exactly that field in #1020 wave 3.
                            Reads.refused(
                                settled.sentence.ifEmpty { WRITE_REFUSED_SENTENCE },
                            )
                        },
                    ),
                )
            }

            event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

            else -> Step(state)
        }

    /**
     * NOTHING HERE, AND WHY — one sentence per shelf, derived in one place.
     *
     * Every one of these is v0's own words where v0 had words, because a port
     * that reworded the copy would be a port a member can tell they are using.
     * The two that are new are the ones v0 never wrote: a memory's members had
     * no screen of their own, and the place sentence is `PlaceDetail.tsx`'s
     * with the heading it already interpolated.
     */
    public fun emptySentence(shelf: PhotoShelf?): String {
        val album = shelf?.album
        val place = shelf?.place
        val memory = shelf?.memory
        val view = shelf?.state_view
        return when {
            album != null -> "Nothing in this album yet."
            // THE PHOTOGRAPHS WITH NO PLACE (`PlacesMachine.unplacedShelf`):
            // empty means every photograph has one, which is the good news.
            place != null && place.unplaced -> "Every photograph has a place."
            place != null -> "No photographs at ${place.place_name} yet."
            memory != null -> "No photographs from this memory are on this device."
            view != null -> emptyStateViewSentence(view)
            // A SHELF WITH NO PREDICATE IS NOT AN EMPTY LIBRARY. It is a screen
            // opened without its parameter, which is a defect and not a state a
            // member is in — so the sentence says what is missing rather than
            // claiming the vault holds nothing.
            else -> "This shelf was opened without saying which photographs it is."
        }
    }

    /** The second line, where a shelf has one a member can act on. */
    public fun emptyRemedy(shelf: PhotoShelf?): String = when {
        shelf?.album != null -> "An album refers to a photograph where it lives."
        else -> ""
    }

    private fun emptyStateViewSentence(view: PhotoStateView): String {
        val person = view.person
        if (person != null) return "No photographs of ${person.person_name} yet."
        return when (view.mode?.kind) {
            PhotoStateView.Mode.Kind.KIND_FAVORITES ->
                "No favorites yet — tap the heart on any photograph."

            PhotoStateView.Mode.Kind.KIND_ARCHIVE -> "Archive is empty."
            PhotoStateView.Mode.Kind.KIND_TRASH -> "Trash is empty."
            PhotoStateView.Mode.Kind.KIND_VIDEOS ->
                "Videos you capture or import collect here."

            PhotoStateView.Mode.Kind.KIND_UNSPECIFIED, null ->
                "This shelf was opened without saying which photographs it is."
        }
    }

    /**
     * WHAT THE APP BAR SAYS BEFORE ANY READ HAS LANDED.
     *
     * The names ride along on [PhotoShelf] (`navigation.ts:63-69`), so this is
     * a projection and never a read: a head that waited a replica round trip is
     * a head that paints under the previous shelf's title.
     */
    public fun title(shelf: PhotoShelf?): String {
        val album = shelf?.album
        val place = shelf?.place
        val memory = shelf?.memory
        val view = shelf?.state_view
        return when {
            album != null -> album.name
            place != null -> place.place_name
            memory != null -> memory.title
            view != null -> stateViewTitle(view)
            else -> "Photographs"
        }
    }

    private fun stateViewTitle(view: PhotoStateView): String {
        val person = view.person
        if (person != null) return person.person_name
        return when (view.mode?.kind) {
            PhotoStateView.Mode.Kind.KIND_FAVORITES -> "Favorites"
            PhotoStateView.Mode.Kind.KIND_ARCHIVE -> "Archive"
            PhotoStateView.Mode.Kind.KIND_TRASH -> "Trash"
            PhotoStateView.Mode.Kind.KIND_VIDEOS -> "Videos"
            PhotoStateView.Mode.Kind.KIND_UNSPECIFIED, null -> "Photographs"
        }
    }

    /** Is this shelf the trash? The one shelf whose verbs and copy differ. */
    public fun isTrash(shelf: PhotoShelf?): Boolean =
        shelf?.state_view?.mode?.kind == PhotoStateView.Mode.Kind.KIND_TRASH

    /** Is this shelf the archive? Its Restore is an un-archive, not a restore. */
    public fun isArchive(shelf: PhotoShelf?): Boolean =
        shelf?.state_view?.mode?.kind == PhotoStateView.Mode.Kind.KIND_ARCHIVE

    /**
     * THE TRASH WINDOW, AS THE VAULT ITSELF COUNTS IT.
     *
     * Thirty days, from `crates/vault/src/commands/media.rs`'s
     * `PURGE_AFTER_DAYS` — the constant `media.delete_asset` stamps `purge_at`
     * with. Restated here rather than read from a registry because
     * `contracts/schema/v0-registries.json`'s `retentionWindows` holds the
     * AUDIT and LEDGER windows only; there is no media entry in it, so a read
     * of that file would be a read of the wrong number.
     *
     * It is a WINDOW and not a countdown, and `PhotoShelfState`'s field says so
     * in its name: a per-row countdown would need `purge_at` on the state — and
     * `PhotoShelfEvent.DataArrived` carries a `PhotosGridData`, which has no
     * such column — AND a clock, which `commonMain` does not have by design
     * (`sync/Instants.kt`: "`commonMain` has no calendar"). The window needs
     * neither, and it is what v0's trash meta line actually stated: "purged 30
     * days after deletion". A fact about the rule is true without asking what
     * time it is.
     */
    public const val PURGE_WINDOW_DAYS: Int = 30

    /**
     * The trash's sentence, from the window on the state.
     *
     * Takes the number rather than reading the shelf, so the one place the
     * sentence is spelled is fed by the one field that carries the fact —
     * a view that re-derived "is this the trash" could disagree with the state
     * it is drawing. Empty for 0, which is every other shelf.
     */
    public fun purgeWindowSentence(days: Int): String = if (days == 0) {
        ""
    } else {
        "Photographs here are deleted forever $days days after you trash them."
    }

    /**
     * OUT OF THE TRASH, OR OUT OF THE ARCHIVE — the fork, in one place.
     *
     * `media.restore_asset` clears `deleted_at`, and it REFUSES an asset whose
     * window has lapsed (`asset_is_trashed_within_its_window`). An archived
     * asset was never deleted, so restoring it is `media.update_asset` with
     * `archived = 0`: sending `restore_asset` for it would be refused by the
     * precondition, and a member unarchiving a photograph would read "that
     * photograph is not in the trash".
     */
    private fun restoreWrites(state: PhotoShelfState): List<ScreenEffect.SubmitWrite> =
        if (isArchive(state.shelf)) {
            archiveWrites(state, archived = false)
        } else {
            state.selected_asset_ids.map { assetId ->
                ScreenEffect.SubmitWrite(
                    command = RESTORE_COMMAND,
                    inputJson = assetInput(assetId),
                    invokeKey = "$RESTORE_COMMAND:$assetId",
                )
            }
        }

    private fun deleteWrites(
        state: PhotoShelfState,
        permanent: Boolean,
    ): List<ScreenEffect.SubmitWrite> = state.selected_asset_ids.map { assetId ->
        val command = if (permanent) PURGE_COMMAND else DELETE_COMMAND
        ScreenEffect.SubmitWrite(
            command = command,
            inputJson = assetInput(assetId),
            // THE KEY NAMES THE VERB AS WELL AS THE ROW. Trashing and purging
            // one photograph are two intents over one id, and a key that was
            // the id alone would make the second look like a replay of the
            // first.
            invokeKey = "$command:$assetId",
        )
    }

    private fun archiveWrites(
        state: PhotoShelfState,
        archived: Boolean,
    ): List<ScreenEffect.SubmitWrite> = state.selected_asset_ids.map { assetId ->
        ScreenEffect.SubmitWrite(
            command = UPDATE_COMMAND,
            inputJson = "{\"asset_id\":${jsonString(assetId)}," +
                "\"archived\":${if (archived) 1 else 0}}",
            // A PER-ROW WRITE KEYS ON THE ROW AND THE VALUE BEING SET, never on
            // an ordinal (`NotesEditorMachine`'s own note on this): archiving
            // and un-archiving the same photograph are two different intents
            // and must not share a key.
            invokeKey = "$UPDATE_COMMAND:archived=${if (archived) 1 else 0}:$assetId",
        )
    }

    /**
     * One write per picked asset, and the selection drains as they SETTLE.
     *
     * **ONE COMMAND PER ASSET, never one batched verb.** The vault registers
     * `media.delete_asset` over a single `asset_id`, so a batch would have to be
     * invented on this side — and a batch that half-committed would leave a
     * member with no way to see which half.
     *
     * **THE PICKS ARE NOT CLEARED HERE**, which is where the first draft of
     * this cleared them (v0 does the same: `PhotoStateView.tsx` empties the set
     * after the batch resolves). Twelve writes are twelve outcomes, and the
     * vault refuses some of them on a precondition — a photograph already in
     * the trash, a source an edited copy still names. A selection emptied on
     * the REQUEST tells a member all twelve happened. Draining it one
     * `WriteSettled` at a time leaves exactly the rows that did not commit
     * still picked, which is both the honest state and the one a member can
     * retry from.
     */
    private fun written(
        state: PhotoShelfState,
        writes: List<ScreenEffect>,
    ): Step<PhotoShelfState> {
        if (writes.isEmpty()) return Step(state)
        return Step(
            // THE LAST REFUSAL GOES WHEN A NEW ATTEMPT STARTS. A member who
            // has just pressed Restore is owed the outcome of THAT press; the
            // previous one's sentence sitting under it is a screen answering a
            // question nobody asked twice. The last copy's notice goes with it.
            state.copy(write_failure = null, export_notice = ""),
            writes,
        )
    }

    private fun favoriteWrites(state: PhotoShelfState, favorite: Boolean): List<ScreenEffect> {
        val value = if (favorite) 1 else 0
        return state.selected_asset_ids.map { assetId ->
            ScreenEffect.SubmitWrite(
                command = FAVORITE_COMMAND,
                inputJson = "{\"asset_id\":${jsonString(assetId)},\"favorite\":$value}",
                // THE ROW AND THE VALUE, as the archive keys them: starring and
                // unstarring one photograph are two intents over one id.
                invokeKey = "$FAVORITE_COMMAND:favorite=$value:$assetId",
            )
        }
    }

    /**
     * RENAME, ONLY ON AN ALBUM AND ONLY TO A NEW NAME.
     *
     * An empty name is refused by `title`'s `minLength: 1`, and the same name
     * is a write that changes nothing — both are round trips a member waits
     * through for no outcome, so neither is sent. The key names the album and
     * the title, and ends in the title: `PhotoShelfReads.settled` reads it
     * back, because the settle carries no output.
     */
    private fun renameWrites(state: PhotoShelfState, title: String): List<ScreenEffect> {
        val album = state.shelf?.album ?: return emptyList()
        val name = title.trim()
        if (name.isEmpty() || name == album.name) return emptyList()
        return listOf(
            ScreenEffect.SubmitWrite(
                command = RENAME_ALBUM_COMMAND,
                inputJson = "{\"album_id\":${jsonString(album.collection_id)}," +
                    "\"title\":${jsonString(name)}}",
                invokeKey = "$RENAME_ALBUM_COMMAND:${album.collection_id}:$name",
            ),
        )
    }

    /** The grouping goes; every photograph in it stays in the library. */
    private fun albumDeleteWrites(state: PhotoShelfState): List<ScreenEffect> {
        val album = state.shelf?.album ?: return emptyList()
        return listOf(
            ScreenEffect.SubmitWrite(
                command = DELETE_ALBUM_COMMAND,
                inputJson = "{\"album_id\":${jsonString(album.collection_id)}}",
                invokeKey = "$DELETE_ALBUM_COMMAND:${album.collection_id}",
            ),
        )
    }

    /**
     * "Make key photo". The vault refuses a cover that is not a member
     * (`asset_is_album_member`), so the asset has to be one this album shelf is
     * showing — which is the only place the verb is offered.
     */
    private fun coverWrites(state: PhotoShelfState, assetId: String): List<ScreenEffect> {
        val album = state.shelf?.album ?: return emptyList()
        if (assetId.isEmpty()) return emptyList()
        return listOf(
            ScreenEffect.SubmitWrite(
                command = SET_COVER_COMMAND,
                inputJson = "{\"album_id\":${jsonString(album.collection_id)}," +
                    "\"asset_id\":${jsonString(assetId)}}",
                invokeKey = "$SET_COVER_COMMAND:${album.collection_id}:$assetId",
            ),
        )
    }

    /** One `media.remove_from_album` per pick. The reference goes, never the photograph. */
    private fun removeWrites(state: PhotoShelfState): List<ScreenEffect> {
        val album = state.shelf?.album ?: return emptyList()
        return state.selected_asset_ids.map { assetId ->
            ScreenEffect.SubmitWrite(
                command = REMOVE_FROM_ALBUM_COMMAND,
                inputJson = "{\"album_id\":${jsonString(album.collection_id)}," +
                    "\"asset_id\":${jsonString(assetId)}}",
                invokeKey = "$REMOVE_FROM_ALBUM_COMMAND:${album.collection_id}:$assetId",
            )
        }
    }

    private fun purgeWrite(assetId: String): ScreenEffect = ScreenEffect.SubmitWrite(
        command = PURGE_COMMAND,
        inputJson = assetInput(assetId),
        invokeKey = "$PURGE_COMMAND:$assetId",
    )

    /**
     * The `ReadPage.screenId` Empty Trash asks for: every trashed asset id,
     * walked to the end, served beside the shelf's own page by
     * `PhotoShelfBridge`. Not [SCREEN_ID], which is the page on screen.
     */
    public const val TRASH_LIST_READ_ID: String = "photos.shelf.trashList"

    /**
     * What a member reads when a write was refused and nothing said why.
     *
     * The core supplies `CommandOutcome.reason` for a denial or a failed
     * precondition and that sentence is preferred; this is for the outcomes
     * that carry none — a `Failed` with no reason — because a refusal a member
     * cannot see is the defect `write_failure` exists to close, and an empty
     * sentence in the slot would be exactly as silent as no slot at all.
     */
    public const val WRITE_REFUSED_SENTENCE: String =
        "Centraid could not make that change."

    private fun assetInput(assetId: String): String =
        "{\"asset_id\":${jsonString(assetId)}}"

    /**
     * The registered command names, and nothing else may spell them.
     *
     * `NotesEditorMachine.SAVE_COMMAND` is the cautionary tale: it said
     * `knowledge.save_note`, the registry has no such command, and a member
     * read "That request does not make sense to this build" on every window for
     * ever because nothing in the product had ever submitted a write. These
     * four are `crates/vault/src/commands/media.rs`'s, and `ShellCommandsExist`
     * is what keeps them that way.
     */
    public const val RESTORE_COMMAND: String = "media.restore_asset"
    public const val DELETE_COMMAND: String = "media.delete_asset"
    public const val PURGE_COMMAND: String = "media.purge_asset"
    public const val UPDATE_COMMAND: String = "media.update_asset"
    public const val FAVORITE_COMMAND: String = "media.set_favorite"
    public const val RENAME_ALBUM_COMMAND: String = "media.rename_album"
    public const val DELETE_ALBUM_COMMAND: String = "media.delete_album"
    public const val SET_COVER_COMMAND: String = "media.set_album_cover"
    public const val REMOVE_FROM_ALBUM_COMMAND: String = "media.remove_from_album"

    private fun firstLoad(state: PhotoShelfState): Step<PhotoShelfState> = Step(
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

    private fun shownIds(state: PhotoShelfState): Set<String> =
        state.data_?.cells?.map { it.asset_id }?.toSet() ?: emptySet()

    /**
     * FIVE TABLES, AND ONLY ONE OF THEM ANSWERS IN ASSET IDS.
     *
     * `media_asset` is the table the page is read from, so its keys ARE the
     * ids this shelf holds and the reducer can ask whether it is showing one.
     *
     * The other four are the MEMBERSHIPS the shelf's predicate is over, and
     * every one of them is a real way a shelf changes without `media_asset`
     * moving at all: `media.add_to_album` writes `core_collection_entry` and
     * nothing else, a star is a `core_tag` row (`set_starred`), naming a face
     * writes `media_face_region`, and a memory pass writes
     * `media_memory_member`. A shelf that listened to `media_asset` alone would
     * be right only after a relaunch — which is the silent staleness
     * `ScreenReads.table`'s own comment describes.
     *
     * Their keys are entry, tag, region and member-row ids, which this shelf
     * cannot match against anything, so the event carries an EMPTY list and
     * [reduce] reads that as "re-read, I cannot tell whose". The core never
     * delivers an empty key list, so the two readings cannot collide.
     */
    override fun rowsChanged(table: String, keys: List<String>): PhotoShelfEvent? = when (table) {
        ASSET_TABLE ->
            PhotoShelfEvent(rows_changed = PhotoShelfEvent.RowsChanged(asset_ids = keys))

        in MEMBERSHIP_TABLES ->
            PhotoShelfEvent(rows_changed = PhotoShelfEvent.RowsChanged(asset_ids = emptyList()))

        // THE ALBUMS THEMSELVES — a rename, a new album, a delete. No shelf's
        // page reads this table, so it moves only the "Add to album" list.
        ALBUM_TABLE ->
            PhotoShelfEvent(
                rows_changed = PhotoShelfEvent.RowsChanged(asset_ids = emptyList(), albums_only = true),
            )

        else -> null
    }

    private const val ASSET_TABLE: String = "media_asset"

    private const val ALBUM_TABLE: String = "core_collection"

    private val MEMBERSHIP_TABLES: Set<String> = setOf(
        "core_collection_entry",
        "core_tag",
        "media_face_region",
        "media_memory_member",
    )

    override fun seatChanged(seat: SeatState): PhotoShelfEvent =
        PhotoShelfEvent(seat_changed = PhotoShelfEvent.SeatChanged(seat = seat))

    /**
     * A JSON string literal, escaped.
     *
     * The same function `NotesEditorMachine` carries and for the same reason:
     * `commonMain` has no JSON dependency, the shapes here are two fields, and
     * the escaping is the only part that can be wrong. It is duplicated rather
     * than shared because `PerAppLayoutSpec` forbids one app's package from
     * importing another's, and a shared JSON helper in `screen/` would widen a
     * contract that is deliberately two files.
     */
    internal fun jsonString(value: String): String = buildString {
        append('"')
        for (character in value) {
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else ->
                    if (character < ' ') {
                        append("\\u").append(character.code.toString(16).padStart(4, '0'))
                    } else {
                        append(character)
                    }
            }
        }
        append('"')
    }
}
