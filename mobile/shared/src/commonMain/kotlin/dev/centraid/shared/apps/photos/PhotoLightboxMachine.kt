package dev.centraid.shared.apps.photos

import centraid.screen.v1.Loading
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoDetail
import centraid.screen.v1.PhotoLabel
import centraid.screen.v1.PhotoLightboxEvent
import centraid.screen.v1.PhotoLightboxState
import centraid.screen.v1.PhotoPerson
import centraid.screen.v1.PhotoPlaceChoice
import centraid.screen.v1.SeatState
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * THE LIGHTBOX — one photograph, and everything this device knows of it
 * (#1029, photos port, lane 2).
 *
 * The screen a member spends most of their time in, and the one where v0 put
 * the most reasoning: `viewer-model.ts`, `viewer-toolbar-states.ts`,
 * `viewer-write-refusal.ts` and `viewer-menu.ts` are four files whose whole
 * subject is **which verbs are offered, and WHY one is withheld**. That
 * reasoning is ported; the buttons alone would not have been worth porting.
 *
 * ## The three things this reducer is
 *
 * 1. **A READ THAT ARRIVES IN PIECES.** There is no join clause on the page
 *    door, so one photograph is several statements: the asset itself, then its
 *    place, its confirmed faces and those people's names, its tags and those
 *    concepts' words, and its byte size. Each is a [Leg] with its own screen
 *    id, its own `ScreenReads`, and its own `ReadPage` effect. The screen is
 *    `loading` until the ASSET lands and never after: **a face read that never
 *    answers is not a failure of the photograph**, and a lightbox that showed a
 *    sentence instead of a picture because the tag table was empty would be the
 *    fourth state the read law forbids, arrived at from the other side.
 * 2. **A CHROME STATE, NOT AN ANIMATION.** `chrome_visible` is reduced here so
 *    that a member who put the bars away and then rotated the phone does not
 *    get them back — the proto's own comment, and v0's `viewerChromeVisible`
 *    before it.
 * 3. **A SET OF VERBS AND THEIR REFUSALS.** [writeRefusal] is v0's ladder,
 *    ported whole, and [toolbar] is its enabled/reason table. Held as data so
 *    "no action is enabled without being able to run, and none is disabled
 *    without a reason" can be asserted without a renderer — which is exactly
 *    why v0 pulled them out of the component in the first place (#1015 B10).
 *
 * ## What a swipe is
 *
 * `neighbour_asset_ids` is the shelf's order, carried in on `Opened`, so a
 * swipe is a [PhotoLightboxEvent.Moved] and NOT a read of the shelf. A
 * lightbox that re-read its neighbours on every swipe would page the library
 * once per photograph a member flicked past.
 */
public object PhotoLightboxMachine : ScreenMachine<PhotoLightboxState, PhotoLightboxEvent> {
    public const val SCREEN_ID: String = "photos.lightbox"

    /**
     * THE READS ONE PHOTOGRAPH TAKES, BESIDE THE ASSET ITSELF.
     *
     * `ScreenReads` serves ONE statement per screen id, and `arrived` is handed
     * rows with no note saying which statement produced them. So a screen that
     * reads six tables is six `ScreenReads` with six ids rather than one object
     * switching on a phase it kept in a field — a field that two reads in
     * flight would race, and that nothing in the runtime promises to sequence.
     * Each leg here is one statement, one projection, one screen id, and the
     * pairing cannot come apart.
     *
     * They are declared on the MACHINE because the machine is what emits the
     * `ReadPage` effects that name them; `PhotoLightboxReads` implements them.
     * The other direction would be a cycle.
     */
    public enum class Leg {
        /** `core_place`, for [PhotoDetail.place_name]. */
        PLACE,

        /** `media_face_region`, confirmed only, for the party ids in it. */
        FACES,

        /** `core_party`, to put a NAME on each of those ids. */
        PEOPLE,

        /** `core_tag` on this asset, for [PhotoDetail.labels]' concept ids. */
        TAGS,

        /** `core_concept`, to put a WORD on each of those concept ids. */
        CONCEPTS,

        /** `core_content_item`, for [PhotoDetail.byte_size]. */
        CONTENT,
    }

    /** The screen id a [Leg]'s `ReadPage` effect carries. */
    public fun readId(leg: Leg): String = SCREEN_ID + "/" + leg.name.lowercase()

    /**
     * THE READS THAT ARE NOT PARTS OF THE PHOTOGRAPH.
     *
     * A [Leg] answers for a piece of [PhotoDetail] and lands as an amendment
     * to it; these answer for the SCREEN around the photograph — the strip of
     * its neighbours, the places it could be moved to, the movie half of a
     * Live Photo — and each lands on its own event arm. Kept apart from [Leg]
     * so that "every leg is an amendment naming a part" stays true of every
     * leg, rather than of most of them.
     */
    public enum class Side {
        /** `media_asset` over a window of neighbours, for the filmstrip. */
        FILM,

        /** `core_place`, for the "Adjust location" picker. */
        PLACES,

        /** `media_asset` by capture group, for a Live Photo's movie. */
        LIVE,
    }

    /** The screen id a [Side] read's `ReadPage` effect carries. */
    public fun readId(side: Side): String = SCREEN_ID + "/side/" + side.name.lowercase()

    /**
     * HOW FAR EITHER SIDE OF THE PHOTOGRAPH ON SCREEN THE STRIP IS READ.
     *
     * A window and not the shelf, because a shelf is up to a page of five
     * hundred and a strip shows about eight: the frames a member can reach by
     * flicking the strip are read, and the next window is read when a swipe
     * carries them past the edge of this one.
     */
    public const val FILM_REACH: Int = 30

    /**
     * v0's `SLIDESHOW_INTERVAL_MS` — A PROMISE, not a taste: the slideshow's
     * meta line prints this number, so the clock that ticks it reads it here.
     */
    public const val SLIDESHOW_INTERVAL_MS: Long = 4_000L

    /** The neighbours the strip reads around the photograph on screen. */
    public fun filmWindow(state: PhotoLightboxState): List<String> {
        val neighbours = state.neighbour_asset_ids
        val at = neighbours.indexOf(state.asset_id)
        if (at < 0 || neighbours.size <= 1) return emptyList()
        val from = maxOf(0, at - FILM_REACH)
        val to = minOf(neighbours.size, at + FILM_REACH + 1)
        return neighbours.subList(from, to)
    }

    /** The window's frames this screen has not read yet. */
    public fun filmMissing(state: PhotoLightboxState): List<String> {
        val known = state.film.map { it.asset_id }.toSet()
        return filmWindow(state).filterNot { it in known }
    }

    /**
     * `12 of 184 · 4 seconds a photograph` — v0's `slideshowMeta`, and the only
     * place the position index appears. Empty when the photograph on screen is
     * not on the shelf it was opened from.
     */
    public fun slideshowMeta(state: PhotoLightboxState): String {
        val at = state.neighbour_asset_ids.indexOf(state.asset_id)
        if (at < 0) return ""
        val seconds = SLIDESHOW_INTERVAL_MS / 1_000L
        return "${at + 1} of ${state.neighbour_asset_ids.size} · $seconds seconds a photograph"
    }

    /** v0's slideshow status line, unchanged. */
    public const val SLIDESHOW_LINE: String =
        "Leaving the slideshow keeps the photograph you stopped on"

    /**
     * THE LIGHTBOX OPENS WITH ITS CHROME DRAWN (v0's `CHROME_VISIBLE_ON_OPEN`).
     *
     * A photograph that arrives bare is a screen with no visible way back,
     * whatever the gesture can do.
     */
    override fun initial(): PhotoLightboxState = PhotoLightboxState(
        loading = Loading(first_load = true),
        chrome_visible = true,
        sheet = PhotoLightboxState.Sheet.SHEET_NONE,
    )

    override fun reduce(
        state: PhotoLightboxState,
        event: PhotoLightboxEvent,
    ): Step<PhotoLightboxState> = when {
        // A FRESH OPEN IS A FRESH SCREEN: the album it came from, no
        // slideshow, and a strip that belongs to the shelf it was opened on —
        // kept only when that shelf is the same one.
        event.opened != null -> open(
            state.copy(
                album_id = event.opened.album_id,
                slideshow = false,
                album_choice_open = false,
                film = if (state.neighbour_asset_ids == event.opened.neighbour_asset_ids) {
                    state.film
                } else {
                    emptyList()
                },
            ),
            event.opened.asset_id,
            event.opened.neighbour_asset_ids,
        )

        // A SWIPE IS A MOVE, NOT A ROUTE. The id and not a delta, because the
        // shell knows which cell it swiped to and an index into a list the
        // reducer also holds is two places one fact can be wrong.
        //
        // The neighbours are KEPT: the shelf that opened this lightbox is still
        // the shelf, and re-deriving its order from the photograph a member
        // landed on would put them in a different library by the third swipe.
        event.moved != null ->
            open(state, event.moved.asset_id, state.neighbour_asset_ids)

        event.data_ != null -> arrived(state, event.data_.detail, event.data_.amendment)

        // A FAILED READ REPLACES THE PHOTOGRAPH, and emits NOTHING. A retry is
        // a wake and never a reducer's reflex; a reducer that re-read on its own
        // refusal is the loop the low-disk park exists to stop.
        event.refused != null -> Step(
            state.copy(loading = null, detail = null, failure = event.refused.failure),
        )

        // THIS PHOTOGRAPH'S OWN ROW MOVED. Re-read it, and do NOT clear the
        // detail first: the picture stays on screen while the read runs, which
        // is the difference between a lightbox and a slideshow of spinners.
        // Rows for other assets move nothing — a backup gains rows all day.
        event.rows_changed != null ->
            if (state.asset_id in event.rows_changed.asset_ids) {
                Step(state, listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)))
            } else {
                Step(state)
            }

        event.chrome != null -> Step(state.copy(chrome_visible = event.chrome.visible))

        // THE PLACE PICKER READS ITS LIST WHEN IT OPENS, and every time it
        // does: a place named on the Places screen a minute ago belongs in it,
        // and a list read once per lightbox would not have it.
        event.sheet != null -> Step(
            state.copy(sheet = event.sheet.sheet),
            if (event.sheet.sheet == PhotoLightboxState.Sheet.SHEET_PLACE) {
                listOf(ScreenEffect.ReadPage(readId(Side.PLACES), null))
            } else {
                emptyList()
            },
        )

        event.located != null -> located(state, event.located)

        // A SLIDESHOW NEEDS SOMEWHERE TO GO. On a shelf of one it would be a
        // mode with a clock that moves nothing, so it is refused by doing
        // nothing — and the menu does not offer it there.
        event.slideshow != null -> Step(
            state.copy(
                slideshow = event.slideshow.playing && state.neighbour_asset_ids.size > 1,
                sheet = PhotoLightboxState.Sheet.SHEET_NONE,
                chrome_visible = true,
            ),
        )

        // THE CLOCK TICKED, AND THE REDUCER SAYS WHERE TO. It wraps at the end
        // of the shelf, as v0's did, so a slideshow is a loop until Leave.
        event.slideshow_advanced != null -> {
            val neighbours = state.neighbour_asset_ids
            val at = neighbours.indexOf(state.asset_id)
            if (!state.slideshow || neighbours.size <= 1 || at < 0) {
                Step(state)
            } else {
                open(state, neighbours[(at + 1) % neighbours.size], neighbours)
            }
        }

        event.caption != null -> caption(state, event.caption.caption)

        event.tag_added != null -> {
            val label = event.tag_added.label.trim()
            // AN EMPTY LABEL IS NOT A WRITE: `core.tag_item` says `minLength: 1`.
            if (label.isEmpty()) {
                Step(state)
            } else {
                write(
                    state,
                    command = TAG_COMMAND,
                    verb = "tag",
                    input = "{\"subject_type\":" + jsonString(TAG_SUBJECT_TYPE) +
                        ",\"subject_id\":" + jsonString(state.asset_id) +
                        ",\"label\":" + jsonString(label) + "}",
                    key = TAG_COMMAND + ":" + state.asset_id + ":" + label,
                )
            }
        }

        // BY THE EDGE, NEVER BY THE WORD. Two schemes can spell one word, and
        // an untag that matched on it would take the wrong one off.
        event.tag_removed != null ->
            if (event.tag_removed.tag_id.isEmpty()) {
                Step(state)
            } else {
                write(
                    state,
                    command = UNTAG_COMMAND,
                    verb = "untag",
                    input = "{\"tag_id\":" + jsonString(event.tag_removed.tag_id) + "}",
                    key = UNTAG_COMMAND + ":" + event.tag_removed.tag_id,
                )
            }

        // AN EMPTY CHOICE CLEARS THE PLACE, and clears it by OMITTING the
        // field: `media.set_asset_place` reads an absent `place_id` as "back to
        // unknown", and an empty string is a value its schema refuses.
        event.place_chosen != null -> {
            val placeId = event.place_chosen.place_id
            write(
                state.copy(sheet = PhotoLightboxState.Sheet.SHEET_NONE),
                command = PLACE_COMMAND,
                verb = "place",
                input = "{\"asset_id\":" + jsonString(state.asset_id) +
                    (if (placeId.isEmpty()) "" else ",\"place_id\":" + jsonString(placeId)) + "}",
                key = PLACE_COMMAND + ":" + state.asset_id + ":" + placeId,
            )
        }

        event.place_choices != null -> Step(
            state.copy(
                // BY NAME, because a member finds a place by reading it. The
                // read sorts by id — the door's own idiom for a set — and the
                // order a member scans is this screen's to decide.
                place_choices = event.place_choices.places.sortedWith(
                    compareBy<PhotoPlaceChoice> { it.name.lowercase() }.thenBy { it.place_id },
                ),
            ),
        )

        // A COVER IS CHOSEN FROM AN ALBUM'S MEMBERS, so without the album this
        // lightbox was opened from there is no cover to set — and the menu
        // does not offer it.
        event.key_photo != null ->
            if (state.album_id.isEmpty()) {
                Step(state)
            } else {
                write(
                    state,
                    command = COVER_COMMAND,
                    verb = "cover",
                    input = "{\"album_id\":" + jsonString(state.album_id) +
                        ",\"asset_id\":" + jsonString(state.asset_id) + "}",
                    key = COVER_COMMAND + ":" + state.album_id + ":" + state.asset_id,
                )
            }

        event.hand_off_settled != null ->
            if (event.hand_off_settled.done) {
                Step(state.copy(notice = event.hand_off_settled.sentence, write_failure = null))
            } else {
                Step(
                    state.copy(
                        notice = "",
                        write_failure = Reads.refused(
                            event.hand_off_settled.sentence.ifEmpty { HAND_OFF_FAILED },
                        ),
                    ),
                )
            }

        // THE STRIP'S FRAMES FOLD IN BY ID, and only frames of THIS shelf are
        // kept: an answer for a window the member has walked away from still
        // belongs on the strip, and one for another shelf does not.
        event.film != null -> {
            val shelf = state.neighbour_asset_ids.toSet()
            val arriving = event.film.frames.filter { it.asset_id in shelf }
            val fresh = arriving.map { it.asset_id }.toSet()
            Step(state.copy(film = state.film.filterNot { it.asset_id in fresh } + arriving))
        }

        // A MOVIE FOR A STILL THE MEMBER HAS LEFT lands on nothing, for the
        // same reason a stale asset read does.
        event.live != null -> {
            val detail = state.detail
            if (detail == null || event.live.asset_id.isEmpty() ||
                event.live.asset_id != state.asset_id
            ) {
                Step(state)
            } else {
                Step(
                    state.copy(
                        detail = detail.copy(
                            live_asset_id = event.live.live_asset_id,
                            live_content_id = event.live.live_content_id,
                        ),
                    ),
                )
            }
        }

        // "ADD TO ALBUM" — `AlbumChoice.kt`'s contract, step for step.
        event.album_choice_opened != null -> Step(
            state.copy(album_choice_open = true, sheet = PhotoLightboxState.Sheet.SHEET_NONE),
            AlbumChoice.openEffects(),
        )

        event.album_choice_dismissed != null -> Step(state.copy(album_choice_open = false))

        event.album_choices != null -> Step(state.copy(album_choices = event.album_choices.choices))

        event.album_chosen != null -> writes(
            state.copy(album_choice_open = false),
            verb = "album",
            effects = AlbumChoice.addEffects(listOf(state.asset_id), event.album_chosen.album_id),
        )

        // THE SHEET STAYS OPEN over a create: the new album is in the list
        // once the create commits and the list re-reads, and the member's next
        // tap is the one that puts the photograph in it.
        event.album_choice_created != null -> writes(
            state,
            verb = "album",
            effects = AlbumChoice.createEffects(event.album_choice_created.title),
        )

        event.favorite != null -> write(
            state,
            command = FAVORITE_COMMAND,
            verb = "favorite",
            input = "{\"asset_id\":" + jsonString(state.asset_id) + ",\"favorite\":" +
                (if (event.favorite.favorite) "1" else "0") + "}",
            key = FAVORITE_COMMAND + ":" + state.asset_id + ":" +
                (if (event.favorite.favorite) "1" else "0"),
        )

        event.archive != null -> write(
            state,
            command = UPDATE_COMMAND,
            verb = "archive",
            input = "{\"asset_id\":" + jsonString(state.asset_id) + ",\"archived\":" +
                (if (event.archive.archived) "1" else "0") + "}",
            key = UPDATE_COMMAND + ":archived:" + state.asset_id + ":" +
                (if (event.archive.archived) "1" else "0"),
        )

        // TWO COMMANDS, ONE TAP APART, AND ONLY ONE OF THEM IS REVERSIBLE. The
        // proto refuses to infer `permanent` from the shelf even though it
        // could, and this refuses to infer it from anything else: the screen
        // that asked has to have said so.
        event.delete != null -> {
            val command = if (event.delete.permanent) PURGE_COMMAND else DELETE_COMMAND
            write(
                state,
                command = command,
                verb = "trash",
                input = "{\"asset_id\":" + jsonString(state.asset_id) + "}",
                key = command + ":" + state.asset_id,
            )
        }

        // THE MEMBER TAPPED THE DOWNLOAD ARROW. The detail goes to
        // `HELD_FETCHING` HERE and not when the answer comes back: the round
        // trip is the whole duration a member waits through, and an affordance
        // that stays un-pressed until it finishes is one a member taps again.
        event.fetch_original != null -> {
            val tapped = event.fetch_original
            Step(
                state.copy(detail = state.detail?.copy(held = PhotoCell.Held.HELD_FETCHING)),
                listOf(
                    ScreenEffect.FetchOriginal(SCREEN_ID, tapped.asset_id, tapped.content_hash),
                ),
            )
        }

        // A FETCH THAT LANDED REDRAWS THROUGH THE ROW CHANGE ITS OWN BYTES
        // CAUSED, so this is here for the other two outcomes — a gateway that
        // was not reached and a refusal by code — and what it does is stop the
        // spinner. A photograph left fetching because nobody said "it did not
        // happen" is the state this deletes.
        //
        // `FetchSettled.sentence` LANDS ON `write_failure` TOO. A fetch is not
        // a write, but what the member is owed is identical — a line that says
        // the thing they asked for did not happen — and a second slot for it
        // would be a second place the chrome has to look.
        event.fetch_settled != null ->
            if (event.fetch_settled.fetched) {
                Step(state)
            } else {
                Step(
                    state.copy(
                        detail = state.detail?.copy(
                            // BACK TO WHAT THE READ SAID, and the read said the
                            // rule was holding it — which is still true, and is
                            // still the state that carries the arrow, so the
                            // member can try again.
                            held = PhotoCell.Held.HELD_WITHHELD_BY_RULE,
                        ),
                        write_failure = event.fetch_settled.sentence
                            .takeIf { it.isNotEmpty() }
                            ?.let(Reads::refused),
                    ),
                )
            }

        // A COMMITTED WRITE IS A RE-READ. Favorite is a `core_tag` row, archive
        // and trash are `media_asset` columns, and none of the three is a fact
        // this reducer may paint on the detail by hand — a star drawn because a
        // command was SENT is a star that stays on when the command was denied.
        //
        // A REFUSED WRITE LEAVES THE PHOTOGRAPH EXACTLY AS IT IS, and its
        // sentence lands on `write_failure` — its OWN slot, never the `content`
        // oneof's `failure`. That slot is the READ's, one of the three states a
        // read can be in, and a denied favourite put there would replace the
        // photograph on screen with an error text: a member who tried to
        // favourite a photo in a read-only vault would lose the picture they
        // were looking at. `NoteDraft.save_failure` is the same field for the
        // same reason.
        event.write_settled != null ->
            if (event.write_settled.committed) {
                Step(
                    state.copy(write_failure = null),
                    // AN OPEN ALBUM SHEET RE-READS ITS LIST TOO: the write
                    // that just committed may be the album it was waiting for.
                    listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)) +
                        (if (state.album_choice_open) AlbumChoice.openEffects() else emptyList()),
                )
            } else {
                Step(
                    state.copy(
                        write_failure = Reads.refused(
                            event.write_settled.sentence.ifEmpty { WRITE_REFUSED_WITHOUT_A_REASON },
                        ),
                    ),
                )
            }

        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

        else -> Step(state)
    }

    /**
     * WHAT A MEMBER READS WHEN THE VAULT REFUSED AND SAID NOTHING.
     *
     * `CommandOutcome.reason` is the author's words for a denial and is usually
     * there; when it is not, the refusal still has to be visible. A write that
     * failed silently is the one outcome a member cannot act on, and an empty
     * sentence under a control that looks armed reads as a control that works.
     */
    public const val WRITE_REFUSED_WITHOUT_A_REASON: String =
        "Centraid could not make that change, and did not say why."

    /**
     * `media.set_favorite` AND NOT `media.update_asset`.
     *
     * Both take a `favorite` integer and both end in the same place — a
     * `core_tag` row against the flags scheme's `starred` concept — but
     * `update_asset` is a general edit whose other fields (`title`,
     * `captured_at`) this tap does not touch, and a command whose input says
     * "change the favourite and nothing else" is the one whose `invoke_key` can
     * honestly be `(asset, value)`. `update_asset` keyed that way would collide
     * with a title edit of the same asset.
     */
    public const val FAVORITE_COMMAND: String = "media.set_favorite"

    /** `media.update_asset` — the `archived` column's own verb. */
    public const val UPDATE_COMMAND: String = "media.update_asset"

    /** Into the trash. Reversible by `media.restore_asset` from the trash shelf. */
    public const val DELETE_COMMAND: String = "media.delete_asset"

    /** OUT OF THE VAULT. The registry marks it confirmation-required. */
    public const val PURGE_COMMAND: String = "media.purge_asset"

    /**
     * `core.tag_item`, as the VAULT registers it. The Photos action
     * `tag-asset` is this command with `subject_type` filled in
     * (`crates/apps/photos/src/commands.rs`), and a screen submits the
     * command, so it fills it in itself.
     */
    public const val TAG_COMMAND: String = "core.tag_item"

    /** `core.untag_item` — by the edge's id. */
    public const val UNTAG_COMMAND: String = "core.untag_item"

    /** `crates/apps/photos`' `TAG_SUBJECT_TYPE`, spelled the same. */
    public const val TAG_SUBJECT_TYPE: String = "media.asset"

    /** `media.set_asset_place` — the Photos action `set-place`. */
    public const val PLACE_COMMAND: String = "media.set_asset_place"

    /** `media.set_album_cover` — the Photos action `set-album-cover`. */
    public const val COVER_COMMAND: String = "media.set_album_cover"

    /** What a member reads when a hand-off failed and did not say why. */
    public const val HAND_OFF_FAILED: String = EXPORT_FAILED

    /**
     * A WRITE, OR THE REFUSAL THAT STANDS IN ITS PLACE.
     *
     * The ladder is climbed HERE and not only in the view, because a view that
     * can compose a command can compose one the vault will not take — and v0's
     * toolbar rendered all five verbs identically, so four of them looked armed
     * and silently did nothing (#1015 B10). A refused verb emits
     * [ScreenEffect.WithheldOffline] rather than nothing at all: the member is
     * told the write did not happen, with the sentence that says why.
     */
    private fun write(
        state: PhotoLightboxState,
        command: String,
        verb: String,
        input: String,
        key: String,
    ): Step<PhotoLightboxState> {
        val refusal = writeRefusal(state)
        if (refusal != null) {
            return Step(
                // THE SAME LINE, WHETHER THE REFUSAL WAS KNOWN IN ADVANCE OR
                // CAME BACK FROM THE VAULT. `viewer-read-only-reason.ts`'s whole
                // subject is wording WHY a verb is withheld, and a member does
                // not care which end of the write found out.
                state.copy(write_failure = Reads.refused(refusal)),
                listOf(ScreenEffect.WithheldOffline(verb, refusal)),
            )
        }
        // A NEW ATTEMPT CLEARS THE OLD SENTENCE. A refusal left standing over a
        // write that is in flight is a screen saying no while it does the thing.
        return Step(
            state.copy(write_failure = null),
            listOf(ScreenEffect.SubmitWrite(command, input, key)),
        )
    }

    /**
     * SEVERAL WRITES FOR ONE TAP, behind the same ladder as one.
     *
     * "Add to album" is `AlbumChoice.addEffects`, which is a list — one per
     * photograph on the screens that pick many — and the refusal is climbed
     * once for all of them: a vault that will not take the first will not
     * take the second either.
     */
    private fun writes(
        state: PhotoLightboxState,
        verb: String,
        effects: List<ScreenEffect>,
    ): Step<PhotoLightboxState> {
        val refusal = writeRefusal(state)
        if (refusal != null) {
            return Step(
                state.copy(write_failure = Reads.refused(refusal)),
                listOf(ScreenEffect.WithheldOffline(verb, refusal)),
            )
        }
        return Step(state.copy(write_failure = null), effects)
    }

    /**
     * THE CAPTION IS THE ASSET'S `title`, and `media.update_asset` is its
     * verb. Trimmed, and a caption identical to the one on screen is not a
     * write: a field that lost focus without being changed would otherwise
     * commit the same words every time the info sheet closed.
     */
    private fun caption(state: PhotoLightboxState, typed: String): Step<PhotoLightboxState> {
        val caption = typed.trim()
        if (state.detail == null || caption == state.detail.title.trim()) return Step(state)
        return write(
            state,
            command = UPDATE_COMMAND,
            verb = "caption",
            input = "{\"asset_id\":" + jsonString(state.asset_id) + ",\"title\":" +
                jsonString(caption) + "}",
            // THE WORDS ARE THE INTENT, so they are in the key: a caption
            // changed twice is two writes, and the second is not a replay of
            // the first.
            key = UPDATE_COMMAND + ":title:" + state.asset_id + ":" + caption,
        )
    }

    /**
     * THE BYTE DOOR'S ANSWER, folded into the photograph it was asked about.
     *
     * Keyed on the asset and dropped for any other, for [arrived]'s reason: a
     * swipe issues the next photograph's reads at once, and a path for the
     * last one landing after it would draw the wrong picture under the
     * member's finger.
     */
    private fun located(
        state: PhotoLightboxState,
        located: PhotoLightboxEvent.OriginalLocated,
    ): Step<PhotoLightboxState> {
        val detail = state.detail ?: return Step(state)
        if (located.asset_id != detail.asset_id) return Step(state)
        return Step(
            state.copy(
                detail = detail.copy(
                    original_path = located.original_path?.takeIf { it.isNotEmpty() },
                    original_embeddable = located.embeddable,
                    original_media_type = located.media_type,
                    live_path = located.live_path?.takeIf { it.isNotEmpty() },
                ),
            ),
        )
    }

    /**
     * v0's `viewerWriteRefusal`, PORTED WHOLE (#1014, R17).
     *
     * **NO-VAULT-ROW BEATS READ-ONLY, and the order is the finding.** It used
     * to be the other way round: `canWrite` is a property of a VAULT row, so a
     * photograph this phone holds and no vault has yet carries no such row, the
     * flag reads false by ABSENCE rather than by grant, and every device-only
     * picture in the member's OWN vault was refused with "ask its owner for
     * write access" — an owner who is them, about a vault that would take the
     * write the moment the row arrived.
     *
     * What the two rungs are on this shell:
     *
     * - **There is no vault row.** The lightbox is `loading`, or the read
     *   failed, or the asset id is empty. There is nothing to write TO.
     * - **The vault is read-only.** On v0 that was a grant on someone else's
     *   vault. The phone is the vault now (#1029 §1), so the one kind of
     *   read-only left is a vault that MOVED to the member's other phone — and
     *   `ScreenRuntime`'s `readOnly` supplier is what knows it, at the moment
     *   of the write rather than at attach. So this rung is NOT duplicated
     *   here: a copy would be a second answer to "may this vault be written",
     *   read a second earlier than the one that counts.
     */
    public fun writeRefusal(state: PhotoLightboxState): String? {
        if (state.detail == null || state.asset_id.isEmpty()) return NOT_IN_A_VAULT_YET_REASON
        return null
    }

    /** v0's `NOT_IN_A_VAULT_YET_REASON`, unchanged. */
    public const val NOT_IN_A_VAULT_YET_REASON: String =
        "This photograph is not in a vault yet."

    /** The five verbs the bottom row carries, in the desktop bar's own order. */
    public enum class Verb { COPY, FAVORITE, INFO, EDIT, TRASH }

    /** One verb: live, or visibly refused with a reason. [why] is never empty
     *  when [enabled] is false, and never set when it is true. */
    public data class ToolbarState(public val enabled: Boolean, public val why: String = "")

    /**
     * THE BOTTOM ROW'S ENABLED/REASON TABLE, AS DATA (v0's
     * `viewer-toolbar-states.ts`, #1015 B10).
     *
     * The contract is one sentence — *no action is enabled without being able
     * to run, and none is disabled without a reason* — and it is held here
     * rather than in either view so that it is assertable without a renderer
     * and cannot say two different things on two shells.
     *
     * Three verbs move from v0:
     *
     * - **COPY** was "save this commons item to my vault", and v0 refused it
     *   with "This photograph is already yours". There is no commons and no
     *   second vault to copy from in v0 of this shell, so every photograph is
     *   already the member's and the refusal is the permanent answer. It is
     *   kept refused-with-a-reason rather than deleted, because a bar of four
     *   where the desktop has five is the watering-down v0's own comment
     *   forbids.
     * - **EDIT** is [PhotoEditorMachine.editRefusal], the one table both
     *   shells' `PhotoEditButton` draw from: live over a photograph whose
     *   original this phone holds, refused otherwise with the sentence that
     *   says which absence it is — or, on a video, that crop and rotate are not
     *   what this kind of media has.
     * - **INFO IS ALWAYS LIVE.** It reads; it never writes. A facts panel
     *   refused because a vault is read-only would be hiding what a member
     *   already holds.
     */
    public fun toolbar(state: PhotoLightboxState): Map<Verb, ToolbarState> {
        val refusal = writeRefusal(state)
        return mapOf(
            Verb.COPY to ToolbarState(false, "This photograph is already yours"),
            Verb.FAVORITE to gate(refusal),
            Verb.INFO to ToolbarState(true),
            Verb.EDIT to gate(PhotoEditorMachine.editRefusal(state.detail)),
            Verb.TRASH to gate(refusal),
        )
    }

    private fun gate(refusal: String?): ToolbarState =
        if (refusal == null) ToolbarState(true) else ToolbarState(false, refusal)

    /**
     * ONE PHOTOGRAPH, FROM THE TOP.
     *
     * The detail is CLEARED, which is what makes a stale amendment harmless:
     * [arrived] drops an amendment that reaches a screen holding no detail, so
     * a place name still in flight for the previous photograph lands on nothing
     * rather than on the next one. The sheet closes and the chrome comes back
     * for v0's stated reason — *navigation re-shows it*, so a member is never
     * carried further into a bare screen.
     */
    private fun open(
        state: PhotoLightboxState,
        assetId: String,
        neighbours: List<String>,
    ): Step<PhotoLightboxState> = Step(
        state.copy(
            asset_id = assetId,
            neighbour_asset_ids = neighbours,
            loading = Loading(first_load = true),
            failure = null,
            detail = null,
            chrome_visible = true,
            sheet = PhotoLightboxState.Sheet.SHEET_NONE,
            // A REFUSAL IS ABOUT THE PHOTOGRAPH IT WAS TRIED ON. Carrying it to
            // the next one would tell a member their swipe had been refused.
            write_failure = null,
            // AND SO IS A RECEIPT: "Sent with no location." under the next
            // photograph would be a claim about a copy of it nobody sent.
            notice = "",
            album_choice_open = false,
        ),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    /**
     * A PAGE LANDED. Which of the seven reads was it?
     *
     * **`amendment` IS EXPLICIT AND IS NOT INFERRED FROM AN EMPTY `asset_id`.**
     * It was, for one draft — "a detail with no id is a satellite" — and that
     * holds only while no satellite CAN carry an id. A placement or face leg
     * would want to carry exactly that, and the day one does the inference
     * fails silently: a reducer that cannot tell a merge from a replace paints
     * one photograph's people onto another, and both shapes typecheck.
     *
     * The asset leg REPLACES rather than merges, including on a re-read: a
     * favourite the member just removed must not survive because a previous
     * leg's answer was carried forward. The six amendments re-fire immediately
     * after, off a local SQLite file, which is the cost of that correctness.
     */
    private fun arrived(
        state: PhotoLightboxState,
        arriving: PhotoDetail?,
        amendment: Boolean,
    ): Step<PhotoLightboxState> {
        if (arriving == null) return Step(state)
        if (!amendment) {
            // A READ FOR A PHOTOGRAPH THE MEMBER HAS LEFT. Dropped rather than
            // drawn: a swipe issues the next asset's read immediately, and the
            // previous one landing after it would put the wrong picture under
            // the member's finger.
            if (arriving.asset_id != state.asset_id) return Step(state)
            val next = state.copy(loading = null, failure = null, detail = carried(state.detail, arriving))
            return Step(next, openers(next, arriving))
        }
        // AN AMENDMENT WITH NOTHING TO AMEND. The member has moved on (or the
        // asset read has not landed yet), and a fragment about a photograph
        // that is not on screen belongs nowhere.
        val current = state.detail ?: return Step(state)
        val merged = amend(current, arriving)
        return Step(state.copy(detail = merged), followUps(current, merged))
    }

    /**
     * The reads the ASSET's own row makes possible, and only those.
     *
     * A place is read when there is a place id; the byte size when there is a
     * content hash to find the item by. Faces and tags are always read — their
     * absence is a real answer and the only way to learn it is to ask.
     */
    private fun openers(state: PhotoLightboxState, detail: PhotoDetail): List<ScreenEffect> =
        buildList {
            add(ScreenEffect.ReadPage(readId(Leg.FACES), null))
            add(ScreenEffect.ReadPage(readId(Leg.TAGS), null))
            if (detail.place_id.isNotEmpty()) add(ScreenEffect.ReadPage(readId(Leg.PLACE), null))
            if (detail.original_hash.isNotEmpty()) {
                add(ScreenEffect.ReadPage(readId(Leg.CONTENT), null))
            }
            // ONLY A STILL CAN HAVE A MOVIE BEHIND IT; a video is the movie.
            if (detail.kind == PhotoCell.Kind.KIND_PHOTO) {
                add(ScreenEffect.ReadPage(readId(Side.LIVE), null))
            }
            // THE STRIP IS READ WHEN A PHOTOGRAPH LANDS, not when it is asked
            // for, so the first read on a fresh open is still the asset alone
            // — the picture before the frames around it.
            if (filmMissing(state).isNotEmpty()) add(ScreenEffect.ReadPage(readId(Side.FILM), null))
        }

    /**
     * WHAT A RE-READ OF THE SAME PHOTOGRAPH KEEPS: where its bytes are.
     *
     * The asset read replaces the detail whole, which is right for every fact
     * the vault holds about it — a favourite removed must not survive — and
     * wrong for the byte door's answer, which no page read carries. A caption
     * edit would otherwise swap the full-size original back to its thumbnail
     * until the path was located again. The movie half is kept for the same
     * reason: it is found by a side read the re-read does not repeat.
     */
    private fun carried(previous: PhotoDetail?, arriving: PhotoDetail): PhotoDetail {
        if (previous == null || previous.asset_id != arriving.asset_id) return arriving
        return arriving.copy(
            content_id = previous.content_id,
            original_path = previous.original_path,
            original_embeddable = previous.original_embeddable,
            original_media_type = previous.original_media_type,
            live_asset_id = previous.live_asset_id,
            live_content_id = previous.live_content_id,
            live_path = previous.live_path,
        )
    }

    /**
     * THE SECOND HOP, AND WHY IT CANNOT LOOP.
     *
     * A face region names a party and a tag names a concept; neither carries
     * the NAME, so each needs one more read. The follow-up fires only for ids
     * this arrival INTRODUCED — `after` minus `before` — so a `core_party` read
     * that came back without a row for somebody (a person purged between the
     * two reads) introduces no new unnamed id and asks again about nobody. A
     * rule of "read while anything is unnamed" would ask for ever.
     */
    private fun followUps(before: PhotoDetail, after: PhotoDetail): List<ScreenEffect> =
        buildList {
            val known = before.people.filter { it.display_name.isEmpty() }
                .map { it.party_id }.toSet()
            if (after.people.any { it.display_name.isEmpty() && it.party_id !in known }) {
                add(ScreenEffect.ReadPage(readId(Leg.PEOPLE), null))
            }
            val said = before.labels.filter { it.label.isEmpty() }.map { it.concept_id }.toSet()
            if (after.labels.any { it.label.isEmpty() && it.concept_id !in said }) {
                add(ScreenEffect.ReadPage(readId(Leg.CONCEPTS), null))
            }
        }

    /**
     * One amendment, folded into the photograph on screen.
     *
     * Every rule here is "an answer beats an absence, and an absence never
     * un-answers": a leg that read nothing must not blank what another leg
     * already said. The only leg that can set each field is named beside it, so
     * there is no field two legs could fight over — which is what makes the
     * fold order-independent and a race between two amendments harmless.
     */
    private fun amend(current: PhotoDetail, part: PhotoDetail): PhotoDetail = current.copy(
        unread_parts = (current.unread_parts + part.unread_parts).distinct()
            .filterNot { it in answered(part) },
        // [Leg.PLACE].
        place_name = part.place_name.ifEmpty { current.place_name },
        // [Leg.CONTENT]. Zero is the absence: `core_content_item.byte_size` is
        // `CHECK (byte_size >= 0)`, and an item of zero bytes is not a
        // photograph anybody has.
        byte_size = if (part.byte_size > 0L) part.byte_size else current.byte_size,
        // [Leg.CONTENT] too: the id the byte door locates the original by.
        content_id = part.content_id.ifEmpty { current.content_id },
        // [Leg.PLACE]. Both halves or neither, and `place_has_coordinate` is
        // what says which.
        place_latitude = if (part.place_has_coordinate) part.place_latitude else current.place_latitude,
        place_longitude = if (part.place_has_coordinate) part.place_longitude else current.place_longitude,
        place_has_coordinate = current.place_has_coordinate || part.place_has_coordinate,
        // [Leg.CONCEPTS], which is the only read that can see the flags
        // scheme's `starred` notation. Monotone within one photograph's life
        // because exactly one leg answers it; an unstar is a WRITE, and a
        // committed write re-reads the asset, which resets this to false before
        // the concepts are asked again.
        favorite = current.favorite || part.favorite,
        people = mergePeople(current.people, part.people),
        labels = mergeLabels(current.labels, part.labels),
    )

    /**
     * WHICH PARTS THIS AMENDMENT JUST ANSWERED FOR.
     *
     * A leg that refused names its [PhotoDetail.Part]; this is how the mark
     * comes OFF again, and the evidence it takes is the only kind available: a
     * populated field. A satellite amendment cannot say which leg produced it
     * when it has nothing to report, so an HONEST EMPTY answer after a refusal
     * does not clear the mark — the reset that does is the asset's own re-read,
     * which replaces the detail whole and re-fires every leg.
     *
     * That asymmetry is deliberate and its failure is the conservative one:
     * the screen can say "Centraid could not read who is in this photograph"
     * while the truth is "nobody is", and the sentence is still true of the
     * last time it asked. The opposite fold — a union that never clears —
     * would leave a refusal standing over an answer that is on screen, which
     * is a screen contradicting itself.
     */
    private fun answered(part: PhotoDetail): Set<PhotoDetail.Part> = buildSet {
        if (part.place_name.isNotEmpty()) add(PhotoDetail.Part.PART_PLACE)
        if (part.people.isNotEmpty()) add(PhotoDetail.Part.PART_PEOPLE)
        if (part.labels.isNotEmpty()) add(PhotoDetail.Part.PART_LABELS)
        if (part.byte_size > 0L) add(PhotoDetail.Part.PART_CONTENT)
    }

    /** [Leg.FACES] brings the ids; [Leg.PEOPLE] brings the names. */
    private fun mergePeople(
        current: List<PhotoPerson>,
        part: List<PhotoPerson>,
    ): List<PhotoPerson> {
        if (part.isEmpty()) return current
        val named = part.associateBy { it.party_id }
        val kept = current.map { person ->
            val name = named[person.party_id]?.display_name.orEmpty()
            if (name.isEmpty()) person else person.copy(display_name = name)
        }
        val known = kept.map { it.party_id }.toSet()
        return kept + part.filterNot { it.party_id in known }
    }

    /**
     * [Leg.TAGS] brings the concept ids and says who put each one there;
     * [Leg.CONCEPTS] brings the words.
     *
     * A label whose word never arrives keeps an empty `label`, and **both views
     * draw only labels that have one**: a concept id is not a word a member
     * wrote, and the flags scheme's `starred` concept is a tag with no word to
     * draw at all — it is the star, and [Leg.CONCEPTS] turns it into
     * `favorite` instead of into a chip.
     */
    private fun mergeLabels(
        current: List<PhotoLabel>,
        part: List<PhotoLabel>,
    ): List<PhotoLabel> {
        if (part.isEmpty()) return current
        val worded = part.associateBy { it.concept_id }
        val kept = current.map { label ->
            val arriving = worded[label.concept_id] ?: return@map label
            // THE WORD FROM ONE LEG AND THE EDGE FROM THE OTHER: [Leg.TAGS]
            // knows which tag it is, [Leg.CONCEPTS] what it says.
            label.copy(
                label = arriving.label.ifEmpty { label.label },
                tag_id = label.tag_id.ifEmpty { arriving.tag_id },
            )
        }
        val known = kept.map { it.concept_id }.toSet()
        return kept + part.filterNot { it.concept_id in known }
    }

    /**
     * `media_asset` — this photograph's own row, and nothing else.
     *
     * NOT `core_tag`, although a favourite IS a tag row: the core's change
     * stream says `(table, keys)`, the keys on that table are TAG ids, and
     * `PhotoLightboxEvent.RowsChanged` carries `asset_ids`. Putting tag ids in
     * that field would be a lie the reducer then matches against its own asset
     * id and never hits — a re-read that looks wired and never fires. The
     * favourite still moves, through the write that made it:
     * `write_settled.committed` re-reads.
     */
    override fun rowsChanged(table: String, keys: List<String>): PhotoLightboxEvent? =
        when (table) {
            TABLE -> PhotoLightboxEvent(rows_changed = PhotoLightboxEvent.RowsChanged(asset_ids = keys))
            else -> null
        }

    private const val TABLE: String = "media_asset"

    /** The lightbox renders the seat: what is durable here decides what the
     *  info sheet can honestly say about where the bytes are. */
    override fun seatChanged(seat: SeatState): PhotoLightboxEvent =
        PhotoLightboxEvent(seat_changed = PhotoLightboxEvent.SeatChanged(seat = seat))

    /**
     * A JSON string, escaped.
     *
     * `commonMain` carries no JSON dependency and `NotesEditorMachine` has the
     * same eight lines — deliberately not shared, because `PerAppLayoutSpec`'s
     * first rule is that an app knows no other app, and `apps.photos` importing
     * `apps.notes` for a string escaper would be exactly the coupling it
     * refuses. Two apps meet in the vault, as rows, and never in a reducer.
     *
     * It does NOT have to be canonical: the command door canonicalises the
     * parsed value before hashing, so a shell agreeing byte-for-byte with the
     * vault's canonicaliser would be a second implementation of it.
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
