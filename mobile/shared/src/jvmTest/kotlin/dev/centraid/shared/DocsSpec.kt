package dev.centraid.shared

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.DocsActivity
import centraid.core.v1.DocsActivityEvent
import centraid.core.v1.DocsDocument
import centraid.core.v1.DocsDocumentRow
import centraid.core.v1.DocsDrive
import centraid.core.v1.DocsFolder
import centraid.core.v1.DocsKind
import centraid.core.v1.DocsLabel
import centraid.core.v1.DocsModifiedFilter
import centraid.core.v1.DocsSearch
import centraid.core.v1.DocsShelf
import centraid.core.v1.DocsSort
import centraid.core.v1.DocsSurface
import centraid.core.v1.DocsTypeFilter
import centraid.core.v1.DocsVersion
import centraid.screen.v1.Autosave
import centraid.screen.v1.DocsCapture
import centraid.screen.v1.DocsDocumentEvent
import centraid.screen.v1.DocsDocumentState
import centraid.screen.v1.DocsDriveData
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsDriveState
import centraid.screen.v1.DocsEditorEvent
import centraid.screen.v1.DocsEditorState
import centraid.screen.v1.DocsReader
import centraid.screen.v1.DocsSheet
import centraid.screen.v1.DocsStage
import centraid.screen.v1.TrashListData
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashRow
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.apps.docs.DocsDocumentMachine
import dev.centraid.shared.apps.docs.DocsDocumentReads
import dev.centraid.shared.apps.docs.DocsDriveMachine
import dev.centraid.shared.apps.docs.DocsDriveReads
import dev.centraid.shared.apps.docs.DocsEditorMachine
import dev.centraid.shared.apps.docs.DocsEditorReads
import dev.centraid.shared.apps.docs.DocsTrashMachine
import dev.centraid.shared.apps.docs.DocsTrashSpec
import dev.centraid.shared.apps.docs.DocsWrites
import dev.centraid.shared.kit.AutosaveLaw
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import java.io.File

/**
 * DOCS, FROM TYPED ANSWERS TO WHAT A VIEW DRAWS (#1046, docs port).
 *
 * Every fixture is a `centraid.core.v1` answer the way the core gives it —
 * sizes as words, kinds named, dates already in the device's zone — so what
 * is pinned here is the phone's half: which query each state asks, what the
 * rows and sheets say, which writes a tap submits, and what the trash will
 * not promise. Wednesday 11 March 2026.
 */
