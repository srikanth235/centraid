package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.FaceCandidate
import centraid.screen.v1.FaceReviewData
import centraid.screen.v1.FaceReviewEvent
import dev.centraid.shared.apps.photos.FaceReviewMachine
import dev.centraid.shared.apps.photos.FaceReviewReads
import dev.centraid.shared.apps.photos.PhotosPeopleReads
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.doubles.plusOrMinus
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain

/**
 * THE FACE QUEUE, AS A STATE MACHINE AND TWO STATEMENTS (#1029, photos port,
 * lane L5).
 *
 * A queue is a cursor and a verdict, and every property below is about one of
 * the two: which question is showing, and what an answer does to the vault.
 */
class FaceReviewSpec : StringSpec({

    fun region(regionId: String, assetId: String, bbox: String, partyId: String, score: Double) =
        Row(
            values = listOf(
                Value(text = regionId),
                Value(text = assetId),
                Value(text = bbox),
                Value(text = partyId),
                Value(real = score),
            ),
        )

    fun party(partyId: String, name: String) = Row(
        values = listOf(Value(text = partyId), Value(text = name), Value(text = "person")),
    )

    val box = "{\"x\":0.25,\"y\":0.1,\"w\":0.4,\"h\":0.5}"

    fun candidates(vararg regionIds: String) = FaceReviewData(
        candidates = regionIds.map { FaceCandidate(region_id = it, asset_id = "a-$it") },
    )

    /** A settle for one region. `region_id` is on the wire now, so it is used. */
    fun settled(committed: Boolean, sentence: String = "", region: String = "") = FaceReviewEvent(
        write_settled = FaceReviewEvent.WriteSettled(
            committed = committed,
            sentence = sentence,
            region_id = region,
        ),
    )

    fun opened() = FaceReviewMachine.reduce(
        FaceReviewMachine.initial(),
        FaceReviewEvent(opened = FaceReviewEvent.Opened()),
    ).state

    // --- the read law -----------------------------------------------------

    "the first Opened emits ONE ReadPage and seeds loading" {
        val step = FaceReviewMachine.reduce(
            FaceReviewMachine.initial(),
            FaceReviewEvent(opened = FaceReviewEvent.Opened()),
        )
        step.state.loading.shouldNotBeNull().first_load shouldBe true
        step.effects shouldBe listOf(
            ScreenEffect.ReadPage(FaceReviewMachine.SCREEN_ID, afterCursor = null),
        )
    }

    "a refusal lands as a failure and never as an empty queue" {
        // AN EMPTY QUEUE IS A CONGRATULATION — "you have worked through them" —
        // so a failed read drawn as one would tell a member they had finished a
        // job they have not seen.
        val refused = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.refused(Reads.noCopyYet()),
        ).state
        refused.loading.shouldBeNull()
        refused.data_.shouldBeNull()
        refused.failure.shouldNotBeNull().sentence shouldNotContain "null"
        // AND THE PICKER CLOSES WITH THE QUEUE IT WAS OVER.
        refused.naming shouldBe false
    }

    "a parked feed emits NO re-read" {
        val parked = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.refused(Reads.lowDiskParked()),
        ).state
        FaceReviewMachine.reduce(
            parked,
            FaceReviewEvent(rows_changed = FaceReviewEvent.RowsChanged(region_ids = listOf("r"))),
        ).effects.shouldBeEmpty()
        FaceReviewMachine.reduce(
            parked,
            settled(committed = false),
        ).effects.shouldBeEmpty()
    }

    "rowsChanged answers for its two tables and null for any other" {
        listOf(FaceReviewReads.REGION_TABLE, FaceReviewReads.PARTY_TABLE).forEach { table ->
            withClue(table) { FaceReviewMachine.rowsChanged(table, listOf("k")).shouldNotBeNull() }
        }
        FaceReviewMachine.rowsChanged("media_asset", listOf("k")).shouldBeNull()
    }

    // --- the cursor, and the page that must not move it --------------------

    "a second page APPENDS, so the cursor still points at the same question" {
        // THE BUG THIS PINS. `cursor` is an index into `candidates` and
        // `FaceReviewData` carries a `next_cursor`, so a page that REPLACED the
        // list would leave the cursor on a different question than the one the
        // member left on — a face attributed to the wrong person, silently.
        // Both shapes typecheck and both render; only this catches it.
        var state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2", "r-3", "r-4", "r-5")),
        ).state
        state = state.copy(cursor = 3)
        FaceReviewMachine.current(state).shouldNotBeNull().region_id shouldBe "r-4"
        state = FaceReviewMachine.reduce(
            state,
            FaceReviewReads.arrived(candidates("r-6", "r-7")),
        ).state
        state.data_.shouldNotBeNull().candidates.map { it.region_id } shouldBe
            listOf("r-1", "r-2", "r-3", "r-4", "r-5", "r-6", "r-7")
        FaceReviewMachine.current(state).shouldNotBeNull().region_id shouldBe "r-4"
    }

    "a region that arrives twice is not asked twice" {
        var state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2")),
        ).state
        state = FaceReviewMachine.reduce(
            state,
            FaceReviewReads.arrived(candidates("r-2", "r-3")),
        ).state
        state.data_.shouldNotBeNull().candidates.map { it.region_id } shouldBe
            listOf("r-1", "r-2", "r-3")
    }

    "a cursor past the end is the worked-through screen, and it is a real one" {
        val state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1")),
        ).state
        FaceReviewMachine.workedThrough(state) shouldBe false
        FaceReviewMachine.workedThrough(state.copy(cursor = 1)) shouldBe true
        FaceReviewMachine.current(state.copy(cursor = 1)).shouldBeNull()
        // AND IT IS NOT "WORKED THROUGH" BEFORE A READ LANDS. The cursor is 0
        // over no candidates, and calling that finished would congratulate a
        // member who has not been shown anything.
        FaceReviewMachine.workedThrough(FaceReviewMachine.initial()) shouldBe false
    }

    "a row change mid-queue does NOT renumber the question under the member" {
        // `PhotosPeopleMachine` re-reads on any change and that is right for a
        // list; here a re-read renumbers `candidates` and the cursor points at
        // whatever landed in that slot.
        var state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2", "r-3")),
        ).state
        state = state.copy(cursor = 1)
        FaceReviewMachine.reduce(
            state,
            FaceReviewEvent(rows_changed = FaceReviewEvent.RowsChanged(region_ids = listOf("r-9"))),
        ).effects.shouldBeEmpty()
        // WORKED THROUGH IS THE ONE MOMENT RENUMBERING COSTS NOTHING, and a
        // refill is exactly what the member is waiting for.
        FaceReviewMachine.reduce(
            state.copy(cursor = 3),
            FaceReviewEvent(rows_changed = FaceReviewEvent.RowsChanged(region_ids = listOf("r-9"))),
        ).effects shouldBe listOf(
            ScreenEffect.ReadPage(FaceReviewMachine.SCREEN_ID, afterCursor = null),
        )
    }

    // --- the three answers -------------------------------------------------

    "reject and dismiss are two writes, not one, and neither moves the cursor yet" {
        // #712 ADDED THE THIRD ANSWER. A queue that could only say "confirmed or
        // not" left "reviewed, deliberately left unnamed" with nowhere to live,
        // so the enricher was free to propose the same stranger again for ever.
        val state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2")),
        ).state
        val rejected = FaceReviewMachine.reduce(
            state,
            FaceReviewEvent(rejected = FaceReviewEvent.Rejected(region_id = "r-1")),
        )
        // THE CURSOR DOES NOT MOVE ON THE SUBMIT. It moves when the vault says
        // the answer committed — an optimistic advance is what a network round
        // trip buys, and the phone IS the vault.
        rejected.state.cursor shouldBe 0
        (rejected.effects.single() as ScreenEffect.SubmitWrite).let { write ->
            write.command shouldBe "media.answer_face_proposal"
            write.inputJson shouldBe "{\"region_id\":\"r-1\",\"answer\":\"reject\"}"
        }
        val dismissed = FaceReviewMachine.reduce(
            state,
            FaceReviewEvent(dismissed = FaceReviewEvent.Dismissed(region_id = "r-1")),
        )
        dismissed.state.cursor shouldBe 0
        (dismissed.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe
            "{\"region_id\":\"r-1\",\"answer\":\"dismiss\"}"
    }

    "skip writes nothing: the question goes to the back and the cursor meets the next" {
        // "DECIDE LATER" (v0's `triageSkip`) IS NOT AN ANSWER. It stays a
        // proposal, so it comes round again once the member has been through
        // the rest; everything before the cursor is still answered.
        val state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2", "r-3")),
        ).state.copy(naming = true)
        val step = FaceReviewMachine.reduce(
            state,
            FaceReviewEvent(skipped = FaceReviewEvent.Skipped(region_id = "r-1")),
        )
        step.effects.shouldBeEmpty()
        step.state.cursor shouldBe 0
        step.state.data_.shouldNotBeNull().candidates.map { it.region_id } shouldBe
            listOf("r-2", "r-3", "r-1")
        // The picker was about the face that just left the screen.
        step.state.naming shouldBe false

        // A SKIP NAMING A FACE THE CURSOR IS NOT ON — a double tap arriving
        // after the first one moved the queue — is dropped rather than
        // skipping a face the member never saw.
        FaceReviewMachine.reduce(
            step.state,
            FaceReviewEvent(skipped = FaceReviewEvent.Skipped(region_id = "r-1")),
        ).state shouldBe step.state
    }

    "a confirm names the party, and only a confirm may" {
        // THE UNION RULE IS THE VAULT'S OWN: `answer_names_a_party_iff_confirm`
        // refuses the other three with a party attached, and JSON Schema has no
        // `oneOf` that could say it — so it is a precondition there and one
        // branch here.
        FaceReviewMachine.answerInput("r-1", FaceReviewMachine.CONFIRM, "p-ada") shouldBe
            "{\"region_id\":\"r-1\",\"answer\":\"confirm\",\"party_id\":\"p-ada\"}"
        FaceReviewMachine.answerInput("r-1", FaceReviewMachine.REJECT, "p-ada") shouldBe
            "{\"region_id\":\"r-1\",\"answer\":\"reject\"}"
    }

    "a confirm naming nobody is not an answer and never leaves the reducer" {
        // The vault would refuse it and the member would watch a face disappear
        // from the queue and come straight back.
        val state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1")),
        ).state
        val step = FaceReviewMachine.reduce(
            state,
            FaceReviewEvent(confirmed = FaceReviewEvent.Confirmed(region_id = "r-1")),
        )
        step.effects.shouldBeEmpty()
        step.state.cursor shouldBe 0
    }

    "the answer keys on the region AND the answer, never on an ordinal" {
        val state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1")),
        ).state
        val write = FaceReviewMachine.reduce(
            state,
            FaceReviewEvent(
                confirmed = FaceReviewEvent.Confirmed(region_id = "r-1", party_id = "p-ada"),
            ),
        ).effects.single() as ScreenEffect.SubmitWrite
        // Answering the same region the same way twice is ONE write; changing
        // one's mind is a different key and lands, which is what `RetrySafe` on
        // the command is for.
        write.invokeKey shouldBe "media.answer_face_proposal:r-1:confirm:p-ada"
    }

    // --- a person this vault has no row for yet ----------------------------

    "a new name creates the party, keeps the question, and keeps the picker open" {
        // THE CASE THAT MATTERS. `people.add_person` mints the id in its handler
        // and returns it in `CommandOutcome.output`, which `ScreenWrites.settled`
        // does not carry — so the confirm that needs it cannot follow. The
        // cursor does NOT move and the picker does NOT close: the question is
        // still open, visibly, which is how a failed create cannot swallow the
        // member's answer. v0 spent the other side of that trade.
        var state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2")),
        ).state
        state = state.copy(naming = true)
        val step = FaceReviewMachine.reduce(
            state,
            FaceReviewEvent(
                confirmed = FaceReviewEvent.Confirmed(region_id = "r-1", new_name = "Ada"),
            ),
        )
        step.state.cursor shouldBe 0
        step.state.naming shouldBe true
        // AND THE NAME THE MEMBER TYPED IS ON THE QUESTION, so it is still
        // there whether the create lands or not.
        step.state.data_.shouldNotBeNull().candidates.first().proposed_name shouldBe "Ada"
        val write = step.effects.single() as ScreenEffect.SubmitWrite
        // A PERSON, so the name is in People's roster too — not a bare party.
        write.command shouldBe "people.add_person"
        write.inputJson shouldBe "{\"display_name\":\"Ada\",\"cadence_days\":0}"
        write.invokeKey shouldBe "people.add_person:r-1:Ada"
    }

    "the new person's id comes back as PersonCreated, and the confirm follows it" {
        // `people.add_person` MINTS THE ID and this machine never does; the bridge
        // reads it off the outcome and hands it back, and the confirm that
        // follows is the same write a pick from the roster makes.
        val state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2")),
        ).state.copy(naming = true)
        val step = FaceReviewMachine.reduce(
            state,
            FaceReviewEvent(
                person_created = FaceReviewEvent.PersonCreated(region_id = "r-1", party_id = "p-ada"),
            ),
        )
        step.state.cursor shouldBe 0
        val write = step.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "media.answer_face_proposal"
        write.inputJson shouldBe
            "{\"region_id\":\"r-1\",\"answer\":\"confirm\",\"party_id\":\"p-ada\"}"
        write.invokeKey shouldBe "media.answer_face_proposal:r-1:confirm:p-ada"

        // AN ID THAT DID NOT COME BACK CONFIRMS NOTHING: the settle's re-read
        // puts the name in the roster for the member to pick.
        FaceReviewMachine.reduce(
            state,
            FaceReviewEvent(person_created = FaceReviewEvent.PersonCreated(region_id = "r-1")),
        ).effects.shouldBeEmpty()
    }

    "a settle while the picker is open re-reads, and keeps the member's place" {
        var state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2", "r-3")),
        ).state
        state = state.copy(cursor = 2, naming = true)
        val step = FaceReviewMachine.reduce(
            state,
            settled(committed = true, region = "r-3"),
        )
        step.effects shouldBe listOf(
            ScreenEffect.ReadPage(FaceReviewMachine.SCREEN_ID, afterCursor = null),
        )
        // THE CURSOR AND THE PICKER ARE KEPT. A create answers nothing, so no
        // region left `review_state = 'proposed'` — the page that comes back is
        // the same page in the same `region_id` order, and the same index is
        // the same question.
        step.state.cursor shouldBe 2
        step.state.naming shouldBe true
    }

    "a refused answer leaves the cursor WHERE IT WAS and says why" {
        // THE DEFECT THIS PINS. A member is shown a face, gives an answer, and
        // the vault refuses it. If the queue had advanced, the answer would be
        // dropped with the cursor already past the question — and they would
        // never be asked again. So the cursor does not move, and the sentence
        // lands in `write_failure`, which is its OWN slot and never the content
        // oneof's `failure`: that one is the READ's, and putting a denied write
        // there would replace the queue with an error.
        val state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2", "r-3", "r-4")),
        ).state.copy(cursor = 3)
        val step = FaceReviewMachine.reduce(
            state,
            settled(committed = false, sentence = "This vault has moved.", region = "r-4"),
        )
        step.state.cursor shouldBe 3
        step.state.write_failure.shouldNotBeNull().sentence shouldBe "This vault has moved."
        // AND THE QUESTION IS STILL THE ONE THEY ANSWERED.
        FaceReviewMachine.current(step.state).shouldNotBeNull().region_id shouldBe "r-4"
        // NO RE-READ: the queue on screen is still the truth, and a reload here
        // would renumber it under a member who is mid-correction.
        step.effects.shouldBeEmpty()
        // THE THREE-STATE READ LAW IS UNTOUCHED — the rows are still there.
        step.state.data_.shouldNotBeNull().candidates.size shouldBe 4
    }

    "a refusal with no words still gets a sentence" {
        // `CommandOutcome.reason` is the author's sentence and can be empty; a
        // blank line under a face would be worse than a plain one.
        FaceReviewMachine.reduce(
            opened(),
            settled(committed = false),
        ).state.write_failure.shouldNotBeNull().sentence shouldBe
            "Centraid could not save that answer."
    }

    "a committed answer with the picker shut moves the queue on, and clears the sentence" {
        var state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2")),
        ).state
        state = FaceReviewMachine.reduce(
            state,
            settled(committed = false, sentence = "no", region = "r-1"),
        ).state
        state.write_failure.shouldNotBeNull()
        val step = FaceReviewMachine.reduce(
            state,
            settled(committed = true, region = "r-1"),
        )
        step.state.cursor shouldBe 1
        step.state.write_failure.shouldBeNull()
        // Re-reading on every committed answer would renumber the queue after
        // every single tap.
        step.effects.shouldBeEmpty()
    }

    "a new answer clears the last one's sentence" {
        var state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2")),
        ).state
        state = FaceReviewMachine.reduce(
            state,
            settled(committed = false, sentence = "no", region = "r-1"),
        ).state
        // A sentence about the last answer left standing over a new question is
        // a refusal attached to the wrong photograph.
        FaceReviewMachine.reduce(
            state,
            FaceReviewEvent(rejected = FaceReviewEvent.Rejected(region_id = "r-1")),
        ).state.write_failure.shouldBeNull()
    }

    "an invoke key names the question it was about, and nothing else does" {
        // `ScreenWrites.settled` is `(status, sentence)` for every screen, so
        // the region rides the key. Without it a refusal would have to assume
        // the answer in flight was the one on screen.
        FaceReviewMachine.regionOfInvokeKey(
            "media.answer_face_proposal:r-4:confirm:p-ada",
        ) shouldBe "r-4"
        FaceReviewMachine.regionOfInvokeKey("people.add_person:r-4:Ada") shouldBe "r-4"
        // ANYTHING ELSE ANSWERS EMPTY, which the reducer reads as "this settle
        // names no question" — a fallback, never a guess at one.
        FaceReviewMachine.regionOfInvokeKey("knowledge.edit_note:note-1:rev-7") shouldBe ""
        FaceReviewMachine.regionOfInvokeKey("nonsense") shouldBe ""
    }

    "only EXECUTED is committed" {
        listOf(
            CommandStatus.COMMAND_STATUS_QUEUED,
            CommandStatus.COMMAND_STATUS_IN_FLIGHT,
            CommandStatus.COMMAND_STATUS_PARKED,
            CommandStatus.COMMAND_STATUS_DENIED,
            CommandStatus.COMMAND_STATUS_FAILED,
        ).forEach { status ->
            withClue(status.name) {
                FaceReviewReads.settled(status, "", "media.answer_face_proposal:reg-0001:confirm")
                    .write_settled.shouldNotBeNull().committed shouldBe false
            }
        }
        FaceReviewReads.settled(
            CommandStatus.COMMAND_STATUS_EXECUTED,
            "",
            "media.answer_face_proposal:reg-0001:confirm",
        )
            .write_settled.shouldNotBeNull().committed shouldBe true
    }

    "the cursor lands PAST THE ANSWERED REGION, not merely one further on" {
        // `region_id` ON THE SETTLE IS WHAT MAKES THIS EXACT. Two answers
        // settling out of order would each have incremented the cursor, moving
        // it twice for the second one — and a member would never be asked about
        // whatever face landed in between.
        val state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2", "r-3", "r-4")),
        ).state.copy(cursor = 3)
        FaceReviewMachine.reduce(state, settled(committed = true, region = "r-2"))
            .state.cursor shouldBe 2
    }

    "a settle for a region this page does not hold moves nothing it should not" {
        // A create's settle names the region it was started from, and after a
        // re-read that region may be gone. Falling back to the old behaviour is
        // the honest answer: this reducer never pretends to know where a face
        // it cannot see belongs.
        val state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2")),
        ).state.copy(cursor = 1)
        FaceReviewMachine.reduce(state, settled(committed = false, region = "r-99"))
            .state.cursor shouldBe 1
    }

    // --- the two facts that cannot ride a FaceReviewData ---------------------

    "the thumbnail leg PAINTS, and an asset it did not answer stays unanswered" {
        // `with_held_thumbnail` is refused at prepare on `media_face_region`,
        // which has no `content_id` — so the photographs come from a leg over
        // `media_asset` and arrive on their own arm. An asset missing from the
        // map is an unanswered question and not "no thumbnail", so a leg that
        // answered half the page must not blank the other half.
        val state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1", "r-2")),
        ).state
        val painted = FaceReviewMachine.reduce(
            state,
            FaceReviewReads.thumbnails(
                listOf(
                    Row(values = listOf(Value(text = "a-r-1"), Value(text = "/store/a.data"))),
                    // AN EMPTY PATH IS LEFT OUT OF THE MAP ENTIRELY: the door
                    // handing back no path is not this leg asserting that a
                    // photograph is absent from the device.
                    Row(values = listOf(Value(text = "a-r-2"), Value(text = ""))),
                ),
            ),
        ).state
        val candidates = painted.data_.shouldNotBeNull().candidates
        candidates[0].thumbnail_path shouldBe "/store/a.data"
        candidates[1].thumbnail_path.shouldBeNull()
        // AND IT IS AN AMENDMENT, NOT A REPLACE: the queue is untouched.
        candidates.map { it.region_id } shouldBe listOf("r-1", "r-2")
    }

    "a thumbnail leg that answered nothing leaves the queue exactly as it was" {
        val state = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.arrived(candidates("r-1")),
        ).state
        FaceReviewMachine.reduce(state, FaceReviewReads.thumbnails(emptyList()))
            .state shouldBe state
    }

    "the asset leg asks only about the ids it was given" {
        val query = FaceReviewReads.thumbnailsQuery(listOf("a-1", "a-2")).shouldNotBeNull()
        query.from shouldBe FaceReviewReads.ASSET_TABLE
        query.where_ shouldBe "asset_id IN (?, ?)"
        query.bind.mapNotNull { it.text } shouldBe listOf("a-1", "a-2")
        // THE COMPUTED COLUMN IS THE WHOLE POINT OF THE LEG.
        query.with_held_thumbnail shouldBe true
        // AN `IN ()` IS NOT A PREDICATE. A leg with nothing to ask is a trip not
        // taken, never a statement matching every row in the library.
        FaceReviewReads.thumbnailsQuery(emptyList()).shouldBeNull()
    }

    "recognition rides its own arm, and an empty queue knows which empty it is" {
        // The tier lives in `enrich_policy` and a `FaceReviewData` has nowhere
        // to put a boolean. An empty queue with the plane off is a different
        // screen with a different next move.
        val on = FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.recognition(
                listOf(Row(values = listOf(Value(text = "photos"), Value(text = "gateway")))),
            ),
        ).state
        on.recognition_enabled shouldBe true
        // AND IT LANDS WHILE THE SCREEN IS STILL LOADING, because it is outside
        // the content oneof — so the empty queue that follows already knows.
        on.loading.shouldNotBeNull()
        FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.recognition(
                listOf(Row(values = listOf(Value(text = "photos"), Value(text = "off")))),
            ),
        ).state.recognition_enabled shouldBe false
        // ONE FOLD FOR BOTH PHOTOS SCREENS, so they cannot disagree about a
        // switch there is only one of — the retired spellings included.
        FaceReviewMachine.reduce(
            opened(),
            FaceReviewReads.recognition(
                listOf(Row(values = listOf(Value(text = "photos"), Value(text = "local")))),
            ),
        ).state.recognition_enabled shouldBe true
    }

    // --- the box ------------------------------------------------------------

    "a bbox is read as FRACTIONS, which is what the writer stores" {
        // `crates/apps/kit`'s corpus calls them "the EXACT normalised boxes the
        // frames were drawn with", origin top left, keys x/y/w/h.
        val read = FaceReviewReads.boxOf("{\"x\":0.3374,\"y\":0.1795,\"w\":0.4511,\"h\":0.4743}")
        read[0] shouldBe (0.3374 plusOrMinus 1e-9)
        read[1] shouldBe (0.1795 plusOrMinus 1e-9)
        read[2] shouldBe (0.4511 plusOrMinus 1e-9)
        read[3] shouldBe (0.4743 plusOrMinus 1e-9)
    }

    "a PIXEL box is dropped rather than drawn somewhere arbitrary" {
        // The divisors are `media_asset.width`/`height`, another table this
        // read cannot join — so a box above 1 cannot be converted, and a
        // confident wrong rectangle over somebody's face is worse than none.
        FaceReviewReads.boxOf("{\"x\":120,\"y\":80,\"w\":300,\"h\":300}").toList() shouldBe
            listOf(0.0, 0.0, 0.0, 0.0)
    }

    "a malformed, absent or zero-sized box is no box at all" {
        listOf(
            "{}",
            "not json",
            "{\"x\":0.1,\"y\":0.1,\"w\":0,\"h\":0.3}",
            "{\"left\":0.1,\"top\":0.1,\"width\":0.3,\"height\":0.3}",
        ).forEach { bbox ->
            withClue(bbox) {
                FaceReviewReads.boxOf(bbox).toList() shouldBe listOf(0.0, 0.0, 0.0, 0.0)
            }
        }
    }

    "a box that runs off the frame is clamped to it" {
        val read = FaceReviewReads.boxOf("{\"x\":0.8,\"y\":0.9,\"w\":0.5,\"h\":0.5}")
        read[2] shouldBe (0.2 plusOrMinus 1e-9)
        read[3] shouldBe (0.1 plusOrMinus 1e-9)
    }

    // --- confidence, as words -----------------------------------------------

    "confidence is WORDS and never a percentage" {
        // "87%" invites a member to reason about a number whose scale they
        // cannot calibrate, and the decision in front of them is binary. The
        // demo corpus's 0.94 and its one deliberately difficult 0.61 land in
        // different words, which is what the bands are for.
        FaceReviewMachine.confidenceWord(0.94) shouldBe "almost certainly"
        FaceReviewMachine.confidenceWord(0.72) shouldBe "probably"
        FaceReviewMachine.confidenceWord(0.61) shouldBe "possibly"
        // THE BOTTOM BAND SAYS NOTHING. A score that low is not a proposal a
        // member should be asked to weigh — and `confidence` is NULL-able, so 0
        // also means "the row does not say".
        FaceReviewMachine.confidenceWord(0.2) shouldBe ""
        FaceReviewMachine.confidenceWord(0.0) shouldBe ""
    }

    // --- the fold -----------------------------------------------------------

    "a candidate is projected off the columns the statement selected" {
        val data = FaceReviewReads.fold(
            partyRows = listOf(party("p-ada", "Ada")),
            queueRows = listOf(region("r-1", "a-1", box, "p-ada", 0.94)),
            nextCursor = "r-1|r-1",
        )
        val candidate = data.candidates.single()
        candidate.region_id shouldBe "r-1"
        candidate.asset_id shouldBe "a-1"
        candidate.proposed_party_id shouldBe "p-ada"
        // THE MODEL'S GUESS, GIVEN ITS NAME by the roster — `media_face_region`
        // holds the id and `core_party` holds the name, and the door has no
        // join, so the fold is where they meet.
        candidate.proposed_name shouldBe "Ada"
        candidate.confidence shouldBe (0.94 plusOrMinus 1e-9)
        candidate.box_x shouldBe (0.25 plusOrMinus 1e-9)
        // NO THUMBNAIL. `with_held_thumbnail` needs a `content_id` on the FROM
        // table and `media_face_region` has none — asking would be refused at
        // prepare, so the field is absent rather than wrong.
        candidate.thumbnail_path.shouldBeNull()
        data.next_cursor shouldBe "r-1|r-1"
        data.known_people.single().display_name shouldBe "Ada"
    }

    "a proposal naming a purged party keeps an EMPTY name, never its id" {
        // The member is being asked about a face belonging to somebody they
        // asked to be forgotten; the question is offered with no suggestion
        // attached, which is the honest shape of "the guess no longer means
        // anything".
        FaceReviewReads.fold(
            partyRows = listOf(party("p-ada", "Ada")),
            queueRows = listOf(region("r-1", "a-1", box, "p-gone", 0.9)),
            nextCursor = null,
        ).candidates.single().proposed_name shouldBe ""
    }

    "an empty queue is DATA with no candidates, never a refusal" {
        val data = FaceReviewReads.fold(emptyList(), emptyList(), null)
        data.candidates.shouldBeEmpty()
        FaceReviewReads.arrived(data).refused.shouldBeNull()
    }

    // --- the statements -----------------------------------------------------

    "both statements select their order columns and bind their values" {
        listOf(FaceReviewReads.queueQuery(), FaceReviewReads.partiesQuery()).forEach { query ->
            val order = query.order.shouldNotBeNull()
            withClue("${query.name} selects ${query.select}") {
                query.select.contains(order.sort_column) shouldBe true
                query.select.contains(order.pk_column) shouldBe true
            }
        }
        val queue = FaceReviewReads.queueQuery()
        // THE FILTER IS `review_state`, NEVER `confirmed_by_party_id` (#712):
        // a rejected region carries no confirmer and a confirmed one does.
        queue.where_.shouldNotBeNull() shouldBe "review_state = ?"
        queue.bind.mapNotNull { it.text } shouldBe listOf(PhotosPeopleReads.PROPOSED)
        // `region_id` IS THE PRIMARY KEY, so a continued page over it is legal —
        // the nullable sort keys the door refuses are elsewhere.
        queue.order.shouldNotBeNull().sort_column shouldBe "region_id"
    }

    "the statements read the tables the machine says it re-reads on" {
        listOf(FaceReviewReads.queueQuery().from, FaceReviewReads.partiesQuery().from)
            .forEach { from ->
                withClue(from) {
                    FaceReviewMachine.rowsChanged(from, listOf("k")).shouldNotBeNull()
                }
            }
    }
})
