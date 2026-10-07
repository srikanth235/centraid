package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.DuplicateMember
import centraid.screen.v1.DuplicateReviewData
import centraid.screen.v1.DuplicateReviewEvent
import centraid.screen.v1.DuplicateReviewState
import centraid.screen.v1.PhotoCell
import dev.centraid.shared.apps.photos.DuplicateReviewLeg
import dev.centraid.shared.apps.photos.DuplicateReviewMachine
import dev.centraid.shared.apps.photos.DuplicateReviewReads
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain

/**
 * ONE CLUSTER'S REVIEW — the screen that deletes a member's photographs
 * (#1029, photos port).
 *
 * The tests below are the guards, and one of them is the reason this file
 * exists: **`ResolveRequested` with an empty `keep_asset_id` emits NOTHING.**
 * A reducer that fell back to "keep the first" or "keep the suggestion" would
 * trash copies nobody chose to trash, and it would do it silently, on a screen
 * whose whole job is to make the choice explicit.
 */
class DuplicateReviewSpec : StringSpec({

    fun member(
        assetId: String,
        width: Int = 0,
        height: Int = 0,
    ) = DuplicateMember(
        asset_id = assetId,
        byte_size = 0L,
        width = width,
        height = height,
        captured_at = "2026-02-03T10:00:00Z",
        member_placed = false,
        held = PhotoCell.Held.HELD_THUMBNAIL_ONLY,
    )

    /** A screen holding one cluster of three, with a suggestion on it. */
    fun loaded(
        members: List<DuplicateMember>,
        suggested: String = "",
    ): DuplicateReviewState = DuplicateReviewMachine.reduce(
        DuplicateReviewMachine.reduce(
            DuplicateReviewMachine.initial(),
            DuplicateReviewEvent(
                opened = DuplicateReviewEvent.Opened(cluster_id = "cluster-1"),
            ),
        ).state,
        DuplicateReviewEvent(
            data_ = DuplicateReviewEvent.DataArrived(
                data_ = DuplicateReviewData(
                    members = members,
                    suggested_keep_asset_id = suggested,
                    suggestion_reason = if (suggested.isEmpty()) {
                        ""
                    } else {
                        DuplicateReviewReads.SUGGESTION_REASON
                    },
                ),
            ),
        ),
    ).state

    // --- The guard this screen exists for ---------------------------------

    "RESOLVE WITH NO KEEP EMITS NOTHING — the bug that would cost photographs" {
        val state = loaded(listOf(member("a-1"), member("a-2"), member("a-3")))
        // The precondition: nothing is picked, because nothing pre-picks.
        state.keep_asset_id shouldBe ""
        val step = DuplicateReviewMachine.reduce(
            state,
            DuplicateReviewEvent(resolve = DuplicateReviewEvent.ResolveRequested()),
        )
        // NO WRITES. Not "keep the first", not "keep the suggestion", not a
        // partial resolve — nothing at all, and the state is untouched so the
        // screen still shows every copy.
        step.effects.shouldBeEmpty()
        step.state shouldBe state
    }

    "a suggestion is never written into keep_asset_id" {
        // The suggestion rides on the DATA, beside its reason. A suggestion a
        // member has not accepted must not be able to delete anything, and the
        // only thing that writes `keep_asset_id` is a member's tap.
        val state = loaded(
            listOf(member("a-1", 4032, 3024), member("a-2", 1024, 768)),
            suggested = "a-1",
        )
        state.data_.shouldNotBeNull().suggested_keep_asset_id shouldBe "a-1"
        state.keep_asset_id shouldBe ""
        // And a resolve is still a no-op, with a suggestion sitting right there.
        DuplicateReviewMachine.reduce(
            state,
            DuplicateReviewEvent(resolve = DuplicateReviewEvent.ResolveRequested()),
        ).effects.shouldBeEmpty()
    }

    "opening a cluster clears the keep the previous one had" {
        val picked = DuplicateReviewMachine.reduce(
            loaded(listOf(member("a-1"), member("a-2"))),
            DuplicateReviewEvent(keep = DuplicateReviewEvent.KeepPicked(asset_id = "a-1")),
        ).state
        picked.keep_asset_id shouldBe "a-1"
        // A DIFFERENT CLUSTER IS A DIFFERENT DECISION. A keep carried across
        // would name an asset that is not in the new cluster, and a resolve
        // under it would trash every member and keep nothing.
        val reopened = DuplicateReviewMachine.reduce(
            picked,
            DuplicateReviewEvent(
                opened = DuplicateReviewEvent.Opened(cluster_id = "cluster-2"),
            ),
        ).state
        reopened.keep_asset_id shouldBe ""
        reopened.cluster_id shouldBe "cluster-2"
        reopened.data_.shouldBeNull()
    }

    "a keep that is not on the screen is ignored" {
        // A view cannot pick a row it is not drawing, so an id from anywhere
        // else is a malformed event — and honouring one would arm a resolve
        // that trashes every member and keeps nothing.
        val state = loaded(listOf(member("a-1"), member("a-2")))
        DuplicateReviewMachine.reduce(
            state,
            DuplicateReviewEvent(keep = DuplicateReviewEvent.KeepPicked(asset_id = "a-99")),
        ).state.keep_asset_id shouldBe ""
    }

    "a keep that left the cluster is dropped when the next page lands" {
        val picked = DuplicateReviewMachine.reduce(
            loaded(listOf(member("a-1"), member("a-2"))),
            DuplicateReviewEvent(keep = DuplicateReviewEvent.KeepPicked(asset_id = "a-1")),
        ).state
        // The copy the member picked was trashed on another surface. Carrying
        // the id forward would leave `keep_asset_id` naming nothing while the
        // Resolve control still looked armed.
        val arrived = DuplicateReviewMachine.reduce(
            picked,
            DuplicateReviewEvent(
                data_ = DuplicateReviewEvent.DataArrived(
                    data_ = DuplicateReviewData(members = listOf(member("a-2"), member("a-3"))),
                ),
            ),
        ).state
        arrived.keep_asset_id shouldBe ""
    }

    // --- The write --------------------------------------------------------

    "a resolve trashes every copy but the kept one, and never purges" {
        val state = DuplicateReviewMachine.reduce(
            loaded(listOf(member("a-1"), member("a-2"), member("a-3"))),
            DuplicateReviewEvent(keep = DuplicateReviewEvent.KeepPicked(asset_id = "a-2")),
        ).state
        val step = DuplicateReviewMachine.reduce(
            state,
            DuplicateReviewEvent(resolve = DuplicateReviewEvent.ResolveRequested()),
        )
        val writes = step.effects.map { it as ScreenEffect.SubmitWrite }
        // ONE COMMAND PER ASSET. The vault registers `media.delete_asset` over
        // one `asset_id`; a bulk verb composed here would be a shell naming a
        // command the vault does not hold, which is how `notes.save` reached a
        // member's screen as "That request does not make sense to this build".
        writes.map { it.inputJson } shouldBe listOf(
            "{\"asset_id\":\"a-1\"}",
            "{\"asset_id\":\"a-3\"}",
        )
        // TRASH, NEVER PURGE. A duplicate sweep sends copies where the member
        // can change their mind; `media.purge_asset` is the permanent one and
        // this screen does not offer it.
        withClue(writes.map { it.command }) {
            writes.all { it.command == DuplicateReviewMachine.TRASH_COMMAND } shouldBe true
            writes.none { it.command.contains("purge") } shouldBe true
        }
        DuplicateReviewMachine.TRASH_COMMAND shouldBe "media.delete_asset"
        // THE INVOKE KEY IS THE ASSET, NOT AN ORDINAL. Without a stable key a
        // replayed command re-executes one that already committed; an ordinal
        // is only stable for a caller that makes the same sequence every time.
        writes.map { it.invokeKey } shouldBe listOf(
            "media.delete_asset:a-1",
            "media.delete_asset:a-3",
        )
        // The kept copy is not in the list, by ID and not by position: a list
        // re-read between the pick and the press can be in a different order,
        // and an index into it would trash the wrong photograph.
        writes.none { it.inputJson.contains("a-2") } shouldBe true
    }

    "a cluster of one with that one kept writes nothing" {
        val state = DuplicateReviewMachine.reduce(
            loaded(listOf(member("a-1"))),
            DuplicateReviewEvent(keep = DuplicateReviewEvent.KeepPicked(asset_id = "a-1")),
        ).state
        DuplicateReviewMachine.reduce(
            state,
            DuplicateReviewEvent(resolve = DuplicateReviewEvent.ResolveRequested()),
        ).effects.shouldBeEmpty()
    }

    "a settled write shows the vault's answer rather than this screen's belief" {
        val state = loaded(listOf(member("a-1"), member("a-2")))
        // COMMITTED — nothing here. The trashed row's own change arrives as
        // `rows_changed` on `media_asset` and re-reads through the path that
        // cannot lie. Re-reading here as well would fire one read per member.
        DuplicateReviewMachine.reduce(
            state,
            DuplicateReviewEvent(
                write_settled = DuplicateReviewEvent.WriteSettled(committed = true),
            ),
        ).effects.shouldBeEmpty()
        // NOT COMMITTED — re-read. The copy is still there and the member must
        // see it still there, rather than a list that quietly matches what they
        // asked for.
        DuplicateReviewMachine.reduce(
            state,
            DuplicateReviewEvent(
                write_settled = DuplicateReviewEvent.WriteSettled(
                    committed = false,
                    sentence = "That vault has moved to your other phone.",
                ),
            ),
        ).effects shouldBe listOf(
            ScreenEffect.ReadPage(DuplicateReviewMachine.SCREEN_ID, afterCursor = null),
        )
    }

    "A REFUSED RESOLVE IS NEVER SILENT, AND NEVER TAKES THE LIST WITH IT" {
        // Silence here is the worst outcome this screen has: a resolve is one
        // command per copy, so some can commit while others are refused, and a
        // member told nothing is left believing a set was resolved while copies
        // of their photograph are still in it.
        val picked = DuplicateReviewMachine.reduce(
            loaded(listOf(member("a-1"), member("a-2"))),
            DuplicateReviewEvent(keep = DuplicateReviewEvent.KeepPicked(asset_id = "a-1")),
        ).state
        val refused = DuplicateReviewMachine.reduce(
            picked,
            DuplicateReviewEvent(
                write_settled = DuplicateReviewEvent.WriteSettled(
                    committed = false,
                    sentence = "That vault has moved to your other phone.",
                ),
            ),
        ).state
        refused.write_failure.shouldNotBeNull().sentence shouldBe
            "That vault has moved to your other phone."
        // THE DECISION SURVIVES. It was not the thing that failed, and clearing
        // it would disarm the control the member needs to press again — they
        // would have to work out, from a list that half changed, which copy
        // they had chosen.
        refused.keep_asset_id shouldBe "a-1"
        // AND THE COPIES STAY ON SCREEN. `write_failure` is its own field and
        // not the `content` oneof's `failure`, which is the READ's slot: a
        // denied write put there would replace the list the member was
        // resolving from. `NoteDraft.save_failure` is the same field for the
        // same reason.
        refused.data_ shouldBe picked.data_
        refused.failure.shouldBeNull()
    }

    "a success in the same batch does not wipe a sibling's refusal" {
        // A resolve is N commands and the settles can disagree. If a committed
        // one cleared the sentence, the ORDER the settles happened to arrive in
        // would decide whether the member is told that two copies were refused.
        val state = loaded(listOf(member("a-1"), member("a-2"), member("a-3")))
        val afterRefusal = DuplicateReviewMachine.reduce(
            state,
            DuplicateReviewEvent(
                write_settled = DuplicateReviewEvent.WriteSettled(
                    committed = false,
                    sentence = "That copy could not be trashed.",
                ),
            ),
        ).state
        DuplicateReviewMachine.reduce(
            afterRefusal,
            DuplicateReviewEvent(
                write_settled = DuplicateReviewEvent.WriteSettled(committed = true),
            ),
        ).state.write_failure.shouldNotBeNull().sentence shouldBe
            "That copy could not be trashed."
    }

    "a refusal with no words of its own still reaches the member" {
        // `CommandOutcome.reason` is empty whenever the failing layer wrote
        // none, and `NotesReads` turns that into `null` — right for an editor
        // whose words are still on screen, wrong here, because `null` is
        // exactly the silence this field was added to end.
        val sentence = DuplicateReviewMachine.reduce(
            loaded(listOf(member("a-1"), member("a-2"))),
            DuplicateReviewEvent(
                write_settled = DuplicateReviewEvent.WriteSettled(committed = false),
            ),
        ).state.write_failure.shouldNotBeNull().sentence
        sentence.isNotBlank() shouldBe true
    }

    "a new decision and a fresh attempt each clear the last refusal" {
        val refused = DuplicateReviewMachine.reduce(
            DuplicateReviewMachine.reduce(
                loaded(listOf(member("a-1"), member("a-2"))),
                DuplicateReviewEvent(keep = DuplicateReviewEvent.KeepPicked(asset_id = "a-1")),
            ).state,
            DuplicateReviewEvent(
                write_settled = DuplicateReviewEvent.WriteSettled(
                    committed = false,
                    sentence = "That copy could not be trashed.",
                ),
            ),
        ).state
        refused.write_failure.shouldNotBeNull()
        // PICKING AGAIN clears it — `NotesEditorMachine.edited`'s rule for
        // `NoteDraft.save_failure`: a refusal describes the resolve that was
        // refused, and leaving it up while the member reconsiders reads as a
        // refusal of the choice they are making now.
        DuplicateReviewMachine.reduce(
            refused,
            DuplicateReviewEvent(keep = DuplicateReviewEvent.KeepPicked(asset_id = "a-2")),
        ).state.write_failure.shouldBeNull()
        // AND SO DOES PRESSING AGAIN. Leaving it up while these writes are in
        // flight would have the member reading a refusal of the press before
        // this one.
        DuplicateReviewMachine.reduce(
            refused,
            DuplicateReviewEvent(resolve = DuplicateReviewEvent.ResolveRequested()),
        ).state.write_failure.shouldBeNull()
        // Opening another cluster clears it too: a sentence about the last
        // cluster is not about this one.
        DuplicateReviewMachine.reduce(
            refused,
            DuplicateReviewEvent(
                opened = DuplicateReviewEvent.Opened(cluster_id = "cluster-2"),
            ),
        ).state.write_failure.shouldBeNull()
    }

    "only an executed command counts as committed" {
        // `QUEUED`, `IN_FLIGHT` and `PARKED` cannot occur any more — the phone
        // is the vault and a write commits here or it does not — and they are
        // folded in with the refusals rather than read as success. A copy this
        // screen reported as trashed and the vault did not trash is the failure
        // a member would only find out about later.
        DuplicateReviewReads.settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", "test.command:row-0001")
            .write_settled.shouldNotBeNull().committed shouldBe true
        listOf(
            CommandStatus.COMMAND_STATUS_QUEUED,
            CommandStatus.COMMAND_STATUS_IN_FLIGHT,
            CommandStatus.COMMAND_STATUS_PARKED,
            CommandStatus.COMMAND_STATUS_FAILED,
            CommandStatus.COMMAND_STATUS_DENIED,
            CommandStatus.COMMAND_STATUS_UNSPECIFIED,
        ).forEach { status ->
            withClue(status.name) {
                DuplicateReviewReads.settled(status, "", "test.command:row-0001")
                    .write_settled.shouldNotBeNull().committed shouldBe false
            }
        }
    }

    // --- The placement leg ------------------------------------------------

    "the members landing asks where these copies are filed" {
        val step = DuplicateReviewMachine.reduce(
            DuplicateReviewMachine.reduce(
                DuplicateReviewMachine.initial(),
                DuplicateReviewEvent(
                    opened = DuplicateReviewEvent.Opened(cluster_id = "cluster-1"),
                ),
            ).state,
            DuplicateReviewEvent(
                data_ = DuplicateReviewEvent.DataArrived(
                    data_ = DuplicateReviewData(members = listOf(member("a-1"), member("a-2"))),
                ),
            ),
        )
        step.effects shouldBe listOf(
            ScreenEffect.ReadPage(
                DuplicateReviewMachine.readId(DuplicateReviewMachine.Leg.PLACEMENTS),
                afterCursor = null,
            ),
        )
        // AND UNTIL IT ANSWERS, THE QUESTION IS OPEN AND SAYS SO. False on
        // every row for want of an answer, with `placements_checked` false
        // beside it so the views hedge rather than drawing every copy as a
        // stray.
        val data = step.state.data_.shouldNotBeNull()
        data.placements_checked shouldBe false
        data.members.none { it.member_placed } shouldBe true
    }

    "a placement answer marks the filed copies and closes the question" {
        val loadedState = loaded(listOf(member("a-1"), member("a-2"), member("a-3")))
        val amended = DuplicateReviewMachine.reduce(
            loadedState,
            DuplicateReviewEvent(
                placements = DuplicateReviewEvent.PlacementArrived(
                    placed_asset_ids = listOf("a-2"),
                ),
            ),
        ).state.data_.shouldNotBeNull()
        amended.members.filter { it.member_placed }.map { it.asset_id } shouldBe listOf("a-2")
        amended.placements_checked shouldBe true
        // AN AMENDMENT AMENDS. The rows keep everything the first read said.
        amended.members.map { it.asset_id } shouldBe listOf("a-1", "a-2", "a-3")
        amended.members.first().captured_at shouldBe "2026-02-03T10:00:00Z"
    }

    "an empty placement answer is a finding, not a silence" {
        // "None of these is in an album" is what lets the screen stop hedging,
        // and it is exactly as much of an answer as the opposite. A leg that
        // went quiet on an empty page would leave the view saying "Centraid
        // could not check" for ever.
        val amended = DuplicateReviewMachine.reduce(
            loaded(listOf(member("a-1"), member("a-2"))),
            DuplicateReviewEvent(
                placements = DuplicateReviewEvent.PlacementArrived(),
            ),
        ).state.data_.shouldNotBeNull()
        amended.placements_checked shouldBe true
        amended.members.none { it.member_placed } shouldBe true
    }

    "a refused placement leg leaves the question open" {
        // No event at all, so `placements_checked` stays false and the views
        // keep saying the question was not answered. An empty `PlacementArrived`
        // would say the opposite — "checked, and none is filed" — about a read
        // that was refused, on a screen that deletes photographs.
        val leg = DuplicateReviewLeg(DuplicateReviewMachine.Leg.PLACEMENTS)
        leg.refused(Reads.refused("no")) shouldBe DuplicateReviewEvent()
        val before = loaded(listOf(member("a-1"), member("a-2")))
        val after = DuplicateReviewMachine.reduce(before, DuplicateReviewEvent())
        after.state shouldBe before
        after.effects.shouldBeEmpty()
    }

    "the placement statement binds the copies on screen and nothing else" {
        val leg = DuplicateReviewLeg(DuplicateReviewMachine.Leg.PLACEMENTS)
        // NO MEMBERS, NO QUESTION. An unbound read here would be every album
        // entry in the vault.
        leg.query(DuplicateReviewMachine.initial(), null).shouldBeNull()
        val query = leg.query(
            loaded(listOf(member("a-1"), member("a-2"))),
            null,
        ).shouldNotBeNull()
        query.from shouldBe leg.table
        query.from shouldBe "core_collection_entry"
        query.bind.map { it.text } shouldBe listOf("media.asset", "a-1", "a-2")
        query.where_.shouldNotBeNull() shouldNotContain "a-1"
        val order = query.order.shouldNotBeNull()
        withClue(query.select) {
            query.select.contains(order.sort_column) shouldBe true
            query.select.contains(order.pk_column) shouldBe true
        }
        // ONE PLACED COPY PER ASSET, not one per album it is filed into: the
        // screen's question has a single answer per photograph.
        val placed = leg.arrived(
            listOf(
                Row(values = listOf(Value(text = "e-1"), Value(text = "a-1"))),
                Row(values = listOf(Value(text = "e-2"), Value(text = "a-1"))),
            ),
            nextCursor = null,
        ).placements.shouldNotBeNull()
        placed.placed_asset_ids shouldBe listOf("a-1")
    }

    // --- The read law -----------------------------------------------------

    "the first Opened asks for the members" {
        val step = DuplicateReviewMachine.reduce(
            DuplicateReviewMachine.initial(),
            DuplicateReviewEvent(
                opened = DuplicateReviewEvent.Opened(cluster_id = "cluster-1"),
            ),
        )
        step.state.cluster_id shouldBe "cluster-1"
        step.state.keep_asset_id shouldBe ""
        step.effects shouldBe listOf(
            ScreenEffect.ReadPage(DuplicateReviewMachine.SCREEN_ID, afterCursor = null),
        )
    }

    "a refused read clears the members and is NOT an empty cluster" {
        val refused = DuplicateReviewMachine.reduce(
            loaded(listOf(member("a-1"), member("a-2"))),
            DuplicateReviewEvent(
                refused = DuplicateReviewEvent.ReadRefused(
                    Reads.refused("This is not shared with you."),
                ),
            ),
        )
        refused.state.data_.shouldBeNull()
        refused.state.failure.shouldNotBeNull().sentence shouldBe "This is not shared with you."
        refused.effects.shouldBeEmpty()
    }

    "a parked feed emits no re-read" {
        DuplicateReviewMachine.reduce(
            loaded(listOf(member("a-1"), member("a-2"))),
            DuplicateReviewEvent(
                refused = DuplicateReviewEvent.ReadRefused(Reads.lowDiskParked()),
            ),
        ).effects.shouldBeEmpty()
    }

    "a resolve over a failed read writes nothing" {
        // `data_` is null, so there are no ids to act on. The guard is checked
        // even though the keep could not have survived a useful read, because
        // the cost of being wrong here is every copy in the cluster.
        val picked = DuplicateReviewMachine.reduce(
            loaded(listOf(member("a-1"), member("a-2"))),
            DuplicateReviewEvent(keep = DuplicateReviewEvent.KeepPicked(asset_id = "a-1")),
        ).state
        val failed = DuplicateReviewMachine.reduce(
            picked,
            DuplicateReviewEvent(
                refused = DuplicateReviewEvent.ReadRefused(Reads.noCopyYet()),
            ),
        ).state
        DuplicateReviewMachine.reduce(
            failed,
            DuplicateReviewEvent(resolve = DuplicateReviewEvent.ResolveRequested()),
        ).effects.shouldBeEmpty()
    }

    "rowsChanged answers for its own table, and only for members on the screen" {
        DuplicateReviewMachine.rowsChanged("media_asset_phash", listOf("a-1")).shouldBeNull()
        val state = loaded(listOf(member("a-1"), member("a-2")))
        val foreign = DuplicateReviewMachine.rowsChanged("media_asset", listOf("z-9"))
            .shouldNotBeNull()
        DuplicateReviewMachine.reduce(state, foreign).effects.shouldBeEmpty()
        val mine = DuplicateReviewMachine.rowsChanged("media_asset", listOf("a-2"))
            .shouldNotBeNull()
        DuplicateReviewMachine.reduce(state, mine).effects shouldBe listOf(
            ScreenEffect.ReadPage(DuplicateReviewMachine.SCREEN_ID, afterCursor = null),
        )
    }

    // --- The statement and the projection ---------------------------------

    "the review will not read until it knows which cluster" {
        // A STATEMENT WITH NO CLUSTER IS NOT A STATEMENT OVER EVERY PHOTOGRAPH.
        // An unbound read here would offer a member their whole library as one
        // set to delete from.
        DuplicateReviewReads.query(DuplicateReviewMachine.initial(), null).shouldBeNull()
        val query = DuplicateReviewReads.query(
            DuplicateReviewMachine.initial().copy(cluster_id = "cluster-1"),
            null,
        ).shouldNotBeNull()
        query.from shouldBe DuplicateReviewReads.table
        query.from shouldBe "media_asset"
        query.bind.map { it.text } shouldBe listOf("cluster-1")
        val predicate = query.where_.shouldNotBeNull()
        predicate shouldNotContain "cluster-1"
        // ONLY LIVE ASSETS RIDE A CLUSTER CARD. A trashed member of an old
        // cluster is not something to offer trashing again — and after a
        // resolve it is exactly what the re-read must not bring back.
        predicate shouldNotContain "deleted_at IS NOT NULL"
        predicate.contains("deleted_at IS NULL") shouldBe true
        val order = query.order.shouldNotBeNull()
        withClue(query.select) {
            query.select.contains(order.sort_column) shouldBe true
            query.select.contains(order.pk_column) shouldBe true
        }
        // THE SAME APPENDED COLUMNS THE GRID READS. A review that drew
        // placeholders where the grid a tap earlier drew photographs would be
        // asking a member to choose between four grey squares.
        query.with_held_thumbnail shouldBe true
    }

    "a member is projected off the columns it selected" {
        val row = Row(
            values = listOf(
                Value(text = "a-1"),
                Value(text = "2026-02-03T10:00:00Z"),
                Value(integer = 4032L),
                Value(integer = 3024L),
                Value(text = "photo"),
                // THE DOOR'S THREE APPENDED COLUMNS, in the order
                // `crates/core`'s `api::page` writes them.
                Value(text = "/store/data/abc.data"),
                Value(text = "a0b1"),
                Value(integer = 1L),
            ),
        )
        val projected = DuplicateReviewReads.arrived(listOf(row), null)
            .data_.shouldNotBeNull().data_.shouldNotBeNull().members.single()
        projected.asset_id shouldBe "a-1"
        projected.thumbnail_path shouldBe "/store/data/abc.data"
        projected.width shouldBe 4032
        projected.height shouldBe 3024
        projected.captured_at shouldBe "2026-02-03T10:00:00Z"
        // THE ORIGINAL IS ON THIS DEVICE, through the SAME derivation the grid
        // uses — called rather than restated, because a second spelling of
        // "what does this device have of this photograph" would disagree with
        // the first on the screen where a member is deciding what to delete.
        projected.held shouldBe PhotoCell.Held.HELD_ORIGINAL
        // ZERO BECAUSE IT IS UNKNOWN, AND THE VIEWS DRAW NOTHING FOR ZERO.
        // `core_content_item.byte_size` is a second table this door cannot
        // reach.
        projected.byte_size shouldBe 0L
        // FALSE BECAUSE IT IS UNKNOWN — and false is NOT a safe default here,
        // which is why both views carry the caveat above the Trash control.
        projected.member_placed shouldBe false
    }

    "the suggestion is the largest by pixels, and it says so" {
        val members = listOf(member("a-1", 1024, 768), member("a-2", 4032, 3024))
        DuplicateReviewReads.suggestedKeep(members) shouldBe "a-2"
        val data = DuplicateReviewReads.arrived(emptyList(), null)
        // The reason is the read's own words and it names PIXELS, because
        // pixels are what this read can compare. The contract says "the largest
        // by bytes"; a reason that named bytes over a comparison of pixels
        // would be false on a cluster where the smaller image is the bigger
        // file.
        DuplicateReviewReads.SUGGESTION_REASON.contains("pixels") shouldBe true
        data.data_.shouldNotBeNull().data_.shouldNotBeNull().suggestion_reason shouldBe ""
    }

    "nothing to compare means no suggestion at all" {
        // Two members TIE at the largest, so "the largest" names two
        // photographs — and picking between them would be the product
        // choosing, which is the thing this pair of screens refuses.
        DuplicateReviewReads.suggestedKeep(
            listOf(member("a-1", 4032, 3024), member("a-2", 3024, 4032)),
        ).shouldBeNull()
        // And no member carries dimensions at all.
        DuplicateReviewReads.suggestedKeep(
            listOf(member("a-1"), member("a-2")),
        ).shouldBeNull()
    }

    "an empty cluster is data with no members, never a refusal" {
        val arrived = DuplicateReviewReads.arrived(emptyList(), null)
        arrived.refused.shouldBeNull()
        val data = arrived.data_.shouldNotBeNull().data_.shouldNotBeNull()
        data.members.shouldBeEmpty()
        // NO SUGGESTION MEANS NO REASON. A sentence explaining a recommendation
        // that is not there is how a view ends up drawing "This is the largest"
        // beside nothing.
        data.suggested_keep_asset_id shouldBe ""
        data.suggestion_reason shouldBe ""
    }
})
