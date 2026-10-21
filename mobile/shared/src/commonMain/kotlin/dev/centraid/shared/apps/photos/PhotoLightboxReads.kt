package dev.centraid.shared.apps.photos

import centraid.core.v1.CommandStatus
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoDetail
import centraid.screen.v1.PhotoLabel
import centraid.screen.v1.PhotoLightboxEvent
import centraid.screen.v1.PhotoLightboxState
import centraid.screen.v1.PhotoPlaceChoice
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.sync.LinkConditions
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT THE LIGHTBOX READS (#1029, photos port, lane 2; #1135).
 *
 * This object is the PHOTOGRAPH — one row of `photo`, bound by id — and the
 * screen's writes. [PhotoLightboxLeg] is the other four statements.
 *
 * ## Why this is five reads and not one
 *
 * **The page door has no join clause.** `PageQuery.select` is rendered as a
 * list of QUOTED IDENTIFIERS (`crates/vault/src/page.rs`: `select.iter().map(quoted)`),
 * so an entry is a real column and can never be `<expression> AS <alias>`; and
 * `from` is one table. The three computed columns the door does offer —
 * `with_held_thumbnail`, `with_note_body`, `with_document_size` — are the only
 * cross-table answers on it, and none of them is a place or a word.
 *
 * A photograph is several tables in the model: its bytes, size and capture are
 * the `photo` row; its title and its trash are its `entity`; a star, the
 * archive and its labels are `tagged` edges; its place is a `place` row and its
 * name another entity's. So the photograph is assembled from five statements,
 * each bound to an id it learned from the one before. The machine sequences
 * them; the state is what carries the intermediate ids, which is why [query]
 * takes a state at all.
 *
 * ## The predicate is NOT the library's
 *
 * `PhotosReads` reads the live, unarchived, unfolded photographs, because a
 * library that showed archived photographs would be showing a member the photos
 * they put away. **The lightbox binds the photograph id and nothing else**,
 * deliberately: it is opened from the trash shelf and from the archive as well
 * as from the library, and a predicate that excluded those two would open the
 * trash onto "Centraid could not find this photograph". `archived` and `trashed`
 * ride on the detail instead (the edge leg and the entity leg answer them), so
 * the toolbar can say Unarchive rather than Archive.
 *
 * ## What this read CANNOT answer, and does not pretend to
 *
 * - **`original_path`.** The door's `with_held_thumbnail` resolves the DRAWABLE
 *   hash to a path — a `thumb` derivative when the vault has one, and the
 *   original's own bytes when it does not — and a caller cannot tell which it
 *   got. `original_held` is a 1/0 beside it and, as its own comment in
 *   `page.rs` says, "this column hands out no path". The path of the original
 *   is only reachable through the BYTE door (`api::content_urls` →
 *   `Vault::content_location`), so this read leaves it ABSENT and
 *   `PhotoLightboxBridge` asks the byte door by the blob hash the CONTENT leg
 *   brings, landing the answer as `OriginalLocated`. Nothing here fabricates a
 *   path.
 * - **`camera`.** No column of `photo` names a camera model, and `exif` is a
 *   JSON blob that a reducer must not parse. Left empty rather than guessed.
 *   The shells read the make and model out of the ORIGINAL's own header once
 *   it is located, which is where a camera wrote them.
 */
public object PhotoLightboxReads :
    ScreenReads<PhotoLightboxState, PhotoLightboxEvent>,
    ScreenWrites<PhotoLightboxState, PhotoLightboxEvent> {
    override val screenId: String = PhotoLightboxMachine.SCREEN_ID

    /** `photo`, the table the machine's `rowsChanged` answers in photograph ids for. */
    override val table: String = "photo"

    /** One photograph. The lightbox is open on exactly one. */
    override val limit: Int = 1

    /**
     * The asset this lightbox opened on, or null before it knows.
     *
     * The id comes off the STATE, where `Opened` put it — `ScreenHost`
     * publishes the state before it emits the same reduce's effects, so by the
     * time this is asked the id is there. Null when it is not, which
     * `ScreenRuntime` turns into a sentence rather than into silence.
     *
     * **The order columns are still selected and the order is still stated** on
     * a read that can return at most one row, for `NotesReads`' reason: the
     * door reads the cursor off the row by the two columns the `ORDER BY`
     * names, there is no `key_of` callback, and a statement that dropped them
     * because "it is only one row" breaks the moment its predicate widens. The
     * pair is the library's own — `taken_at DESC, id DESC` — so this
     * statement sorts the way every other Photos read sorts.
     */
    override fun query(state: PhotoLightboxState, afterCursor: String?): PageQuery? {
        val assetId = state.asset_id.takeIf { it.isNotEmpty() } ?: return null
        return PageQuery(
            name = "photos.lightbox.asset",
            select = listOf(
                "id",
                "form",
                "taken_at",
                "offset_min",
                "place_id",
                "width",
                "height",
                "duration_s",
            ),
            from = table,
            where_ = "id = ?",
            bind = listOf(Value(text = assetId)),
            order = PageOrder(
                sort_column = "taken_at",
                pk_column = "id",
                descending = true,
            ),
            // THE SAME THREE COMPUTED COLUMNS THE GRID ASKS FOR, and for the
            // same reason the proto gives: "the download arrow is the same
            // affordance in both places and a second derivation of it would be
            // a second answer". `PhotosReads.heldOf` IS that derivation, and
            // this read calls it rather than restating it.
            with_held_thumbnail = true,
        )
    }

    /**
     * The photograph, or the refusal an asset that is not there deserves.
     *
     * **AN EMPTY PAGE IS NOT AN EMPTY PHOTOGRAPH.** An empty grid is a real
     * answer — the member has no photographs — but a LIGHTBOX with no row is a
     * lightbox over an asset that was purged, or never reached this device, and
     * a black stage with a disabled toolbar would invite a member to try verbs
     * against something that does not exist.
     */
    override fun arrived(rows: List<Row>, nextCursor: String?): PhotoLightboxEvent {
        val row = rows.firstOrNull() ?: return refused(
            Reads.refused("Centraid could not find this photo on this phone."),
        )
        val kind = PhotosReads.kindOf(row.text(FORM))
        return PhotoLightboxEvent(
            data_ = PhotoLightboxEvent.DataArrived(
                // NOT an amendment: this read REPLACES the photograph, which is
                // what makes a re-read after a write honest — a favourite the
                // member just removed must not survive because a previous leg's
                // answer was carried forward.
                amendment = false,
                detail = PhotoDetail(
                    asset_id = row.text(ASSET_ID),
                    thumbnail_path = row.text(THUMBNAIL).ifEmpty { null },
                    // ABSENT FROM THIS READ. See this object's own doc: the
                    // byte door answers for the original's path, and the
                    // bridge asks it.
                    original_path = null,
                    // THE TITLE, THE TRASH, THE STAR AND THE ARCHIVE ARE NOT THIS
                    // ROW'S: the entity leg and the edge leg answer them.
                    title = "",
                    captured_at = row.text(CAPTURED_AT),
                    // A CAPTURE-LOCAL OFFSET, NOT THE READER'S. `tz_offset_min`
                    // is nullable and a missing offset reads as zero, so a
                    // photograph whose day cannot be told is shown in UTC rather
                    // than in the phone's zone — which would silently move it a
                    // day for a traveller.
                    captured_utc_offset_minutes = row.integer(TZ_OFFSET).toInt(),
                    kind = kind,
                    held = PhotosReads.heldOf(
                        thumbnail = row.text(THUMBNAIL).isNotEmpty(),
                        originalHeld = row.integer(ORIGINAL_HELD) > 0L,
                        originalHash = row.text(ORIGINAL_HASH),
                        kind = kind,
                        rule = LinkConditions.rule,
                        metered = LinkConditions.metered,
                    ),
                    original_hash = row.text(ORIGINAL_HASH),
                    // FILLED BY THE TAGS LEG, which is the only read that can see
                    // the `starred` flag's edge. A star guessed here would be one
                    // a member never put on a photograph.
                    favorite = false,
                    // THE ARCHIVE IS A FLAG EDGE AND THE TRASH THE ENTITY'S
                    // STAMP: the tags leg and the entities leg say which, and
                    // both reset here with the rest of the detail.
                    archived = false,
                    trashed = false,
                    width = row.integer(WIDTH).toInt(),
                    height = row.integer(HEIGHT).toInt(),
                    // `duration_s` IS `REAL` IN THE DDL, so it arrives on the
                    // real arm of the value oneof. Read as an integer it comes
                    // back zero and every video in the vault is a still.
                    duration_seconds = row.real(DURATION).toInt(),
                    byte_size = 0L,
                    place_id = row.text(PLACE_ID),
                    place_name = "",
                    // See this object's doc: an access-plane device id is not a
                    // camera, and EXIF is not a reducer's to parse.
                    camera = "",
                ),
            ),
        )
    }

    override fun refused(failure: ReadFailure): PhotoLightboxEvent =
        PhotoLightboxEvent(refused = PhotoLightboxEvent.ReadRefused(failure = failure))

    /** A tapped original's fetch, settled (#1080). */
    override fun fetchSettled(assetId: String, fetched: Boolean, sentence: String): PhotoLightboxEvent =
        PhotoLightboxEvent(
            fetch_settled = PhotoLightboxEvent.FetchSettled(asset_id = assetId, fetched = fetched, sentence = sentence),
        )

    private const val ASSET_ID: Int = 0
    private const val FORM: Int = 1
    private const val CAPTURED_AT: Int = 2
    private const val TZ_OFFSET: Int = 3
    private const val PLACE_ID: Int = 4
    private const val WIDTH: Int = 5
    private const val HEIGHT: Int = 6
    private const val DURATION: Int = 7

    /**
     * The three computed columns, in the order `crates/core`'s `api::page`
     * appends them — after the eight this statement named. They move together
     * with the `select` list above and nowhere else.
     */
    private const val THUMBNAIL: Int = 8
    private const val ORIGINAL_HASH: Int = 9
    private const val ORIGINAL_HELD: Int = 10

    override val appId: String = "photos"

    /**
     * The write's outcome, as the lightbox's own settle event.
     *
     * Only `EXECUTED` is committed. `QUEUED`, `IN_FLIGHT` and `PARKED` all mean
     * "somewhere durable, not yet committed", and calling one of them a commit
     * would be the shell claiming a star that is not on the photograph yet.
     *
     * The sentence is carried faithfully and then has nowhere to go — see
     * `PhotoLightboxMachine.WRITE_SENTENCE_HAS_NO_HOME`. It is passed anyway
     * rather than dropped here, so that the day the state grows a slot this
     * file needs no edit.
     */
    /**
     * Positional, as the door states. See `HomeReads.text` for why only TEXT.
     *
     * A MEMBER AND NOT A TOP-LEVEL EXTENSION: every reads object in this
     * package needs the same three lines, and a file-level one would be
     * ambiguous between them. Inside the object it is unambiguous and
     * unexported.
     */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    private fun Row.integer(index: Int): Long = values.getOrNull(index)?.integer ?: 0L

    /** `REAL` columns arrive on their own arm; as an integer they read zero. */
    private fun Row.real(index: Int): Double = values.getOrNull(index)?.real ?: 0.0

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): PhotoLightboxEvent =
        PhotoLightboxEvent(
            write_settled = PhotoLightboxEvent.WriteSettled(
                committed = status == CommandStatus.COMMAND_STATUS_EXECUTED,
                sentence = sentence,
            ),
        )
}

