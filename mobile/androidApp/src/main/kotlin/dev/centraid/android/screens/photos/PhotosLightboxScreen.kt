package dev.centraid.android.screens.photos

import android.content.Context
import android.view.accessibility.AccessibilityManager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import centraid.core.v1.PhotoTile
import centraid.core.v1.PhotosLightboxEvent
import centraid.core.v1.PhotosLightboxPhoto
import centraid.core.v1.PhotosLightboxShareChoice
import centraid.core.v1.PhotosLightboxState
import centraid.core.v1.PhotosLightboxVerb
import centraid.core.v1.PhotosLightboxWords
import centraid.core.v1.Route
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.PhotosAlbumChoiceSheet
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.StageKey
import dev.centraid.android.kit.StageSpinner
import dev.centraid.android.kit.StageVerb
import dev.centraid.android.kit.rememberReducedMotion
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry

/**
 * ONE PHOTOGRAPH, FULL BLEED (#1135): `photos.lightbox`, drawn. Rust decides
 * every word, every verb and the reason one cannot run; this draws
 * [PhotosLightboxState] and sends [PhotosLightboxEvent]s. The SwiftUI twin is
 * `PhotosLightboxView.swift`.
 *
 * Every verb is live or visibly refused, and the refusal is drawn as text and
 * not only spoken (the toolbar's `why`). A refused write is the state's `status`
 * line, over the photograph and never instead of it.
 */
@Composable
public fun PhotosLightboxScreen(
    state: PhotosLightboxState,
    onEvent: (PhotosLightboxEvent) -> Unit,
    onOpen: (Route) -> Unit,
    /** The stage room's one way out: the swipe down and the close control. */
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val words = state.words ?: PhotosLightboxWords()
    val loading = state.loading
    val failure = state.failure
    val denied = state.denied
    val photo = state.photo
    val screenReader = rememberScreenReader(context)
    val reduceMotion = rememberReducedMotion()

    // THE PLAYERS ARE THE SCREEN'S, so the stage draws their surfaces and the
    // chrome draws their transport off the same instance.
    val videoPath = photo?.takeIf {
        it.tile?.kind == PhotoTile.Kind.KIND_VIDEO && it.original_embeddable
    }?.original_path?.takeIf { it.isNotEmpty() }
    val player = rememberLightboxPlayer(videoPath, once = false)
    val live = rememberLightboxPlayer(photo?.live_path?.takeIf { it.isNotEmpty() }, once = true)

    // A SCREEN READER PINS THE CHROME OPEN: a control reachable only by an
    // unlabelled full-screen tap is not reachable at all under TalkBack.
    val chromeVisible = state.chrome_visible || screenReader || state.slideshow

    Box(
        modifier = Modifier
            .fillMaxSize()
            // THE STAGE IS ITS OWN GROUND, the same value in both schemes.
            .background(centraidColor("stage")),
    ) {
        when {
            // BEFORE THE READ LANDS THE STAGE STILL DRAWS what it has — the
            // strip frame of the photograph a member swiped to — and a ring
            // only over a stage with nothing at all.
            loading != null -> {
                LightboxStage(state, reduceMotion, player, live, onEvent, onClose)
                if (state.film.none { it.photo_id == state.photo_id && it.tile != null }) {
                    StageSpinner(modifier = Modifier.align(Alignment.Center))
                }
            }

            failure != null -> ScreenFailure(
                sentence = failure.sentence,
                remedy = failure.remedy,
                modifier = Modifier.align(Alignment.Center).padding(16.dp),
            )

            denied != null -> ScreenFailure(
                sentence = denied.title,
                remedy = denied.body,
                modifier = Modifier.align(Alignment.Center).padding(16.dp),
            )

            photo != null -> {
                LightboxStage(state, reduceMotion, player, live, onEvent, onClose)
                if (drawnPath(photo) == null) {
                    // NEVER A BROKEN IMAGE. Each of these is a truthful state.
                    Text(
                        text = photo.stage_label,
                        color = centraidColor("onStage"),
                        textAlign = TextAlign.Center,
                        style = centraidType("body"),
                        modifier = Modifier.align(Alignment.Center).padding(16.dp),
                    )
                }
                if (chromeVisible) Chrome(state, photo, words, player, live, onEvent, onOpen, onClose)
            }
        }
        Sheets(state, photo, onEvent)
    }
}

