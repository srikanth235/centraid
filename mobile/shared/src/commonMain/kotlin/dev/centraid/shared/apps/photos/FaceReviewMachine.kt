package dev.centraid.shared.apps.photos

import centraid.screen.v1.FaceCandidate
import centraid.screen.v1.FaceReviewData
import centraid.screen.v1.FaceReviewEvent
import centraid.screen.v1.FaceReviewState
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * FACE REVIEW — a QUEUE of questions, worked one at a time (#1029, photos
 * port, lane L5).
 *
 * "Is this Ada?" and then the next one. The state is a CURSOR and a verdict,
 * which is what makes it a different screen from `photos.people` next door: one
 * is a list of answers a member has already given, this is the backlog of
 * questions a model has asked. v0 drew a page with checkboxes and that is the
 * wrong shape for the job — a member answers faces the way they answer a
 * doorbell, one at a time, and a grid of sixty strangers with tick boxes is a
 * screen nobody finishes.
 *
 * `cursor` PAST THE END IS A REAL SCREEN and not an empty one: "you have worked
 * through them" is the outcome this queue exists to reach, and an empty state
 * apologising for having nothing to show would be the product congratulating
 * the member by shrugging.
 *
 * ## THE THREE ANSWERS ARE THREE WRITES
 *
 * `media.answer_face_proposal` with `confirm`, `reject` or `dismiss` — the only
 * registered writer of `review_state` (`crates/vault/src/commands/media.rs`).
 * They are three because they are three different acts: this IS someone, this
 * is NOT the person proposed, and this is not a face worth naming. #712 added
 * the third and the table's own CHECK keeps them apart; a queue that could only
 * say "confirmed or not" left "reviewed, deliberately left unnamed" with
 * nowhere to live, so the enricher was free to propose the same stranger again
 * for ever.
 *
 * ## A PERSON THIS VAULT HAS NO ROW FOR — THE CASE THAT MATTERS
 *
 * On a first run MOST answers are a name the vault has never heard. That needs
 * two writes: `people.add_person` makes the person — a party AND a People
 * profile, so the name is in People's roster the moment it is in Photos — then
 * `media.answer_face_proposal` confirms the region against it, and it is ONE
 * step for the member. (A bare `core.add_party` party has no profile, and is
 * in no People list.)
 *
 * This machine never mints the id, so it comes back the only way it can: in
 * `CommandOutcome.output`. `FaceReviewBridge` reads it there and hands it back
 * as [FaceReviewEvent.PersonCreated], and the confirm follows from that event.
 * Until then the cursor DOES NOT MOVE and the picker DOES NOT CLOSE, so a failed
 * create cannot swallow the member's answer — v0 created the party first and
 * lost the answer when the create failed.
 *
 * ## SKIP WRITES NOTHING
 *
 * "Decide later" (v0's `triageSkip`). The question moves to the BACK of the
 * queue and stays a proposal; the cursor then points at the next one. Moving it
 * rather than wrapping the cursor keeps the rule every other answer relies on —
 * everything before the cursor is answered — and a skipped face comes round
 * again once the member has been through the rest. Keeping a face and leaving it
 * unnamed is a separate answer, [FaceReviewEvent.Dismissed], and that one writes.
 *
 * ## WHAT ARRIVES BESIDE THE PAGE
 *
 * Two facts this screen needs cannot ride a `FaceReviewData`, so each has an
 * arm of its own and the bridge reads them as extra legs:
 *
 * * **`ThumbnailsArrived`** — `with_held_thumbnail` is refused at prepare on
 *   `media_face_region`, which has no `content_id`, so the photographs come
 *   from a leg over `media_asset` keyed on the page's own asset ids. Without it
 *   face review draws a box over a sentence rather than over a photograph.
 * * **`RecognitionChanged`** — the tier lives in `enrich_policy` and a
 *   `FaceReviewData` has nowhere to put a boolean. An empty queue with the
 *   plane switched off is a different screen from an empty queue, the same way
 *   `PhotosPeopleData.EmptyReason` keeps three of them apart next door.
 *
 * Both are AMENDMENTS and neither is a second `DataArrived`: a reducer handed
 * two of those cannot tell an amendment from a replace, and a replace here
 * would move the cursor onto a different question.
 */
public object FaceReviewMachine : ScreenMachine<FaceReviewState, FaceReviewEvent> {
    public const val SCREEN_ID: String = "photos.faces"

    /** The only registered writer of `media_face_region.review_state`. */
    public const val ANSWER_COMMAND: String = "media.answer_face_proposal"

    /**
     * THE PERSON A FACE IS NAMED AS, when the vault has no row for them yet.
     *
     * People's command and not a media one: a person is People's, and Photos
     * only points at them. There is no `media.create_person`, and a screen
     * that invented one would get `UnknownCommand` on every window for ever
     * (`NotesEditorMachine.SAVE_COMMAND`, #1025).
     */
    public const val CREATE_PERSON_COMMAND: String = "people.add_person"

    override fun initial(): FaceReviewState = FaceReviewState(
        loading = Loading(first_load = true),
    )

    override fun reduce(state: FaceReviewState, event: FaceReviewEvent): Step<FaceReviewState> =
        when {
            event.opened != null -> firstLoad(state)

            // MORE QUESTIONS, APPENDED BEHIND THE ONE ON SCREEN. The cursor is
            // an index into `candidates`, so a page that replaced the list
            // instead of extending it would move the question under the
            // member's finger between the read and their tap.
            event.next_page != null -> Step(
                state,
                listOf(ScreenEffect.ReadPage(SCREEN_ID, event.next_page.after_cursor)),
            )

            event.data_ != null -> arrived(state, event.data_.data_)

            event.refused != null -> Step(
                state.copy(
                    loading = null,
                    data_ = null,
                    failure = event.refused.failure,
                    // THE PICKER CLOSES WITH THE QUEUE IT WAS OVER. A name
                    // field floating above a sentence about a failed read is a
                    // control that would write to a candidate the screen no
                    // longer holds.
                    naming = false,
                    write_failure = null,
                ),
            )

            // A ROW MOVED — AND A QUEUE IS NOT A LIST.
            //
            // `PhotosPeopleMachine` re-reads from the top on any change and
            // that is right for a list; here it is wrong, because a re-read
            // renumbers `candidates` and the cursor points at whatever landed
            // in that slot. The member is mid-question. So a change is served
            // at the one moment where renumbering costs nothing: when there is
            // nothing on screen, or when the queue is worked through and a
            // refill is exactly what the member is waiting for.
            //
            // The change is otherwise DROPPED rather than deferred, and the
            // cost is stated: a region answered on another surface can still be
            // asked here once, and answering it again is what
            // `media.answer_face_proposal` is `RetrySafe` for — "answering the
            // same region twice is how a member corrects themself".
            //
            // A PARKED FEED EMITS NO RE-READ (census §E seam 8).
            event.rows_changed != null -> when {
                Reads.isParked(state.failure) -> Step(state)
                state.data_ == null || workedThrough(state) -> firstLoad(state)
                else -> Step(state)
            }

            event.naming != null -> Step(state.copy(naming = event.naming.naming))

            event.confirmed != null -> confirmed(state, event.confirmed)

            // NOT THE PERSON PROPOSED. The row SURVIVES carrying its answer —
            // a rejection is not a delete, which would make "gone from this
            // queue" and "gone from the vault" the same thing and leave the
            // enricher free to propose the same stranger again (#712,
            // `faces.rs` trap 2).
            event.rejected != null ->
                answered(state, event.rejected.region_id, REJECT, partyId = null)

            // DECIDE LATER. No write: see the class note.
            event.skipped != null -> Step(skipped(state, event.skipped.region_id))

            // REVIEWED, AND DELIBERATELY LEFT UNNAMED. The answer that finishes
            // a queue, and the one v0 could not express until #712.
            event.dismissed != null ->
                answered(state, event.dismissed.region_id, DISMISS, partyId = null)

            // THE NEW PERSON EXISTS — confirm the face against them, now. The
            // same write a pick from the roster makes, so it settles, advances
            // and refuses exactly the way that one does.
            event.person_created != null ->
                if (event.person_created.party_id.isEmpty()) {
                    Step(state)
                } else {
                    answered(
                        state,
                        event.person_created.region_id,
                        CONFIRM,
                        event.person_created.party_id,
                    )
                }

            // THE THUMBNAIL LEG LANDED. Painted onto the candidates in place,
            // which is safe for the reason a `rows_changed` re-read is not: a
            // picture is not a cursor, so nothing about WHICH question is
            // showing can have moved.
            event.thumbnails != null ->
                Step(state.copy(data_ = painted(state.data_, event.thumbnails.path_by_asset_id)))

            // WHETHER THE PLANE IS ON. Outside the content oneof, so it lands
            // while the screen is still loading and the empty queue that
            // follows already knows which empty screen it is.
            event.recognition != null ->
                Step(state.copy(recognition_enabled = event.recognition.enabled))

            event.write_settled != null -> settled(state, event.write_settled)

            event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

            else -> Step(state)
        }

    /**
     * A PAGE OF QUESTIONS, APPENDED.
     *
     * **`DataArrived` APPENDS AND NEVER REPLACES**, which the proto states on
     * `cursor` itself and this is the reducer it binds: the cursor is an index
     * into `candidates`, `FaceReviewData` carries a `next_cursor`, and a second
     * page that replaced the first would leave the cursor pointing at a
     * DIFFERENT question than the one the member left on — which is a face
     * attributed to the wrong person, silently. Both shapes typecheck and both
     * render, so the only thing that catches it is `FaceReviewSpec`.
     *
     * `known_people` comes with every page because the bridge reads the roster
     * beside the queue; the arriving copy is taken whole, since it is the same
     * read either way.
     */
    private fun arrived(
        state: FaceReviewState,
        arriving: FaceReviewData?,
    ): Step<FaceReviewState> {
        if (arriving == null) return Step(state)
        val held = state.data_
        return Step(
            state.copy(
                loading = null,
                failure = null,
                data_ = arriving.copy(
                    candidates = merge(held?.candidates.orEmpty(), arriving.candidates),
                ),
            ),
        )
    }

    /**
     * THIS IS SOMEONE.
     *
     * Two shapes, and the union rule is the vault's own: `confirm` must name a
     * party that EXISTS, which `media.answer_face_proposal`'s
     * `answer_names_a_party_iff_confirm` precondition checks against
     * `core_party` before it writes anything.
     */
    private fun confirmed(
        state: FaceReviewState,
        confirmed: FaceReviewEvent.Confirmed,
    ): Step<FaceReviewState> = when {
        confirmed.party_id.isNotEmpty() ->
            answered(state, confirmed.region_id, CONFIRM, confirmed.party_id)

        // A PERSON THIS VAULT HAS NO ROW FOR. See the class note: the create
        // goes first and the confirm follows `PersonCreated`. Until then the
        // cursor DOES NOT MOVE and the picker DOES NOT CLOSE — the question is
        // still open, visibly, and the name the member typed is painted onto
        // the candidate so a failed create leaves their words on the screen
        // rather than swallowing them.
        confirmed.new_name.isNotEmpty() -> Step(
            state.copy(
                data_ = named(state.data_, confirmed.region_id, confirmed.new_name),
                write_failure = null,
            ),
            listOf(
                ScreenEffect.SubmitWrite(
                    command = CREATE_PERSON_COMMAND,
                    inputJson = createPersonInput(confirmed.new_name),
                    // STABLE FOR THE SAME INTENT, never an ordinal: naming this
                    // face this thing twice is one person, not two rows with
                    // the same name (`NotesEditorMachine`'s note on the field).
                    invokeKey =
                        "$CREATE_PERSON_COMMAND:${confirmed.region_id}:${confirmed.new_name}",
                ),
            ),
        )

        // A CONFIRM THAT NAMES NOBODY IS NOT AN ANSWER. The vault would refuse
        // it and the member would watch a face disappear from the queue and
        // come back, so it never leaves this reducer.
        else -> Step(state)
    }

    /**
     * ONE ANSWER: the write, and nothing else yet.
     *
     * **THE CURSOR DOES NOT MOVE HERE.** It moves in [settled], when the vault
     * says the answer committed — and that ordering is the whole safety of this
     * screen. An optimistic advance is what a network round trip buys, and
     * there is no network: the phone IS the vault, so the write is a local
     * commit and the wait is milliseconds. What an advance would buy instead is
     * the defect: a refused `media.answer_face_proposal` with the cursor
     * already past the question means the member was shown a face, gave an
     * answer, had it dropped, and will never be asked again.
     *
     * `write_failure` is cleared as the answer goes out, because it is about
     * THIS answer from here on; a sentence about the last one left standing
     * over a new question is a sentence attached to the wrong photograph.
     */
    private fun answered(
        state: FaceReviewState,
        regionId: String,
        answer: String,
        partyId: String?,
    ): Step<FaceReviewState> {
        if (regionId.isEmpty()) return Step(state)
        return Step(
            state.copy(naming = false, write_failure = null),
            listOf(
                ScreenEffect.SubmitWrite(
                    command = ANSWER_COMMAND,
                    inputJson = answerInput(regionId, answer, partyId),
                    // THE REGION AND THE ANSWER. Answering the same region the
                    // same way twice is one write; changing one's mind is a
                    // different key and lands, which is what `RetrySafe` on the
                    // command is for.
                    invokeKey = "$ANSWER_COMMAND:$regionId:$answer:${partyId.orEmpty()}",
                ),
            ),
        )
    }

    /**
     * A WRITE CAME BACK.
     *
     * `WriteSettled` says whether it committed and **not WHICH write it was**,
     * which is a gap in this screen's contract — so the rule here is one a
     * mis-attribution cannot corrupt. `naming` is what tells the two apart in
     * practice, because the picker is open exactly while a `people.add_person`
     * is in flight.
     *
     * * **an answer committed** — and only now does the queue move on. The
     *   member stayed on the question they answered until the vault agreed,
     *   which on a phone that IS the vault is a few milliseconds and is what
     *   makes a refusal recoverable;
     * * **a create committed with no id to hand back** — the bridge sends
     *   [FaceReviewEvent.PersonCreated] when it can read the minted id, and
     *   this settle only when it could not. The roster gained a name, so the
     *   page is read again to pick it up and the member finishes with a tap.
     *   The CURSOR IS KEPT, and that is safe for a reason worth stating: a
     *   create answers nothing, so no region left `review_state = 'proposed'`,
     *   so the page that comes back is the same page in the same `region_id`
     *   order and the same index is the same question. The picker stays open
     *   over it;
     * * **anything refused** — the sentence lands in `write_failure` and the
     *   cursor does NOT move. The member is still on the question they
     *   answered, with the reason it did not take, and can answer again. Before
     *   that field existed this branch had nowhere to put the sentence, and a
     *   refused answer was silent.
     *
     * A PARKED FEED EMITS NO RE-READ (census §E seam 8).
     */
    private fun settled(
        state: FaceReviewState,
        settled: FaceReviewEvent.WriteSettled,
    ): Step<FaceReviewState> = when {
        !settled.committed -> Step(
            state.copy(
                // THE CURSOR IS PUT BACK ON THE QUESTION THAT FAILED, exactly,
                // rather than merely left alone. `region_id` is on the settle
                // now, so this no longer has to assume the answer in flight was
                // the one on screen: a member who answered quickly and had an
                // earlier one refused is returned to THAT face, with the reason
                // under it.
                cursor = indexOf(state, settled.region_id) ?: state.cursor,
                write_failure = Reads.refused(
                    settled.sentence.ifEmpty { "Centraid could not save that answer." },
                ),
            ),
        )

        state.naming ->
            if (Reads.isParked(state.failure)) {
                Step(state)
            } else {
                Step(
                    state.copy(
                        loading = Loading(first_load = false),
                        failure = null,
                        // WIRE ENFORCES THE ONEOF, so the page goes while the
                        // next one is in flight. The cursor and the picker do
                        // not: see above for why the same index is the same
                        // question across this particular re-read.
                        data_ = null,
                        write_failure = null,
                    ),
                    listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
                )
            }

        // PAST THE QUESTION THAT WAS ANSWERED, and not merely one further on.
        // Derived from the settle's own `region_id` so that two answers
        // settling out of order cannot skip a face — an increment would have
        // moved the cursor twice for the second one and a member would never be
        // asked about whatever landed in between.
        else -> Step(
            state.copy(
                cursor = indexOf(state, settled.region_id)?.plus(1) ?: (state.cursor + 1),
                write_failure = null,
            ),
        )
    }

    /**
     * THE QUESTION ON SCREEN, MOVED TO THE BACK OF THE QUEUE — and nothing
     * written. The cursor stays where it is, which is now the next question.
     *
     * Only the candidate the cursor is ON is moved: a skip that named another
     * region (a double tap arriving after the first one moved the queue) is
     * dropped rather than skipping a face the member never saw.
     */
    private fun skipped(state: FaceReviewState, regionId: String): FaceReviewState {
        val data = state.data_ ?: return state
        val at = state.cursor
        val current = data.candidates.getOrNull(at) ?: return state
        if (regionId.isNotEmpty() && current.region_id != regionId) return state
        val rest = data.candidates.filterIndexed { index, _ -> index != at }
        return state.copy(
            data_ = data.copy(candidates = rest + current),
            naming = false,
            write_failure = null,
        )
    }

    /** Where a region sits in the queue on screen, or null when it is not on it. */
    private fun indexOf(state: FaceReviewState, regionId: String): Int? {
        if (regionId.isEmpty()) return null
        val at = state.data_?.candidates?.indexOfFirst { it.region_id == regionId } ?: -1
        return if (at < 0) null else at
    }

    /**
     * THE PHOTOGRAPHS, ONTO THE QUESTIONS THAT ARE ON THEM.
     *
     * **An asset missing from the map is an unanswered question and not "no
     * thumbnail"**, which the proto states and this is where it is kept: a
     * candidate whose asset did not come back is left exactly as it was, so a
     * second leg that answered half the page does not blank the other half.
     */
    private fun painted(
        data: FaceReviewData?,
        pathByAssetId: Map<String, String>,
    ): FaceReviewData? {
        if (data == null || pathByAssetId.isEmpty()) return data
        return data.copy(
            candidates = data.candidates.map { candidate ->
                val path = pathByAssetId[candidate.asset_id]
                if (path.isNullOrEmpty()) candidate else candidate.copy(thumbnail_path = path)
            },
        )
    }

    /**
     * HOW SURE THE MODEL IS, IN WORDS A MEMBER CAN ACT ON.
     *
     * Never a percentage. "87%" invites a member to reason about a number whose
     * scale they have no way to calibrate, and the decision in front of them is
     * binary — is this Ada or not. Four words, and the thresholds are stated
     * here rather than in two shells so there is one answer:
     *
     * | score | word |
     * | --- | --- |
     * | ≥ 0.90 | almost certainly |
     * | ≥ 0.70 | probably |
     * | ≥ 0.45 | possibly |
     * | otherwise, and 0 | (nothing) |
     *
     * **0.90 is the demo corpus's own confident value** — `crates/apps/kit`'s
     * frames carry 0.94 for a clear face and 0.61 for the one deliberately
     * difficult frame, and the bands put those two in different words, which is
     * what the bands are for. The bottom band says NOTHING rather than "maybe":
     * a detector score that low is not a proposal a member should be asked to
     * weigh, and `confidence` is `NULL`-able in the DDL so 0 also means "the row
     * does not say".
     *
     * This is the DETECTOR's score and never the queue's match count
     * (`faces.rs`'s first trap): the two are different facts and v0 printed
     * "1 %" for a face seen in one other photograph by running them together.
     */
    public fun confidenceWord(confidence: Double): String = when {
        confidence >= 0.90 -> "almost certainly"
        confidence >= 0.70 -> "probably"
        confidence >= 0.45 -> "possibly"
        else -> ""
    }

    /** The candidate the cursor is on, or null when the queue is worked through. */
    public fun current(state: FaceReviewState): FaceCandidate? =
        state.data_?.candidates?.getOrNull(state.cursor)

    /**
     * Has the member reached the end?
     *
     * True only once the data is there: before the read lands the cursor is 0
     * over no candidates, and calling that "worked through" would congratulate
     * a member who has not been shown anything.
     */
    public fun workedThrough(state: FaceReviewState): Boolean {
        val data = state.data_ ?: return false
        return state.cursor >= data.candidates.size
    }

    /**
     * `media.answer_face_proposal`'s input, as JSON bytes.
     *
     * The schema is `additionalProperties: false` with `region_id` and `answer`
     * required and `party_id` optional — and the party is sent ONLY for a
     * confirm, because the command's own `answer_names_a_party_iff_confirm`
     * predicate refuses the other three with a party attached. JSON Schema has
     * no `oneOf` that could say it, which is why the vault says it in a
     * precondition and this says it in one branch.
     */
    internal fun answerInput(regionId: String, answer: String, partyId: String?): String {
        val fields = mutableListOf(
            "\"region_id\":${PhotosPeopleMachine.jsonString(regionId)}",
            "\"answer\":${PhotosPeopleMachine.jsonString(answer)}",
        )
        if (answer == CONFIRM && !partyId.isNullOrEmpty()) {
            fields += "\"party_id\":${PhotosPeopleMachine.jsonString(partyId)}"
        }
        return fields.joinToString(",", prefix = "{", postfix = "}")
    }

    /**
     * `people.add_person`'s input: the name, and no cadence (`0` — the
     * command requires one, and a face named in Photos asks nobody to keep in
     * touch). The vault mints the `party_id`. `display_name` is `minLength:
     * 1`, so an empty name is refused by the vault — and never sent, because
     * [confirmed] does not submit one.
     */
    internal fun createPersonInput(displayName: String): String =
        "{\"display_name\":${PhotosPeopleMachine.jsonString(displayName)},\"cadence_days\":0}"

    /**
     * THE QUESTION AN INVOKE KEY WAS ABOUT.
     *
     * Both writes this screen submits spell their key `<command>:<region>:<…>`
     * — that is [answered]'s and [confirmed]'s shape and this is the only other
     * place that reads it, which is why the format is stated here rather than
     * inferred twice. It exists because `ScreenWrites.settled` is
     * `(status, sentence)` for every screen and `FaceReviewEvent.WriteSettled`
     * needs a third thing: which face.
     *
     * A command name carries a `.` and never a `:`, and the vault's ids are
     * slugs, so the second segment is the region. Anything this does not
     * recognise answers empty, which the reducer reads as "this settle names no
     * question" — a fallback, never a guess at one.
     */
    public fun regionOfInvokeKey(invokeKey: String): String {
        val parts = invokeKey.split(':')
        if (parts.size < 3) return ""
        val command = parts[0]
        if (command != ANSWER_COMMAND && command != CREATE_PERSON_COMMAND) return ""
        return parts[1]
    }

    /** The command's three answers, as `media.rs`' enum spells them. */
    internal const val CONFIRM: String = "confirm"
    internal const val REJECT: String = "reject"
    internal const val DISMISS: String = "dismiss"

    /**
     * THE NAME THE MEMBER TYPED, KEPT ON THE CANDIDATE.
     *
     * The create is in flight and the confirm cannot follow it (see the class
     * note), so this is what stops the answer being swallowed: the typed name
     * is on the question the member is still looking at, whether the create
     * lands or not.
     */
    private fun named(
        data: FaceReviewData?,
        regionId: String,
        name: String,
    ): FaceReviewData? = data?.copy(
        candidates = data.candidates.map { candidate ->
            if (candidate.region_id == regionId) candidate.copy(proposed_name = name) else candidate
        },
    )

    private fun merge(
        held: List<FaceCandidate>,
        arriving: List<FaceCandidate>,
    ): List<FaceCandidate> {
        if (held.isEmpty()) return arriving
        val known = held.map { it.region_id }.toSet()
        return held + arriving.filterNot { it.region_id in known }
    }

    private fun firstLoad(state: FaceReviewState): Step<FaceReviewState> = Step(
        state.copy(
            loading = Loading(first_load = true),
            failure = null,
            // WIRE ENFORCES THE ONEOF — "at most one of loading, failure,
            // data_ may be non-null" — so this is the constructor's rule and
            // not tidiness. It is also the read law: a screen that is loading
            // is not a screen still holding last round's queue.
            data_ = null,
            cursor = 0,
            naming = false,
            // A REFUSED WRITE'S SENTENCE BELONGS TO THE QUESTION IT WAS ABOUT,
            // and that question is gone with the page.
            write_failure = null,
        ),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    /**
     * TWO TABLES MOVE THIS SCREEN.
     *
     * `media_face_region` is the queue itself — the enricher adding proposals,
     * and answers given on another surface. `core_party` is the picker's
     * roster: a person added, renamed or purged anywhere changes what a member
     * can name a face as, and a picker offering a party that has been purged is
     * a confirm the vault's own precondition will refuse.
     *
     * The keys are not filtered. A region id the queue is not showing is still
     * a reason to refill once the member has worked through, and a party id is
     * not a key this screen holds at all — a filter over it would always say
     * "not mine".
     */
    override fun rowsChanged(
        table: String,
        keys: List<String>,
    ): FaceReviewEvent? = when (table) {
        FaceReviewReads.REGION_TABLE, FaceReviewReads.PARTY_TABLE ->
            FaceReviewEvent(rows_changed = FaceReviewEvent.RowsChanged(region_ids = keys))
        else -> null
    }

    override fun seatChanged(seat: SeatState): FaceReviewEvent =
        FaceReviewEvent(seat_changed = FaceReviewEvent.SeatChanged(seat = seat))
}