/**
 * ONE OF THE FOUR READS THAT ARE NOT THE PHOTOGRAPH ITSELF.
 *
 * A CLASS WITH A LEG RATHER THAN AN OBJECT WITH A PHASE. `ScreenReads` pairs
 * one `query` with one `arrived` under one screen id, and `arrived` is handed
 * rows with no note saying which statement produced them. An object that kept
 * "which leg am I on" in a field would be an object two reads in flight could
 * race, and nothing in `ScreenRuntime` promises to sequence them — it launches
 * each `ReadPage` in its own coroutine. Four instances, four ids, four pairings
 * that cannot come apart.
 *
 * **EVERY ONE OF THESE SETS `DataArrived.amendment`.** It is a flag and not an
 * inference from an empty `asset_id`: an `edge` carries the photograph in a column,
 * so the day a leg projects it the inference would start replacing the
 * photograph with a tag — silently, because both shapes typecheck.
 *
 * **A REFUSED LEG NAMES ITS [PhotoDetail.Part] AND CHANGES NOTHING ELSE.** It
 * used to answer an event the reducer ignored, so "no label is on this
 * photograph" and "the tag read was refused" drew the same empty panel; see
 * [refused].
 */
public class PhotoLightboxLeg internal constructor(
    public val leg: PhotoLightboxMachine.Leg,
) : ScreenReads<PhotoLightboxState, PhotoLightboxEvent> {
    override val screenId: String = PhotoLightboxMachine.readId(leg)

    override val table: String = when (leg) {
        PhotoLightboxMachine.Leg.PLACE -> "place"
        PhotoLightboxMachine.Leg.TAGS -> "edge"
        PhotoLightboxMachine.Leg.CONCEPTS -> "entity"
        PhotoLightboxMachine.Leg.CONTENT -> "blob"
    }

    /**
     * **THESE ARE CEILINGS, AND A FULL PAGE IS A FLOOR.**
     *
     * There is no `COUNT(*)` on this door, and none of these reads walks: each
     * is bound to one asset's ids, and a photograph with more than sixty-four
     * tags on it is not a page this screen tries to complete. What a full page
     * costs here is a chip that is not drawn — never a wrong number, because the
     * lightbox prints no counts.
     */
    override val limit: Int = when (leg) {
        PhotoLightboxMachine.Leg.PLACE, PhotoLightboxMachine.Leg.CONTENT -> 1
        PhotoLightboxMachine.Leg.TAGS -> 64
        // THE PHOTOGRAPH'S OWN ENTITY, ITS PLACE'S, AND ONE PER TAG.
        PhotoLightboxMachine.Leg.CONCEPTS -> 66
    }

    /**
     * The statement, bound to what the photograph on screen already knows.
     *
     * Null whenever it does not know it yet — no place id, no tagged concepts,
     * no content hash — which `ScreenRuntime` turns into a sentence rather than
     * into silence. The machine does not emit these reads before the asset has
     * landed, so a null here means the member moved on mid-read.
     *
     * **SORT AND PRIMARY KEY ARE THE SAME COLUMN** on three of the four, and the
     * edge leg's are its two ends (`to_id`, `from_id`: an edge has no id of its
     * own, and one photograph has one edge to each thing). That is
     * `crates/apps/photos`' own idiom for a set read by id, and it is what keeps
     * these off `taken_at` — the nullable sort key whose CONTINUED page the door
     * refuses. None of these walks, so none of them can hit that.
     */
    override fun query(state: PhotoLightboxState, afterCursor: String?): PageQuery? {
        val detail = state.detail
        val assetId = state.asset_id.takeIf { it.isNotEmpty() } ?: return null
        return when (leg) {
            PhotoLightboxMachine.Leg.PLACE -> {
                val placeId = detail?.place_id?.takeIf { it.isNotEmpty() } ?: return null
                PageQuery(
                    name = "photos.lightbox.place",
                    // THE COORDINATE RIDES ALONG FOR "Copy exact location"
                    // ONLY — it is never printed (`docs/photos/places.md`).
                    select = listOf("id", "lat", "lon"),
                    from = table,
                    where_ = "id = ?",
                    bind = listOf(Value(text = placeId)),
                    order = PageOrder("id", "id", descending = false),
                )
            }

            // WHAT IS `tagged` ON THIS PHOTOGRAPH: its labels (tag entities) and
            // its two flags, the star and the archive.
            PhotoLightboxMachine.Leg.TAGS -> PageQuery(
                name = "photos.lightbox.tags",
                select = listOf("to_id", "from_id"),
                from = table,
                where_ = "from_id = ? AND rel = 'tagged'",
                bind = listOf(Value(text = assetId)),
                order = PageOrder("to_id", "from_id", descending = false),
            )

            // THE WORDS AND THE TRASH: the photograph's own entity (its title and
            // its trash stamp), its place's (the name) and each label's (its
            // word), in one statement bound to every id the photograph knows.
            PhotoLightboxMachine.Leg.CONCEPTS -> {
                val ids = buildList {
                    add(assetId)
                    detail?.place_id?.takeIf { it.isNotEmpty() }?.let { add(it) }
                    detail?.labels?.map { it.concept_id }?.filter { it.isNotEmpty() }?.let { addAll(it) }
                }.distinct()
                PageQuery(
                    name = "photos.lightbox.entities",
                    select = listOf("id", "title", "kind", "deleted_at"),
                    from = table,
                    where_ = inList("id", ids.size),
                    bind = ids.map { Value(text = it) },
                    order = PageOrder("id", "id", descending = false),
                )
            }

            // BY HASH, AND THE HASH IS AN IDENTITY HERE: `blob.hash` is the key,
            // and the thumbnail column already handed this screen the original's.
            PhotoLightboxMachine.Leg.CONTENT -> {
                val hash = detail?.original_hash?.takeIf { it.isNotEmpty() } ?: return null
                PageQuery(
                    name = "photos.lightbox.content",
                    select = listOf("hash", "size"),
                    from = table,
                    where_ = "hash = ?",
                    bind = listOf(Value(text = hash)),
                    order = PageOrder("hash", "hash", descending = false),
                )
            }
        }
    }

    /**
     * The rows, as an AMENDMENT to the photograph on screen.
     *
     * An empty page is a real answer everywhere here — no place row on this
     * device, no tags — and each one folds in
     * as an absence that changes nothing, which is what the machine's `amend`
     * is built to do.
     */
    override fun arrived(rows: List<Row>, nextCursor: String?): PhotoLightboxEvent =
        PhotoLightboxEvent(
            data_ = PhotoLightboxEvent.DataArrived(
                // AN AMENDMENT SAYS SO, and is never inferred from an empty
                // `asset_id`. an `edge` COULD carry one — it has the photograph in a
                // column — and a reducer that read absence as "satellite" would
                // start replacing the photograph with a tag the day it did.
                // Both shapes typecheck; only one is right.
                amendment = true,
                detail = when (leg) {
                    // BOTH OR NEITHER. A `REAL` column that is NULL is absent on
                    // the wire, never zero — a coordinate coerced from nothing is
                    // a pin on the equator. The NAME is the entities leg's.
                    PhotoLightboxMachine.Leg.PLACE -> PhotoDetail(
                        place_latitude = rows.firstOrNull()?.real(1) ?: 0.0,
                        place_longitude = rows.firstOrNull()?.real(2) ?: 0.0,
                        place_has_coordinate = rows.firstOrNull()?.let {
                            it.real(1) != null && it.real(2) != null
                        } ?: false,
                    )

                    PhotoLightboxMachine.Leg.TAGS -> tags(rows)

                    PhotoLightboxMachine.Leg.CONCEPTS -> entities(rows)

                    PhotoLightboxMachine.Leg.CONTENT -> PhotoDetail(
                        byte_size = rows.firstOrNull()?.integer(1) ?: 0L,
                        // The id the byte door is asked by — the blob's hash; see
                        // `PhotoLightboxReads`' doc on `original_path`.
                        content_id = rows.firstOrNull()?.text(0).orEmpty(),
                    )
                },
            ),
        )

    /**
     * WHAT IS `tagged` ON THE PHOTOGRAPH: the star and the archive are the two
     * FLAGS, and every other target is a label.
     *
     * A flag is an entity of its own (`flag:starred`, `flag:archived`) and is
     * drawn as a button, never as a chip saying "starred": the star becomes
     * [PhotoDetail.favorite] and the archive [PhotoDetail.archived], and neither
     * is left in the labels. A label is a tag entity, and its id is both the
     * edge a remove names and the key its word is read by.
     */
    private fun tags(rows: List<Row>): PhotoDetail {
        val targets = rows.map { it.text(0) }.filter { it.isNotEmpty() }
        return PhotoDetail(
            favorite = STARRED_FLAG in targets,
            archived = ARCHIVED_FLAG in targets,
            labels = targets.filterNot { it.startsWith(FLAG_PREFIX) }.map {
                // A MEMBER'S OWN WORD: the model keeps no proposal in a tag.
                PhotoLabel(concept_id = it, tag_id = it, confirmed = true)
            },
        )
    }

    /**
     * THE WORDS AND THE TRASH, off the entities the photograph names: its own
     * (the title, and the trash stamp), its place's (the name, never
     * coordinate-shaped) and each label's (the word).
     */
    private fun entities(rows: List<Row>): PhotoDetail {
        val own = rows.firstOrNull { it.text(KIND_COLUMN) == PhotoWrites.PHOTO_KIND }
        val place = rows.firstOrNull { it.text(KIND_COLUMN) == PLACE_KIND }
        return PhotoDetail(
            title = own?.text(1).orEmpty(),
            trashed = own?.text(DELETED_COLUMN)?.isNotEmpty() ?: false,
            // A PLACE NAME IS NEVER COORDINATE-SHAPED, FOR ANY INPUT
            // (`docs/photos/places.md`, layer 2). A place minted from a
            // photograph's GPS is titled after its own coordinates until a member
            // names it, and `readableName` refuses one at every rung; the stamp
            // simply omits the place, which is what a photograph with no readable
            // place has always drawn.
            place_name = place?.text(1)?.let { PlacesReads.readableName(it) }.orEmpty(),
            labels = rows.filter { it.text(KIND_COLUMN) == TAG_KIND }
                .map { PhotoLabel(concept_id = it.text(0), label = it.text(1)) }
                .filter { it.concept_id.isNotEmpty() && it.label.isNotEmpty() },
        )
    }

    /**
     * A SATELLITE READ THAT FAILED IS NOT A PHOTOGRAPH THAT FAILED — AND IT IS
     * NOT SILENCE EITHER.
     *
     * It was, for one draft: an empty event the reducer ignored, so **"no label
     * is on this photograph" and "the tag read was refused" drew the same
     * empty panel.** That is the two-empty-cell-sentences defect one level up,
     * and the fix is the same one — say which absence this is.
     *
     * So the refusal lands as an ordinary AMENDMENT carrying nothing but this
     * leg's [PhotoDetail.Part]. The photograph, the toolbar and everything the
     * other legs answered stay exactly where they are; one section of the info
     * sheet says it could not be read.
     *
     * The `ReadFailure`'s own sentence is dropped here on purpose. A refusal
     * per part would put up to three vault sentences in a facts panel, and what
     * a member needs is WHICH PART — the read law's sentence belongs to the
     * read that can fail the screen, which is the asset's.
     */
    override fun refused(failure: ReadFailure): PhotoLightboxEvent = PhotoLightboxEvent(
        data_ = PhotoLightboxEvent.DataArrived(
            amendment = true,
            detail = PhotoDetail(unread_parts = listOf(part)),
        ),
    )

    /**
     * WHICH PART OF THE PHOTOGRAPH THIS LEG SPEAKS FOR.
     *
     * Four legs, three parts: [PhotoLightboxMachine.Leg.TAGS] and
     * [PhotoLightboxMachine.Leg.CONCEPTS] are two hops at ONE answer — which
     * labels it carries. A member reading that Centraid could not read them
     * does not need to know which of the two reads it was, and a part per hop
     * would be the plumbing showing through.
     */
    public val part: PhotoDetail.Part = when (leg) {
        PhotoLightboxMachine.Leg.PLACE -> PhotoDetail.Part.PART_PLACE
        PhotoLightboxMachine.Leg.TAGS, PhotoLightboxMachine.Leg.CONCEPTS ->
            PhotoDetail.Part.PART_LABELS
        PhotoLightboxMachine.Leg.CONTENT -> PhotoDetail.Part.PART_CONTENT
    }

    /** Positional, as the door states; a member for [PhotoLightboxReads]' reason. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    private fun Row.integer(index: Int): Long = values.getOrNull(index)?.integer ?: 0L

    /** `REAL`, or null when the column is NULL — never a coerced zero. */
    private fun Row.real(index: Int): Double? = values.getOrNull(index)?.real

    private companion object {
        /** The flags a photograph carries, as the entities the `tagged` edges point at. */
        const val FLAG_PREFIX: String = "flag:"
        const val STARRED_FLAG: String = "flag:starred"
        const val ARCHIVED_FLAG: String = "flag:archived"

        /** The entities leg's columns and the kinds it tells apart. */
        const val KIND_COLUMN: Int = 2
        const val DELETED_COLUMN: Int = 3
        const val PLACE_KIND: String = "place"
        const val TAG_KIND: String = "tag"

        /**
         * `column IN (?, ?, ?)`, with a placeholder per bind.
         *
         * The desktop's `in_list` for the same job. The COUNT comes from the
         * caller's own list and no value is ever interpolated — the only thing
         * that reaches the predicate text is a number of question marks, which
         * is what keeps a statement built here from being a statement a value
         * can change.
         */
        fun inList(column: String, count: Int): String =
            column + " IN (" + List(count) { "?" }.joinToString(", ") + ")"
    }
}