@Composable
private fun Chrome(
    state: PhotosLightboxState,
    photo: PhotosLightboxPhoto,
    words: PhotosLightboxWords,
    player: LightboxPlayer?,
    live: LightboxPlayer?,
    onEvent: (PhotosLightboxEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onClose: () -> Unit,
) {
    val ink = centraidColor("onStage")
    val soft = centraidColor("onStageSoft")
    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 8.dp),
    ) {
        // THREE FLOATING THINGS ACROSS THE TOP: the way out, the stamp, and the
        // menu. The stamp takes the middle because it is the only one that is
        // not a control; WHEN outranks WHAT.
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Top,
        ) {
            Chip(icon = "ChevronLeft", label = words.close, onClick = onClose)
            Column(
                modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                val title = if (state.slideshow) words.slideshow else photo.stamp_date
                val meta = if (state.slideshow) state.slideshow_meta else photo.stamp_line
                if (title.isNotEmpty()) Text(text = title, color = ink, style = centraidType("control"))
                if (meta.isNotEmpty()) Text(text = meta, color = soft, style = centraidType("small"))
            }
            if (state.slideshow) {
                StageVerb(label = words.slideshow_leave, onClick = {
                    onEvent(PhotosLightboxEvent(slideshow_left = PhotosLightboxEvent.SlideshowLeft()))
                })
            } else {
                Chip(icon = "more", label = words.more) {
                    onEvent(sheetEvent(PhotosLightboxState.Sheet.SHEET_MORE))
                }
            }
        }

        Box(modifier = Modifier.weight(1f))

        if (!state.slideshow && live != null) {
            Box(Modifier.padding(bottom = 8.dp)) { LiveChip(live, words) }
        }

        // THE ONE STATUS LINE, drawn only when it has something to say. A receipt
        // or a refusal beats a byte status: it is about something the member did.
        val line = when {
            state.slideshow -> state.slideshow_line
            else -> if (player != null) photo.status_line_playing else photo.status_line
        }
        if (line.isNotEmpty() || (photo.offers_fetch && !state.slideshow) || photo.fetching) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (!state.slideshow && photo.fetching) StageSpinner()
                if (line.isNotEmpty()) Text(text = line, color = soft, style = centraidType("small"))
                if (!state.slideshow && photo.offers_fetch) {
                    StageVerb(
                        label = words.load_original,
                        onClick = { onEvent(PhotosLightboxEvent(fetch_original = PhotosLightboxEvent.FetchTapped())) },
                    )
                }
            }
        }

        // A WRITE THAT WAS REFUSED, OR A RECEIPT, AS A LINE OVER THE CHROME.
        state.status?.takeIf { it.sentence.isNotEmpty() }?.let { status ->
            Text(
                text = status.sentence,
                color = ink,
                textAlign = TextAlign.Center,
                style = centraidType("small"),
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
            )
        }

        if (!state.slideshow) {
            if (player != null) LightboxTransport(player, words)
            LightboxFilmstrip(state, onEvent)
            Pager(state, words, onEvent)
            Toolbar(state, onEvent, onOpen, soft)
        }
    }
}

/** One round plate around one control, floating on the photograph. */
@Composable
private fun Chip(icon: String, label: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(CentraidGeometry.TARGET_MIN_COARSE.dp)
            .clip(CircleShape)
            .background(centraidColor("stageSunken"))
            .clickable(onClick = onClick)
            .semantics {
                role = Role.Button
                contentDescription = label
            },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(iconKey = icon, tint = centraidColor("onStage"), size = 20.dp)
    }
}

/**
 * THE POINTER EQUIVALENT FOR SWIPE: nothing here is reachable by gesture alone,
 * and a phone has no arrow keys. The ids are Rust's `previous_id` and `next_id`,
 * empty at either end of the shelf.
 */
