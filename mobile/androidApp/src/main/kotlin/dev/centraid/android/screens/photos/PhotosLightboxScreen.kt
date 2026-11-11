package dev.centraid.android.screens.photos

import android.content.Context
import android.view.accessibility.AccessibilityManager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.ui.platform.testTag
import androidx.compose.material3.TextFieldDefaults
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitCard
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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.BottomSheetScaffold
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SheetValue
import androidx.compose.material3.rememberBottomSheetScaffoldState
import androidx.compose.material3.rememberStandardBottomSheetState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.heightIn
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
import dev.centraid.android.kit.EarlierEntryCard
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.PhotosAlbumChoiceSheet
import dev.centraid.android.kit.ReadStateView
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
    val photo = state.photo
    val screenReader = rememberScreenReader(context)
    val reduceMotion = rememberReducedMotion()

    // THE PLAYERS ARE THE SCREEN'S, so the stage draws their surfaces and the
    // chrome draws their transport off the same instance.
    val videoPath = photo?.takeIf {
        it.tile?.kind == PhotoTile.Kind.KIND_VIDEO && it.original_embeddable
    }?.original_path?.takeIf { it.isNotEmpty() }
    val player = rememberLightboxPlayer(videoPath, once = false, mediaType = photo?.original_media_type.orEmpty())
    val live = rememberLightboxPlayer(photo?.live_path?.takeIf { it.isNotEmpty() }, once = true)

    // A SCREEN READER PINS THE CHROME OPEN: a control reachable only by an
    // unlabelled full-screen tap is not reachable at all under TalkBack.
    val chromeVisible = state.chrome_visible || screenReader || state.slideshow

    if (!state.slideshow) {
        // THE VIEWER IS A LIGHT PAGE (#1173): the photograph in a band, the cards under it.
        LightViewer(state, photo, words, player, live, reduceMotion, onEvent, onOpen, onClose)
        return
    }
    Box(
        modifier = Modifier
            .fillMaxSize()
            // THE SLIDESHOW IS A MODE, AND A MODE IS THE STAGE: its own ground, the same value in
            // both schemes.
            .background(centraidColor("stage")),
    ) {
        // THE SHARED PAGE VIEW, in its stage variant: the gate, the failure and the note are drawn
        // by it in the dark scheme; the stage draws what it has.
        ReadStateView(
            page = state.page!!,
            onRetry = { onEvent(PhotosLightboxEvent(refreshed = PhotosLightboxEvent.Refreshed())) },
            stage = true,
            skeleton = {
                // BEFORE THE READ LANDS THE STAGE STILL DRAWS what it has — the
                // strip frame of the photograph a member swiped to — and the
                // opening words only over a stage with nothing at all (never a ring).
                Box(Modifier.fillMaxSize()) {
                    LightboxStage(state, reduceMotion, player, live, onEvent, onClose)
                    if (state.film.none { it.photo_id == state.photo_id && it.tile != null }) {
                        Text(
                            text = words.opening,
                            color = centraidColor("onStageSoft"),
                            style = centraidType("small"),
                            modifier = Modifier.align(Alignment.Center),
                        )
                    }
                }
            },
        ) {
            if (photo != null) {
                Box(Modifier.fillMaxSize()) {
                    LightboxStage(state, reduceMotion, player, live, onEvent, onClose)
                    if (drawnPath(photo) == null) {
                        // NEVER A BROKEN IMAGE. Each of these is a truthful state.
                        Text(
                            text = photo.stage_label,
                            color = centraidColor("onStage"),
                            textAlign = TextAlign.Center,
                            style = centraidType("body"),
                            modifier = Modifier.align(Alignment.Center).padding(KitGeometry.GUTTER),
                        )
                    }
                    if (chromeVisible) Chrome(state, photo, words, player, live, onEvent, onOpen, onClose)
                }
            }
        }
        Sheets(state, photo, onEvent)
    }
}

/**
 * THE VIEWER, a light page (#1173, the Photo viewer board): the way out, the stamp and the menu
 * across the top; the photograph in a band of its own, with every gesture it had; then the cards
 * that say what the vault knows about it; and the floating bar of verbs.
 */
