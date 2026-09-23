package dev.centraid.android.screens

import android.net.Uri
import android.view.ViewGroup
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoDetail
import centraid.screen.v1.PhotoLightboxEvent
import centraid.screen.v1.PhotoLightboxState
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.shared.apps.photos.PhotoLightboxMachine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.abs
import kotlin.math.max

/**
 * THE STAGE — the photograph, and the three gestures a member reaches it by
 * (#1029 photos port; v0's `MediaPage.tsx` and `lightbox-gestures.ts`).
 *
 * - **A horizontal swipe pages** to the shelf's next or previous photograph.
 *   The neighbours slide in as their filmstrip frames, so the photograph a
 *   member is swiping TO is on screen before its read lands. The pager
 *   chevrons stay in the chrome: nothing here is reachable by gesture alone.
 * - **A pinch, or a double tap, zooms**, from fit to 2.5× and up to 5×, and a
 *   one-finger drag pans a zoomed photograph. A zoomed photograph does not
 *   page — the drag that would have paged is the drag that pans it.
 * - **A swipe down closes**, the `StageRoom`'s own way out (DESIGN.md); the
 *   close control in the chrome is the same act.
 *
 * One bare tap toggles the chrome, a long press plays a Live Photo's movie.
 * Every settle runs on the one state-change curve and snaps under reduced
 * motion.
 */
