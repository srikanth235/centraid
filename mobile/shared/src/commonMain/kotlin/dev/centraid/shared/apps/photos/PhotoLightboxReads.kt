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
import centraid.screen.v1.PhotoPerson
import centraid.screen.v1.PhotoPlaceChoice
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.sync.LinkConditions
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT THE LIGHTBOX READS (#1029, photos port, lane 2).
 *
 * This object is the ASSET — one row of `media_asset`, bound by id — and the
 * screen's writes. [PhotoLightboxLeg] is the other six statements.
 *
 * ## Why this is seven reads and not one
 *
 * **The page door has no join clause.** `PageQuery.select` is rendered as a
 * list of QUOTED IDENTIFIERS (`crates/vault/src/page.rs`: `select.iter().map(quoted)`),
 * so an entry is a real column and can never be `<expression> AS <alias>`; and
 * `from` is one table. The three computed columns the door does offer —
 * `with_held_thumbnail`, `with_note_body`, `with_document_size` — are the only
 * cross-table answers on it, and none of them is a place, a person or a word.
 *
 * So the photograph is assembled from seven statements, each bound to an id it
 * learned from the one before. The machine sequences them; the state is what
 * carries the intermediate ids, which is why [query] takes a state at all.
 *
 * ## The predicate is NOT the library's
 *
 * `PhotosReads` reads `deleted_at IS NULL AND archived_at IS NULL`, because a
 * library that showed archived assets would be showing a member the photos they
 * put away. **The lightbox binds the asset id and nothing else**, deliberately:
 * it is opened from the trash shelf and from the archive as well as from the
 * library, and a predicate that excluded those two would open the trash onto
 * "Centraid could not find this photograph". `archived` and `trashed` ride on
 * the detail instead, so the toolbar can say Unarchive rather than Archive.
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
 *   `PhotoLightboxBridge` asks the byte door by the content id the CONTENT leg
 *   brings, landing the answer as `OriginalLocated`. Nothing here fabricates a
 *   path.
 * - **`camera`.** `media_asset.camera_device_id` is a foreign key into
 *   `access_device`, which is an ACCESS-plane row about a device that has
 *   reached this vault — not a camera model — and `exif_json` is a JSON blob
 *   that a reducer must not parse. Left empty rather than filled with an id: a
 *   member reading `dev-01j…` under "Camera" has been told less than nothing.
 *   The shells read the make and model out of the ORIGINAL's own header once
 *   it is located, which is where a camera wrote them.
 */
public object PhotoLightboxReads :
    ScreenReads<PhotoLightboxState, PhotoLightboxEvent>,
    ScreenWrites<PhotoLightboxState, PhotoLightboxEvent> {
    override val screenId: String = PhotoLightboxMachine.SCREEN_ID

    /** `media_asset`, the same table the machine's `rowsChanged` declares. */
    override val table: String = "media_asset"

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
     * pair is the library's own — `captured_at DESC, asset_id DESC` — so this
     * statement sorts the way every other Photos read sorts.
     */
    override fun query(state: PhotoLightboxState, afterCursor: String?): PageQuery? {
        val assetId = state.asset_id.takeIf { it.isNotEmpty() } ?: return null
        return PageQuery(
            name = "photos.lightbox.asset",
            select = listOf(
                "asset_id",
                "kind",
                "title",
                "captured_at",
                "tz_offset_min",
                "place_id",
                "width",
                "height",
                "duration_s",
                "archived_at",
                "deleted_at",
            ),
            from = table,
            where_ = "asset_id = ?",
            bind = listOf(Value(text = assetId)),
            order = PageOrder(
                sort_column = "captured_at",
                pk_column = "asset_id",
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
            Reads.refused("Centraid could not find this photograph on this device."),
        )
        val kind = PhotosReads.kindOf(row.text(KIND))
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
                    title = row.text(TITLE),
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
                    // FILLED BY THE CONCEPTS LEG, which is the only read that
                    // can see the flags scheme's `starred` notation. A star
                    // guessed here would be one a member never put on a
                    // photograph.
                    favorite = false,
                    // A TIMESTAMP COLUMN IS A BOOLEAN TO THIS SCREEN. The DDL's
                    // own CHECK keeps a row out of both at once
                    // (`archived_at IS NULL OR deleted_at IS NULL`), so these
                    // two are exclusive by construction and not by convention.
                    archived = row.text(ARCHIVED_AT).isNotEmpty(),
                    trashed = row.text(DELETED_AT).isNotEmpty(),
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

    private const val ASSET_ID: Int = 0
    private const val KIND: Int = 1
    private const val TITLE: Int = 2
    private const val CAPTURED_AT: Int = 3
    private const val TZ_OFFSET: Int = 4
    private const val PLACE_ID: Int = 5
    private const val WIDTH: Int = 6
    private const val HEIGHT: Int = 7
    private const val DURATION: Int = 8
    private const val ARCHIVED_AT: Int = 9
    private const val DELETED_AT: Int = 10

    /**
     * The three computed columns, in the order `crates/core`'s `api::page`
     * appends them — after the eleven this statement named. They move together
     * with the `select` list above and nowhere else.
     */
    private const val THUMBNAIL: Int = 11
    private const val ORIGINAL_HASH: Int = 12
    private const val ORIGINAL_HELD: Int = 13

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
     * ambiguous against the `internal` copy `PhotosPeopleReads` already
     * publishes. Inside the object it is unambiguous and unexported.
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
 * ONE OF THE SIX READS THAT ARE NOT THE PHOTOGRAPH ITSELF.
 *
 * A CLASS WITH A LEG RATHER THAN AN OBJECT WITH A PHASE. `ScreenReads` pairs
 * one `query` with one `arrived` under one screen id, and `arrived` is handed
 * rows with no note saying which statement produced them. An object that kept
 * "which leg am I on" in a field would be an object two reads in flight could
 * race, and nothing in `ScreenRuntime` promises to sequence them — it launches
 * each `ReadPage` in its own coroutine. Six instances, six ids, six pairings
 * that cannot come apart.
 *
 * **EVERY ONE OF THESE SETS `DataArrived.amendment`.** It is a flag and not an
 * inference from an empty `asset_id`: `media_face_region` and `core_tag` both
 * carry the asset in a column, so the day a leg projects it the inference would
 * start replacing the photograph with a face region — silently, because both
 * shapes typecheck.
 *
 * **A REFUSED LEG NAMES ITS [PhotoDetail.Part] AND CHANGES NOTHING ELSE.** It
 * used to answer an event the reducer ignored, so "nobody is in this
 * photograph" and "the face read was refused" drew the same empty panel; see
 * [refused].
 */
public class PhotoLightboxLeg internal constructor(
    public val leg: PhotoLightboxMachine.Leg,
) : ScreenReads<PhotoLightboxState, PhotoLightboxEvent> {
    override val screenId: String = PhotoLightboxMachine.readId(leg)

    override val table: String = when (leg) {
        PhotoLightboxMachine.Leg.PLACE -> "core_place"
        PhotoLightboxMachine.Leg.FACES -> "media_face_region"
        PhotoLightboxMachine.Leg.PEOPLE -> "core_party"
        PhotoLightboxMachine.Leg.TAGS -> "core_tag"
        PhotoLightboxMachine.Leg.CONCEPTS -> "core_concept"
        PhotoLightboxMachine.Leg.CONTENT -> "core_content_item"
    }

    /**
     * **THESE ARE CEILINGS, AND A FULL PAGE IS A FLOOR.**
     *
     * There is no `COUNT(*)` on this door, and none of these reads walks: each
     * is bound to one asset's ids, and a photograph with more than thirty-two
     * confirmed faces or sixty-four tags on it is not a page this screen tries
     * to complete. What a full page costs here is a face or a chip that is not
     * drawn — never a wrong number, because the lightbox prints no counts.
     */
    override val limit: Int = when (leg) {
        PhotoLightboxMachine.Leg.PLACE, PhotoLightboxMachine.Leg.CONTENT -> 1
        PhotoLightboxMachine.Leg.FACES, PhotoLightboxMachine.Leg.PEOPLE -> 32
        PhotoLightboxMachine.Leg.TAGS, PhotoLightboxMachine.Leg.CONCEPTS -> 64
    }

    /**
     * The statement, bound to what the photograph on screen already knows.
     *
     * Null whenever it does not know it yet — no place id, no tagged concepts,
     * no content hash — which `ScreenRuntime` turns into a sentence rather than
     * into silence. The machine does not emit these reads before the asset has
     * landed, so a null here means the member moved on mid-read.
     *
     * **SORT AND PRIMARY KEY ARE THE SAME COLUMN** on five of the six. That is
     * `crates/apps/photos`' own idiom for a set read by id
     * (`content_statement`, `concepts_statement`, `custody_statement` all use
     * `PageOrder::asc("content_id", "content_id")`), and it is what keeps these
     * off `captured_at` — the nullable sort key whose CONTINUED page the door
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
                    select = listOf("place_id", "name", "geo_lat", "geo_lng"),
                    from = table,
                    where_ = "place_id = ?",
                    bind = listOf(Value(text = placeId)),
                    order = PageOrder("place_id", "place_id", descending = false),
                )
            }

            // CONFIRMED FACES ONLY, and the proto says why: "a proposal belongs
            // to face review and naming it here would make a guess look like a
            // fact". `party_id IS NOT NULL` is the second half of that — the
            // column is `ON DELETE SET NULL` so a purged person leaves a
            // confirmed region behind with nobody in it.
            PhotoLightboxMachine.Leg.FACES -> PageQuery(
                name = "photos.lightbox.faces",
                select = listOf("region_id", "party_id"),
                from = table,
                where_ = "asset_id = ? AND review_state = ? AND party_id IS NOT NULL",
                bind = listOf(Value(text = assetId), Value(text = CONFIRMED)),
                order = PageOrder("region_id", "region_id", descending = false),
            )

            PhotoLightboxMachine.Leg.PEOPLE -> {
                val ids = detail?.people?.map { it.party_id }?.filter { it.isNotEmpty() }
                    ?: return null
                if (ids.isEmpty()) return null
                PageQuery(
                    name = "photos.lightbox.people",
                    select = listOf("party_id", "display_name"),
                    from = table,
                    // A DELETED PARTY IS NOT A NAME TO DRAW. The row survives
                    // until the purge sweep takes it, and a face labelled with
                    // somebody the member has forgotten is the one thing
                    // "forgetting" was supposed to mean.
                    where_ = inList("party_id", ids.size) + " AND deleted_at IS NULL",
                    bind = ids.map { Value(text = it) },
                    order = PageOrder("party_id", "party_id", descending = false),
                )
            }

            PhotoLightboxMachine.Leg.TAGS -> PageQuery(
                name = "photos.lightbox.tags",
                select = listOf("tag_id", "concept_id", "tagged_by_party_id"),
                from = table,
                where_ = "target_type = ? AND target_id = ?",
                bind = listOf(Value(text = TAG_TARGET_TYPE), Value(text = assetId)),
                order = PageOrder("tag_id", "tag_id", descending = false),
            )

            PhotoLightboxMachine.Leg.CONCEPTS -> {
                val ids = detail?.labels?.map { it.concept_id }?.filter { it.isNotEmpty() }
                    ?: return null
                if (ids.isEmpty()) return null
                PageQuery(
                    name = "photos.lightbox.concepts",
                    select = listOf("concept_id", "pref_label", "notation"),
                    from = table,
                    where_ = inList("concept_id", ids.size),
                    bind = ids.map { Value(text = it) },
                    order = PageOrder("concept_id", "concept_id", descending = false),
                )
            }

            // BY HASH, AND THE HASH IS AN IDENTITY HERE. `PhotoDetail` carries
            // no `content_id`, and `core_content_item.content_hash` is `NOT
            // NULL UNIQUE` — so the hash the thumbnail column already handed
            // this screen addresses exactly one item. `deleted_at IS NULL`
            // because a tombstoned item is not bytes a member has.
            PhotoLightboxMachine.Leg.CONTENT -> {
                val hash = detail?.original_hash?.takeIf { it.isNotEmpty() } ?: return null
                PageQuery(
                    name = "photos.lightbox.content",
                    select = listOf("content_id", "byte_size"),
                    from = table,
                    where_ = "content_hash = ? AND deleted_at IS NULL",
                    bind = listOf(Value(text = hash)),
                    order = PageOrder("content_id", "content_id", descending = false),
                )
            }
        }
    }

    /**
     * The rows, as an AMENDMENT to the photograph on screen.
     *
     * An empty page is a real answer everywhere here — no place row on this
     * device, nobody confirmed in the picture, no tags — and each one folds in
     * as an absence that changes nothing, which is what the machine's `amend`
     * is built to do.
     */
    override fun arrived(rows: List<Row>, nextCursor: String?): PhotoLightboxEvent =
        PhotoLightboxEvent(
            data_ = PhotoLightboxEvent.DataArrived(
                // AN AMENDMENT SAYS SO, and is never inferred from an empty
                // `asset_id`. Two of these legs COULD carry one —
                // `media_face_region` and `core_tag` both have the asset in a
                // column — and a reducer that read absence as "satellite" would
                // start replacing the photograph with a face region the day one
                // of them did. Both shapes typecheck; only one is right.
                amendment = true,
                detail = when (leg) {
                    PhotoLightboxMachine.Leg.PLACE -> PhotoDetail(
                        // WHERE, AS THE VAULT NAMES IT — never a coordinate
                        // formatted into a sentence. `core_place.name` is `NOT
                        // NULL`, so a row means a name.
                        // A PLACE NAME IS NEVER COORDINATE-SHAPED, FOR ANY
                        // INPUT (`docs/photos/places.md`, layer 2).
                        //
                        // `core_place.name` is the RAW column, and a row
                        // minted from a photograph's GPS is literally named
                        // after its own coordinates ("39.0021, -120.1131") —
                        // rung 3 of `find_or_create_place`. Passed through, the
                        // capture stamp printed a member's coordinates over
                        // their own photograph, with no action on their part.
                        // `exact_location` is the ONE function allowed to print
                        // digits and it sits behind an explicit member action;
                        // `printable_name` refuses a coordinate-shaped label at
                        // every rung, and this is that refusal, shared with
                        // `PlacesReads` so the two surfaces cannot disagree
                        // about the same row.
                        //
                        // Empty rather than a stand-in sentence: the stamp
                        // simply omits the place, which is what a photograph
                        // with no readable place has always drawn.
                        place_name = PlacesReads
                            .readableName(rows.firstOrNull()?.text(1).orEmpty())
                            .orEmpty(),
                        // BOTH OR NEITHER. A `REAL` column that is NULL is
                        // absent on the wire, never zero — a coordinate
                        // coerced from nothing is a pin on the equator.
                        place_latitude = rows.firstOrNull()?.real(2) ?: 0.0,
                        place_longitude = rows.firstOrNull()?.real(3) ?: 0.0,
                        place_has_coordinate = rows.firstOrNull()?.let {
                            it.real(2) != null && it.real(3) != null
                        } ?: false,
                    )

                    PhotoLightboxMachine.Leg.FACES -> PhotoDetail(
                        // IDS NOW, NAMES ON THE NEXT HOP. A person with an
                        // empty `display_name` is one this leg found and the
                        // party read has not answered for yet; both views draw
                        // only the named ones, because a party id is not a
                        // person's name.
                        people = rows.map { PhotoPerson(party_id = it.text(1)) }
                            .filter { it.party_id.isNotEmpty() },
                    )

                    PhotoLightboxMachine.Leg.PEOPLE -> PhotoDetail(
                        people = rows.map {
                            PhotoPerson(party_id = it.text(0), display_name = it.text(1))
                        },
                    )

                    PhotoLightboxMachine.Leg.TAGS -> PhotoDetail(
                        labels = rows.map {
                            PhotoLabel(
                                concept_id = it.text(1),
                                // THE EDGE, so a remove takes THIS tag off.
                                tag_id = it.text(0),
                                // WHO PUT IT THERE, STRUCTURALLY. The DDL's own
                                // CHECK is `tagged_by_party_id IS NULL OR
                                // (derivation_id IS NULL AND input_revision_id
                                // IS NULL)` — a member's tag and a derivation's
                                // proposal are mutually exclusive by
                                // construction, so the presence of a tagger IS
                                // the answer. `confidence` deliberately is not
                                // consulted: a derivation at 0.99 is still a
                                // proposal, and a threshold here would be this
                                // shell deciding what the enrichment plane meant.
                                confirmed = it.text(2).isNotEmpty(),
                            )
                        }.filter { it.concept_id.isNotEmpty() },
                    )

                    PhotoLightboxMachine.Leg.CONCEPTS -> concepts(rows)

                    PhotoLightboxMachine.Leg.CONTENT -> PhotoDetail(
                        byte_size = rows.firstOrNull()?.integer(1) ?: 0L,
                        // The id the byte door is asked by — see
                        // `PhotoLightboxReads`' doc on `original_path`.
                        content_id = rows.firstOrNull()?.text(0).orEmpty(),
                    )
                },
            ),
        )

    /**
     * THE STAR IS A TAG, AND THIS IS WHERE IT STOPS BEING ONE.
     *
     * `media.set_favorite` writes a `core_tag` against the flags scheme's
     * `starred` concept (`crates/vault/src/commands/media.rs`, `is_starred`),
     * so a favourite arrives at this screen as one more concept id among the
     * member's own words — and it must not be drawn as a chip saying "starred".
     * A concept notated `starred` turns into [PhotoDetail.favorite] and is left
     * out of the labels.
     *
     * **THE SCHEME IS NOT CHECKED, AND THE GAP IS REAL.** The vault's own
     * `is_starred` joins `core_concept_scheme` and matches its `uri`; this
     * cannot, because a scheme row has nowhere to live — `PhotoDetail` carries
     * no field a scheme could ride in, so there is no way for a fourth leg to
     * hand one to the reducer. The consequence is bounded and stated: a concept
     * in ANOTHER scheme whose notation is the literal word `starred`, tagged on
     * this photograph, would light the heart. `core_concept` is `UNIQUE (scheme_id,
     * notation)`, so that is one extra row in one other scheme, and the WRITE
     * behind the heart still goes through the vault's own scheme-checked
     * command. Closing it properly needs a place to put a scheme id — the
     * root's to decide.
     */
    private fun concepts(rows: List<Row>): PhotoDetail {
        val starred = rows.any { it.text(2) == STARRED_NOTATION }
        return PhotoDetail(
            favorite = starred,
            labels = rows.filterNot { it.text(2) == STARRED_NOTATION }
                .map { PhotoLabel(concept_id = it.text(0), label = it.text(1)) }
                .filter { it.concept_id.isNotEmpty() && it.label.isNotEmpty() },
        )
    }

    /**
     * A SATELLITE READ THAT FAILED IS NOT A PHOTOGRAPH THAT FAILED — AND IT IS
     * NOT SILENCE EITHER.
     *
     * It was, for one draft: an empty event the reducer ignored, so **"nobody
     * is in this photograph" and "the face read was refused" drew the same
     * empty panel.** That is the two-empty-cell-sentences defect one level up,
     * and the fix is the same one — say which absence this is.
     *
     * So the refusal lands as an ordinary AMENDMENT carrying nothing but this
     * leg's [PhotoDetail.Part]. The photograph, the toolbar and everything the
     * other legs answered stay exactly where they are; one section of the info
     * sheet says it could not be read.
     *
     * The `ReadFailure`'s own sentence is dropped here on purpose. A refusal
     * per part would put up to four vault sentences in a facts panel, and what
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
     * Six legs, four parts: [PhotoLightboxMachine.Leg.FACES] and
     * [PhotoLightboxMachine.Leg.PEOPLE] are two hops at ONE answer — who is in
     * it — and so are [PhotoLightboxMachine.Leg.TAGS] and
     * [PhotoLightboxMachine.Leg.CONCEPTS]. A member reading "Centraid could not
     * read who is in this photograph" does not need to know which of the two
     * reads it was, and a part per hop would be the plumbing showing through.
     */
    public val part: PhotoDetail.Part = when (leg) {
        PhotoLightboxMachine.Leg.PLACE -> PhotoDetail.Part.PART_PLACE
        PhotoLightboxMachine.Leg.FACES, PhotoLightboxMachine.Leg.PEOPLE ->
            PhotoDetail.Part.PART_PEOPLE
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
        /** `media_face_region.review_state`'s own value. */
        const val CONFIRMED: String = "confirmed"

        /** `crates/apps/photos`' `TAG_TARGET_TYPE`, spelled the same. */
        const val TAG_TARGET_TYPE: String = "media.asset"

        /** `crates/apps/photos`' `STARRED_NOTATION`. */
        const val STARRED_NOTATION: String = "starred"

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
        PhotoLightboxMachine.Side.FILM, PhotoLightboxMachine.Side.LIVE -> "media_asset"
        PhotoLightboxMachine.Side.PLACES -> "core_place"
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
                        select = listOf("asset_id", "kind", "captured_at"),
                        from = table,
                        where_ = "asset_id IN (" + ids.joinToString(", ") { "?" } + ")",
                        bind = ids.map { Value(text = it) },
                        order = PageOrder("asset_id", "asset_id", descending = false),
                        // The grid's own three computed columns, so a frame
                        // draws what its cell draws.
                        with_held_thumbnail = true,
                    )
                }
            }

            PhotoLightboxMachine.Side.PLACES -> PageQuery(
                name = "photos.lightbox.places",
                select = listOf("place_id", "name"),
                from = table,
                order = PageOrder("place_id", "place_id", descending = false),
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
                        select = listOf("asset_id", "content_id", "kind"),
                        from = table,
                        where_ = "capture_group_id = (SELECT capture_group_id FROM media_asset " +
                            "WHERE asset_id = ?) AND deleted_at IS NULL",
                        bind = listOf(Value(text = assetId)),
                        order = PageOrder("asset_id", "asset_id", descending = false),
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
        PhotoLightboxMachine.Side.LIVE -> {
            val stills = rows.filter { it.text(2) == "photo" }
            val movies = rows.filter { it.text(2) == "video" }
            val still = stills.singleOrNull()
            val movie = movies.singleOrNull()
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
