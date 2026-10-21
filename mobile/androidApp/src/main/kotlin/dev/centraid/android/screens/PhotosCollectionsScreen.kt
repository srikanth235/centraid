package dev.centraid.android.screens

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
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
import dev.centraid.android.kit.RowSkeleton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import centraid.screen.v1.CollectionsDoor
import centraid.screen.v1.Confirm
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosCollectionsEvent
import centraid.screen.v1.PhotosCollectionsState
import centraid.screen.v1.ShelfRow
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.design.copy.PhotosCopy
import dev.centraid.shared.kit.CappedCount

/**
 * COLLECTIONS (#1029, the photos port).
 *
 * The hub: every surface this miniapp has that is not the library or search is
 * reached from here.
 *
 * **LAID OUT AS THE SYSTEM PHOTOS APP LAYS OUT ITS COLLECTIONS TAB** (iOS 26):
 * titled, foldable sections — Pinned as a strip of
 * square covers with the name on the picture, Albums as covers with the name
 * and count beneath, and Utilities as a grouped list. Which section a
 * row lands in is read off what the row already is (`member_owned`, the
 * standing shelf's mode, the door's kind); a row this file does not recognise
 * goes to Pinned rather than nowhere.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotosCollectionsView.swift`,
 * which carries the full argument and the measures; the two are kept in step
 * by hand.
 */
