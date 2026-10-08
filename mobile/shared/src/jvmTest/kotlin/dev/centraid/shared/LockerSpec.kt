package dev.centraid.shared

import centraid.core.v1.AppQueryResponse
import centraid.core.v1.LockerItem
import centraid.core.v1.LockerItemDetail
import centraid.core.v1.LockerItemRow
import centraid.core.v1.LockerItems
import centraid.core.v1.LockerRevealRefusal
import centraid.core.v1.LockerReview
import centraid.core.v1.LockerSecret
import centraid.core.v1.LockerTypeCount
import centraid.core.v1.Row
import centraid.screen.v1.LockerBiometry
import centraid.screen.v1.LockerEditorEvent
import centraid.screen.v1.LockerEditorState
import centraid.screen.v1.LockerGeneratorEvent
import centraid.screen.v1.LockerHomeEvent
import centraid.screen.v1.LockerHomeState
import centraid.screen.v1.LockerItemEvent
import centraid.screen.v1.LockerItemState
import centraid.screen.v1.LockerLockEvent
import centraid.screen.v1.LockerLockState
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashListState
import centraid.screen.v1.WriteSettled
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.apps.locker.GateEffect
import dev.centraid.shared.apps.locker.GateInput
import dev.centraid.shared.apps.locker.LOCKER_TABLES
import dev.centraid.shared.apps.locker.LockerDoor
import dev.centraid.shared.apps.locker.LockerDoorAnswer
import dev.centraid.shared.apps.locker.LockerEditorMachine
import dev.centraid.shared.apps.locker.LockerFold
import dev.centraid.shared.apps.locker.LockerGate
import dev.centraid.shared.apps.locker.LockerGeneratorMachine
import dev.centraid.shared.apps.locker.LockerHeld
import dev.centraid.shared.apps.locker.LockerHomeMachine
import dev.centraid.shared.apps.locker.LockerHomeReads
import dev.centraid.shared.apps.locker.LockerInput
import dev.centraid.shared.apps.locker.LockerItemMachine
import dev.centraid.shared.apps.locker.LockerItemReads
import dev.centraid.shared.apps.locker.LockerLockMachine
import dev.centraid.shared.apps.locker.LockerPasswords
import dev.centraid.shared.apps.locker.LockerTrashReads
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.shell.HomeReads
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

/**
 * LOCKER ON THE PHONE (#1047, D-5): the lock, "nothing is read while locked",
 * the reveal's life, and the words — asserted on the machines and the gate
 * over a fake door, the way a shell drives them.
 */
