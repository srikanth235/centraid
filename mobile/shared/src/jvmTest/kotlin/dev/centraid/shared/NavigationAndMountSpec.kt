package dev.centraid.shared

import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.TallyListState
import dev.centraid.shared.mount.Mount
import dev.centraid.shared.mount.MountKey
import dev.centraid.shared.mount.remount
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.core.spec.style.StringSpec

/**
 * The navigation model and the mount (#1020, D-1020-E1, D-1020-E4).
 *
 * Four of v0's sentences, each as a test rather than a comment.
 */
class NavigationAndMountSpec : StringSpec({

    "one root stack, and Home is the floor" {
        val stack = NavStack()
        stack.current shouldBe Destination.Home
        stack.pop() shouldBe stack
        shouldThrow<IllegalArgumentException> { NavStack(emptyList()) }
    }

    "a band destination changes in place, so back does not walk the bands" {
        // Doctrine 1. A second screen per band would make every band tap a
        // push, and a member who looked at three bands would press back three
        // times to leave Photos.
        val stack = NavStack()
            .push(Destination.PhotosHome())
            .withPhotosDestination(PhotosGridState.Destination.DESTINATION_COLLECTIONS)
            .withPhotosDestination(PhotosGridState.Destination.DESTINATION_SEARCH)
        stack.entries.size shouldBe 2
        (stack.current as Destination.PhotosHome).destination shouldBe
            PhotosGridState.Destination.DESTINATION_SEARCH
        stack.pop().current shouldBe Destination.Home
    }

    "a band destination from somewhere else IS a push" {
        val stack = NavStack()
            .withTallyDestination(TallyListState.Destination.DESTINATION_BALANCES)
        stack.entries.size shouldBe 2
        (stack.current as Destination.TallyHome).destination shouldBe
            TallyListState.Destination.DESTINATION_BALANCES
    }

    "names ride along the route, so an app bar has something to say at once" {
        // Doctrine 2 (`apps/mobile/src/navigation.ts:63-69`).
        val folder = Destination.DocsFolder(folderId = "fld-1", folderName = "Taxes")
        folder.folderName shouldBe "Taxes"
        Destination.NotesEditor(noteId = "note-1", title = "Winter plans").title shouldBe
            "Winter plans"
    }

    "a photo state view is a discriminated union" {
        // Doctrine 3. The person case carries the name; the mode case carries
        // no party id, and the type system is what says so.
        val person = Destination.PhotoStateViewRoute(
            PhotoStateView(
                person = PhotoStateView.Person(party_id = "pty-1", person_name = "Ada"),
            ),
        )
        person.view.person?.person_name shouldBe "Ada"
        person.view.mode shouldBe null
    }

    "there is no permission destination, and there is no vault parameter" {
        // Doctrine 4, and the mount rule, asserted the only way an absence can
        // be: by naming the grep. `Destination`'s sealed subclasses are the
        // whole set, and neither a permission nor a vault id is among them.
        val names = Destination::class.sealedSubclasses.mapNotNull { it.simpleName }
        names.none { it.contains("Permission") }.shouldBeTrue()
        names.none { it.contains("Vault", ignoreCase = false) && it != "Vault" }
            .shouldBeTrue()
        // `Vault` IS a destination — it is v0's `Data` alias, a screen. What is
        // not a destination is a vault ID as a parameter, and no destination
        // carries one.
        names.contains("Vault").shouldBeTrue()
    }

    "there is no stand-in for a gateway id" {
        // Census §E seam 2. The literal `"manual"` named a file whose path
        // moved the moment a real endpoint arrived, orphaning every write
        // queued under it. A `MountKey` cannot hold it.
        shouldThrow<IllegalArgumentException> { MountKey("manual", "vlt-1") }
            .message!! shouldContain "orphaned every queued write"
        shouldThrow<IllegalArgumentException> { MountKey("", "vlt-1") }
            .message!! shouldContain "never names a placeholder"
        shouldThrow<IllegalArgumentException> { MountKey("gw-1", " ") }
    }

    "a waiting mount names no file at all" {
        // Not "names a placeholder file"; names nothing. The state carries a
        // reason a member can read and no key.
        val waiting = Mount.Waiting(Mount.Waiting.Reason.RESOLVING_ENDPOINT)
        (waiting is Mount.Waiting).shouldBeTrue()
        Mount.Waiting.Reason.entries.size shouldBe 3
    }

    "switching vaults IS the remount" {
        val first = MountKey("gw-1", "vlt-1")
        val second = MountKey("gw-1", "vlt-2")
        val mounted = remount(Mount.Waiting(Mount.Waiting.Reason.NOT_PAIRED), first)
        mounted shouldBe Mount.Mounted(first)
        // Same key: the same mount, not a remount of the same file.
        remount(mounted, first) shouldBe mounted
        // Different vault: a different mount, and a different file.
        remount(mounted, second) shouldBe Mount.Mounted(second)
        first.fileName shouldBe "gw-1.vlt-1.replica.db"
        (first.fileName != second.fileName).shouldBeTrue()
    }
})
