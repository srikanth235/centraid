package dev.centraid.android.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.DuplicateMember
import centraid.screen.v1.DuplicateReviewEvent
import centraid.screen.v1.DuplicateReviewState
import centraid.screen.v1.PhotoCell
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.PhotoCellSquare
import dev.centraid.android.kit.ScreenEmpty
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * ONE CLUSTER, AND THE DECISION THAT DELETES A MEMBER'S PHOTOGRAPHS
 * (#1029, photos port).
 *
 * Three things this screen is arranged to keep apart, because getting any of
 * them wrong costs somebody their photographs:
 *
 * 1. **NOTHING IS PICKED UNTIL THE MEMBER PICKS IT.** No row is ticked when
 *    this opens, and the control that trashes the rest is disabled and SAYS it
 *    is disabled until one is. A default here is the product choosing which of
 *    a member's photographs to delete.
 * 2. **THE SUGGESTION IS A HINT ON A ROW, NEVER A TICKED BOX.** It is drawn as
 *    a line of soft text beside the row it is about, with its reason — visibly
 *    a remark and not a state. The tick is the member's and nothing else may
 *    draw one.
 * 3. **TRASH IS NOT PURGE.** The copies go where the member can get them back,
 *    and the line under the control says so. There is no permanent option on
 *    this screen and its absence is the design, not an omission.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/DuplicateReviewView.swift`.
 */
@Composable
public fun DuplicateReviewScreen(
    state: DuplicateReviewState,
    onEvent: (DuplicateReviewEvent) -> Unit,
) {
    Column(
        modifier = Modifier
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // A WIRE PROPERTY IS CROSS-MODULE PUBLIC API, so Kotlin will not
        // smart-cast it after a null check. Binding each arm's value to a local
        // first is what makes the branches type-check.
        val loading = state.loading
        val failure = state.failure
        val data = state.data_
        when {
            loading != null -> CircularProgressIndicator()

            failure != null -> ScreenFailure(failure.sentence, failure.remedy)

            data != null ->
                if (data.members.isEmpty()) {
                    // NOT A FAILURE. An empty cluster is a real answer — the
                    // copies were trashed here or somewhere else — and the read
                    // that says so was refused by nobody.
                    ScreenEmpty(
                        sentence = "There are no copies left in this set.",
                        remedy = "Anything trashed here is still in the trash.",
                    )
                } else {
                    ReviewHeader(placementsChecked = data.placements_checked)
                    data.members.forEach { member ->
                        DuplicateMemberRow(
                            member = member,
                            isKept = state.keep_asset_id == member.asset_id,
                            // EMPTY UNLESS THIS ROW IS THE SUGGESTED ONE. The
                            // reason travels with the row it is about, so there
                            // is no way to draw the sentence beside the wrong
                            // photograph.
                            suggestionReason = if (
                                data.suggested_keep_asset_id == member.asset_id
                            ) {
                                data.suggestion_reason
                            } else {
                                ""
                            },
                            onPick = {
                                onEvent(
                                    DuplicateReviewEvent(
                                        keep = DuplicateReviewEvent.KeepPicked(
                                            asset_id = member.asset_id,
                                        ),
                                    ),
                                )
                            },
                        )
                    }
                    ResolveControl(
                        keptAssetId = state.keep_asset_id,
                        memberCount = data.members.size,
                        onResolve = {
                            onEvent(
                                DuplicateReviewEvent(
                                    resolve = DuplicateReviewEvent.ResolveRequested(),
                                ),
                            )
                        },
                    )
                }
        }
        // A REFUSED RESOLVE SAYS SO, BESIDE THE LIST AND NEVER INSTEAD OF IT.
        //
        // `write_failure` is its OWN field and not the `content` oneof's
        // `failure`: that slot is the READ's, and a denied write put there
        // would replace the copies with an error, so a member whose resolve was
        // refused would lose the list they were resolving from.
        // `NoteDraft.save_failure` is the same field for the same reason.
        //
        // Silence here is the worst outcome this screen has — a resolve is one
        // command per copy, and some can commit while others are refused. A
        // member told nothing is left believing a set was resolved while copies
        // of their photograph are still in it. The list has been re-read by the
        // time this appears, so the sentence sits over what is ACTUALLY still
        // there.
        //
        // OUTSIDE the `when`, so it survives the case where the re-read comes
        // back with nothing left to show: a refusal that only rendered beside
        // members would vanish exactly when the list it explains did.
        val refusal = state.write_failure
        if (refusal != null) ScreenFailure(refusal.sentence, refusal.remedy)
    }
}

@Composable
private fun ReviewHeader(placementsChecked: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(text = "Pick the copy to keep.", style = centraidType("body"))
        Text(
            text = "The others go to the trash, where you can still get them back.",
            style = centraidType("small"),
            color = centraidColor("textSoft"),
        )
        // WHAT WAS CHECKED, AND WHAT WAS NOT — SAID OUT LOUD EITHER WAY.
        //
        // `member_placed` answers "is this copy in an album", and until
        // `DuplicateReviewLeg` lands it is false on every row for want of an
        // answer rather than because there is one. **False is not a safe
        // default on a screen that deletes photographs** — silence would let
        // this screen quietly tell a member every copy is a stray, about a
        // photograph that may be in three albums — so `placements_checked` is
        // what decides which sentence appears, and one of them always does.
        //
        // The favourite half is deliberately named as unchecked: a star is a
        // `core_tag` on the flags scheme's `starred` concept (#916), two
        // further reads, and a screen that said "checked" while meaning "albums
        // only" would be making the narrower claim in the broader words.
        NoteLine(
            if (placementsChecked) {
                "Centraid checked which of these are in an album. " +
                    "Favourites are not checked here."
            } else {
                "Centraid has not been able to check whether these are in an album " +
                    "or favourited."
            },
        )
    }
}

/**
 * ONE COPY, WITH WHAT DISTINGUISHES IT FROM ITS SIBLINGS.
 *
 * The tick is the MEMBER'S pick and the hint is the suggestion, and they are
 * drawn by two different things on purpose: the tick comes from
 * [PhotoCellSquare]'s own `isSelected` overlay — the one cell renderer every
 * Photos surface uses — and the hint is a line of soft text under the facts. A
 * suggestion that borrowed the tick would be a pre-ticked box, and a pre-ticked
 * box on this screen is the product deciding what to delete.
 */
@Composable
private fun DuplicateMemberRow(
    member: DuplicateMember,
    isKept: Boolean,
    suggestionReason: String,
    onPick: () -> Unit,
) {
    // THE PIXEL SIZE, OR NOTHING. `width` and `height` are nullable in the DDL
    // and arrive as zero when the vault does not know them, and "0 x 0" reads
    // as a broken file rather than as a missing fact.
    //
    // **THE BYTE SIZE IS NOT HERE, AND IT IS THE FACT A MEMBER MOST WANTS.**
    // `DuplicateMember.byte_size` is `core_content_item.byte_size`, a second
    // table this door cannot reach, so it arrives zero — and a view does not
    // invent a phrase from a byte count either, which is what
    // `PageQuery.with_document_size`'s own note refuses.
    val pixels = if (member.width > 0 && member.height > 0) {
        "${member.width} × ${member.height}"
    } else {
        ""
    }
    // THE PHRASE AND NEVER THE NUMBER, and the two facts joined only when both
    // are there. `byte_phrase` is empty while the size is unknown — which is
    // not "0 bytes" — and nothing here composes one from `byte_size`, because
    // a size is the vault's to spell. A row with neither still says something:
    // a blank strong line over a capture time reads as a broken row rather
    // than as a photograph nobody measured.
    val dimensions = listOf(pixels, member.byte_phrase)
        .filter { it.isNotEmpty() }
        .joinToString(" · ")
        .ifEmpty { "This copy" }
    val captured = member.captured_at.ifEmpty { "No capture time on this copy" }
    val spoken = listOf(
        dimensions,
        captured,
        if (member.member_placed) "In an album" else "",
        suggestionReason,
        if (isKept) "Keeping this copy" else "",
    ).filter { it.isNotEmpty() }.joinToString(". ")
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onPick)
            .semantics { contentDescription = spoken },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        // ONE CELL RENDERER, SHARED WITH EVERY OTHER PHOTOS SURFACE
        // (`kit/PhotoCells.kt`). It takes a `PhotoCell`, so the member is
        // lowered into one — a LOWERING and not a second cell type: a bespoke
        // square here would be the fifth place the held derivation is spelled,
        // which is how v0 ended up with four that disagreed. Only what a square
        // draws is carried over; the facts beside it are this row's job.
        PhotoCellSquare(
            cell = PhotoCell(
                asset_id = member.asset_id,
                captured_at = member.captured_at,
                thumbnail_path = member.thumbnail_path,
                held = member.held,
            ),
            // WHICH OF THE TWO EMPTY-CELL SENTENCES THIS SCREEN CAN STAND
            // BEHIND. `thumbnail_pack_absent` is a fact about the byte store
            // and `DuplicateReviewData` does not carry one, so false is the
            // conservative answer: the member reads "no longer on this device"
            // rather than being told a pack is missing that may be sitting
            // there. `PhotosReads` makes the same call.
            packAbsent = false,
            modifier = Modifier.size(72.dp),
            isSelected = isKept,
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(text = dimensions, style = centraidType("bodyStrong"))
            Text(
                text = captured,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
            )
            // SOMEBODY FILED THIS COPY, AND DELETING IT IS A DIFFERENT ACT.
            //
            // Drawn only when it is TRUE. False is the answer AND the absence
            // of one — `placements_checked` on the data is what tells those
            // apart, and the header says which — so a "not in any album" line
            // here would be the screen answering a question it may not have
            // asked.
            if (member.member_placed) PlacedLine()
            if (suggestionReason.isNotEmpty()) NoteLine(suggestionReason)
        }
    }
}

/** This copy is in an album, with the albums mark rather than the remark mark. */
@Composable
private fun PlacedLine() {
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CentraidIcon(iconKey = "album", tint = centraidColor("textSoft"), size = 16.dp)
        Text(
            text = "In an album",
            style = centraidType("small"),
            color = centraidColor("textSoft"),
        )
    }
}

/**
 * The verb, and the sentence that says why it is not available yet.
 *
 * **A DISABLED CONTROL WITH NO EXPLANATION IS A BROKEN CONTROL.** The member
 * has not picked a copy, which is the whole reason this cannot run, and a
 * greyed button on its own is indistinguishable from an app that has stopped
 * working.
 *
 * The disable is the SECOND guard and not the only one:
 * `DuplicateReviewMachine.resolve` emits nothing for an empty `keep_asset_id`
 * however the event got there. Two guards for one mistake, because the mistake
 * is a member's photographs.
 */
@Composable
private fun ResolveControl(keptAssetId: String, memberCount: Int, onResolve: () -> Unit) {
    // THE COUNT IS ONLY SAID ONCE THERE IS ONE. With nothing picked there is no
    // "other", and "Trash the other 0 copies" is a sentence about a number the
    // member has not produced yet.
    val picked = keptAssetId.isNotEmpty()
    val doomed = if (picked) memberCount - 1 else 0
    val label = when {
        !picked -> "Trash the other copies"
        doomed == 1 -> "Trash the other copy"
        else -> "Trash the other $doomed copies"
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Button(onClick = onResolve, enabled = picked) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CentraidIcon(iconKey = "trash", tint = centraidColor("danger"), size = 18.dp)
                Text(text = label)
            }
        }
        if (!picked) {
            Text(
                text = "Choose the copy to keep first — nothing is trashed until you do.",
                style = centraidType("small"),
                color = centraidColor("textSoft"),
            )
        }
    }
}