@Composable
private fun Pager(state: PhotosLightboxState, words: PhotosLightboxWords, onEvent: (PhotosLightboxEvent) -> Unit) {
    if (state.previous_id.isEmpty() && state.next_id.isEmpty()) return
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        StageKey(
            iconKey = "ChevronLeft",
            label = words.previous,
            onClick = { onEvent(movedEvent(state.previous_id)) },
            enabled = state.previous_id.isNotEmpty(),
        )
        StageKey(
            iconKey = "ChevronRight",
            label = words.next,
            onClick = { onEvent(movedEvent(state.next_id)) },
            enabled = state.next_id.isNotEmpty(),
        )
    }
}

/**
 * THE BOTTOM ROW, and its refusals in words. The enabled/reason table is Rust's
 * ([PhotosLightboxVerb]): no action is enabled without being able to run, and
 * none is disabled without a reason. A refused target is greyed with the
 * stage's own soft ink, never the page's disabled ink.
 */
@Composable
private fun Toolbar(
    state: PhotosLightboxState,
    onEvent: (PhotosLightboxEvent) -> Unit,
    onOpen: (Route) -> Unit,
    soft: Color,
) {
    val reasons = state.toolbar.filter { !it.enabled && it.why.isNotEmpty() }.map { it.why }.distinct()
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            state.toolbar.forEach { verb ->
                StageKey(
                    iconKey = verb.icon_key,
                    label = verb.label,
                    onClick = {
                        // Edit is a page: the shell pushes the route Rust built.
                        val route = verb.route
                        if (route != null) onOpen(route) else onEvent(verbEvent(verb))
                    },
                    enabled = verb.enabled,
                )
            }
        }
        // THE REFUSAL AS VISIBLE TEXT, not only as a spoken hint.
        reasons.forEach { reason ->
            Text(
                text = reason,
                color = soft,
                textAlign = TextAlign.Center,
                style = centraidType("small"),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** The sheets: info, share, more, the place picker, the album choice, the delete question. */
@Composable
private fun Sheets(
    state: PhotosLightboxState,
    photo: PhotosLightboxPhoto?,
    onEvent: (PhotosLightboxEvent) -> Unit,
) {
    val words = state.words ?: PhotosLightboxWords()
    // A DISMISS HAS TO REACH RUST TOO, or the state would still say INFO with
    // nothing on screen and the next tap on Info would be a no-op.
    val close = { onEvent(sheetEvent(PhotosLightboxState.Sheet.SHEET_NONE)) }
    if (photo != null) {
        when (state.sheet) {
            PhotosLightboxState.Sheet.SHEET_INFO ->
                SheetRoom(title = words.info_title, onDismiss = close) {
                    InfoSheet(state, photo, words, onEvent)
                }

            PhotosLightboxState.Sheet.SHEET_SHARE -> SheetRoom(title = words.share_title, onDismiss = close) {
                state.share_choices.forEach { choice -> ShareRow(choice, onEvent) }
            }

            PhotosLightboxState.Sheet.SHEET_MORE -> SheetRoom(title = "", onDismiss = close) {
                state.menu.forEach { verb ->
                    SheetRow(
                        label = verb.label,
                        onTap = { onEvent(verbEvent(verb)) },
                        iconKey = verb.icon_key,
                        detail = verb.why,
                        destructive = verb.destructive,
                        enabled = verb.enabled,
                    )
                }
            }

            PhotosLightboxState.Sheet.SHEET_PLACE ->
                SheetRoom(title = words.place_picker_title, onDismiss = close) {
                    PlaceSheet(state, words, onEvent)
                }

            PhotosLightboxState.Sheet.SHEET_NONE,
            PhotosLightboxState.Sheet.SHEET_UNSPECIFIED,
            -> Unit
        }
    }
    val album = state.album_choice
    if (album != null && album.open_) {
        PhotosAlbumChoiceSheet(album) { event -> onEvent(PhotosLightboxEvent(album_choice = event)) }
    }
    state.confirm?.let { confirm ->
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(PhotosLightboxEvent(confirmed = PhotosLightboxEvent.Confirmed())) },
            onDismiss = { onEvent(PhotosLightboxEvent(confirm_dismissed = PhotosLightboxEvent.ConfirmDismissed())) },
        )
    }
}

