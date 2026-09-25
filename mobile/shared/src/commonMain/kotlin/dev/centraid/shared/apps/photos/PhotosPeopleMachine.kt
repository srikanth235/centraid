package dev.centraid.shared.apps.photos

import centraid.screen.v1.Loading
import centraid.screen.v1.PersonRow
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosPeopleData
import centraid.screen.v1.PhotosPeopleEvent
import centraid.screen.v1.PhotosPeopleState
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * PEOPLE — the members of a family, as this vault has been TOLD them (#1029,
 * photos port, lane L5).
 *
 * The screen that lists nobody a model guessed. A `media_face_region` becomes a
 * person here only once its `review_state` says `confirmed`, which is the
 * owner's own word and the only word `crates/vault`'s
 * `media.answer_face_proposal` will write. The questions live one screen over,
 * in [FaceReviewMachine], and the door between them carries its count — that
 * separation is the product decision the proto states as "one is a list of
 * answers, the other is a queue of questions".
 *
 * ## ONE `ReadPage`, THREE TABLES
 *
 * The screen needs three facts from three tables and the page door has no join.
 * They cannot be chained through this reducer, and the type system is what says
 * so: the content `oneof` means `loading` and `data` cannot both be set, so
 * there is nowhere to park two answers while the third is in flight. The fan
 * out therefore lives BELOW this machine, in `PhotosPeopleBridge` — which is
 * `HomeRuntime`'s design and its documented reason for existing — and this
 * reducer sees one `DataArrived` carrying one finished screen. `PhotosPeopleReads`
 * holds the statements and the fold.
 *
 * ## `empty_reason`
 *
 * Derived in that fold from the recognition TIER and never from an absence; see
 * `PhotosPeopleReads.fold`, which is where the three empty screens v0 collapsed
 * into one are told apart.
 */
public object PhotosPeopleMachine : ScreenMachine<PhotosPeopleState, PhotosPeopleEvent> {
    public const val SCREEN_ID: String = "photos.people"

    /**
     * RENAMING A PERSON IS A CORE COMMAND, NOT A MEDIA ONE.
     *
     * A face region points AT a party; the name lives on `core_party`, and the
     * only registered writer of that column is `core.update_party`
     * (`crates/vault/src/commands/core.rs`). There is no `media.rename_person`,
     * and a screen that invented one would get `UnknownCommand` back on every
     * window for ever — which is exactly the defect
     * `NotesEditorMachine.SAVE_COMMAND` records from #1025, found only on a
     * device against a real vault.
     */
    public const val RENAME_COMMAND: String = "core.update_party"

    override fun initial(): PhotosPeopleState = PhotosPeopleState(
        loading = Loading(first_load = true),
    )

