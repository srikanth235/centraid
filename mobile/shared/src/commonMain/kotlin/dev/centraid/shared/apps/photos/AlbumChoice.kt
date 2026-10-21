package dev.centraid.shared.apps.photos

import centraid.core.v1.Page
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.AlbumChoiceEntry
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * "ADD TO ALBUM", ONCE, FOR EVERY SCREEN THAT OFFERS IT (#1029, the photos
 * port).
 *
 * v0 asked "which album?" from four surfaces through four `Alert.alert`s with a
 * row per album, and one of them sliced its list to six because an alert has no
 * scroll (`PhotosChoiceSheet.tsx`). The lightbox, the library grid and a shelf
 * all put a pick into an album, so the list, the statement behind it and the
 * writes it ends in are here and nowhere else — and the screens carry the answer
 * as `repeated AlbumChoiceEntry album_choices` beside `bool album_choice_open`.
 *
 * ## HOW A HOST SCREEN USES THIS
 *
 * 1. `AlbumChoiceOpened` → set `album_choice_open`, emit [openEffects].
 * 2. The bridge calls [attach] once, which serves that effect: it runs the
 *    reads below and hands the rows to the screen's own `AlbumChoicesArrived`
 *    arm, which stores them on `album_choices`.
 * 3. `AlbumChosen` → close the sheet, emit [addEffects] over the pick.
 * 4. `AlbumChoiceCreated` → emit [createEffects], and KEEP THE SHEET OPEN.
 * 5. `rowsChanged` on a table [movesChoices] names → while the sheet is open,
 *    emit [openEffects] again, which is what puts a new album in the list.
 *
 * ## "NEW ALBUM…" IS TWO TAPS, AND THAT IS THE HONEST COST
 *
 * `container.create` takes an optional `id` (#922 G2), and
 * a pure reducer has no clock and no randomness to mint one with. The vault
 * mints it, and `ScreenWrites.settled` is `(status, sentence, invokeKey)` —
 * **the command's output never reaches a screen** — so the id the pick would
 * go into is not known when the create settles. The create's own commit moves
 * `entity` and `container`, the host re-reads the list, and the new album is there for
 * the tap that finishes the job.
 *
 * Emitting the create and the adds together would not work either: the runner
 * launches one coroutine per write, so the adds would race the album they need
 * and lose on `edge_joins_what_it_may`.
 *
 * ## WHAT A PICK OF MANY DOES
 *
 * One `edge.add` per photograph — the vault registers it over a single
 * `from`/`to` pair — keyed on the album and the photograph. A photograph already in the
 * album is a no-op (an edge is idempotent), and a refused one carries the vault's own sentence,
 * which the host's `write_failure` shows; the others land.
 */
public object AlbumChoice {
    /** `photos.albumChoice.albums` — the list the sheet draws. */
    public const val ALBUMS_QUERY_NAME: String = "photos.albumChoice.albums"

    /** `photos.albumChoice.entries` — how many photographs each album holds. */
    public const val ENTRIES_QUERY_NAME: String = "photos.albumChoice.entries"

    /** `photos.albumChoice.covers` — the asset and thumbnail behind each cover. */
    public const val COVERS_QUERY_NAME: String = "photos.albumChoice.covers"

    /**
     * The `ReadPage.screenId` a host emits to ask for the list.
     *
     * Not the host's own screen id: the host's runner serves ITS page for that
     * id, and the list is a second read [attach] serves beside it.
     */
    public const val READ_ID: String = "photos.albumChoice"

    /** `edge.add` of a `contains` edge, as the VAULT registers it — never the app action. */
    public const val ADD_COMMAND: String = PhotoWrites.EDGE_ADD

    /** `container.create` of an album. */
    public const val CREATE_COMMAND: String = PhotoWrites.CREATE_CONTAINER

    /** The create's key: it is about no photograph, and `container.create` is shared. */
    public const val CREATE_KEY: String = PhotoWrites.KEY_CREATE_ALBUM

    /**
     * Albums are "owner-curated and small" (`crates/apps/photos`' own
     * `albums_statement`); the Collections list reads a hundred a page. The
     * sheet reads one page and does not walk — a member choosing an album is
     * scrolling a list they made, and two hundred is past any list a person
     * scrolls to find a name.
     */
    public const val ALBUM_LIMIT: Int = 200

    /** The door's own ceiling (`MAX_PAGE_ROWS`); the counts are floors past it. */
    public const val ENTRY_LIMIT: Int = 500

    private const val ASSET_TABLE: String = "photo"
    private const val ENTITY_TABLE: String = "entity"
    private const val CONTAINER_TABLE: String = "container"
    private const val EDGE_TABLE: String = "edge"
    private val CHOICE_TABLES: Set<String> = setOf(ENTITY_TABLE, CONTAINER_TABLE, EDGE_TABLE)

    /** `photos.albumChoice.coverBlobs` — each album's chosen cover. */
    public const val COVER_BLOBS_QUERY_NAME: String = "photos.albumChoice.coverBlobs"

    /**
     * THE MEMBER'S ALBUMS, BY NAME.
     *
     * An album's name is its `entity`'s title, and the entity is where the trash
     * lives too, so this pages `entity` rows of kind `album` that are not in the
     * trash. By `title` because a member finds an album by reading its name, and
     * `title` is `NOT NULL` — so this is a sort the door can continue, unlike
     * every nullable timestamp on this app's tables. The id breaks ties between
     * two albums called "Trip".
     *
     * `kind = 'album'`: `entity` holds every kind of thing, and a photograph
     * offered a notebook here would be refused by the vault anyway
     * (`edge_joins_what_it_may`).
     */
    public fun albumsQuery(): PageQuery = PageQuery(
        name = ALBUMS_QUERY_NAME,
        select = listOf("id", "title"),
        from = ENTITY_TABLE,
        where_ = "kind = ? AND deleted_at IS NULL",
        bind = listOf(Value(text = PhotosCollectionsReads.ALBUM_KIND)),
        order = PageOrder(sort_column = "title", pk_column = "id"),
    )

    /**
     * Each album's cover: the photograph's blob a member chose, or none. A second
     * read because the cover is the `container`'s and the name is the `entity`'s.
     */
    public fun coversOfQuery(albumIds: List<String>): PageQuery? {
        val ids = albumIds.filter { it.isNotEmpty() }.distinct()
        if (ids.isEmpty()) return null
        return PageQuery(
            name = COVER_BLOBS_QUERY_NAME,
            select = listOf("id", "cover"),
            from = CONTAINER_TABLE,
            where_ = "id IN (" + ids.joinToString(", ") { "?" } + ")",
            bind = ids.map { Value(text = it) },
            order = PageOrder(sort_column = "id", pk_column = "id"),
        )
    }

    /**
     * Every album's live photographs, as rows to count: the `contains` edges whose
     * photograph is not in the trash. A trashed photograph keeps its membership
     * (a restore brings it back) and is not counted while it is in the trash.
     *
     * An edge has no id of its own, and `(from_id, to_id)` is unique under one
     * `rel`, so the album and the photograph are the keyset.
     */
    public fun entriesQuery(): PageQuery = PageQuery(
        name = ENTRIES_QUERY_NAME,
        select = listOf("from_id", "to_id", "position"),
        from = EDGE_TABLE,
        where_ = "rel = 'contains' AND to_id IN (SELECT id FROM entity WHERE kind = 'photo' AND deleted_at IS NULL)",
        order = PageOrder(sort_column = "from_id", pk_column = "to_id"),
    )

    /**
     * The photographs behind the covers, with their thumbnails, or null when no
     * album has one: a chosen cover is a photograph's blob, and an album with none
     * draws its first member.
     *
     * `photo` and not `container`, because `with_held_thumbnail` correlates on
     * `{from}.blob` and a table without one is refused at prepare.
     */
    public fun coversQuery(coverBlobs: List<String>, firstMembers: List<String>): PageQuery? {
        val blobs = coverBlobs.filter { it.isNotEmpty() }.distinct()
        val members = firstMembers.filter { it.isNotEmpty() }.distinct()
        if (blobs.isEmpty() && members.isEmpty()) return null
        val clauses = buildList {
            if (blobs.isNotEmpty()) add("blob IN (" + blobs.joinToString(", ") { "?" } + ")")
            if (members.isNotEmpty()) add("id IN (" + members.joinToString(", ") { "?" } + ")")
        }
        return PageQuery(
            name = COVERS_QUERY_NAME,
            select = listOf("id", "blob"),
            from = ASSET_TABLE,
            where_ = clauses.joinToString(" OR "),
            bind = (blobs + members).map { Value(text = it) },
            order = PageOrder(sort_column = "id", pk_column = "id"),
            with_held_thumbnail = true,
        )
    }

    /** The albums page alone: names, no counts, no covers. */
    public fun rows(page: Page): List<AlbumChoiceRow> = rows(page.rows, emptyMap(), emptyList(), emptyList())

    /**
     * THREE READS, ONE LIST, pure — so all of it is provable with no vault.
     *
     * [coverBlob] is each album's chosen cover (an album with none is absent).
     * Every count is capped when the entry page was: one read counts every
     * album's entries at once, so a page that filled may have stopped before
     * this album's rows entirely, and "0" would then be a claim.
     */
    public fun rows(
        albumRows: List<Row>,
        coverBlob: Map<String, String>,
        entryRows: List<Row>,
        coverRows: List<Row>,
        entriesCapped: Boolean = false,
    ): List<AlbumChoiceRow> {
        val sizes = mutableMapOf<String, Long>()
        val first = firstMembers(entryRows)
        entryRows.forEach { row ->
            val album = row.text(ENTRY_ALBUM)
            if (album.isNotEmpty()) sizes[album] = (sizes[album] ?: 0L) + 1L
        }
        val byBlob = mutableMapOf<String, Row>()
        val byId = mutableMapOf<String, Row>()
        coverRows.forEach { row ->
            byBlob[row.text(COVER_BLOB)] = row
            byId[row.text(COVER_ASSET)] = row
        }
        return albumRows.map { row ->
            val albumId = row.text(ALBUM_ID)
            // THE CHOSEN COVER, else the album's first member.
            val cover = coverBlob[albumId]?.let { byBlob[it] } ?: first[albumId]?.let { byId[it] }
            val thumbnail = cover?.text(COVER_THUMBNAIL).orEmpty()
            AlbumChoiceRow(
                albumId = albumId,
                title = row.text(ALBUM_TITLE),
                count = sizes[albumId] ?: 0L,
                coverAssetId = cover?.text(COVER_ASSET)?.ifEmpty { null },
                coverThumbnailPath = thumbnail.ifEmpty { null },
                countCapped = entriesCapped,
            )
        }
    }

    /** Each album's first member: the lowest position, ties by id. */
    internal fun firstMembers(entryRows: List<Row>): Map<String, String> {
        val best = mutableMapOf<String, Triple<Double, String, String>>()
        entryRows.forEach { row ->
            val album = row.text(ENTRY_ALBUM)
            val photo = row.text(ENTRY_PHOTO)
            if (album.isEmpty() || photo.isEmpty()) return@forEach
            val position = row.values.getOrNull(ENTRY_POSITION)?.let { it.real ?: it.integer?.toDouble() } ?: 0.0
            val held = best[album]
            if (held == null || position < held.first || (position == held.first && photo < held.third)) {
                best[album] = Triple(position, album, photo)
            }
        }
        return best.mapValues { it.value.third }
    }

    /** The rows, as the wire carries them on every host screen's state. */
    public fun entries(rows: List<AlbumChoiceRow>): List<AlbumChoiceEntry> = rows.map { row ->
        AlbumChoiceEntry(
            album_id = row.albumId,
            title = row.title,
            count = row.count,
            cover_asset_id = row.coverAssetId ?: "",
            cover_thumbnail_path = row.coverThumbnailPath,
            count_capped = row.countCapped,
        )
    }

    /** What a host emits when the sheet opens, and again when an album moves. */
    public fun openEffects(): List<ScreenEffect> =
        listOf(ScreenEffect.ReadPage(READ_ID, afterCursor = null))

    /**
     * Does a change on [table] move the list? The albums themselves (`entity` for a
     * name, `container` for a cover), and their members (`edge`) — which is what a
     * count is made of.
     */
    public fun movesChoices(table: String): Boolean = table in CHOICE_TABLES

    /**
     * ONE `edge.add` PER PICKED PHOTOGRAPH.
     *
     * CONTENT-DERIVED, NEVER AN ORDINAL: the intent is "this photograph into
     * that album", so that is the key — and it ends in the asset id, which is
     * what lets a host's settle recover the row (`PhotoShelfReads.
     * assetOfInvokeKey`).
     */
    public fun addEffects(assetIds: List<String>, albumId: String): List<ScreenEffect> {
        if (albumId.isEmpty()) return emptyList()
        return assetIds.filter { it.isNotEmpty() }.distinct().map { assetId ->
            ScreenEffect.SubmitWrite(
                command = ADD_COMMAND,
                inputJson = PhotoWrites.membership(albumId, assetId),
                invokeKey = "$ADD_COMMAND:$albumId:$assetId",
            )
        }
    }

    /**
     * "NEW ALBUM…" — the create alone. See the class note for why the adds do
     * not ride with it.
     *
     * An empty name is not a write: `title` is `minLength: 1` and the vault
     * would refuse it. The key is `PhotosCollectionsMachine`'s, so a name typed
     * on Collections and the same name typed here are the same intent for the
     * answer's sake; it makes no second create one (R-1088-12), and the sheet's
     * field, which clears on Create, is what stops a repeat.
     */
    public fun createEffects(title: String): List<ScreenEffect> {
        val name = title.trim()
        if (name.isEmpty()) return emptyList()
        return listOf(
            ScreenEffect.SubmitWrite(
                command = CREATE_COMMAND,
                inputJson = PhotoWrites.createAlbum(name),
                invokeKey = "$CREATE_KEY:$name",
            ),
        )
    }

    /**
     * THE THREE READS, AGAINST THE CORE. Null when the albums themselves could
     * not be read; the counts and covers are amendments, and a list without
     * them is still the list.
     */
    internal suspend fun load(session: HomeSession): List<AlbumChoiceEntry>? {
        val core = session.shelf.core()
        val albums = core.photosPage(albumsQuery(), limit = ALBUM_LIMIT) as? PhotosPage.Rows
            ?: return null
        val entries = core.photosPage(entriesQuery(), limit = ENTRY_LIMIT) as? PhotosPage.Rows
        val containers = coversOfQuery(albums.rows.map { it.text(ALBUM_ID) })?.let { query ->
            core.photosPage(query, limit = ALBUM_LIMIT) as? PhotosPage.Rows
        }
        val coverBlob = containers?.rows.orEmpty()
            .filter { it.text(CONTAINER_COVER).isNotEmpty() }
            .associate { it.text(CONTAINER_ID) to it.text(CONTAINER_COVER) }
        val first = firstMembers(entries?.rows.orEmpty())
        val chosen = albums.rows.map { it.text(ALBUM_ID) }
        val covers = coversQuery(
            coverBlobs = coverBlob.values.toList(),
            firstMembers = chosen.filter { it !in coverBlob }.mapNotNull { first[it] },
        )?.let { query ->
            core.photosPage(query, limit = ENTRY_LIMIT) as? PhotosPage.Rows
        }
        return entries(
            rows(
                albumRows = albums.rows,
                coverBlob = coverBlob,
                entryRows = entries?.rows.orEmpty(),
                coverRows = covers?.rows.orEmpty(),
                entriesCapped = entries == null || entries.nextCursor != null,
            ),
        )
    }

    /**
     * SERVE [READ_ID] FOR ONE HOST. Call once, from the host's bridge `attach`,
     * beside whatever serves the host's own page.
     *
     * A collector of its own on `host.effects`, which is a `SharedFlow` every
     * subscriber sees in full, so it sits beside `ScreenRuntime` without taking
     * anything from it. UNDISPATCHED for `ScreenRuntime.start`'s reason: a
     * `SharedFlow` with no subscriber drops what is emitted.
     *
     * A REFUSED list arrives EMPTY. The sheet's "New album…" row is still there,
     * and a sheet that hung on a spinner over a refusal would be a sheet the
     * member cannot leave by doing anything useful.
     */
    public fun <S, E> attach(
        session: HomeSession,
        host: ScreenHost<S, E>,
        scope: CoroutineScope,
        arrived: (List<AlbumChoiceEntry>) -> E,
    ): Job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
        host.effects.collect { effect ->
            if (effect is ScreenEffect.ReadPage && effect.screenId == READ_ID) {
                scope.launch { host.send(arrived(load(session).orEmpty())) }
            }
        }
    }

    private const val ALBUM_ID: Int = 0
    private const val ALBUM_TITLE: Int = 1
    private const val CONTAINER_ID: Int = 0
    private const val CONTAINER_COVER: Int = 1
    private const val ENTRY_ALBUM: Int = 0
    private const val ENTRY_PHOTO: Int = 1
    private const val ENTRY_POSITION: Int = 2
    private const val COVER_ASSET: Int = 0
    private const val COVER_BLOB: Int = 1

    /** The door APPENDS `thumbnail_path` after the two named columns. */
    private const val COVER_THUMBNAIL: Int = 2

    /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""
}

/** One album a pick can go into, before it is put on the wire. */
public data class AlbumChoiceRow(
    val albumId: String,
    val title: String,
    val count: Long,
    val coverAssetId: String?,
    val coverThumbnailPath: String? = null,
    val countCapped: Boolean = false,
)
