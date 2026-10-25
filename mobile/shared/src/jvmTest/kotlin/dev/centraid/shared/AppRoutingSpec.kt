package dev.centraid.shared

import centraid.core.v1.NotesPlace
import centraid.core.v1.Route
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
import centraid.screen.v1.TileStatus
import dev.centraid.shared.apps.locker.LockerAccessMachine
import dev.centraid.shared.apps.locker.LockerEditorMachine
import dev.centraid.shared.apps.locker.LockerExportMachine
import dev.centraid.shared.apps.locker.LockerHomeMachine
import dev.centraid.shared.apps.locker.LockerImportMachine
import dev.centraid.shared.apps.locker.LockerItemMachine
import dev.centraid.shared.apps.locker.LockerRouting
import dev.centraid.shared.apps.locker.LockerTrashMachine
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
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.MemberAction
import dev.centraid.shared.nav.RowRef
import dev.centraid.shared.nav.RowRoutes
import dev.centraid.shared.nav.ScreenIds
import dev.centraid.shared.nav.NavMove
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.nav.NotesEntry
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
 * the unfiled filter) and that every page a
 * routing names is one `ScreenOpenings` spells, on the screen id its machine
 * registers under.
 */
class AppRoutingSpec : StringSpec({
    val home = Destination.Home

    "a move drops the top (never the floor), then pushes; spelled, it is the same openings in order" {
        val stack = NavStack().push(Destination.LockerHome())
        stack.applying(NavMove.swap(Destination.LockerTrash)).entries shouldContainExactly listOf(home, Destination.LockerTrash)
        stack.applying(NavMove.Pop).entries shouldContainExactly listOf(home)
        NavStack().applying(NavMove.Pop).entries shouldContainExactly listOf(home)
        stack.applying(NavMove.push(Destination.LockerTrash)).entries shouldContainExactly
            listOf(home, Destination.LockerHome(), Destination.LockerTrash)

        val spelled = ScreenMoves.of(NavMove(dropsTop = true, pushes = listOf(Destination.LockerEditor(itemId = "i1"), Destination.LockerItem("i1"))))
        spelled.shouldNotBeNull()
        spelled.dropsTop shouldBe true
        spelled.openings.map { it.screenId } shouldContainExactly listOf(LockerEditorMachine.SCREEN_ID, LockerItemMachine.SCREEN_ID)
        // Half a move is no move: a page no route spells spells nothing.
        ScreenMoves.of(NavMove(pushes = listOf(Destination.LockerTrash, Destination.Settings))).shouldBeNull()
        ScreenMoves.of(null).shouldBeNull()
    }

    "every page a routing names is spelled on the id its machine registers under" {
        val ids = mapOf(
            Destination.MoneyTarget("2026-10", "c", "EUR") to MoneyTargetMachine.SCREEN_ID,
            Destination.MoneyRecurring() to MoneyRecurringMachine.SCREEN_ID,
            Destination.MoneyImport() to MoneyImportMachine.SCREEN_ID,
            Destination.MoneyAccounts() to MoneyAccountsMachine.SCREEN_ID,
            Destination.MoneyRules() to MoneyRulesMachine.SCREEN_ID,
            Destination.MoneyCategories() to MoneyCategoriesMachine.SCREEN_ID,
            Destination.MoneySearch to MoneySearchMachine.SCREEN_ID,
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
        LockerEditorEvent.ADAPTER.decode(ScreenOpenings.of(Destination.LockerEditor(itemId = "i2"))!!.event).opened!!.run {
            mode shouldBe LockerEditorState.Mode.MODE_EDIT
            item_id shouldBe "i2"
            password shouldBe ""
        }
    }

    // --- Notes -----------------------------------------------------------

    "Notes' entry: the tile opens its shelf's place, a new note on an empty vault, and nothing while it reads" {
        val route = { destination: Destination? -> (destination as Destination.RustScreen).route }
        val tile = HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_EMPTY)
        route(NotesEntry.tile(tile)).notes_editor!!.is_new shouldBe true
        route(NotesEntry.tile(null)).notes_editor!!.is_new shouldBe true
        NotesEntry.tile(HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_LOADING)).shouldBeNull()
        NotesEntry.tile(HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_UNKNOWN)).shouldBeNull()
        val shelf = HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_CONTENT)
        route(NotesEntry.tile(shelf)).screen shouldBe "notes.home"
        route(NotesEntry.tile(shelf)).notes_home!!.place shouldBe NotesPlace.NOTES_PLACE_NOTES
        // Spelled, a Notes page is the Rust screen id and the encoded route, which a shell that keys by id pushes.
        val opening = NotesEntry.tileOpening(tile.encode())!!
        opening.screenId shouldBe ScreenIds.RUST_SCREEN
        Route.ADAPTER.decode(opening.event).screen shouldBe "notes.editor"
        NotesEntry.tileOpening(byteArrayOf(-1, -1)).shouldBeNull()
    }

    "Notes' rows route by their kind: a note opens its editor, a notebook the home filtered to it" {
        val note = RowRoutes.destination(RowRef(AppIds.NOTES, "note", "n1", "Plans")) as Destination.RustScreen
        note.route.notes_editor!!.note_id shouldBe "n1"
        val book = RowRoutes.destination(RowRef(AppIds.NOTES, "notebook", "nb", "Cabin")) as Destination.RustScreen
        book.route.notes_home!!.notebook_id shouldBe "nb"
        book.route.notes_home!!.notebook_name shouldBe "Cabin"
        (RowRoutes.appHome(AppIds.NOTES) as Destination.RustScreen).route.screen shouldBe "notes.home"
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

    "a Locker card offered by the assistant runs its action: reveal and code on the page, a secret to type in the editor, export in the export" {
        fun card(qualifier: String, id: String = "i1") = RowRef(AppIds.LOCKER, "locker_item", id, "Home Wi-Fi", qualifier)
        RowRoutes.destination(card("reveal:password"), parent = "Chat") shouldBe
            Destination.LockerItem("i1", parent = "Chat", follow = "reveal:password")
        RowRoutes.destination(card("code:otp_seed")) shouldBe Destination.LockerItem("i1", follow = "code:otp_seed")
        RowRoutes.destination(card("edit_secret:cvv")) shouldBe Destination.LockerEditor(itemId = "i1")
        RowRoutes.destination(card("export:", id = "")) shouldBe Destination.LockerExport
        // no action, an unknown one, or one with no field: the plain card, never a crash
        for (plain in listOf("", "wipe:password", "reveal:", "reveal", ":password", "2026-10-08")) {
            RowRoutes.destination(card(plain), parent = "Chat") shouldBe Destination.LockerItem("i1", parent = "Chat")
        }
        // spelled for a shell that sends bytes: the page's Opened event carries the action
        val opening = RowRoutes.route(card("reveal:password"))!!
        LockerItemEvent.ADAPTER.decode(opening.event).opened!!.follow shouldBe "reveal:password"
    }

    "MemberAction parses each action once and spells the qualifier back" {
        MemberAction.parse(AppIds.LOCKER, "locker_item", "i1", "reveal:card_number") shouldBe
            MemberAction(MemberAction.Kind.Reveal, "i1", "card_number")
        MemberAction.parse(AppIds.LOCKER, "locker_item", "i1", "code:otp_seed")!!.qualifier shouldBe "code:otp_seed"
        MemberAction.parse(AppIds.LOCKER, "locker_item", "i1", "edit_secret:password")!!.kind shouldBe MemberAction.Kind.EditSecret
        MemberAction.parse(AppIds.LOCKER, "locker_item", "", "export:")!!.kind shouldBe MemberAction.Kind.Export
        MemberAction.parse(AppIds.LOCKER, "locker_item", "", "reveal:password").shouldBeNull()
        MemberAction.parse(AppIds.AGENDA, "task", "t1", "reveal:password").shouldBeNull()
        MemberAction.parse(AppIds.LOCKER, "locker_item", "i1", "").shouldBeNull()
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
