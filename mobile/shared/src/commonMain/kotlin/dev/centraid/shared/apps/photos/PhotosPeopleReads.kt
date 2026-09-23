package dev.centraid.shared.apps.photos

import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.PageRequest
import centraid.core.v1.Request
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.PersonRow
import centraid.screen.v1.PhotosPeopleData
import centraid.screen.v1.PhotosPeopleEvent
import centraid.screen.v1.PhotosPeopleState
import centraid.screen.v1.ReadFailure
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.sync.ScreenWrites
import dev.centraid.shared.sync.fromCore
import dev.centraid.shared.sync.sentenceFor

/**
 * WHAT THE PEOPLE SCREEN READS (#1029, photos port, lane L5).
 *
 * ## THIS IS NOT A `ScreenReads`, AND THE REASON IS A CONTRACT FINDING
 *
 * Every other app screen in this module implements
 * [dev.centraid.shared.sync.ScreenReads]: one table, one statement, one
 * projection. This screen needs THREE tables and the page door has no join —
 * who is confirmed and how often (`media_face_region`), what those parties are
 * called (`core_party`), and whether recognition is switched on at all
 * (`enrich_policy`).
 *
 * Three reads cannot be chained through the reducer, and the type system is
 * what says so: **`PhotosPeopleState`'s content is a protobuf `oneof`**, so
 * `loading` and `data` cannot both be set, and there is nowhere on the state to
 * hold two reads' answers while the third is in flight. Wire enforces it in the
 * constructor — "At most one of loading, failure, data_ may be non-null" — and
 * it is the three-state read law made structural, which is exactly right and
 * exactly what forbids a partial screen.
 *
 * So the composition happens BELOW the machine, in `PhotosPeopleBridge`, which
 * is `HomeRuntime`'s own design and its documented reason for existing: "it
 * fans out one read per app and turns seven independent answers into seven
 * tiles". The machine still sees one `DataArrived` carrying one finished
 * screen. What lives here is everything about those reads that is DATA — the
 * three statements and one pure [fold] — so all of it is provable on a machine
 * with no vault.
 *
 * ## THE COVER IS A FOURTH LEG, AND IT HAS A KEY NOW
 *
 * A cover is `media_asset`'s thumbnail and the door has no join, so it needs a
 * read of its own — and that read needs an asset id to ask about.
 * `PersonRow.cover_asset_id` is that key: [fold] puts one on every row and
 * [withCovers] fills the path from the leg's rows. A person whose cover did not
 * come back keeps an ABSENT path rather than a placeholder one, because a path
 * invented here would claim bytes this device may not hold — and the view draws
 * their initial, which reads as "no picture yet" where a grey square would read
 * as "this failed".
 */
public object PhotosPeopleReads : ScreenWrites<PhotosPeopleState, PhotosPeopleEvent> {
    /** `media_face_region` — the confirmed faces and the unanswered backlog. */
    public const val REGION_TABLE: String = "media_face_region"

    /** `core_party` — what those parties are called. */
    public const val PARTY_TABLE: String = "core_party"

    /** `enrich_policy` — whether recognition is switched on at all. */
    public const val POLICY_TABLE: String = "enrich_policy"

    /** `media_asset` — the covers' own table, read by [coversQuery]. */
    public const val ASSET_TABLE: String = "media_asset"

    /**
     * The door's own ceiling (`crates/apps/kit`'s `MAX_PAGE_ROWS`).
     *
     * Asked for in full because every region collapses into a COUNT: a hundred
     * regions of one person are one row on this screen, so a small page would
     * be a small number rather than a short list, and a member would read
     * "3 photos" under a face they have confirmed fifty times.
     */
    public const val REGION_LIMIT: Int = 500

    /**
     * `faces.rs`' `PARTY_ROWS`, clamped by the door's own 500.
     *
     * A vault with more than five hundred people would have names missing from
     * the tail of the book, and a party with a count but no name is DROPPED by
     * [fold] rather than drawn as an id — so the failure mode is a short list
     * and not a wrong one.
     */
    public const val PARTY_LIMIT: Int = 500