@Composable
public fun PhotosCollectionsScreen(
    state: PhotosCollectionsState,
    onEvent: (PhotosCollectionsEvent) -> Unit,
    /**
     * A shelf was tapped — the parameter for `photos.shelf`, whole.
     *
     * A CALLBACK AND NOT AN EVENT, for the reason nothing in this file routes:
     * where a tap goes is the navigator's business, and a reducer that pushed a
     * destination would be a reducer holding the back stack. Defaulted so a
     * preview and a fixture render this screen without one.
     */
    onOpenShelf: (PhotoShelf) -> Unit = {},
    onOpenDoor: (CollectionsDoor.Kind) -> Unit = {},
    /**
     * The bulk fold's two words, from the grid's chrome. The fold itself is
     * where the member's eye is and stays this screen's; the words do not.
     */
    showAllLabel: String = "",
    collapseAllLabel: String = "",
) {
    // WHICH SECTIONS ARE FOLDED — where the member's eye is, like a scroll
    // offset, and not a fact about the vault. Nothing reads it back.
    var folded by remember { mutableStateOf(setOf<String>()) }
    // The album a member asked to delete, while the confirm is up.
    var deleting by remember { mutableStateOf<ShelfRow?>(null) }
    val openNewAlbum = {
        onEvent(
            PhotosCollectionsEvent(
                sheet = PhotosCollectionsEvent.SheetChanged(PhotosCollectionsState.Sheet.SHEET_NEW_ALBUM),
            ),
        )
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = MARGIN)
            .padding(bottom = 24.dp),
    ) {
        // THE HEADER IS THE ROOM'S (R-CHROME-1): "Photos" and New album's
        // `Plus` are drawn by `AppPlace` in `PhotosRoutes`, so this body
        // starts at its content. SHOW ALL / COLLAPSE ALL is one link here —
        // v0's Collections menu (`photos-collections-menu.ts`) without the
        // menu: a bulk fold is a command over this list, not a header verb,
        // and the room's one trailing slot is New album's.
        if (state.data_ != null && showAllLabel.isNotEmpty()) {
            val everyFolded = folded.containsAll(SECTION_KEYS)
            Row(Modifier.fillMaxWidth().padding(top = 4.dp)) {
                Spacer(Modifier.weight(1f))
                KitLink(
                    label = if (everyFolded) showAllLabel else collapseAllLabel,
                    onClick = { folded = if (everyFolded) emptySet() else SECTION_KEYS },
                )
            }
        }

        if (state.sheet == PhotosCollectionsState.Sheet.SHEET_NEW_ALBUM) {
            // A WRITE WAS REFUSED, AND THE SENTENCE A MEMBER READS — off
            // `write_failure`, never the read's `failure`, which would replace
            // the whole screen with an error.
            NewAlbumSheet(onEvent, state.write_failure?.sentence)
        }

        // A WIRE PROPERTY IS CROSS-MODULE PUBLIC API, so Kotlin will not
        // smart-cast it after a null check. Each arm is bound to a local first.
        val loading = state.loading
        val failure = state.failure
        val data = state.data_
        when {
            loading != null -> RowSkeleton()

            failure != null -> ScreenFailure(failure.sentence, failure.remedy)

            data != null -> {
                val layout = CollectionsLayout(data.shelves, data.doors)
                val toggle = { key: String -> folded = if (key in folded) folded - key else folded + key }
                if (layout.pinned.isNotEmpty()) {
                    Section(PhotosCopy.PHOTOS_PINNED, "pinned" in folded, { toggle("pinned") }) {
                        Strip {
                            layout.pinned.forEach { item -> PinnedCard(item, onOpenShelf, onOpenDoor) }
                        }
                    }
                }
                Section(PhotosCopy.PHOTOS_ALBUMS, "albums" in folded, { toggle("albums") }) {
                    if (layout.albums.isEmpty()) {
                        EmptySectionCard(
                            iconKey = "album",
                            title = PhotosCopy.PHOTOS_COLLECTIONS_NO_ALBUMS,
                            caption = PhotosCopy.PHOTOS_COLLECTIONS_NO_ALBUMS_CAPTION,
                            verb = PhotosCopy.PHOTOS_CREATE,
                            onVerb = openNewAlbum,
                        )
                    } else {
                        Strip { layout.albums.forEach { row -> AlbumCard(row, onOpenShelf) { deleting = row } } }
                    }
                }
                if (layout.utilities.isNotEmpty()) {
                    Section(PhotosCopy.PHOTOS_UTILITIES, "utilities" in folded, { toggle("utilities") }) {
                        UtilitiesGroup(layout.utilities, onOpenShelf, onOpenDoor)
                    }
                }
            }
        }
    }

    // DELETING AN ALBUM DELETES THE GROUPING, and the confirm says so in v0's
    // one sentence. The reducer's `album_deleted` arm was wired and nothing
    // sent it.
    val pending = deleting
    val pendingAlbum = pending?.shelf?.album
    if (pending != null && pendingAlbum != null) {
        ConfirmSheet(
            confirm = Confirm(
                title = PhotosCopy.PHOTOS_DELETE_ALBUM_TITLE,
                body = PhotosCopy.PHOTOS_DELETE_ALBUM_BODY,
                confirm_label = PhotosCopy.PHOTOS_DELETE_ALBUM,
                destructive = true,
            ),
            cancelLabel = PhotosCopy.PHOTOS_KEEP_IT,
            onConfirm = {
                deleting = null
                onEvent(
                    PhotosCollectionsEvent(
                        album_deleted = PhotosCollectionsEvent.AlbumDeleted(
                            collection_id = pendingAlbum.collection_id,
                        ),
                    ),
                )
            },
            onDismiss = { deleting = null },
        )
    }
}

/** Every section's fold key — what "Collapse all" folds. */
private val SECTION_KEYS: Set<String> = setOf("pinned", "albums", "utilities")

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

// --- which row goes in which section ---

/** A shelf or a door, which is all a card on this screen can be. */
private sealed interface CollectionsItem {
    data class Shelf(val row: ShelfRow) : CollectionsItem
    data class Door(val door: CollectionsDoor) : CollectionsItem
}

/**
 * The rows, sorted into the system's sections: Pinned holds Favorites, Videos
 * and Places (in the slot the system gives its Map); Utilities holds
 * Duplicates, Archive and Trash; members' own albums are Albums.
 */
private class CollectionsLayout(shelves: List<ShelfRow>, doors: List<CollectionsDoor>) {
    val pinned = mutableListOf<CollectionsItem>()
    val albums = mutableListOf<ShelfRow>()
    val utilities = mutableListOf<CollectionsItem>()