@Composable
internal fun LightboxStage(
    state: PhotoLightboxState,
    reduceMotion: Boolean,
    player: LightboxPlayer?,
    live: LightboxPlayer?,
    onEvent: (PhotoLightboxEvent) -> Unit,
    onClose: () -> Unit,
) {
    val neighbours = state.neighbour_asset_ids
    // THE GESTURE LOOP OUTLIVES A RECOMPOSITION, so what it reads off the
    // state it reads through these — never a copy taken when it started.
    val current by rememberUpdatedState(state)
    val send by rememberUpdatedState(onEvent)
    val close by rememberUpdatedState(onClose)
    // THE PHOTOGRAPH THE STAGE IS DRAWING, which leads the state by one frame
    // on a swipe: the incoming frame is already under the member's finger when
    // `Moved` is sent, and snapping back to the old one for the frame before
    // the state catches up would be a flicker on every page.
    var shown by remember { mutableStateOf(state.asset_id) }
    LaunchedEffect(state.asset_id) { shown = state.asset_id }
    val at = neighbours.indexOf(shown)
    val previous = if (at > 0) neighbours[at - 1] else null
    val next = if (at >= 0 && at + 1 < neighbours.size) neighbours[at + 1] else null
    val frames = remember(state.film) { state.film.associateBy { it.asset_id } }
    val detail = state.detail?.takeIf { it.asset_id == shown }

    val scope = rememberCoroutineScope()
    var pageX by remember { mutableFloatStateOf(0f) }
    var dismissY by remember { mutableFloatStateOf(0f) }
    var scale by remember(shown) { mutableFloatStateOf(1f) }
    var panX by remember(shown) { mutableFloatStateOf(0f) }
    var panY by remember(shown) { mutableFloatStateOf(0f) }
    val settle: AnimationSpec<Float> = if (reduceMotion) snap() else STATE_CHANGE
    val zoomable = detail?.kind != PhotoCell.Kind.KIND_VIDEO && !state.slideshow

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val width = constraints.maxWidth.toFloat()
        val height = constraints.maxHeight.toFloat()
        val dismissAt = with(LocalDensity.current) { DISMISS_DISTANCE.dp.toPx() }

        fun extent(size: Float): Float = max(0f, (size * scale - size) / 2f)

        Box(
            Modifier
                .fillMaxSize()
                .pointerInput(shown, previous, next, zoomable) {
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false)
                        var mode = Gesture.UNDECIDED
                        var travelled = Offset.Zero
                        do {
                            val event = awaitPointerEvent()
                            val pressed = event.changes.count { it.pressed }
                            if (pressed >= 2 && zoomable) {
                                mode = Gesture.ZOOM
                                scale = (scale * event.calculateZoom()).coerceIn(ZOOM_FIT, ZOOM_MAX)
                                val pan = event.calculatePan()
                                panX = (panX + pan.x).coerceIn(-extent(width), extent(width))
                                panY = (panY + pan.y).coerceIn(-extent(height), extent(height))
                                event.changes.forEach { if (it.positionChanged()) it.consume() }
                            } else if (pressed == 1) {
                                val change = event.changes.first { it.pressed }
                                val delta = change.positionChange()
                                when (mode) {
                                    Gesture.UNDECIDED -> {
                                        travelled += delta
                                        if (travelled.getDistance() > viewConfiguration.touchSlop) {
                                            mode = when {
                                                scale > ZOOM_FIT + 0.001f -> Gesture.PAN
                                                current.slideshow -> Gesture.NONE
                                                abs(travelled.x) > abs(travelled.y) -> Gesture.PAGE
                                                travelled.y > 0f -> Gesture.DISMISS
                                                else -> Gesture.NONE
                                            }
                                        }
                                    }
                                    Gesture.PAN -> {
                                        panX = (panX + delta.x).coerceIn(-extent(width), extent(width))
                                        panY = (panY + delta.y).coerceIn(-extent(height), extent(height))
                                        change.consume()
                                    }
                                    Gesture.PAGE -> {
                                        // A SHELF'S EDGE RESISTS rather than
                                        // sliding into nothing.
                                        val edge = (delta.x > 0 && previous == null) ||
                                            (delta.x < 0 && next == null)
                                        pageX += if (edge) delta.x / 3f else delta.x
                                        change.consume()
                                    }
                                    Gesture.DISMISS -> {
                                        dismissY = max(0f, dismissY + delta.y)
                                        change.consume()
                                    }
                                    Gesture.ZOOM, Gesture.NONE -> Unit
                                }
                            }
                        } while (event.changes.any { it.pressed })

                        when (mode) {
                            Gesture.PAGE -> {
                                val target = when {
                                    pageX < -width * PAGE_THRESHOLD && next != null -> next
                                    pageX > width * PAGE_THRESHOLD && previous != null -> previous
                                    else -> null
                                }
                                scope.launch {
                                    val end = when (target) {
                                        null -> 0f
                                        next -> -width
                                        else -> width
                                    }
                                    animate(pageX, end, animationSpec = settle) { value, _ -> pageX = value }
                                    if (target != null) {
                                        shown = target
                                        pageX = 0f
                                        send(PhotoLightboxEvent(moved = PhotoLightboxEvent.Moved(target)))
                                    }
                                }
                            }
                            Gesture.DISMISS ->
                                if (dismissY > dismissAt) {
                                    close()
                                } else {
                                    scope.launch {
                                        animate(dismissY, 0f, animationSpec = settle) { value, _ -> dismissY = value }
                                    }
                                }
                            Gesture.ZOOM ->
                                if (scale <= ZOOM_FIT + 0.01f) {
                                    scale = ZOOM_FIT
                                    panX = 0f
                                    panY = 0f
                                }
                            else -> Unit
                        }
                    }
                }
                .pointerInput(shown, zoomable, live) {
                    detectTapGestures(
                        // THE CHROME TOGGLE, and nothing else is bound to a
                        // bare tap: the gesture that hid the controls is the
                        // gesture that returns them.
                        onTap = {
                            send(
                                PhotoLightboxEvent(
                                    chrome = PhotoLightboxEvent.ChromeToggled(!current.chrome_visible),
                                ),
                            )
                        },
                        onDoubleTap = { tap -> if (zoomable) {
                            val zoomed = scale > ZOOM_FIT + 0.001f
                            val target = if (zoomed) ZOOM_FIT else ZOOM_RUNG
                            // THE POINT UNDER THE FINGER STAYS UNDER IT.
                            val toX = if (zoomed) 0f else ((width / 2f - tap.x) * (target - 1f))
                            val toY = if (zoomed) 0f else ((height / 2f - tap.y) * (target - 1f))
                            val limitX = max(0f, (width * target - width) / 2f)
                            val limitY = max(0f, (height * target - height) / 2f)
                            val fromScale = scale
                            val fromX = panX
                            val fromY = panY
                            scope.launch {
                                animate(0f, 1f, animationSpec = settle) { t, _ ->
                                    scale = fromScale + (target - fromScale) * t
                                    panX = fromX + (toX.coerceIn(-limitX, limitX) - fromX) * t
                                    panY = fromY + (toY.coerceIn(-limitY, limitY) - fromY) * t
                                }
                            }
                        } },
                        // A LIVE PHOTO MOVES WHILE IT IS HELD, as it does in
                        // the camera roll it came from.
                        onLongPress = { live?.playFromStart() },
                    )
                },
        ) {
            // THE TWO NEIGHBOURS, as their strip frames, either side.
            listOf(-1 to previous, 1 to next).forEach { (slot, id) ->
                if (id != null) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            .graphicsLayer {
                                translationX = slot * width + pageX
                                translationY = dismissY
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        frames[id]?.thumbnail_path?.let { StageImage(path = it) }
                    }
                }
            }
            Box(
                Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        translationX = pageX + panX
                        translationY = dismissY + panY
                        scaleX = scale
                        scaleY = scale
                    },
                contentAlignment = Alignment.Center,
            ) {
                // A SLIDESHOW DISSOLVES from one photograph to the next on the
                // state-change curve, and cuts under reduced motion. Paging by
                // hand does not: the swipe is its own motion.
                Crossfade(
                    targetState = shown,
                    animationSpec = if (state.slideshow && !reduceMotion) FADE else snap(),
                    label = "slide",
                ) { id ->
                    val here = state.detail?.takeIf { it.asset_id == id }
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        StageContent(here, frames[id], player, live)
                    }
                }
            }
        }
    }
}