    /**
     * THE CONFIRMED FACES AND THE UNANSWERED ONES, in one statement.
     *
     * `crates/apps/photos`' `photos.faceQueue.regions` narrowed: the confirmed
     * rows are the people and the proposed rows are the badge on the door to
     * review, and the door has no `COUNT(*)`, so both are counted off the rows.
     * `rejected` and `dismissed` are left out of the PREDICATE rather than
     * filtered afterwards — they are answers a member already gave, and
     * carrying them across the wire to throw them away would shrink the window
     * the counts are honest within.
     *
     * **THE FILTER IS `review_state`, NEVER `confirmed_by_party_id`** (#712,
     * `faces.rs` trap 2): a rejected region carries no confirmer and a
     * confirmed one does, so a filter on that column silently means something
     * else on two of the four answers.
     *
     * `region_id` is the table's primary key and therefore both order columns,
     * which is also the one order a CONTINUED page is legal in — the nullable
     * sort keys the door refuses (`KitError::NullableSortKey`, `queries.rs`)
     * are `captured_at`, `deleted_at` and `media_asset_phash.cluster_id`.
     *
     * `asset_id` IS PROJECTED BECAUSE THE COUNT IS PER PHOTOGRAPH, not per
     * region: two faces of one person in one frame are one photograph of them,
     * which is the dedupe `faces.rs`' `assets_by_party` does with a set of
     * asset ids and [fold] does with the same set.
     */
    public fun regionsQuery(): PageQuery = PageQuery(
        name = "photos.people.regions",
        select = listOf("region_id", "asset_id", "party_id", "review_state"),
        from = REGION_TABLE,
        where_ = "review_state IN (?, ?)",
        bind = listOf(Value(text = CONFIRMED), Value(text = PROPOSED)),
        order = PageOrder(sort_column = "region_id", pk_column = "region_id", descending = false),
    )

    /**
     * THE NAME BOOK.
     *
     * `faces.rs`' `queue_parties_statement`: `core_party` ordered by
     * `display_name`, which is v0's order — followed rather than re-derived for
     * `PhotosReads`' reason, that a roster in a different order from the
     * desktop's over the same rows is two address books. The collation is
     * SQLite's `BINARY` and a render side's is a locale compare; `faces.rs`
     * records that disagreement and so does this.
     *
     * **`kind` NARROWS TO PEOPLE AND THAT IS THE MODEL, NOT A FILTER.** An
     * `org`, a `group` and an `agent` are parties a region could point at and
     * none of them has a face; `agent` in particular is enrolment's row, which
     * `core.update_party`'s own precondition refuses to edit.
     *
     * A TRASHED PERSON IS NOT LISTED (#916, D1): the row survives its deletion
     * until the purge sweep takes it, and a People screen that listed one would
     * offer a member a face for somebody they have already thrown away.
     */
    public fun partiesQuery(): PageQuery = PageQuery(
        name = "photos.people.parties",
        select = listOf("party_id", "display_name", "kind"),
        from = PARTY_TABLE,
        where_ = "kind = ? AND deleted_at IS NULL",
        bind = listOf(Value(text = PERSON)),
        order = PageOrder(
            sort_column = "display_name",
            pk_column = "party_id",
            descending = false,
        ),
    )

    /**
     * IS RECOGNITION SWITCHED ON AT ALL?
     *
     * The same single-row read `crates/apps/photos`' `enrichment-status` makes,
     * keyed on the `photos` domain — and the same fold: `tier ∈ off | device |
     * gateway`, with `local` and `model` read forward as the pre-#712 names
     * (`enrichment.rs`). The bootstrap seeds both domains at `gateway`, so "on"
     * is the ordinary state of a vault made on this phone and a member who
     * reads "recognition is off" has switched it off themselves.
     */
    public fun policyQuery(): PageQuery = PageQuery(
        name = "photos.people.policy",
        select = listOf("domain", "tier"),
        from = POLICY_TABLE,
        where_ = "domain = ?",
        bind = listOf(Value(text = DOMAIN)),
        order = PageOrder(sort_column = "domain", pk_column = "domain", descending = false),
    )

