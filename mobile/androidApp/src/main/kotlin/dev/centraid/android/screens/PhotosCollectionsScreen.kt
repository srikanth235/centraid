package dev.centraid.android.screens

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.core.v1.PhotosCollectionCard
import centraid.core.v1.PhotosCollections
import centraid.core.v1.PhotosCollectionsSection
import centraid.core.v1.PhotosHomeChrome
import centraid.core.v1.PhotosHomeEvent
import centraid.core.v1.PhotosHomeState
import centraid.core.v1.PhotosNewAlbumSubmitted
import centraid.core.v1.Route
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry

/**
 * COLLECTIONS (#1029, the photos port; #1135).
 *
 * The hub: every surface this miniapp has that is not the library or search is
 * reached from here. **LAID OUT AS THE SYSTEM PHOTOS APP LAYS OUT ITS
 * COLLECTIONS TAB** (iOS 26): titled, foldable sections — Pinned as a strip of
 * square covers with the name on the picture, Albums as covers with the name and
 * count beneath, Utilities as a grouped list, and the albums in the trash with
 * their Restore. Which section a card lands in, every title, every count and the
 * route a tap opens are Rust's (`photos::home::collections`); this draws them.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotosCollectionsView.swift`.
 */
@Composable
internal fun PhotosCollectionsScreen(
    state: PhotosHomeState,
    collections: PhotosCollections,
    onEvent: (PhotosHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    val chrome = state.chrome ?: PhotosHomeChrome()
    val data = collections.data_
    val loading = collections.loading
    val failure = collections.failure
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = MARGIN)
            .padding(bottom = 24.dp),
    ) {
        // SHOW ALL / COLLAPSE ALL is one link here — v0's Collections menu without
        // the menu: a bulk fold is a command over this list, not a header verb.
        if (data != null && data.sections.isNotEmpty()) {
            val everyFolded = data.sections.all { it.folded }
            Row(Modifier.fillMaxWidth().padding(top = 4.dp)) {
                Spacer(Modifier.weight(1f))
                KitLink(
                    label = if (everyFolded) chrome.show_all_label else chrome.collapse_all_label,
                    onClick = { onEvent(PhotosHomeEvent(fold_all = centraid.core.v1.PhotosFoldAll())) },
                )
            }
        }
        when {
            loading != null -> RowSkeleton()
            failure != null -> ScreenFailure(failure.sentence, failure.remedy)
            data != null -> data.sections.forEach { section ->
                Section(section.title, section.toggle_label, section.folded, { onEvent(PhotosHomeEvent(section_toggled = section.key)) }) {
                    SectionBody(section, onEvent, onOpen)
                }
            }
        }
    }

    // DELETING AN ALBUM DELETES THE GROUPING, and the confirm says so in v0's one
    // sentence; Photos stay in the library.
    val confirm = collections.delete_confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            cancelLabel = collections.keep_label,
            onConfirm = { onEvent(PhotosHomeEvent(album_delete_confirmed = centraid.core.v1.PhotosDeleteConfirmed())) },
            onDismiss = { onEvent(PhotosHomeEvent(album_delete_dismissed = centraid.core.v1.PhotosDeleteDismissed())) },
        )
    }
    if (state.sheet == PhotosHomeState.Sheet.SHEET_NEW_ALBUM) {
        // A WRITE WAS REFUSED, AND THE SENTENCE A MEMBER READS — beside the name the
        // member typed, never in place of the list.
        NameSheet(
            title = chrome.new_album_label,
            fieldLabel = collections.new_album_placeholder,
            name = collections.new_album_name,
            onName = { onEvent(PhotosHomeEvent(new_album_name = it)) },
            canSubmit = collections.new_album_can_submit,
            primaryLabel = collections.create_label,
            status = state.status?.sentence.orEmpty(),
            onDismiss = {
                onEvent(PhotosHomeEvent(sheet = PhotosHomeEvent.SheetEvent(sheet = PhotosHomeState.Sheet.SHEET_NONE)))
            },
            onSave = { onEvent(PhotosHomeEvent(new_album_submitted = PhotosNewAlbumSubmitted())) },
        )
    }
}