    override fun reduce(
        state: PhotosPeopleState,
        event: PhotosPeopleEvent,
    ): Step<PhotosPeopleState> = when {
        event.opened != null -> firstLoad(state)

        event.next_page != null -> Step(
            state,
            listOf(ScreenEffect.ReadPage(SCREEN_ID, event.next_page.after_cursor)),
        )

        event.data_ != null -> {
            val arriving = event.data_.data_
            if (arriving == null) {
                Step(state)
            } else {
                Step(
                    state.copy(
                        loading = null,
                        failure = null,
                        data_ = merge(state.data_, arriving),
                    ),
                )
            }
        }

        // A FAILED READ IS NOT AN EMPTY LIST, and it is not a half-built one
        // either: whichever of the three reads refused, the bridge refuses the
        // whole screen, because a list of names with no counts under a sentence
        // would claim that nobody in this vault has ever been photographed.
        event.refused != null -> Step(
            state.copy(
                loading = null,
                data_ = null,
                failure = event.refused.failure,
                // THE WRITE'S SENTENCE GOES WITH THE ROW IT WAS ABOUT.
                write_failure = null,
            ),
        )

        // A ROW MOVED. Re-reading from the top is right here and it is NOT
        // right on the queue next door: this screen is a list and a list that
        // renumbers is still a list, while a queue that renumbers moves the
        // question out from under the member's finger.
        //
        // A PARKED FEED EMITS NO RE-READ (census §E seam 8): low disk stops the
        // retry cadence, and a change arriving while parked would restart the
        // loop the park exists to break.
        event.rows_changed != null ->
            if (Reads.isParked(state.failure)) Step(state) else firstLoad(state)

        // THE MEMBER RETYPED SOMEBODY'S NAME.
        //
        // Painted over the row AND written, because the two are different
        // promises: the paint is what the member sees the instant they press
        // done, and the write is what makes it true. A rename that waited for
        // the round trip would leave the old name under a keyboard the member
        // had just dismissed.
        //
        // The paint is safe for the one reason a `rows_changed` re-read is not:
        // a name is not a count and not a cursor, so nothing about WHERE the
        // row sits can have moved — except its sort position, which the next
        // re-read corrects.
        //
        // `invoke_key` IS THE PARTY AND THE VALUE BEING SET, never an ordinal
        // (`NotesEditorMachine`'s note on the field): pressing done twice on
        // one spelling is one write, and correcting a typo is a different key
        // and lands.
        event.renamed != null -> {
            val renamed = event.renamed
            if (renamed.party_id.isEmpty() || renamed.display_name.isEmpty()) {
                // `core.update_party`'s schema puts `minLength: 1` on the name,
                // so an empty one is refused by the vault rather than clearing
                // the column. It never leaves this reducer: a member would
                // otherwise watch a name vanish and come back.
                Step(state)
            } else {
                Step(
                    state.copy(
                        data_ = rename(state.data_, renamed.party_id, renamed.display_name),
                        // A SENTENCE ABOUT THE LAST RENAME, STANDING OVER THIS
                        // ONE, would attach a refusal to the wrong person.
                        write_failure = null,
                    ),
                    listOf(
                        ScreenEffect.SubmitWrite(
                            command = RENAME_COMMAND,
                            inputJson = renameInput(renamed.party_id, renamed.display_name),
                            invokeKey =
                                "$RENAME_COMMAND:${renamed.party_id}:${renamed.display_name}",
                        ),
                    ),
                )
            }
        }

        // A REFUSED RENAME MUST NOT LEAVE THE NEW NAME ON THE SCREEN, AND MUST
        // NOT BE SILENT.
        //
        // The paint above is a claim, and this is where an unkept one is taken
        // back: a re-read puts `core_party`'s own answer on the row, and
        // `write_failure` carries the reason beside it. **Its own slot, never
        // the `content` oneof's `failure`** — that slot is the READ's, and a
        // denied write put there would replace the whole list with an error, so
        // a member whose rename was refused would lose the list they were
        // renaming from. `NoteDraft.save_failure` is the same field for the
        // same reason, and before it existed here the refusal was silent.
        //
        // A COMMITTED rename needs no re-read: the row change it caused arrives
        // on its own, and the paint already agrees with it.
        //
        // A PARKED FEED EMITS NO RE-READ (census §E seam 8) — the sentence
        // still lands, because a member is owed the reason whether or not the
        // list can be refreshed.
        event.write_settled != null -> {
            val settled = event.write_settled
            when {
                settled.committed -> Step(state.copy(write_failure = null))

                Reads.isParked(state.failure) ->
                    Step(state.copy(write_failure = sentenceOf(settled)))

                else -> firstLoad(state).let { step ->
                    Step(step.state.copy(write_failure = sentenceOf(settled)), step.effects)
                }
            }
        }

        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

        else -> Step(state)
    }

    /**
     * THE CORE'S OWN WORDS, or this shell's when it had none.
     *
     * `CommandOutcome.reason` is the author's sentence for a denial or a failed
     * precondition — never the raw predicate, which reaches the audit trail
     * only. An empty one is a refusal nobody worded, and a blank line beside a
     * row would be worse than a plain one.
     */
    private fun sentenceOf(settled: PhotosPeopleEvent.WriteSettled): ReadFailure =
        Reads.refused(settled.sentence.ifEmpty { "Centraid could not save that name." })