    /**
     * THE COVERS, BY ASSET ID.
     *
     * A fourth leg, keyed on the `cover_asset_id` [fold] chose for each person.
     * `with_held_thumbnail` is the door's own computed column — it resolves the
     * thumbnail-tier derivative of the row's `content_id`, falling back to the
     * original's bytes, and the rule about whether a path may be handed out at
     * all is the vault's. This side asks for the answer and cannot spell either,
     * which is the point: a media-type predicate written here would be a
     * security rule living in a shell's statement.
     *
     * Ordered on `asset_id`, which is the table's primary key and therefore
     * both order columns — and non-nullable, so this is a statement the door
     * would walk if it ever had to.
     *
     * Null for an empty list: an `IN ()` is not a predicate, and a leg with
     * nothing to ask is a trip not taken rather than a statement that matches
     * every row in the library.
     */
    public fun coversQuery(assetIds: List<String>): PageQuery? {
        if (assetIds.isEmpty()) return null
        return PageQuery(
            name = "photos.people.covers",
            select = listOf("asset_id"),
            from = ASSET_TABLE,
            where_ = "asset_id IN (" + assetIds.joinToString(", ") { "?" } + ")",
            bind = assetIds.map { Value(text = it) },
            order = PageOrder(sort_column = "asset_id", pk_column = "asset_id", descending = false),
            with_held_thumbnail = true,
        )
    }

    /**
     * THE COVERS' PATHS, ONTO THE ROWS THAT NAMED THEM.
     *
     * `thumbnail_path` is THE APPENDED COLUMN — index 1, after the one
     * [coversQuery] named — which is where the door puts a computed column so
     * that `select` stays a list of real columns. An empty one is a real answer
     * with more than one cause: the bytes have not reached this device, or they
     * are a reading no surface may embed. Neither is an error, and both leave
     * the row's cover ABSENT so the view draws the initial.
     */
    public fun withCovers(data: PhotosPeopleData, coverRows: List<Row>): PhotosPeopleData {
        if (coverRows.isEmpty()) return data
        val paths = coverRows.mapNotNull { row ->
            val assetId = row.text(0)
            val path = row.text(1)
            if (assetId.isEmpty() || path.isEmpty()) null else assetId to path
        }.toMap()
        if (paths.isEmpty()) return data
        return data.copy(
            people = data.people.map { person ->
                person.copy(cover_thumbnail_path = paths[person.cover_asset_id])
            },
        )
    }