@Composable
private fun SectionBody(
    section: PhotosCollectionsSection,
    onEvent: (PhotosHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    val empty = section.empty
    when (section.key) {
        "pinned" -> Strip { section.cards.forEach { PinnedCard(it, onOpen) } }
        "albums" ->
            if (empty != null) {
                EmptySectionCard(
                    iconKey = "album",
                    title = empty.headline,
                    caption = empty.body,
                    verb = empty.action_label,
                    onVerb = {
                        onEvent(PhotosHomeEvent(sheet = PhotosHomeEvent.SheetEvent(sheet = PhotosHomeState.Sheet.SHEET_NEW_ALBUM)))
                    },
                )
            } else {
                Strip {
                    section.cards.forEach { card ->
                        AlbumCard(card, onOpen) { onEvent(PhotosHomeEvent(album_delete_asked = card.id)) }
                    }
                }
            }
        "deleted" -> DeletedGroup(section.cards) { id -> onEvent(PhotosHomeEvent(album_restored = id)) }
        else -> UtilitiesGroup(section.cards, onOpen)
    }
}

// --- the measures, and where each came from (iOS's `PhotosCollectionsView`) ---

/** The phone's page margin, emitted beside the tokens. */
private val MARGIN = 18.dp
/** Home's tile radius: one card corner in the product, not one per screen. */
private val CARD_RADIUS = 12.dp
private val CARD_GAP = 12.dp
private val PINNED_SIDE = 110.dp
private val ALBUM_SIDE = 150.dp
private val WIDE_CARD_HEIGHT = 150.dp
private val FOLD_CONTROL = 30.dp

// --- the section, the strip and the controls ---

@Composable
private fun Section(title: String, toggleLabel: String, isFolded: Boolean, onFold: () -> Unit, content: @Composable () -> Unit) {
    val turn by animateFloatAsState(
        targetValue = if (isFolded) -90f else 0f,
        animationSpec = tween(CentraidGeometry.DURATION_ONE),
        label = "fold",
    )
    Column(Modifier.fillMaxWidth().padding(top = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                title,
                style = centraidType("title"),
                color = centraidColor("text"),
                modifier = Modifier.weight(1f).semantics { heading() },
            )
            Box(
                Modifier
                    .size(44.dp)
                    .clickable(onClick = onFold)
                    .semantics {
                        contentDescription = toggleLabel
                        role = Role.Button
                    },
                contentAlignment = Alignment.CenterEnd,
            ) {
                Box(
                    Modifier.size(FOLD_CONTROL).background(centraidColor("bgElev"), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    CentraidIcon(
                        iconKey = "ChevronDown",
                        tint = centraidColor("link"),
                        modifier = Modifier.rotate(turn),
                    )
                }
            }
        }
        if (!isFolded) content()
    }
}

/** A strip that runs to the screen's edges, so a half-shown card says it scrolls. */
@Composable
private fun Strip(content: @Composable () -> Unit) {
    Row(
        Modifier
            .padding(horizontal = 0.dp)
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(CARD_GAP),
    ) { content() }
}

// --- the cards ---

/** A cover, or the soft wash a card without one stands on. */
@Composable
private fun CoverGround(path: String?, iconKey: String, side: Dp) {
    Box(
        Modifier
            .size(side)
            .clip(RoundedCornerShape(CARD_RADIUS))
            .background(Brush.verticalGradient(listOf(centraidColor("bgElev"), centraidColor("lineStrong")))),
        contentAlignment = Alignment.Center,
    ) {
        if (!path.isNullOrEmpty()) {
            ContentImage(path)
        } else {
            CentraidIcon(iconKey = iconKey, tint = centraidColor("textFaint"), size = 28.dp)
        }
    }
}

/** ONE PINNED CARD: a square, the name printed on the picture over a dark wash. */
@Composable
private fun PinnedCard(card: PhotosCollectionCard, onOpen: (Route) -> Unit) {
    Box(
        Modifier
            .size(PINNED_SIDE)
            .clip(RoundedCornerShape(CARD_RADIUS))
            .clickable { card.route?.let(onOpen) }
            .semantics { contentDescription = card.accessibility_label; role = Role.Button },
        contentAlignment = Alignment.BottomStart,
    ) {
        CoverGround(card.cover?.thumbnail_path, card.icon_key, PINNED_SIDE)
        Box(
            Modifier
                .fillMaxSize()
                .background(Brush.verticalGradient(0.5f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.45f))),
        )
        Text(
            card.title,
            style = centraidType("smallStrong"),
            color = Color.White,
            maxLines = 2,
            modifier = Modifier.padding(10.dp),
        )
    }
}