/**
 * ONE OF THE READS THAT ARE ABOUT THE SCREEN AROUND THE PHOTOGRAPH, not about
 * the photograph (`PhotoLightboxMachine.Side`).
 *
 * The same shape as [PhotoLightboxLeg] — one statement, one screen id, one
 * pairing that cannot come apart — and a different answer: each of these lands
 * on its OWN event arm, never as an amendment to the detail, because none of
 * them is a fact about the asset on screen. A filmstrip frame is a fact about
 * its neighbour, a place choice about the vault, and a Live Photo's movie is a
 * second asset.
 */
public class PhotoLightboxSideRead internal constructor(
    public val side: PhotoLightboxMachine.Side,
) : ScreenReads<PhotoLightboxState, PhotoLightboxEvent> {
    override val screenId: String = PhotoLightboxMachine.readId(side)

    override val table: String = when (side) {
        PhotoLightboxMachine.Side.FILM, PhotoLightboxMachine.Side.LIVE -> "photo"
        // A PLACE'S NAME IS ITS ENTITY'S TITLE.
        PhotoLightboxMachine.Side.PLACES -> "entity"
    }

    /**
     * A window of the strip; the door's own ceiling for places, which are
     * read to be scanned and not walked (`PlacesReads.limit`'s reason); and a
     * capture group, which is a still and its movie and nothing larger.
     */
    override val limit: Int = when (side) {
        PhotoLightboxMachine.Side.FILM -> PhotoLightboxMachine.FILM_REACH * 2 + 1
        PhotoLightboxMachine.Side.PLACES -> 500
        PhotoLightboxMachine.Side.LIVE -> 8
    }

    override fun query(state: PhotoLightboxState, afterCursor: String?): PageQuery? =
        when (side) {
            // THE WINDOW'S MISSING FRAMES, bound by id. The trash and the
            // archive are NOT excluded: a strip opened from the trash shelf
            // shows the trash, which is the shelf's order and not this read's.
            PhotoLightboxMachine.Side.FILM -> {
                val ids = PhotoLightboxMachine.filmMissing(state)
                if (ids.isEmpty()) {
                    null
                } else {
                    PageQuery(
                        name = "photos.lightbox.film",
                        select = listOf("id", "form", "taken_at"),
                        from = table,
                        where_ = "id IN (" + ids.joinToString(", ") { "?" } + ")",
                        bind = ids.map { Value(text = it) },
                        order = PageOrder("id", "id", descending = false),
                        // The grid's own three computed columns, so a frame
                        // draws what its cell draws.
                        with_held_thumbnail = true,
                    )
                }
            }

            PhotoLightboxMachine.Side.PLACES -> PageQuery(
                name = "photos.lightbox.places",
                select = listOf("id", "title"),
                from = table,
                where_ = "kind = 'place' AND deleted_at IS NULL",
                order = PageOrder("id", "id", descending = false),
            )

            // THE WHOLE CAPTURE GROUP, THE STILL INCLUDED. The answer then
            // names the still it is about, so a movie read for a photograph the
            // member has swiped past lands on nothing rather than on the next
            // one. A still with no group binds `= NULL`, which matches nothing:
            // no movie, honestly.
            PhotoLightboxMachine.Side.LIVE -> {
                val assetId = state.asset_id.takeIf { it.isNotEmpty() }
                if (assetId == null || state.detail == null) {
                    null
                } else {
                    PageQuery(
                        name = "photos.lightbox.live",
                        select = listOf("id", "blob", "form"),
                        from = table,
                        where_ = "burst = (SELECT burst FROM photo WHERE id = ?) AND ${PhotoFold.NOT_TRASHED}",
                        bind = listOf(Value(text = assetId)),
                        order = PageOrder("id", "id", descending = false),
                    )
                }
            }
        }

    override fun arrived(rows: List<Row>, nextCursor: String?): PhotoLightboxEvent = when (side) {
        PhotoLightboxMachine.Side.FILM -> PhotoLightboxEvent(
            film = PhotoLightboxEvent.FilmArrived(
                frames = rows.map { row ->
                    PhotoCell(
                        asset_id = row.text(0),
                        kind = PhotosReads.kindOf(row.text(1)),
                        captured_at = row.text(2),
                        // THE DOOR APPENDS its three after the three named.
                        thumbnail_path = row.text(3).ifEmpty { null },
                        original_hash = row.text(4),
                    )
                }.filter { it.asset_id.isNotEmpty() },
            ),
        )

        // A COORDINATE-SHAPED NAME IS NEVER A NAME (`PlacesReads.readableName`),
        // so a place minted from a GPS fix reads as the unnamed place it is.
        PhotoLightboxMachine.Side.PLACES -> PhotoLightboxEvent(
            place_choices = PhotoLightboxEvent.PlaceChoicesArrived(
                places = rows.map { row ->
                    PhotoPlaceChoice(
                        place_id = row.text(0),
                        name = PlacesReads.readableName(row.text(1)) ?: PlacesMachine.NO_NAME,
                    )
                }.filter { it.place_id.isNotEmpty() },
            ),
        )

        // A LIVE PHOTO IS ONE STILL AND ONE MOVIE in a group. Anything else —
        // a burst of stills, a group of one — is not one, and answers empty.
        // An EDITED Live Photo has two stills and may have two movies, one per
        // version of the capture (A20): the newest of each is the one drawn.
        PhotoLightboxMachine.Side.LIVE -> {
            // THE NEWEST, BY ID: an id is minted in time order.
            val still = rows.filter { it.text(2) == "photo" }.maxByOrNull { it.text(0) }
            val movie = rows.filter { it.text(2) == "video" }.maxByOrNull { it.text(0) }
            PhotoLightboxEvent(
                live = PhotoLightboxEvent.LiveArrived(
                    asset_id = if (still != null && movie != null) still.text(0) else "",
                    live_asset_id = movie?.text(0).orEmpty(),
                    live_content_id = movie?.text(1).orEmpty(),
                ),
            )
        }
    }

    /**
     * A SIDE READ THAT FAILED TAKES NOTHING WITH IT. An empty strip, an
     * empty list of places and no movie are each a screen that still works,
     * and none of them is a sentence about the photograph.
     */
    override fun refused(failure: ReadFailure): PhotoLightboxEvent = arrived(emptyList(), null)

    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""
}