@Composable
private fun LightViewer(
    state: PhotosLightboxState,
    photo: PhotosLightboxPhoto?,
    words: PhotosLightboxWords,
    player: LightboxPlayer?,
    live: LightboxPlayer?,
    reduceMotion: Boolean,
    onEvent: (PhotosLightboxEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onClose: () -> Unit,
) {
    val infoOpen = state.sheet == PhotosLightboxState.Sheet.SHEET_INFO
    Column(Modifier.fillMaxSize().background(Surface.page).statusBarsPadding().navigationBarsPadding()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Chip(icon = "ChevronLeft", label = words.close, onClick = onClose, light = true)
            Column(
                modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (photo != null && photo.stamp_date.isNotEmpty()) KitText(photo.stamp_date, KitType.Row, Surface.ink, maxLines = 1)
                if (photo != null && photo.stamp_line.isNotEmpty()) KitText(photo.stamp_line, KitType.Meta, Surface.meta, maxLines = 1)
            }
            MoreMenu(state.menu, words.more, onEvent)
        }
        val stage: @Composable () -> Unit = {
            DetailsSheetHost(
                open = infoOpen,
                onOpenChanged = { open -> onEvent(sheetEvent(if (open) PhotosLightboxState.Sheet.SHEET_INFO else PhotosLightboxState.Sheet.SHEET_NONE)) },
                modifier = Modifier.fillMaxSize(),
                details = {
                    if (photo != null) {
                        InfoCards(state, photo, words, onEvent, onOpen)
                        // EVERY RECORD KEEPS ITS EARLIER VALUES (#1185): the foot of the details.
                        EarlierEntryCard(photo.earlier, onOpen)
                        dev.centraid.android.kit.OriginLineView(photo.origin)
                    }
                },
            ) {
                // THE PHOTOGRAPH ON THE LIGHT PAGE, no black letterbox, with what plays or loads over its foot.
                Box(Modifier.fillMaxSize()) {

                        LightboxStage(state, reduceMotion, player, live, onEvent, onClose)
                        if (photo != null && drawnPath(photo) == null) {
                            // NEVER A BROKEN IMAGE. Each of these is a truthful state.
                            Text(
                                text = photo.stage_label,
                                color = centraidColor("onStage"),
                                textAlign = TextAlign.Center,
                                style = centraidType("body"),
                                modifier = Modifier.align(Alignment.Center).padding(KitGeometry.GUTTER),
                            )
                        } else if (photo == null && state.film.none { it.photo_id == state.photo_id && it.tile != null }) {
                            Text(
                                text = words.opening,
                                color = centraidColor("onStageSoft"),
                                style = centraidType("small"),
                                modifier = Modifier.align(Alignment.Center),
                            )
                        }
                        if (photo != null) {
                            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(bottom = 4.dp)) {
                                if (live != null) Box(Modifier.align(Alignment.CenterHorizontally)) { LiveChip(live, words) }
                                val line = if (player != null) photo.status_line_playing else photo.status_line
                                if (line.isNotEmpty() || photo.offers_fetch || photo.fetching) {
                                    Row(
                                        modifier = Modifier.fillMaxWidth().padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
                                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        if (photo.fetching) StageSpinner()
                                        if (line.isNotEmpty()) Text(text = line, color = centraidColor("onStageSoft"), style = centraidType("small"))
                                        if (photo.offers_fetch) {
                                            StageVerb(
                                                label = words.load_original,
                                                onClick = { onEvent(PhotosLightboxEvent(fetch_original = PhotosLightboxEvent.FetchTapped())) },
                                            )
                                        }
                                    }
                                }
                                if (player != null) LightboxTransport(player, words)
                            }
                        }
                                    }
            }
        }
        // A FIRST READ DRAWS THE STAGE ALONE (the photograph's frame is already known from the
        // film); a failed or refused one draws the shared failure or gate; a failed re-read keeps
        // the photograph under the one-sentence note.
        ReadStateView(
            page = state.page!!,
            onRetry = { onEvent(PhotosLightboxEvent(refreshed = PhotosLightboxEvent.Refreshed())) },
            modifier = Modifier.weight(1f),
            skeleton = stage,
            data = stage,
        )
        // THE BAR IS THE PAGE'S LAST ROW: the photograph and the details are laid out above it, so
        // it never covers the Place card's links.
        if (photo != null) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp)
                    .padding(bottom = 8.dp),
            ) {
                state.status?.takeIf { it.sentence.isNotEmpty() && !it.refused }?.let {
                    Row(Modifier.fillMaxWidth().padding(bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        KitText(it.sentence, KitType.Meta, Surface.meta, Modifier.weight(1f).testTag("photos.lightbox.status"))
                        if (it.action_label.isNotEmpty()) {
                            KitText(
                                it.action_label,
                                KitType.Meta,
                                Surface.ink,
                                Modifier
                                    .clickable { onEvent(PhotosLightboxEvent(status_acted = PhotosLightboxEvent.StatusActed())) }
                                    .padding(start = 8.dp)
                                    .testTag("photos-lightbox-status-action"),
                            )
                        }
                    }
                }
                Box(Modifier.clip(CircleShape).background(Surface.card)) {
                    Toolbar(state, words, photo.trashed, onEvent, onOpen, Surface.meta, light = true)
                }
            }
        }
        Sheets(state, photo, onEvent)
    }
}

