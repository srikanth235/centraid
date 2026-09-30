package dev.centraid.android.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.DuplicateCluster
import centraid.screen.v1.DuplicatesEvent
import centraid.screen.v1.DuplicatesState
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.ScreenEmpty
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * The shelf of near-duplicate clusters (#1029, photos port).
 *
 * A list of DECISIONS, not of photographs. Each row is one cluster and the row
 * is a way in to `photos.duplicate`, where the member sees the copies side by
 * side and picks the one that survives. Nothing on this screen deletes
 * anything: v0's shelf carried a selection bar with Trash on it
 * (`DuplicatesShelf.tsx:132-150`), so a member could bulk-trash copies from a
 * list that never showed them which copy was the biggest, the sharpest or the
 * one already in an album. The verb lives on the screen that shows the
 * differences.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/DuplicatesView.swift`; the two are
 * kept in step by hand, which is what a shared state message and a shared
 * screen id buy — the arrangement is per platform, the meaning is not.
 */
@Composable
public fun DuplicatesScreen(
    state: DuplicatesState,
    /**
     * **THIS SCREEN SENDS NOTHING, AND THE PARAMETER STAYS.**
     *
     * `DuplicatesEvent`'s six arms are `Opened`, `NextPageRequested` and the
     * four the runtime raises. `Opened` belongs to the shell — one place tells
     * a screen it is on screen, or a push issues two first reads — and there is
     * no next page to request, because a continued page over the nullable
     * `cluster_id` is refused by the door. A shelf of decisions with no verb of
     * its own is the design, not an omission; the parameter is kept so the
     * signature matches every other screen's and so the first event this screen
     * grows has somewhere to go.
     */
    onEvent: (DuplicatesEvent) -> Unit,
    /**
     * OPEN ONE CLUSTER, AS NAVIGATION AND NOT AS AN EVENT.
     *
     * `DuplicatesEvent` has no "cluster tapped" arm, and that is right: this
     * screen's state does not change when a member walks into a cluster, so a
     * reducer that was told would have nothing to do with the news. The shell
     * owns the route; this hands it the id.
     *
     * Defaulted so a preview and a fixture render this screen without one.
     */
    onOpenCluster: (String) -> Unit = {},
) {
    Column(
        modifier = Modifier
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // A WIRE PROPERTY IS CROSS-MODULE PUBLIC API, so Kotlin will not
        // smart-cast it after a null check. Binding each arm's value to a local
        // first is what makes the branches type-check, and it is the shape
        // every screen in this module uses.
        val loading = state.loading
        val failure = state.failure
        val data = state.data_
        when {
            loading != null -> CircularProgressIndicator()

            failure != null -> ScreenFailure(failure.sentence, failure.remedy)

            data != null ->
                if (data.clusters.isEmpty()) {
                    // THE SAME EMPTY LIST, ONE BOOLEAN APART, AND ONLY ONE OF
                    // THEM MAY SAY "NONE".
                    //
                    // `photos-duplicates/scan-incomplete` and
                    // `photos-duplicates/scanned-and-clean` differ by exactly
                    // this flag, and a screen that only checked
                    // `clusters.isEmpty()` draws both the same and is wrong
                    // about one of them: "No duplicates" over a pass that has
                    // not finished is a claim the vault has not earned, and a
                    // member who reads it stops looking.
                    if (data.scan_complete) {
                        ScreenEmpty(
                            sentence = "No near-identical photographs in your library.",
                            remedy = "Centraid has looked through everything on this device.",
                        )
                    } else {
                        ScreenEmpty(
                            sentence = "Centraid has not finished looking for near-identical " +
                                "photographs.",
                            remedy = "That is not the same as there being none — nothing " +
                                "here has been ruled out yet.",
                        )
                    }
                } else {
                    Text(
                        text = lede(data.clusters.size),
                        style = centraidType("small"),
                        color = centraidColor("textSoft"),
                    )
                    // WHAT THE WORK IS WORTH, WHEN THE READ CAN SAY IT.
                    //
                    // **The PHRASE and never the number.** A size is the
                    // vault's to spell — `format_byte_size` is `pub` in
                    // `crates/vault/src/page.rs` precisely so there is one of
                    // it, after a launcher row and a drive row disagreed about
                    // the same file — so this draws what arrived and composes
                    // nothing. Empty means UNKNOWN and not "0 bytes", which is
                    // why the absence draws no line rather than a zero.
                    //
                    // `total_capped` decides the wording: the door has no
                    // `COUNT(*)`, so a figure off a page that filled is a
                    // floor, and `DuplicatesReads` marks the total capped
                    // while it cannot measure it at all.
                    if (data.total_reclaimable_phrase.isNotEmpty()) {
                        Text(
                            text = if (data.total_capped) {
                                "At least ${data.total_reclaimable_phrase} to reclaim."
                            } else {
                                "${data.total_reclaimable_phrase} to reclaim."
                            },
                            style = centraidType("small"),
                            color = centraidColor("textSoft"),
                        )
                    }
                    // THE SAME CAVEAT ABOVE A SHELF THAT DOES HAVE ROWS. A
                    // member who resolves everything here has not finished with
                    // their duplicates, and a screen that went quiet once it had
                    // something to show would only be honest while it was empty.
                    if (!data.scan_complete) {
                        NoteLine("Centraid is still looking; more sets may appear.")
                    }
                    data.clusters.forEach { cluster ->
                        DuplicateClusterRow(cluster) { onOpenCluster(cluster.cluster_id) }
                    }
                }
        }
    }
}

/**
 * ONE CLUSTER, AS A ROW.
 *
 * The count and nothing else, because the count is the only fact this read can
 * state. `reclaimable_bytes` is the number the contract says the shelf is
 * ordered by, and `DuplicatesReads` cannot fill it —
 * `core_content_item.byte_size` is a second table and this door has one. So the
 * row draws NOTHING for zero rather than "0 bytes", and it does not compute a
 * phrase from a byte count either: **a size is formatted by the vault, which
 * knows the member's locale, and never in a view** — which is what
 * `PageQuery.with_document_size`'s own note says, in the words it was written
 * in after a launcher row and a drive row disagreed about how big one file was.
 */
@Composable
private fun DuplicateClusterRow(cluster: DuplicateCluster, onOpen: () -> Unit) {
    // THE COUNT, AND "AT LEAST" WHENEVER IT IS A FLOOR.
    //
    // The door has no `COUNT(*)`, so a count off a page that filled is a floor
    // — which `HomeState.ThingCount.capped` says the same way, and `HomeScreen`
    // spells as "at least N things". This view honours the FLAG and does not
    // assume: `DuplicatesReads` happens to avoid the cap rather than report it
    // — a cluster the page edge cut is dropped whole rather than counted short
    // — so today the flag is false and this says "4 copies" and means four. A
    // view that hard-coded that would be a view that lies the day the read
    // learns to walk.
    val noun = if (cluster.member_count == 1) "copy" else "near-identical copies"
    val headline = if (cluster.member_count_capped) {
        "At least ${cluster.member_count} $noun"
    } else {
        "${cluster.member_count} $noun"
    }
    // WHAT THIS ONE CARD WOULD GIVE BACK, or the invitation when nothing can
    // say. The PHRASE and never the number, for the reason the shelf's total
    // gives: a size is the vault's to spell and this composes nothing. An empty
    // phrase is UNKNOWN — not "0 bytes" — so the row falls back to the line
    // that is true whatever the size is.
    //
    // **`member_count_capped` IS THE RIGHT FLAG FOR A BYTE FLOOR HERE**, and it
    // is not a conflation: a card has no `reclaimable_capped` of its own
    // because it does not need one. The figure is summed over the members the
    // read saw, so a count that is a floor makes the sum a floor by the same
    // arithmetic and in the same rows.
    val phrase = cluster.reclaimable_phrase
    val subhead = when {
        phrase.isEmpty() -> "Pick the one to keep."
        cluster.member_count_capped -> "At least $phrase to reclaim."
        else -> "$phrase to reclaim."
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .semantics { contentDescription = "$headline. $subhead" },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // ONE OF THE COPIES, SO THE ROW IS ABOUT A PHOTOGRAPH.
        //
        // `cover_thumbnail_path` is absent whenever the read could not resolve
        // one — `DuplicatesReads` cannot resolve any, because
        // `media_asset_phash` carries no `content_id` for the door's thumbnail
        // column to correlate on — and the `dupe` mark stands in. It is a
        // FALLBACK and not a placeholder box: a grey square would say "this
        // photograph failed to load" about a photograph nobody asked for.
        val cover = cluster.cover_thumbnail_path
        if (!cover.isNullOrEmpty()) {
            Box(Modifier.size(44.dp)) { ContentImage(cover) }
        } else {
            CentraidIcon(iconKey = "dupe", tint = centraidColor("text"), size = 20.dp)
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(text = headline, style = centraidType("bodyStrong"))
            Text(
                text = subhead,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
            )
        }
        CentraidIcon(
            iconKey = "ChevronRight",
            tint = centraidColor("textSoft"),
            size = 18.dp,
        )
    }
}

/**
 * A remark beside its mark.
 *
 * Shared by both duplicates screens' caveats so the two cannot drift into
 * different shapes for the same kind of sentence — one says what the pass has
 * not finished, the other says what the read could not check.
 */
@Composable
internal fun NoteLine(sentence: String) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        CentraidIcon(iconKey = "info", tint = centraidColor("textSoft"), size = 16.dp)
        Text(
            text = sentence,
            style = centraidType("small"),
            color = centraidColor("textSoft"),
        )
    }
}

/**
 * How many sets there are to work through.
 *
 * It counts CLUSTERS and not photographs: the unit of work on this shelf is a
 * decision, and "84 duplicate photos" would be a number a member cannot act on
 * one of.
 */
private fun lede(clusters: Int): String = if (clusters == 1) {
    "1 set of near-identical photographs."
} else {
    "$clusters sets of near-identical photographs."
}
