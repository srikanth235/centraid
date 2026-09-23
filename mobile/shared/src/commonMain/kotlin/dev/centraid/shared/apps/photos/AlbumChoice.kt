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
 * `media.create_album` takes an optional seat-minted `album_id` (#922 G2), and
 * a pure reducer has no clock and no randomness to mint one with. The vault
 * mints it, and `ScreenWrites.settled` is `(status, sentence, invokeKey)` —
 * **the command's output never reaches a screen** — so the id the pick would
 * go into is not known when the create settles. The create's own commit moves
 * `core_collection`, the host re-reads the list, and the new album is there for
 * the tap that finishes the job. `FaceReviewMachine` pays the same price for
 * the same reason with a new person's name.
 *
 * Emitting the create and the adds together would not work either: the runner
 * launches one coroutine per write, so the adds would race the album they need
 * and lose on `album_exists`.
 *
 * ## WHAT A PICK OF MANY DOES
 *
 * One `media.add_to_album` per asset — the vault registers it over a single
 * `asset_id` — keyed on the album and the asset. A photograph already in the
 * album is REFUSED by `not_already_in_album` with the vault's own sentence,
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

    /** `media.add_to_album`, as the VAULT registers it — never the app action. */
    public const val ADD_COMMAND: String = "media.add_to_album"

    /** `media.create_album`. */
    public const val CREATE_COMMAND: String = "media.create_album"

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

    private const val COLLECTION_TABLE: String = "core_collection"
    private const val ENTRY_TABLE: String = "core_collection_entry"
    private const val ASSET_TABLE: String = "media_asset"
    private const val ASSET_TARGET_TYPE: String = "media.asset"

    /**
     * THE MEMBER'S ALBUMS, BY NAME.
     *
     * By `name` because a member finds an album by reading its name, and
     * `core_collection.name` is `NOT NULL` — so this is a sort the door can
     * continue, unlike every nullable timestamp on this app's tables. The
     * primary key breaks ties between two albums called "Trip".
     *
     * `cover_content_id` rides along for [coversQuery]: it names a CONTENT
     * item, and the asset behind it is a second read.
     */
    public fun albumsQuery(): PageQuery = PageQuery(
        name = ALBUMS_QUERY_NAME,
        select = listOf("collection_id", "name", "cover_content_id"),
        from = COLLECTION_TABLE,
        order = PageOrder(sort_column = "name", pk_column = "collection_id"),
    )

    /**
     * Every album's photographs, as rows to count.
     *
     * `target_type = 'media.asset'` because `core_collection_entry` is
     * polymorphic and a notebook's notes live in it too.
     */
    public fun entriesQuery(): PageQuery = PageQuery(
        name = ENTRIES_QUERY_NAME,
        select = listOf("entry_id", "collection_id", "target_id"),
        from = ENTRY_TABLE,
        where_ = "target_type = ?",
        bind = listOf(Value(text = ASSET_TARGET_TYPE)),
        order = PageOrder(sort_column = "entry_id", pk_column = "entry_id"),
    )

    /**
     * The assets behind the covers, with their thumbnails, or null when no
     * album has a cover.
     *
     * `media_asset` and not `core_collection`, because `with_held_thumbnail`
     * correlates on `{from}.content_id` and a table without one is refused at
     * prepare.
     */
    public fun coversQuery(coverContentIds: List<String>): PageQuery? {
        val ids = coverContentIds.filter { it.isNotEmpty() }.distinct()
        if (ids.isEmpty()) return null
        return PageQuery(
            name = COVERS_QUERY_NAME,
            select = listOf("asset_id", "content_id"),
            from = ASSET_TABLE,
            where_ = "content_id IN (" + ids.joinToString(", ") { "?" } + ")",
            bind = ids.map { Value(text = it) },
            order = PageOrder(sort_column = "asset_id", pk_column = "asset_id"),
            with_held_thumbnail = true,
        )
    }

    /** The albums page alone: names, no counts, no covers. */
    public fun rows(page: Page): List<AlbumChoiceRow> = rows(page.rows, emptyList(), emptyList())

    /**
     * THREE READS, ONE LIST, pure — so all of it is provable with no vault.
     *
     * Every count is capped when the entry page was: one read counts every
     * album's entries at once, so a page that filled may have stopped before
     * this album's rows entirely, and "0" would then be a claim.
     */
    public fun rows(
        albumRows: List<Row>,
        entryRows: List<Row>,
        coverRows: List<Row>,
        entriesCapped: Boolean = false,
    ): List<AlbumChoiceRow> {
        val sizes = mutableMapOf<String, Long>()
        entryRows.forEach { row ->
            val album = row.text(ENTRY_COLLECTION)
            if (album.isNotEmpty()) sizes[album] = (sizes[album] ?: 0L) + 1L
        }
        val coverAsset = mutableMapOf<String, String>()
        val coverThumbnail = mutableMapOf<String, String>()
        coverRows.forEach { row ->
            val content = row.text(COVER_CONTENT)
            if (content.isEmpty()) return@forEach
            coverAsset[content] = row.text(COVER_ASSET)
            val thumbnail = row.text(COVER_THUMBNAIL)
            if (thumbnail.isNotEmpty()) coverThumbnail[content] = thumbnail
        }
        return albumRows.map { row ->
            val albumId = row.text(ALBUM_ID)
            val cover = row.text(ALBUM_COVER)
            AlbumChoiceRow(
                albumId = albumId,
                title = row.text(ALBUM_NAME),
                count = sizes[albumId] ?: 0L,
                coverAssetId = coverAsset[cover]?.ifEmpty { null },
                coverThumbnailPath = coverThumbnail[cover],
                countCapped = entriesCapped,
            )
        }
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
     * Does a change on [table] move the list? The albums themselves, and their
     * entries — which is what a count is made of.
     */
    public fun movesChoices(table: String): Boolean =
        table == COLLECTION_TABLE || table == ENTRY_TABLE

    /**
     * ONE `media.add_to_album` PER PICKED ASSET.
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
                inputJson = "{\"album_id\":${PhotoShelfMachine.jsonString(albumId)}," +
                    "\"asset_id\":${PhotoShelfMachine.jsonString(assetId)}}",
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
     * on Collections and the same name typed here are the same intent.
     */
    public fun createEffects(title: String): List<ScreenEffect> {
        val name = title.trim()
        if (name.isEmpty()) return emptyList()
        return listOf(
            ScreenEffect.SubmitWrite(
                command = CREATE_COMMAND,
                inputJson = "{\"title\":${PhotoShelfMachine.jsonString(name)}}",
                invokeKey = "$CREATE_COMMAND:$name",
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
        val coverIds = albums.rows.map { it.text(ALBUM_COVER) }
        val covers = coversQuery(coverIds)?.let { query ->
            core.photosPage(query, limit = coverIds.size) as? PhotosPage.Rows
        }
        return entries(
            rows(
                albumRows = albums.rows,
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
    private const val ALBUM_NAME: Int = 1
    private const val ALBUM_COVER: Int = 2
    private const val ENTRY_COLLECTION: Int = 1
    private const val COVER_ASSET: Int = 0
    private const val COVER_CONTENT: Int = 1

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
