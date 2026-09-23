package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.CollectionsDoor
import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosCollectionsData
import centraid.screen.v1.PhotosCollectionsEvent
import centraid.screen.v1.PhotosCollectionsState
import dev.centraid.shared.apps.photos.PhotosCollectionsMachine
import dev.centraid.shared.apps.photos.PhotosCollectionsReads
import dev.centraid.shared.apps.photos.PhotosCollectionsReads.Scan
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * COLLECTIONS, AS A PURE FUNCTION (#1029, the photos port).
 *
 * Everything here runs on the JVM with no ABI, because everything here is the
 * part of a screen that is DATA: the ten statements, the fold that turns their
 * rows into one screen, the effects a reduce decided on, and the JSON a write
 * carries. What needs a real vault — that the door answers these statements at
 * all — is the device contract's job, and a test that mocked a core to assert
 * a mock's answer would prove only that the mock was written to match.
 */
class PhotosCollectionsSpec : StringSpec({

    val machine = PhotosCollectionsMachine

    fun row(vararg values: String) = Row(values = values.map { Value(text = it) })

    /** An album row: `collection_id, name`. */
    fun albumRow(id: String, name: String) = row(id, name)

    /** An entry row: `entry_id, collection_id`. */
    fun entryRow(id: String, collectionId: String) = row(id, collectionId)

    /** A shelf row: the two named columns, then the door's appended thumbnail. */
    fun shelfRow(assetId: String, sortKey: String, thumbnail: String = "") =
        row(assetId, sortKey, thumbnail)

    /** A face row: `region_id, party_id, review_state`. */
    fun faceRow(regionId: String, partyId: String, state: String) = row(regionId, partyId, state)

    /** A phash row: `asset_id, cluster_id`. */
    fun phashRow(assetId: String, clusterId: String) = row(assetId, clusterId)

    fun fold(
        albums: Scan = Scan(),
        albumsNextCursor: String? = null,
        entries: Scan = Scan(),
        archive: Scan = Scan(),
        trash: Scan = Scan(),
        videos: Scan = Scan(),
        starred: Scan = Scan(),
        faces: Scan = Scan(),
        places: Scan = Scan(),
        memories: Scan = Scan(),
        duplicates: Scan = Scan(),
    ): PhotosCollectionsData = PhotosCollectionsReads.fold(
        albums = albums,
        albumsNextCursor = albumsNextCursor,
        entries = entries,
        archive = archive,
        trash = trash,
        videos = videos,
        starred = starred,
        faces = faces,
        places = places,
        memories = memories,
        duplicates = duplicates,
    )

    "the first open asks for a page, and the screen is loading until it lands" {
        val step = machine.reduce(
            machine.initial(),
            PhotosCollectionsEvent(opened = PhotosCollectionsEvent.Opened()),
        )
        step.state.loading.shouldNotBeNull().first_load shouldBe true
        step.state.failure shouldBe null
        step.effects shouldBe listOf(
            ScreenEffect.ReadPage(PhotosCollectionsMachine.SCREEN_ID, afterCursor = null),
        )
    }

    "a refused read is a sentence, never an empty shelf list" {
        // THE LAW FROM BOTH SIDES. A failure clears the data case rather than
        // standing beside it, so there is never a fourth state — an empty list
        // of shelves standing in for a read that did not happen. It is also
        // why the bridge ends the whole trip on the FIRST refusal: "Trash, 0"
        // beside a refused read is a worse lie than the sentence.
        val refused = machine.reduce(
            machine.initial(),
            PhotosCollectionsEvent(
                refused = PhotosCollectionsEvent.ReadRefused(
                    failure = Reads.refused("The access plane said no."),
                ),
            ),
        )
        refused.state.data_ shouldBe null
        refused.state.loading shouldBe null
        refused.state.failure.shouldNotBeNull().sentence shouldBe "The access plane said no."
        refused.effects.shouldBeEmpty()
    }

    "a parked feed emits no re-read, from a scroll or from a row change" {
        // OUT OF DISK PARKS THE FEED (`docs/mobile-offline.md:238`): the cursor
        // and the rows stay and the retry cadence stops. A screen that kept
        // asking would be the retry loop over a failing batch that the device
        // contract already pins as a regression — and on this screen one
        // re-read is ten reads, so it is ten times the loop.
        val parked = machine.reduce(
            machine.initial(),
            PhotosCollectionsEvent(
                refused = PhotosCollectionsEvent.ReadRefused(failure = Reads.lowDiskParked()),
            ),
        ).state

        machine.reduce(
            parked,
            PhotosCollectionsEvent(
                next_page = PhotosCollectionsEvent.NextPageRequested(after_cursor = "c|1"),
            ),
        ).effects.shouldBeEmpty()

        machine.reduce(
            parked,
            PhotosCollectionsEvent(
                rows_changed = PhotosCollectionsEvent.RowsChanged(collection_ids = listOf("col-1")),
            ),
        ).effects.shouldBeEmpty()
    }

    "a collection change re-reads even when the keys name nothing on screen" {
        // TWO DEFECTS IN ONE ASSERTION.
        //
        // A NEW album's id is by construction not in the set this screen is
        // showing, so the grid's "is one of mine?" filter would drop precisely
        // the event the member is waiting for. And the keys can be EMPTY:
        // `ChangeFeed::tables_changed` — the producer behind every locally
        // committed command — offers `pk_set: Vec::new()`, because its source
        // is a rusqlite update hook handed a ROWID and not a declared primary
        // key. Both are a re-read.
        listOf(listOf("a-brand-new-album"), emptyList()).forEach { keys ->
            withClue("keys=$keys") {
                machine.reduce(
                    machine.initial(),
                    PhotosCollectionsEvent(
                        rows_changed = PhotosCollectionsEvent.RowsChanged(collection_ids = keys),
                    ),
                ).effects shouldBe listOf(
                    ScreenEffect.ReadPage(PhotosCollectionsMachine.SCREEN_ID, afterCursor = null),
                )
            }
        }
    }

    "rowsChanged answers for core_collection and null for any other table" {
        machine.rowsChanged("core_collection", listOf("col-1")).shouldNotBeNull()
        machine.rowsChanged("media_asset", listOf("asset-1")) shouldBe null
        machine.rowsChanged("core_collection_entry", listOf("entry-1")) shouldBe null
    }

    "every statement selects both of the columns its cursor is read off" {
        // THE DOOR HAS NO `key_of` CALLBACK, so the cursor is read off the row
        // by the two columns the ORDER BY names. A statement that ordered by a
        // column it did not project produces a walk that is not a walk: the
        // second page starts from an empty key and repeats the first.
        listOf(
            PhotosCollectionsReads.albumsQuery(),
            PhotosCollectionsReads.albumEntriesQuery(),
            PhotosCollectionsReads.archiveQuery(),
            PhotosCollectionsReads.trashQuery(),
            PhotosCollectionsReads.videosQuery(),
            PhotosCollectionsReads.flagsSchemeQuery(),
            PhotosCollectionsReads.starredConceptQuery("scheme-1"),
            PhotosCollectionsReads.starredTagsQuery("concept-1"),
            PhotosCollectionsReads.facesQuery(),
            PhotosCollectionsReads.placesQuery(),
            PhotosCollectionsReads.memoriesQuery(),
            PhotosCollectionsReads.duplicatesQuery(),
        ).forEach { query ->
            withClue("${query.name} selects ${query.select}") {
                val order = query.order.shouldNotBeNull()
                query.select.contains(order.sort_column) shouldBe true
                query.select.contains(order.pk_column) shouldBe true
            }
        }
    }

    "the albums statement is the table the machine re-reads on, and asks for no thumbnail" {
        // THE PAIRING, ASSERTED MECHANICALLY. When the two part company nothing
        // fails — the screen simply stops redrawing on sync, and the symptom is
        // a list that is right only after a relaunch.
        val query = PhotosCollectionsReads.albumsQuery()
        query.from shouldBe PhotosCollectionsReads.TABLE
        machine.rowsChanged(query.from, listOf("col-1")).shouldNotBeNull()
        // `core_collection` CARRIES `cover_content_id` AND NOT `content_id`,
        // and `with_held_thumbnail` correlates on `{from}.content_id` — a table
        // without one is REFUSED at prepare, which would take the whole page
        // down rather than return a blank column.
        query.with_held_thumbnail shouldBe false
    }

    "only the three shelf statements ask the byte store anything" {
        // A COVER IS THE NEWEST ROW ON THE SHELF THIS READ ALREADY ORDERED, so
        // it costs nothing extra — and the four statements that touch no asset
        // must not ask, for the reason above.
        listOf(
            PhotosCollectionsReads.archiveQuery(),
            PhotosCollectionsReads.trashQuery(),
            PhotosCollectionsReads.videosQuery(),
        ).forEach { withClue(it.name) { it.with_held_thumbnail shouldBe true } }
        listOf(
            PhotosCollectionsReads.albumEntriesQuery(),
            PhotosCollectionsReads.facesQuery(),
            PhotosCollectionsReads.starredTagsQuery("c"),
        ).forEach { withClue(it.name) { it.with_held_thumbnail shouldBe false } }
    }

    "an album's entries are counted as PHOTOGRAPHS and not as whatever was filed there" {
        // `core_collection_entry` IS POLYMORPHIC — `(target_type, target_id)` —
        // so a notebook's notes live in the same table. An album's size counted
        // without the predicate would be the size of everything a member had
        // filed under that collection.
        val query = PhotosCollectionsReads.albumEntriesQuery()
        query.where_ shouldBe "target_type = ?"
        query.bind.map { it.text } shouldBe listOf("media.asset")
    }

    "the archive and the trash are different shelves, and neither counts the other" {
        // #419: archived and trashed are different answers and the table's own
        // CHECK refuses a row claiming both, so a shelf that counted the
        // overlap would be counting a row that cannot exist.
        PhotosCollectionsReads.archiveQuery().where_ shouldBe
            "archived_at IS NOT NULL AND deleted_at IS NULL"
        PhotosCollectionsReads.trashQuery().where_ shouldBe "deleted_at IS NOT NULL"
        // VIDEOS IS A SHELF OF THE LIVE LIBRARY: a video in the trash is in the
        // trash, and counting it here would put one photograph on two shelves
        // whose whole point is that they are different places.
        PhotosCollectionsReads.videosQuery().where_ shouldBe
            "kind = ? AND deleted_at IS NULL AND archived_at IS NULL"
        PhotosCollectionsReads.videosQuery().bind.map { it.text } shouldBe listOf("video")
    }

    "the star is three reads, because a favourite is not a column" {
        // #916, ONT-03: `media_asset.favorite` does not exist. The star is the
        // `starred` concept in the flags scheme, and the URI is spelled `https`
        // deliberately — a `urn:`-style `:flags` reads as a NAMED PARAMETER in
        // condition SQL (#258, the colon-literal trap).
        PhotosCollectionsReads.flagsSchemeQuery().bind.map { it.text } shouldBe
            listOf("https://centraid.dev/schemes/flags")
        PhotosCollectionsReads.starredConceptQuery("scheme-1").bind.map { it.text } shouldBe
            listOf("scheme-1", "starred")
        PhotosCollectionsReads.starredTagsQuery("concept-1").bind.map { it.text } shouldBe
            listOf("media.asset", "concept-1")
    }

    "the four standing shelves come first, in the order a member reads them" {
        val data = fold(albums = Scan(rows = listOf(albumRow("col-1", "Portugal"))))
        data.shelves.take(4).map { it.title } shouldContainExactly
            listOf("Favorites", "Archive", "Trash", "Videos")
        // A STANDING SHELF CANNOT BE RENAMED OR DELETED, and the ROW says so
        // rather than the view deriving it from the oneof.
        data.shelves.take(4).forEach { it.member_owned shouldBe false }
        data.shelves.first().shelf.shouldNotBeNull()
            .state_view.shouldNotBeNull()
            .mode.shouldNotBeNull()
            .kind shouldBe PhotoStateView.Mode.Kind.KIND_FAVORITES

        val album = data.shelves.last()
        album.member_owned shouldBe true
        album.title shouldBe "Portugal"
        // NAMES RIDE ALONG THE ROUTE, so the shelf screen's app bar has a
        // heading before its own read lands.
        album.shelf.shouldNotBeNull().album.shouldNotBeNull().name shouldBe "Portugal"
        album.shelf.shouldNotBeNull().album.shouldNotBeNull().collection_id shouldBe "col-1"

        data.doors.map { it.kind } shouldContainExactly listOf(
            CollectionsDoor.Kind.KIND_PEOPLE,
            CollectionsDoor.Kind.KIND_PLACES,
            CollectionsDoor.Kind.KIND_MEMORIES,
            CollectionsDoor.Kind.KIND_DUPLICATES,
        )
    }

    "a vault with nothing in it is four shelves and four doors, never a refusal" {
        // AN EMPTY VAULT IS A REAL ANSWER, unlike the Notes editor's empty page:
        // a member with no albums and no photographs has a Collections screen
        // with four standing shelves and four doors on it, which is a screen
        // and not an absence.
        val data = fold()
        data.shelves.size shouldBe 4
        data.doors.size shouldBe 4
        data.shelves.forEach {
            withClue(it.title) {
                it.item_count shouldBe 0
                it.item_count_capped shouldBe false
            }
        }
    }

    "each shelf is counted from its own rows, and its cover is its newest" {
        val data = fold(
            starred = Scan(rows = listOf(row("tag-1", "a-1"), row("tag-2", "a-2"))),
            archive = Scan(rows = listOf(shelfRow("a-9", "2026-02-03", "/store/a-9.data"))),
            trash = Scan(
                rows = listOf(
                    // THE NEWEST ROW WITH AN IMAGE IS THE COVER, and the read is
                    // already in the shelf's own order — so this is "the newest
                    // photograph this device can draw" and never an arbitrary
                    // pick. A row with no thumbnail is skipped rather than
                    // becoming an empty cover.
                    shelfRow("a-8", "2026-02-02"),
                    shelfRow("a-7", "2026-02-01", "/store/a-7.data"),
                ),
            ),
            videos = Scan(rows = listOf(shelfRow("a-6", "2026-01-01"))),
        )
        val byTitle = data.shelves.associateBy { it.title }
        byTitle.getValue("Favorites").item_count shouldBe 2
        // NO COVER FOR FAVORITES: a favourite is a `core_tag` row and that read
        // never reaches the photograph behind it.
        byTitle.getValue("Favorites").cover_thumbnail_path shouldBe null
        byTitle.getValue("Archive").item_count shouldBe 1
        byTitle.getValue("Archive").cover_thumbnail_path shouldBe "/store/a-9.data"
        byTitle.getValue("Trash").item_count shouldBe 2
        byTitle.getValue("Trash").cover_thumbnail_path shouldBe "/store/a-7.data"
        byTitle.getValue("Videos").item_count shouldBe 1
        byTitle.getValue("Videos").cover_thumbnail_path shouldBe null
    }

    "a page that filled makes its count a FLOOR, and says so" {
        // THE DOOR HAS NO `COUNT(*)`, so every number on this screen is rows
        // read and counted — and a page that filled has more behind it. A bare
        // number over a full page would be a total nobody counted, which is
        // what `HomeState.ThingCount.capped` exists to prevent and what the
        // views render as "at least N".
        val data = fold(
            albums = Scan(rows = listOf(albumRow("col-1", "Portugal"))),
            entries = Scan(rows = listOf(entryRow("e-1", "col-1")), capped = true),
            trash = Scan(rows = listOf(shelfRow("a-1", "2026-02-02")), capped = true),
            archive = Scan(rows = listOf(shelfRow("a-2", "2026-02-02")), capped = false),
            faces = Scan(rows = listOf(faceRow("r-1", "p-1", "confirmed")), capped = true),
        )
        val byTitle = data.shelves.associateBy { it.title }
        byTitle.getValue("Trash").item_count_capped shouldBe true
        byTitle.getValue("Archive").item_count_capped shouldBe false
        // EVERY ALBUM'S COUNT IS CAPPED WHEN THE ENTRY PAGE WAS, including one
        // that looks empty: a single read counts every album's entries at once,
        // so a page that filled may have stopped before this album's rows
        // entirely — "0" would be a claim and "at least 0" is the truth.
        byTitle.getValue("Portugal").item_count shouldBe 1
        byTitle.getValue("Portugal").item_count_capped shouldBe true
        data.doors.single { it.kind == CollectionsDoor.Kind.KIND_PEOPLE }
            .count_capped shouldBe true
    }

    "People counts the named and badges the unanswered" {
        // Two facts off one table: who is CONFIRMED is the door's count, and
        // how many proposals are UNANSWERED is the badge. A party named on two
        // faces is one person, which is why the confirmed ids are deduped.
        val data = fold(
            faces = Scan(
                rows = listOf(
                    faceRow("r-1", "p-1", "confirmed"),
                    faceRow("r-2", "p-1", "confirmed"),
                    faceRow("r-3", "p-2", "confirmed"),
                    faceRow("r-4", "", "proposed"),
                    faceRow("r-5", "", "proposed"),
                    // ANSWERED AND NOT NAMED IS NOT A BACKLOG ITEM: "rejected"
                    // and "dismissed" are states precisely so the queue can be
                    // finished (#712), and counting them would make it endless.
                    faceRow("r-6", "", "rejected"),
                    faceRow("r-7", "", "dismissed"),
                ),
            ),
        )
        val people = data.doors.single { it.kind == CollectionsDoor.Kind.KIND_PEOPLE }
        people.count shouldBe 2
        people.needs_attention shouldBe 2
    }

    "Duplicates counts GROUPS of look-alikes, never rows" {
        // A cluster of one is not a duplicate of anything, and counting rows
        // would tell a member they have hundreds of duplicates when they have
        // one. The badge and the count are the same number here: every cluster
        // on this door is one decision still owed.
        val data = fold(
            duplicates = Scan(
                rows = listOf(
                    phashRow("a-1", "c-1"),
                    phashRow("a-2", "c-1"),
                    phashRow("a-3", "c-2"),
                    phashRow("a-4", "c-3"),
                    phashRow("a-5", "c-3"),
                ),
            ),
        )
        val door = data.doors.single { it.kind == CollectionsDoor.Kind.KIND_DUPLICATES }
        door.count shouldBe 2
        door.needs_attention shouldBe 2
    }

    "a second page appends albums and does not draw Favorites twice" {
        val first = machine.reduce(
            machine.initial(),
            PhotosCollectionsReads.arrived(
                fold(
                    albums = Scan(rows = listOf(albumRow("col-1", "Portugal"))),
                    albumsNextCursor = "col-1|col-1",
                ),
            ),
        ).state
        first.data_.shouldNotBeNull().next_cursor shouldBe "col-1|col-1"

        val second = machine.reduce(
            first,
            PhotosCollectionsReads.arrived(
                fold(albums = Scan(rows = listOf(albumRow("col-2", "Rooftops")))),
            ),
        ).state
        val shelves = second.data_.shouldNotBeNull().shelves
        shelves.count { it.title == "Favorites" } shouldBe 1
        shelves.filter { it.member_owned }.map { it.title } shouldContainExactly
            listOf("Portugal", "Rooftops")
        second.data_.shouldNotBeNull().doors.size shouldBe 4
    }

    "creating an album is the VAULT's command, keyed on what it is for" {
        val step = machine.reduce(
            machine.reduce(
                machine.initial(),
                PhotosCollectionsEvent(
                    sheet = PhotosCollectionsEvent.SheetChanged(
                        PhotosCollectionsState.Sheet.SHEET_NEW_ALBUM,
                    ),
                ),
            ).state,
            PhotosCollectionsEvent(
                album_created = PhotosCollectionsEvent.AlbumCreated(name = "  Portugal  "),
            ),
        )
        val write = step.effects.single() as ScreenEffect.SubmitWrite
        // THE COMMAND NAME IS THE VAULT'S, never the app action. `notes.save`
        // did not exist and a member read "That request does not make sense to
        // this build" on every window for ever.
        write.command shouldBe "media.create_album"
        write.inputJson shouldBe "{\"title\":\"Portugal\"}"
        // CONTENT-DERIVED, NEVER AN ORDINAL: an ordinal is stable only for a
        // caller that makes the same calls every time, which is the v0 fallback
        // `crates/core`'s `invoke` refuses outright.
        write.invokeKey shouldBe "media.create_album:Portugal"
        // THE SHEET STAYS OPEN UNTIL THE WRITE COMMITS. Closing it here would
        // be the screen claiming an album exists because a button was pressed.
        step.state.sheet shouldBe PhotosCollectionsState.Sheet.SHEET_NEW_ALBUM
    }

    "a refusal with no words is still a sentence, and a new attempt clears it" {
        // A REFUSAL WITH NO WORDS WAS SILENCE until `write_failure` existed,
        // and a member who pressed Create and saw nothing happen could not
        // tell a refusal from a tap that missed. `Error.detail` is never the
        // source: it is logs-only and one reached a member's screen through
        // exactly that field in #1020 wave 3, so the shell writes this.
        val refused = machine.reduce(
            machine.initial(),
            PhotosCollectionsReads.settled(CommandStatus.COMMAND_STATUS_FAILED, "", "test.command:row-0001"),
        ).state
        refused.write_failure.shouldNotBeNull().sentence shouldBe
            "Centraid could not make that change."

        machine.reduce(
            refused,
            PhotosCollectionsEvent(
                album_created = PhotosCollectionsEvent.AlbumCreated(name = "Rooftops"),
            ),
        ).state.write_failure shouldBe null

        // AND ON RE-OPENING: a member who has come back is not still being
        // told about the create they tried a minute ago.
        machine.reduce(
            refused,
            PhotosCollectionsEvent(opened = PhotosCollectionsEvent.Opened()),
        ).state.write_failure shouldBe null
    }

    "an empty album name is not a write" {
        // `media.create_album`'s schema has `"title": { "minLength": 1 }`, so
        // the vault would refuse it — and a command a screen KNOWS will be
        // refused is a round trip a member waits through for nothing.
        machine.reduce(
            machine.initial(),
            PhotosCollectionsEvent(
                album_created = PhotosCollectionsEvent.AlbumCreated(name = "   "),
            ),
        ).effects.shouldBeEmpty()
    }

    "an album name with a quote in it survives as JSON" {
        // The escaping is the only hard part of hand-building this input, and
        // an album named `He said "hi"` would otherwise produce bytes the vault
        // cannot parse — landing as a command that never ran rather than as
        // anything a member could read.
        PhotosCollectionsMachine.createInput("He said \"hi\"") shouldBe
            "{\"title\":\"He said \\\"hi\\\"\"}"
        PhotosCollectionsMachine.deleteInput("col-1") shouldBe "{\"album_id\":\"col-1\"}"
    }

    "deleting an album names the album and nothing else" {
        val write = machine.reduce(
            machine.initial(),
            PhotosCollectionsEvent(
                album_deleted = PhotosCollectionsEvent.AlbumDeleted(collection_id = "col-9"),
            ),
        ).effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "media.delete_album"
        write.invokeKey shouldBe "media.delete_album:col-9"
    }

    "only a committed write closes the sheet, and a refused one keeps the list" {
        val listed = machine.reduce(
            machine.initial(),
            PhotosCollectionsReads.arrived(
                fold(albums = Scan(rows = listOf(albumRow("col-1", "Portugal")))),
            ),
        ).state.copy(sheet = PhotosCollectionsState.Sheet.SHEET_NEW_ALBUM)

        // QUEUED IS NOT COMMITTED. It means "somewhere durable, not yet
        // committed", and a sheet that closed on one would be the shell
        // claiming an album exists that does not.
        val queued = PhotosCollectionsReads.settled(CommandStatus.COMMAND_STATUS_QUEUED, "", "test.command:row-0001")
        machine.reduce(listed, queued).state.sheet shouldBe
            PhotosCollectionsState.Sheet.SHEET_NEW_ALBUM

        val denied = PhotosCollectionsReads.settled(
            CommandStatus.COMMAND_STATUS_DENIED,
            "This vault has moved to your other phone.",
            "media.create_album:alb-0001",
        )
        val afterDenial = machine.reduce(listed, denied).state
        // A FAILED WRITE DOES NOT REPLACE THE LIST. The rows are still true and
        // the refusal says nothing about them (`NotesEditorMachine`'s rule from
        // the other side). The sentence goes to `write_failure` — its OWN slot,
        // never the `content` oneof's `failure`, which is the READ's: a denied
        // create put there would take the four standing shelves off a screen
        // that has them in every vault.
        afterDenial.data_.shouldNotBeNull().shelves.size shouldBe 5
        afterDenial.failure shouldBe null
        afterDenial.sheet shouldBe PhotosCollectionsState.Sheet.SHEET_NEW_ALBUM
        afterDenial.write_failure.shouldNotBeNull().sentence shouldBe
            "This vault has moved to your other phone."

        val executed = PhotosCollectionsReads.settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", "test.command:row-0001")
        val afterCommit = machine.reduce(afterDenial, executed)
        afterCommit.state.sheet shouldBe PhotosCollectionsState.Sheet.SHEET_NONE
        // AND THE LAST REFUSAL GOES WITH IT: a sentence that outlives what it
        // was about becomes furniture.
        afterCommit.state.write_failure shouldBe null
        // NO RE-READ FROM HERE: the commit's own change event is what redraws
        // the list, and a read beside it would be two trips for one write
        // racing each other over ten statements.
        afterCommit.effects.shouldBeEmpty()
    }
})