/**
 * WHAT ONE PAGE OF THE STAGE DRAWS, from the most to the least it can.
 *
 * The located original when the byte door said this device holds it and it
 * may be drawn; the thumbnail under it, which is on screen from the first
 * frame; and, before the photograph's own read has landed, its strip frame.
 * A video with its file here plays; one without draws its still, and the
 * status line says why.
 */
@Composable
private fun StageContent(
    detail: PhotoDetail?,
    frame: PhotoCell?,
    player: LightboxPlayer?,
    live: LightboxPlayer?,
) {
    val thumbnail = detail?.thumbnail_path?.takeIf { it.isNotEmpty() }
        ?: frame?.thumbnail_path?.takeIf { it.isNotEmpty() }
    if (thumbnail != null) StageImage(path = thumbnail)
    if (detail == null) return
    val original = detail.original_path?.takeIf { it.isNotEmpty() && detail.original_embeddable }
    when {
        detail.kind == PhotoCell.Kind.KIND_VIDEO && original != null && player != null ->
            PlayerSurface(player)
        detail.kind != PhotoCell.Kind.KIND_VIDEO && original != null -> StageImage(path = original, full = true)
    }
    if (live != null && live.showing) PlayerSurface(live)
}

/**
 * ONE STILL, FIT TO THE STAGE. A thumbnail decodes at its own size; the
 * ORIGINAL decodes off the main thread, upright, and no larger than a zoomed
 * screen needs — a 48-megapixel photograph decoded whole is a quarter of a
 * gigabyte a phone does not have to spend.
 */
