package dev.centraid.shared

import centraid.core.v1.NotesPlace
import centraid.core.v1.Route
import centraid.screen.v1.HomeTile
import centraid.screen.v1.PeopleChannelRow
import centraid.screen.v1.PeopleEditorEvent
import centraid.screen.v1.PeopleHomeEvent
import centraid.screen.v1.PeoplePersonData
import centraid.screen.v1.PeoplePersonEvent
import centraid.screen.v1.PeoplePersonState
import centraid.screen.v1.TileStatus
import dev.centraid.shared.apps.health.HealthConnectMachine
import dev.centraid.shared.apps.health.HealthHomeMachine
import dev.centraid.shared.apps.health.HealthMetricMachine
import dev.centraid.shared.apps.health.HealthWorkoutMachine
import dev.centraid.shared.apps.people.PeopleEditorMachine
import dev.centraid.shared.apps.people.PeopleHomeMachine
import dev.centraid.shared.apps.people.PeoplePersonMachine
import dev.centraid.shared.apps.people.PeopleRouting
import dev.centraid.shared.apps.people.PeopleTrashMachine
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.LockerEntry
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
 * the unfiled filter, a new person's id is minted once) and that every page a
 * routing names is one `ScreenOpenings` spells, on the screen id its machine
 * registers under.
 */
class AppRoutingSpec : StringSpec({
    val home = Destination.Home

    "a move drops the top (never the floor), then pushes; spelled, it is the same openings in order" {
        val stack = NavStack().push(Destination.PeopleHome())
        stack.applying(NavMove.swap(Destination.PeopleTrash)).entries shouldContainExactly listOf(home, Destination.PeopleTrash)
        stack.applying(NavMove.Pop).entries shouldContainExactly listOf(home)
        NavStack().applying(NavMove.Pop).entries shouldContainExactly listOf(home)
        stack.applying(NavMove.push(Destination.PeopleTrash)).entries shouldContainExactly
            listOf(home, Destination.PeopleHome(), Destination.PeopleTrash)

        val spelled = ScreenMoves.of(NavMove(dropsTop = true, pushes = listOf(Destination.PeopleEditor("p1"), Destination.PeoplePerson("p1"))))
        spelled.shouldNotBeNull()
        spelled.dropsTop shouldBe true
        spelled.openings.map { it.screenId } shouldContainExactly listOf(PeopleEditorMachine.SCREEN_ID, PeoplePersonMachine.SCREEN_ID)
        // Half a move is no move: a page no route spells spells nothing.
        ScreenMoves.of(NavMove(pushes = listOf(Destination.PeopleTrash, Destination.Settings))).shouldBeNull()
        ScreenMoves.of(null).shouldBeNull()
    }

    "every page a routing names is spelled on the id its machine registers under" {
        val ids = mapOf(
            Destination.PeopleEditor("p") to PeopleEditorMachine.SCREEN_ID,
            Destination.PeopleTrash to PeopleTrashMachine.screenId,
            Destination.HealthHome() to HealthHomeMachine.SCREEN_ID,
            Destination.HealthMetric("steps") to HealthMetricMachine.SCREEN_ID,
            Destination.HealthWorkout("a") to HealthWorkoutMachine.SCREEN_ID,
            Destination.HealthConnect() to HealthConnectMachine.SCREEN_ID,
        )
        ids.forEach { (destination, id) -> ScreenOpenings.of(destination).shouldNotBeNull().screenId shouldBe id }
    }

    "the openings carry what the page opens on" {
        PeopleEditorEvent.ADAPTER.decode(ScreenOpenings.of(Destination.PeopleEditor("p9", isNew = true))!!.event).opened!!.run {
            minted_party_id shouldBe "p9"
            party_id shouldBe ""
        }
        PeopleEditorEvent.ADAPTER.decode(ScreenOpenings.of(Destination.PeopleEditor("p9"))!!.event).opened!!.party_id shouldBe "p9"
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

    // --- Locker ----------------------------------------------------------

    "a Locker card offered by the assistant runs its action: reveal and code on the page, a secret to type in the editor, export in the export" {
        fun card(qualifier: String, id: String = "i1") = RowRef(AppIds.LOCKER, "locker_item", id, "Home Wi-Fi", qualifier)
        RowRoutes.destination(card("reveal:password"), parent = "Chat") shouldBe
            LockerEntry.item("i1", parent = "Chat", follow = "reveal:password")
        RowRoutes.destination(card("code:otp_seed")) shouldBe LockerEntry.item("i1", follow = "code:otp_seed")
        RowRoutes.destination(card("edit_secret:cvv")) shouldBe LockerEntry.editor("i1")
        RowRoutes.destination(card("export:", id = "")) shouldBe LockerEntry.export()
        // no action, an unknown one, or one with no field: the plain card, never a crash
        for (plain in listOf("", "wipe:password", "reveal:", "reveal", ":password", "2026-10-08")) {
            RowRoutes.destination(card(plain), parent = "Chat") shouldBe LockerEntry.item("i1", parent = "Chat")
        }
        // every Locker destination is one Rust screen the shell hosts
        ScreenOpenings.of(LockerEntry.item("i1")).shouldNotBeNull().screenId shouldBe ScreenIds.RUST_SCREEN
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
})
