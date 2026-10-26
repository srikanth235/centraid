package dev.centraid.android.screens.photos

import androidx.compose.foundation.border
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.PhotosDuplicateMember
import centraid.core.v1.PhotosDuplicateReviewEvent
import centraid.core.v1.PhotosDuplicateReviewState
import centraid.core.v1.PhotosDuplicateSet
import centraid.core.v1.PhotosDuplicatesEvent
import centraid.core.v1.PhotosDuplicatesState
import centraid.core.v1.Route
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE NEAR-DUPLICATE SETS (#1135): `photos.duplicates`, drawn. A list of
 * decisions and not of photographs: each row is the way in to the review, where
 * the member sees the copies side by side. Nothing here deletes anything. Every
 * word is Rust's.
 */
@Composable
public fun PhotosDuplicatesScreen(
    state: PhotosDuplicatesState,
    onEvent: (PhotosDuplicatesEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onBack: () -> Unit,
    parentTitle: String = "",
) {
    PushedPage(title = state.title, parentTitle = parentTitle, onBack = onBack) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(PhotosDuplicatesEvent(refreshed = PhotosDuplicatesEvent.Refreshed())) },
        ) { data ->
            val empty = data.empty
            if (empty != null) {
                EmptyStateView(empty, onAction = null)
            } else {
                Column(
                    modifier = Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(text = data.lede, style = centraidType("small"), color = centraidColor("textSoft"))
                    if (data.reclaim.isNotEmpty()) {
                        Text(text = data.reclaim, style = centraidType("small"), color = centraidColor("textSoft"))
                    }
                    data.sets.forEach { set -> SetRow(set, onOpen) }
                }
            }
        }
    }
}

@Composable
private fun SetRow(set: PhotosDuplicateSet, onOpen: (Route) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { set.route?.let(onOpen) }
            .semantics { contentDescription = set.accessibility_label },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val cover = set.cover?.thumbnail_path
        if (!cover.isNullOrEmpty()) {
            Box(Modifier.size(44.dp)) { ContentImage(cover) }
        } else {
            CentraidIcon(iconKey = "dupe", tint = centraidColor("text"), size = 20.dp)
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(text = set.headline, style = centraidType("bodyStrong"))
            Text(text = set.subhead, style = centraidType("small"), color = centraidColor("textSoft"))
        }
        CentraidIcon(iconKey = "ChevronRight", tint = centraidColor("textSoft"), size = 18.dp)
    }
}

/**
 * ONE SET, AND THE DECISION THAT TRASHES A MEMBER'S PHOTOGRAPHS (#1135):
 * `photos.duplicate_review`, drawn. Nothing is kept until the member picks it;
 * the suggestion is a line of text on a row, never a ticked box; trash is not
 * purge. A refused trash is drawn beside the copies, never instead of them.
 */
@Composable
public fun PhotosDuplicateReviewScreen(
    state: PhotosDuplicateReviewState,
    onEvent: (PhotosDuplicateReviewEvent) -> Unit,
    onBack: () -> Unit,
    parentTitle: String = "",
) {
    PushedPage(
        title = state.title,
        parentTitle = parentTitle,
        onBack = onBack,
        status = state.status?.sentence.orEmpty(),
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(PhotosDuplicateReviewEvent(refreshed = PhotosDuplicateReviewEvent.Refreshed())) },
        ) { data ->
            val empty = data.empty
            if (empty != null) {
                EmptyStateView(empty, onAction = null)
            } else {
                Column(
                    modifier = Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(text = data.pick_line, style = centraidType("body"))
                        Text(text = data.pick_caption, style = centraidType("small"), color = centraidColor("textSoft"))
                        NoteLine(data.checked_line)
                    }
                    data.members.forEach { member ->
                        MemberRow(member) {
                            onEvent(
                                PhotosDuplicateReviewEvent(
                                    keep = PhotosDuplicateReviewEvent.KeepPicked(photo_id = member.photo_id),
                                ),
                            )
                        }
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        // A DISABLED CONTROL WITH NO EXPLANATION IS A BROKEN CONTROL.
                        InkButton(
                            label = data.resolve_label,
                            destructive = true,
                            testTag = "duplicates-resolve",
                            enabled = data.resolve_enabled,
                            onPress = {
                                onEvent(PhotosDuplicateReviewEvent(resolve = PhotosDuplicateReviewEvent.ResolveTapped()))
                            },
                        )
                        if (data.resolve_hint.isNotEmpty()) {
                            Text(text = data.resolve_hint, style = centraidType("small"), color = centraidColor("textSoft"))
                        }
                    }
                }
            }
        }
    }
}

/**
 * ONE COPY, WITH WHAT DISTINGUISHES IT FROM ITS SIBLINGS. The tick is the
 * MEMBER'S pick (an outline on the thumbnail) and the hint is Rust's suggestion;
 * they are drawn by two different things on purpose, because a suggestion that
 * borrowed the tick would be a pre-ticked box.
 */
@Composable
private fun MemberRow(member: PhotosDuplicateMember, onPick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onPick)
            .semantics { contentDescription = member.accessibility_label },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        val path = member.tile?.thumbnail_path
        Box(
            Modifier
                .size(72.dp)
                .then(if (member.kept) Modifier.border(2.dp, centraidColor("text")) else Modifier),
        ) {
            if (!path.isNullOrEmpty()) ContentImage(path)
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(text = member.facts, style = centraidType("bodyStrong"))
            Text(text = member.captured, style = centraidType("small"), color = centraidColor("textSoft"))
            if (member.in_album) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CentraidIcon(iconKey = "album", tint = centraidColor("textSoft"), size = 16.dp)
                    Text(text = member.in_album_label, style = centraidType("small"), color = centraidColor("textSoft"))
                }
            }
            if (member.suggestion.isNotEmpty()) NoteLine(member.suggestion)
        }
    }
}

@Composable
private fun NoteLine(sentence: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
        CentraidIcon(iconKey = "info", tint = centraidColor("textSoft"), size = 16.dp)
        Text(text = sentence, style = centraidType("small"), color = centraidColor("textSoft"))
    }
}