/**
 * THE DETAILS UNDER THE PHOTOGRAPH, as an M3 bottom sheet (#1173): closed, the photograph has the whole
 * page; open (the (i) key, a swipe up, or a drag of the sheet), the sheet rises from the foot and the
 * photograph shrinks up to the room that is left above it. A drag down, (i) or Back closes it. Rust's
 * `sheet` is the one truth: the sheet's own settling is reported back as the event.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DetailsSheetHost(
    open: Boolean,
    onOpenChanged: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    details: @Composable () -> Unit,
    photo: @Composable () -> Unit,
) {
    val sheetState = rememberStandardBottomSheetState(initialValue = SheetValue.PartiallyExpanded, skipHiddenState = true)
    val scaffold = rememberBottomSheetScaffoldState(sheetState)
    val reported by rememberUpdatedState(onOpenChanged)
    LaunchedEffect(open) {
        if (open && sheetState.currentValue != SheetValue.Expanded) sheetState.expand()
        if (!open && sheetState.currentValue != SheetValue.PartiallyExpanded) sheetState.partialExpand()
    }
    LaunchedEffect(sheetState) {
        snapshotFlow { sheetState.currentValue }.collect { value ->
            val nowOpen = value == SheetValue.Expanded
            if (nowOpen != open) reported(nowOpen)
        }
    }
    val density = LocalDensity.current
    val maxSheet = (LocalConfiguration.current.screenHeightDp * 0.62f).dp
    var container by remember { mutableIntStateOf(0) }
    BottomSheetScaffold(
        scaffoldState = scaffold,
        sheetPeekHeight = 0.dp,
        sheetContainerColor = Surface.sheet,
        sheetContent = {
            Column(Modifier.heightIn(max = maxSheet).verticalScroll(rememberScrollState())) {
                details()
                Spacer(Modifier.height(16.dp))
            }
        },
        containerColor = Surface.page,
        modifier = modifier.onSizeChanged { container = it.height },
    ) {
        // THE PHOTOGRAPH SHRINKS UP: it keeps the room above the sheet's top edge.
        val covered = if (container > 0) {
            val offset = runCatching { sheetState.requireOffset() }.getOrDefault(container.toFloat())
            with(density) { (container - offset).coerceAtLeast(0f).toDp() }
        } else {
            0.dp
        }
        Box(Modifier.fillMaxSize().padding(bottom = covered)) { photo() }
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
            StageVerb(label = words.slideshow_leave, onClick = {
                onEvent(PhotosLightboxEvent(slideshow_left = PhotosLightboxEvent.SlideshowLeft()))
            })
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
            // ON ITS OWN PLATE, clear of the photograph's pixels beneath it.
            Box(Modifier.fillMaxWidth().padding(bottom = 8.dp), contentAlignment = Alignment.Center) {
                Row(
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(centraidColor("stageSunken"))
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = status.sentence,
                        color = ink,
                        textAlign = TextAlign.Center,
                        style = centraidType("small"),
                    )
                    if (status.action_label.isNotEmpty()) {
                        Text(
                            text = status.action_label,
                            color = ink,
                            style = centraidType("small"),
                            modifier = Modifier
                                .clickable { onEvent(PhotosLightboxEvent(status_acted = PhotosLightboxEvent.StatusActed())) }
                                .padding(start = 12.dp)
                                .testTag("photos-lightbox-status-action"),
                        )
                    }
                }
            }
        }

        if (!state.slideshow) {
            if (player != null) LightboxTransport(player, words)
            LightboxFilmstrip(state, onEvent)
            Toolbar(state, words, photo.trashed, onEvent, onOpen, soft)
        }
    }
}

/**
 * THE "…" KEY IS THE PLATFORM'S OWN MENU, never a sheet (#1173): an M3 [DropdownMenu] of Rust's
 * rows (`menu`). A refusal rides as the row's detail, not as a second phrasing of the same truth.
 */