    /**
     * THREE PAGES INTO ONE SCREEN. Pure, and the whole of this screen's
     * reasoning.
     *
     * `empty_reason` IS THE FIELD THIS SCREEN EXISTS TO GET RIGHT. v0 drew one
     * sentence over an empty People screen (`PeopleEmptyState.tsx`) and there
     * are three different empty screens behind it with three different next
     * moves — recognition is off (a setting, and nothing will ever arrive until
     * the member changes it), on and nothing looked at yet (waiting is right),
     * or faces found and none named (the queue next door is the answer, and the
     * next move is a door rather than a sentence).
     *
     * **The reason is derived from the TIER and never from an absence**, which
     * is what v0 could not do: no region row means "off" or "not run yet"
     * depending on a switch, and only `enrich_policy` knows which.
     *
     * Switching recognition off does NOT empty this screen: it does not un-name
     * the people a member already named, and a list that emptied itself when
     * the switch moved would look like it had forgotten them. So `NONE` — "not
     * empty" — outranks the tier whenever there is somebody to draw.
     */
    public fun fold(
        policyRows: List<Row>,
        partyRows: List<Row>,
        regionRows: List<Row>,
        nextCursor: String?,
    ): PhotosPeopleData {
        val names = partyRows.mapNotNull { row ->
            val partyId = row.text(0)
            val name = row.text(1)
            // `display_name` IS NOT NULL IN THE DDL, so an empty one is a door
            // answering something this fold does not understand — and a blank
            // row a member cannot tap is worse than a short list.
            if (partyId.isEmpty() || name.isEmpty()) null else partyId to name
        }.toMap()

        val assetsByParty = mutableMapOf<String, MutableSet<String>>()
        // THE COVER, AS THE FIRST CONFIRMED PHOTOGRAPH THIS PAGE YIELDS FOR A
        // PERSON. Not "their best photograph" — the door cannot rank, and a
        // fold that pretended to would be picking a favourite nobody chose.
        // What it IS is stable: the page is ordered by `region_id`, so the same
        // library answers the same cover on every read, and a member's people
        // list does not shuffle its faces between openings.
        val coverOf = mutableMapOf<String, String>()
        var proposed = 0
        regionRows.forEach { row ->
            val partyId = row.text(REGION_PARTY)
            when (row.text(REGION_REVIEW_STATE)) {
                // A CONFIRMED REGION WITH NO PARTY IS NOT A PERSON. The DDL's
                // foreign key is `ON DELETE SET NULL`, so a purged member leaves
                // their confirmed faces behind unnamed (#916, D1) — and a row on
                // this screen for somebody the member asked to be forgotten is
                // the defect that rule exists to prevent.
                CONFIRMED ->
                    if (partyId.isNotEmpty()) {
                        val assetId = row.text(REGION_ASSET)
                        assetsByParty.getOrPut(partyId) { mutableSetOf() } += assetId
                        if (assetId.isNotEmpty()) coverOf.getOrPut(partyId) { assetId }
                    }

                PROPOSED -> proposed += 1
            }
        }

        val people = assetsByParty
            .mapNotNull { (partyId, assets) ->
                // AN ID IS NEVER DRAWN WHERE A NAME GOES (`AppReadsSpec`, Tally's
                // payer column). A counted party the name book does not know was
                // purged, and it is left out rather than rendered as its key.
                val name = names[partyId] ?: return@mapNotNull null
                PersonRow(
                    party_id = partyId,
                    display_name = name,
                    photo_count = assets.size,
                    // THE KEY THE COVER LEG ASKS ABOUT. The PATH is filled by
                    // [withCovers] and stays absent when that leg did not run
                    // or did not answer.
                    cover_asset_id = coverOf[partyId].orEmpty(),
                    // A FLOOR AND NOT A TOTAL. The door has no `COUNT(*)`, so
                    // this counts the rows one page returned — and a page with
                    // a cursor behind it has more rows this person may be in.
                    // The flag is what makes the view say "at least 84"; a bare
                    // number over a full page would state a total nobody
                    // counted (`HomeState.ThingCount.capped`).
                    photo_count_capped = nextCursor != null,
                )
            }
            // ORDERED BY NAME, not by count. A member looks for somebody by
            // their name.
            .sortedWith(compareBy({ it.display_name }, { it.party_id }))

        return PhotosPeopleData(
            people = people,
            next_cursor = nextCursor,
            proposed_face_count = proposed,
            empty_reason = when {
                people.isNotEmpty() -> PhotosPeopleData.EmptyReason.EMPTY_REASON_NONE
                // FACES FOUND, NONE CONFIRMED. The door to review is the
                // answer, whatever the switch says now.
                regionRows.isNotEmpty() ->
                    PhotosPeopleData.EmptyReason.EMPTY_REASON_NONE_NAMED
                recognitionIsOn(policyRows.firstOrNull()?.text(POLICY_TIER) ?: "") ->
                    PhotosPeopleData.EmptyReason.EMPTY_REASON_NOT_RUN_YET
                else -> PhotosPeopleData.EmptyReason.EMPTY_REASON_RECOGNITION_OFF
            },
        )
    }

    /**
     * THE TIER TABLE, AS `crates/apps/photos` SPELLS IT.
     *
     * Four accepted spellings and not three: `local` and `model` are the
     * pre-#712 names the column's CHECK still admits as a READ shim, and a
     * vault written by an older build must open rather than report its
     * recognition switched off. Nothing here writes a tier, so no retired
     * spelling can go back.
     *
     * **An absent row, and any spelling outside the CHECK, is `off`.** The
     * failure-safe direction for a recognition switch is not running, which is
     * `enrichment.rs`' answer and v0's before it.
     *
     * A REFUSAL IS NOT `off`, and the distinction survives because a refusal
     * never reaches this function: it arrives as [refused] and the screen draws
     * the failure. Telling a member their recognition is switched off when the
     * read was denied is the lie `enrichment.rs` keeps a three-armed `Reading`
     * to prevent.
     */
    public fun recognitionIsOn(tier: String): Boolean = when (tier) {
        "device", "local", "gateway", "model" -> true
        else -> false
    }