    init {
        var places: CollectionsDoor? = null
        var duplicates: CollectionsDoor? = null
        doors.forEach { door ->
            when (door.kind) {
                CollectionsDoor.Kind.KIND_PLACES -> places = door
                CollectionsDoor.Kind.KIND_DUPLICATES -> duplicates = door
                CollectionsDoor.Kind.KIND_UNSPECIFIED -> Unit
            }
        }
        val housekeeping = mutableListOf<CollectionsItem>()
        shelves.forEach { row ->
            val mode = row.shelf?.state_view?.mode?.kind
            when {
                row.member_owned -> albums += row
                mode == PhotoStateView.Mode.Kind.KIND_ARCHIVE ||
                    mode == PhotoStateView.Mode.Kind.KIND_TRASH -> housekeeping += CollectionsItem.Shelf(row)
                else -> pinned += CollectionsItem.Shelf(row)
            }
        }
        places?.let { pinned.add(minOf(2, pinned.size), CollectionsItem.Door(it)) }
        duplicates?.let { utilities += CollectionsItem.Door(it) }
        utilities += housekeeping
    }
}

// --- the counts, spelled once ---

/** A capped count says `N+`; zero on a SHELF is "Empty", a real count. */
private fun shelfCount(row: ShelfRow): Pair<String, String> =
    if (row.item_count == 0 && !row.item_count_capped) {
        PhotosCopy.PHOTOS_COUNT_EMPTY to PhotosCopy.PHOTOS_COUNT_EMPTY
    } else {
        bareCount(row.item_count.toLong(), row.item_count_capped)
    }

/** A count with no noun: `12+` drawn, `at least 12` spoken. */
private fun bareCount(count: Long, capped: Boolean): Pair<String, String> =
    CappedCount.shown(count, capped, "", "") to CappedCount.spoken(count, capped, "", "")

/**
 * A door's count, or nothing: zero on a DOOR means nothing is known yet.
 * `needs_attention` outranks the count.
 */
private fun doorCount(door: CollectionsDoor): Triple<String, String, Boolean>? = when {
    door.needs_attention > 0 -> PhotosCopy.PHOTOS_WAITING.replace("{count}", "${door.needs_attention}").let { Triple(it, it, true) }
    door.count == 0 -> null
    else -> bareCount(door.count.toLong(), door.count_capped).let { Triple(it.first, it.second, false) }
}

/** An album with no name is still a card, and says so. */
private fun shelfTitle(row: ShelfRow): String = row.title.ifEmpty { PhotosCopy.PHOTOS_UNTITLED_ALBUM }

// --- the section, the strip and the controls ---

@Composable
private fun Section(title: String, isFolded: Boolean, onFold: () -> Unit, content: @Composable () -> Unit) {
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
                        contentDescription = (if (isFolded) PhotosCopy.PHOTOS_SECTION_SHOW else PhotosCopy.PHOTOS_SECTION_HIDE).replace("{title}", title)
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
private fun PinnedCard(
    item: CollectionsItem,
    onOpenShelf: (PhotoShelf) -> Unit,
    onOpenDoor: (CollectionsDoor.Kind) -> Unit,
) {
    val (title, cover, iconKey, spoken) = when (item) {
        is CollectionsItem.Shelf -> {
            val t = shelfTitle(item.row)
            listOf(t, item.row.cover_thumbnail_path, iconKeyOf(item.row.shelf ?: PhotoShelf()), "$t, ${shelfCount(item.row).second}")
        }
        is CollectionsItem.Door -> {
            val t = doorTitle(item.door.kind)
            listOf(t, null, iconKeyOf(item.door.kind), doorCount(item.door)?.let { "$t, ${it.second}" } ?: t)
        }
    }
    Box(
        Modifier
            .size(PINNED_SIDE)
            .clip(RoundedCornerShape(CARD_RADIUS))
            .clickable {
                when (item) {
                    is CollectionsItem.Shelf -> item.row.shelf?.let(onOpenShelf)
                    is CollectionsItem.Door -> onOpenDoor(item.door.kind)
                }
            }
            .semantics { contentDescription = spoken ?: ""; role = Role.Button },
        contentAlignment = Alignment.BottomStart,
    ) {
        CoverGround(cover, iconKey ?: "album", PINNED_SIDE)
        Box(
            Modifier
                .fillMaxSize()
                .background(Brush.verticalGradient(0.5f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.45f))),
        )
        Text(
            title ?: "",
            style = centraidType("smallStrong"),
            color = Color.White,
            maxLines = 2,
            modifier = Modifier.padding(10.dp),
        )
    }
}

