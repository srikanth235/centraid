package dev.centraid.shared

import centraid.screen.v1.AgendaEditorEvent
import centraid.screen.v1.AgendaEditorState
import centraid.screen.v1.AgendaEventEvent
import centraid.screen.v1.AgendaEventState
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.DocsDocumentEvent
import centraid.screen.v1.DocsDocumentState
import centraid.screen.v1.DocsDriveChrome
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsDriveState
import centraid.screen.v1.DocsEditorEvent
import centraid.screen.v1.DocsIngestState
import centraid.screen.v1.HomeTile
import centraid.screen.v1.LockerEditorEvent
import centraid.screen.v1.LockerEditorState
import centraid.screen.v1.LockerGeneratorEvent
import centraid.screen.v1.LockerHomeChrome
import centraid.screen.v1.LockerHomeEvent
import centraid.screen.v1.LockerHomeState
import centraid.screen.v1.LockerItemEvent
import centraid.screen.v1.LockerItemState
import centraid.screen.v1.MoneyHomeChrome
import centraid.screen.v1.MoneyHomeEvent
import centraid.screen.v1.MoneyHomeState
import centraid.screen.v1.MoneyImportEvent
import centraid.screen.v1.MoneyImportState
import centraid.screen.v1.MoneyPageChrome
import centraid.screen.v1.MoneySearchEvent
import centraid.screen.v1.MoneySearchState
import centraid.screen.v1.MoneyTargetEvent
import centraid.screen.v1.MoneyTransactionEvent
import centraid.screen.v1.NotesEditorChrome
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.NotesJournalEvent
import centraid.screen.v1.NotesLibraryEvent
import centraid.screen.v1.NotesNotebooksEvent
import centraid.screen.v1.PeopleChannelRow
import centraid.screen.v1.PeopleEditorEvent
import centraid.screen.v1.PeopleHomeEvent
import centraid.screen.v1.PeoplePersonData
import centraid.screen.v1.PeoplePersonEvent
import centraid.screen.v1.PeoplePersonState
import centraid.screen.v1.TasksHomeEvent
import centraid.screen.v1.TasksHomeState
import centraid.screen.v1.TileStatus
import dev.centraid.shared.apps.agenda.AgendaEditorMachine
import dev.centraid.shared.apps.agenda.AgendaEventMachine
import dev.centraid.shared.apps.agenda.AgendaHomeMachine
import dev.centraid.shared.apps.agenda.AgendaRouting
import dev.centraid.shared.apps.docs.DocsDocumentMachine
import dev.centraid.shared.apps.docs.DocsDriveMachine
import dev.centraid.shared.apps.docs.DocsEditorMachine
import dev.centraid.shared.apps.docs.DocsRouting
import dev.centraid.shared.apps.docs.DocsTrashMachine
import dev.centraid.shared.apps.locker.LockerAccessMachine
import dev.centraid.shared.apps.locker.LockerEditorMachine
import dev.centraid.shared.apps.locker.LockerExportMachine
import dev.centraid.shared.apps.locker.LockerHomeMachine
import dev.centraid.shared.apps.locker.LockerImportMachine
import dev.centraid.shared.apps.locker.LockerItemMachine
import dev.centraid.shared.apps.locker.LockerRouting
import dev.centraid.shared.apps.locker.LockerTrashMachine
import dev.centraid.shared.apps.health.HealthConnectMachine
import dev.centraid.shared.apps.health.HealthHomeMachine
import dev.centraid.shared.apps.health.HealthMetricMachine
import dev.centraid.shared.apps.health.HealthWorkoutMachine
import dev.centraid.shared.apps.money.MoneyAccountsMachine
import dev.centraid.shared.apps.money.MoneyCategoriesMachine
import dev.centraid.shared.apps.money.MoneyHomeMachine
import dev.centraid.shared.apps.money.MoneyImportMachine
import dev.centraid.shared.apps.money.MoneyRecurringMachine
import dev.centraid.shared.apps.money.MoneyRouting
import dev.centraid.shared.apps.money.MoneyRulesMachine
import dev.centraid.shared.apps.money.MoneySearchMachine
import dev.centraid.shared.apps.money.MoneyTargetMachine
import dev.centraid.shared.apps.money.MoneyTransactionMachine
import dev.centraid.shared.apps.notes.NotesBand
import dev.centraid.shared.apps.notes.NotesEditorMachine
import dev.centraid.shared.apps.notes.NotesHistoryMachine
import dev.centraid.shared.apps.notes.NotesJournalMachine
import dev.centraid.shared.apps.notes.NotesLibraryMachine
import dev.centraid.shared.apps.notes.NotesNotebooksMachine
import dev.centraid.shared.apps.notes.NotesRouting
import dev.centraid.shared.apps.notes.NotesTrashMachine
import dev.centraid.shared.apps.people.PeopleEditorMachine
import dev.centraid.shared.apps.people.PeopleHomeMachine
import dev.centraid.shared.apps.people.PeoplePersonMachine
import dev.centraid.shared.apps.people.PeopleRouting
import dev.centraid.shared.apps.people.PeopleTrashMachine
import dev.centraid.shared.apps.tasks.TasksHomeMachine
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavMove
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.nav.ScreenMoves
import dev.centraid.shared.nav.ScreenOpenings
import dev.centraid.shared.nav.applying
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldNotBeEmpty

