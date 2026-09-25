package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.Autosave
import centraid.screen.v1.NoteDraft
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.SearchField
import centraid.screen.v1.TrashListData
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashListState
import centraid.screen.v1.TrashRow
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.shared.apps.notes.NotesEditorMachine
import dev.centraid.shared.kit.AutosaveLaw
import dev.centraid.shared.kit.BandLaw
import dev.centraid.shared.kit.BandLens
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.SearchLaw
import dev.centraid.shared.kit.SearchLens
import dev.centraid.shared.kit.TrashCopy
import dev.centraid.shared.kit.TrashMachine
import dev.centraid.shared.kit.TrashReads
import dev.centraid.shared.kit.TrashSpec
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

/**
 * THE KIT'S LAWS, each once (the five-app kit, K2–K4). The screens that use
 * them keep their own specs; these pin the law itself, through the screen that
 * migrated onto it where there is one.
 */
class KitLawsSpec : StringSpec({

    // --- Paged list -------------------------------------------------------
    //
    // THROUGH THE KIT'S TRASH SCREEN, the paged list every app now shares
    // (Tally's legacy `tally.list`, where these laws were first pinned, is
    // gone with the native views that drew it).

    "paged list: a first page replaces, a later page appends deduplicated, a refusal clears with no effect" {
        val one = listed(pagedList.initial(), page("a", "b", cursor = "c1"), "")
        val two = listed(one, page("b", "c"), "c1")
        two.ids() shouldBe listOf("a", "b", "c")
        listed(two, page("x"), "").ids() shouldBe listOf("x")

        val refused = pagedList.reduce(
            two,
            TrashListEvent(refused = TrashListEvent.ReadRefused(Reads.refused("no"))),
        )
        refused.state.data_.shouldBeNull()
        refused.effects.shouldBeEmpty()
    }

    "paged list: an empty change re-reads; a change naming only unshown rows does not" {
        val shown = listed(pagedList.initial(), page("a"), "")
        pagedList.reduce(shown, changedRows()).effects shouldBe
            listOf(ScreenEffect.ReadPage(pagedList.screenId, null))
        pagedList.reduce(shown, changedRows("zz")).effects.shouldBeEmpty()
        pagedList.reduce(shown, changedRows("zz")).state.first_page_pending shouldBe false
        pagedList.reduce(shown, changedRows("a")).state.first_page_pending shouldBe true
    }

    "paged list: page two landing after a change appends, and the re-read's answer then replaces" {
        // The answer carries the cursor it ANSWERED (the runtime echoes the
        // request's); that, and not a pending flag, says which page it is.
        val shown = listed(pagedList.initial(), page("a", "b", cursor = "c1"), "")
        val scrolled = pagedList.reduce(shown, nextPage)
        scrolled.effects shouldBe listOf(ScreenEffect.ReadPage(pagedList.screenId, "c1"))
        val changed = pagedList.reduce(scrolled.state, changedRows()).state
        changed.first_page_pending shouldBe true
        // PAGE TWO LANDS FIRST: appended, and the re-read is still pending.
        val paged = listed(changed, page("c", "d"), "c1")
        paged.ids() shouldBe listOf("a", "b", "c", "d")
        paged.first_page_pending shouldBe true
        // No next page is asked while that first page is in flight.
        pagedList.reduce(paged, nextPage).effects.shouldBeEmpty()
        // THEN PAGE ONE. It replaces.
        val reread = listed(paged, page("z", "a", "b", cursor = "c1b"), "")
        reread.ids() shouldBe listOf("z", "a", "b")
        reread.first_page_pending shouldBe false
    }

    "paged list: a later page answering a cursor the list has since replaced is dropped" {
        val shown = listed(pagedList.initial(), page("a", "b", cursor = "c1"), "")
        val replaced = listed(shown, page("z", "a", cursor = "c9"), "")
        listed(replaced, page("c", "d"), "c1").ids() shouldBe listOf("z", "a")
    }

    "paged list: a re-read keeps the rows drawn, then its answer is the list — new, edited and gone rows alike" {
        for (reread in listOf(TrashListEvent(refreshed = TrashListEvent.Refreshed()), changedRows())) {
            val shown = listed(pagedList.initial(), page("b", "c", cursor = "stale"), "")
            val asked = pagedList.reduce(shown, reread)
            asked.effects shouldBe listOf(ScreenEffect.ReadPage(pagedList.screenId, null))
            // THE ROWS STAY DRAWN while the answer is in flight.
            asked.state.ids() shouldBe listOf("b", "c")
            // A row first in the answer lands at the top; one it drops leaves.
            val answered = listed(asked.state, page("a", "b", cursor = "fresh"), null)
            answered.ids() shouldBe listOf("a", "b")
            answered.data_.shouldNotBeNull().next_cursor shouldBe "fresh"
            answered.first_page_pending shouldBe false
            // The next page continues from the re-read's cursor, and appends.
            pagedList.reduce(answered, nextPage).effects shouldBe
                listOf(ScreenEffect.ReadPage(pagedList.screenId, "fresh"))
            listed(answered, page("c", "d"), "fresh").ids() shouldBe listOf("a", "b", "c", "d")
        }
        // An edited row shows what the re-read answered, not what it was first read with.
        val edited = listed(
            pagedList.reduce(listed(pagedList.initial(), page("a"), ""), changedRows("a")).state,
            TrashListData(rows = listOf(TrashRow(id = "a", title = "Rent, corrected"))),
            "",
        )
        edited.data_.shouldNotBeNull().rows.single().title shouldBe "Rent, corrected"
    }

    "paged list: the reads object echoes the cursor — empty for a first page, the cursor for a later one" {
        val reads = TrashReads(tasksTrash)
        val row = Row(values = listOf(Value(text = "t-1"), Value(text = "Rent"), Value(text = "2026-06-15T09:00:00Z")))
        reads.arrived(listOf(row), nextCursor = null, answeredCursor = null)
            .data_.shouldNotBeNull().answered_cursor shouldBe ""
        reads.arrived(listOf(row), nextCursor = null, answeredCursor = "k|1")
            .data_.shouldNotBeNull().answered_cursor shouldBe "k|1"
    }

    // --- Band -------------------------------------------------------------

    "band: the tab you are on is no change; another tab is a first load" {
        data class Probe(val destination: String, val content: ReadContent<String>)
        val band = object : BandLens<Probe, String> {
            override fun destination(state: Probe): String = state.destination
            override fun with(state: Probe, destination: String): Probe = state.copy(destination = destination)
        }
        val lens = object : ContentLens<Probe, String> {
            override fun content(state: Probe): ReadContent<String> = state.content
            override fun with(state: Probe, content: ReadContent<String>): Probe = state.copy(content = content)
        }
        val shown = Probe("activity", ReadContent.Data("rows"))
        val same = BandLaw.changed(band, lens, "probe.band", shown, "activity")
        same.state shouldBe shown
        same.effects.shouldBeEmpty()
        val other = BandLaw.changed(band, lens, "probe.band", shown, "groups")
        other.state shouldBe Probe("groups", ReadContent.Loading(firstLoad = true))
        other.effects shouldBe listOf(ScreenEffect.ReadPage("probe.band", null))
    }

    // --- Search -----------------------------------------------------------

    "search: a term reads, a blank term does not, and close clears the term and its answer" {
        var field = SearchField()
        val lens = object : SearchLens<SearchField> {
            override val screenId: String = "probe.search"
            override fun field(state: SearchField): SearchField = state
            override fun with(state: SearchField, field: SearchField): SearchField = field
        }
        field = SearchLaw.opened(lens, field).state
        field.open_ shouldBe true
        SearchLaw.term(lens, field, "  ").effects.shouldBeEmpty()
        val typed = SearchLaw.term(lens, field, "dinner")
        typed.effects shouldBe listOf(ScreenEffect.ReadPage("probe.search", null))
        field = SearchLaw.answered(lens, typed.state, "dinner")
        field.answered_term shouldBe "dinner"
        SearchLaw.closed(lens, field).state shouldBe SearchField()
    }

    "search: an answer for a term the member has since changed is stale" {
        val lens = object : SearchLens<SearchField> {
            override val screenId: String = "probe.search"
            override fun field(state: SearchField): SearchField = state
            override fun with(state: SearchField, field: SearchField): SearchField = field
        }
        val field = SearchLaw.term(lens, SearchLaw.term(lens, SearchField(), "din").state, "dinner").state
        SearchLaw.answerIsCurrent(lens, field, "din") shouldBe false
        SearchLaw.answerIsCurrent(lens, field, "dinner") shouldBe true
        SearchLaw.answerIsCurrent(lens, SearchLaw.closed(lens, field).state, "dinner") shouldBe false
    }

    // --- Autosave ---------------------------------------------------------

    "autosave: each edit schedules its own token, and a stale tick saves nothing" {
        val one = notes(loaded(), title("Winter trip"))
        val two = notes(one.state, title("Winter plans"))
        two.effects shouldBe listOf(ScreenEffect.Schedule(NotesEditorMachine.SCREEN_ID, "save:2", 900))
        // The first edit's tick comes due after the second edit: stale.
        notes(two.state, tick("save:1")).effects.shouldBeEmpty()
        val saved = notes(two.state, tick("save:2"))
        (saved.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldContain "Winter plans"
        saved.state.autosave.shouldNotBeNull().phase shouldBe Autosave.Phase.PHASE_SAVING
    }

    "autosave: one invoke key per edit_seq, so the next save is a new command" {
        val first = notes(notes(loaded(), body("a")).state, tick("save:1"))
        val key1 = (first.effects.single() as ScreenEffect.SubmitWrite).invokeKey
        key1 shouldBe InvokeKeys.of(NotesEditorMachine.SAVE_COMMAND, "note-1", "seq=1")
        val committed = notes(first.state, settled(key1, committed = true)).state
        val second = notes(notes(committed, body("ab")).state, tick("save:2"))
        val key2 = (second.effects.single() as ScreenEffect.SubmitWrite).invokeKey
        key2 shouldBe InvokeKeys.of(NotesEditorMachine.SAVE_COMMAND, "note-1", "seq=2")
    }

    "autosave: only the changed fields are sent" {
        val titleOnly = notes(notes(loaded(), title("New")).state, tick("save:1"))
        val input = (titleOnly.effects.single() as ScreenEffect.SubmitWrite).inputJson
        input shouldBe "{\"note_id\":\"note-1\",\"title\":\"New\"}"
        input shouldNotContain "body_text"
        input shouldNotContain "pinned"
    }

    "autosave: a pin saves at once, with no debounce" {
        val pinned = notes(loaded(), NotesEditorEvent(pin = NotesEditorEvent.PinToggled()))
        val write = pinned.effects.single() as ScreenEffect.SubmitWrite
        write.inputJson shouldBe "{\"note_id\":\"note-1\",\"pinned\":1}"
    }

    "autosave: a change from the vault never replaces words being typed" {
        val dirty = notes(loaded(), body("my words")).state
        // EMPTY keys: the core's own "re-read the table", which is this note too.
        val moved = notes(dirty, NotesEditorEvent(rows_changed = NotesEditorEvent.RowsChanged(emptyList())))
        moved.effects.shouldBeEmpty()
        moved.state.autosave.shouldNotBeNull().remote_changed shouldBe true
        // A read's answer that lands anyway replaces nothing either.
        val answered = notes(moved.state, NotesEditorEvent(data_ = NotesEditorEvent.DataArrived(draft("theirs")))).state
        answered.draft.shouldNotBeNull().body shouldBe "my words"
        // Saved: then, and only then, the editor reads what the vault moved to.
        val saving = notes(answered, tick("save:1"))
        val key = (saving.effects.single() as ScreenEffect.SubmitWrite).invokeKey
        val done = notes(saving.state, settled(key, committed = true))
        done.effects shouldBe listOf(ScreenEffect.ReadPage(NotesEditorMachine.SCREEN_ID, null))
        done.state.autosave.shouldNotBeNull().remote_changed shouldBe false
    }

    "autosave: a clean editor re-reads on an empty change, and ignores another note's" {
        notes(loaded(), NotesEditorEvent(rows_changed = NotesEditorEvent.RowsChanged(emptyList()))).effects shouldBe
            listOf(ScreenEffect.ReadPage(NotesEditorMachine.SCREEN_ID, null))
        notes(loaded(), NotesEditorEvent(rows_changed = NotesEditorEvent.RowsChanged(listOf("other")))).effects
            .shouldBeEmpty()
    }

    "autosave: a settle under another key is not this save's" {
        val saving = notes(notes(loaded(), body("x")).state, tick("save:1")).state
        notes(saving, settled("someone-else", committed = false)).state shouldBe saving
    }

    "autosave: words typed while a save is in flight are saved when it commits" {
        val saving = notes(notes(loaded(), body("x")).state, tick("save:1"))
        val key = (saving.effects.single() as ScreenEffect.SubmitWrite).invokeKey
        val more = notes(saving.state, body("xy")).state
        // Their tick comes due against a SAVING editor, and does nothing.
        notes(more, tick("save:2")).effects.shouldBeEmpty()
        val next = notes(more, settled(key, committed = true))
        (next.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldContain "\"body_text\":\"xy\""
    }

    "autosave: an untitled note is titled from its first line; an emptied body is saved empty" {
        val untitled = notes(notes(loaded(title = ""), body("\n  Shopping list \nmilk")).state, tick("save:1"))
        (untitled.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldContain "\"title\":\"Shopping list\""

        // `body_text` takes an empty string: clearing a note is the member's words.
        val emptied = notes(notes(loaded(), body("")).state, tick("save:1"))
        (emptied.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe
            "{\"note_id\":\"note-1\",\"body_text\":\"\"}"
        emptied.state.save shouldBe NotesEditorState.SaveState.SAVE_STATE_SAVING
    }

    "autosave: leaving saves what is unsaved, and nothing when all is saved" {
        notes(loaded(), NotesEditorEvent(left = NotesEditorEvent.Left())).effects.shouldBeEmpty()
        val left = notes(notes(loaded(), body("bye")).state, NotesEditorEvent(left = NotesEditorEvent.Left()))
        (left.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldContain "bye"
        AutosaveLaw.DEBOUNCE_MS shouldBe 900L
    }

    // --- Writes -----------------------------------------------------------

    "write law: the same key in flight is one write; a settle under another key is ignored" {
        val lens = object : WriteLens<WriteState> {
            override fun write(state: WriteState): WriteState = state
            override fun with(state: WriteState, write: WriteState): WriteState = write
        }
        val sent = WriteLaw.submit(lens, WriteState(), "tasks.complete_task", "{}", "k1")
        sent.state.phase shouldBe WriteState.Phase.PHASE_IN_FLIGHT
        WriteLaw.submit(lens, sent.state, "tasks.complete_task", "{}", "k1").effects.shouldBeEmpty()
        WriteLaw.settled(lens, sent.state, WriteSettled(invoke_key = "k0", committed = true)).state shouldBe sent.state
        val refused = WriteLaw.settled(
            lens,
            sent.state,
            WriteLaw.settledOf(CommandStatus.COMMAND_STATUS_DENIED, "No.", "k1"),
        ).state
        refused.phase shouldBe WriteState.Phase.PHASE_REFUSED
        refused.failure.shouldNotBeNull().sentence shouldBe "No."
    }

    // --- Trash ------------------------------------------------------------

    "trash: restore writes at once; purge and empty ask first, destructively" {
        val machine = TrashMachine(tasksTrash)
        val shown = trash(machine, machine.initial(), TrashListData(rows = listOf(TrashRow(id = "t1", title = "Buy milk"))))
        shown.data_.shouldNotBeNull().rows.single().purge_label shouldBe "Delete forever"
        shown.data_!!.empty_label shouldBe "Empty trash"

        val restore = machine.reduce(shown, TrashListEvent(restore = TrashListEvent.RestoreTapped(id = "t1")))
        restore.effects.single() shouldBe ScreenEffect.SubmitWrite(
            "tasks.restore_task",
            "{\"task_id\":\"t1\"}",
            "tasks.restore_task:t1",
        )

        val asked = machine.reduce(shown, TrashListEvent(purge = TrashListEvent.PurgeTapped(id = "t1")))
        asked.effects.shouldBeEmpty()
        asked.state.confirm.shouldNotBeNull().destructive shouldBe true
        asked.state.purge_id shouldBe "t1"
        val dismissed = machine.reduce(asked.state, TrashListEvent(dismissed = TrashListEvent.Dismissed()))
        dismissed.state.confirm.shouldBeNull()
        dismissed.effects.shouldBeEmpty()
        val purged = machine.reduce(asked.state, TrashListEvent(confirmed = TrashListEvent.Confirmed()))
        (purged.effects.single() as ScreenEffect.SubmitWrite).command shouldBe "tasks.purge_task"
        purged.state.confirm.shouldBeNull()

        val emptying = machine.reduce(shown, TrashListEvent(empty = TrashListEvent.EmptyTapped()))
        emptying.state.empty_all shouldBe true
        val emptied = machine.reduce(emptying.state, TrashListEvent(confirmed = TrashListEvent.Confirmed()))
        (emptied.effects.single() as ScreenEffect.SubmitWrite).command shouldBe "tasks.empty_trash"
    }

    "trash: an app with no destroy path offers restore only" {
        val machine = TrashMachine(tasksTrash.copy(appId = "docs", purgeCommand = null, emptyCommand = null))
        val shown = trash(machine, machine.initial(), TrashListData(rows = listOf(TrashRow(id = "d1", title = "Plan"))))
        shown.data_.shouldNotBeNull().rows.single().purge_label shouldBe ""
        shown.data_!!.empty_label shouldBe ""
        machine.reduce(shown, TrashListEvent(purge = TrashListEvent.PurgeTapped(id = "d1"))).state shouldBe shown
        machine.reduce(shown, TrashListEvent(empty = TrashListEvent.EmptyTapped())).state shouldBe shown
        machine.screenId shouldBe "docs.trash"
    }

    "trash: a refused write keeps the list; the reads are the deleted rows of the app's table" {
        val machine = TrashMachine(tasksTrash)
        val shown = trash(machine, machine.initial(), TrashListData(rows = listOf(TrashRow(id = "t1"))))
        val restoring = machine.reduce(shown, TrashListEvent(restore = TrashListEvent.RestoreTapped(id = "t1"))).state
        val refused = machine.reduce(
            restoring,
            TrashListEvent(write_settled = WriteSettled(invoke_key = "tasks.restore_task:t1", committed = false)),
        ).state
        refused.data_.shouldNotBeNull().rows.single().id shouldBe "t1"
        refused.write.shouldNotBeNull().phase shouldBe WriteState.Phase.PHASE_REFUSED

        val query = TrashReads(tasksTrash).query(machine.initial(), null)
        query.from shouldBe "schedule_task"
        query.where_ shouldBe "deleted_at IS NOT NULL"
        query.select shouldBe listOf("task_id", "title", "deleted_at")
        machine.rowsChanged("schedule_task", emptyList()).shouldNotBeNull()
        machine.rowsChanged("other", emptyList()).shouldBeNull()
    }

    "trash: an app's words replace the kit's, and only where it says so" {
        val machine = TrashMachine(
            tasksTrash.copy(copy = TrashCopy(emptyBody = "Nothing is removed.", emptyStateBody = "Kept 30 days.")),
        )
        val shown = trash(machine, machine.initial(), TrashListData(rows = listOf(TrashRow(id = "t1"))))
        val emptying = machine.reduce(shown, TrashListEvent(empty = TrashListEvent.EmptyTapped())).state
        emptying.confirm.shouldNotBeNull().body shouldBe "Nothing is removed."
        emptying.confirm.shouldNotBeNull().title shouldBe TrashCopy().emptyTitle
        machine.reduce(shown, TrashListEvent(purge = TrashListEvent.PurgeTapped(id = "t1"))).state
            .confirm.shouldNotBeNull().body shouldBe TrashCopy().purgeBody
        val empty = trash(machine, machine.initial(), TrashListData())
        empty.data_.shouldNotBeNull().empty.shouldNotBeNull().body shouldBe "Kept 30 days."
    }

    "trash: a purge-date column is selected and said on the row, after the deletion day" {
        val spec = tasksTrash.copy(purgeAtColumn = "purge_at", copy = TrashCopy(purgesOn = "Erased {day}"))
        val reads = TrashReads(spec)
        reads.query(TrashMachine(spec).initial(), null).select shouldBe listOf("task_id", "title", "deleted_at", "purge_at")
        fun text(v: String) = Value(text = v)
        val event = reads.arrived(
            listOf(Row(values = listOf(text("t1"), text(""), text("2026-03-11T10:00:00Z"), text("2026-04-10T10:00:00Z")))),
            null,
        )
        val row = event.data_.shouldNotBeNull().data_.shouldNotBeNull().rows.single()
        row.title shouldBe TrashCopy().untitled
        row.meta shouldContain " · Erased "
        row.meta.substringBefore(" · ") shouldBe TrashCopy().deletedMeta("2026-03-11T10:00:00Z")
        // Without the column nothing is said about a purge day.
        TrashReads(tasksTrash).arrived(
            listOf(Row(values = listOf(text("t1"), text("A"), text("2026-03-11T10:00:00Z")))),
            null,
        ).data_.shouldNotBeNull().data_.shouldNotBeNull().rows.single().meta shouldNotContain " · "
    }

    "trash: a table keyed unlike its rows re-reads on any change" {
        val machine = TrashMachine(tasksTrash.copy(reReadOnAnyChange = true))
        machine.rowsChanged("schedule_task", listOf("profile-9")).shouldNotBeNull().rows_changed
            .shouldNotBeNull().ids.shouldBeEmpty()
        machine.rowsChanged("other", listOf("k")).shouldBeNull()
    }
}) {
    private companion object {
        val tasksTrash = TrashSpec(
            appId = "tasks",
            table = "schedule_task",
            restoreCommand = "tasks.restore_task",
            purgeCommand = "tasks.purge_task",
            emptyCommand = "tasks.empty_trash",
            idColumn = "task_id",
            titleColumn = "title",
            purgeWindowDays = 30,
        )

        /** The kit's paged list, as every app's trash draws it. */
        val pagedList = TrashMachine(tasksTrash)

        val nextPage = TrashListEvent(next_page = TrashListEvent.NextPageRequested())

        fun page(vararg ids: String, cursor: String? = null): TrashListData =
            TrashListData(rows = ids.map { TrashRow(id = it, title = it) }, next_cursor = cursor)

        /** An answer; [answered] null is a sender that echoes no cursor. */
        fun listed(state: TrashListState, data: TrashListData, answered: String?): TrashListState =
            pagedList.reduce(
                state,
                TrashListEvent(data_ = TrashListEvent.DataArrived(data_ = data, answered_cursor = answered)),
            ).state

        fun changedRows(vararg ids: String) = TrashListEvent(rows_changed = TrashListEvent.RowsChanged(ids = ids.toList()))

        fun TrashListState.ids(): List<String> = data_?.rows?.map { it.id } ?: emptyList()

        fun draft(body: String, title: String = "Winter"): NoteDraft =
            NoteDraft(title = title, body = body, base_revision_id = "rev-1")

        fun loaded(title: String = "Winter"): NotesEditorState {
            val opened = NotesEditorMachine.reduce(
                NotesEditorMachine.initial(),
                NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = "note-1")),
            ).state
            return NotesEditorMachine.reduce(
                opened,
                NotesEditorEvent(data_ = NotesEditorEvent.DataArrived(draft("plans", title))),
            ).state
        }

        fun notes(state: NotesEditorState, event: NotesEditorEvent): Step<NotesEditorState> =
            NotesEditorMachine.reduce(state, event)

        fun title(t: String) = NotesEditorEvent(title = NotesEditorEvent.TitleEdited(title = t))

        fun body(b: String) = NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = b))

        fun tick(token: String) = NotesEditorEvent(tick = NotesEditorEvent.Ticked(token = token))

        fun settled(key: String, committed: Boolean) =
            NotesEditorEvent(write_settled = WriteSettled(invoke_key = key, committed = committed))

        fun trash(machine: TrashMachine, state: TrashListState, data: TrashListData): TrashListState =
            machine.reduce(
                machine.reduce(state, TrashListEvent(opened = TrashListEvent.Opened())).state,
                TrashListEvent(data_ = TrashListEvent.DataArrived(data_ = data, answered_cursor = "")),
            ).state
    }
}