    /** The finished screen, as the machine's own event. */
    public fun arrived(data: PhotosPeopleData): PhotosPeopleEvent =
        PhotosPeopleEvent(data_ = PhotosPeopleEvent.DataArrived(data_ = data))

    /** A refusal from any one of the three reads. */
    public fun refused(failure: ReadFailure): PhotosPeopleEvent =
        PhotosPeopleEvent(refused = PhotosPeopleEvent.ReadRefused(failure = failure))

    override val appId: String = "photos"

    /**
     * The rename's outcome.
     *
     * `committed` is `EXECUTED` and nothing else. `QUEUED`, `IN_FLIGHT` and
     * `PARKED` all mean "somewhere durable, not yet committed", and a screen
     * that read them as done would be claiming a write that has not happened —
     * `NotesReads.settled` states the same table for the same reason.
     */
    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): PhotosPeopleEvent =
        PhotosPeopleEvent(
            write_settled = PhotosPeopleEvent.WriteSettled(
                committed = status == CommandStatus.COMMAND_STATUS_EXECUTED,
                sentence = sentence,
            ),
        )

    /** The DDL's CHECK spells these; see `faces.rs`' `ReviewState`. */
    public const val CONFIRMED: String = "confirmed"
    public const val PROPOSED: String = "proposed"

    /** `core_party.kind`'s CHECK; a face is a person by construction. */
    public const val PERSON: String = "person"

    /** `enrich_policy.domain`'s CHECK is `('photos','docs')`; this app reads its own. */
    public const val DOMAIN: String = "photos"

    /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    private const val REGION_ASSET: Int = 1
    private const val REGION_PARTY: Int = 2
    private const val REGION_REVIEW_STATE: Int = 3
    private const val POLICY_TIER: Int = 1
}

/**
 * ONE PAGE OFF THE CORE, OR THE SENTENCE THE MEMBER READS.
 *
 * The half of [dev.centraid.shared.sync.ScreenRuntime] a composing bridge still
 * needs, lifted out so the two screens in this app that read more than one
 * table do not each re-derive it. Copied in shape from `HomeRuntime.page`,
 * which is the other composing runtime in this module and answers the same
 * question the same way.
 *
 * `Error.detail` IS FOR LOGS AND NEVER FOR A MEMBER: it carries whatever the
 * failing layer said, including a SQLite `RAISE(ABORT)`, and one reached a
 * member's screen through exactly that field in #1020 wave 3. The CODE chooses
 * the sentence.
 */
internal sealed interface PhotosPage {
    public data class Rows(val rows: List<Row>, val nextCursor: String?) : PhotosPage

    public data class Refused(val failure: ReadFailure) : PhotosPage
}

internal suspend fun CentraidCore?.photosPage(
    query: PageQuery,
    limit: Int,
    after: centraid.core.v1.PageCursor? = null,
): PhotosPage {
    val handle = this
        // NO VAULT IS NOT A CRASH, and not an empty list either: a device
        // before its first pairing has not learned that it holds nothing.
        ?: return PhotosPage.Refused(Reads.refused("No vault is open on this device."))
    val outcome = handle.call(
        Envelope(
            request_id = 0,
            request = Request(page = PageRequest(query = query, limit = limit, after = after)),
        ),
    )
    return when (outcome) {
        is CoreOutcome.Failed -> PhotosPage.Refused(fromCore(outcome.failure))
        is CoreOutcome.Answered -> {
            val page = outcome.value.response?.page
            val error = outcome.value.error
            when {
                page != null -> PhotosPage.Rows(
                    rows = page.rows,
                    nextCursor = page.next?.let { "${it.sort_key}|${it.pk}" },
                )
                error != null -> PhotosPage.Refused(sentenceFor(error.code))
                else -> PhotosPage.Refused(
                    Reads.refused("The vault answered with neither a page nor a reason."),
                )
            }
        }
    }
}
