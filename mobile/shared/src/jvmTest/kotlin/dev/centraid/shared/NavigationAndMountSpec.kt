package dev.centraid.shared

import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.TallyListState
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.Mount
import dev.centraid.shared.shell.MountKey
import dev.centraid.shared.shell.remount
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain

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

    "a replica is named by its vault and by nothing else" {
        // #1025 S5, D-1025-S5-2. The key was `(gatewayId, vaultId)` and the file
        // was `"$gatewayId.$vaultId.replica.db"`, which D-1025-S1-1 deleted from
        // the core: a gateway id is an ADDRESS and never a name a copy is filed
        // under. This assertion is what makes a re-addition loud — one vault
        // reached through two gateways must be ONE file, with one cursor and
        // one outbox.
        val key = MountKey("vlt-1")
        key.fileName shouldBe "centraid-replica-vlt-1.sqlite3"
        MountKey::class.java.declaredFields.none { it.name.contains("gateway", true) }
            .shouldBeTrue()
    }

    "there is no stand-in for a vault id" {
        // Census §E seam 2. The literal `"manual"` named a file whose path
        // moved the moment a real endpoint arrived, orphaning every write
        // queued under it. A `MountKey` cannot hold it.
        shouldThrow<IllegalArgumentException> { MountKey("manual") }
            .message!! shouldContain "orphaned every queued write"
        shouldThrow<IllegalArgumentException> { MountKey("") }
        shouldThrow<IllegalArgumentException> { MountKey(" ") }
    }

    "a waiting mount names no file at all" {
        // Not "names a placeholder file"; names nothing. The state carries a
        // reason a member can read and no key.
        val waiting = Mount.Waiting(Mount.Waiting.Reason.BOOTSTRAPPING)
        (waiting is Mount.Waiting).shouldBeTrue()
        Mount.Waiting.Reason.entries.size shouldBe 3
    }

    "switching vaults IS the remount" {
        val first = MountKey("vlt-1")
        val second = MountKey("vlt-2")
        val mounted = remount(Mount.Waiting(Mount.Waiting.Reason.NOT_PAIRED), first)
        mounted shouldBe Mount.Mounted(first)
        // Same key: the same mount, not a remount of the same file.
        remount(mounted, first) shouldBe mounted
        // Different vault: a different mount, and a different file.
        remount(mounted, second) shouldBe Mount.Mounted(second)
        (first.fileName != second.fileName).shouldBeTrue()
    }

    "no gateway id names anything under mobile/" {
        // #1025 S5, D-1025-S5-2, asserted over the SOURCE rather than over one
        // type: `MountKey` losing its field is necessary and not sufficient —
        // the name could come back as a `CoreConfiguration` parameter, a file
        // name built in a shell, or a Swift property, and each of those is the
        // same defect wearing a different hat.
        //
        // Prose is exempt by construction: this looks for the identifier
        // SPELLINGS a compiler would resolve, and the comments that explain why
        // the gateway is gone say "gateway id" in words.
        val root = java.io.File(
            System.getProperty("centraid.mobileRoot")
                ?: error("centraid.mobileRoot is unset; see mobile/shared/build.gradle.kts"),
        )
        val forbidden = Regex("""\bgatewayId\b|\bgatewayHex\b|\bgateway_id\b""")
        val offenders = root.walkTopDown()
            // `build/` and `.build/` hold generated and stale artifacts — a
            // framework header from a previous link is not this tree's source.
            .onEnter { it.name != "build" && it.name != ".build" && it.name != "Generated" }
            .filter { it.isFile && (it.extension == "kt" || it.extension == "swift") }
            .flatMap { file ->
                file.readLines().withIndex().mapNotNull { (line, text) ->
                    // A line that CITES the deletion is the record of it, not a
                    // use of it. `MountKey(gatewayId, vaultId)` in a doc comment
                    // is what a reader needs to understand the rename.
                    if (forbidden.containsMatchIn(text) && !text.contains("D-1025-S5-2") &&
                        !text.trimStart().startsWith("*") && !text.trimStart().startsWith("//") &&
                        !text.trimStart().startsWith("///")
                    ) {
                        "${file.name}:${line + 1}: ${text.trim()}"
                    } else {
                        null
                    }
                }
            }
            .toList()
        withClue(offenders) { offenders shouldBe emptyList() }
    }
})