class LockerSpec : StringSpec({

    val now = DeviceClock.Reading(zone = "America/New_York", epochMillis = 0L)
    val password = "correct horse battery staple"

    fun lock(event: LockerLockEvent) = GateInput.View(event)
    val attached = lock(LockerLockEvent(attached = LockerLockEvent.Attached(available = true, biometry = LockerBiometry.LOCKER_BIOMETRY_FACE)))
    val tap = lock(LockerLockEvent(unlock = LockerLockEvent.UnlockTapped()))
    fun answered(token: Long, outcome: LockerLockEvent.PromptAnswered.Outcome) =
        lock(LockerLockEvent(answered = LockerLockEvent.PromptAnswered(token = token, outcome = outcome)))

    /** Run a gate machine through [inputs], collecting every effect. */
    fun gate(vararg inputs: GateInput): Pair<dev.centraid.shared.apps.locker.Gate, List<GateEffect>> {
        var gate = LockerLockMachine.initial()
        val effects = mutableListOf<GateEffect>()
        inputs.forEach {
            val step = LockerLockMachine.reduce(gate, it)
            gate = step.gate
            effects += step.effects
        }
        return gate to effects
    }

    fun <S, E> ScreenMachine<LockerHeld<S>, LockerInput<E>>.run(vararg inputs: LockerInput<E>): Pair<LockerHeld<S>, List<ScreenEffect>> {
        var held = initial()
        val effects = mutableListOf<ScreenEffect>()
        inputs.forEach {
            val step: Step<LockerHeld<S>> = reduce(held, it)
            held = step.state
            effects += step.effects
        }
        return held to effects
    }

    fun row(id: String, title: String, type: String = "login", starred: Boolean = false, compromised: Boolean = false) =
        LockerItemRow(item_id = id, type = type, title = title, subtitle = "maya", starred = starred, compromised = compromised)

    fun items(vararg rows: LockerItemRow, total: Int? = rows.size, truncated: Boolean = false) = AppQueryResponse(
        locker_items = LockerItems(
            items = rows.toList(),
            total = total,
            truncated = truncated,
            window = 300,
            by_type = rows.groupBy { it.type }.map { (type, list) -> LockerTypeCount(type = type, count = list.size) },
            archived_count = 0,
            trashed_count = 0,
            today = "2099-06-30",
        ),
    )

    val bank = LockerItem(
        item_id = "item-bank",
        type = "login",
        title = "Bank",
        username = "maya@example.com",
        url = "https://bank.example.com",
        secrets = listOf(LockerSecret(column = "password", present = true), LockerSecret(column = "otp_seed", present = false)),
        created_local_day = "2099-06-30",
    )

    fun itemAnswer(item: LockerItem? = bank) = AppQueryResponse(locker_item = LockerItemDetail(item = item, today = "2099-06-30"))

    val home = LockerHomeMachine
    fun homeView(event: LockerHomeEvent) = LockerInput.View(event)
    val openHome = homeView(LockerHomeEvent(opened = LockerHomeEvent.Opened()))

    // --- the lock -----------------------------------------------------------

    "a Locker boots locked, covered, and asks nothing of the OS until a tap" {
        val (locked, effects) = gate(attached)
        locked.state.phase shouldBe LockerLockState.Phase.PHASE_LOCKED
        locked.state.cover.shouldBeTrue()
        locked.state.prompt.shouldBeNull()
        locked.state.unlock_label shouldBe "${LockerCopy.UNLOCK_WITH} ${LockerCopy.METHOD_FACE}"
        locked.state.body shouldContain LockerCopy.METHOD_FACE
        effects.shouldBeEmpty()
    }

    "the OS saying yes is not the Locker opening: only the core's answer is" {
        val (asking, _) = gate(attached, tap)
        asking.state.phase shouldBe LockerLockState.Phase.PHASE_UNLOCKING
        val prompt = asking.state.prompt.shouldNotBeNull()
        prompt.reason shouldBe LockerCopy.PROMPT_REASON
        val (opening, effects) = gate(attached, tap, answered(prompt.token, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED))
        opening.state.phase shouldBe LockerLockState.Phase.PHASE_UNLOCKING
        opening.state.prompt.shouldBeNull()
        opening.state.cover.shouldBeTrue()
        effects shouldBe listOf(GateEffect.Unlock)
        val open = LockerLockMachine.reduce(opening, GateInput.Core(open = true)).gate
        open.state.phase shouldBe LockerLockState.Phase.PHASE_UNLOCKED
        open.state.cover.shouldBeFalse()
        // A CORE THAT WOULD NOT OPEN leaves the member at FAILED, with its sentence.
        val refused = LockerLockMachine.reduce(opening, GateInput.Core(open = false, sentence = "No key here.")).gate
        refused.state.phase shouldBe LockerLockState.Phase.PHASE_FAILED
        refused.state.notice shouldBe "No key here."
        refused.state.unlock_label shouldBe LockerCopy.UNLOCK_AGAIN
    }

    "the capture shield holds exactly while the Locker is open, and a relock drops it" {
        // THE VIEWS DECIDE NOTHING OF WHEN: FLAG_SECURE and the iOS shield
        // follow `secure`, which is the cover's complement.
        val (locked, _) = gate(attached)
        locked.state.secure.shouldBeFalse()
        val (asking, _) = gate(attached, tap)
        asking.state.secure.shouldBeFalse()
        val (open, _) = gate(attached, tap, answered(1, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED), GateInput.Core(open = true))
        open.state.secure.shouldBeTrue()
        LockerLockMachine.reduce(open, lock(LockerLockEvent(lock = LockerLockEvent.LockTapped()))).gate.state.secure.shouldBeFalse()
        LockerLockMachine.reduce(open, lock(LockerLockEvent(backgrounded = LockerLockEvent.Backgrounded()))).gate.state.secure.shouldBeFalse()
        val noLock = lock(LockerLockEvent(attached = LockerLockEvent.Attached(available = false)))
        LockerLockMachine.reduce(open, noLock).gate.state.secure.shouldBeFalse()
    }

    "locking clears Locker's own copy from the clipboard; leaving the foreground leaves it to expire (#1047 walk)" {
        val (open, _) = gate(attached, tap, answered(1, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED), GateInput.Core(open = true))
        val before = open.state.clipboard_clear
        // THE LOCK ROW (and a vault switch, which sends the same tap): a new token.
        val locked = LockerLockMachine.reduce(open, lock(LockerLockEvent(lock = LockerLockEvent.LockTapped()))).gate
        locked.state.clipboard_clear shouldBe before + 1
        // Locking again says it again: once per new value, never re-run on a redraw.
        LockerLockMachine.reduce(locked, lock(LockerLockEvent(lock = LockerLockEvent.LockTapped()))).gate.state.clipboard_clear shouldBe
            before + 2
        // A COPY EXISTS TO BE PASTED INTO ANOTHER APP: the background relock
        // keeps it, and the wall says it clears itself.
        LockerLockMachine.reduce(open, lock(LockerLockEvent(backgrounded = LockerLockEvent.Backgrounded()))).gate.state.clipboard_clear shouldBe
            before
        val leaving = locked.state.facts.single { it.label == LockerCopy.FACT_LEAVING }.detail
        leaving shouldBe "Locks at once · revealed values are cleared, and a copied secret clears itself within 30 seconds"
    }

    "a cancelled prompt is not a failure, and a stale token is nobody's answer" {
        val (asking, _) = gate(attached, tap)
        val token = asking.state.prompt!!.token
        val cancelled = LockerLockMachine.reduce(asking, answered(token, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_CANCELLED)).gate
        cancelled.state.phase shouldBe LockerLockState.Phase.PHASE_LOCKED
        cancelled.state.notice shouldBe ""
        val stale = LockerLockMachine.reduce(asking, answered(token + 7, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED))
        stale.gate shouldBe asking
        stale.effects.shouldBeEmpty()
        val failed = LockerLockMachine.reduce(asking, answered(token, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_FAILED)).gate
        failed.state.phase shouldBe LockerLockState.Phase.PHASE_FAILED
        failed.state.notice shouldBe LockerCopy.LOCK_FAILED
        val lockedOut = LockerLockMachine.reduce(asking, answered(token, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_LOCKED_OUT)).gate
        lockedOut.state.notice shouldBe LockerCopy.LOCK_LOCKED_OUT
        // ANOTHER TRY MINTS ANOTHER TOKEN.
        val again = LockerLockMachine.reduce(failed, tap).gate
        again.state.prompt!!.token shouldNotBe token
    }

    "a phone with no passcode has no Locker, and anything open closes" {
        val noLock = lock(LockerLockEvent(attached = LockerLockEvent.Attached(available = false)))
        val (unavailable, _) = gate(noLock, tap)
        unavailable.state.phase shouldBe LockerLockState.Phase.PHASE_UNAVAILABLE
        unavailable.state.prompt.shouldBeNull()
        unavailable.state.unlock_label shouldBe ""
        unavailable.state.notice shouldBe LockerCopy.LOCK_UNAVAILABLE_NOTICE
        val (open, _) = gate(attached, tap, answered(1, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED), GateInput.Core(open = true))
        val closed = LockerLockMachine.reduce(open, noLock)
        closed.gate.state.phase shouldBe LockerLockState.Phase.PHASE_UNAVAILABLE
        closed.effects shouldBe listOf(GateEffect.Relock)
        // SETTING A PASSCODE brings the lock back.
        LockerLockMachine.reduce(closed.gate, attached).gate.state.phase shouldBe LockerLockState.Phase.PHASE_LOCKED
    }

    "leaving the foreground relocks at once, and drops a prompt that was up" {
        val (open, _) = gate(attached, tap, answered(1, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED), GateInput.Core(open = true))
        val left = LockerLockMachine.reduce(open, lock(LockerLockEvent(backgrounded = LockerLockEvent.Backgrounded())))
        left.gate.state.phase shouldBe LockerLockState.Phase.PHASE_LOCKED
        left.gate.state.cover.shouldBeTrue()
        left.effects shouldBe listOf(GateEffect.Relock)
        val (asking, _) = gate(attached, tap)
        val away = LockerLockMachine.reduce(asking, lock(LockerLockEvent(backgrounded = LockerLockEvent.Backgrounded()))).gate
        away.state.prompt.shouldBeNull()
        // The prompt's late answer arrives for a token nobody is asking.
        LockerLockMachine.reduce(away, answered(asking.state.prompt!!.token, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED))
            .effects.shouldBeEmpty()
    }

    "back in the foreground the gate asks the core, and an idle end locks" {
        val (open, _) = gate(attached, tap, answered(1, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED), GateInput.Core(open = true))
        LockerLockMachine.reduce(open, lock(LockerLockEvent(foregrounded = LockerLockEvent.Foregrounded()))).effects shouldBe listOf(GateEffect.Check)
        val ended = LockerLockMachine.reduce(open, GateInput.Core(open = false)).gate
        ended.state.phase shouldBe LockerLockState.Phase.PHASE_LOCKED
        ended.state.notice shouldBe LockerCopy.LOCK_EXPIRED
        // A screen's reveal that answered LOCKED says the same.
        LockerLockMachine.reduce(open, GateInput.Expired).gate.state.phase shouldBe LockerLockState.Phase.PHASE_LOCKED
    }

    "the wall's words follow the biometry and never name a platform's brand" {
        mapOf(
            LockerBiometry.LOCKER_BIOMETRY_FINGERPRINT to LockerCopy.METHOD_FINGERPRINT,
            LockerBiometry.LOCKER_BIOMETRY_TOUCH to LockerCopy.METHOD_FINGERPRINT,
            LockerBiometry.LOCKER_BIOMETRY_PASSCODE to LockerCopy.METHOD_PASSCODE,
        ).forEach { (biometry, words) ->
            val (gate, _) = gate(lock(LockerLockEvent(attached = LockerLockEvent.Attached(available = true, biometry = biometry))))
            gate.state.unlock_label shouldContain words
        }
        LockerCopy.PROMPT_REASON shouldNotContain "Face ID"
        LockerCopy.PROMPT_REASON shouldNotContain "Touch ID"
    }

    "the running gate asks the door once per step, and relocks on leave" {
        val door = FakeDoor()
        val scope = TestScope(StandardTestDispatcher())
        val gate = LockerGate(door, scope)
        runTest {
            gate.reduce(attached)
            gate.reduce(tap)
            gate.reduce(answered(gate.state.value.prompt!!.token, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED))
            gate.open.value.shouldBeTrue()
            door.calls shouldBe listOf("unlock")
            gate.reduce(lock(LockerLockEvent(backgrounded = LockerLockEvent.Backgrounded())))
            gate.open.value.shouldBeFalse()
            door.calls shouldBe listOf("unlock", "relock")
        }
    }

    // --- nothing is read while locked ---------------------------------------

    "a locked Locker reads nothing: no effect, and no request even if asked" {
        val (held, effects) = home.run(openHome)
        effects.filterIsInstance<ScreenEffect.ReadPage>().shouldBeEmpty()
        held.open.shouldBeFalse()
        LockerHomeReads.requests(held, now).shouldBeNull()
        LockerItemReads.requests(
            LockerItemMachine.run(LockerInput.View(LockerItemEvent(opened = LockerItemEvent.Opened(item_id = "item-bank")))).first,
            now,
        ).shouldBeNull()
        // A CHANGE EVENT ON A LOCKED SCREEN READS NOTHING EITHER.
        home.reduce(held, LockerInput.Changed("locker_item")).effects.shouldBeEmpty()
    }

    "the gate opening reads; closing wipes every answer, and a late answer is dropped" {
        val (open, effects) = home.run(openHome, LockerInput.Lock(open = true))
        effects.filterIsInstance<ScreenEffect.ReadPage>().size shouldBe 1
        LockerHomeReads.requests(open, now)!!.single().locker_items.shouldNotBeNull()
        val drawn = home.reduce(open, LockerInput.Answered(listOf(items(row("item-bank", "Bank"))))).state
        drawn.screen.data_!!.rows.single().title shouldBe "Bank"
        val relocked = home.reduce(drawn, LockerInput.Lock(open = false)).state
        relocked.screen.data_.shouldBeNull()
        relocked.answers.items.shouldBeNull()
        relocked.screen.band.shouldBeEmpty()
        relocked.screen.destination shouldBe LockerHomeState.Destination.DESTINATION_ITEMS
        val late = home.reduce(relocked, LockerInput.Answered(listOf(items(row("item-bank", "Bank"))))).state
        late.screen.data_.shouldBeNull()
    }

    "the kit trash reads behind the gate, and says the Locker is locked" {
        val door = FakeDoor()
        val gate = LockerGate(door, TestScope(StandardTestDispatcher()))
        val reads = LockerTrashReads(gate)
        reads.query(TrashListState(), null, "UTC").shouldBeNull()
        reads.refused(dev.centraid.shared.screen.Reads.refused("x")).refused!!.failure!!.sentence shouldBe LockerCopy.LOCKED_SENTENCE
        runTest {
            gate.reduce(attached)
            gate.reduce(tap)
            gate.reduce(answered(gate.state.value.prompt!!.token, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED))
        }
        val query = reads.query(TrashListState(), null, "UTC").shouldNotBeNull()
        query.from shouldBe "locker_item"
        query.select shouldContain "title"
        query.select.none { it in setOf("password", "otp_seed", "card_number", "cvv", "content") }.shouldBeTrue()
    }

    // --- home ---------------------------------------------------------------

    "items fold into filter chips, rows and the window's honest end" {
        val (open, _) = home.run(openHome, LockerInput.Lock(open = true))
        val answer = items(
            row("a", "Bank", starred = true),
            row("b", "Forum", compromised = true),
            row("c", "Visa", type = "card"),
            total = 312,
            truncated = true,
        )
        val data = home.reduce(open, LockerInput.Answered(listOf(answer))).state.screen.data_!!
        data.filters.map { it.key } shouldBe listOf("all", "starred", "login", "card")
        data.filters.first().detail shouldBe "312"
        data.window shouldBe "3 of 312 · the window is 300 by default and 2,000 at most."
        data.status_line shouldBe LockerCopy.ITEMS_STATUS
        val forum = data.rows.first { it.item_id == "b" }
        forum.chips.map { it.label } shouldBe listOf(LockerCopy.CHIP_COMPROMISED)
        forum.meta shouldBe "Login · maya"
        forum.type_chip shouldBe "LO"
        // A TYPE'S OWN WORD IS NOT A SUBTITLE: the core fills a note's and a
        // card's with the type ("Secure note · Secure note", the #1047 walk).
        LockerFold.row(LockerItemRow(item_id = "n", type = "note", title = "Memo", subtitle = "Secure note")).meta shouldBe
            LockerCopy.TYPE_NOTE
        LockerFold.row(LockerItemRow(item_id = "v", type = "card", title = "Visa", subtitle = "Card", tags = listOf("travel"))).meta shouldBe
            "${LockerCopy.TYPE_CARD} · travel"
        LockerFold.row(LockerItemRow(item_id = "k", type = "ssh_key", title = "Box", subtitle = "Password")).meta shouldBe
            LockerCopy.TYPE_SSH_KEY
        // A FILTER RE-FOLDS WITHOUT A READ.
        val starred = home.reduce(
            home.reduce(open, LockerInput.Answered(listOf(answer))).state,
            homeView(LockerHomeEvent(filter = LockerHomeEvent.FilterPicked(key = "starred"))),
        )
        starred.effects.shouldBeEmpty()
        starred.state.screen.data_!!.rows.map { it.item_id } shouldBe listOf("a")
    }

    "an empty Locker says day one and offers the first move" {
        val (open, _) = home.run(openHome, LockerInput.Lock(open = true))
        val data = home.reduce(open, LockerInput.Answered(listOf(items(total = 0)))).state.screen.data_!!
        data.items_empty!!.headline shouldBe LockerCopy.DAY_ONE
        data.items_empty.action_label shouldBe LockerCopy.DAY_ONE_ACTION
    }

    "review names the verdicts and the checks this phone does not run" {
        // ONE READ IN FLIGHT: the shelf lands first, then the tab asks its own.
        val (open, _) = home.run(openHome, LockerInput.Lock(open = true), LockerInput.Answered(listOf(items(row("a", "Bank")))))
        val onReview = home.reduce(open, homeView(LockerHomeEvent(band = LockerHomeEvent.BandPicked(key = "review")))).state
        LockerHomeReads.requests(onReview, now)!!.single().locker_review.shouldNotBeNull()
        val data = home.reduce(
            onReview,
            LockerInput.Answered(listOf(AppQueryResponse(locker_review = LockerReview(compromised = listOf(row("b", "Forum", compromised = true)), reviewed = 4, today = "2099-06-30")))),
        ).state.screen.data_!!
        data.review.single().head!!.count shouldBe 1
        data.review_unchecked.map { it.label } shouldBe listOf(LockerCopy.REVIEW_WEAK, LockerCopy.REVIEW_BREACH)
        data.review_clear.shouldBeNull()
        data.review_note shouldBe "Checked 4 items today"
    }

    "the band is five tabs while open, and More is a sheet, never a destination" {
        val (open, _) = home.run(openHome, LockerInput.Lock(open = true))
        open.screen.band.map { it.key } shouldBe listOf("items", "review", "generate", "search", "more")
        val more = home.reduce(open, homeView(LockerHomeEvent(band = LockerHomeEvent.BandPicked(key = "more")))).state
        more.screen.sheet shouldBe LockerHomeState.Sheet.SHEET_MORE
        more.screen.destination shouldBe LockerHomeState.Destination.DESTINATION_ITEMS
    }

    // --- one item -----------------------------------------------------------

    val item = LockerItemMachine
    fun itemView(event: LockerItemEvent) = LockerInput.View(event)
    fun openItem(): LockerHeld<LockerItemState> = item.run(
        itemView(LockerItemEvent(opened = LockerItemEvent.Opened(item_id = "item-bank", parent = "Items"))),
        LockerInput.Lock(open = true),
        LockerInput.Answered(listOf(itemAnswer())),
    ).first

    "an item does not read before it is opened, so no failure flashes on the first push" {
        // The gate is already open when the page is pushed: its Lock lands
        // before the view's Opened. That must not read with an empty id.
        val (early, earlyEffects) = item.run(LockerInput.Lock(open = true), LockerInput.Changed("locker_item"))
        earlyEffects.shouldBeEmpty()
        early.reading.shouldBeFalse()
        early.screen.failure.shouldBeNull()
        early.screen.loading.shouldNotBeNull()
        val opened = item.reduce(early, itemView(LockerItemEvent(opened = LockerItemEvent.Opened(item_id = "item-bank", parent = "Items"))))
        opened.effects.filterIsInstance<ScreenEffect.ReadPage>().map { it.screenId } shouldBe listOf(LockerItemMachine.SCREEN_ID)
        LockerItemReads.requests(opened.state, now).shouldNotBeNull()
    }

    "an item shows metadata plainly and a secret as a sealed row with a verb" {
        val data = openItem().screen.data_.shouldNotBeNull()
        val rows = data.sections.first().rows
        rows.first { it.key == "username" }.value_ shouldBe "maya@example.com"
        val sealed = rows.first { it.key == "password" }
        sealed.sealed_.shouldBeTrue()
        sealed.revealed.shouldBeFalse()
        sealed.value_ shouldBe ""
        sealed.verbs.map { it.key } shouldBe listOf("reveal", "copy")
        // AN ABSENT SECRET IS NO ROW, not an empty one.
        rows.none { it.key == "otp_seed" }.shouldBeTrue()
        data.status_line shouldBe LockerCopy.ITEM_STATUS
    }

    "a reveal is asked of the core, lives thirty seconds, and is gone at zero" {
        val asked = item.reduce(openItem(), itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "password", verb = "reveal")))).state
        val ask = asked.asking.shouldNotBeNull()
        ask.column shouldBe "password"
        asked.screen.data_!!.sections.first().rows.first { it.key == "password" }.note shouldBe LockerCopy.REVEALING
        val revealed = item.reduce(
            asked,
            LockerInput.Revealed(ask.token, LockerDoorAnswer.Session(open = true, revealed = LockerDoorAnswer.Revealed("item-bank", "password", password, "rcp-1", 30_000))),
        )
        val shown = revealed.state.screen.data_!!.sections.first().rows.first { it.key == "password" }
        shown.value_ shouldBe password
        shown.verbs.map { it.key } shouldBe listOf("copy", "conceal")
        shown.note shouldContain "30"
        val tick = revealed.effects.filterIsInstance<ScreenEffect.Schedule>().single()
        var held = revealed.state
        repeat(30) { held = item.reduce(held, LockerInput.Tick(tick.token)).state }
        held.shown.shouldBeNull()
        held.screen.data_!!.sections.first().rows.first { it.key == "password" }.value_ shouldBe ""
        held.screen.encode().decodeToString() shouldNotContain password
    }

    "relocking and leaving both wipe a revealed value" {
        val asked = item.reduce(openItem(), itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "password", verb = "reveal")))).state
        val revealed = item.reduce(
            asked,
            LockerInput.Revealed(asked.asking!!.token, LockerDoorAnswer.Session(open = true, revealed = LockerDoorAnswer.Revealed("item-bank", "password", password, "rcp-1", 30_000))),
        ).state
        val relocked = item.reduce(revealed, LockerInput.Lock(open = false)).state
        relocked.shown.shouldBeNull()
        relocked.answers.item.shouldBeNull()
        relocked.screen.encode().decodeToString() shouldNotContain password
        val left = item.reduce(revealed, item.left()).state
        left.shown.shouldBeNull()
        left.screen.encode().decodeToString() shouldNotContain password
    }

    "copy puts a secret on the clipboard and never on the screen" {
        val asked = item.reduce(openItem(), itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "password", verb = "copy")))).state
        asked.asking!!.copy.shouldBeTrue()
        val copied = item.reduce(
            asked,
            LockerInput.Revealed(asked.asking.token, LockerDoorAnswer.Session(open = true, revealed = LockerDoorAnswer.Revealed("item-bank", "password", password, "rcp-1", 30_000))),
        ).state
        val clipboard = copied.screen.clipboard.shouldNotBeNull()
        clipboard.value_ shouldBe password
        clipboard.sensitive.shouldBeTrue()
        clipboard.expires_in_ms shouldBe 30_000L
        copied.shown.shouldBeNull()
        copied.screen.status!!.sentence shouldBe "Password copied · the clipboard clears itself in 30 seconds"
        val done = item.reduce(copied, itemView(LockerItemEvent(clipboard_done = LockerItemEvent.ClipboardDone(token = clipboard.token)))).state
        done.screen.clipboard.shouldBeNull()
        done.screen.encode().decodeToString() shouldNotContain password
    }

    // --- one-time codes (Q-1047-16) ------------------------------------------

    fun openSeeded(): LockerHeld<LockerItemState> = item.run(
        itemView(LockerItemEvent(opened = LockerItemEvent.Opened(item_id = "item-bank", parent = "Items"))),
        LockerInput.Lock(open = true),
        LockerInput.Answered(
            listOf(itemAnswer(bank.copy(secrets = listOf(LockerSecret(column = "password", present = true), LockerSecret(column = "otp_seed", present = true))))),
        ),
    ).first

    fun code(value: String, seconds: Int) = LockerDoorAnswer.Session(
        open = true,
        code = LockerDoorAnswer.Code("item-bank", value, periodSeconds = 30, remainingSeconds = seconds, receiptId = "rcp-code"),
    )

    "a seed is never revealed: its row offers a code, and the code ticks with its step" {
        val sealed = openSeeded().screen.data_!!.sections.first().rows.first { it.key == "otp_seed" }
        sealed.verbs.map { it.key } shouldBe listOf("code", "copy_code")
        sealed.note shouldBe LockerCopy.OTP_NOTE
        val asked = item.reduce(openSeeded(), itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "otp_seed", verb = "code")))).state
        val ask = asked.asking.shouldNotBeNull()
        ask.code.shouldBeTrue()
        ask.follow.shouldBeTrue()
        asked.screen.data_!!.sections.first().rows.first { it.key == "otp_seed" }.note shouldBe LockerCopy.CODE_FETCHING
        // A reveal verb on the seed asks for nothing: the seed is not shown.
        item.reduce(openSeeded(), itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "otp_seed", verb = "reveal")))).state.asking.shouldBeNull()

        val shown = item.reduce(asked, LockerInput.Revealed(ask.token, code("287082", 3)))
        val row = shown.state.screen.data_!!.sections.first().rows.first { it.key == "otp_seed" }
        row.value_ shouldBe "287 082"
        row.revealed.shouldBeTrue()
        row.countdown.shouldNotBeNull().seconds_left shouldBe 3
        row.countdown.period shouldBe 30
        row.verbs.map { it.key } shouldBe listOf("copy_code", "conceal")
        // THE FIRST CODE FOLLOWS ITS ROLL ONCE: three seconds was too little to type.
        val tick = shown.effects.filterIsInstance<ScreenEffect.Schedule>().single()
        var held = shown.state
        repeat(3) { held = item.reduce(held, LockerInput.Tick(tick.token)).state }
        held.shown.shouldBeNull()
        val next = held.asking.shouldNotBeNull()
        next.code.shouldBeTrue()
        next.follow.shouldBeFalse()
        val second = item.reduce(held, LockerInput.Revealed(next.token, code("359152", 30)))
        second.state.screen.data_!!.sections.first().rows.first { it.key == "otp_seed" }.value_ shouldBe "359 152"
        // …AND THE SECOND CONCEALS: a tap shows at most two steps.
        val secondTick = second.effects.filterIsInstance<ScreenEffect.Schedule>().single()
        held = second.state
        repeat(30) { held = item.reduce(held, LockerInput.Tick(secondTick.token)).state }
        held.shown.shouldBeNull()
        held.asking.shouldBeNull()
        held.screen.encode().decodeToString() shouldNotContain "359152"
    }

    "a copied code is sensitive and leaves the clipboard when it rolls" {
        val asked = item.reduce(openSeeded(), itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "otp_seed", verb = "copy_code")))).state
        val ask = asked.asking.shouldNotBeNull()
        ask.copy.shouldBeTrue()
        val copied = item.reduce(asked, LockerInput.Revealed(ask.token, code("287082", 12))).state
        val clipboard = copied.screen.clipboard.shouldNotBeNull()
        clipboard.value_ shouldBe "287082"
        clipboard.sensitive.shouldBeTrue()
        clipboard.expires_in_ms shouldBe 12_000L
        copied.screen.status!!.sentence shouldBe LockerCopy.CODE_COPIED
        copied.shown.shouldBeNull()
    }

    "a seed that makes no code says so" {
        val asked = item.reduce(openSeeded(), itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "otp_seed", verb = "code")))).state
        val refused = item.reduce(
            asked,
            LockerInput.Revealed(asked.asking!!.token, LockerDoorAnswer.Session(open = true, refusal = LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_NOT_A_SEED)),
        ).state
        refused.screen.status!!.sentence shouldBe LockerCopy.CODE_NOT_A_SEED
        refused.screen.status.refused.shouldBeTrue()
    }

    "a refused reveal says why, in the member's words" {
        val asked = item.reduce(openItem(), itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "password", verb = "reveal")))).state
        val refused = item.reduce(
            asked,
            LockerInput.Revealed(asked.asking!!.token, LockerDoorAnswer.Session(open = false, refusal = LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_LOCKED)),
        ).state
        refused.screen.status!!.sentence shouldBe LockerCopy.REVEAL_LOCKED
        refused.screen.status.refused.shouldBeTrue()
        refused.asking.shouldBeNull()
    }

    "trashing offers Undo, which restores" {
        val trashed = item.reduce(openItem(), itemView(LockerItemEvent(action = LockerItemEvent.ActionTapped(key = "trash"))))
        val write = trashed.effects.filterIsInstance<ScreenEffect.SubmitWrite>().single()
        write.command shouldBe "locker.trash_item"
        val settled = item.reduce(trashed.state, LockerInput.Settled(WriteSettled(invoke_key = write.invokeKey, committed = true))).state
        settled.screen.status!!.action_label shouldBe LockerCopy.UNDO
        item.reduce(settled, itemView(LockerItemEvent(status_acted = LockerItemEvent.StatusActed())))
            .effects.filterIsInstance<ScreenEffect.SubmitWrite>().single().command shouldBe "locker.restore_item"
    }

    // --- the editor ---------------------------------------------------------

    val editor = LockerEditorMachine
    fun editorView(event: LockerEditorEvent, entropy: ByteArray = ByteArray(0)) = LockerInput.View(event, entropy)

    "a new login saves whole, typed secrets as typed, and the key names no secret" {
        val opened = editor.run(
            LockerInput.Lock(open = true),
            editorView(LockerEditorEvent(opened = LockerEditorEvent.Opened(mode = LockerEditorState.Mode.MODE_ADD, item_id = "item-new"))),
        ).first
        opened.screen.data_!!.can_save.shouldBeFalse()
        opened.screen.data_.blocked shouldBe LockerCopy.TITLE_NEEDED
        var held = opened
        listOf("title" to "Bank", "username" to "maya", "password" to password).forEach { (key, value) ->
            held = editor.reduce(held, editorView(LockerEditorEvent(typed = LockerEditorEvent.Typed(key = key, value_ = value)))).state
        }
        val save = editor.reduce(held, editorView(LockerEditorEvent(save = LockerEditorEvent.SaveTapped())))
        val write = save.effects.filterIsInstance<ScreenEffect.SubmitWrite>().single()
        write.command shouldBe "locker.add_item"
        write.inputJson shouldContain "\"item_id\":\"item-new\""
        write.inputJson shouldContain "\"type\":\"login\""
        write.inputJson shouldContain "\"password\":\"$password\""
        write.inputJson shouldNotContain "match_policy"
        write.invokeKey shouldNotContain password
        val done = editor.reduce(save.state, LockerInput.Settled(WriteSettled(invoke_key = write.invokeKey, committed = true))).state
        done.screen.done.shouldBeTrue()
        done.screen.encode().decodeToString() shouldNotContain password
        // THE COMMIT ENDS THE SITTING (#1089): the form is gone with it, so a second Save files no second item.
        editor.reduce(done, editorView(LockerEditorEvent(save = LockerEditorEvent.SaveTapped())))
            .effects.filterIsInstance<ScreenEffect.SubmitWrite>().shouldBeEmpty()
    }

    "the editor takes a setup key or an otpauth link, and says why it will not take another" {
        val opened = editor.run(
            LockerInput.Lock(open = true),
            editorView(LockerEditorEvent(opened = LockerEditorEvent.Opened(mode = LockerEditorState.Mode.MODE_ADD, item_id = "item-new"))),
        ).first
        opened.screen.data_!!.inputs.first { it.key == "otp_seed" }.note shouldBe LockerCopy.OTP_HINT
        fun typed(seed: String): centraid.screen.v1.LockerEditorData {
            val titled = editor.reduce(opened, editorView(LockerEditorEvent(typed = LockerEditorEvent.Typed(key = "title", value_ = "Bank")))).state
            return editor.reduce(titled, editorView(LockerEditorEvent(typed = LockerEditorEvent.Typed(key = "otp_seed", value_ = seed)))).state.screen.data_!!
        }
        for (good in listOf("JBSW Y3DP EHPK 3PXP", "otpauth://totp/Bank:maya?secret=JBSWY3DPEHPK3PXP&issuer=Bank&digits=6")) {
            withClue(good) {
                typed(good).can_save.shouldBeTrue()
                typed(good).inputs.first { it.key == "otp_seed" }.note shouldBe LockerCopy.SEALED_ON_SAVE
            }
        }
        for ((bad, sentence) in listOf(
            "not a key!" to LockerCopy.OTP_NOT_A_SEED,
            "otpauth://hotp/Bank?secret=JBSWY3DPEHPK3PXP&counter=0" to LockerCopy.OTP_COUNTER_BASED,
            "otpauth://totp/Bank?secret=JBSWY3DPEHPK3PXP&digits=8" to LockerCopy.OTP_UNSUPPORTED,
        )) {
            withClue(bad) {
                val data = typed(bad)
                data.can_save.shouldBeFalse()
                data.blocked shouldBe sentence
                data.inputs.first { it.key == "otp_seed" }.note shouldBe sentence
            }
        }
    }

    "an edit leaves a stored secret alone unless it is retyped" {
        val opened = editor.run(
            LockerInput.Lock(open = true),
            editorView(LockerEditorEvent(opened = LockerEditorEvent.Opened(mode = LockerEditorState.Mode.MODE_EDIT, item_id = "item-bank"))),
            LockerInput.Answered(listOf(itemAnswer())),
        ).first
        val passwordRow = opened.screen.data_!!.inputs.first { it.key == "password" }
        passwordRow.value_ shouldBe ""
        passwordRow.secret.shouldBeTrue()
        passwordRow.note shouldBe LockerCopy.KEPT_SEALED
        val renamed = editor.reduce(opened, editorView(LockerEditorEvent(typed = LockerEditorEvent.Typed(key = "title", value_ = "My bank")))).state
        val write = editor.reduce(renamed, editorView(LockerEditorEvent(save = LockerEditorEvent.SaveTapped())))
            .effects.filterIsInstance<ScreenEffect.SubmitWrite>().single()
        write.command shouldBe "locker.edit_item"
        write.inputJson shouldContain "\"password\":\"${LockerEditorMachine.PLACEHOLDER}\""
        write.inputJson shouldContain "\"username\":\"maya@example.com\""
        write.inputJson shouldNotContain "\"type\""
    }

    "the member marks a leaked item compromised, and the flag is sent only when it changed (R-1047-F7)" {
        // A NEW ITEM: the row is there and off; a card's note has no password to name.
        val added = editor.run(
            LockerInput.Lock(open = true),
            editorView(LockerEditorEvent(opened = LockerEditorEvent.Opened(mode = LockerEditorState.Mode.MODE_ADD, item_id = "item-new"))),
        ).first
        added.screen.data_!!.compromised_label shouldBe LockerCopy.COMPROMISED_TOGGLE
        added.screen.data_.compromised.shouldBeFalse()
        added.screen.data_.compromised_note shouldBe LockerCopy.COMPROMISED_NOTE
        val card = editor.reduce(added, editorView(LockerEditorEvent(type = LockerEditorEvent.TypePicked(key = "card")))).state
        card.screen.data_!!.compromised_note shouldBe LockerCopy.COMPROMISED_NOTE_NO_PASSWORD
        var held = editor.reduce(added, editorView(LockerEditorEvent(typed = LockerEditorEvent.Typed(key = "title", value_ = "Forum")))).state
        held.screen.data_!!.compromised.shouldBeFalse()
        editor.reduce(held, editorView(LockerEditorEvent(save = LockerEditorEvent.SaveTapped())))
            .effects.filterIsInstance<ScreenEffect.SubmitWrite>().single().inputJson shouldNotContain "compromised"
        held = editor.reduce(held, editorView(LockerEditorEvent(compromised = LockerEditorEvent.CompromisedToggled(on = true)))).state
        held.screen.data_!!.compromised.shouldBeTrue()
        editor.reduce(held, editorView(LockerEditorEvent(save = LockerEditorEvent.SaveTapped())))
            .effects.filterIsInstance<ScreenEffect.SubmitWrite>().single().inputJson shouldContain "\"compromised\":true"

        // AN EDIT OF A FLAGGED ITEM: untouched, the flag is not restated, so a
        // new password clears it in the vault; the note says so as it is typed.
        val flagged = editor.run(
            LockerInput.Lock(open = true),
            editorView(LockerEditorEvent(opened = LockerEditorEvent.Opened(mode = LockerEditorState.Mode.MODE_EDIT, item_id = "item-bank"))),
            LockerInput.Answered(listOf(itemAnswer(bank.copy(compromised = true)))),
        ).first
        flagged.screen.data_!!.compromised.shouldBeTrue()
        editor.dirty(flagged).shouldBeFalse()
        val retyped = editor.reduce(flagged, editorView(LockerEditorEvent(typed = LockerEditorEvent.Typed(key = "password", value_ = password)))).state
        retyped.screen.data_!!.compromised_note shouldBe LockerCopy.COMPROMISED_CLEARS
        val rotation = editor.reduce(retyped, editorView(LockerEditorEvent(save = LockerEditorEvent.SaveTapped())))
            .effects.filterIsInstance<ScreenEffect.SubmitWrite>().single()
        rotation.inputJson shouldNotContain "compromised"

        // Cleared by hand: dirty, and stated.
        val cleared = editor.reduce(flagged, editorView(LockerEditorEvent(compromised = LockerEditorEvent.CompromisedToggled(on = false)))).state
        editor.dirty(cleared).shouldBeTrue()
        cleared.screen.data_!!.compromised_note shouldBe LockerCopy.COMPROMISED_NOTE
        editor.reduce(cleared, editorView(LockerEditorEvent(save = LockerEditorEvent.SaveTapped())))
            .effects.filterIsInstance<ScreenEffect.SubmitWrite>().single().inputJson shouldContain "\"compromised\":false"
    }

    "generate fills the password from the platform's bytes, and a relock closes the editor" {
        val opened = editor.run(
            LockerInput.Lock(open = true),
            editorView(LockerEditorEvent(opened = LockerEditorEvent.Opened(mode = LockerEditorState.Mode.MODE_ADD, item_id = "item-new"))),
        ).first
        val bytes = ByteArray(128) { it.toByte() }
        val generated = editor.reduce(opened, editorView(LockerEditorEvent(generate = LockerEditorEvent.GenerateTapped(key = "password")), bytes)).state
        val value = generated.screen.data_!!.inputs.first { it.key == "password" }.value_
        value.length shouldBe LockerPasswords.DEFAULT_LENGTH
        generated.screen.data_.inputs.first { it.key == "password" }.note shouldContain LockerCopy.STRENGTH_VERY_STRONG
        val relocked = editor.reduce(generated, LockerInput.Lock(open = false)).state
        relocked.screen.done.shouldBeTrue()
        relocked.screen.data_.shouldBeNull()
        relocked.screen.encode().decodeToString() shouldNotContain value
    }

    // --- the generator ------------------------------------------------------

    "the generator rejects rather than biases, and never uses a look-alike" {
        val alphabet = LockerPasswords.alphabet(pin = false, digits = true, symbols = true)
        "0O1lI|".forEach { alphabet.contains(it).shouldBeFalse() }
        // 70 characters: bytes 210..255 are refused, never folded onto the start.
        LockerPasswords.generate(ByteArray(40) { (210 + it % 46).toByte() }, alphabet, 4).shouldBeNull()
        LockerPasswords.generate(byteArrayOf(0, 70, 140.toByte(), 1), alphabet, 4) shouldBe "aaab"
        val gen = LockerGeneratorMachine.run(
            LockerInput.Lock(open = true),
            LockerInput.View(LockerGeneratorEvent(opened = LockerGeneratorEvent.Opened()), ByteArray(128) { (it * 7).toByte() }),
        ).first.screen
        gen.output.length shouldBe LockerPasswords.DEFAULT_LENGTH
        gen.kinds.map { it.key } shouldBe listOf("characters", "pin")
        val pin = LockerGeneratorMachine.run(
            LockerInput.View(LockerGeneratorEvent(kind_picked = LockerGeneratorEvent.KindPicked(key = "pin")), ByteArray(128) { (it * 3).toByte() }),
        ).first.screen
        pin.output.length shouldBe LockerPasswords.PIN_DEFAULT
        pin.output.all { it.isDigit() }.shouldBeTrue()
        pin.use_label shouldBe ""
    }

    // --- Home's tile ----------------------------------------------------------

    "the Home tile counts items, shows none of them, and says whether Locker is open" {
        val read = HomeReads.READS.first { it.appId == "locker" }
        read.query.select shouldBe listOf("item_id", "updated_at")
        read.query.where_!! shouldContain "deleted_at IS NULL"
        HomeReads.TABLES shouldContain "locker_item"
        val rows = listOf(Row(values = listOf(centraid.core.v1.Value(text = "a"), centraid.core.v1.Value(text = "t"))))
        HomeReads.lockerOpen = { false }
        val locked = HomeReads.arrived("locker", rows, capped = false).tile.shouldNotBeNull()
        locked.count!!.value_ shouldBe 1
        locked.count_label shouldBe LockerCopy.TILE_COUNT_ONE
        locked.body!!.locker!!.locked.shouldBeTrue()
        locked.body.locker.state_label shouldBe LockerCopy.TILE_LOCKED
        HomeReads.lockerOpen = { true }
        HomeReads.arrived("locker", rows, capped = false).tile!!.body!!.locker!!.line shouldBe LockerCopy.TILE_OPEN_LINE
        HomeReads.lockerOpen = { false }
    }

    "every Locker table is a table in the vault, and a change on one re-reads" {
        LOCKER_TABLES shouldContain "locker_item"
        withClue("a change on a Locker table re-reads the screen that shows it") {
            LockerHomeMachine.rowsChanged("core_tag", emptyList()).shouldBeInstanceOf<LockerInput.Changed>()
            LockerHomeMachine.rowsChanged("media_asset", emptyList()).shouldBeNull()
        }
        TrashListEvent.Refreshed() shouldNotBe null
    }
})

/** The core, faked: every step answers the session it would. */
private class FakeDoor : LockerDoor {
    val calls = mutableListOf<String>()
    private var open = false

    override suspend fun state(): LockerDoorAnswer = LockerDoorAnswer.Session(open = open).also { calls += "state" }

    override suspend fun unlock(): LockerDoorAnswer {
        calls += "unlock"
        open = true
        return LockerDoorAnswer.Session(open = true)
    }

    override suspend fun relock(): LockerDoorAnswer {
        calls += "relock"
        open = false
        return LockerDoorAnswer.Session(open = false)
    }

    override suspend fun reveal(itemId: String, column: String): LockerDoorAnswer =
        LockerDoorAnswer.Session(open = open, refusal = LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_LOCKED)
}