    /**
     * A SECOND PAGE IS MORE REGIONS FOR THE SAME PEOPLE, so the counts ADD.
     *
     * Every count stays a FLOOR either way — `photo_count_capped` says so — and
     * a page boundary makes it a slightly softer floor: two faces of one person
     * in one photograph that straddle the boundary are counted twice, because
     * the asset ids that would dedupe them do not survive the fold. That is why
     * the view never prints a bare total over a capped row.
     */
    private fun merge(
        held: PhotosPeopleData?,
        arriving: PhotosPeopleData,
    ): PhotosPeopleData {
        if (held == null) return arriving
        val counts = held.people.associate { it.party_id to it.photo_count }
        val people = arriving.people.map { person ->
            val already = counts[person.party_id] ?: return@map person
            person.copy(photo_count = person.photo_count + already)
        }
        val known = people.map { it.party_id }.toSet()
        return arriving.copy(
            people = (people + held.people.filterNot { it.party_id in known })
                .sortedWith(compareBy({ it.display_name }, { it.party_id })),
            proposed_face_count = held.proposed_face_count + arriving.proposed_face_count,
        )
    }

    /**
     * WHERE A TAP ON A PERSON LANDS.
     *
     * The library under a predicate, which is `photos.shelf`'s whole job — and
     * the name RIDES ALONG so the app bar says "Ada" before the page read
     * (law 2's sibling). Produced here rather than in a view because both
     * shells need the same value and a second spelling of it is a second
     * screen.
     */
    public fun shelfFor(person: PersonRow): PhotoShelf = PhotoShelf(
        state_view = PhotoStateView(
            person = PhotoStateView.Person(
                party_id = person.party_id,
                person_name = person.display_name,
            ),
        ),
    )

    /**
     * `core.update_party`'s input, as JSON bytes.
     *
     * Hand-built for `NotesEditorMachine.saveInput`'s reason: `commonMain`
     * carries no JSON dependency and the escaping is the only hard part. The
     * schema is `additionalProperties: false` with `party_id` required, so
     * every key here is one it names.
     */
    internal fun renameInput(partyId: String, displayName: String): String =
        "{\"party_id\":${jsonString(partyId)},\"display_name\":${jsonString(displayName)}}"

    /** The same escaping `NotesEditorMachine` states; see its note. */
    internal fun jsonString(value: String): String = buildString {
        append('"')
        for (character in value) {
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else ->
                    if (character < ' ') {
                        append("\\u").append(character.code.toString(16).padStart(4, '0'))
                    } else {
                        append(character)
                    }
            }
        }
        append('"')
    }

    private fun rename(
        data: PhotosPeopleData?,
        partyId: String,
        displayName: String,
    ): PhotosPeopleData? = data?.copy(
        people = data.people.map { person ->
            if (person.party_id == partyId) person.copy(display_name = displayName) else person
        },
    )

    private fun firstLoad(state: PhotosPeopleState): Step<PhotosPeopleState> = Step(
        state.copy(
            loading = Loading(first_load = true),
            failure = null,
            // WIRE ENFORCES THE ONEOF — "at most one of loading, failure, data_
            // may be non-null" — so this is not tidiness, it is the constructor
            // that would throw. It is also the read law: a screen that is
            // loading is not a screen holding last round's list.
            data_ = null,
        ),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    /**
     * THREE TABLES MOVE THIS SCREEN, and each one for its own reason.
     *
     * * `media_face_region` — a face was confirmed or answered, which is the
     *   only way somebody joins or leaves this list;
     * * `core_party` — somebody was renamed, merged or purged, here or on
     *   another surface;
     * * `enrich_policy` — the member moved the recognition switch, and the
     *   empty screen's sentence changes with it.
     *
     * The keys are not filtered. Only `core_party`'s are this screen's ids at
     * all; a region id and a policy domain are not, and a filter over them
     * would always say "not mine" — so the event carries them and the reducer's
     * answer to all three is the same re-read.
     */
    override fun rowsChanged(
        table: String,
        keys: List<String>,
    ): PhotosPeopleEvent? = when (table) {
        PhotosPeopleReads.REGION_TABLE,
        PhotosPeopleReads.PARTY_TABLE,
        PhotosPeopleReads.POLICY_TABLE,
        -> PhotosPeopleEvent(rows_changed = PhotosPeopleEvent.RowsChanged(party_ids = keys))

        else -> null
    }

    override fun seatChanged(seat: SeatState): PhotosPeopleEvent =
        PhotosPeopleEvent(seat_changed = PhotosPeopleEvent.SeatChanged(seat = seat))
}