@Composable
private fun ShareRow(choice: PhotosLightboxShareChoice, onEvent: (PhotosLightboxEvent) -> Unit) {
    SheetRow(label = choice.label, detail = choice.detail, onTap = {
        onEvent(PhotosLightboxEvent(share = PhotosLightboxEvent.ShareChosen(precision = choice.precision)))
    })
}

/** "ADJUST LOCATION": the places this vault knows, and "No place". A place is picked, never typed. */
@Composable
private fun PlaceSheet(
    state: PhotosLightboxState,
    words: PhotosLightboxWords,
    onEvent: (PhotosLightboxEvent) -> Unit,
) {
    Column(
        modifier = Modifier.verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        state.status?.takeIf { it.refused && it.sentence.isNotEmpty() }?.let {
            Text(
                text = it.sentence,
                style = centraidType("small"),
                color = centraidColor("net"),
                modifier = Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
            )
        }
        state.place_choices.forEach { place ->
            val label = place.name
            val detail = when {
                place.place_id.isEmpty() -> words.no_place_detail
                place.here -> words.place_here
                else -> ""
            }
            SheetRow(label = label, detail = detail, onTap = {
                if (!place.here) {
                    onEvent(PhotosLightboxEvent(place_chosen = PhotosLightboxEvent.PlaceChosen(place_id = place.place_id)))
                }
            })
        }
        if (state.place_choices.size <= 1) {
            Text(
                text = words.no_places,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
            )
        }
    }
}

/**
 * THE INFO SHEET: everything the vault knows about this photograph, and the four
 * things a member may change: the caption, the labels, the place, and a copy of
 * where it was taken. No destructive control here, ever: Trash lives on the bar
 * alone. A field the record lacks is omitted, never invented.
 */