/**
 * WHERE EVERY APP'S INTENTS GO IS STATED ONCE, IN SHARED (#1029 port).
 *
 * Each `<App>Routing` answers an event with the move Android applies, and its
 * bytes door answers the same move spelled for iOS. These pin both halves:
 * the decisions (a band place swaps, Done pops, a notebook named Unfiled is
 * the unfiled filter, a new person's id is minted once) and that every page a
 * routing names is one `ScreenOpenings` spells, on the screen id its machine
 * registers under.
 */
class AppRoutingSpec : StringSpec({
    val home = Destination.Home

    "a move drops the top (never the floor), then pushes; spelled, it is the same openings in order" {
        val stack = NavStack().push(Destination.NotesLibrary())
        stack.applying(NavMove.swap(Destination.NotesJournal)).entries shouldContainExactly listOf(home, Destination.NotesJournal)
        stack.applying(NavMove.Pop).entries shouldContainExactly listOf(home)
        NavStack().applying(NavMove.Pop).entries shouldContainExactly listOf(home)
        stack.applying(NavMove.push(Destination.NotesTrash)).entries shouldContainExactly
            listOf(home, Destination.NotesLibrary(), Destination.NotesTrash)

        val spelled = ScreenMoves.of(NavMove(dropsTop = true, pushes = listOf(Destination.NotesEditor("n1"), Destination.NotesHistory("n1"))))
        spelled.shouldNotBeNull()
        spelled.dropsTop shouldBe true
        spelled.openings.map { it.screenId } shouldContainExactly listOf(NotesEditorMachine.SCREEN_ID, NotesHistoryMachine.SCREEN_ID)
        // Half a move is no move: a page no route spells spells nothing.
        ScreenMoves.of(NavMove(pushes = listOf(Destination.NotesTrash, Destination.Settings))).shouldBeNull()
        ScreenMoves.of(null).shouldBeNull()
    }

    "every page a routing names is spelled on the id its machine registers under" {
        val ids = mapOf(
            Destination.NotesNotebooks to NotesNotebooksMachine.SCREEN_ID,
            Destination.NotesJournal to NotesJournalMachine.SCREEN_ID,
            Destination.NotesHistory("n") to NotesHistoryMachine.SCREEN_ID,
            Destination.NotesTrash to NotesTrashMachine.screenId,
            Destination.DocsEditor("d") to DocsEditorMachine.SCREEN_ID,
            Destination.DocsTrash to DocsTrashMachine.screenId,
            Destination.PeopleEditor("p") to PeopleEditorMachine.SCREEN_ID,
            Destination.PeopleTrash to PeopleTrashMachine.screenId,
            Destination.AgendaEditor(day = "2026-10-17") to AgendaEditorMachine.SCREEN_ID,
            Destination.MoneyTarget("2026-10", "c", "EUR") to MoneyTargetMachine.SCREEN_ID,
            Destination.MoneyRecurring() to MoneyRecurringMachine.SCREEN_ID,
            Destination.MoneyImport() to MoneyImportMachine.SCREEN_ID,
            Destination.MoneyAccounts() to MoneyAccountsMachine.SCREEN_ID,
            Destination.MoneyRules() to MoneyRulesMachine.SCREEN_ID,
            Destination.MoneyCategories() to MoneyCategoriesMachine.SCREEN_ID,
            Destination.MoneySearch to MoneySearchMachine.SCREEN_ID,
            Destination.HealthHome() to HealthHomeMachine.SCREEN_ID,
            Destination.HealthMetric("steps") to HealthMetricMachine.SCREEN_ID,
            Destination.HealthWorkout("a") to HealthWorkoutMachine.SCREEN_ID,
            Destination.HealthConnect() to HealthConnectMachine.SCREEN_ID,
            Destination.LockerHome() to LockerHomeMachine.SCREEN_ID,
            Destination.LockerItem("i") to LockerItemMachine.SCREEN_ID,
            Destination.LockerEditor() to LockerEditorMachine.SCREEN_ID,
            Destination.LockerTrash to LockerTrashMachine.screenId,
            Destination.LockerExport to LockerExportMachine.SCREEN_ID,
            Destination.LockerImport to LockerImportMachine.SCREEN_ID,
            Destination.LockerAccess to LockerAccessMachine.SCREEN_ID,
        )
        ids.forEach { (destination, id) -> ScreenOpenings.of(destination).shouldNotBeNull().screenId shouldBe id }
        // The generator's candidate is never a route parameter, so its editor has no opening.
        ScreenOpenings.of(Destination.LockerEditor(type = "login", fromGenerator = true)).shouldBeNull()
    }

    "the openings carry what the page opens on" {
        PeopleEditorEvent.ADAPTER.decode(ScreenOpenings.of(Destination.PeopleEditor("p9", isNew = true))!!.event).opened!!.run {
            minted_party_id shouldBe "p9"
            party_id shouldBe ""
        }
        PeopleEditorEvent.ADAPTER.decode(ScreenOpenings.of(Destination.PeopleEditor("p9"))!!.event).opened!!.party_id shouldBe "p9"
        AgendaEditorEvent.ADAPTER.decode(ScreenOpenings.of(Destination.AgendaEditor(day = "2026-10-17"))!!.event).opened!!.run {
            mode shouldBe AgendaEditorState.Mode.MODE_CREATE
            day shouldBe "2026-10-17"
        }
        AgendaEditorEvent.ADAPTER.decode(
            ScreenOpenings.of(Destination.AgendaEditor("e1", "k1", null, "2026-10-17"))!!.event,
        ).opened!!.mode shouldBe AgendaEditorState.Mode.MODE_EDIT
        LockerEditorEvent.ADAPTER.decode(ScreenOpenings.of(Destination.LockerEditor(itemId = "i2"))!!.event).opened!!.run {
            mode shouldBe LockerEditorState.Mode.MODE_EDIT
            item_id shouldBe "i2"
            password shouldBe ""
        }
        DocsEditorEvent.ADAPTER.decode(ScreenOpenings.of(Destination.DocsEditor("d1", "Lease"))!!.event).opened!!.title shouldBe "Lease"
    }

    // --- Notes -----------------------------------------------------------

    "Notes: another band place swaps the top; the same place and More are the machine's" {
        fun band(key: String) = NotesLibraryEvent(band = NotesLibraryEvent.BandPicked(key = key))
        NotesRouting.library(band(NotesBand.NOTEBOOKS)) shouldBe NavMove.swap(Destination.NotesNotebooks)
        NotesRouting.library(band(NotesBand.NOTES)).shouldBeNull()
        NotesRouting.library(band(NotesBand.MORE)).shouldBeNull()
        NotesRouting.notebooks(NotesNotebooksEvent(band = NotesNotebooksEvent.BandPicked(key = NotesBand.JOURNAL))) shouldBe
            NavMove.swap(Destination.NotesJournal)
        NotesRouting.journal(NotesJournalEvent(band = NotesJournalEvent.BandPicked(key = NotesBand.NOTES))) shouldBe
            NavMove.swap(Destination.NotesLibrary())
        NotesRouting.journal(NotesJournalEvent(band = NotesJournalEvent.BandPicked(key = NotesBand.JOURNAL))).shouldBeNull()
    }

    "Notes: a notebook is the Notes place filtered, swapped in; Unfiled is the unfiled filter, not a notebook id" {
        NotesRouting.notebooks(NotesNotebooksEvent(notebook_picked = NotesNotebooksEvent.NotebookPicked(id = "nb", name = "Cabin"))) shouldBe
            NavMove.swap(Destination.NotesLibrary(notebookId = "nb", notebookName = "Cabin"))
        NotesRouting.notebooks(
            NotesNotebooksEvent(notebook_picked = NotesNotebooksEvent.NotebookPicked(id = NotesNotebooksMachine.UNFILED, name = "Unfiled")),
        ) shouldBe NavMove.swap(Destination.NotesLibrary(notebookName = "Unfiled", unfiledOnly = true))
        NotesRouting.notebooks(NotesNotebooksEvent(trash_opened = NotesNotebooksEvent.TrashOpened())) shouldBe NavMove.push(Destination.NotesTrash)
    }

    "Notes: a note, a new note and More's Trash push; a note with no id opens nothing" {
        NotesRouting.library(NotesLibraryEvent(note_picked = NotesLibraryEvent.NotePicked(note_id = "n1", title = "Hi"))) shouldBe
            NavMove.push(Destination.NotesEditor("n1", "Hi"))
        NotesRouting.library(NotesLibraryEvent(note_picked = NotesLibraryEvent.NotePicked())).shouldBeNull()
        val fresh = NotesRouting.library(NotesLibraryEvent(new_note = NotesLibraryEvent.NewNoteRequested()))!!.pushes.single()
        (fresh as Destination.NotesEditor).isNew shouldBe true
        fresh.noteId.shouldNotBeEmpty()
        NotesRouting.library(NotesLibraryEvent(more_row = NotesLibraryEvent.MoreRowPicked(key = NotesLibraryMachine.MORE_TRASH))) shouldBe
            NavMove.push(Destination.NotesTrash)
        NotesRouting.journal(NotesJournalEvent(entry_picked = NotesJournalEvent.EntryPicked(note_id = "j1"))) shouldBe
            NavMove.push(Destination.NotesEditor("j1", ""))
    }

    "Notes: History re-spells the note under it as no longer new, once the note has history; Send to Tasks lands on the Inbox" {
        val history = NotesEditorEvent(history = NotesEditorEvent.HistoryRequested())
        NotesRouting.editor(history, NotesEditorState(note_id = "n1")).shouldBeNull()
        val ready = NotesEditorState(note_id = "n1", chrome = NotesEditorChrome(history_enabled = true))
        NotesRouting.editor(history, ready) shouldBe NavMove(
            dropsTop = true,
            pushes = listOf(Destination.NotesEditor("n1", "", isNew = false), Destination.NotesHistory("n1", "")),
        )
        NotesRouting.editor(NotesEditorEvent(send_to_tasks = NotesEditorEvent.SendToTasks(text = "  ")), ready).shouldBeNull()
        val sent = NotesRouting.editor(NotesEditorEvent(send_to_tasks = NotesEditorEvent.SendToTasks(text = "Buy milk")), ready)
        sent shouldBe NavMove.push(Destination.TasksHome(TasksHomeState.Destination.DESTINATION_INBOX, quickAdd = "Buy milk"))
        // Spelled, the words ride the home's `Opened`.
        val opening = ScreenMoves.of(sent)!!.openings.single()
        opening.screenId shouldBe TasksHomeMachine.SCREEN_ID
        TasksHomeEvent.ADAPTER.decode(opening.event).opened!!.quick_add_title shouldBe "Buy milk"
    }

    "Notes: Done pops onto a Notes screen, else swaps in the library; the tile opens its note" {
        NotesRouting.close(NotesLibraryMachine.SCREEN_ID) shouldBe NavMove.Pop
        NotesRouting.close("") shouldBe NavMove.swap(Destination.NotesLibrary())
        NotesRouting.close(TasksHomeMachine.SCREEN_ID) shouldBe NavMove.swap(Destination.NotesLibrary())

        val tile = HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_EMPTY)
        (NotesRouting.tile(tile) as Destination.NotesEditor).isNew shouldBe true
        NotesRouting.tile(HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_LOADING)).shouldBeNull()
        NotesRouting.tileOpening(tile.encode())!!.screenId shouldBe NotesEditorMachine.SCREEN_ID
        NotesRouting.tileOpening(byteArrayOf(-1, -1)).shouldBeNull()
    }

    "Notes, asked as bytes, answer the move Android applies" {
        val swap = NotesRouting.route(
            NotesLibraryMachine.SCREEN_ID,
            NotesLibraryEvent(band = NotesLibraryEvent.BandPicked(key = NotesBand.JOURNAL)).encode(),
            ByteArray(0),
        )
        swap.shouldNotBeNull()
        swap.dropsTop shouldBe true
        swap.openings.single().screenId shouldBe NotesJournalMachine.SCREEN_ID
        NotesRouting.route(NotesLibraryMachine.SCREEN_ID, byteArrayOf(-1, -1, -1), ByteArray(0)).shouldBeNull()
        NotesRouting.route("tasks.home", ByteArray(0), ByteArray(0)).shouldBeNull()
        NotesRouting.closeMove("")!!.openings.single().screenId shouldBe NotesLibraryMachine.SCREEN_ID
    }

    // --- Money -----------------------------------------------------------

    "Money: every home intent pushes with the home's title as the back word; More's rows are pages" {
        val state = MoneyHomeState(chrome = MoneyHomeChrome(title = "Spending"), month = "2026-10")
        MoneyRouting.home(MoneyHomeEvent(add = MoneyHomeEvent.AddStatement()), state) shouldBe Destination.MoneyImport(parent = "Spending")
        MoneyRouting.home(MoneyHomeEvent(search_opened = MoneyHomeEvent.SearchOpened()), state) shouldBe Destination.MoneySearch
        MoneyRouting.home(MoneyHomeEvent(transaction = MoneyHomeEvent.TransactionPicked(txn_id = "t1")), state) shouldBe
            Destination.MoneyTransaction("t1", "Spending")
        MoneyRouting.home(MoneyHomeEvent(transaction = MoneyHomeEvent.TransactionPicked()), state).shouldBeNull()
        MoneyRouting.home(
            MoneyHomeEvent(category_line = MoneyHomeEvent.CategoryLinePicked(category_id = "c1", currency = "EUR")),
            state,
        ) shouldBe Destination.MoneyTarget("2026-10", "c1", "EUR")
        MoneyRouting.home(MoneyHomeEvent(recurring = MoneyHomeEvent.RecurringOpened()), state) shouldBe Destination.MoneyRecurring("Spending")
        val more = MoneyHomeMachine.initial().screen.chrome!!.more_rows.map { it.key }
        more.forEach { key ->
            MoneyRouting.home(MoneyHomeEvent(more = MoneyHomeEvent.MorePicked(key = key)), state).shouldNotBeNull()
        }
        MoneyRouting.home(MoneyHomeEvent(more = MoneyHomeEvent.MorePicked(key = MoneyHomeMachine.MORE_RULES)), state) shouldBe
            Destination.MoneyRules("Spending")
    }

    "Money: the import's Add an account pushes and its Done pops; search picks a transaction" {
        val importing = MoneyImportState(chrome = MoneyPageChrome(title = "Import"))
        MoneyRouting.importer(MoneyImportEvent(add_account = MoneyImportEvent.AddAccount()), importing) shouldBe
            NavMove.push(Destination.MoneyAccounts("Import"))
        MoneyRouting.importer(MoneyImportEvent(done = MoneyImportEvent.Done()), importing) shouldBe NavMove.Pop
        MoneyRouting.search(
            MoneySearchEvent(transaction = MoneySearchEvent.TransactionPicked(txn_id = "t2")),
            MoneySearchState(chrome = MoneyPageChrome(title = "Search")),
        ) shouldBe Destination.MoneyTransaction("t2", "Search")
        val done = MoneyRouting.route(MoneyImportMachine.SCREEN_ID, MoneyImportEvent(done = MoneyImportEvent.Done()).encode(), importing.encode())
        done.shouldNotBeNull()
        done.dropsTop shouldBe true
        done.openings shouldBe emptyList()
    }

    "Money: an opening is sent with a draft token minted per arrival; a page without a draft is sent as it is" {
        val opening = ScreenOpenings.of(Destination.MoneyTransaction("t1", "Spending"))!!
        MoneyTransactionEvent.ADAPTER.decode(opening.event).opened!!.draft_token shouldBe ""
        val sent = MoneyTransactionEvent.ADAPTER.decode(MoneyRouting.opened(opening.screenId, opening.event)).opened!!
        sent.txn_id shouldBe "t1"
        sent.parent shouldBe "Spending"
        sent.draft_token.shouldNotBeEmpty()
        val target = ScreenOpenings.of(Destination.MoneyTarget("2026-10", "c", "EUR"))!!
        MoneyTargetEvent.ADAPTER.decode(MoneyRouting.opened(target.screenId, target.event)).opened!!.draft_token.shouldNotBeEmpty()
        // THE HOME OPENS ON THE BAND IT WAS NAMED: a shared Money home route is no longer always Spending.
        val activity = ScreenOpenings.of(Destination.MoneyHome(MoneyHomeState.Destination.DESTINATION_ACTIVITY))!!
        MoneyRouting.opened(activity.screenId, activity.event) shouldBe activity.event
        MoneyHomeEvent.ADAPTER.decode(activity.event).opened!!.destination shouldBe MoneyHomeState.Destination.DESTINATION_ACTIVITY
        MoneyRouting.opened(MoneyTransactionMachine.SCREEN_ID, byteArrayOf(-1, -1)) shouldBe byteArrayOf(-1, -1)
    }

    // --- People ----------------------------------------------------------

    "People: a person, a touch, Add and Trash push; a new person's id is minted once, for the route" {
        PeopleRouting.home(PeopleHomeEvent(person = PeopleHomeEvent.PersonPicked(party_id = "p1", name = "Ada"))) shouldBe
            Destination.PeoplePerson("p1", "Ada")
        PeopleRouting.home(PeopleHomeEvent(log_touch = PeopleHomeEvent.LogTouchRequested(party_id = "p1", name = "Ada"))) shouldBe
            Destination.PeoplePerson("p1", "Ada", logTouch = true)
        PeopleRouting.home(PeopleHomeEvent(person = PeopleHomeEvent.PersonPicked())).shouldBeNull()
        val added = PeopleRouting.home(PeopleHomeEvent(add_person = PeopleHomeEvent.AddPersonRequested())) as Destination.PeopleEditor
        added.isNew shouldBe true
        added.partyId.matches(Regex("^[0-9a-f-]{36}$")) shouldBe true
        PeopleRouting.home(PeopleHomeEvent(more_row = PeopleHomeEvent.MoreRowPicked(key = PeopleHomeMachine.MORE_TRASH))) shouldBe
            Destination.PeopleTrash
    }

    "People: Edit opens the person the page holds; a channel tap names its row" {
        val edit = PeoplePersonEvent(edit = PeoplePersonEvent.EditRequested())
        PeopleRouting.person(edit, PeoplePersonState()).shouldBeNull()
        PeopleRouting.person(edit, PeoplePersonState(party_id = "p1")) shouldBe Destination.PeopleEditor("p1")
        val row = PeopleChannelRow(channel_id = "c2", value_ = "+31 6")
        val state = PeoplePersonState(party_id = "p1", data_ = PeoplePersonData(channels = listOf(PeopleChannelRow(channel_id = "c1"), row)))
        val tapped = PeoplePersonEvent(channel = PeoplePersonEvent.ChannelTapped(channel_id = "c2"))
        PeopleRouting.channel(tapped, state) shouldBe row
        PeopleChannelRow.ADAPTER.decode(PeopleRouting.channelRow(tapped.encode(), state.encode())!!) shouldBe row
        PeopleRouting.channelRow(edit.encode(), state.encode()).shouldBeNull()
        PeopleRouting.route(PeoplePersonMachine.SCREEN_ID, edit.encode(), state.encode())!!.openings.single().screenId shouldBe
            PeopleEditorMachine.SCREEN_ID
    }

    // --- Agenda ----------------------------------------------------------

    "Agenda: an occurrence opens its detail; New event the editor on the anchor day; Edit the editor on the occurrence" {
        val picked = AgendaHomeEvent(
            event_picked = AgendaHomeEvent.EventPicked(event_id = "e1", instance_key = "k1", day = "2026-10-17"),
        )
        AgendaRouting.home(picked, AgendaHomeState()) shouldBe Destination.AgendaEvent("e1", "k1", null, "2026-10-17")
        AgendaRouting.home(AgendaHomeEvent(new_event = AgendaHomeEvent.NewEventRequested()), AgendaHomeState(anchor_day = "2026-10-20")) shouldBe
            Destination.AgendaEditor(day = "2026-10-20")
        val edit = AgendaEventEvent(action = AgendaEventEvent.ActionPicked(key = AgendaEventMachine.ACTION_EDIT))
        AgendaRouting.event(edit, AgendaEventState()).shouldBeNull()
        AgendaRouting.event(edit, AgendaEventState(event_id = "e1", instance_key = "k1", day = "2026-10-17")) shouldBe
            Destination.AgendaEditor("e1", "k1", null, "2026-10-17")
        AgendaRouting.event(AgendaEventEvent(action = AgendaEventEvent.ActionPicked(key = "cancel")), AgendaEventState(event_id = "e1")).shouldBeNull()
        AgendaRouting.route(AgendaHomeMachine.SCREEN_ID, picked.encode(), AgendaHomeState().encode())!!.openings.single().screenId shouldBe
            AgendaEventMachine.SCREEN_ID
    }

    // --- Docs ------------------------------------------------------------

    "Docs: a folder, a document and the trash push with the drive's title; a folder with no id is not a page" {
        val state = DocsDriveState(chrome = DocsDriveChrome(title = "Folders"))
        DocsRouting.drive(DocsDriveEvent(folder_picked = DocsDriveEvent.FolderPicked(folder_id = "f1", name = "Taxes")), state) shouldBe
            Destination.DocsFolder("f1", "Taxes", "Folders")
        DocsRouting.drive(DocsDriveEvent(folder_picked = DocsDriveEvent.FolderPicked(name = "Top")), state).shouldBeNull()
        DocsRouting.drive(DocsDriveEvent(document_picked = DocsDriveEvent.DocumentPicked(document_id = "d1", title = "Lease")), state) shouldBe
            Destination.DocsDocument("d1", "Lease", "Folders")
        DocsRouting.drive(DocsDriveEvent(trash_opened = DocsDriveEvent.TrashOpened()), state) shouldBe Destination.DocsTrash
        // The folder page is the drive's machine on its own key, and routes the same.
        DocsRouting.route(
            DocsDriveMachine.FOLDER_SCREEN_ID,
            DocsDriveEvent(document_picked = DocsDriveEvent.DocumentPicked(document_id = "d1")).encode(),
            state.encode(),
        )!!.openings.single().screenId shouldBe DocsDocumentMachine.SCREEN_ID
    }

    "Docs: a document's crumb names the document as the folder's parent; Edit opens the editor; a filed ingest opens once" {
        val document = DocsDocumentState(title_hint = "Lease")
        DocsRouting.document(DocsDocumentEvent(folder_picked = DocsDocumentEvent.FolderPicked(folder_id = "f1", name = "Taxes")), document) shouldBe
            Destination.DocsFolder("f1", "Taxes", "Lease")
        DocsRouting.document(DocsDocumentEvent(edit_requested = DocsDocumentEvent.EditRequested(document_id = "d1", title = "Lease")), document) shouldBe
            Destination.DocsEditor("d1", "Lease")
        val filed = DocsIngestState(phase = DocsIngestState.Phase.PHASE_FILED, document_id = "d2", title = "Scan", parent = "All")
        DocsRouting.filed(filed) shouldBe Destination.DocsDocument("d2", "Scan", parent = "All")
        DocsRouting.filed(filed.copy(open_editor = true)) shouldBe Destination.DocsEditor("d2", "Scan")
        DocsRouting.filed(filed.copy(routed = true)).shouldBeNull()
        DocsRouting.filed(filed.copy(phase = DocsIngestState.Phase.PHASE_UNSPECIFIED)).shouldBeNull()
        DocsRouting.filedOpening(filed.encode())!!.screenId shouldBe DocsDocumentMachine.SCREEN_ID
    }

    // --- Locker ----------------------------------------------------------

    "Locker: Add, an item and More's pages push; Lock and Facts are not pages" {
        val state = LockerHomeState(chrome = LockerHomeChrome(title = "Locker"))
        LockerRouting.home(LockerHomeEvent(add = LockerHomeEvent.AddItem()), state) shouldBe Destination.LockerEditor()
        LockerRouting.home(LockerHomeEvent(item = LockerHomeEvent.ItemPicked(item_id = "i1")), state) shouldBe
            Destination.LockerItem("i1", parent = "Locker")
        mapOf(
            LockerHomeMachine.MORE_IMPORT to Destination.LockerImport,
            LockerHomeMachine.MORE_EXPORT to Destination.LockerExport,
            LockerHomeMachine.MORE_ACCESS to Destination.LockerAccess,
            LockerHomeMachine.MORE_TRASH to Destination.LockerTrash,
        ).forEach { (key, page) -> LockerRouting.home(LockerHomeEvent(more = LockerHomeEvent.MorePicked(key = key)), state) shouldBe page }
        LockerRouting.home(LockerHomeEvent(more = LockerHomeEvent.MorePicked(key = LockerHomeMachine.MORE_LOCK)), state).shouldBeNull()
        LockerRouting.home(LockerHomeEvent(more = LockerHomeEvent.MorePicked(key = LockerHomeMachine.MORE_FACTS)), state).shouldBeNull()
    }

    "Locker: Edit opens the item the page holds; the generator's Use is Android's hand-over, never a spelled route" {
        val edit = LockerItemEvent(edit = LockerItemEvent.EditTapped())
        LockerRouting.item(edit, LockerItemState()).shouldBeNull()
        LockerRouting.item(edit, LockerItemState(item_id = "i1")) shouldBe Destination.LockerEditor(itemId = "i1")
        LockerRouting.generator(LockerGeneratorEvent(use = LockerGeneratorEvent.UseTapped())) shouldBe
            Destination.LockerEditor(type = "login", fromGenerator = true)
        LockerRouting.route(LockerItemMachine.SCREEN_ID, edit.encode(), LockerItemState(item_id = "i1").encode())!!.openings.single().screenId shouldBe
            LockerEditorMachine.SCREEN_ID
        LockerRouting.route(LockerHomeMachine.SCREEN_ID, LockerHomeEvent(add = LockerHomeEvent.AddItem()).encode(), ByteArray(0)) shouldNotBe null
    }
})