/**
 * ONE ALBUM: the cover, then the name and the count beneath it. A long-press is
 * the system's way to the album's own verbs — here, Delete, which the parent
 * confirms before it sends.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AlbumCard(row: ShelfRow, onOpen: (PhotoShelf) -> Unit, onDelete: () -> Unit) {
    val title = shelfTitle(row)
    val (shown, spoken) = shelfCount(row)
    Column(
        Modifier
            .width(ALBUM_SIDE)
            .combinedClickable(onClick = { row.shelf?.let(onOpen) }, onLongClick = onDelete)
            .semantics(mergeDescendants = true) {
                contentDescription = "$title, $spoken"
                role = Role.Button
                customActions = listOf(CustomAccessibilityAction(PhotosCopy.PHOTOS_DELETE_ALBUM) { onDelete(); true })
            },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        CoverGround(row.cover_thumbnail_path, "album", ALBUM_SIDE)
        Column {
            Text(title, style = centraidType("smallStrong"), color = centraidColor("text"), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(shown, style = centraidType("small"), color = centraidColor("textFaint"))
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
private fun UtilitiesGroup(
    items: List<CollectionsItem>,
    onOpenShelf: (PhotoShelf) -> Unit,
    onOpenDoor: (CollectionsDoor.Kind) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(CARD_RADIUS))
            .background(centraidColor("bgElev")),
    ) {
        items.forEachIndexed { index, item ->
            if (index > 0) {
                Box(
                    Modifier
                        .padding(start = 50.dp)
                        .fillMaxWidth()
                        .heightIn(min = CentraidGeometry.HAIRLINE.dp)
                        .background(centraidColor("line")),
                )
            }
            val title: String
            val iconKey: String
            val count: String?
            val spoken: String
            val urgent: Boolean
            when (item) {
                is CollectionsItem.Shelf -> {
                    title = shelfTitle(item.row)
                    iconKey = iconKeyOf(item.row.shelf ?: PhotoShelf())
                    val c = shelfCount(item.row)
                    count = c.first
                    spoken = "$title, ${c.second}"
                    urgent = false
                }
                is CollectionsItem.Door -> {
                    title = doorTitle(item.door.kind)
                    iconKey = iconKeyOf(item.door.kind)
                    val c = doorCount(item.door)
                    count = c?.first
                    spoken = c?.let { "$title, ${it.second}" } ?: title
                    urgent = c?.third ?: false
                }
            }
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clickable {
                        when (item) {
                            is CollectionsItem.Shelf -> item.row.shelf?.let(onOpenShelf)
                            is CollectionsItem.Door -> onOpenDoor(item.door.kind)
                        }
                    }
                    .semantics(mergeDescendants = true) { contentDescription = spoken; role = Role.Button }
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(Modifier.width(26.dp), contentAlignment = Alignment.Center) {
                    CentraidIcon(iconKey = iconKey, tint = centraidColor("link"), size = 22.dp)
                }
                Text(title, style = centraidType("body"), color = centraidColor("text"), modifier = Modifier.weight(1f))
                if (count != null) {
                    Text(count, style = centraidType("small"), color = centraidColor(if (urgent) "accent" else "textFaint"))
                }
                CentraidIcon(iconKey = "ChevronRight", tint = centraidColor("textFaint"))
            }
        }
    }
}

/**
 * ONE FIELD AND A VERB.
 *
 * It does NOT close itself when Create is pressed: the reducer closes it when
 * the write commits, so a refused create leaves the member's typed name on the
 * screen, the album visibly not made, and the refusal's sentence beside it.
 * Closing on the press would be the shell claiming an album exists because a
 * button was tapped — and would leave the sentence nowhere to be read.
 *
 * A `SheetRoom` the state opens: the state says which sheet is open and the
 * screen draws it, so there is no second place the answer lives.
 */