@Composable
private fun InfoSheet(
    state: PhotosLightboxState,
    photo: PhotosLightboxPhoto,
    words: PhotosLightboxWords,
    onEvent: (PhotosLightboxEvent) -> Unit,
) {
    val soft = centraidColor("textSoft")
    val ink = centraidColor("text")
    var caption by remember(state.photo_id) { mutableStateOf(photo.caption) }
    var tag by remember(state.photo_id) { mutableStateOf("") }
    val commitCaption = {
        onEvent(PhotosLightboxEvent(caption = PhotosLightboxEvent.CaptionChanged(caption = caption)))
    }
    Column(
        modifier = Modifier
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // A REFUSED EDIT IS SAID HERE, where the member made it.
        state.status?.takeIf { it.refused && it.sentence.isNotEmpty() }?.let {
            Text(text = it.sentence, style = centraidType("small"), color = centraidColor("net"))
        }

        InfoLabel(words.caption_label)
        TextField(
            value = caption,
            onValueChange = { caption = it },
            placeholder = { Text(words.caption_placeholder) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { commitCaption() }),
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = words.caption_label }
                // COMMITTED WHEN THE FIELD IS LEFT: the typed text stays exactly
                // where it is if the vault says no.
                .onFocusChanged { if (!it.isFocused) commitCaption() },
        )

        photo.facts.forEach { fact ->
            Column {
                InfoLabel(fact.label)
                Text(text = fact.text, style = centraidType("body"), color = ink)
            }
        }

        // WHERE, in words — never a coordinate. "Copy exact location" puts it on
        // the member's own clipboard because they asked.
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            InfoLabel(words.place_title)
            Text(text = photo.place_phrase, style = centraidType("body"), color = ink)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                KitLink(
                    label = if (photo.has_place) words.change else words.add_place,
                    onClick = { onEvent(sheetEvent(PhotosLightboxState.Sheet.SHEET_PLACE)) },
                )
                if (photo.has_place) {
                    KitLink(label = words.remove, onClick = {
                        onEvent(PhotosLightboxEvent(place_chosen = PhotosLightboxEvent.PlaceChosen(place_id = "")))
                    })
                }
                if (photo.can_copy_location) {
                    KitLink(label = words.copy_location, onClick = {
                        onEvent(PhotosLightboxEvent(copy_location = PhotosLightboxEvent.CopyLocationTapped()))
                    })
                }
            }
        }

        // LABELS, each with its own remove, and a field to add one.
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            InfoLabel(words.labels_title)
            if (photo.labels_line.isNotEmpty()) {
                Text(text = photo.labels_line, style = centraidType("small"), color = soft)
            }
            photo.labels.forEach { label ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier
                        .clip(photosTokenShape("md"))
                        .background(centraidColor("bgSunken"))
                        .padding(start = 10.dp),
                ) {
                    Text(text = label.label, style = centraidType("small"), color = ink)
                    dev.centraid.android.kit.IconKey(
                        iconKey = "X",
                        label = label.remove_label,
                        testTag = "lightbox-tag-remove",
                        bordered = false,
                        onPress = {
                            onEvent(PhotosLightboxEvent(tag_removed = PhotosLightboxEvent.TagRemoved(tag_id = label.tag_id)))
                        },
                    )
                }
            }
            TextField(
                value = tag,
                onValueChange = { tag = it },
                placeholder = { Text(words.add_label_placeholder) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = {
                    if (tag.isNotBlank()) {
                        onEvent(PhotosLightboxEvent(tag_added = PhotosLightboxEvent.TagAdded(label = tag)))
                        tag = ""
                    }
                }),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = words.add_label_placeholder },
            )
        }

        // WHERE THE BYTES ARE, in a sentence that says what fetching costs.
        Text(text = photo.whereabouts, style = centraidType("small"), color = soft)
        if (photo.trash_line.isNotEmpty()) {
            Text(text = photo.trash_line, style = centraidType("small"), color = soft)
        }
        state.status?.takeIf { !it.refused && it.sentence.isNotEmpty() }?.let {
            Text(text = it.sentence, style = centraidType("small"), color = soft)
        }
    }
}

@Composable
private fun InfoLabel(text: String) {
    Text(text = text, style = centraidType("small"), color = centraidColor("textSoft"))
}

/**
 * IS A SCREEN READER RUNNING? Live, so TalkBack switched on mid-session brings
 * the chrome back without asking the member to find a tap target they cannot see.
 */
@Composable
private fun rememberScreenReader(context: Context): Boolean {
    val manager = remember(context) { context.getSystemService(AccessibilityManager::class.java) }
    var on by remember(manager) { mutableStateOf(manager?.isTouchExplorationEnabled == true) }
    DisposableEffect(manager) {
        val listener = AccessibilityManager.TouchExplorationStateChangeListener { on = it }
        manager?.addTouchExplorationStateChangeListener(listener)
        onDispose { manager?.removeTouchExplorationStateChangeListener(listener) }
    }
    return on
}

private fun sheetEvent(sheet: PhotosLightboxState.Sheet): PhotosLightboxEvent =
    PhotosLightboxEvent(sheet = PhotosLightboxEvent.SheetChanged(sheet = sheet))

private fun movedEvent(photoId: String): PhotosLightboxEvent =
    PhotosLightboxEvent(moved = PhotosLightboxEvent.Moved(photo_id = photoId))

private fun verbEvent(verb: PhotosLightboxVerb): PhotosLightboxEvent =
    PhotosLightboxEvent(verb = PhotosLightboxEvent.VerbTapped(kind = verb.kind))

/** What the stage draws for this photograph, or null when it has nothing. */
private fun drawnPath(photo: PhotosLightboxPhoto): String? =
    photo.original_path?.takeIf { it.isNotEmpty() && photo.original_embeddable }
        ?: photo.tile?.thumbnail_path?.takeIf { it.isNotEmpty() }
