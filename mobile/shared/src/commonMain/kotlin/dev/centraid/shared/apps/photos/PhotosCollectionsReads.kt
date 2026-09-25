package dev.centraid.shared.apps.photos

import centraid.core.v1.CommandStatus
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.CollectionsDoor
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosCollectionsData
import centraid.screen.v1.PhotosCollectionsEvent
import centraid.screen.v1.PhotosCollectionsState
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.ShelfRow
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT COLLECTIONS READS (#1029, the photos port).
 *
 * ## THIS IS NOT A `ScreenReads`, FOR `PhotosPeopleReads`' REASON
 *
 * [dev.centraid.shared.sync.ScreenReads] is one table, one statement, one
 * projection, and its `arrived` is handed rows with no way to ask which
 * statement produced them. Collections is a list of SHELVES, and a shelf is a
 * count: the door has **no `COUNT(*)` and no join**
 * (`centraid.core.v1.PageQuery`), so every number on this screen is rows read
 * and counted, off a different table each time —
 *
 * | what | where it comes from |
 * | --- | --- |
 * | the albums | `core_collection` |
 * | an album's size | `core_collection_entry` |
 * | Archive, Trash, Videos | `media_asset` under three predicates |
 * | Favorites | `core_concept_scheme` → `core_concept` → `core_tag` |
 * | People | `media_face_region` |
 * | Places | `core_place` |
 * | Memories | `media_memory` |
 * | Duplicates | `media_asset_phash` |
 *
 * Those answers cannot be chained through the reducer, and the type system is
 * what says so: **`PhotosCollectionsState`'s content is a protobuf `oneof`**,
 * so `loading` and `data` cannot both be set and there is nowhere to hold nine
 * answers while the tenth is in flight. Wire enforces it in the constructor,
 * which is the three-state read law made structural and exactly what forbids a
 * half-composed screen.
 *
 * So the composition happens BELOW the machine, in [PhotosCollectionsBridge],
 * which is `HomeRuntime`'s own design and its documented reason for existing.
 * What lives here is everything about those reads that is DATA — the
 * statements and one pure [fold] — so all of it is provable on a machine with
 * no vault.
 *
 * ## EVERY COUNT IS A FLOOR WHEN ITS PAGE FILLED
 *
 * A page that filled has more behind it, so the count read off it is "at
 * least", and `ShelfRow.item_count_capped` / `CollectionsDoor.count_capped`
 * are what say so. A bare number over a full page would be a total nobody
 * counted, which is the defect `HomeState.ThingCount.capped` exists to
 * prevent. Nothing here rounds, estimates or extrapolates: it counts what it
 * was handed and says whether that was all of it.
 *
 * ## THE COVERS THAT ARE HERE, AND THE ONES THAT ARE NOT
 *
 * Archive, Trash and Videos each read their own shelf in the shelf's own
 * order, so the newest row on each IS the cover and its thumbnail comes down
 * the same statement (`with_held_thumbnail`). Favorites get none: a favourite
 * is a `core_tag` row and this read never touches the asset behind it. An
 * album's cover is `core_collection.cover_content_id` — a column
 * `with_held_thumbnail` cannot correlate on, because it joins
 * `{from}.content_id` and a table without one is REFUSED at prepare — so the
 * albums get theirs from a second read over `media_asset`
 * ([albumCoversQuery]). Absent is still a real answer; the views draw the empty
 * cover themselves, which is what the field says to do.
 */
public object PhotosCollectionsReads :
    ScreenWrites<PhotosCollectionsState, PhotosCollectionsEvent> {
    /** `core_collection`, the same table the machine's `rowsChanged` declares. */
    public const val TABLE: String = "core_collection"

    /**
     * `core_collection.kind` for an album (rung six). The table holds Notes'
     * notebooks too, and every album read in this app binds this — the vault's
     * own word, spelled once.
     */
    public const val ALBUM_KIND: String = "album"

    /**
     * Albums are "owner-curated and small" (`crates/apps/photos`' own
     * `albums_statement`), and this is a list of named rows rather than a
     * mosaic — a member reads them, they do not flick past them.
     */
    public const val ALBUM_LIMIT: Int = 100

    /**
     * How far a COUNTING read goes before its answer becomes a floor.
     *
     * The door's own ceiling is 500 rows (`MAX_PAGE_ROWS`) and asking for more
     * is clamped rather than refused, so this is the most any one of these can
     * learn in one trip. It is deliberately the same number for every count on
     * this screen: a Trash counted to 500 beside a Videos counted to 200 would
     * make "at least" mean two different things in one list.
     */
    public const val COUNT_LIMIT: Int = 500

    /**
     * ONE PAGE EACH, AND NEVER A WALK.
     *
     * `captured_at`, `deleted_at` and `media_asset_phash.cluster_id` are all
     * nullable, and the door **refuses a CONTINUED page over a nullable sort
     * key** (`KitError::NullableSortKey`) because SQLite's row-value comparison
     * puts every NULL on one side of the keyset and the walk silently drops
     * them. `crates/apps/photos` reached the same answer on purpose and wrote
     * it down: one page plus an honest "there is more", never a walk that
     * quietly loses rows. [Scan.capped] is that "there is more".
     */
    public data class Scan(val rows: List<Row> = emptyList(), val capped: Boolean = false)

    // -----------------------------------------------------------------------
    // The statements.
    // -----------------------------------------------------------------------

    /**
     * `photos.collections.albums` — the member's own albums.
     *
     * The desktop's `albums_statement`: `core_collection`, projected
     * `collection_id, name`, ordered `collection_id ASC`. Followed rather than
     * re-derived, for the reason `PhotosReads` gives about the grid — a list in
     * a different order from the desktop's over the same rows is two products.
     *
     * Ordering a collection list by its own primary key is also the one sort on
     * this screen that is NOT nullable, which is what makes it the one read
     * here that can honestly be walked for a second page.
     *
     * **`kind = 'album'` AND NOTHING ELSE**, as the desktop's statement does.
     * `core_collection` holds Notes' notebooks too, and the vault says which a
     * row is (rung six) — so no shape heuristic (a parent, an entry type) is
     * invented here to guess at it.
     */
    public fun albumsQuery(): PageQuery = PageQuery(
        name = "photos.collections.albums",
        select = listOf("collection_id", "name", "cover_content_id"),
        from = TABLE,
        where_ = "kind = ?",
        bind = listOf(Value(text = ALBUM_KIND)),
        order = PageOrder(sort_column = "collection_id", pk_column = "collection_id"),
    )

    /** `photos.collections.albumEntries` — how many assets each album holds. */
    public fun albumEntriesQuery(): PageQuery = PageQuery(
        name = "photos.collections.albumEntries",
        select = listOf("entry_id", "collection_id", "target_id"),
        from = "core_collection_entry",
        // A COLLECTION HOLDS MORE THAN PHOTOGRAPHS. `core_collection_entry` is
        // polymorphic — `(target_type, target_id)` — so a notebook's notes live
        // in the same table, and an album's size counted without this predicate
        // would be the size of whatever else a member had filed there.
        where_ = "target_type = ?",
        bind = listOf(Value(text = TAG_TARGET_TYPE)),
        order = PageOrder(sort_column = "entry_id", pk_column = "entry_id"),
    )

    /**
     * `photos.collections.archive` — the shelf, in the shelf's own order.
     *
     * A read PER SHELF rather than one scan of `media_asset` partitioned
     * afterwards, and the difference is the quality of the floor: five hundred
     * rows of the archive counts five hundred archived photographs, where five
     * hundred rows of the whole library might contain three. The cover comes
     * free with it — the newest row on the shelf is the shelf's cover, and its
     * thumbnail rides the same statement.
     *
     * `deleted_at IS NULL` beside `archived_at IS NOT NULL` is the app's own
     * pairing (#419): archived and trashed are different answers and the
     * table's CHECK refuses a row claiming both, so a shelf that counted the
     * overlap would be counting a row that cannot exist.
     */
    public fun archiveQuery(): PageQuery = PageQuery(
        name = "photos.collections.archive",
        select = listOf("asset_id", "archived_at"),
        from = ASSETS,
        where_ = "archived_at IS NOT NULL AND deleted_at IS NULL",
        order = PageOrder(sort_column = "archived_at", pk_column = "asset_id", descending = true),
        with_held_thumbnail = true,
    )

    /** `photos.collections.trash` — the desktop's `trash_statement`, counted. */
    public fun trashQuery(): PageQuery = PageQuery(
        name = "photos.collections.trash",
        select = listOf("asset_id", "deleted_at"),
        from = ASSETS,
        where_ = "deleted_at IS NOT NULL",
        order = PageOrder(sort_column = "deleted_at", pk_column = "asset_id", descending = true),
        with_held_thumbnail = true,
    )

    /**
     * `photos.collections.videos` — the library predicate, narrowed to one kind.
     *
     * Videos is a shelf of the LIVE library and not of everything: a video in
     * the trash is in the trash, and counting it here would put one photograph
     * on two shelves whose whole point is that they are different places.
     */
    public fun videosQuery(): PageQuery = PageQuery(
        name = "photos.collections.videos",
        select = listOf("asset_id", "captured_at"),
        from = ASSETS,
        where_ = "kind = ? AND deleted_at IS NULL AND archived_at IS NULL",
        bind = listOf(Value(text = "video")),
        order = PageOrder(sort_column = "captured_at", pk_column = "asset_id", descending = true),
        with_held_thumbnail = true,
    )

    /**
     * `photos.collections.flagsScheme` — the first hop to the star.
     *
     * **THE FAVOURITE IS DERIVED, NEVER A COLUMN** (#916, ONT-03):
     * `media_asset.favorite` does not exist, and the star is the `starred`
     * concept in the flags scheme. So counting Favorites is three reads —
     * scheme, concept, tags — and the alternative would be a four-table join
     * written into `where_` from a shell, which is the vault's SQL living in a
     * Kotlin string.
     *
     * **NO SCHEME OR NO CONCEPT MEANS NOTHING IS STARRED, AND THAT IS NOT AN
     * ERROR** (`queries.rs`'s own words): a vault mints both the first time
     * something is starred, so a vault that has never starred anything simply
     * has neither row.
     *
     * The URI is spelled `https` deliberately and is not drift to tidy — a
     * `urn:`-style `:flags` reads as a NAMED PARAMETER in condition SQL (#258,
     * the colon-literal trap).
     */
    public fun flagsSchemeQuery(): PageQuery = PageQuery(
        name = "photos.collections.flagsScheme",
        select = listOf("scheme_id", "uri"),
        from = "core_concept_scheme",
        where_ = "uri = ?",
        bind = listOf(Value(text = FLAGS_SCHEME_URI)),
        order = PageOrder(sort_column = "scheme_id", pk_column = "scheme_id"),
    )

    /** `photos.collections.starredConcept` — the second hop. */
    public fun starredConceptQuery(schemeId: String): PageQuery = PageQuery(
        name = "photos.collections.starredConcept",
        select = listOf("concept_id", "notation"),
        from = "core_concept",
        where_ = "scheme_id = ? AND notation = ?",
        bind = listOf(Value(text = schemeId), Value(text = STARRED_NOTATION)),
        order = PageOrder(sort_column = "concept_id", pk_column = "concept_id"),
    )

    /**
     * `photos.collections.starredTags` — one row per starred photograph.
     *
     * The tag rows ARE the count: a tag targets the ASSET and never the content
     * item, and `(target_type, target_id, concept_id)` is unique, so counting
     * rows counts photographs without touching `media_asset` at all.
     */
    public fun starredTagsQuery(conceptId: String): PageQuery = PageQuery(
        name = "photos.collections.starredTags",
        select = listOf("tag_id", "target_id"),
        from = "core_tag",
        where_ = "target_type = ? AND concept_id = ?",
        bind = listOf(Value(text = TAG_TARGET_TYPE), Value(text = conceptId)),
        order = PageOrder(sort_column = "tag_id", pk_column = "tag_id"),
    )

    /**
     * `photos.collections.faces` — the People door and its badge, in one read.
     *
     * Two facts off one table rather than two predicates down two statements:
     * who is CONFIRMED (the door's count) and how many proposals are
     * UNANSWERED (the badge). `review_state` is the column that made the
     * second one expressible at all (#712) — before it, "rejected" was a
     * DELETE, so the enricher was free to propose the same stranger again and
     * the queue could never be finished.
     */
    public fun facesQuery(): PageQuery = PageQuery(
        name = "photos.collections.faces",
        select = listOf("region_id", "party_id", "review_state"),
        from = "media_face_region",
        order = PageOrder(sort_column = "region_id", pk_column = "region_id"),
    )

    /** `photos.collections.places`. */
    public fun placesQuery(): PageQuery = PageQuery(
        name = "photos.collections.places",
        select = listOf("place_id", "name"),
        from = "core_place",
        order = PageOrder(sort_column = "place_id", pk_column = "place_id"),
    )

    /**
     * `photos.collections.albumCovers` — the thumbnails an album's card stands
     * on, or null when there is nothing to look up.
     *
     * TWO WAYS IN, ONE STATEMENT. An album with a key photo names it by CONTENT
     * (`core_collection.cover_content_id`); one without falls back to its newest
     * entry, which names an ASSET — Apple Photos' rule, so an album a member
     * has just filled does not stand on an empty ground. `media_asset` and not
     * `core_collection`, because `with_held_thumbnail` correlates on
     * `{from}.content_id` and a table without one is refused at prepare.
     */
    public fun albumCoversQuery(contentIds: List<String>, assetIds: List<String>): PageQuery? {
        val contents = contentIds.filter { it.isNotEmpty() }.distinct()
        val assets = assetIds.filter { it.isNotEmpty() }.distinct()
        if (contents.isEmpty() && assets.isEmpty()) return null
        val clauses = buildList {
            if (contents.isNotEmpty()) add("content_id IN (" + contents.joinToString(", ") { "?" } + ")")
            if (assets.isNotEmpty()) add("asset_id IN (" + assets.joinToString(", ") { "?" } + ")")
        }
        return PageQuery(
            name = "photos.collections.albumCovers",
            select = listOf("asset_id", "content_id"),
            from = ASSETS,
            where_ = clauses.joinToString(" OR "),
            bind = (contents + assets).map { Value(text = it) },
            order = PageOrder(sort_column = "asset_id", pk_column = "asset_id"),
            with_held_thumbnail = true,
        )
    }

    /** The key photos' contents and the newest entries' assets, for [albumCoversQuery]. */
    public fun albumCoverKeys(albums: Scan, entries: Scan): Pair<List<String>, List<String>> {
        val keyed = albums.rows.map { it.text(ALBUM_COVER) }.filter { it.isNotEmpty() }
        val unkeyed = albums.rows.filter { it.text(ALBUM_COVER).isEmpty() }.map { it.text(0) }.toSet()
        val newest = newestEntries(entries.rows).filterKeys { it in unkeyed }.values.toList()
        return keyed to newest
    }

    /**
     * `photos.collections.memories`.
     *
     * Ordered by the primary key and not by `computed_at`, which is the same
     * decision the album list makes: this read counts, it does not display, and
     * the pk is the one column on the table that cannot be NULL.
     */
    public fun memoriesQuery(): PageQuery = PageQuery(
        name = "photos.collections.memories",
        select = listOf("memory_id"),
        from = "media_memory",
        order = PageOrder(sort_column = "memory_id", pk_column = "memory_id"),
    )

    /**
     * `photos.collections.duplicates` — the near-duplicate projection.
     *
     * `cluster_id IS NOT NULL` is the whole predicate: a phash with no cluster
     * is a photograph that looks like nothing else, which is the normal case
     * and not a duplicate. What a member resolves is a CLUSTER and not a row,
     * so the fold groups them — see [fold].
     */
    public fun duplicatesQuery(): PageQuery = PageQuery(
        name = "photos.collections.duplicates",
        select = listOf("asset_id", "cluster_id"),
        from = "media_asset_phash",
        where_ = "cluster_id IS NOT NULL",
        order = PageOrder(sort_column = "asset_id", pk_column = "asset_id"),
    )

    // -----------------------------------------------------------------------
    // The fold.
    // -----------------------------------------------------------------------

    /**
     * TEN ANSWERS, ONE SCREEN. Pure, so every line of it is provable with no
     * vault.
     *
     * The shelves come out in the order a member reads them — the standing four
     * first, then the albums — and that order is DECLARED here rather than
     * arriving from a read, because the four exist in a vault with no rows at
     * all and no statement can produce them.
     */
    @Suppress("LongParameterList")
    public fun fold(
        albums: Scan,
        albumsNextCursor: String?,
        entries: Scan,
        archive: Scan,
        trash: Scan,
        videos: Scan,
        starred: Scan,
        faces: Scan,
        places: Scan,
        memories: Scan,
        duplicates: Scan,
        covers: Scan = Scan(),
    ): PhotosCollectionsData {
        val sizes = albumSizes(entries.rows)
        val newest = newestEntries(entries.rows)
        val byContent = covers.rows.associate { it.text(COVER_CONTENT) to it.text(SHELF_THUMBNAIL) }
        val byAsset = covers.rows.associate { it.text(0) to it.text(SHELF_THUMBNAIL) }
        val proposals = faces.rows.count { it.text(FACE_REVIEW_STATE) == REVIEW_PROPOSED }
        val named = faces.rows
            .filter { it.text(FACE_REVIEW_STATE) == REVIEW_CONFIRMED }
            .map { it.text(FACE_PARTY) }
            .filter { it.isNotEmpty() }
            .distinct()
            .size
        val clusters = duplicateClusters(duplicates.rows)

        return PhotosCollectionsData(
            shelves = listOf(
                standing(
                    PhotoStateView.Mode.Kind.KIND_FAVORITES,
                    "Favorites",
                    starred.rows.size,
                    starred.capped,
                    // NO COVER: a favourite is a `core_tag` row and this read
                    // never reaches the photograph behind it.
                    cover = null,
                ),
                standing(
                    PhotoStateView.Mode.Kind.KIND_ARCHIVE,
                    "Archive",
                    archive.rows.size,
                    archive.capped,
                    cover = coverOf(archive.rows),
                ),
                standing(
                    PhotoStateView.Mode.Kind.KIND_TRASH,
                    "Trash",
                    trash.rows.size,
                    trash.capped,
                    cover = coverOf(trash.rows),
                ),
                standing(
                    PhotoStateView.Mode.Kind.KIND_VIDEOS,
                    "Videos",
                    videos.rows.size,
                    videos.capped,
                    cover = coverOf(videos.rows),
                ),
            ) + albums.rows.map { row ->
                val keyed = row.text(ALBUM_COVER)
                val cover = if (keyed.isNotEmpty()) byContent[keyed] else newest[row.text(0)]?.let { byAsset[it] }
                albumOf(row, sizes, entries.capped, cover?.ifEmpty { null })
            },
            doors = listOf(
                door(CollectionsDoor.Kind.KIND_PEOPLE, named, faces.capped, proposals),
                door(CollectionsDoor.Kind.KIND_PLACES, places.rows.size, places.capped, 0),
                door(CollectionsDoor.Kind.KIND_MEMORIES, memories.rows.size, memories.capped, 0),
                // A CLUSTER IS THE THING A MEMBER RESOLVES, so the badge and
                // the count are the same number here — every cluster on this
                // door is one decision still owed.
                door(CollectionsDoor.Kind.KIND_DUPLICATES, clusters, duplicates.capped, clusters),
            ),
            next_cursor = albumsNextCursor,
        )
    }

    /**
     * One standing shelf.
     *
     * `member_owned` is false for every one of them: a standing shelf cannot be
     * renamed or deleted, and the ROW says so rather than the view deriving it
     * from the oneof — so a fifth standing shelf does not need every menu
     * edited.
     */
    private fun standing(
        kind: PhotoStateView.Mode.Kind,
        title: String,
        count: Int,
        capped: Boolean,
        cover: String?,
    ): ShelfRow = ShelfRow(
        shelf = PhotoShelf(state_view = PhotoStateView(mode = PhotoStateView.Mode(kind = kind))),
        title = title,
        item_count = count,
        item_count_capped = capped,
        cover_thumbnail_path = cover,
        member_owned = false,
    )

    private fun door(
        kind: CollectionsDoor.Kind,
        count: Int,
        capped: Boolean,
        needsAttention: Int,
    ): CollectionsDoor = CollectionsDoor(
        kind = kind,
        count = count,
        count_capped = capped,
        needs_attention = needsAttention,
    )

    /**
     * One album row.
     *
     * `member_owned` is TRUE, which is the whole difference a menu reads: an
     * album can be renamed and deleted and a standing shelf cannot.
     *
     * **The title is the collection's `name` and the shelf carries it too**, and
     * that is not a duplication to tidy: `ShelfRow.title` is what THIS list
     * draws, and `PhotoShelf.Album.name` is what rides the route so the shelf
     * screen's app bar has a heading before its own read lands
     * (`navigation.ts:63-69`). One is a row in a list; the other is a parameter
     * to another screen.
     *
     * A collection with no name still becomes a row: dropping it would leave a
     * member with an album they made and cannot find. The views say "Untitled
     * album", which is a sentence rather than a blank line.
     *
     * **EVERY ALBUM'S COUNT IS CAPPED WHEN THE ENTRY PAGE WAS**, including an
     * album that looks empty. One read counts every album's entries at once, so
     * a page that filled may have stopped before this album's rows entirely —
     * "0" would then be a claim, and "at least 0" is the truth.
     */
    private fun albumOf(row: Row, sizes: Map<String, Int>, capped: Boolean, cover: String?): ShelfRow {
        val collectionId = row.text(0)
        val name = row.text(1)
        return ShelfRow(
            shelf = PhotoShelf(
                album = PhotoShelf.Album(collection_id = collectionId, name = name),
            ),
            title = name,
            item_count = sizes[collectionId] ?: 0,
            item_count_capped = capped,
            member_owned = true,
            cover_thumbnail_path = cover,
        )
    }

    /**
     * Each album's newest photograph, by the entry that filed it last. Entry
     * ids are minted in time order, so the greatest is the latest filing.
     */
    private fun newestEntries(entryRows: List<Row>): Map<String, String> {
        val newest = mutableMapOf<String, Pair<String, String>>()
        entryRows.forEach { row ->
            val collectionId = row.text(ENTRY_COLLECTION)
            val entryId = row.text(0)
            val target = row.text(ENTRY_TARGET)
            if (collectionId.isEmpty() || target.isEmpty()) return@forEach
            val held = newest[collectionId]
            if (held == null || entryId > held.first) newest[collectionId] = entryId to target
        }
        return newest.mapValues { it.value.second }
    }

    private fun albumSizes(entryRows: List<Row>): Map<String, Int> {
        val sizes = mutableMapOf<String, Int>()
        entryRows.forEach { row ->
            val collectionId = row.text(ENTRY_COLLECTION)
            if (collectionId.isNotEmpty()) sizes[collectionId] = (sizes[collectionId] ?: 0) + 1
        }
        return sizes
    }

    /**
     * HOW MANY GROUPS OF LOOK-ALIKES, NOT HOW MANY PHOTOGRAPHS.
     *
     * A cluster of one is not a duplicate of anything — `media_asset_phash`
     * carries the projection and a lone row in a cluster is a photograph that
     * happens to have been hashed — so a count of rows would tell a member they
     * have hundreds of duplicates when they have none.
     */
    private fun duplicateClusters(rows: List<Row>): Int = rows
        .map { it.text(PHASH_CLUSTER) }
        .filter { it.isNotEmpty() }
        .groupingBy { it }
        .eachCount()
        .count { it.value > 1 }

    /**
     * The newest row on a shelf that has a thumbnail, as the shelf's cover.
     *
     * Each shelf read is ordered as the shelf itself is ordered, so "first row
     * with an image" is "the newest photograph this device can draw" and never
     * an arbitrary pick. Null when none of them has one, which is a real answer
     * on a device that has not copied these bytes.
     */
    private fun coverOf(rows: List<Row>): String? = rows
        .asSequence()
        .map { it.text(SHELF_THUMBNAIL) }
        .firstOrNull { it.isNotEmpty() }

    // -----------------------------------------------------------------------
    // The events.
    // -----------------------------------------------------------------------

    /** The finished screen, as the machine's `DataArrived`. */
    public fun arrived(data: PhotosCollectionsData): PhotosCollectionsEvent =
        PhotosCollectionsEvent(data_ = PhotosCollectionsEvent.DataArrived(data_ = data))

    public fun refused(failure: ReadFailure): PhotosCollectionsEvent =
        PhotosCollectionsEvent(refused = PhotosCollectionsEvent.ReadRefused(failure = failure))

    override val appId: String = "photos"

    /**
     * The outcome of a create or a delete, as this screen's own settle event.
     *
     * **ONE EVENT FOR BOTH VERBS, and it carries no verb.** The screen does not
     * branch on which write settled: a create that committed closes the sheet
     * and a delete that committed does nothing, and both redraw through the
     * change event the commit itself produced. A verb here would be a third
     * place the shell has to keep in step with the two `SubmitWrite`s.
     *
     * `QUEUED`, `IN_FLIGHT` and `PARKED` are NOT committed. They mean "somewhere
     * durable, not yet committed", and a sheet that closed on one would be the
     * shell claiming an album exists that does not — the exact claim
     * `NotesEditorMachine` refuses to make about a save.
     */
    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): PhotosCollectionsEvent =
        PhotosCollectionsEvent(
            write_settled = PhotosCollectionsEvent.WriteSettled(
                committed = status == CommandStatus.COMMAND_STATUS_EXECUTED,
                // THE CORE'S OWN SENTENCE, when it has one, and never one
                // composed here out of an error: `Error.detail` is logs-only,
                // and a shell that made its own from a peer's words would be
                // the hole in that rule.
                sentence = sentence,
            ),
        )

    // -----------------------------------------------------------------------
    // The vocabulary these statements bind, restated from `crates/apps/photos`.
    // -----------------------------------------------------------------------

    /** Tags and album entries target the ASSET, never the content item. */
    public const val TAG_TARGET_TYPE: String = "media.asset"

    public const val FLAGS_SCHEME_URI: String = "https://centraid.dev/schemes/flags"

    public const val STARRED_NOTATION: String = "starred"

    private const val ASSETS: String = "media_asset"

    private const val REVIEW_PROPOSED: String = "proposed"

    private const val REVIEW_CONFIRMED: String = "confirmed"

    private const val ENTRY_COLLECTION: Int = 1

    private const val ENTRY_TARGET: Int = 2

    private const val ALBUM_COVER: Int = 2

    private const val COVER_CONTENT: Int = 1

    private const val FACE_PARTY: Int = 1

    private const val FACE_REVIEW_STATE: Int = 2

    private const val PHASH_CLUSTER: Int = 1

    /**
     * After the two named columns of every shelf statement.
     *
     * The door appends `thumbnail_path` after whatever `select` named, so this
     * index moves with those `select` lists and nowhere else — which is why all
     * three shelf statements project exactly two columns.
     */
    private const val SHELF_THUMBNAIL: Int = 2

    /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""
}
