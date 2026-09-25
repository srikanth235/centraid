package dev.centraid.shared.apps.photos

import centraid.screen.v1.Loading
import centraid.screen.v1.PhotosCollectionsData
import centraid.screen.v1.PhotosCollectionsEvent
import centraid.screen.v1.PhotosCollectionsState
import centraid.screen.v1.SeatState
import centraid.screen.v1.ShelfRow
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * COLLECTIONS — the band's second destination, and the hub of the rest of
 * Photos (#1029, the photos port).
 *
 * v0's `PHOTOS_MORE_FOOT` says "The rest of Photos is in Collections", so every
 * surface this miniapp has that is not the library or search is reached from
 * here. Two row types and no third:
 *
 * * **[ShelfRow]** — the four standing shelves and the member's own albums, in
 *   ONE list. Both carry a `PhotoShelf`, so a tap on either lands on
 *   `photos.shelf` and the difference a view cares about is `member_owned`. v0
 *   drew two component families here and had to keep their covers, counts and
 *   empty states in step by hand (`PhotosCollectionsView.tsx`,
 *   `CollectionShelfBody.tsx`).
 * * **`CollectionsDoor`** — People, Places, Memories and Duplicates, whose tap
 *   lands somewhere else entirely.
 *
 * ## THIS MACHINE HOLDS NO SHELF AND MAKES NO COUNT
 *
 * Both are [PhotosCollectionsReads]', and the reducer's whole job on a data
 * event is the MERGE. That division matters because this screen's numbers come
 * off ten tables and one page each — the door has no `COUNT(*)` and no join —
 * so a count is rows read and counted, with `item_count_capped` saying when the
 * page filled and the number is therefore a floor. None of that is a reduction
 * over an event; all of it is a fold over rows, and it lives where it can be
 * proved with no vault.
 */
public object PhotosCollectionsMachine :
    ScreenMachine<PhotosCollectionsState, PhotosCollectionsEvent> {
    public const val SCREEN_ID: String = "photos.collections"

    /** `media.create_album`, as the VAULT registers it — never the app action. */
    public const val CREATE_COMMAND: String = "media.create_album"

    /** `media.delete_album`. */
    public const val DELETE_COMMAND: String = "media.delete_album"

    /**
     * What a member reads when the core refused and said nothing.
     *
     * The shell's words and not an error's: `Error.detail` is logs-only — it
     * carries whatever the failing layer said, including a SQLite
     * `RAISE(ABORT)`, and one reached a member's screen through exactly that
     * field in #1020 wave 3.
     */
    internal const val WRITE_REFUSED_SENTENCE: String =
        "Centraid could not make that change."

    override fun initial(): PhotosCollectionsState = PhotosCollectionsState(
        loading = Loading(first_load = true),
        sheet = PhotosCollectionsState.Sheet.SHEET_NONE,
    )

    override fun reduce(
        state: PhotosCollectionsState,
        event: PhotosCollectionsEvent,
    ): Step<PhotosCollectionsState> = when {
        event.opened != null -> firstLoad(state)

        event.next_page != null ->
            // A PARKED FEED EMITS NO RE-READ (`docs/mobile-offline.md:238`).
            // The cursor and the rows stay and the retry cadence stops; a
            // scroll that kept asking would be the retry loop over a failing
            // batch that the device contract pins.
            if (Reads.isParked(state.failure)) {
                Step(state)
            } else {
                Step(
                    state,
                    listOf(ScreenEffect.ReadPage(SCREEN_ID, event.next_page.after_cursor)),
                )
            }

        // A COLLECTION MOVED — RE-READ, WHATEVER THE KEYS SAY.
        //
        // The grid filters this event against the ids it is showing, because a
        // camera roll gains `media_asset` rows all day during a backup and a
        // library that redrew on each would never settle. **Collections is the
        // opposite case in both halves.** A `core_collection` row changes when
        // the member makes, renames or deletes an album — which is exactly when
        // this list has to move — and a NEW album's id is by construction not in
        // the set this screen is showing, so a filter on shown ids would drop
        // precisely the event the member is waiting for.
        //
        // And the keys can be EMPTY. `ChangeFeed::tables_changed` — the producer
        // behind every locally committed command — offers `pk_set: Vec::new()`,
        // because its source is a rusqlite update hook that is handed a ROWID
        // and not a declared primary key. An empty list is "this table changed
        // and nobody can say which rows", and the only honest reading of it is
        // to read again.
        event.rows_changed != null ->
            if (Reads.isParked(state.failure)) Step(state) else firstLoad(state)

        event.data_ != null -> Step(
            state.copy(
                loading = null,
                failure = null,
                data_ = merge(state.data_, event.data_.data_),
            ),
        )

        // A FAILED READ IS NOT AN EMPTY SHELF LIST. Three states, never two,
        // and no fourth: the data case is dropped rather than left standing
        // beside a sentence that contradicts it.
        event.refused != null -> Step(
            state.copy(
                loading = null,
                data_ = null,
                failure = event.refused.failure,
            ),
        )

        // NAMING A NEW ALBUM IS A SHEET, NOT A ROUTE: one field and a verb, and
        // a push for it would put a keyboard behind a back chevron.
        event.sheet != null -> Step(state.copy(sheet = event.sheet.sheet))

        // THE SHEET STAYS OPEN UNTIL THE WRITE COMMITS.
        //
        // Closing it here would be the screen claiming an album exists because
        // a member pressed a button — and a refusal would then have nowhere to
        // be read, over a sheet that had already gone. `WriteSettled` below is
        // what closes it, and what puts the sentence on `write_failure` when
        // there is one.
        event.album_created != null -> {
            val title = event.album_created.name.trim()
            if (title.isEmpty()) {
                // AN EMPTY NAME IS NOT A WRITE. `media.create_album`'s schema
                // has `"title": { "minLength": 1 }`, so this would be refused
                // by the vault — and a command a screen KNOWS will be refused
                // is a round trip a member waits through for nothing.
                Step(state)
            } else {
                Step(
                    // THE LAST REFUSAL GOES WHEN A NEW ATTEMPT IS MADE. A
                    // sentence about the previous try, sitting under a name
                    // the member has since changed, is a sentence about
                    // nothing.
                    state.copy(write_failure = null),
                    listOf(
                        ScreenEffect.SubmitWrite(
                            command = CREATE_COMMAND,
                            inputJson = createInput(title),
                            // CONTENT-DERIVED, NEVER AN ORDINAL. The intent is
                            // "an album called <title>", so that is the key; an
                            // ordinal is stable only for a caller that makes the
                            // same calls every time, which is the v0 fallback
                            // `crates/core`'s `invoke` refuses outright.
                            //
                            // **The seat does not mint the id here.** The command
                            // takes an optional `album_id` so a seat's own
                            // projection can carry the id the origin will honour,
                            // and a pure reducer has no clock and no randomness to
                            // mint one with. The vault mints it, and the row comes
                            // back through the change event above.
                            invokeKey = "$CREATE_COMMAND:$title",
                        ),
                    ),
                )
            }
        }

        event.album_deleted != null -> Step(
            state.copy(write_failure = null),
            listOf(
                ScreenEffect.SubmitWrite(
                    command = DELETE_COMMAND,
                    inputJson = deleteInput(event.album_deleted.collection_id),
                    invokeKey = "$DELETE_COMMAND:${event.album_deleted.collection_id}",
                ),
            ),
        )

        // A WRITE THAT COMMITTED CLOSES THE SHEET AND CLEARS THE LAST REFUSAL.
        //
        // No re-read is emitted from here: the commit's own change event is
        // what redraws this list, and a re-read beside it would be two trips
        // for one write racing each other over ten statements.
        //
        // A WRITE THAT DID NOT COMMIT LANDS ITS SENTENCE ON `write_failure`
        // AND TOUCHES `content` NOTHING. The `content` oneof's `failure` is the
        // READ's slot — one of the three states a read can be in — and a denied
        // create put there would replace the whole list of shelves with an
        // error, so a member whose new album was refused would lose the
        // Collections screen itself, including the four standing shelves that
        // exist in every vault. `NoteDraft.save_failure` is the same field for
        // the same reason, and `NotesEditorMachine` states the rule from the
        // other side: a failed save does not replace the editor.
        //
        // The SHEET STAYS OPEN on a refusal, so the sentence is read beside the
        // name the member typed rather than over a screen that has moved on.
        event.write_settled != null -> {
            val settled = event.write_settled
            if (settled.committed) {
                Step(
                    state.copy(
                        sheet = PhotosCollectionsState.Sheet.SHEET_NONE,
                        write_failure = null,
                    ),
                )
            } else {
                Step(
                    state.copy(
                        // THE CORE'S OWN SENTENCE WHEN IT HAS ONE, and a plain
                        // one when it does not — never silence. A refusal with
                        // no words was this screen's state until the field
                        // existed, and a member who pressed Create and saw
                        // nothing happen could not tell a refusal from a tap
                        // that missed.
                        write_failure = Reads.refused(
                            settled.sentence.ifEmpty { WRITE_REFUSED_SENTENCE },
                        ),
                    ),
                )
            }
        }

        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

        else -> Step(state)
    }

    /**
     * Back to loading, and the read asked for again.
     *
     * **The write's sentence is cleared here too.** A refusal is about the tap
     * that provoked it, and a member who has come back to this screen — or
     * whose album list has just moved under them — is not still being told
     * about the create they tried a minute ago. It is the same reason
     * `NotesEditorMachine` clears `save_failure` on the next edit: a sentence
     * that outlives what it was about becomes furniture.
     */
    private fun firstLoad(state: PhotosCollectionsState): Step<PhotosCollectionsState> = Step(
        state.copy(
            loading = Loading(first_load = true),
            failure = null,
            data_ = null,
            write_failure = null,
        ),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    /**
     * A SECOND PAGE APPENDS ALBUMS AND REPLACES NOTHING.
     *
     * Every arrival carries the standing four and the four doors, because
     * [PhotosCollectionsReads] builds them on every page — so the merge is by
     * KEY and not by position: the standing rows dedupe against themselves and
     * the albums accumulate. Concatenating blind would draw Favorites once per
     * page of albums.
     */
    private fun merge(
        existing: PhotosCollectionsData?,
        arriving: PhotosCollectionsData?,
    ): PhotosCollectionsData? {
        if (arriving == null) return existing
        if (existing == null) return arriving
        val known = existing.shelves.map(::shelfKey).toSet()
        return arriving.copy(
            shelves = existing.shelves + arriving.shelves.filterNot { shelfKey(it) in known },
            // The doors are the same four on every page; the arriving copy
            // wins, because a later page can only ever know more.
            doors = arriving.doors.ifEmpty { existing.doors },
        )
    }

    /**
     * What makes two shelf rows the same row.
     *
     * A standing shelf is its mode; an album is its collection id. There is no
     * field on [ShelfRow] that is unique across both — `title` is copy and two
     * albums may share one — so the key is read off the oneof, which is the
     * discriminated union doing the job a bag of optionals could not.
     */
    private fun shelfKey(row: ShelfRow): String {
        val shelf = row.shelf ?: return "?:${row.title}"
        val album = shelf.album
        if (album != null) return "album:${album.collection_id}"
        val view = shelf.state_view
        val mode = view?.mode
        if (mode != null) return "mode:${mode.kind.name}"
        val person = view?.person
        if (person != null) return "person:${person.party_id}"
        val place = shelf.place
        if (place != null) return "place:${place.place_id}"
        val memory = shelf.memory
        if (memory != null) return "memory:${memory.memory_id}"
        return "?:${row.title}"
    }

    /**
     * `media.create_album`'s input, as JSON bytes.
     *
     * Hand-built for `NotesEditorMachine.saveInput`'s reason: `commonMain`
     * carries no JSON dependency, the shape is one field, and the escaping is
     * the only hard part. The schema is `additionalProperties: false`, so
     * `title` and the optional `album_id` are the only keys it admits — and
     * `album_id` is deliberately absent (see the invoke key's note).
     */
    internal fun createInput(title: String): String = "{\"title\":${jsonString(title)}}"

    internal fun deleteInput(collectionId: String): String =
        "{\"album_id\":${jsonString(collectionId)}}"

    /**
     * One JSON string literal, escaped.
     *
     * The same table `NotesEditorMachine` writes, and for the same reason: an
     * album named `He said "hi"` produces input the vault cannot parse, and the
     * failure lands as a command that never ran rather than as anything a
     * member could read.
     */
    private fun jsonString(value: String): String {
        val out = StringBuilder(value.length + 2)
        out.append('"')
        value.forEach { character ->
            when (character) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                else ->
                    if (character < ' ') {
                        out.append("\\u").append(character.code.toString(16).padStart(4, '0'))
                    } else {
                        out.append(character)
                    }
            }
        }
        out.append('"')
        return out.toString()
    }

    /**
     * `core_collection` — the member's own albums, and the table this screen's
     * one statement reads.
     *
     * Not `media_asset`: nothing on this screen is keyed by an asset, and a
     * library that gains rows all day during a camera-roll backup would redraw
     * a list of shelves on every one of them. Not `core_collection_entry`
     * either — an entry moving changes an album's SIZE, which is the count this
     * screen cannot show anyway.
     */
    override fun rowsChanged(
        table: String,
        keys: List<String>,
    ): PhotosCollectionsEvent? = when (table) {
        TABLE -> PhotosCollectionsEvent(
            rows_changed = PhotosCollectionsEvent.RowsChanged(collection_ids = keys),
        )

        else -> null
    }

    internal const val TABLE: String = PhotosCollectionsReads.TABLE

    override fun seatChanged(seat: SeatState): PhotosCollectionsEvent =
        PhotosCollectionsEvent(seat_changed = PhotosCollectionsEvent.SeatChanged(seat = seat))
}
