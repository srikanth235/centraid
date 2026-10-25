package dev.centraid.shared

import centraid.core.v1.Route
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.LockerEntry
import dev.centraid.shared.nav.MemberAction
import dev.centraid.shared.nav.RowRef
import dev.centraid.shared.nav.RowRoutes
import dev.centraid.shared.nav.ScreenIds
import dev.centraid.shared.nav.HealthEntry
import dev.centraid.shared.nav.PeopleEntry
import dev.centraid.shared.nav.PhotosEntry
import dev.centraid.shared.nav.ScreenOpenings
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * WHERE A CHAT CARD GOES, STATED ONCE ON THIS SIDE (#1029 port; #1135).
 *
 * Home, search and every app's rows carry the route Rust built, and the stack,
 * the move and Notes' tile are Rust's (`crates/screens/src/shell`, whose tests
 * hold those cases). What remains here is the table the chat's cards still use
 * until the chat is Rust's: a row of an app opens that app's page, spelled as a
 * `ScreenOpening` a shell pushes.
 */
class AppRoutingSpec : StringSpec({
    "every app's page opens as a Rust screen carrying its route" {
        listOf(PhotosEntry.home(), PhotosEntry.lightbox("a1"), PeopleEntry.home(), HealthEntry.home()).forEach { destination ->
            val opening = ScreenOpenings.of(destination).shouldNotBeNull()
            opening.screenId shouldBe ScreenIds.RUST_SCREEN
            Route.ADAPTER.decode(opening.event) shouldBe destination.route
        }
    }

    // --- Notes ---------------------------------------------------------

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
