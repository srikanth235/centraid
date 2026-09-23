package dev.centraid.android.screens

import android.content.Context
import android.provider.Settings
import android.text.format.DateFormat
import android.view.accessibility.AccessibilityManager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import centraid.screen.v1.AlbumChoiceCreated
import centraid.screen.v1.AlbumChoiceDismissed
import centraid.screen.v1.AlbumChoiceOpened
import centraid.screen.v1.AlbumChosen
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoDetail
import centraid.screen.v1.PhotoLightboxEvent
import centraid.screen.v1.PhotoLightboxState
import dev.centraid.android.kit.AlbumChoiceSheet
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.shared.apps.photos.PhotoLightboxMachine
import dev.centraid.shared.apps.photos.SHARE_PLACE_TITLE
import dev.centraid.shared.apps.photos.sharePlaceOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * ONE PHOTOGRAPH, FULL BLEED (#1029, photos port).
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotoLightboxView.swift`; the two
 * are kept in step by hand, which is what a shared state message and a shared
 * screen id buy — the arrangement is per platform, the meaning is not. The
 * stage and its gestures are `PhotoLightboxStage.kt`; the hand-offs to the OS
 * are `PhotoHandOff.kt`.
 *
 * **EVERY VERB IS LIVE OR VISIBLY REFUSED**, and the refusal is drawn as text
 * rather than only spoken: v0's toolbar rendered all five identically, so four
 * of them looked armed and silently did nothing (#1015 B10). This side reads
 * the table straight off [PhotoLightboxMachine.toolbar], which is the tested
 * statement of it — a Compose screen can call into the shared module and the
 * Swift one cannot, so this is the copy with no second spelling.
 */
@Composable
public fun PhotoLightboxScreen(
    state: PhotoLightboxState,
    onEvent: (PhotoLightboxEvent) -> Unit,
    /**
     * THE STAGE ROOM'S ONE WAY OUT — the swipe down, and the close control in
     * the chrome. The shell's, because leaving is a route change.
     */
    onClose: () -> Unit = {},
) {
    val context = LocalContext.current
    // A WIRE PROPERTY IS CROSS-MODULE PUBLIC API, so Kotlin will not smart-cast
    // it after a null check. Binding each arm's value to a local first is what
    // makes the branches type-check, and it is the shape every screen in this
    // module uses.
    val loading = state.loading
    val failure = state.failure
    val detail = state.detail
    val screenReader = rememberScreenReader(context)
    val reduceMotion = remember(context) { reducedMotion(context) }

    // THE PLAYERS ARE THE SCREEN'S, so the stage draws their surfaces and the
    // chrome draws their transport off the same instance.
    val videoPath = detail?.takeIf {
        it.kind == PhotoCell.Kind.KIND_VIDEO && it.original_embeddable
    }?.original_path?.takeIf { it.isNotEmpty() }
    val player = rememberLightboxPlayer(videoPath, once = false)
    val live = rememberLightboxPlayer(detail?.live_path?.takeIf { it.isNotEmpty() }, once = true)

    // THE SLIDESHOW'S CLOCK. The shell owns the clock and the reducer owns
    // where it goes; keyed on the photograph, so a manual move restarts the
    // count rather than cutting the next photograph short.
    LaunchedEffect(state.slideshow, state.asset_id) {
        if (state.slideshow) {
            player?.pause()
            delay(PhotoLightboxMachine.SLIDESHOW_INTERVAL_MS)
            onEvent(PhotoLightboxEvent(slideshow_advanced = PhotoLightboxEvent.SlideshowAdvanced()))
        }
    }

    // A SCREEN READER PINS THE CHROME OPEN (v0's `use-screen-reader.ts`): a
    // control reachable only by an unlabelled full-screen tap is not reachable
    // at all under TalkBack. The slideshow keeps its chrome too — Leave is the
    // only way out of it.
    val chromeVisible = state.chrome_visible || screenReader || state.slideshow

    Box(
        modifier = Modifier
            .fillMaxSize()
            // THE STAGE IS ITS OWN GROUND, not the page's. A photograph on
            // paper reads as a document. `stage` carries the same value in
            // both schemes, deliberately: a viewer that went pale in daylight
            // would be a second surface for one photograph.
            .background(centraidColor("stage")),
    ) {
        when {
            // BEFORE THE READ LANDS THE STAGE STILL DRAWS what it has — the
            // strip frame of the photograph a member swiped to — and a ring
            // only over a stage with nothing at all.
            loading != null -> {
                LightboxStage(state, reduceMotion, player, live, onEvent, onClose)
                if (state.film.none { it.asset_id == state.asset_id }) {
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                }
            }

            failure != null -> ScreenFailure(
                sentence = failure.sentence,
                remedy = failure.remedy,
                modifier = Modifier.align(Alignment.Center).padding(16.dp),
            )

            detail != null -> {
                LightboxStage(state, reduceMotion, player, live, onEvent, onClose)
                if (lightboxDrawnPath(detail) == null) {
                    // NEVER A BROKEN IMAGE. Each of these is a truthful state,
                    // and the sentence says which one.
                    Text(
                        text = lightboxStageLabel(detail),
                        color = centraidColor("onStage"),
                        textAlign = TextAlign.Center,
                        style = centraidType("body"),
                        modifier = Modifier.align(Alignment.Center).padding(16.dp),
                    )
                }
                if (chromeVisible) Chrome(state, detail, player, live, onEvent, onClose)
            }
        }
        Sheets(state, detail, onEvent)
    }
}

@Composable
private fun Chrome(
    state: PhotoLightboxState,
    detail: PhotoDetail,
    player: LightboxPlayer?,
    live: LightboxPlayer?,
    onEvent: (PhotoLightboxEvent) -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val ink = centraidColor("onStage")
    val soft = centraidColor("onStageSoft")
    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 8.dp),
    ) {
        // THREE FLOATING THINGS ACROSS THE TOP: the way out, the stamp, and
        // the menu. The stamp takes the middle because it is the only one that
        // is not a control; WHEN outranks WHAT.
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Top,
        ) {
            Chip(icon = "ChevronLeft", label = "Close", onClick = onClose)
            Column(
                modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                val title = if (state.slideshow) "Slideshow" else lightboxStampDate(detail)
                val meta = if (state.slideshow) {
                    PhotoLightboxMachine.slideshowMeta(state)
                } else {
                    lightboxStampLine(context, detail)
                }
                if (title.isNotEmpty()) Text(text = title, color = ink, style = centraidType("control"))
                if (meta.isNotEmpty()) Text(text = meta, color = soft, style = centraidType("small"))
            }
            if (state.slideshow) {
                // THE ONE WAY OUT OF THE SLIDESHOW, named for what it does.
                TextButton(onClick = {
                    onEvent(PhotoLightboxEvent(slideshow = PhotoLightboxEvent.SlideshowChanged(false)))
                }) { Text(text = "Leave", color = ink, style = centraidType("control")) }
            } else {
                Chip(icon = "more", label = "More") {
                    onEvent(lightboxSheetEvent(PhotoLightboxState.Sheet.SHEET_MORE))
                }
            }
        }

        Box(modifier = Modifier.weight(1f))

        if (!state.slideshow && live != null) {
            Box(Modifier.padding(bottom = 8.dp)) { LiveChip(live) }
        }

        // THE ONE STATUS LINE, drawn only when it has something to say. A
        // receipt beats a byte status, because it is about something the
        // member just did.
        val status = when {
            state.slideshow -> PhotoLightboxMachine.SLIDESHOW_LINE
            state.notice.isNotEmpty() -> state.notice
            else -> lightboxStatusLine(detail, player != null)
        }
        if (status.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // HOW FAR IT HAS GOT, WHEN ANYONE CAN SAY (`fetch_percent`).
                if (!state.slideshow && detail.held == PhotoCell.Held.HELD_FETCHING) {
                    if (detail.fetch_percent > 0) {
                        CircularProgressIndicator(
                            progress = { detail.fetch_percent / 100f },
                            modifier = Modifier.size(16.dp),
                        )
                    } else {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp))
                    }
                }
                Text(text = status, color = soft, style = centraidType("small"))
                // THE DOWNLOAD ARROW IS OFFERED ONLY FOR `HELD_WITHHELD_BY_RULE`,
                // and only with a hash to name.
                if (!state.slideshow && state.notice.isEmpty() &&
                    detail.held == PhotoCell.Held.HELD_WITHHELD_BY_RULE &&
                    detail.original_hash.isNotEmpty()
                ) {
                    TextButton(
                        onClick = {
                            onEvent(
                                PhotoLightboxEvent(
                                    fetch_original = PhotoLightboxEvent.OriginalRequested(
                                        asset_id = state.asset_id,
                                        content_hash = detail.original_hash,
                                    ),
                                ),
                            )
                        },
                    ) { Text(text = "Load the original", color = ink) }
                }
            }
        }

        // A WRITE THAT WAS REFUSED, AS A LINE OVER THE CHROME — over it and
        // never instead of the photograph.
        lightboxRefusedLine(state)?.let { refused ->
            Text(
                text = refused,
                color = ink,
                textAlign = TextAlign.Center,
                style = centraidType("small"),
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
            )
        }

        if (!state.slideshow) {
            if (player != null) LightboxTransport(player)
            // THE FILMSTRIP SITS DIRECTLY ABOVE THE PAGER AND THE ROW, and
            // goes away with the rest of the chrome.
            LightboxFilmstrip(state, onEvent)
            Pager(state, onEvent, ink, soft)
            Toolbar(state, detail, onEvent, ink, soft)
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
 * THE POINTER EQUIVALENT FOR SWIPE (§15).
 *
 * Nothing in this shell is reachable by gesture alone, and a phone has no arrow
 * keys to offer instead — so previous and next are controls on the stage. The
 * ids come off `neighbour_asset_ids`, which is the SHELF'S order: a swipe is a
 * reduce and never a read. A control with nowhere to go takes the stage's soft
 * ink on its own glyph, never a faded container.
 */
@Composable
private fun Pager(
    state: PhotoLightboxState,
    onEvent: (PhotoLightboxEvent) -> Unit,
    ink: Color,
    soft: Color,
) {
    val neighbours = state.neighbour_asset_ids
    if (neighbours.size <= 1) return
    val at = neighbours.indexOf(state.asset_id)
    val previous = neighbours.getOrNull(at - 1).takeIf { at > 0 }
    val next = neighbours.getOrNull(at + 1).takeIf { at >= 0 }
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        IconButton(
            onClick = { previous?.let { onEvent(lightboxMovedEvent(it)) } },
            enabled = previous != null,
        ) {
            CentraidIcon(
                iconKey = "ChevronLeft",
                tint = if (previous != null) ink else soft,
                size = 20.dp,
                modifier = Modifier.semantics { contentDescription = "Previous photograph" },
            )
        }
        IconButton(
            onClick = { next?.let { onEvent(lightboxMovedEvent(it)) } },
            enabled = next != null,
        ) {
            CentraidIcon(
                iconKey = "ChevronRight",
                tint = if (next != null) ink else soft,
                size = 20.dp,
                modifier = Modifier.semantics { contentDescription = "Next photograph" },
            )
        }
    }
}

/**
 * THE BOTTOM ROW, and its refusals in words.
 *
 * The enabled/reason table is [PhotoLightboxMachine.toolbar] — held as data so
 * that "no action is enabled without being able to run, and none is disabled
 * without a reason" is assertable without a renderer (#1015 B10).
 *
 * A REFUSED TARGET IS GREYED WITH THE STAGE'S OWN SOFT INK, never the page's
 * disabled ink: `textDisabled` is mixed against paper and on the stage reads as
 * an ABSENT control rather than a refused one.
 */
@Composable
private fun Toolbar(
    state: PhotoLightboxState,
    detail: PhotoDetail,
    onEvent: (PhotoLightboxEvent) -> Unit,
    ink: Color,
    soft: Color,
) {
    val table = PhotoLightboxMachine.toolbar(state)
    val refusal = PhotoLightboxMachine.writeRefusal(state)
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            Verb("share", "Send a copy", true, ink, soft) {
                onEvent(lightboxSheetEvent(PhotoLightboxState.Sheet.SHEET_SHARE))
            }
            val favorite = table[PhotoLightboxMachine.Verb.FAVORITE]
            Verb(
                iconKey = "heart",
                // A TOGGLE'S LABEL SAYS WHAT THE NEXT PRESS DOES, not what is
                // currently true.
                label = if (detail.favorite) "Remove from favourites" else "Favourite",
                enabled = favorite?.enabled == true,
                ink = ink,
                soft = soft,
            ) {
                onEvent(
                    PhotoLightboxEvent(
                        favorite = PhotoLightboxEvent.FavoriteToggled(!detail.favorite),
                    ),
                )
            }
            Verb("info", "Info", true, ink, soft) {
                onEvent(lightboxSheetEvent(PhotoLightboxState.Sheet.SHEET_INFO))
            }
            // EDIT, in v0's place after Info. Its gate and its route live with
            // the editor (`PhotoEditorScreen.kt`), not in this bar.
            PhotoEditButton(state, detail, ink, soft)
            // ARCHIVE IS NOT ONE OF v0'S FIVE — on the desktop it lives in
            // the `···` menu — so it is gated on the SAME ladder directly. It
            // is on the bar here because a phone's overflow is a sheet away and
            // hiding a reversible verb behind one makes the irreversible one
            // easier to reach than it is.
            Verb(
                iconKey = "Archive",
                label = if (detail.archived) "Unarchive" else "Archive",
                enabled = refusal == null,
                ink = ink,
                soft = soft,
            ) {
                onEvent(
                    PhotoLightboxEvent(
                        archive = PhotoLightboxEvent.ArchiveToggled(!detail.archived),
                    ),
                )
            }
            val trash = table[PhotoLightboxMachine.Verb.TRASH]
            Verb("trash", "Delete", trash?.enabled == true, ink, soft) {
                // INTO THE TRASH, NEVER OUT OF THE VAULT. `permanent` is a
                // separate decision with its own confirmation, and the trash
                // shelf is where it is made.
                onEvent(PhotoLightboxEvent(delete = PhotoLightboxEvent.DeleteRequested(false)))
            }
        }
        // THE REFUSAL AS VISIBLE TEXT, not only as a spoken hint.
        if (refusal != null) {
            Text(
                text = refusal,
                color = soft,
                textAlign = TextAlign.Center,
                style = centraidType("small"),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun Verb(
    iconKey: String,
    label: String,
    enabled: Boolean,
    ink: Color,
    soft: Color,
    onClick: () -> Unit,
) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(48.dp)) {
        CentraidIcon(
            iconKey = iconKey,
            tint = if (enabled) ink else soft,
            size = 24.dp,
            modifier = Modifier.semantics { contentDescription = label },
        )
    }
}

/** The sheets: info, share, more, the place picker, and the album choice. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun Sheets(
    state: PhotoLightboxState,
    detail: PhotoDetail?,
    onEvent: (PhotoLightboxEvent) -> Unit,
) {
    if (detail == null) return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // A DISMISS HAS TO REACH THE REDUCER TOO, or the state would still say
    // `SHEET_INFO` with nothing on screen and the next tap on Info would be a
    // no-op — the shape of bug that makes a control feel broken every second
    // press.
    val close = { onEvent(lightboxSheetEvent(PhotoLightboxState.Sheet.SHEET_NONE)) }
    // A HAND-OFF RUNS OFF THE REDUCER and reports back through it: what it
    // did lands on the status line, what it could not do on `write_failure`.
    val handOff: (suspend () -> PhotoHandOff.Outcome) -> Unit = { run ->
        scope.launch {
            val outcome = run()
            onEvent(
                PhotoLightboxEvent(
                    hand_off_settled = PhotoLightboxEvent.HandOffSettled(outcome.done, outcome.sentence),
                ),
            )
        }
    }
    when (state.sheet) {
        PhotoLightboxState.Sheet.SHEET_INFO ->
            ModalBottomSheet(onDismissRequest = close) {
                LightboxInfoSheet(state, detail, onEvent) {
                    handOff { PhotoHandOff.copyLocation(context, detail) }
                }
            }

        PhotoLightboxState.Sheet.SHEET_SHARE -> ModalBottomSheet(onDismissRequest = close) {
            Column(
                modifier = Modifier
                    .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp)
                    .padding(bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(text = SHARE_PLACE_TITLE, style = centraidType("title"), color = centraidColor("text"))
                // THE ROWS ARE THE SHARED MODULE'S, and the words with them:
                // what leaves the vault is not a per-platform decision.
                sharePlaceOptions(detail.place_name, detail.place_has_coordinate).forEach { option ->
                    SheetRow(label = option.label, detail = option.detail) {
                        close()
                        handOff { PhotoHandOff.send(context, detail, option.precision) }
                    }
                }
            }
        }

        PhotoLightboxState.Sheet.SHEET_MORE -> ModalBottomSheet(onDismissRequest = close) {
            LightboxMoreSheet(state, detail, onEvent, close) {
                close()
                handOff { PhotoHandOff.saveToDevice(context, detail) }
            }
        }

        PhotoLightboxState.Sheet.SHEET_PLACE -> ModalBottomSheet(onDismissRequest = close) {
            LightboxPlaceSheet(state, detail, onEvent)
        }

        PhotoLightboxState.Sheet.SHEET_NONE,
        PhotoLightboxState.Sheet.SHEET_UNSPECIFIED,
        -> Unit
    }
    if (state.album_choice_open) {
        AlbumChoiceSheet(
            choices = state.album_choices,
            onChoose = { album ->
                onEvent(PhotoLightboxEvent(album_chosen = AlbumChosen(album_id = album)))
            },
            onNewAlbum = { title ->
                onEvent(PhotoLightboxEvent(album_choice_created = AlbumChoiceCreated(title = title)))
            },
            onDismiss = {
                onEvent(PhotoLightboxEvent(album_choice_dismissed = AlbumChoiceDismissed()))
            },
        )
    }
}

/**
 * The `···` menu, as a sheet — v0's `viewer-menu.ts`, in iOS' own group order.
 *
 * **THE OMISSIONS ARE CHECKED CLAIMS, not oversights.** Copy, Duplicate and
 * Adjust Date & Time are not here because there is no write behind any of
 * them. Make key photo is here only inside an album — a row with nothing
 * behind it is left out, never shown permanently disabled — and Slideshow only
 * on a shelf with somewhere to go. Delete is LAST: nothing is placed under a
 * destructive row, and the safety is the trash behind it, never the row being
 * hard to find.
 */
@Composable
private fun LightboxMoreSheet(
    state: PhotoLightboxState,
    detail: PhotoDetail,
    onEvent: (PhotoLightboxEvent) -> Unit,
    close: () -> Unit,
    onDownload: () -> Unit,
) {
    val refusal = PhotoLightboxMachine.writeRefusal(state)
    Column(
        modifier = Modifier
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp)
            .padding(bottom = 24.dp),
    ) {
        MoreRow("Archive", if (detail.archived) "Unarchive" else "Archive", refusal) {
            close()
            onEvent(PhotoLightboxEvent(archive = PhotoLightboxEvent.ArchiveToggled(!detail.archived)))
        }
        if (state.neighbour_asset_ids.size > 1) {
            MoreRow("Play", "Slideshow", null) {
                onEvent(PhotoLightboxEvent(slideshow = PhotoLightboxEvent.SlideshowChanged(true)))
            }
        }
        MoreRow("FolderPlus", "Add to album", refusal) {
            onEvent(PhotoLightboxEvent(album_choice_opened = AlbumChoiceOpened()))
        }
        if (state.album_id.isNotEmpty()) {
            MoreRow("Star", "Make key photo", refusal) {
                close()
                onEvent(PhotoLightboxEvent(key_photo = PhotoLightboxEvent.KeyPhotoRequested()))
            }
        }
        MoreRow("MapPin", "Adjust location", refusal) {
            onEvent(lightboxSheetEvent(PhotoLightboxState.Sheet.SHEET_PLACE))
        }
        MoreRow("Download", "Download", null, onClick = onDownload)
        MoreRow("Send", "Send a copy", null) {
            onEvent(lightboxSheetEvent(PhotoLightboxState.Sheet.SHEET_SHARE))
        }
        MoreRow("trash", "Delete", refusal, destructive = true) {
            close()
            onEvent(PhotoLightboxEvent(delete = PhotoLightboxEvent.DeleteRequested(false)))
        }
    }
}

/**
 * ONE TEXT SLOT, so a refusal rides after an em dash rather than becoming a
 * second, shorter phrasing of the same truth. Destructive is `net` ink, never
 * a fill (DESIGN.md §3).
 */
@Composable
private fun MoreRow(
    icon: String,
    label: String,
    refusal: String?,
    destructive: Boolean = false,
    onClick: () -> Unit,
) {
    val enabled = refusal == null
    val ink = when {
        !enabled -> centraidColor("textSoft")
        destructive -> centraidColor("net")
        else -> centraidColor("text")
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics(mergeDescendants = true) { role = Role.Button },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CentraidIcon(iconKey = icon, tint = ink, size = 20.dp)
        Text(
            text = if (enabled) label else "$label — $refusal",
            color = ink,
            style = centraidType("control"),
        )
    }
}

@Composable
private fun SheetRow(label: String, detail: String, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(onClick = onClick)
            .semantics(mergeDescendants = true) { role = Role.Button },
        verticalArrangement = Arrangement.Center,
    ) {
        Text(text = label, style = centraidType("control"), color = centraidColor("text"))
        if (detail.isNotEmpty()) {
            Text(text = detail, style = centraidType("small"), color = centraidColor("textSoft"))
        }
    }
}

/**
 * "ADJUST LOCATION" — the places this vault knows, and "No place".
 *
 * A place is PICKED here and never typed: `media.set_asset_place` points at an
 * existing `core_place` row and there is no app-plane command that mints one,
 * so a free-text field would be a promise the vault cannot keep. Naming a
 * place is the Places screen's.
 */
@Composable
private fun LightboxPlaceSheet(
    state: PhotoLightboxState,
    detail: PhotoDetail,
    onEvent: (PhotoLightboxEvent) -> Unit,
) {
    val choose = { placeId: String ->
        onEvent(PhotoLightboxEvent(place_chosen = PhotoLightboxEvent.PlaceChosen(place_id = placeId)))
    }
    Column(
        modifier = Modifier
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp)
            .padding(bottom = 24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(text = "Adjust location", style = centraidType("title"), color = centraidColor("text"))
        lightboxRefusedLine(state)?.let {
            Text(text = it, style = centraidType("small"), color = centraidColor("net"))
        }
        if (detail.place_id.isNotEmpty()) {
            SheetRow(label = "No place", detail = "Clear where this was taken.") { choose("") }
        }
        state.place_choices.forEach { place ->
            val here = place.place_id == detail.place_id
            SheetRow(label = place.name, detail = if (here) "Where this was taken" else "") {
                if (!here) choose(place.place_id)
            }
        }
        if (state.place_choices.isEmpty()) {
            Text(
                text = "No places in this vault yet.",
                style = centraidType("small"),
                color = centraidColor("textSoft"),
            )
        }
    }
}

/**
 * THE INFO SHEET — everything the vault knows about this photograph, and the
 * four things a member may change about it: the caption, the labels, the
 * place, and a copy of where it was taken.
 *
 * **NO DESTRUCTIVE CONTROL HERE, EVER** (owner ruling, #711 2c): Trash lives on
 * the viewer bar alone, and a second destructive path inside a facts panel is
 * a misfire waiting to happen. Removing a LABEL is not that — it takes a word
 * off a photograph, and the photograph stays.
 *
 * **A FIELD THE RECORD LACKS IS OMITTED**, never invented as `?p` or `0:00`.
 */
@Composable
private fun LightboxInfoSheet(
    state: PhotoLightboxState,
    detail: PhotoDetail,
    onEvent: (PhotoLightboxEvent) -> Unit,
    onCopyLocation: () -> Unit,
) {
    val context = LocalContext.current
    val soft = centraidColor("textSoft")
    val ink = centraidColor("text")
    var caption by remember(detail.asset_id) { mutableStateOf(detail.title) }
    var tag by remember(detail.asset_id) { mutableStateOf("") }
    val commitCaption = {
        onEvent(PhotoLightboxEvent(caption = PhotoLightboxEvent.CaptionChanged(caption = caption)))
    }
    // THE CAMERA, from the original's own header when this device holds it —
    // see `PhotoLightboxReads`' doc for why the vault's row cannot say.
    val camera by produceState(initialValue = detail.camera, detail.original_path, detail.camera) {
        val path = detail.original_path?.takeIf { it.isNotEmpty() }
        if (detail.camera.isEmpty() && path != null) {
            value = withContext(Dispatchers.IO) { PhotoHandOff.cameraOf(path) }.orEmpty()
        }
    }
    Column(
        modifier = Modifier
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp)
            .padding(bottom = 24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(text = detail.title.ifEmpty { "Photograph" }, style = centraidType("title"), color = ink)

        // A REFUSED EDIT IS SAID HERE, where the member made it — the chrome's
        // line is behind this sheet.
        lightboxRefusedLine(state)?.let {
            Text(text = it, style = centraidType("small"), color = centraidColor("net"))
        }

        InfoLabel("Caption")
        TextField(
            value = caption,
            onValueChange = { caption = it },
            placeholder = { Text("Say what this is") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { commitCaption() }),
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = "Caption" }
                // COMMITTED WHEN THE FIELD IS LEFT, as v0's was on blur: the
                // typed text stays exactly where it is if the vault says no.
                .onFocusChanged { if (!it.isFocused) commitCaption() },
        )

        lightboxFacts(context, detail, camera).forEach { (label, value) ->
            Column {
                InfoLabel(label)
                Text(text = value, style = centraidType("body"), color = ink)
            }
        }

        // WHERE, as the vault names it — and the three things a member can do
        // about it. The coordinate is never printed; "Copy exact location"
        // puts it on the member's own clipboard because they asked.
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            InfoLabel("Place")
            Text(
                text = when {
                    detail.place_name.isNotEmpty() -> detail.place_name
                    PhotoDetail.Part.PART_PLACE in detail.unread_parts ->
                        "Centraid could not read where this was taken."
                    detail.place_id.isNotEmpty() -> "A place with no name yet"
                    else -> "No place"
                },
                style = centraidType("body"),
                color = ink,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { onEvent(lightboxSheetEvent(PhotoLightboxState.Sheet.SHEET_PLACE)) }) {
                    Text(text = if (detail.place_id.isEmpty()) "Add place" else "Change", color = ink)
                }
                if (detail.place_id.isNotEmpty()) {
                    TextButton(onClick = {
                        onEvent(PhotoLightboxEvent(place_chosen = PhotoLightboxEvent.PlaceChosen(place_id = "")))
                    }) { Text(text = "Remove", color = ink) }
                }
                if (detail.place_has_coordinate) {
                    TextButton(onClick = onCopyLocation) { Text(text = "Copy exact location", color = ink) }
                }
            }
        }

        // CONFIRMED FACES ONLY, and only the ones with a NAME: a party id is
        // not a person, and a proposal belongs to face review.
        Column {
            InfoLabel("Who is in it")
            Text(
                text = lightboxSection(
                    values = detail.people.map { it.display_name }.filter { it.isNotEmpty() },
                    unread = PhotoDetail.Part.PART_PEOPLE in detail.unread_parts,
                    unreadSentence = "Centraid could not read who is in this photograph.",
                    emptySentence = "Nobody is named in this photograph.",
                ),
                style = centraidType("body"),
                color = ink,
            )
        }

        // LABELS, each with its own remove, and a field to add one. Only
        // labels with a word on them are drawn: a concept id is not a word.
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            InfoLabel("Labels")
            val labels = detail.labels.filter { it.label.isNotEmpty() }
            if (labels.isEmpty()) {
                Text(
                    text = if (PhotoDetail.Part.PART_LABELS in detail.unread_parts) {
                        "Centraid could not read this photograph's labels."
                    } else {
                        "No labels on this photograph."
                    },
                    style = centraidType("small"),
                    color = soft,
                )
            }
            labels.forEach { label ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier
                        .clip(RoundedCornerShape(7.dp))
                        .background(centraidColor("bgSunken"))
                        .padding(start = 10.dp),
                ) {
                    Text(text = label.label, style = centraidType("small"), color = ink)
                    if (label.tag_id.isNotEmpty()) {
                        IconButton(
                            onClick = {
                                onEvent(
                                    PhotoLightboxEvent(
                                        tag_removed = PhotoLightboxEvent.TagRemoved(label.tag_id),
                                    ),
                                )
                            },
                            modifier = Modifier.size(34.dp),
                        ) {
                            CentraidIcon(
                                iconKey = "X",
                                tint = soft,
                                size = 14.dp,
                                modifier = Modifier.semantics { contentDescription = "Remove ${label.label}" },
                            )
                        }
                    }
                }
            }
            TextField(
                value = tag,
                onValueChange = { tag = it },
                placeholder = { Text("Add a label") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = {
                    if (tag.isNotBlank()) {
                        onEvent(PhotoLightboxEvent(tag_added = PhotoLightboxEvent.TagAdded(label = tag)))
                        tag = ""
                    }
                }),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Add a label" },
            )
        }

        // WHERE THE BYTES ARE, in a sentence that says what fetching costs.
        Text(text = lightboxWhereabouts(detail), style = centraidType("small"), color = soft)
        if (state.notice.isNotEmpty()) {
            Text(text = state.notice, style = centraidType("small"), color = soft)
        }
    }
}

@Composable
private fun InfoLabel(text: String) {
    Text(text = text, style = centraidType("small"), color = centraidColor("textSoft"))
}

/**
 * IS A SCREEN READER RUNNING? Live, so TalkBack switched on mid-session brings
 * the chrome back without asking the member to find a tap target they cannot
 * see (v0's `use-screen-reader.ts`).
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

/**
 * REDUCED MOTION, as Android spells it: animations switched off in the
 * developer or accessibility settings set the animator scale to zero.
 */
private fun reducedMotion(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

private fun lightboxSheetEvent(sheet: PhotoLightboxState.Sheet): PhotoLightboxEvent =
    PhotoLightboxEvent(sheet = PhotoLightboxEvent.SheetChanged(sheet))

private fun lightboxMovedEvent(assetId: String): PhotoLightboxEvent =
    PhotoLightboxEvent(moved = PhotoLightboxEvent.Moved(assetId))

/** The refused write's sentence and remedy, or null when nothing was refused. */
private fun lightboxRefusedLine(state: PhotoLightboxState): String? {
    val refused = state.write_failure ?: return null
    if (refused.sentence.isEmpty()) return null
    return if (refused.remedy.isEmpty()) refused.sentence else "${refused.sentence} ${refused.remedy}"
}

/** What the stage draws for this photograph, or null when it has nothing. */
private fun lightboxDrawnPath(detail: PhotoDetail): String? =
    detail.original_path?.takeIf { it.isNotEmpty() && detail.original_embeddable }
        ?: detail.thumbnail_path?.takeIf { it.isNotEmpty() }

/**
 * A stage with nothing to draw says which of its truthful states it is in —
 * never a broken image.
 */
private fun lightboxStageLabel(detail: PhotoDetail): String = when (detail.held) {
    PhotoCell.Held.HELD_ABSENT -> "This photograph is not on this device yet."
    else -> "Preview no longer on this device"
}

/**
 * The stage's one line. See the SwiftUI twin for the precedence. A video with
 * no player is one whose file is not here, and the line says what the stage is
 * showing instead.
 */
private fun lightboxStatusLine(detail: PhotoDetail, playing: Boolean): String = when {
    detail.held == PhotoCell.Held.HELD_WITHHELD_BY_RULE ->
        "Original not fetched — your transfer rule is holding it back."
    // A PERCENTAGE ONLY WHEN THERE IS ONE: "0%" would read as "nothing has
    // crossed".
    detail.held == PhotoCell.Held.HELD_FETCHING ->
        if (detail.fetch_percent > 0) {
            "Fetching the original — ${detail.fetch_percent}%"
        } else {
            "Fetching the original…"
        }
    detail.held == PhotoCell.Held.HELD_ABSENT ->
        "Nothing of this photograph has reached this device yet."
    detail.kind == PhotoCell.Kind.KIND_VIDEO && !playing ->
        "This video's file is not on this device — showing a still from it."
    else -> ""
}

/**
 * WHERE THE BYTES ARE, in a sentence that says what fetching costs: "explicit
 * choice" is only honest if the choice is described before it is offered.
 */
private fun lightboxWhereabouts(detail: PhotoDetail): String = when (detail.held) {
    PhotoCell.Held.HELD_ORIGINAL -> "The original is on this device."
    PhotoCell.Held.HELD_WITHHELD_BY_RULE ->
        "The original has not been fetched — your transfer rule is holding it, " +
            "and fetching it is your choice."
    PhotoCell.Held.HELD_FETCHING -> "Centraid is fetching the original now."
    PhotoCell.Held.HELD_ABSENT -> "Nothing of this photograph is on this device yet."
    PhotoCell.Held.HELD_THUMBNAIL_ONLY, PhotoCell.Held.HELD_UNSPECIFIED ->
        "This device holds a smaller copy; the original has not been fetched."
}

/**
 * THE FACTS, in the SwiftUI twin's order and words. Each row exists only when
 * the vault answered for it; a fact that could not be read is still a row.
 */
private fun lightboxFacts(context: Context, detail: PhotoDetail, camera: String): List<Pair<String, String>> =
    buildList {
        val date = lightboxStampDate(detail)
        if (date.isNotEmpty()) {
            val offset = detail.captured_utc_offset_minutes
            // NO ORIGINAL OFFSET IS NOT ZERO: the line says UTC rather than
            // claiming the camera recorded Greenwich.
            val zone = if (offset == 0) "UTC" else lightboxOffset(offset)
            add("Captured" to "$date ${lightboxStampLine(context, detail)} · $zone")
        }
        if (detail.width > 0 && detail.height > 0) add("Size" to "${detail.width} × ${detail.height}")
        if (detail.duration_seconds > 0) add("Length" to lightboxClock(detail.duration_seconds))
        if (detail.byte_size > 0L) {
            add("File" to lightboxBytes(detail.byte_size))
        } else if (PhotoDetail.Part.PART_CONTENT in detail.unread_parts) {
            add("File" to "Centraid could not read this file's size.")
        }
        if (camera.isNotEmpty()) add("Camera" to camera)
    }

/**
 * `30 July 2026` — the SwiftUI twin's `.day().month(.wide).year()`, in this
 * device's locale and the capture's zone. Empty when the row records no capture time: never
 * the raw timestamp, and never an invented date.
 */
private fun lightboxStampDate(detail: PhotoDetail): String {
    val instant = lightboxInstant(detail.captured_at) ?: return ""
    val locale = Locale.getDefault()
    return SimpleDateFormat(DateFormat.getBestDateTimePattern(locale, "dMMMMyyyy"), locale)
        .apply { timeZone = lightboxCaptureZone(detail) }
        .format(instant)
}

/**
 * THE ZONE THE SHUTTER FIRED IN, not this phone's. The Library files a
 * photograph under its capture-local day (`PhotosTimeline.captureDay`), so a
 * stamp in the phone's zone put an evening in Lisbon on the next morning's date
 * here while the grid said the evening. A missing offset is UTC, the same rule
 * the grid and the "Captured" row follow.
 */
private fun lightboxCaptureZone(detail: PhotoDetail): TimeZone {
    val offset = detail.captured_utc_offset_minutes
    return if (offset == 0) TimeZone.getTimeZone("UTC") else TimeZone.getTimeZone(lightboxOffset(offset).replace("UTC", "GMT"))
}

/**
 * `17:42 · Lyme Regis`, the clock in this device's own 12- or 24-hour habit.
 * The place stops the line short when there is none, never leaving a dangling
 * separator.
 */
private fun lightboxStampLine(context: Context, detail: PhotoDetail): String {
    val locale = Locale.getDefault()
    val skeleton = if (DateFormat.is24HourFormat(context)) "Hm" else "hm"
    val clock = lightboxInstant(detail.captured_at)?.let {
        SimpleDateFormat(DateFormat.getBestDateTimePattern(locale, skeleton), locale)
            .apply { timeZone = lightboxCaptureZone(detail) }
            .format(it)
    }.orEmpty()
    return listOf(clock, detail.place_name).filter { it.isNotEmpty() }.joinToString(" · ")
}

/**
 * The vault writes `%Y-%m-%dT%H:%M:%fZ` and nothing else — FRACTIONAL SECONDS
 * FIRST, because a parser that only accepted whole seconds would answer null
 * for every photograph in the vault.
 */
private fun lightboxInstant(text: String): Date? {
    if (text.isEmpty()) return null
    for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSSX", "yyyy-MM-dd'T'HH:mm:ssX")) {
        val parser = SimpleDateFormat(pattern, Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        runCatching { parser.parse(text) }.getOrNull()?.let { return it }
    }
    return null
}

private fun lightboxOffset(minutes: Int): String {
    val sign = if (minutes < 0) "-" else "+"
    val total = kotlin.math.abs(minutes)
    return "UTC$sign${(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}"
}

/**
 * `1:01:40`, with an hours arm. A clock without one reads a 61-minute recording
 * as `61:40` — the drift #883 B5 found between two copies of this that claimed
 * to be twins.
 */
internal fun lightboxClock(seconds: Int): String {
    val hours = seconds / 3600
    val minutes = (seconds % 3600) / 60
    val rest = seconds % 60
    val padded = rest.toString().padStart(2, '0')
    return if (hours > 0) {
        "$hours:${minutes.toString().padStart(2, '0')}:$padded"
    } else {
        "$minutes:$padded"
    }
}

/**
 * DECIMAL, not binary, and one decimal above a megabyte — the same rungs
 * `centraid_vault::page::format_byte_size` uses, because a member comparing
 * this with a file's size elsewhere should not be handed two numbers for one
 * amount.
 */
private fun lightboxBytes(count: Long): String = when {
    count < 1_000L -> if (count == 1L) "1 byte" else "$count bytes"
    count < 1_000_000L -> "${count / 1_000L} KB"
    count < 1_000_000_000L -> "${lightboxTenths(count, 1_000_000L)} MB"
    else -> "${lightboxTenths(count, 1_000_000_000L)} GB"
}

/**
 * `count / unit` to one decimal, ROUNDED rather than truncated, so this and the
 * SwiftUI twin's `%.1f` print the same number for the same file.
 */
private fun lightboxTenths(count: Long, unit: Long): String {
    val tenth = (count * 10L + unit / 2L) / unit
    return "${tenth / 10L}.${tenth % 10L}"
}

/**
 * ONE SECTION, AND THREE THINGS IT CAN SAY: values, "there are none", or "this
 * could not be read" — never a heading over a blank space.
 */
private fun lightboxSection(
    values: List<String>,
    unread: Boolean,
    unreadSentence: String,
    emptySentence: String,
): String = when {
    values.isNotEmpty() -> values.joinToString(" · ")
    unread -> unreadSentence
    else -> emptySentence
}
