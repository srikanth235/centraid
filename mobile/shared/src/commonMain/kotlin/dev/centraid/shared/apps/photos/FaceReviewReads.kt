package dev.centraid.shared.apps.photos

import centraid.core.v1.CommandStatus
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.FaceCandidate
import centraid.screen.v1.FaceReviewData
import centraid.screen.v1.FaceReviewEvent
import centraid.screen.v1.FaceReviewState
import centraid.screen.v1.PhotoPerson
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT THE FACE QUEUE READS (#1029, photos port, lane L5).
 *
 * Two tables and therefore not a [dev.centraid.shared.sync.ScreenReads], for
 * the reason `PhotosPeopleReads` states at length: the page door has no join,
 * and the content `oneof` on `FaceReviewState` means two reads cannot be
 * chained through the reducer. `FaceReviewBridge` makes both trips and this
 * holds everything about them that is DATA — two statements and one pure
 * [fold].
 *
 * The queue is `crates/apps/photos`' `photos.faceQueue.regions` narrowed to the
 * questions: `media_face_region` where `review_state = 'proposed'`, in
 * `region_id` order.
 *
 * **THE FILTER IS `review_state` AND NOT `confirmed_by_party_id`** (#712,
 * `faces.rs` trap 2). Confirmed, rejected and dismissed all leave the queue for
 * good and only one of the three leaves a confirmer behind, so a filter on that
 * column would keep asking a member about faces they have already rejected.
 *
 * `region_id` is the table's primary key, so it is both order columns and a
 * CONTINUED page over it is legal — the nullable sort keys the door refuses
 * (`KitError::NullableSortKey`, `queries.rs`) are `captured_at`, `deleted_at`
 * and `media_asset_phash.cluster_id`, and none of them is here.
 *
 * ## THE THUMBNAIL IS A LEG OF ITS OWN, AND HAS TO BE
 *
 * `FaceCandidate.thumbnail_path` is the ASSET's thumbnail, because there is no
 * per-face derivative in the vault and inventing one would be a second copy of
 * every photograph. `with_held_thumbnail` resolves that path from the row's own
 * `content_id` through a CORRELATED subquery, and **a `from` table with no
 * `content_id` column is REFUSED AT PREPARE** (`query.proto`) —
 * `media_face_region` has none, so asking for it on the queue's own statement
 * would fail the whole page rather than answer nulls.
 *
 * So [thumbnailsQuery] reads `media_asset` keyed on the page's own asset ids
 * and the result arrives on `FaceReviewEvent.ThumbnailsArrived` — its own arm,
 * because a reducer handed two `DataArrived`s cannot tell an amendment from a
 * replace. **An asset missing from that map is an unanswered question and not
 * "no thumbnail"**, which is why the reducer paints rather than assigns.
 */
public object FaceReviewReads : ScreenWrites<FaceReviewState, FaceReviewEvent> {
    /** `media_face_region` — the questions. */
    public const val REGION_TABLE: String = "media_face_region"

    /** `core_party` — the picker's roster. */
    public const val PARTY_TABLE: String = "core_party"

    /**
     * `faces.rs`' `QUEUE_LIMIT`, followed rather than re-chosen.
     *
     * Sixty questions is already more than a member answers in one sitting, and
     * `next_cursor` says there is more so `NextPageRequested` can walk it for a
     * member who keeps going.
     */
    public const val QUEUE_LIMIT: Int = 60

    /** The door's ceiling. See `PhotosPeopleReads.PARTY_LIMIT` for the tail. */
    public const val PARTY_LIMIT: Int = 500

    /** `media_asset` — the photographs the questions are on. */
    public const val ASSET_TABLE: String = "media_asset"

    /**
     * THE PHOTOGRAPHS THIS PAGE'S QUESTIONS ARE ON.
     *
     * Keyed on `FaceCandidate.asset_id`, which the queue already projects.
     * Ordered on `asset_id` — the table's primary key, so it is both order
     * columns and non-nullable, which is the one shape the door will walk.
     *
     * Null for an empty list: an `IN ()` is not a predicate, and a leg with
     * nothing to ask is a trip not taken rather than a statement matching every
     * row in the library.
     */
    public fun thumbnailsQuery(assetIds: List<String>): PageQuery? {
        if (assetIds.isEmpty()) return null
        return PageQuery(
            name = "photos.faces.assets",
            select = listOf("asset_id"),
            from = ASSET_TABLE,
            where_ = "asset_id IN (" + assetIds.joinToString(", ") { "?" } + ")",
            bind = assetIds.map { Value(text = it) },
            order = PageOrder(sort_column = "asset_id", pk_column = "asset_id", descending = false),
            with_held_thumbnail = true,
        )
    }

    /**
     * The leg's rows, as the map the reducer paints with.
     *
     * `thumbnail_path` is THE APPENDED COLUMN — index 1, after the one
     * [thumbnailsQuery] named. An empty one is LEFT OUT of the map rather than
     * mapped to an empty string: the proto's rule is that a missing entry is an
     * unanswered question, and an entry saying "" would be this leg asserting
     * that a photograph is not on a device when all it knows is that the door
     * handed back no path.
     */
    public fun thumbnails(rows: List<Row>): FaceReviewEvent = FaceReviewEvent(
        thumbnails = FaceReviewEvent.ThumbnailsArrived(
            path_by_asset_id = rows.mapNotNull { row ->
                val assetId = row.text(0)
                val path = row.text(1)
                if (assetId.isEmpty() || path.isEmpty()) null else assetId to path
            }.toMap(),
        ),
    )

    /**
     * IS RECOGNITION ON AT ALL? The tier, as this screen's own event.
     *
     * The same `enrich_policy` row `PhotosPeopleReads` reads and the same fold
     * — `off | device | gateway`, with `local` and `model` read forward — so
     * the two photos screens cannot disagree about a switch there is only one
     * of. A queue cannot fill while it is off, and an empty queue with the
     * plane switched off is a different screen with a different next move.
     */
    public fun recognition(policyRows: List<Row>): FaceReviewEvent = FaceReviewEvent(
        recognition = FaceReviewEvent.RecognitionChanged(
            enabled = PhotosPeopleReads.recognitionIsOn(policyRows.firstOrNull()?.text(1) ?: ""),
        ),
    )

    public fun queueQuery(): PageQuery = PageQuery(
        name = "photos.faces.queue",
        select = listOf("region_id", "asset_id", "bbox_json", "party_id", "confidence"),
        from = REGION_TABLE,
        where_ = "review_state = ?",
        bind = listOf(Value(text = PhotosPeopleReads.PROPOSED)),
        order = PageOrder(sort_column = "region_id", pk_column = "region_id", descending = false),
    )

    /**
     * THE PICKER'S ROSTER.
     *
     * `faces.rs`' `queue_parties_statement`, narrowed to live people for
     * `PhotosPeopleReads.partiesQuery`'s reasons — an `org`, a `group` and an
     * `agent` have no faces, and a trashed party is somebody the member has
     * already thrown away.
     *
     * Read with the page and never when the picker opens: "every party a face
     * could be named as, so the picker needs no second read while a member is
     * mid-answer" is the proto's own reason for the field, and a roster fetched
     * on open would be a spinner between a member and a name they know.
     */
    public fun partiesQuery(): PageQuery = PhotosPeopleReads.partiesQuery()

    /**
     * TWO PAGES INTO ONE SCREEN. Pure.
     *
     * The roster does double duty: it is the picker's list AND the book that
     * gives the model's guess a name. `media_face_region.party_id` on a
     * `proposed` row is who the derivation thinks it is, and the name is
     * `core_party`'s — a proposal naming a party the roster does not know keeps
     * an EMPTY name rather than its id, because that party was purged and the
     * member is being asked about a face belonging to somebody they asked to be
     * forgotten. The view then offers the question with no suggestion attached,
     * which is the honest shape of "the model had a guess and it no longer
     * means anything".
     */
    public fun fold(
        partyRows: List<Row>,
        queueRows: List<Row>,
        nextCursor: String?,
    ): FaceReviewData {
        val roster = partyRows.mapNotNull { row ->
            val partyId = row.text(0)
            val name = row.text(1)
            if (partyId.isEmpty() || name.isEmpty()) {
                null
            } else {
                PhotoPerson(party_id = partyId, display_name = name)
            }
        }
        val book = roster.associate { it.party_id to it.display_name }
        return FaceReviewData(
            candidates = queueRows.map { row -> candidateOf(row, book) },
            next_cursor = nextCursor,
            known_people = roster,
        )
    }

    /**
     * One question out of one row.
     *
     * `proposed_party_id` is a PROPOSAL, NEVER DRAWN AS A FACT, and it is empty
     * when the derivation has no guess at all — which is every row the demo
     * corpus seeds: nothing in v0 writes `party_id` on a proposal, and a
     * proposal of one region is honest (#712).
     */
    private fun candidateOf(row: Row, book: Map<String, String>): FaceCandidate {
        val box = boxOf(row.text(BBOX))
        val proposed = row.text(PARTY_ID)
        return FaceCandidate(
            region_id = row.text(0),
            asset_id = row.text(ASSET_ID),
            proposed_party_id = proposed,
            proposed_name = book[proposed] ?: "",
            // THE DETECTOR'S SCORE, `[0,1]` and NULL-able in the DDL. A NULL
            // arrives as 0, which `confidenceWord` reads as "say nothing" — and
            // that is right: a row that does not say how sure it is must not be
            // drawn as a row that is sure of nothing.
            confidence = row.real(CONFIDENCE),
            box_x = box[0],
            box_y = box[1],
            box_width = box[2],
            box_height = box[3],
        )
    }

    /**
     * THE BOX, AS FRACTIONS OF THE IMAGE (#1029, photos port).
     *
     * `media_face_region.bbox_json` is `TEXT NOT NULL CHECK (json_valid(...))`
     * and nothing narrower: the column's contract is "valid JSON" and the shape
     * is the writer's convention. **That convention is `{"x","y","w","h"}` as
     * NORMALISED fractions with the origin at the top left** —
     * `crates/apps/kit`'s corpus calls them "the EXACT normalised boxes the
     * frames were drawn with" and seeds values like
     * `{"x":0.3374,"y":0.1795,"w":0.4511,"h":0.4743}`. So there is nothing to
     * convert, and this reads rather than scales.
     *
     * **A VALUE ABOVE 1 IS TREATED AS MALFORMED AND THE BOX IS DROPPED.** It
     * would be a box in PIXELS, and pixels cannot be converted here: the
     * divisors are `media_asset.width`/`height`, another table this read cannot
     * join, and a pixel box drawn over a thumbnail lands somewhere arbitrary —
     * which is the proto's own reason for asking for fractions. A confident
     * wrong rectangle over somebody's face is worse than none, and `faces.rs`
     * makes the same choice from the other side: it does not parse the column
     * at all, so "a malformed one must reach the surface as malformed rather
     * than as a silent `(0,0,0,0)`".
     *
     * A zero-sized, absent or malformed box is `[0,0,0,0]`, which the views
     * read as "no box" and draw the whole thumbnail for. That is a visible
     * degradation and not a silent one: the member sees a photograph instead of
     * a crop.
     */
    public fun boxOf(bbox: String): DoubleArray {
        val none = doubleArrayOf(0.0, 0.0, 0.0, 0.0)
        val x = numberOf(bbox, "x") ?: return none
        val y = numberOf(bbox, "y") ?: return none
        val width = numberOf(bbox, "w") ?: return none
        val height = numberOf(bbox, "h") ?: return none
        val fractions = listOf(x, y, width, height).all { it.isFinite() && it >= 0.0 && it <= 1.0 }
        if (!fractions || width <= 0.0 || height <= 0.0) return none
        // CLAMPED TO THE IMAGE, because a detector's box may run off the edge of
        // the frame and a view asked to draw past its own bounds draws over its
        // neighbour.
        return doubleArrayOf(x, y, minOf(width, 1.0 - x), minOf(height, 1.0 - y))
    }

    /**
     * One JSON number by key, hand-read.
     *
     * `commonMain` carries no JSON dependency — `NotesEditorMachine` hand-builds
     * its command input for the same reason — and this is the reading half of
     * the same trade: four numbers out of a flat object, and anything it does
     * not understand answers null, which [boxOf] turns into "no box" rather
     * than into a guess.
     *
     * A nested object or an array would not match, and that is the honest
     * outcome: a box shaped differently from the one convention in this
     * repository is a box this port does not know how to read.
     */
    private fun numberOf(json: String, key: String): Double? {
        val at = json.indexOf("\"$key\"")
        if (at < 0) return null
        var index = at + key.length + 2
        while (index < json.length && json[index].isWhitespace()) index += 1
        if (index >= json.length || json[index] != ':') return null
        index += 1
        while (index < json.length && json[index].isWhitespace()) index += 1
        val start = index
        while (index < json.length && (json[index].isDigit() || json[index] in "+-.eE")) {
            index += 1
        }
        if (index == start) return null
        return json.substring(start, index).toDoubleOrNull()
    }

    /** The finished page, as the machine's own event. */
    public fun arrived(data: FaceReviewData): FaceReviewEvent =
        FaceReviewEvent(data_ = FaceReviewEvent.DataArrived(data_ = data))

    public fun refused(failure: ReadFailure): FaceReviewEvent =
        FaceReviewEvent(refused = FaceReviewEvent.ReadRefused(failure = failure))

    override val appId: String = "photos"

    /**
     * The answer's outcome.
     *
     * `committed` is `EXECUTED` and nothing else — `QUEUED`, `IN_FLIGHT` and
     * `PARKED` all mean "somewhere durable, not yet committed", and a queue that
     * read them as done would move past a question whose answer has not landed.
     *
     * **It does not say WHICH write settled**, which is why
     * `FaceReviewMachine.settled` is written so a mis-attribution cannot corrupt
     * the screen: every outcome but a committed answer re-reads, and a re-read
     * is the vault's own truth about what is still unanswered.
     *
     * `appId` is `photos` for both commands this screen submits, including
     * `people.add_person` — the field is what a log line says WROTE, and it was
     * Photos that wrote, whichever schema owns the command.
     */
    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): FaceReviewEvent =
        settledFor(status, sentence, regionId = FaceReviewMachine.regionOfInvokeKey(invokeKey))

    /**
     * The same, naming the question it was about — **`settledFor`, because it
     * cannot be an overload any more**: now that `ScreenWrites.settled` carries
     * the `invokeKey`, the two would have identical signatures
     * `(CommandStatus, String, String)` and every call site would be
     * ambiguous.
     *
     * **The interface form now carries it too**: `ScreenWrites.settled` gained
     * the `invokeKey`, so the ordinary path resolves the region through
     * [FaceReviewMachine.regionOfInvokeKey] rather than answering empty. This
     * overload stays for `FaceReviewBridge`, which already holds the region
     * and need not re-parse a key to find it. An EMPTY region is still a real
     * answer — the reducer reads it as "this settle names no question" and
     * falls back to the cursor it already had rather than guessing.
     */
    public fun settledFor(
        status: CommandStatus,
        sentence: String,
        regionId: String,
    ): FaceReviewEvent = FaceReviewEvent(
        write_settled = FaceReviewEvent.WriteSettled(
            committed = status == CommandStatus.COMMAND_STATUS_EXECUTED,
            sentence = sentence,
            region_id = regionId,
        ),
    )

    /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    private const val ASSET_ID: Int = 1
    private const val BBOX: Int = 2
    private const val PARTY_ID: Int = 3
    private const val CONFIDENCE: Int = 4

    /**
     * A REAL column, read off the REAL arm.
     *
     * A door that stored an integer 0 or 1 in a REAL column is a case
     * `faces.rs` handles on its side, so it is handled here too: read as text a
     * confidence comes back empty and every face in the queue would be drawn as
     * having no score at all.
     */
    private fun Row.real(index: Int): Double {
        val value = values.getOrNull(index) ?: return 0.0
        return value.real ?: value.integer?.toDouble() ?: 0.0
    }
}