@Composable
private fun MoreMenu(menu: List<PhotosLightboxVerb>, label: String, onEvent: (PhotosLightboxEvent) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Chip(icon = "more", label = label, light = true) { open = true }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = Surface.card) {
            menu.forEach { verb ->
                DropdownMenuItem(
                    text = {
                        Text(
                            text = if (verb.enabled || verb.why.isEmpty()) verb.label else "${verb.label} \u2014 ${verb.why}",
                            style = centraidType("control"),
                            color = when {
                                !verb.enabled -> Surface.meta
                                verb.destructive -> centraidColor("net")
                                else -> Surface.ink
                            },
                        )
                    },
                    enabled = verb.enabled,
                    onClick = {
                        open = false
                        onEvent(verbEvent(verb))
                    },
                    modifier = Modifier.testTag("photos.lightbox.menu.${verb.icon_key}"),
                )
            }
        }
    }
}

/** One round plate around one control, floating on the photograph. */
@Composable
private fun Chip(icon: String, label: String, light: Boolean = false, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(CentraidGeometry.TARGET_MIN_COARSE.dp)
            .clip(CircleShape)
            .background(if (light) Surface.card else centraidColor("stageSunken"))
            .clickable(onClick = onClick)
            .semantics {
                role = Role.Button
                contentDescription = label
            },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(iconKey = icon, tint = if (light) Surface.ink else centraidColor("onStage"), size = 20.dp)
    }
}

/**
 * THE BOTTOM ROW, and its refusals in words. The enabled/reason table is Rust's
 * ([PhotosLightboxVerb]): no action is enabled without being able to run, and
 * none is disabled without a reason. A refused target is greyed with the
 * stage's own soft ink, never the page's disabled ink.
 *
 * THE POINTER EQUIVALENT FOR SWIPE is the ends of this one row, so the arrows line up with the
 * verbs between them: nothing here is reachable by gesture alone. The ids are Rust's
 * `previous_id` and `next_id`, empty at either end of the shelf. Over a trashed photograph the
 * verbs carry their words, because a restore and a delete-forever are two marks to tell apart.
 */
