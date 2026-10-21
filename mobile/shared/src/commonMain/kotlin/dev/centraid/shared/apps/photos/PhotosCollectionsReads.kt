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
 * WHAT COLLECTIONS READS (#1029, the photos port; #1135).
 *
 * ## THIS IS NOT A `ScreenReads`, AND THE REASON IS A CONTRACT FINDING
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
 * | the albums' names | `entity` of kind `album` |
 * | an album's cover | `container.cover` |
 * | an album's size | `edge` (`contains`) |
 * | Archive, Trash, Videos | `photo` under three predicates |
 * | Favorites | `edge` (`tagged` to `flag:starred`) |
 * | Places | `entity` of kind `place` |
 * | Duplicates | the `photos.duplicates` app query |
 *
 * Those answers cannot be chained through the reducer, and the type system is
 * what says so: **`PhotosCollectionsState`'s content is a protobuf `oneof`**,
 * so `loading` and `data` cannot both be set and there is nowhere to hold seven
 * answers while the eighth is in flight. Wire enforces it in the constructor,
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
 * counted, which is the defect `HomeTile.count.capped` exists to
 * prevent. Nothing here rounds, estimates or extrapolates: it counts what it
 * was handed and says whether that was all of it.
 *
 * ## THE COVERS THAT ARE HERE, AND THE ONES THAT ARE NOT
 *
 * Archive, Trash and Videos each read their own shelf in the shelf's own
 * order, so the newest row on each IS the cover and its thumbnail comes down
 * the same statement (`with_held_thumbnail`). Favorites get none: a favourite
 * is an edge and this read never touches the photograph behind it. An album's
 * cover is `container.cover` — a blob hash, and a column `with_held_thumbnail`
 * cannot correlate on, because it joins `{from}.blob` and a table without one
 * is REFUSED at prepare — so the albums get theirs from a second read over
 * `photo` ([albumCoversQuery]): the chosen photograph, else the album's first
 * member. Absent is still a real answer; the views draw the empty cover
 * themselves, which is what the field says to do.
 */
public object PhotosCollectionsReads :
    ScreenWrites<PhotosCollectionsState, PhotosCollectionsEvent> {
    /** `entity`, the table the albums' names live on and the machine's `rowsChanged` declares first. */
    public const val TABLE: String = "entity"

    /**
     * `entity.kind` for an album. The table holds every kind, and every album read
     * in this app binds this — the vault's own word, spelled once.
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
     * `captured_at`, `deleted_at` and the core's cluster are all
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
     * `photos.collections.albums` — the member's own albums, by name.
     *
     * An album's name is its `entity`'s title and the trash is the entity's, so
     * this pages `entity` rows of kind `album` that are not in the trash, ordered
     * `title, id`. A title is `NOT NULL`, which is what makes this the one read
     * here that can honestly be walked for a second page.
     */
    public fun albumsQuery(): PageQuery = PageQuery(
        name = "photos.collections.albums",
        select = listOf("id", "title"),
        from = TABLE,
        where_ = "kind = ? AND deleted_at IS NULL",
        bind = listOf(Value(text = ALBUM_KIND)),
        order = PageOrder(sort_column = "title", pk_column = "id"),
    )

    /** `photos.collections.albumEntries` — how many live photographs each album holds. */
    public fun albumEntriesQuery(): PageQuery = AlbumChoice.entriesQuery().copy(name = "photos.collections.albumEntries")

    /**
     * `photos.collections.albumCoverBlobs` — each album's chosen key photo, a
     * photograph's blob, from the `container`. A second read because the cover is
     * the container's and the name is the entity's.
     */
    public fun albumCoverBlobsQuery(albumIds: List<String>): PageQuery? =
        AlbumChoice.coversOfQuery(albumIds)?.copy(name = "photos.collections.albumCoverBlobs")

    /**
     * `photos.collections.archive` — the shelf, in the shelf's own order.
     *
     * A read PER SHELF rather than one scan of `photo` partitioned afterwards, and
     * the difference is the quality of the floor: five hundred rows of the archive
     * counts five hundred archived photographs, where five hundred rows of the
     * whole library might contain three. The cover comes free with it — the newest
     * row on the shelf is the shelf's cover, and its thumbnail rides the same
     * statement.
     *
     * Not trashed beside `archived` is the app's own pairing (#419): a photograph
     * archived and then thrown away is on the trash shelf only.
     */
    public fun archiveQuery(): PageQuery = PageQuery(
        name = "photos.collections.archive",
        select = listOf("id", "taken_at"),
        from = ASSETS,
        where_ = "${PhotoFold.NOT_TRASHED} AND ${PhotoFold.ARCHIVED}",
        order = PageOrder(sort_column = "taken_at", pk_column = "id", descending = true),
        with_held_thumbnail = true,
    )

    /**
     * `photos.collections.trash` — the trash shelf, counted. It sorts by id, as the
     * shelf does (R-1135-5-17: the trash stamp is the entity's).
     */
    public fun trashQuery(): PageQuery = PageQuery(
        name = "photos.collections.trash",
        select = listOf("id", "taken_at"),
        from = ASSETS,
        where_ = PhotoFold.TRASHED,
        order = PageOrder(sort_column = "id", pk_column = "id", descending = true),
        with_held_thumbnail = true,
    )

    /**
     * `photos.collections.videos` — the library predicate, narrowed to one form.
     *
     * Videos is a shelf of the LIVE library and not of everything: a video in
     * the trash is in the trash, and counting it here would put one photograph
     * on two shelves whose whole point is that they are different places.
     */
    public fun videosQuery(): PageQuery = PageQuery(
        name = "photos.collections.videos",
        select = listOf("id", "taken_at"),
        from = ASSETS,
        where_ = "form = ? AND ${PhotoFold.LIVE}",
        bind = listOf(Value(text = "video")),
        order = PageOrder(sort_column = "taken_at", pk_column = "id", descending = true),
        with_held_thumbnail = true,
    )

    /**
     * `photos.collections.starred` — one row per starred live photograph: the
     * `tagged` edges to `flag:starred` whose photograph is not in the trash.
     *
     * **THE FAVOURITE IS DERIVED, NEVER A COLUMN** (#916, ONT-03): a star is an
     * edge, and rows counted are photographs counted. An edge has no id of its own
     * and `(from_id, to_id)` is unique, so the photograph and the flag are the
     * keyset.
     */
    public fun starredQuery(): PageQuery = PageQuery(
        name = "photos.collections.starred",
        select = listOf("from_id", "to_id"),
        from = "edge",
        where_ = "rel = 'tagged' AND to_id = 'flag:starred' AND " +
            "from_id IN (SELECT id FROM entity WHERE kind = 'photo' AND deleted_at IS NULL)",
        order = PageOrder(sort_column = "from_id", pk_column = "to_id"),
    )

    /** `photos.collections.places` — the places that are not in the trash. */
    public fun placesQuery(): PageQuery = PageQuery(
        name = "photos.collections.places",
        select = listOf("id", "title"),
        from = TABLE,
        where_ = "kind = 'place' AND deleted_at IS NULL",
        order = PageOrder(sort_column = "id", pk_column = "id"),
    )

    /**
     * `photos.collections.albumCovers` — the thumbnails an album's card stands
     * on, or null when there is nothing to look up: the chosen key photographs'
     * blobs, and the first member of an album that has none.
     */
    public fun albumCoversQuery(coverBlobs: List<String>, firstMembers: List<String>): PageQuery? =
        AlbumChoice.coversQuery(coverBlobs, firstMembers)?.copy(name = "photos.collections.albumCovers")

    // -----------------------------------------------------------------------
    // The fold.
    // -----------------------------------------------------------------------

    /**
     * EIGHT ANSWERS, ONE SCREEN. Pure, so every line of it is provable with no
     * vault.
     *
     * The shelves come out in the order a member reads them — the standing four
     * first, then the albums — and that order is DECLARED here rather than
     * arriving from a read, because the four exist in a vault with no rows at
     * all and no statement can produce them.
     *
     * [coverBlob] is each album's chosen key photograph (an album with none is
     * absent); [duplicateClusters] is how many groups of look-alikes the app query
     * answered, and [duplicatesCapped] says whether it stopped at its ceiling.
     */
    @Suppress("LongParameterList")
    public fun fold(
        albums: Scan,
        albumsNextCursor: String?,
        coverBlob: Map<String, String>,
        entries: Scan,
        archive: Scan,
        trash: Scan,
        videos: Scan,
        starred: Scan,
        places: Scan,
        duplicateClusters: Int,
        duplicatesCapped: Boolean = false,
        covers: Scan = Scan(),
    ): PhotosCollectionsData {
        val sizes = albumSizes(entries.rows)
        val first = AlbumChoice.firstMembers(entries.rows)
        val byBlob = covers.rows.associate { it.text(COVER_BLOB) to it.text(SHELF_THUMBNAIL) }
        val byId = covers.rows.associate { it.text(0) to it.text(SHELF_THUMBNAIL) }

        return PhotosCollectionsData(
            shelves = listOf(
                standing(
                    PhotoStateView.Mode.Kind.KIND_FAVORITES,
                    "Favorites",
                    starred.rows.size,
                    starred.capped,
                    // NO COVER: a favourite is an edge and this read never
                    // reaches the photograph behind it.
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
                val id = row.text(0)
                // THE CHOSEN KEY PHOTOGRAPH, else the album's first member.
                val cover = coverBlob[id]?.let { byBlob[it] } ?: first[id]?.let { byId[it] }
                albumOf(row, sizes, entries.capped, cover?.ifEmpty { null })
            },
            doors = listOf(
                door(CollectionsDoor.Kind.KIND_PLACES, places.rows.size, places.capped, 0),
                // A CLUSTER IS THE THING A MEMBER RESOLVES, so the badge and
                // the count are the same number here — every cluster on this
                // door is one decision still owed.
                door(CollectionsDoor.Kind.KIND_DUPLICATES, duplicateClusters, duplicatesCapped, duplicateClusters),
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

    private fun albumSizes(entryRows: List<Row>): Map<String, Int> {
        val sizes = mutableMapOf<String, Int>()
        entryRows.forEach { row ->
            val collectionId = row.text(ENTRY_ALBUM)
            if (collectionId.isNotEmpty()) sizes[collectionId] = (sizes[collectionId] ?: 0) + 1
        }
        return sizes
    }

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
                invoke_key = invokeKey,
            ),
        )

    // -----------------------------------------------------------------------
    // The vocabulary these statements bind.
    // -----------------------------------------------------------------------

    private const val ASSETS: String = "photo"

    private const val ENTRY_ALBUM: Int = 0

    /** The blob of a cover row: `id, blob`, then the door's appended thumbnail. */
    private const val COVER_BLOB: Int = 1

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