/**
 * ONE ALBUM: the cover, then the name and the count beneath it. A long-press is
 * the system's way to the album's own verbs — here, Delete, which Rust confirms
 * before it writes.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AlbumCard(card: PhotosCollectionCard, onOpen: (Route) -> Unit, onDelete: () -> Unit) {
    Column(
        Modifier
            .width(ALBUM_SIDE)
            .combinedClickable(onClick = { card.route?.let(onOpen) }, onLongClick = onDelete)
            .semantics(mergeDescendants = true) {
                contentDescription = card.accessibility_label
                role = Role.Button
                customActions = listOf(CustomAccessibilityAction(card.delete_label) { onDelete(); true })
            },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        CoverGround(card.cover?.thumbnail_path, "album", ALBUM_SIDE)
        Column {
            Text(card.title, style = centraidType("smallStrong"), color = centraidColor("text"), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(card.count_label, style = centraidType("small"), color = centraidColor("textFaint"))
        }
    }
}

/** An empty section's card: icon and verb across the top, the sentence at the foot. */
@Composable
private fun EmptySectionCard(iconKey: String, title: String, caption: String, verb: String, onVerb: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(min = WIDE_CARD_HEIGHT)
            .clip(RoundedCornerShape(CARD_RADIUS))
            .background(centraidColor("bgElev"))
            .padding(18.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            CentraidIcon(iconKey = iconKey, tint = centraidColor("textFaint"), size = 28.dp)
            Spacer(Modifier.weight(1f))
            KitLink(label = verb, onClick = onVerb)
        }
        Spacer(Modifier.weight(1f).heightIn(min = 12.dp))
        Text(title, style = centraidType("smallStrong"), color = centraidColor("textSoft"))
        Text(caption, style = centraidType("small"), color = centraidColor("textFaint"))
    }
}

/** UTILITIES, as a grouped list: one rounded card, hairlines inset past the icon. */
@Composable
private fun UtilitiesGroup(cards: List<PhotosCollectionCard>, onOpen: (Route) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(CARD_RADIUS))
            .background(centraidColor("bgElev")),
    ) {
        cards.forEachIndexed { index, card ->
            if (index > 0) Hairline()
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clickable { card.route?.let(onOpen) }
                    .semantics(mergeDescendants = true) { contentDescription = card.accessibility_label; role = Role.Button }
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(Modifier.width(26.dp), contentAlignment = Alignment.Center) {
                    CentraidIcon(iconKey = card.icon_key, tint = centraidColor("link"), size = 22.dp)
                }
                Text(card.title, style = centraidType("body"), color = centraidColor("text"), modifier = Modifier.weight(1f))
                if (card.count_label.isNotEmpty()) {
                    Text(card.count_label, style = centraidType("small"), color = centraidColor(if (card.urgent) "accent" else "textFaint"))
                }
                CentraidIcon(iconKey = "ChevronRight", tint = centraidColor("textFaint"))
            }
        }
    }
}

/**
 * THE ALBUMS IN THE TRASH, as the same grouped list: each with the days left
 * before it is purged and a Restore, which brings the album back with its
 * photographs. Nothing else opens them.
 */
@Composable
private fun DeletedGroup(cards: List<PhotosCollectionCard>, onRestore: (String) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(CARD_RADIUS))
            .background(centraidColor("bgElev")),
    ) {
        cards.forEachIndexed { index, card ->
            if (index > 0) Hairline()
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .semantics(mergeDescendants = true) { contentDescription = card.accessibility_label }
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(Modifier.width(26.dp), contentAlignment = Alignment.Center) {
                    CentraidIcon(iconKey = card.icon_key, tint = centraidColor("textFaint"), size = 22.dp)
                }
                Column(Modifier.weight(1f)) {
                    Text(card.title, style = centraidType("body"), color = centraidColor("text"), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (card.count_label.isNotEmpty()) {
                        Text(card.count_label, style = centraidType("small"), color = centraidColor("textFaint"))
                    }
                }
                KitLink(label = card.restore_label, onClick = { onRestore(card.id) })
            }
        }
    }
}

@Composable
private fun Hairline() {
    Box(
        Modifier
            .padding(start = 50.dp)
            .fillMaxWidth()
            .heightIn(min = CentraidGeometry.HAIRLINE.dp)
            .background(centraidColor("line")),
    )
}