@Composable
private fun Toolbar(
    state: PhotosLightboxState,
    words: PhotosLightboxWords,
    trashed: Boolean,
    onEvent: (PhotosLightboxEvent) -> Unit,
    onOpen: (Route) -> Unit,
    soft: Color,
    light: Boolean = false,
) {
    val reasons = state.toolbar.filter { !it.enabled && it.why.isNotEmpty() }.map { it.why }.distinct()
    val paged = state.previous_id.isNotEmpty() || state.next_id.isNotEmpty()
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            if (paged) {
                StageKey(
                    iconKey = "ChevronLeft",
                    label = words.previous,
                    onClick = { onEvent(movedEvent(state.previous_id)) },
                    enabled = state.previous_id.isNotEmpty(),
                    light = light,
                )
            }
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
                    on = verb.on,
                    showLabel = trashed,
                    destructive = verb.destructive,
                    light = light,
                    // INFO IS PRESSED WHILE ITS CARDS ARE ON THE PAGE, which is always.
                    modifier = if (light && verb.kind == PhotosLightboxVerb.Kind.KIND_INFO) {
                        Modifier.clip(CircleShape).background(Surface.fill)
                    } else {
                        Modifier
                    },
                )
            }
            if (paged) {
                StageKey(
                    iconKey = "ChevronRight",
                    label = words.next,
                    onClick = { onEvent(movedEvent(state.next_id)) },
                    enabled = state.next_id.isNotEmpty(),
                    light = light,
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

/** The sheets: share, the place picker, the album choice, the delete question. */
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
            // THE CARDS ARE ON THE PAGE, so Info presents nothing.
            PhotosLightboxState.Sheet.SHEET_INFO -> Unit

            PhotosLightboxState.Sheet.SHEET_SHARE -> SheetRoom(title = words.share_title, onDismiss = close) {
                state.share_choices.forEach { choice -> ShareRow(choice, onEvent) }
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
    state.people_picker?.takeIf { it.open_ }?.let { picker ->
        dev.centraid.android.kit.LinkPickerSheet(picker) { link -> onEvent(PhotosLightboxEvent(people = link)) }
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
 * THE CARDS UNDER THE PHOTOGRAPH: everything the vault knows about it, and the four things a
 * member may change: the caption, the labels, the place, and a copy of where it was taken. No
 * destructive control here, ever: Trash lives on the bar alone. A field the record lacks is
 * omitted, never invented. The SwiftUI twin is `PhotosLightboxInfo`.
 */
@Composable
private fun InfoCards(
    state: PhotosLightboxState,
    photo: PhotosLightboxPhoto,
    words: PhotosLightboxWords,
    onEvent: (PhotosLightboxEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    var caption by remember(state.photo_id) { mutableStateOf(photo.caption) }
    var tag by remember(state.photo_id) { mutableStateOf("") }
    val commitCaption = {
        onEvent(PhotosLightboxEvent(caption = PhotosLightboxEvent.CaptionChanged(caption = caption)))
    }
    val fieldColors = TextFieldDefaults.colors(
        focusedContainerColor = Color.Transparent,
        unfocusedContainerColor = Color.Transparent,
    )
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp)
            .padding(top = 14.dp)
            // THE CARDS' NAME is what a screen reader says on entering them.
            .semantics { contentDescription = words.info_title },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // A REFUSED EDIT IS SAID HERE, where the member made it.
        state.status?.takeIf { it.refused && it.sentence.isNotEmpty() }?.let {
            KitText(it.sentence, KitType.Meta, StateColor.Red.text)
        }

        // THE CAPTION, ITS OWN CARD.
        Column(Modifier.fillMaxWidth().kitCard().padding(14.dp)) {
            KitText(words.caption_label, KitType.Meta, Surface.meta)
            TextField(
                value = caption,
                onValueChange = { caption = it },
                placeholder = { Text(words.caption_placeholder) },
                singleLine = true,
                colors = fieldColors,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { commitCaption() }),
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = words.caption_label }
                    // COMMITTED WHEN THE FIELD IS LEFT: the typed text stays exactly
                    // where it is if the vault says no.
                    .onFocusChanged { if (!it.isFocused) commitCaption() },
            )
        }

        // WHEN AND WITH WHAT, one card of rows.
        if (photo.facts.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().kitCard()) {
                photo.facts.forEachIndexed { at, fact ->
                    Row(Modifier.fillMaxWidth().padding(14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        CentraidIcon(
                            iconKey = fact.icon_key,
                            tint = appAccent("photos").text,
                            size = 16.dp,
                            modifier = Modifier.padding(top = 3.dp),
                        )
                        Column(Modifier.weight(1f).semantics(mergeDescendants = true) { }) {
                            KitText(fact.label, KitType.Meta, Surface.meta)
                            KitText(fact.text, KitType.Row, Surface.ink)
                        }
                    }
                    if (at < photo.facts.size - 1) {
                        Spacer(Modifier.padding(start = 14.dp).fillMaxWidth().height(KitGeometry.HAIRLINE).background(Surface.line))
                    }
                }
            }
        }

        // WHO IS IN IT, by hand: a section of its own (#1173).
        photo.people?.let { people ->
            dev.centraid.android.kit.LinkSectionView(
                people,
                { link -> onEvent(PhotosLightboxEvent(people = link)) },
                onOpen,
                padded = false,
            )
        }

        // PLACE AND LABELS, one card. WHERE, in words, never a coordinate; "Copy exact location"
        // puts it on the member's own clipboard because they asked.
        Column(Modifier.fillMaxWidth().kitCard()) {
            Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                InfoHeading(words.place_title, "MapPin")
                Text(text = photo.place_phrase, style = centraidType("body"), color = centraidColor("text"))
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
            Spacer(Modifier.padding(start = 14.dp).fillMaxWidth().height(KitGeometry.HAIRLINE).background(Surface.line))
            // LABELS, each with its own remove, and a field to add one.
            Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                InfoHeading(words.labels_title, "Tag")
                if (photo.labels_line.isNotEmpty()) {
                    KitText(photo.labels_line, KitType.Meta, Surface.meta)
                }
                photo.labels.forEach { label ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        modifier = Modifier
                            .clip(photosTokenShape("md"))
                            .background(Surface.fill)
                            .padding(start = 10.dp),
                    ) {
                        KitText(label.label, KitType.Meta, Surface.ink)
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
                    colors = fieldColors,
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
        }

        // WHERE THE BYTES ARE, in a sentence that says what fetching costs.
        KitText(photo.whereabouts, KitType.Meta, Surface.meta)
        if (photo.trash_line.isNotEmpty()) {
            KitText(photo.trash_line, KitType.Meta, Surface.meta)
        }
        state.status?.takeIf { !it.refused && it.sentence.isNotEmpty() }?.let {
            KitText(it.sentence, KitType.Meta, Surface.meta)
        }
    }
}

/** A card's heading: the mark, then the word. */
@Composable
private fun InfoHeading(text: String, iconKey: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier.semantics(mergeDescendants = true) { },
    ) {
        CentraidIcon(iconKey = iconKey, tint = appAccent("photos").text, size = 14.dp)
        KitText(text, KitType.Meta, Surface.meta)
    }
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
