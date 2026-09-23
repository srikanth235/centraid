package dev.centraid.shared.apps.photos

import centraid.screen.v1.Loading
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PlaceRow
import centraid.screen.v1.PlacesData
import centraid.screen.v1.PlacesEvent
import centraid.screen.v1.PlacesState
import centraid.screen.v1.SeatState
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * PLACES — WHERE THE PHOTOGRAPHS WERE TAKEN, AS CARDS OR AS A PLOT (#1029, photos port).
 *
 * v0 had two routes over one read (`PlacesView.tsx` and `PlacesMap.tsx`): the
 * shelf and the map read the same `core_place` rows and differed only in the
 * draw, which meant two reads, two empty states and two ways to be out of date.
 * The contract collapses them into one screen with a `Presentation`, so
 * [PlacesEvent.PresentationChanged] changes a parameter and **emits no read** —
 * a member switching to the map is looking at the rows already on the screen.
 *
 * ## TWO PASSES, BECAUSE THE DOOR HAS NO JOIN AND NO `COUNT(*)`
 *
 * A place card is two facts from two tables. `core_place` knows a place's name,
 * its pin and its zone; only `media_asset` knows how many photographs are AT it
 * and which one is its cover, and `PlacesData.unplaced_count` — the number a
 * member needs to judge whether the plot is their library or a corner of it —
 * is a fact about assets with no place at all. `centraid.core.v1.PageQuery` has
 * no join clause and no aggregate, so one statement cannot answer both halves.
 *
 * So this screen emits TWO [ScreenEffect.ReadPage]s under two screen ids
 * ([SCREEN_ID] and [ASSETS_SCREEN_ID]), served by [PlacesReads] and
 * [PlacesAssetReads], and [merge] joins the two answers **field by field, by
 * taking whichever side has an answer**. That is what makes the join
 * order-independent and what keeps it from being a hidden discriminator: the
 * places pass never reports a count, the asset pass never reports a name, and
 * neither has to know which of them arrived first.
 *
 * The alternative was to project one pass and leave the other half at zero, the
 * way `TallyReads` leaves `group_name` empty — but a place shelf whose every
 * card reads "0" is not "a name this read cannot see", it is a number that is
 * wrong. So the count is read, and its ceiling is stated rather than hidden:
 * see [PlacesAssetReads].
 *
 * ## The pin is a pair, and 0,0 is a real place
 *
 * [PlaceRow.has_coordinate] exists because the Gulf of Guinea is a real point
 * and not a null. Nothing here infers "no location" from a zero, and the plot
 * draws only the rows that say they have one.
 */
public object PlacesMachine : ScreenMachine<PlacesState, PlacesEvent> {
    public const val SCREEN_ID: String = "photos.places"

    /**
     * The counting pass's own screen id.
     *
     * A second id and not a second machine: [ScreenEffect.ReadPage] is routed to
     * a runtime by `screenId` (`ScreenRuntime.start`), so two ids are how one
     * screen asks two questions of one door. `PlacesBridge` attaches the runtime
     * that serves this one.
     */
    public const val ASSETS_SCREEN_ID: String = "photos.places.assets"

    /**
     * THE VAULT COMMAND, NOT THE APP ACTION (`crates/vault/src/commands/media.rs`).
     *
     * `media.name_place` writes `name` and `kind` and nothing else; it cannot
     * reach the derived gazetteer name, which is what keeps a member's own word
     * for a place authoritative by construction rather than by convention
     * (`docs/photos/places.md`, layer 1).
     */
    public const val RENAME_COMMAND: String = "media.name_place"

    /**
     * WHAT A PLACE WITH NO READABLE NAME IS CALLED.
     *
     * Byte-identical to `PLACE_NO_NAME` in `crates/apps/photos/src/places.rs`,
     * because the desktop and this shell are naming the same row. Never the
     * coordinate: `find_or_create_place`'s third rung mints a place whose stored
     * `name` IS its coordinates, and printing those would look like an answer.
     */
    public const val NO_NAME: String = "A place with no name yet"

    /**
     * WHEN THE CORE REFUSED AND SAID NOTHING.
     *
     * `CommandOutcome.reason` is the author's words for a denial and it is what
     * a member reads whenever there is one. When there is not, the shell writes
     * the sentence — which is what `HomeSession.found` already does for a
     * refused vault — because the alternative is a rename that fails in silence.
     * **It is not composed out of an error**: `Error.detail` is logs-only, and a
     * shell making a sentence from a peer's words is the hole in that rule.
     */
    internal const val NOT_SAVED: String = "Centraid did not save that name."

    override fun initial(): PlacesState = PlacesState(
        // CARDS, and not `PRESENTATION_UNSPECIFIED`. A screen whose seeded
        // presentation is the enum's zero has a fourth presentation that no
        // view has a branch for, and the one it would fall through to is
        // whichever branch a view wrote last.
        presentation = PlacesState.Presentation.PRESENTATION_CARDS,
        loading = Loading(first_load = true),
    )

    override fun reduce(state: PlacesState, event: PlacesEvent): Step<PlacesState> =
        when {
            // A FRESH OPEN CLEARS A REFUSAL THE MEMBER HAS ALREADY LEFT. The
            // sentence survives a sync re-read — see [firstLoad] — because it
            // is about a write and not about the rows, but it must not greet a
            // member returning to the screen later.
            event.opened != null -> firstLoad(state.copy(write_failure = null))

            // CARDS OR MAP IS A PARAMETER, AND IT COSTS NO READ. The rows are
            // already here; only the draw changes. v0 navigated, which is why
            // opening the map re-read the library and showed a spinner over
            // places the member was looking at a moment earlier.
            event.presentation != null ->
                Step(state.copy(presentation = event.presentation.presentation))

            // THE PLACE WALK CONTINUES; THE COUNTING PASS DOES NOT.
            // `PlacesData.next_cursor` is the `core_place` cursor and nothing
            // else — see [merge], which keeps it from the places pass alone.
            event.next_page != null -> Step(
                state,
                listOf(ScreenEffect.ReadPage(SCREEN_ID, event.next_page.after_cursor)),
            )

            // A ROW MOVED, AND THIS SCREEN IS AN AGGREGATE OVER BOTH TABLES.
            //
            // The keys are NOT consulted, and that is deliberate rather than
            // lazy: a change to one `media_asset` row changes the count of the
            // place it left and the place it joined, and the event that carries
            // it names ASSET ids while `RowsChanged.place_ids` is a list of
            // PLACE ids. There is no key subset that decides an aggregate, so
            // the honest reduction is to read both passes again.
            //
            // **A PARKED FEED EMITS NO RE-READ.** Low disk stops the cadence
            // and freeing space resumes it; a reducer that re-read on every
            // change while parked is the retry loop the device contract pins.
            event.rows_changed != null ->
                if (Reads.isParked(state.failure)) Step(state) else firstLoad(state)

            event.data_ != null -> Step(
                state.copy(
                    loading = null,
                    failure = null,
                    data_ = merge(state.data_, event.data_.data_),
                ),
            )

            // A FAILED READ IS NOT AN EMPTY SHELF. The rows go and the sentence
            // arrives; an empty `PlacesData` in their place would tell a member
            // they have never been anywhere.
            event.refused != null -> Step(
                state.copy(
                    loading = null,
                    data_ = null,
                    failure = event.refused.failure,
                ),
            )

            // THE MEMBER NAMED A PLACE.
            //
            // No optimistic repaint: `PlacesState` has no pending set (the way
            // `PhotoShelfState` has `selected_asset_ids`), so a name painted
            // here would be a name with nothing to roll it back when the
            // command is denied. The row change the commit causes is what
            // redraws the card.
            event.renamed != null -> {
                val renamed = event.renamed
                if (renamed.place_id.isEmpty() || renamed.name.isBlank()) {
                    // `media.name_place` REFUSES A BLANK NAME, so a blank one is
                    // refused here rather than sent to be refused there: a
                    // round trip whose only possible outcome is a denial is a
                    // round trip that teaches a member nothing.
                    Step(state)
                } else {
                    // THE NAME IS TRIMMED ONCE, and both the input and the key
                    // are built from the same trimmed value. Trimming only one
                    // of them would make "Home" and "Home " two intents that
                    // send one identical command, which is exactly the replay
                    // `invoke_key` exists to collapse.
                    val name = renamed.name.trim()
                    Step(
                        // A NEW ATTEMPT CLEARS THE LAST REFUSAL. Leaving it up
                        // while a second rename is in flight would show a
                        // member a sentence about a write they have already
                        // replaced.
                        state.copy(write_failure = null),
                        listOf(
                            ScreenEffect.SubmitWrite(
                                command = RENAME_COMMAND,
                                inputJson = renameInput(renamed.place_id, name),
                                // THE KEY IS THE INTENT, NOT AN ORDINAL. A
                                // replayed command with the same key must not
                                // re-execute, and naming the same place the
                                // same thing twice IS one intent; naming it
                                // something else is another.
                                invokeKey = "$RENAME_COMMAND:${renamed.place_id}:$name",
                            ),
                        ),
                    )
                }
            }

            // THE WRITE SETTLED.
            //
            // A REFUSAL LANDS ON `write_failure` AND NEVER ON `failure`. The
            // `content` oneof's `failure` is the READ's slot — one of the three
            // states a read can be in — so a denied rename put there would
            // replace the shelf of places the member was renaming FROM with an
            // error about a write that changed nothing. `NoteDraft.save_failure`
            // is the same field for the same reason. The rows are untouched and
            // the views draw the sentence over them.
            //
            // A COMMIT RE-READS, because a rename changes the very column this
            // screen sorts and draws, and a screen that waited for a change
            // event it may never be handed would show the old name until the
            // next open. One read after one commit is not a retry loop.
            event.write_settled != null -> {
                val settled = event.write_settled
                if (settled.committed) {
                    firstLoad(state.copy(write_failure = null))
                } else {
                    val sentence = settled.sentence.ifEmpty { NOT_SAVED }
                    Step(state.copy(write_failure = Reads.refused(sentence)))
                }
            }

            event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

            else -> Step(state)
        }

    /**
     * BOTH PASSES, FROM THE TOP.
     *
     * The data is cleared first so the two arrivals join into a fresh answer
     * rather than onto the previous load's — see [merge], whose per-field join
     * is only correct within one load.
     *
     * **`write_failure` IS NOT CLEARED HERE.** A sync re-read is not an answer
     * to a refused rename, and wiping the sentence because a row moved
     * somewhere else would take it off the screen before the member read it.
     * The three things that do clear it are the ones that make it stale: a
     * fresh open, a new attempt, and a commit.
     */
    private fun firstLoad(state: PlacesState): Step<PlacesState> = Step(
        state.copy(
            loading = Loading(first_load = true),
            failure = null,
            data_ = null,
        ),
        listOf(
            ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null),
            ScreenEffect.ReadPage(ASSETS_SCREEN_ID, afterCursor = null),
        ),
    )

    /**
     * JOIN THE TWO PASSES, FIELD BY FIELD.
     *
     * Each pass answers only what its own table can see, so every field has at
     * most one claimant and the join is "take the side that has an answer". It
     * is deliberately commutative: nothing here depends on which read landed
     * first, which is what makes it safe for a `ScreenReads.arrived` that
     * cannot see the state and therefore cannot say which pass it is.
     *
     * `next_cursor` is the exception worth stating: the counting pass always
     * reports `null` (it does not walk — see [PlacesAssetReads]), so `?:` keeps
     * the `core_place` walk's cursor rather than letting the other pass erase
     * it.
     */
    internal fun merge(existing: PlacesData?, arriving: PlacesData?): PlacesData? {
        if (arriving == null) return existing
        if (existing == null) return arriving.copy(places = sorted(arriving.places))
        val byId = existing.places.associateBy { it.place_id }.toMutableMap()
        arriving.places.forEach { row ->
            val held = byId[row.place_id]
            byId[row.place_id] = if (held == null) row else join(held, row)
        }
        return PlacesData(
            places = sorted(byId.values.toList()),
            next_cursor = arriving.next_cursor ?: existing.next_cursor,
            // The counting pass is the only one that can see this, and it
            // reports 0 when it has not run; `maxOf` is how "no answer" loses
            // to an answer without either side having to say which it is.
            unplaced_count = maxOf(existing.unplaced_count, arriving.unplaced_count),
            // AND THE FLOOR TRAVELS WITH THE NUMBER. `||` for `maxOf`'s reason
            // and with the same commutativity: the places pass never sets it,
            // so a true from the counting pass survives whichever order the
            // two answers land in. Losing it would leave a number that stopped
            // at one page reading as a total.
            unplaced_count_capped =
                existing.unplaced_count_capped || arriving.unplaced_count_capped,
        )
    }

    private fun join(held: PlaceRow, arriving: PlaceRow): PlaceRow = PlaceRow(
        place_id = held.place_id,
        // An empty name is the counting pass saying nothing, never a place
        // called "". [PlacesReads] resolves a readable name or [NO_NAME].
        name = arriving.name.ifEmpty { held.name },
        asset_count = maxOf(held.asset_count, arriving.asset_count),
        asset_count_capped = held.asset_count_capped || arriving.asset_count_capped,
        cover_thumbnail_path = arriving.cover_thumbnail_path ?: held.cover_thumbnail_path,
        // THE PIN TRAVELS AS A TRIPLE. Taking `latitude` from one side and
        // `has_coordinate` from the other is exactly how a row ends up claiming
        // a pin at 0,0.
        latitude = if (arriving.has_coordinate) arriving.latitude else held.latitude,
        longitude = if (arriving.has_coordinate) arriving.longitude else held.longitude,
        has_coordinate = held.has_coordinate || arriving.has_coordinate,
        time_zone = arriving.time_zone.ifEmpty { held.time_zone },
    )

    /**
     * MOST PHOTOGRAPHED FIRST, which is `placeCards`' own order
     * (`places-model.ts`: `sort((a, b) => b.count - a.count)`).
     *
     * The name is the tiebreak and the id is the tiebreak's tiebreak, so the
     * shelf does not reshuffle between two loads that read the same rows — a
     * list whose order is stable only by luck is a list a member loses their
     * place in.
     */
    private fun sorted(rows: List<PlaceRow>): List<PlaceRow> = rows.sortedWith(
        compareByDescending<PlaceRow> { it.asset_count }
            .thenBy { it.name }
            .thenBy { it.place_id },
    )

    /**
     * WHERE A TAP ON A PLACE LANDS.
     *
     * `photos.shelf` with a [PhotoShelf.Place] — the library under a predicate,
     * which is what v0's `PlaceDetail.tsx` was. **The name rides along** so the
     * shelf's head says "The cabin" before its first page returns, which is the
     * whole of law 2's sibling; a shelf that waited for a read would paint under
     * the previous title.
     *
     * Built here rather than in each view, because two shells composing the
     * same value twice is two chances to send a place id with no name.
     */
    public fun shelfFor(row: PlaceRow): PhotoShelf = PhotoShelf(
        place = PhotoShelf.Place(place_id = row.place_id, place_name = row.name),
    )

    /**
     * WHERE A TAP ON "N PHOTOGRAPHS CARRY NO PLACE" LANDS (v0's trailing "No
     * location yet" card, #816): the photographs with no place, as a shelf.
     * Reachable, and NOT counted as a place — which is why it is a flag on
     * [PhotoShelf.Place] and not a row in `places`.
     *
     * Search's no-location door opens this same value, so the two land on one
     * shelf under one name.
     */
    public fun unplacedShelf(): PhotoShelf = PhotoShelf(
        place = PhotoShelf.Place(place_name = NO_LOCATION_NAME, unplaced = true),
    )

    /** v0's `PLACE_NO_LOCATION`, the shelf's name. */
    public const val NO_LOCATION_NAME: String = "No location yet"

    /**
     * THE PLOT, IN A UNIT SQUARE — the whole of what a "map" is here.
     *
     * ## There is no basemap, and that is the decision
     *
     * v0 offered two grounds (`places-map-mode.ts`) and defaulted to real tiles
     * with a disclosure under them: *"The map provider sees which areas you
     * open."* A tile is a network request whose URL is a bounding box, so
     * opening the map tells a stranger's server roughly where a member has
     * photographed. The private ground drew the same pins over a graticule and
     * fetched nothing.
     *
     * This shell draws the private one, and it is the honest port rather than a
     * lesser one: `docs/photos/places.md` is current state on this branch and
     * says *"No surface in this tree draws a map. There is no basemap, no map
     * SDK, and no geometry layer"*, and neither shell links one. **A real-tile
     * map is a separate decision with a privacy cost attached**, not a hole
     * left by this port.
     *
     * ## The arithmetic is here so it is not written twice
     *
     * Equirectangular, normalised to the plotted rows' own bounding box: x
     * grows east, **y grows SOUTH** because both shells' canvases put the origin
     * at the top left, and a plot that forgot that draws every library upside
     * down. A degree of longitude is narrower than a degree of latitude away
     * from the equator and this does not correct for it — the plate is a
     * relative picture, which is why the views draw a north mark and no scale
     * they cannot honour.
     *
     * Rows with no coordinate are DROPPED, never plotted at 0,0: see
     * [PlaceRow.has_coordinate]. A single plotted place, or several at one
     * spot, lands in the middle rather than dividing by a zero span.
     */
    public fun plot(rows: List<PlaceRow>): List<PlacePlot> {
        val pinned = rows.filter { it.has_coordinate }
        if (pinned.isEmpty()) return emptyList()
        val minLat = pinned.minOf { it.latitude }
        val maxLat = pinned.maxOf { it.latitude }
        val minLng = pinned.minOf { it.longitude }
        val maxLng = pinned.maxOf { it.longitude }
        val latSpan = maxLat - minLat
        val lngSpan = maxLng - minLng
        return pinned.map { row ->
            PlacePlot(
                placeId = row.place_id,
                x = if (lngSpan == 0.0) MIDDLE else (row.longitude - minLng) / lngSpan,
                y = if (latSpan == 0.0) MIDDLE else (maxLat - row.latitude) / latSpan,
                count = row.asset_count,
            )
        }
    }

    /** One plotted place: where in the unit square, and how big the pin is. */
    public data class PlacePlot(
        public val placeId: String,
        public val x: Double,
        public val y: Double,
        public val count: Int,
    )

    private const val MIDDLE: Double = 0.5

    /**
     * `media.name_place`'s input.
     *
     * `kind` is deliberately NOT sent. It is optional on the command and it is
     * how the phrase ladder learns which place is Home, so writing one from a
     * rename sheet that never asked would be this screen answering a question
     * the member was not shown.
     *
     * Hand-built for `NotesEditorMachine.saveInput`'s reason: `commonMain`
     * carries no JSON dependency, the shape is two fields, and the escaping is
     * the only hard part.
     */
    internal fun renameInput(placeId: String, name: String): String =
        "{\"place_id\":${jsonString(placeId)},\"name\":${jsonString(name)}}"

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

    /**
     * `core_place` AND `media_asset` — both halves of a card.
     *
     * Two tables on one machine because the screen is a join the door will not
     * do. The keys are handed on for `core_place`, where they genuinely are
     * place ids; for `media_asset` they are asset ids and the event's field is
     * `place_ids`, so they are dropped rather than mislabelled — [reduce]
     * ignores the list either way, for the reason stated there.
     */
    override fun rowsChanged(table: String, keys: List<String>): PlacesEvent? = when (table) {
        PLACES_TABLE -> PlacesEvent(rows_changed = PlacesEvent.RowsChanged(place_ids = keys))
        ASSETS_TABLE -> PlacesEvent(rows_changed = PlacesEvent.RowsChanged())
        else -> null
    }

    internal const val PLACES_TABLE: String = "core_place"
    internal const val ASSETS_TABLE: String = "media_asset"

    override fun seatChanged(seat: SeatState): PlacesEvent =
        PlacesEvent(seat_changed = PlacesEvent.SeatChanged(seat = seat))
}
