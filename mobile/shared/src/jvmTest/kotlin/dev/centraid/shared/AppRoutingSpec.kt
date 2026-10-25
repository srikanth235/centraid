package dev.centraid.shared

import centraid.core.v1.NotesPlace
import centraid.core.v1.Route
import centraid.screen.v1.HomeTile
import centraid.screen.v1.TileStatus
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.LockerEntry
import dev.centraid.shared.nav.MemberAction
import dev.centraid.shared.nav.RowRef
import dev.centraid.shared.nav.RowRoutes
import dev.centraid.shared.nav.ScreenIds
import dev.centraid.shared.nav.NavMove
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.nav.HealthEntry
import dev.centraid.shared.nav.NotesEntry
import dev.centraid.shared.nav.PeopleEntry
import dev.centraid.shared.nav.PhotosEntry
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
        val photos = PhotosEntry.home()
        val lightbox = PhotosEntry.lightbox("a1")
        val stack = NavStack().push(photos)
        stack.applying(NavMove.swap(lightbox)).entries shouldContainExactly listOf(home, lightbox)
        stack.applying(NavMove.Pop).entries shouldContainExactly listOf(home)
        NavStack().applying(NavMove.Pop).entries shouldContainExactly listOf(home)
        stack.applying(NavMove.push(lightbox)).entries shouldContainExactly listOf(home, photos, lightbox)

        val spelled = ScreenMoves.of(NavMove(dropsTop = true, pushes = listOf(photos, lightbox)))
        spelled.shouldNotBeNull()
        spelled.dropsTop shouldBe true
        spelled.openings.map { Route.ADAPTER.decode(it.event) } shouldContainExactly listOf(photos.route, lightbox.route)
        // Half a move is no move: a page no route spells spells nothing.
        ScreenMoves.of(NavMove(pushes = listOf(lightbox, Destination.Settings))).shouldBeNull()
        ScreenMoves.of(null).shouldBeNull()
    }

    "every app's page opens as a Rust screen carrying its route" {
        listOf(PhotosEntry.home(), PhotosEntry.lightbox("a1"), PeopleEntry.home(), HealthEntry.home()).forEach { destination ->
            val opening = ScreenOpenings.of(destination).shouldNotBeNull()
            opening.screenId shouldBe ScreenIds.RUST_SCREEN
            Route.ADAPTER.decode(opening.event) shouldBe destination.route
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
