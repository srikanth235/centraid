package dev.centraid.shared.apps.photos

import centraid.screen.v1.DuplicateReviewData
import centraid.screen.v1.DuplicateReviewEvent
import centraid.screen.v1.DuplicateReviewState
import centraid.screen.v1.Loading
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * ONE CLUSTER, AND THE DECISION THAT DELETES A MEMBER'S PHOTOGRAPHS
 * (#1029, photos port).
 *
 * This is the screen where a default is the product choosing which of somebody's
 * photographs to throw away, so three rules are written into the reducer rather
 * than left to the views:
 *
 * 1. **`keep_asset_id` STARTS EMPTY AND THIS MACHINE NEVER SEEDS IT.** Not on
 *    `Opened`, not on `DataArrived`, not from the suggestion. The only thing
 *    that writes it is [DuplicateReviewEvent.KeepPicked] — a member's tap.
 * 2. **`suggested_keep_asset_id` IS NOT A DECISION.** It rides on the DATA,
 *    beside its reason, and it is deliberately not copied into
 *    `keep_asset_id`: a suggestion nobody accepted must not be able to delete
 *    anything. Both views draw it as a hint on a row and never as a ticked box.
 * 3. **`ResolveRequested` WITH AN EMPTY `keep_asset_id` EMITS NOTHING.** It is
 *    a no-op, not a "keep the first one" and not a "keep the suggestion". The
 *    spec tests this explicitly, because it is the one bug in this pair that
 *    would cost somebody their photographs.
 *
 * ## The write is TRASH and there is no permanent option
 *
 * `media.delete_asset` per member, one command each, and never
 * `media.purge_asset`. A duplicate sweep sends copies to the trash where the
 * member can change their mind — which the proto states — and a bulk act that
 * could not be undone is not one this screen offers. There is no "also purge"
 * affordance to add later: the absence is the design.
 *
 * ## Why a resolve is N commands and not one
 *
 * The vault registers `media.delete_asset` over ONE `asset_id`
 * (`crates/vault/src/commands/media.rs`). There is no bulk verb, and inventing
 * one on this side would be a shell composing a command name the vault does
 * not hold — which is exactly how `notes.save` reached a member's screen as
 * "That request does not make sense to this build" on every window for ever
 * (`NotesEditorMachine.SAVE_COMMAND`). N commands with N stable invoke keys
 * also means a resolve that is interrupted half way has committed exactly the
 * deletions it committed, and a repeat re-sends the rest without re-executing
 * the ones that landed.
 */
public object DuplicateReviewMachine :
    ScreenMachine<DuplicateReviewState, DuplicateReviewEvent> {
    public const val SCREEN_ID: String = "photos.duplicate"

    /**
     * THE COMMAND THE VAULT ACTUALLY HAS.
     *
     * `media.delete_asset` takes one required `asset_id` and moves the row to
     * the trash. **Not `media.purge_asset`**, which is the confirmation-gated
     * permanent one: see the header for why this screen does not offer it and
     * why that is not an omission to fill in.
     */
    public const val TRASH_COMMAND: String = "media.delete_asset"

    /**
     * THE SECOND STATEMENT THIS SCREEN MAKES (#1029, photos port).
     *
     * `ScreenReads` serves one statement per screen id and `arrived` is handed
     * rows with no note saying which produced them, so a screen that reads two
     * tables is two `ScreenReads` with two ids. `PhotoLightboxMachine` has six
     * of these and its note on why a phase field would race applies unchanged.
     *
     * One leg, and the ceiling is stated rather than discovered: this answers
     * the ALBUM half of `member_placed`. The favourite half is a `core_tag` row
     * on the flags scheme's `starred` concept (#916), which is two further
     * reads to resolve before the tags can be asked for — see
     * [DuplicateReviewLeg]. The byte size is a third table again and has no
     * carrier on `DuplicateMember`; both are in this lane's report.
     */
    public enum class Leg {
        /** `core_collection_entry`, for `DuplicateMember.member_placed`. */
        PLACEMENTS,
    }

    /** The screen id a [Leg]'s `ReadPage` effect carries. */
    public fun readId(leg: Leg): String = SCREEN_ID + "/" + leg.name.lowercase()

    override fun initial(): DuplicateReviewState = DuplicateReviewState(
        loading = Loading(first_load = true),
        // `keep_asset_id` IS THE PROTO'S DEFAULT EMPTY STRING and is not
        // written here. Spelling it out would look like a choice; leaving it
        // is the choice.
    )

    override fun reduce(
        state: DuplicateReviewState,
        event: DuplicateReviewEvent,
    ): Step<DuplicateReviewState> = when {
        // A DIFFERENT CLUSTER IS A DIFFERENT DECISION. `keep_asset_id` is
        // cleared here and not merely left alone: a keep picked in the cluster
        // the member just backed out of names an asset that is not in this one,
        // and a resolve under it would trash every member of THIS cluster and
        // keep nothing.
        event.opened != null -> Step(
            state.copy(
                cluster_id = event.opened.cluster_id,
                loading = Loading(first_load = true),
                failure = null,
                data_ = null,
                keep_asset_id = "",
                // A SENTENCE ABOUT THE LAST CLUSTER IS NOT ABOUT THIS ONE.
                write_failure = null,
            ),
            listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
        )

        // THE MEMBERS ARRIVED, AND THE KEEP IS RE-VALIDATED AGAINST THEM.
        //
        // A copy the member had picked can be gone by the time the next read
        // lands — trashed on another surface, or purged. Carrying the id
        // forward would leave `keep_asset_id` naming nothing while the Resolve
        // control still looked armed, and [resolve]'s own guard would then have
        // to be the last line of defence. It is the last line of defence; this
        // is the line before it.
        event.data_ != null -> {
            val arriving = event.data_.data_
            Step(
                state.copy(
                    loading = null,
                    failure = null,
                    data_ = arriving,
                    keep_asset_id = state.keep_asset_id
                        .takeIf { it.isNotEmpty() && it in memberIds(arriving) }
                        ?: "",
                ),
                // AND NOW ASK WHERE THESE COPIES ARE FILED. The members carry
                // `placements_checked = false` out of the read, so until this
                // answers the views say the question is open rather than
                // drawing every copy as a stray. No members means no question.
                if (memberIds(arriving).isEmpty()) {
                    emptyList()
                } else {
                    listOf(ScreenEffect.ReadPage(readId(Leg.PLACEMENTS), afterCursor = null))
                },
            )
        }

        // THE PLACEMENT LEG LANDED.
        //
        // Its OWN arm and not a second `DataArrived`, for the reason the
        // contract gives: a reducer handed two of those cannot tell an
        // amendment from a replace, and the lightbox's discriminator inverts
        // here because the asset ids are exactly what this leg has to say.
        //
        // **`placements_checked` GOES TRUE EVEN WHEN THE LIST IS EMPTY**, and
        // that is the whole value of the flag: "none of these is in an album"
        // is a finding, and it is the one that lets the screen stop hedging. A
        // refused leg sends no event at all, so the flag stays false and the
        // hedge stays up.
        //
        // Applied to a snapshot that may have moved: an id that is no longer a
        // member simply matches nothing. The alternative — dropping the whole
        // amendment because one id went stale — would lose the answer for every
        // copy that did not.
        event.placements != null -> {
            val held = state.data_
            if (held == null) {
                Step(state)
            } else {
                val placed = event.placements.placed_asset_ids.toSet()
                Step(
                    state.copy(
                        data_ = held.copy(
                            members = held.members.map { member ->
                                member.copy(member_placed = member.asset_id in placed)
                            },
                            placements_checked = true,
                        ),
                    ),
                )
            }
        }

        // A FAILED READ IS NOT AN EMPTY CLUSTER (census §E seam 3). The members
        // go and the sentence arrives; NO re-read is emitted, because a reducer
        // that retried its own refusal is the 1 s loop the low-disk park exists
        // to stop.
        //
        // `keep_asset_id` is left alone rather than cleared. With `data_` null
        // there are no members, so [resolve] emits nothing whatever it holds —
        // and if the read succeeds on the next wake, the arrival above
        // re-validates it against the members that actually came back. Clearing
        // it here would throw away a member's choice to no end.
        event.refused != null -> Step(
            state.copy(
                loading = null,
                data_ = null,
                failure = event.refused.failure,
            ),
        )

        // A ROW MOVED UNDER THIS CLUSTER. Re-read rather than patch: a member
        // that was trashed elsewhere must leave the list, and a list that
        // patched a row in place would keep offering a copy that is already in
        // the trash. Assets this screen is not showing move nothing.
        // AN EMPTY ID LIST MEANS "RE-READ THIS TABLE", NOT "NOTHING OF MINE"
        // (#1029, photos port). `none {}` over an empty list is vacuously
        // TRUE, and `ChangeFeed::tables_changed` emits `pk_set: Vec::new()`
        // for EVERY locally committed command — it says so itself: "an empty
        // `pk_set` reads as re-read this table, which is what a screen does"
        // (`crates/core/src/events.rs:293`). Without the guard this screen
        // ignores the member's own writes and only ever moves for a sync from
        // another device, which arrives WITH keys.
        event.rows_changed != null ->
            if (
                event.rows_changed.asset_ids.isNotEmpty() &&
                event.rows_changed.asset_ids.none { it in memberIds(state.data_) }
            ) {
                Step(state)
            } else {
                reread(state)
            }

        // THE MEMBER PICKED THE COPY THAT SURVIVES.
        //
        // Only an id that is ON THIS SCREEN is honoured. A view cannot pick a
        // row it is not drawing, so an id from anywhere else is a malformed
        // event — and honouring one would arm a resolve that trashes every
        // member and keeps nothing, which is the worst outcome this screen has.
        event.keep != null ->
            if (event.keep.asset_id in memberIds(state.data_)) {
                Step(
                    state.copy(
                        keep_asset_id = event.keep.asset_id,
                        // A NEW DECISION CLEARS THE LAST ATTEMPT'S SENTENCE,
                        // which is `NotesEditorMachine.edited`'s rule for
                        // `NoteDraft.save_failure`: a refusal describes the
                        // resolve that was refused, and leaving it up while the
                        // member reconsiders which copy to keep reads as a
                        // refusal of the choice they are making now.
                        write_failure = null,
                    ),
                )
            } else {
                Step(state)
            }

        event.resolve != null -> resolve(state)

        // WHAT A SETTLED WRITE DOES, AND WHY IT IS NOT ONE THING.
        //
        // A resolve is N commands, one per copy the member did not keep, so N
        // of these arrive for one press and they can disagree with each other.
        //
        // * **Committed** — nothing at all, and in particular the sentence is
        //   NOT cleared. Three writes where two were refused and the third
        //   committed must still say two were refused, and a success that wiped
        //   `write_failure` would make the order the settles happen to arrive
        //   in decide whether the member is told. The trashed row's own change
        //   arrives as `rows_changed` on `media_asset` and re-reads through the
        //   path above, which is the path that cannot lie; re-reading here as
        //   well would fire one read per member for the same truth.
        // * **Not committed** — the sentence lands on `write_failure`, and the
        //   cluster is re-read so the screen shows which copies are actually
        //   still there.
        //
        // **`keep_asset_id` SURVIVES A REFUSAL.** The member's decision was not
        // the thing that failed, and clearing it would disarm the control they
        // need to press again — they would have to work out, from a list that
        // half changed, which copy they had chosen.
        //
        // **`write_failure` IS ITS OWN FIELD AND NEVER THE `content` ONEOF'S
        // `failure`.** That slot is the READ's, and a refused write put there
        // would replace the copies with an error — so a member whose resolve
        // was denied would lose the list they were resolving. `NoteDraft`'s
        // `save_failure` is the same field for the same reason.
        //
        // Silence here is the worst outcome this screen has: a member left
        // believing a cluster was resolved while copies are still in it, or
        // believing copies were kept that were not.
        event.write_settled != null ->
            if (event.write_settled.committed) {
                Step(state)
            } else {
                Step(
                    state.copy(write_failure = refusal(event.write_settled.sentence)),
                    listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
                )
            }

        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

        else -> Step(state)
    }

    /**
     * TRASH EVERY MEMBER BUT THE KEPT ONE — or do nothing at all.
     *
     * Three refusals, and each of them emits NO effects and changes NO state:
     *
     * 1. **No keep.** The member has not chosen, so there is nothing to keep
     *    and everything to lose. This is the guard the whole screen is built
     *    around.
     * 2. **No data.** The read failed or has not landed; there is nothing to
     *    act on and the ids this could act on are unknown.
     * 3. **A keep that is not a member.** Unreachable from the events above —
     *    [DuplicateReviewEvent.KeepPicked] is validated and `DataArrived`
     *    re-validates — and checked anyway, because the cost of being wrong
     *    here is every copy in the cluster.
     *
     * The kept asset is excluded by id and not by position: a list that had
     * been re-read between the pick and the press can be in a different order,
     * and an index into it would trash the wrong photograph.
     */
    private fun resolve(state: DuplicateReviewState): Step<DuplicateReviewState> {
        val keep = state.keep_asset_id
        if (keep.isEmpty()) return Step(state)
        val data = state.data_ ?: return Step(state)
        val members = data.members.map { it.asset_id }
        if (keep !in members) return Step(state)
        val doomed = members.filter { it.isNotEmpty() && it != keep }
        if (doomed.isEmpty()) return Step(state)
        return Step(
            // A FRESH ATTEMPT CLEARS THE LAST ONE'S SENTENCE. Leaving it up
            // while these writes are in flight would have the member reading a
            // refusal of the press before this one.
            state.copy(write_failure = null),
            doomed.map { assetId ->
                ScreenEffect.SubmitWrite(
                    command = TRASH_COMMAND,
                    inputJson = "{\"asset_id\":${jsonString(assetId)}}",
                    // THE INVOKE KEY IS THE ASSET, NOT AN ORDINAL.
                    //
                    // v0's fallback was the call's ORDINAL and was only stable
                    // for a handler that made the same call sequence every time
                    // (apps census §2.1); without a stable key a replayed
                    // command re-executes one that already committed. Trashing
                    // asset X is the same act however a member arrived at it,
                    // so the key names the asset and nothing else — not the
                    // cluster, which would make the same deletion two different
                    // intents if the sweep re-clustered between two presses.
                    invokeKey = "$TRASH_COMMAND:$assetId",
                )
            },
        )
    }

    /**
     * ASK AGAIN, AND LEAVE THE SCREEN EXACTLY AS IT IS.
     *
     * **The copies stay on screen under a re-read**, which is
     * `NotesEditorMachine`'s choice for its own `rows_changed` and the opposite
     * of `PhotosGridMachine.firstLoad`. The difference is what the member is
     * doing: a grid is being scrolled and can be re-laid; this screen is being
     * DECIDED on, and rows that vanished and came back under a spinner would
     * pull the list out from under a half-made choice — the pick would survive
     * on `keep_asset_id` with nothing on screen to explain it.
     *
     * It is also what the oneof allows. `content` is `loading | failure | data`
     * and the generated constructor REFUSES two of them at once ("At most one
     * of loading, failure, data_ may be non-null"), so a re-read that set
     * `loading` beside the members it wanted to keep would throw rather than
     * render — which is how this was first written, and what the spec caught.
     */
    private fun reread(state: DuplicateReviewState): Step<DuplicateReviewState> = Step(
        state,
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    /**
     * THE REFUSAL A MEMBER READS, AND NEVER AN EMPTY ONE.
     *
     * `ScreenRuntime` hands over `CommandOutcome.reason` — the author's words
     * for a denial or a failed precondition — and that field is empty whenever
     * the failing layer wrote none. `NotesReads` turns an empty sentence into
     * `null`, which is right for an editor whose words are still on the screen;
     * it is wrong HERE, because `null` is exactly the silence this field was
     * added to end. A member who pressed Trash and got nothing back cannot tell
     * a resolve that worked from one that did not, and the copies are the
     * difference.
     *
     * The fallback says what is KNOWN — some copy was not trashed — and does
     * not guess at which or why. `Error.detail` is logs-only and a shell that
     * made its own sentence out of a peer's words would be the hole in that
     * rule.
     */
    private fun refusal(sentence: String): ReadFailure = Reads.refused(
        sentence.ifEmpty { "Centraid could not trash one of these copies." },
    )

    /**
     * The ids on the screen right now.
     *
     * Empty when there is no data — which is what makes every guard above read
     * as "not among the members" rather than needing a null branch of its own.
     */
    private fun memberIds(data: DuplicateReviewData?): Set<String> =
        data?.members?.map { it.asset_id }?.toSet() ?: emptySet()

    /**
     * One JSON string, escaped.
     *
     * `commonMain` carries no JSON dependency and the payload is one field, so
     * this is hand-built the way `NotesEditorMachine.saveInput` is. It is NOT
     * shared with that one: `PerAppLayoutSpec`'s first rule is that an
     * `apps.<x>` package imports no other `apps.<y>`, and two apps meet in the
     * vault as rows and never in a reducer. An asset id has no character this
     * would have to escape today; escaping anyway is what keeps that from being
     * a property the next id scheme has to preserve.
     */
    private fun jsonString(value: String): String = buildString {
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

    /**
     * `media_asset` — the members' own rows, which is also what this screen
     * reads (see [DuplicateReviewReads]).
     *
     * **`media_asset_phash` is NOT declared here, and that is a known gap.**
     * A sweep that re-clusters while a member is mid-review changes WHICH
     * assets belong to this cluster without touching a single `media_asset`
     * row, so this screen would not notice. `rowsChanged` names one table by
     * design — one declaration cannot disagree with itself — and the trade is
     * the right way round: a re-clustering is rare and a member is looking at
     * the screen, while a trashed member is the common case and is caught.
     * Named in this lane's report.
     */
    override fun rowsChanged(table: String, keys: List<String>): DuplicateReviewEvent? =
        when (table) {
            TABLE -> DuplicateReviewEvent(
                rows_changed = DuplicateReviewEvent.RowsChanged(asset_ids = keys),
            )

            else -> null
        }

    private const val TABLE: String = "media_asset"

    override fun seatChanged(seat: SeatState): DuplicateReviewEvent =
        DuplicateReviewEvent(seat_changed = DuplicateReviewEvent.SeatChanged(seat = seat))
}