@Composable
private fun StageImage(path: String, full: Boolean = false) {
    val bitmap by produceState<ImageBitmap?>(initialValue = null, path) {
        value = withContext(Dispatchers.IO) {
            decodeUpright(path, maxDimension = if (full) FULL_DECODE else 0)?.asImageBitmap()
        }
    }
    bitmap?.let {
        Image(
            bitmap = it,
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

/**
 * A PLAYER AND WHAT THE CHROME READS OFF IT.
 *
 * ExoPlayer is the decoder and the clock; the transport is this screen's own
 * controls, so the player's state is polled into Compose state rather than
 * drawn by `media3-ui`'s controller. Released with the composition that made
 * it — a player left running behind a closed lightbox is a sound with no
 * screen.
 */
internal class LightboxPlayer(val exo: ExoPlayer, private val once: Boolean) {
    var playing by mutableStateOf(false)
    var position by mutableLongStateOf(0L)
    var duration by mutableLongStateOf(0L)

    /** A Live Photo's movie shows only while it plays, then gives the still back. */
    var showing by mutableStateOf(false)

    fun toggle() {
        if (exo.isPlaying) {
            exo.pause()
        } else {
            if (exo.playbackState == Player.STATE_ENDED) exo.seekTo(0L)
            exo.play()
        }
    }

    fun seekTo(fraction: Float) {
        if (duration > 0L) exo.seekTo((duration * fraction.coerceIn(0f, 1f)).toLong())
    }

    fun playFromStart() {
        exo.seekTo(0L)
        exo.play()
        showing = true
    }

    fun pause() = exo.pause()

    internal fun poll() {
        playing = exo.isPlaying
        position = exo.currentPosition.coerceAtLeast(0L)
        duration = exo.duration.takeIf { it > 0L } ?: 0L
        if (once && exo.playbackState == Player.STATE_ENDED) showing = false
    }
}

/** A player for [path], or null when there is nothing to play. */
@Composable
internal fun rememberLightboxPlayer(path: String?, once: Boolean): LightboxPlayer? {
    val context = LocalContext.current
    val player = remember(path) {
        path?.let {
            val exo = ExoPlayer.Builder(context).build().apply {
                setMediaItem(MediaItem.fromUri(Uri.fromFile(File(it))))
                prepare()
            }
            LightboxPlayer(exo, once)
        }
    }
    DisposableEffect(player) { onDispose { player?.exo?.release() } }
    LaunchedEffect(player) {
        while (player != null) {
            player.poll()
            delay(POLL_MS)
        }
    }
    return player
}

@Composable
private fun PlayerSurface(player: LightboxPlayer) {
    AndroidView(
        factory = { context ->
            PlayerView(context).apply {
                // THE APP'S OWN TRANSPORT, never the library's: one control
                // vocabulary, drawn by this screen.
                useController = false
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                isClickable = false
                isFocusable = false
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
            }
        },
        update = { it.player = player.exo },
        modifier = Modifier.fillMaxSize(),
    )
}

/**
 * THE TRANSPORT — play, pause and the scrub strip (v0's `Transport`).
 *
 * Determinate, always: a position over a length, never a spinner (DESIGN.md
 * §5). The strip is a track the member drags or taps to seek; the time beside
 * it is the clock the strip is drawing.
 */
@Composable
internal fun LightboxTransport(player: LightboxPlayer) {
    val ink = centraidColor("onStage")
    val soft = centraidColor("onStageSoft")
    val fraction = if (player.duration > 0L) player.position.toFloat() / player.duration else 0f
    Row(
        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        IconButton(onClick = { player.toggle() }, modifier = Modifier.size(44.dp)) {
            CentraidIcon(
                iconKey = if (player.playing) "Pause" else "Play",
                tint = ink,
                size = 20.dp,
                modifier = Modifier.semantics {
                    contentDescription = if (player.playing) "Pause" else "Play"
                },
            )
        }
        BoxWithConstraints(
            Modifier
                .weight(1f)
                .height(28.dp)
                .semantics {
                    contentDescription = "Position"
                    stateDescription = mediaClock(player.position) + " of " + mediaClock(player.duration)
                }
                .pointerInput(player) {
                    detectTapGestures { player.seekTo(it.x / size.width) }
                }
                .pointerInput(player) {
                    detectHorizontalDragGestures { change, _ ->
                        player.seekTo(change.position.x / size.width)
                    }
                },
            contentAlignment = Alignment.CenterStart,
        ) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(2.dp)
                    .background(centraidColor("stageLine")),
            )
            Box(
                Modifier
                    .fillMaxWidth(fraction.coerceIn(0f, 1f))
                    .height(2.dp)
                    .background(ink),
            )
        }
        Text(
            text = mediaClock(player.position) + " / " + mediaClock(player.duration),
            color = soft,
            style = centraidType("mono"),
        )
    }
}

/**
 * THE FILMSTRIP — v0's `PhotoFilmstrip`, 58 high: the current frame at 58 with
 * a 2-wide outline, its neighbours at 40, 2 apart. The swipe and the strip are
 * one control from two directions: the swipe is fast, the strip says where a
 * member is and lets them jump.
 */
@Composable
internal fun LightboxFilmstrip(state: PhotoLightboxState, onEvent: (PhotoLightboxEvent) -> Unit) {
    val window = PhotoLightboxMachine.filmWindow(state)
    if (window.size <= 1) return
    val frames = remember(state.film) { state.film.associateBy { it.asset_id } }
    val list = rememberLazyListState()
    val current = window.indexOf(state.asset_id)
    val total = state.neighbour_asset_ids.size
    val offset = state.neighbour_asset_ids.indexOf(window.first())
    // PAGING MOVES THE STRIP TOO, or the two controls disagree about where
    // the member is.
    LaunchedEffect(current, window.first()) {
        if (current >= 0) list.animateScrollToItem(maxOf(0, current - 3))
    }
    LazyRow(
        state = list,
        modifier = Modifier
            .fillMaxWidth()
            .height(FILMSTRIP_HEIGHT.dp)
            .semantics { contentDescription = "Filmstrip" },
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        itemsIndexed(window, key = { _, id -> id }) { index, id ->
            val here = id == state.asset_id
            val side = if (here) FILMSTRIP_HEIGHT else FILMSTRIP_NEIGHBOUR
            Box(
                Modifier
                    .size(side.dp)
                    .clip(RoundedCornerShape(0.dp))
                    .background(centraidColor("skel"))
                    .then(
                        if (here) Modifier.border(2.dp, centraidColor("onStage")) else Modifier,
                    )
                    .semantics {
                        role = Role.Button
                        selected = here
                        contentDescription = "Show photograph ${offset + index + 1} of $total"
                    }
                    .clickable {
                        if (!here) onEvent(PhotoLightboxEvent(moved = PhotoLightboxEvent.Moved(id)))
                    },
            ) {
                frames[id]?.thumbnail_path?.let { path ->
                    val bitmap by produceState<ImageBitmap?>(initialValue = null, path) {
                        value = withContext(Dispatchers.IO) {
                            decodeUpright(path, maxDimension = FILM_DECODE)?.asImageBitmap()
                        }
                    }
                    bitmap?.let {
                        Image(
                            bitmap = it,
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }
            }
        }
    }
}

/** A Live Photo's own control: the word, and the movie it plays. */
@Composable
internal fun LiveChip(live: LightboxPlayer) {
    val ink = centraidColor("onStage")
    Row(
        modifier = Modifier
            .height(28.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(centraidColor("stageSunken"))
            .clickable { live.playFromStart() }
            .padding(horizontal = 10.dp)
            .semantics(mergeDescendants = true) {
                role = Role.Button
                contentDescription = "Play Live Photo"
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        CentraidIcon(iconKey = "Play", tint = ink, size = 14.dp)
        Text(text = "Live", color = ink, style = centraidType("small"), textAlign = TextAlign.Center)
    }
}

/** `1:01:40`, with an hours arm — `lightboxClock`'s rule, in milliseconds. */
internal fun mediaClock(milliseconds: Long): String = lightboxClock((milliseconds / 1_000L).toInt())

private enum class Gesture { UNDECIDED, PAGE, DISMISS, PAN, ZOOM, NONE }

/** v0's `ZOOM_FIT`, `ZOOM_RUNG` and `ZOOM_MAX`. */
private const val ZOOM_FIT = 1f
private const val ZOOM_RUNG = 2.5f
private const val ZOOM_MAX = 5f

/** A fifth of the stage is a page turn; less springs back. */
private const val PAGE_THRESHOLD = 0.2f

/** How far down a swipe has to travel before it is a close. */
private const val DISMISS_DISTANCE = 120

/** The longest edge an original is decoded at: a zoomed phone screen's worth. */
private const val FULL_DECODE = 4096
private const val FILM_DECODE = 160

internal const val FILMSTRIP_HEIGHT = 58
private const val FILMSTRIP_NEIGHBOUR = 40

private const val POLL_MS = 200L

/** The state-change curve, `--ease` at `--dur-1` — the one this screen moves on. */
private val STATE_CHANGE = tween<Float>(
    durationMillis = CentraidGeometry.DURATION_ONE,
    easing = CubicBezierEasing(0.3f, 0f, 0.4f, 1f),
)
private val FADE = tween<Float>(
    durationMillis = CentraidGeometry.DURATION_ONE,
    easing = CubicBezierEasing(0.3f, 0f, 0.4f, 1f),
)