@Composable
private fun NewAlbumSheet(onEvent: (PhotosCollectionsEvent) -> Unit, failure: String?) {
    var name by remember { mutableStateOf("") }
    NameSheet(
        title = PhotosCopy.PHOTOS_NEW_ALBUM,
        fieldLabel = PhotosCopy.PHOTOS_ALBUM_NAME,
        name = name,
        onName = { name = it },
        primaryLabel = PhotosCopy.PHOTOS_CREATE,
        // BESIDE THE FIELD AND NEVER INSTEAD OF IT: the member's typed name is
        // the only copy of it, and a sheet that swapped it for an error would
        // have thrown that away.
        status = failure.orEmpty(),
        onDismiss = {
            onEvent(
                PhotosCollectionsEvent(
                    sheet = PhotosCollectionsEvent.SheetChanged(
                        PhotosCollectionsState.Sheet.SHEET_NONE,
                    ),
                ),
            )
        },
        // AN EMPTY NAME IS NOT A WRITE. `media.create_album`'s schema has
        // `"title": { "minLength": 1 }`, so the vault would refuse it — and
        // `NameSheet` does not offer the verb while the name is blank.
        onSave = {
            onEvent(
                PhotosCollectionsEvent(
                    album_created = PhotosCollectionsEvent.AlbumCreated(name = name),
                ),
            )
        },
    )
}

/**
 * THE CATALOG'S KEYS AND NOTHING ELSE.
 *
 * `CentraidIcon` looks the key up in `CentraidCatalog.icons` and falls back to
 * an empty list, so a key that does not exist draws NOTHING — silently, which
 * is the failure that once made the band's More tab render as a dash. Every key
 * below is in the emitted catalog, and Material's icon set is deliberately not
 * used: a second set is a second product.
 */
private fun iconKeyOf(shelf: PhotoShelf): String {
    val album = shelf.album
    if (album != null) return "album"
    if (shelf.place != null) return "place"
    val view = shelf.state_view
    return when (view?.mode?.kind) {
        PhotoStateView.Mode.Kind.KIND_FAVORITES -> "heart"
        PhotoStateView.Mode.Kind.KIND_ARCHIVE -> "Archive"
        PhotoStateView.Mode.Kind.KIND_TRASH -> "trash"
        PhotoStateView.Mode.Kind.KIND_VIDEOS -> "Video"
        else -> "album"
    }
}

private fun iconKeyOf(kind: CollectionsDoor.Kind): String = when (kind) {
    CollectionsDoor.Kind.KIND_PLACES -> "place"
    CollectionsDoor.Kind.KIND_DUPLICATES -> "dupe"
    CollectionsDoor.Kind.KIND_UNSPECIFIED -> "album"
}

/**
 * A DOOR'S NAME IS COPY AND RIDES THE SHELL, not the wire.
 *
 * `CollectionsDoor` carries a `kind` and no title, deliberately: the three are
 * fixed and a string on the row would be three strings to keep in step with
 * SwiftUI's three. The kind is the fact; this is the word.
 */
private fun doorTitle(kind: CollectionsDoor.Kind): String = when (kind) {
    CollectionsDoor.Kind.KIND_PLACES -> PhotosCopy.PHOTOS_PLACES
    CollectionsDoor.Kind.KIND_DUPLICATES -> PhotosCopy.PHOTOS_DUPLICATES
    CollectionsDoor.Kind.KIND_UNSPECIFIED -> ""
}