class DocsSpec : StringSpec({

    val now = DeviceClock.Reading(zone = "Europe/Lisbon", epochMillis = 1_773_230_400_000)

    fun drive(e: DocsDriveEvent, s: DocsDriveState = DocsDriveMachine.initial()): Step<DocsDriveState> =
        DocsDriveMachine.reduce(s, e)

    fun opened(destination: DocsDriveState.Destination = DocsDriveState.Destination.DESTINATION_ALL, folder: String = "", name: String = "") =
        drive(DocsDriveEvent(opened = DocsDriveEvent.Opened(destination = destination, folder_id = folder, folder_name = name)))

    fun answered(s: DocsDriveState, answer: DocsDrive): DocsDriveState =
        drive(DocsDriveReads.arrived(listOf(AppQueryResponse(docs_drive = answer))), s).state

    fun onScreen(answer: DocsDrive = driveAnswer(), destination: DocsDriveState.Destination = DocsDriveState.Destination.DESTINATION_ALL) =
        answered(opened(destination).state, answer)

    fun settled(key: String, ok: Boolean = true, sentence: String = "") =
        DocsDriveReads.settled(
            if (ok) CommandStatus.COMMAND_STATUS_EXECUTED else CommandStatus.COMMAND_STATUS_FAILED,
            sentence,
            key,
        )

    fun writes(step: Step<*>) = step.effects.filterIsInstance<ScreenEffect.SubmitWrite>()

    fun reads(step: Step<*>) = step.effects.filterIsInstance<ScreenEffect.ReadPage>()

    // --- Shelves, filters and the order -----------------------------------

    "each shelf asks docs.drive for itself, with the filters and the order as the request" {
        val all = opened().state
        DocsDriveReads.requests(all, now).single().docs_drive.shouldNotBeNull().let {
            it.shelf shouldBe DocsShelf.DOCS_SHELF_ALL
            it.sort shouldBe DocsSort.DOCS_SORT_CHANGED
            it.ascending shouldBe false
            it.tz shouldBe "Europe/Lisbon"
        }
        val starred = opened(DocsDriveState.Destination.DESTINATION_STARRED).state
        DocsDriveReads.requests(starred, now).single().docs_drive!!.shelf shouldBe DocsShelf.DOCS_SHELF_STARRED

        val folder = opened(DocsDriveState.Destination.DESTINATION_FOLDERS, "f-tax", "Taxes").state
        DocsDriveReads.requests(folder, now).single().docs_drive!!.let {
            it.shelf shouldBe DocsShelf.DOCS_SHELF_FOLDER
            it.folder_id shouldBe "f-tax"
        }
        folder.chrome!!.title shouldBe "Taxes"

        // Filters and a sort, chosen on their sheets.
        var s = onScreen(driveAnswer(labels = listOf("lease")))
        s = drive(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = DocsSheet.Kind.KIND_TYPE)), s).state
        s.sheet!!.choices!!.choices.first().selected shouldBe true
        val typed = drive(DocsDriveEvent(choice = DocsDriveEvent.ChoicePicked(key = "pdf")), s)
        reads(typed).size shouldBe 1
        s = typed.state
        s.sheet!!.kind shouldBe DocsSheet.Kind.KIND_NONE
        s = drive(DocsDriveEvent(refused = DocsDriveEvent.ReadRefused()), s).state // settle the read
        s = drive(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = DocsSheet.Kind.KIND_MODIFIED)), s).state
        s = drive(DocsDriveEvent(choice = DocsDriveEvent.ChoicePicked(key = "7d")), s).state
        s = drive(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = DocsSheet.Kind.KIND_SORT)), s).state
        s = drive(DocsDriveEvent(choice = DocsDriveEvent.ChoicePicked(key = DocsDriveMachine.SORT_NAME_ASC)), s).state
        DocsDriveReads.requests(s, now).single().docs_drive!!.let {
            it.type shouldBe DocsTypeFilter.DOCS_TYPE_FILTER_PDF
            it.modified shouldBe DocsModifiedFilter.DOCS_MODIFIED_FILTER_LAST_7_DAYS
            it.sort shouldBe DocsSort.DOCS_SORT_NAME
            it.ascending shouldBe true
        }
        s.filters_active shouldBe true
        s.pills.map { it.label } shouldBe listOf("PDFs", "Last 7 days", "Label", "Name · A to Z")
        s.pills.map { it.active } shouldBe listOf(true, true, false, false)

        // Clear filters keeps the order.
        val cleared = drive(DocsDriveEvent(filters_cleared = DocsDriveEvent.FiltersCleared()), s)
        DocsDriveReads.requests(cleared.state, now).single().docs_drive!!.let {
            it.type shouldBe DocsTypeFilter.DOCS_TYPE_FILTER_UNSPECIFIED
            it.modified shouldBe DocsModifiedFilter.DOCS_MODIFIED_FILTER_UNSPECIFIED
            it.sort shouldBe DocsSort.DOCS_SORT_NAME
        }
        cleared.state.filters_active shouldBe false
    }

    "Recently added is a window from More: no filters, no pills, and its rule said once" {
        var s = onScreen(driveAnswer())
        s = drive(DocsDriveEvent(band = DocsDriveEvent.BandPicked(key = DocsDriveMachine.BAND_MORE)), s).state
        s.sheet!!.kind shouldBe DocsSheet.Kind.KIND_MORE
        s.sheet!!.actions!!.actions.map { it.key } shouldBe listOf(DocsWrites.KEY_RECENT, DocsWrites.KEY_TRASH_SHELF)
        s.sheet!!.actions!!.actions.map { it.label } shouldBe listOf("Recently added", "Trash")
        val recent = drive(DocsDriveEvent(action = DocsDriveEvent.ActionPicked(key = DocsWrites.KEY_RECENT)), s)
        recent.state.destination shouldBe DocsDriveState.Destination.DESTINATION_RECENT
        reads(recent).size shouldBe 1
        DocsDriveReads.requests(recent.state, now).single().docs_drive!!.let {
            it.shelf shouldBe DocsShelf.DOCS_SHELF_RECENT
            it.type shouldBe DocsTypeFilter.DOCS_TYPE_FILTER_UNSPECIFIED
        }
        val landed = answered(recent.state, driveAnswer())
        landed.pills.shouldBeEmpty()
        landed.data_!!.shelf_note shouldBe DocsCopy.RECENT_RULE
        landed.chrome!!.title shouldBe "Recently added"
        // No band tab is current: Recently added is not a tab.
        landed.band.none { it.current } shouldBe true
    }

    "the band: All · Folders · Starred · More, and the tab you are on is nothing" {
        val s = onScreen()
        s.band.map { it.key } shouldBe listOf("all", "folders", "starred", "more")
        s.band.map { it.label } shouldBe listOf("All", "Folders", "Starred", "More")
        drive(DocsDriveEvent(band = DocsDriveEvent.BandPicked(key = "all")), s).effects.shouldBeEmpty()
        val starred = drive(DocsDriveEvent(band = DocsDriveEvent.BandPicked(key = "starred")), s)
        starred.state.destination shouldBe DocsDriveState.Destination.DESTINATION_STARRED
        starred.state.loading.shouldNotBeNull()
        reads(starred).size shouldBe 1
    }

    "ONE READ IN FLIGHT: a shelf changed mid-read queues, and the older answer is dropped" {
        val first = opened().state
        first.reading shouldBe true
        val moved = drive(DocsDriveEvent(band = DocsDriveEvent.BandPicked(key = "starred")), first)
        moved.effects.shouldBeEmpty()
        moved.state.read_queued shouldBe true
        // All's answer lands under Starred's head: dropped, and Starred is asked.
        val stale = drive(DocsDriveReads.arrived(listOf(AppQueryResponse(docs_drive = driveAnswer()))), moved.state)
        stale.state.data_.shouldBeNull()
        reads(stale).size shouldBe 1
        stale.state.read_queued shouldBe false
        val landed = answered(stale.state, driveAnswer(rows = listOf(row("d-1", "Lease", starred = true))))
        landed.data_!!.rows.map { it.title } shouldBe listOf("Lease")
        landed.reading shouldBe false
    }

    "a row says kind, size and when, in words, and a snippet is cut into runs" {
        val s = onScreen(driveAnswer(rows = listOf(row("d-1", "Lease 2026", updated = "2026-03-11T08:15", starred = true))))
        val r = s.data_!!.rows.single()
        r.meta shouldBe "PDF · 2.4 MB · Changed today"
        r.kind_icon_key shouldBe "FileText"
        r.accessibility_label shouldBe "Lease 2026, PDF, 2.4 MB, Changed today, Starred"
        s.head_meta shouldBe "1 document"

        val searched = drive(
            DocsDriveReads.arrived(
                listOf(
                    AppQueryResponse(
                        docs_search = DocsSearch(
                            documents = listOf(row("d-1", "Lease").copy(snippet = "rent is ⟦due⟧ monthly")),
                            today = TODAY,
                        ),
                    ),
                ),
            ),
            drive(DocsDriveEvent(search_term = DocsDriveEvent.SearchTermChanged(term = "due")), s).state,
        ).state
        searched.data_!!.mode shouldBe DocsDriveData.Mode.MODE_SEARCH
        searched.data_!!.rows.single().snippet.map { it.text to it.match } shouldBe
            listOf("rent is " to false, "due" to true, " monthly" to false)
    }

    // --- Search -----------------------------------------------------------

    "search is a field: a term reads docs.search, the rail stays, closing reads the shelf back" {
        var s = onScreen(driveAnswer(folders = listOf(DocsFolder(folder_id = "f", name = "Taxes"))))
        s = drive(DocsDriveEvent(search_opened = DocsDriveEvent.SearchOpened()), s).state
        s.search!!.open_ shouldBe true
        drive(DocsDriveEvent(search_term = DocsDriveEvent.SearchTermChanged(term = "  ")), s).effects.shouldBeEmpty()
        val typed = drive(DocsDriveEvent(search_term = DocsDriveEvent.SearchTermChanged(term = "lease")), s)
        reads(typed).size shouldBe 1
        DocsDriveReads.requests(typed.state, now).single().docs_search.shouldNotBeNull().let {
            it.term shouldBe "lease"
            it.limit shouldBe DocsDriveReads.SEARCH_LIMIT
        }
        val none = drive(
            DocsDriveReads.arrived(listOf(AppQueryResponse(docs_search = DocsSearch(today = TODAY)))),
            typed.state,
        ).state
        none.data_!!.empty!!.headline shouldBe DocsCopy.EMPTY_SEARCH
        none.search!!.answered_term shouldBe "lease"
        none.pills.shouldBeEmpty()
        none.rail!!.folders.single().name shouldBe "Taxes"

        val closed = drive(DocsDriveEvent(search_closed = DocsDriveEvent.SearchClosed()), none)
        closed.state.search!!.term shouldBe ""
        reads(closed).size shouldBe 1
        DocsDriveReads.requests(closed.state, now).single().docs_drive.shouldNotBeNull()
    }

    // --- Empties, day one, denied -----------------------------------------

    "every shelf has its own empty sentence and at most one action" {
        val all = onScreen(driveAnswer())
        all.data_!!.empty!!.headline shouldBe "No documents yet."
        all.data_!!.empty_action shouldBe DocsDriveData.EmptyAction.EMPTY_ACTION_ADD

        onScreen(driveAnswer(), DocsDriveState.Destination.DESTINATION_STARRED).data_!!.let {
            it.empty!!.headline shouldBe "Nothing starred yet."
            it.empty_action shouldBe DocsDriveData.EmptyAction.EMPTY_ACTION_NONE
        }
        onScreen(driveAnswer(), DocsDriveState.Destination.DESTINATION_FOLDERS).data_!!.let {
            it.empty!!.headline shouldBe "No folders yet."
            it.empty_action shouldBe DocsDriveData.EmptyAction.EMPTY_ACTION_NEW_FOLDER
        }
        // A folder with a child folder is not empty.
        onScreen(
            driveAnswer(folders = listOf(DocsFolder(folder_id = "f", name = "Taxes"))),
            DocsDriveState.Destination.DESTINATION_FOLDERS,
        ).data_!!.let {
            it.empty.shouldBeNull()
            it.folders.single().count_label shouldBe "Empty"
        }

        // Filters that match nothing offer to clear them, not to add.
        var s = onScreen(driveAnswer(rows = listOf(row("d-1", "Lease"))))
        s = drive(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = DocsSheet.Kind.KIND_TYPE)), s).state
        s = drive(DocsDriveEvent(choice = DocsDriveEvent.ChoicePicked(key = "audio")), s).state
        s = answered(s, driveAnswer())
        s.data_!!.empty!!.headline shouldBe DocsCopy.EMPTY_FILTERED
        s.data_!!.empty_action shouldBe DocsDriveData.EmptyAction.EMPTY_ACTION_CLEAR_FILTERS

        // Beyond the window: said once, and search offered.
        onScreen(driveAnswer(rows = listOf(row("d-1", "Lease")), truncated = true)).data_!!.truncated_note shouldBe
            DocsCopy.TRUNCATED
    }

    "denied is the gate: its words, no band, no pills" {
        val s = drive(DocsDriveReads.denied(AppQueryDenial(message = "no")), opened().state).state
        s.denied!!.title shouldBe DocsCopy.DENIED_TITLE
        s.band.shouldBeEmpty()
        s.pills.shouldBeEmpty()
        s.data_.shouldBeNull()
    }

    "a failed read is not an empty list, and asks nothing more" {
        val s = onScreen(driveAnswer(rows = listOf(row("d-1", "Lease"))))
        val refreshed = drive(DocsDriveEvent(refreshed = DocsDriveEvent.Refreshed()), s)
        refreshed.state.refreshing shouldBe true
        refreshed.state.data_.shouldNotBeNull()
        val failed = drive(DocsDriveReads.refused(dev.centraid.shared.screen.Reads.refused("Nope.")), refreshed.state)
        failed.effects.shouldBeEmpty()
        failed.state.failure!!.sentence shouldBe "Nope."
        failed.state.data_.shouldBeNull()
    }

    "a change on any table the drive reads re-reads over the rows; another table is not the drive's" {
        val s = onScreen(driveAnswer(rows = listOf(row("d-1", "Lease"))))
        DocsDriveMachine.TABLES.forEach { table ->
            val event = DocsDriveMachine.rowsChanged(table, emptyList()).shouldNotBeNull()
            val step = drive(event, s)
            reads(step).size shouldBe 1
            step.state.data_.shouldNotBeNull()
        }
        DocsDriveMachine.rowsChanged("knowledge_note", emptyList()).shouldBeNull()
    }

    // --- The row menu -------------------------------------------------------

    "the row menu: star submits once per intent, and a refusal keeps the rows" {
        var s = onScreen(driveAnswer(rows = listOf(row("d-1", "Lease"))))
        s = drive(DocsDriveEvent(row_menu = DocsDriveEvent.RowMenuOpened(document_id = "d-1")), s).state
        s.sheet!!.title shouldBe "Lease"
        s.sheet!!.actions!!.actions.map { it.label } shouldBe listOf("Star", "Rename", "Move", "Labels", "Move to trash")
        val star = drive(DocsDriveEvent(action = DocsDriveEvent.ActionPicked(key = DocsWrites.KEY_STAR)), s)
        val write = writes(star).single()
        write.command shouldBe "core.star_document"
        write.inputJson shouldBe """{"document_id":"d-1"}"""
        write.invokeKey shouldBe "core.star_document:d-1"
        star.state.sheet!!.kind shouldBe DocsSheet.Kind.KIND_NONE
        star.state.write!!.phase shouldBe WriteState.Phase.PHASE_IN_FLIGHT

        val refused = drive(settled(write.invokeKey, ok = false, sentence = "That document is in the trash."), star.state).state
        refused.write!!.phase shouldBe WriteState.Phase.PHASE_REFUSED
        refused.write!!.failure!!.sentence shouldBe "That document is in the trash."
        refused.data_!!.rows.single().title shouldBe "Lease"
    }

    "move offers every folder by its path, and the folder it is in is nothing" {
        val folders = listOf(
            DocsFolder(folder_id = "f-home", name = "Home"),
            DocsFolder(folder_id = "f-lease", name = "Leases", parent_id = "f-home"),
        )
        var s = onScreen(driveAnswer(rows = listOf(row("d-1", "Lease", folder = "f-home")), folders = folders))
        s = drive(DocsDriveEvent(row_menu = DocsDriveEvent.RowMenuOpened(document_id = "d-1")), s).state
        s = drive(DocsDriveEvent(action = DocsDriveEvent.ActionPicked(key = DocsWrites.KEY_MOVE)), s).state
        val choices = s.sheet!!.choices!!.choices
        choices.map { it.label } shouldBe listOf("Top level", "Home", "Home / Leases")
        choices.single { it.selected }.key shouldBe "f-home"
        drive(DocsDriveEvent(choice = DocsDriveEvent.ChoicePicked(key = "f-home")), s).effects.shouldBeEmpty()
        writes(drive(DocsDriveEvent(choice = DocsDriveEvent.ChoicePicked(key = "f-lease")), s)).single().inputJson shouldBe
            """{"document_id":"d-1","folder_id":"f-lease"}"""
        // The top level is no folder: the command files it back under the root.
        writes(drive(DocsDriveEvent(choice = DocsDriveEvent.ChoicePicked(key = DocsWrites.KEY_TOP_LEVEL)), s)).single().inputJson shouldBe
            """{"document_id":"d-1"}"""
    }

    "labels: add tags the document, a label it has is nothing, remove untags by edge" {
        var s = onScreen(
            driveAnswer(
                rows = listOf(row("d-1", "Lease").copy(labels = listOf(DocsLabel(tag_id = "t-1", label = "signed")))),
                labels = listOf("signed", "tax"),
            ),
        )
        s = drive(DocsDriveEvent(row_menu = DocsDriveEvent.RowMenuOpened(document_id = "d-1")), s).state
        s = drive(DocsDriveEvent(action = DocsDriveEvent.ActionPicked(key = DocsWrites.KEY_LABELS)), s).state
        val sheet = s.sheet!!.labels!!
        sheet.current.map { it.label } shouldBe listOf("signed")
        sheet.available shouldBe listOf("tax")
        sheet.can_add shouldBe false
        s = drive(DocsDriveEvent(label_draft = DocsDriveEvent.LabelDraftEdited(text = "insurance")), s).state
        s.sheet!!.labels!!.can_add shouldBe true
        writes(drive(DocsDriveEvent(label_added = DocsDriveEvent.LabelAdded(label = " insurance ")), s)).single().let {
            it.command shouldBe "core.tag_item"
            it.inputJson shouldBe """{"subject_type":"core.document","subject_id":"d-1","label":"insurance"}"""
        }
        drive(DocsDriveEvent(label_added = DocsDriveEvent.LabelAdded(label = "signed")), s).effects.shouldBeEmpty()
        writes(drive(DocsDriveEvent(label_removed = DocsDriveEvent.LabelRemoved(tag_id = "t-1")), s)).single().let {
            it.command shouldBe "core.untag_item"
            it.inputJson shouldBe """{"tag_id":"t-1"}"""
        }
    }

    "trash asks first, says it can be restored, and dismissing writes nothing" {
        var s = onScreen(driveAnswer(rows = listOf(row("d-1", "Lease"))))
        s = drive(DocsDriveEvent(row_menu = DocsDriveEvent.RowMenuOpened(document_id = "d-1")), s).state
        val asked = drive(DocsDriveEvent(action = DocsDriveEvent.ActionPicked(key = DocsWrites.KEY_TRASH)), s)
        asked.effects.shouldBeEmpty()
        asked.state.confirm!!.body shouldBe "It can be restored from trash for 30 days."
        drive(DocsDriveEvent(dismissed = DocsDriveEvent.Dismissed()), asked.state).let {
            it.effects.shouldBeEmpty()
            it.state.confirm.shouldBeNull()
        }
        writes(drive(DocsDriveEvent(confirmed = DocsDriveEvent.Confirmed()), asked.state)).single().let {
            it.command shouldBe "core.trash_document"
            it.invokeKey shouldBe "core.trash_document:d-1"
        }
    }

    "rename is inline and autosaves: debounced, one key per edit, blank refused, close saves" {
        var s = onScreen(driveAnswer(rows = listOf(row("d-1", "Lease"))))
        s = drive(DocsDriveEvent(row_menu = DocsDriveEvent.RowMenuOpened(document_id = "d-1")), s).state
        s = drive(DocsDriveEvent(action = DocsDriveEvent.ActionPicked(key = DocsWrites.KEY_RENAME)), s).state
        s.rename!!.title shouldBe "Lease"
        val typed = drive(DocsDriveEvent(rename_edited = DocsDriveEvent.RenameEdited(title = "Lease 2026")), s)
        writes(typed).shouldBeEmpty()
        typed.effects.single() shouldBe ScreenEffect.Schedule(DocsDriveMachine.SCREEN_ID, AutosaveLaw.tokenOf(1), AutosaveLaw.DEBOUNCE_MS)
        // The row draws the member's title while the field is open.
        typed.state.data_!!.rows.single().title shouldBe "Lease 2026"
        val saved = drive(DocsDriveEvent(tick = DocsDriveEvent.Ticked(token = AutosaveLaw.tokenOf(1))), typed.state)
        writes(saved).single().let {
            it.command shouldBe "core.rename_document"
            it.inputJson shouldBe """{"document_id":"d-1","title":"Lease 2026"}"""
            it.invokeKey shouldBe "core.rename_document:d-1:seq=1"
        }
        saved.state.rename!!.status_label shouldBe "Saving"
        val committed = drive(settled("core.rename_document:d-1:seq=1"), saved.state).state
        committed.rename!!.status_label shouldBe "Saved"
        // Close = done: nothing unsaved, so the field goes.
        drive(DocsDriveEvent(rename_closed = DocsDriveEvent.RenameClosed()), committed).state.rename.shouldBeNull()

        // Blank: refused with a sentence, and closing keeps the vault's name.
        val blank = drive(DocsDriveEvent(rename_edited = DocsDriveEvent.RenameEdited(title = " ")), s).state
        val tick = drive(DocsDriveEvent(tick = DocsDriveEvent.Ticked(token = AutosaveLaw.tokenOf(1))), blank)
        writes(tick).shouldBeEmpty()
        tick.state.rename!!.status_label shouldBe DocsCopy.NAME_REQUIRED
        drive(DocsDriveEvent(rename_closed = DocsDriveEvent.RenameClosed()), tick.state).let {
            writes(it).shouldBeEmpty()
            it.state.rename.shouldBeNull()
        }

        // Leaving the screen with unsaved words saves them.
        val left = drive(DocsDriveMachine.left(), typed.state)
        writes(left).single().command shouldBe "core.rename_document"
    }

    // --- Folders, capture ---------------------------------------------------

    "a folder page: its children, its crumbs, and a new folder made inside it" {
        val folders = listOf(
            DocsFolder(folder_id = "f-home", name = "Home", document_count = 2),
            DocsFolder(folder_id = "f-lease", name = "Leases", parent_id = "f-home", document_count = 1),
        )
        val s = answered(
            opened(DocsDriveState.Destination.DESTINATION_FOLDERS, "f-home", "Home").state,
            driveAnswer(rows = listOf(row("d-1", "Lease", folder = "f-home")), folders = folders),
        )
        s.data_!!.folders.map { it.name to it.count_label } shouldBe listOf("Leases" to "1 document")
        s.data_!!.crumbs.map { it.name } shouldBe listOf("Home")
        var n = drive(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = DocsSheet.Kind.KIND_NEW_FOLDER)), s).state
        n.sheet!!.new_folder!!.where_label shouldBe "In Home"
        n.sheet!!.new_folder!!.can_create shouldBe false
        drive(DocsDriveEvent(folder_created = DocsDriveEvent.FolderCreated()), n).effects.shouldBeEmpty()
        n = drive(DocsDriveEvent(folder_name = DocsDriveEvent.FolderNameEdited(name = "Insurance")), n).state
        n.sheet!!.new_folder!!.can_create shouldBe true
        writes(drive(DocsDriveEvent(folder_created = DocsDriveEvent.FolderCreated()), n)).single().let {
            it.command shouldBe "core.create_folder"
            it.inputJson shouldBe """{"name":"Insurance","parent_folder_id":"f-home"}"""
        }
        // The Folders tab from a folder page goes to the top level.
        val top = drive(DocsDriveEvent(band = DocsDriveEvent.BandPicked(key = "folders")), s)
        top.state.folder_id shouldBe ""
        reads(top).size shouldBe 1
    }

    "the Add sheet: capture rows follow the OS grants, as state" {
        var s = onScreen()
        s = drive(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = DocsSheet.Kind.KIND_ADD)), s).state
        s.sheet!!.actions!!.actions.map { it.key } shouldBe listOf("upload", "scan", "text", "new_folder")
        s = drive(
            DocsDriveEvent(
                permission = DocsDriveEvent.PermissionChanged(
                    surface = DocsDriveEvent.PermissionChanged.Surface.SURFACE_CAMERA,
                    permission = DocsCapture.Permission.PERMISSION_DENIED,
                ),
            ),
            s,
        ).state
        s.sheet!!.actions!!.actions.single { it.key == "scan" }.let {
            it.enabled shouldBe false
            it.detail shouldBe DocsCopy.CAMERA_DENIED
        }
        s = drive(
            DocsDriveEvent(
                permission = DocsDriveEvent.PermissionChanged(
                    surface = DocsDriveEvent.PermissionChanged.Surface.SURFACE_CAMERA,
                    permission = DocsCapture.Permission.PERMISSION_UNAVAILABLE,
                ),
            ),
            s,
        ).state
        s.sheet!!.actions!!.actions.map { it.key } shouldBe listOf("upload", "text", "new_folder")
        // Capture is an intent: nothing is written, the sheet goes.
        drive(DocsDriveEvent(add_requested = DocsDriveEvent.AddRequested()), s).let {
            it.effects.shouldBeEmpty()
            it.state.sheet!!.kind shouldBe DocsSheet.Kind.KIND_NONE
        }
    }

    // --- One document ---------------------------------------------------------

    fun doc(e: DocsDocumentEvent, s: DocsDocumentState = DocsDocumentMachine.initial()) = DocsDocumentMachine.reduce(s, e)

    fun docOpened(id: String = "d-1") = doc(DocsDocumentEvent(opened = DocsDocumentEvent.Opened(document_id = id, title = "Lease")))

    fun docLanded(answer: DocsDocument, activity: DocsActivity = DocsActivity(), s: DocsDocumentState = docOpened().state) =
        doc(
            DocsDocumentReads.arrived(
                listOf(
                    AppQueryResponse(docs_document = answer),
                    AppQueryResponse(docs_activity = activity),
                    AppQueryResponse(docs_drive = driveAnswer(folders = listOf(DocsFolder(folder_id = "f", name = "Taxes")))),
                ),
            ),
            s,
        ).state

    "a document asks for itself, its activity and the rail, and waits for an id" {
        DocsDocumentReads.requests(DocsDocumentMachine.initial(), now).shouldBeNull()
        val asked = DocsDocumentReads.requests(docOpened().state, now).shouldNotBeNull()
        asked[0].docs_document!!.document_id shouldBe "d-1"
        asked[1].docs_activity!!.document_id shouldBe "d-1"
        asked[2].docs_drive!!.limit shouldBe DocsDocumentReads.RAIL_WINDOW
    }

    "the three surfaces: reader over the text, stage over held bytes or why not, facts for the rest" {
        val text = docLanded(
            DocsDocument(
                document = row("d-1", "Notes", kind = DocsKind.DOCS_KIND_DOCUMENT, surface = DocsSurface.DOCS_SURFACE_READING, media = "text/markdown"),
                body = "# Rent",
                versions = listOf(version("c-2", 2, current = true), version("c-1", 1)),
                today = TODAY,
            ),
            DocsActivity(events = listOf(DocsActivityEvent(activity = "core.edit_document", agent_kind = "owner", occurred_local = "2026-03-11T09:12"))),
        ).data_!!
        text.reading!!.let {
            it.body shouldBe "# Rent"
            it.has_text shouldBe true
            it.format shouldBe DocsReader.Format.FORMAT_MARKDOWN
            it.editable shouldBe true
        }
        text.actions.map { it.key } shouldBe listOf("edit", "star", "rename", "move", "labels", "trash")
        text.versions.map { it.label } shouldBe listOf("Version 2", "Version 1")
        text.versions.map { it.restore_label } shouldBe listOf("", "Restore")
        text.activity.single().let {
            it.label shouldBe "Edited"
            it.meta shouldBe "You · Wed 11 March 09:12"
        }
        text.facts.map { it.label } shouldBe listOf("Kind", "Size", "Media type", "Folder", "Added", "Changed", "Versions")

        // Text this vault does not hold is said, not drawn as an empty page.
        docLanded(
            DocsDocument(document = row("d-1", "Notes", surface = DocsSurface.DOCS_SURFACE_READING), today = TODAY),
        ).data_!!.reading!!.let {
            it.has_text shouldBe false
            it.no_text shouldBe DocsCopy.NO_TEXT
            it.editable shouldBe false
        }

        docLanded(
            DocsDocument(document = row("d-1", "Scan", kind = DocsKind.DOCS_KIND_IMAGE, surface = DocsSurface.DOCS_SURFACE_STAGE), bytes_held = true, today = TODAY),
        ).data_!!.stage!!.let {
            it.media shouldBe DocsStage.Media.MEDIA_IMAGE
            it.held shouldBe true
            it.content_id shouldBe "c-d-1"
        }
        docLanded(
            DocsDocument(
                document = row("d-1", "Scan", kind = DocsKind.DOCS_KIND_PDF, surface = DocsSurface.DOCS_SURFACE_STAGE),
                bytes_held = false,
                bytes_absent_reason = "Only the backup holds this file.",
                today = TODAY,
            ),
        ).data_!!.stage!!.let {
            it.held shouldBe false
            it.absent_reason shouldBe "Only the backup holds this file."
        }
        docLanded(
            DocsDocument(document = row("d-1", "Archive", kind = DocsKind.DOCS_KIND_OTHER, surface = DocsSurface.DOCS_SURFACE_FACTS), today = TODAY),
        ).data_!!.facts_only!!.sentence shouldBe DocsCopy.FACTS_ONLY

        // Gone is a state, not an error.
        docLanded(DocsDocument(today = TODAY)).data_!!.gone!!.headline shouldBe DocsCopy.GONE
    }

    "a trashed document offers restore only, and never says it will be deleted" {
        val live = docLanded(
            DocsDocument(document = row("d-1", "Lease", trashed = true, purgeInDays = 3, purgeDay = "2026-03-14"), today = TODAY),
        )
        live.data_!!.actions.map { it.key } shouldBe listOf("restore")
        live.data_!!.trashed_note shouldBe "In trash · restorable until Sat 14 March"
        writes(doc(DocsDocumentEvent(action = DocsDocumentEvent.ActionPicked(key = "restore")), live)).single().command shouldBe
            "core.restore_document"
        // Keys the head does not offer are nothing.
        doc(DocsDocumentEvent(action = DocsDocumentEvent.ActionPicked(key = "trash")), live).effects.shouldBeEmpty()

        val lapsed = docLanded(
            DocsDocument(document = row("d-1", "Lease", trashed = true, purgeInDays = 0, purgeDay = "2026-03-11"), today = TODAY),
        )
        lapsed.data_!!.trashed_note shouldBe DocsCopy.IN_TRASH_LAPSED
        lapsed.data_!!.actions.single().enabled shouldBe false
        doc(DocsDocumentEvent(action = DocsDocumentEvent.ActionPicked(key = "restore")), lapsed).effects.shouldBeEmpty()
    }

    "a document's head writes: star, move and an earlier version made current" {
        val s = docLanded(
            DocsDocument(
                document = row("d-1", "Lease"),
                versions = listOf(version("c-2", 2, current = true), version("c-1", 1)),
                today = TODAY,
            ),
        )
        writes(doc(DocsDocumentEvent(action = DocsDocumentEvent.ActionPicked(key = "star")), s)).single().command shouldBe
            "core.star_document"
        val moving = doc(DocsDocumentEvent(action = DocsDocumentEvent.ActionPicked(key = "move")), s).state
        moving.sheet!!.choices!!.choices.map { it.label } shouldBe listOf("Top level", "Taxes")
        writes(doc(DocsDocumentEvent(version_restore = DocsDocumentEvent.VersionRestoreTapped(content_id = "c-1")), s)).single().let {
            it.command shouldBe "core.restore_document_version"
            it.inputJson shouldBe """{"document_id":"d-1","content_id":"c-1"}"""
        }
        doc(DocsDocumentEvent(version_restore = DocsDocumentEvent.VersionRestoreTapped(content_id = "c-2")), s).effects.shouldBeEmpty()

        // THE VERBS SHEET is the machine's: every head verb, and a pick closes it.
        val more = doc(DocsDocumentEvent(more_opened = DocsDocumentEvent.MoreOpened()), s).state
        more.sheet.shouldNotBeNull().kind shouldBe DocsSheet.Kind.KIND_MORE
        more.sheet.shouldNotBeNull().title shouldBe "Lease"
        more.sheet.shouldNotBeNull().actions.shouldNotBeNull().actions.map { it.key } shouldBe s.data_.shouldNotBeNull().actions.map { it.key }
        val starred = doc(DocsDocumentEvent(action = DocsDocumentEvent.ActionPicked(key = "star")), more)
        starred.state.sheet.shouldNotBeNull().kind shouldBe DocsSheet.Kind.KIND_NONE
        writes(starred).single().command shouldBe "core.star_document"
    }

    // --- The editor -----------------------------------------------------------

    fun edit(e: DocsEditorEvent, s: DocsEditorState = DocsEditorMachine.initial()) = DocsEditorMachine.reduce(s, e)

    fun editorWith(body: String, versions: Int = 1): DocsEditorState {
        val opened = edit(DocsEditorEvent(opened = DocsEditorEvent.Opened(document_id = "d-1", title = "Notes"))).state
        return edit(DocsEditorReads.arrived(listOf(AppQueryResponse(docs_document = textDoc(body, versions)))), opened).state
    }

    "the editor autosaves: one edit_document per settled edit, body always sent, the version follows" {
        val s = editorWith("rent")
        s.draft!!.body shouldBe "rent"
        s.version_label shouldBe "Version 1"
        val typed = edit(DocsEditorEvent(body = DocsEditorEvent.BodyEdited(body = "rent is due")), s)
        typed.state.status_label shouldBe DocsCopy.EDITED
        writes(typed).shouldBeEmpty()
        val saving = edit(DocsEditorEvent(tick = DocsEditorEvent.Ticked(token = AutosaveLaw.tokenOf(1))), typed.state)
        writes(saving).single().let {
            it.command shouldBe "core.edit_document"
            it.inputJson shouldBe """{"document_id":"d-1","body_text":"rent is due"}"""
            it.invokeKey shouldBe "core.edit_document:d-1:seq=1"
        }
        // Its own commit arrives as a change while saving: noted, not read.
        val during = edit(DocsEditorMachine.rowsChanged("core_document", emptyList())!!, saving.state)
        during.effects.shouldBeEmpty()
        val committed = edit(DocsEditorReads.settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", "core.edit_document:d-1:seq=1"), during.state)
        committed.state.status_label shouldBe DocsCopy.SAVED
        reads(committed).size shouldBe 1
        val reread = edit(DocsEditorReads.arrived(listOf(AppQueryResponse(docs_document = textDoc("rent is due", 2)))), committed.state)
        reread.state.version_label shouldBe "Version 2"

        // A title change still sends the body the command requires.
        val titled = edit(DocsEditorEvent(title = DocsEditorEvent.TitleEdited(title = "Rent")), s)
        writes(edit(DocsEditorMachine.left(), titled.state)).single().inputJson shouldBe
            """{"document_id":"d-1","body_text":"rent","title":"Rent"}"""
        // Clearing the text is a save, not a refusal.
        val cleared = edit(DocsEditorEvent(body = DocsEditorEvent.BodyEdited(body = "")), s)
        writes(edit(DocsEditorMachine.left(), cleared.state)).single().inputJson shouldBe
            """{"document_id":"d-1","body_text":""}"""
    }

    "a vault change never replaces words being typed" {
        val typed = edit(DocsEditorEvent(body = DocsEditorEvent.BodyEdited(body = "mine")), editorWith("rent")).state
        val changed = edit(DocsEditorMachine.rowsChanged("core_document", listOf("d-1"))!!, typed)
        changed.effects.shouldBeEmpty()
        changed.state.autosave!!.remote_changed shouldBe true
        changed.state.remote_note shouldBe DocsCopy.REMOTE_CHANGED
        changed.state.draft!!.body shouldBe "mine"
        // Another table's keys are not this document.
        edit(DocsEditorMachine.rowsChanged("core_tag", listOf("t-1"))!!, typed).effects.shouldBeEmpty()
    }

    "only a live text document with text opens in the editor" {
        val opened = edit(DocsEditorEvent(opened = DocsEditorEvent.Opened(document_id = "d-1"))).state
        val image = DocsDocument(document = row("d-1", "Scan", surface = DocsSurface.DOCS_SURFACE_STAGE), today = TODAY)
        edit(DocsEditorReads.arrived(listOf(AppQueryResponse(docs_document = image))), opened).state.failure!!.sentence shouldBe
            DocsCopy.NOT_EDITABLE
        val trashed = textDoc("rent").let { it.copy(document = it.document!!.copy(trashed = true)) }
        edit(DocsEditorReads.arrived(listOf(AppQueryResponse(docs_document = trashed))), opened).state.failure!!.sentence shouldBe
            DocsCopy.TRASHED_NOT_EDITABLE
    }

    // --- Trash ------------------------------------------------------------------

    "the trash has no destroy path: no purge, and Empty trash promises only that nothing can be restored" {
        DocsTrashSpec.purgeCommand.shouldBeNull()
        DocsTrashSpec.emptyCommand shouldBe "core.empty_document_trash"
        val opened = DocsTrashMachine.reduce(DocsTrashMachine.initial(), TrashListEvent(opened = TrashListEvent.Opened()))
        opened.state.app_id shouldBe "docs"
        val landed = DocsTrashMachine.reduce(
            opened.state,
            TrashListEvent(
                data_ = TrashListEvent.DataArrived(
                    data_ = TrashListData(rows = listOf(TrashRow(id = "d-1", title = "Lease"))),
                    answered_cursor = "",
                ),
            ),
        ).state
        landed.data_!!.rows.single().purge_label shouldBe ""
        landed.data_!!.empty_label shouldBe "Empty trash"
        DocsTrashMachine.reduce(landed, TrashListEvent(purge = TrashListEvent.PurgeTapped(id = "d-1"))).let {
            it.effects.shouldBeEmpty()
            it.state.confirm.shouldBeNull()
        }
        val asked = DocsTrashMachine.reduce(landed, TrashListEvent(empty = TrashListEvent.EmptyTapped())).state
        asked.confirm!!.body shouldBe DocsCopy.TRASH_EMPTY_BODY
        asked.confirm!!.body shouldNotContain "for good"
        DocsTrashMachine.reduce(asked, TrashListEvent(confirmed = TrashListEvent.Confirmed())).effects
            .filterIsInstance<ScreenEffect.SubmitWrite>().single().command shouldBe "core.empty_document_trash"
        writes(DocsTrashMachine.reduce(landed, TrashListEvent(restore = TrashListEvent.RestoreTapped(id = "d-1")))).single().inputJson shouldBe
            """{"document_id":"d-1"}"""
        val empty = DocsTrashMachine.reduce(opened.state, TrashListEvent(data_ = TrashListEvent.DataArrived(data_ = TrashListData(), answered_cursor = ""))).state
        empty.data_!!.empty!!.body shouldBe DocsCopy.TRASH_EMPTY_STATE_BODY
        empty.data_!!.empty_label shouldBe ""
    }

    "no Docs string promises deletion or names a gateway" {
        val root = File(System.getProperty("centraid.repositoryRoot") ?: error("unset"))
        val copy = root.resolve("copy/docs.json").readText().substringAfter("\"strings\": {").substringBefore("\n  }").lowercase()
        listOf("forever", "for good", "gateway", "purge", "shared with", "deleted on").forEach { copy shouldNotContain it }
        copy shouldContain "can no longer be restored"
    }

    // --- Navigation -------------------------------------------------------------

    "Docs' band moves in place; a document and the editor push" {
        val home = NavStack().withDocsDestination(DocsDriveState.Destination.DESTINATION_ALL)
        val starred = home.withDocsDestination(DocsDriveState.Destination.DESTINATION_STARRED)
        starred.entries.size shouldBe 2
        starred.current shouldBe Destination.DocsHome(DocsDriveState.Destination.DESTINATION_STARRED)
        val editor = starred.push(Destination.DocsDocument("d-1", "Lease")).push(Destination.DocsEditor("d-1", "Lease"))
        editor.pop().current shouldBe Destination.DocsDocument("d-1", "Lease")
    }

    "the rename state's autosave is the kit's" {
        // A guard against a second autosave: the rename carries the kit message.
        var s = onScreen(driveAnswer(rows = listOf(row("d-1", "Lease"))))
        s = drive(DocsDriveEvent(row_menu = DocsDriveEvent.RowMenuOpened(document_id = "d-1")), s).state
        s = drive(DocsDriveEvent(action = DocsDriveEvent.ActionPicked(key = DocsWrites.KEY_RENAME)), s).state
        s.rename!!.autosave!!.phase shouldBe Autosave.Phase.PHASE_CLEAN
    }
}) {
    companion object {
        const val TODAY: String = "2026-03-11"

        fun row(
            id: String,
            title: String,
            starred: Boolean = false,
            folder: String = "",
            updated: String = "2026-03-10T17:00",
            kind: DocsKind = DocsKind.DOCS_KIND_PDF,
            surface: DocsSurface = DocsSurface.DOCS_SURFACE_STAGE,
            media: String = "application/pdf",
            trashed: Boolean = false,
            purgeInDays: Int = 0,
            purgeDay: String = "",
        ): DocsDocumentRow = DocsDocumentRow(
            document_id = id,
            content_id = "c-$id",
            title = title,
            media_type = media,
            kind = kind,
            kind_name = when (kind) {
                DocsKind.DOCS_KIND_PDF -> "PDF"
                DocsKind.DOCS_KIND_IMAGE -> "Image"
                DocsKind.DOCS_KIND_DOCUMENT -> "Document"
                else -> "File"
            },
            surface = surface,
            size = "2.4 MB",
            folder_id = folder,
            starred = starred,
            trashed = trashed,
            created_local = "2026-03-01T10:00",
            updated_local = updated,
            trashed_local = if (trashed) "2026-02-12T10:00" else "",
            purge_local_day = purgeDay,
            purge_in_days = purgeInDays,
        )

        fun driveAnswer(
            rows: List<DocsDocumentRow> = emptyList(),
            folders: List<DocsFolder> = emptyList(),
            labels: List<String> = emptyList(),
            truncated: Boolean = false,
        ): DocsDrive = DocsDrive(
            documents = rows,
            folders = folders,
            labels = labels,
            all_count = rows.size,
            starred_count = rows.count { it.starred },
            truncated = truncated,
            window = 200,
            today = TODAY,
            now_local = "2026-03-11T10:00",
        )

        fun version(contentId: String, n: Int, current: Boolean = false): DocsVersion = DocsVersion(
            content_id = contentId,
            size = "1 KB",
            current = current,
            number = n,
            asserted_local = "2026-03-0${n}T09:00",
        )

        fun textDoc(body: String, versions: Int = 1): DocsDocument = DocsDocument(
            document = row(
                "d-1",
                "Notes",
                kind = DocsKind.DOCS_KIND_DOCUMENT,
                surface = DocsSurface.DOCS_SURFACE_READING,
                media = "text/plain",
            ).copy(content_id = "c-v$versions"),
            body = body,
            versions = (versions downTo 1).map { version("c-v$it", it, current = it == versions) },
            today = TODAY,
        )
    }
}
