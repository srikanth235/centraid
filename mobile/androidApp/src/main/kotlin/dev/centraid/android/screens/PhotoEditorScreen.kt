package dev.centraid.android.screens

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import centraid.screen.v1.PhotoDetail
import centraid.screen.v1.PhotoEditPlan
import centraid.screen.v1.PhotoEditSource
import centraid.screen.v1.PhotoEditorEvent
import centraid.screen.v1.PhotoEditorState
import centraid.screen.v1.PhotoLightboxState
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.shared.apps.photos.PhotoEditorMachine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * THE PHOTO EDITOR — crop, rotate, straighten, flip (#1029, photos port).
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotoEditorView.swift`; the two
 * are kept in step by hand. Everything this view says is reduced by
 * [PhotoEditorMachine] — the status line, the two live labels, the refusal —
 * and everything it draws is the plan on that state. What is this file's own is
 * the GEOMETRY of the stage and the gesture's translation into fractions: the
 * reducer has no image and cannot know how wide the frame is.
 *
 * ## Mode, not a page
 *
 * v0's editor was a mode over the lightbox, so the photograph never unmounted.
 * It is a route here because it has a machine of its own, and it keeps the
 * mode's promise another way: the lightbox stays under it on the stack, and
 * Cancel lands on the same photograph, in the same place.
 *
 * ## The stage
 *
 * `stage` is its own ground and the same literal in both themes, for the
 * lightbox's reason. The crop's four mask panes are the STAGE colour with alpha
 * on the colour — v0's `maskFill` — and never `alpha` on a container.
 */
@Composable
public fun PhotoEditorScreen(
    state: PhotoEditorState,
    onEvent: (PhotoEditorEvent) -> Unit,
    /** The member left without saving. The shell pops. */
    onClose: () -> Unit,
    /** The new photograph is in the vault. The shell opens it. */
    onSaved: (assetId: String) -> Unit,
) {
    val ink = centraidColor("onStage")
    val soft = centraidColor("onStageSoft")
    // BACK IS CANCEL, and Cancel asks first when there is something to lose.
    // A system gesture that bypassed the question would make the question
    // decorative.
    // ALWAYS ENABLED, and inert while a save runs: a back that fell through
    // to the shell's own handler mid-save would pop an editor whose render is
    // still in flight.
    BackHandler {
        if (state.phase == PhotoEditorState.Phase.PHASE_EDITING) {
            onEvent(PhotoEditorEvent(cancel = PhotoEditorEvent.CancelRequested()))
        }
    }
    // THE MACHINE SAYS WHEN TO LEAVE; the shell does the leaving.
    //
    // ARMED ONLY ONCE THIS SCREEN HAS SEEN THE EDITOR EDITING. The host
    // outlives the route, so the first frame of a second edit can still carry
    // the LAST one's `CLOSED` or `SAVED` — and acting on it would pop the
    // editor the member just opened, before `Opened` had reset it.
    var armed by remember { mutableStateOf(false) }
    LaunchedEffect(state.phase, state.saved_asset_id) {
        if (state.phase == PhotoEditorState.Phase.PHASE_EDITING) {
            armed = true
            return@LaunchedEffect
        }
        if (!armed) return@LaunchedEffect
        when (state.phase) {
            PhotoEditorState.Phase.PHASE_SAVED -> onSaved(state.saved_asset_id)
            PhotoEditorState.Phase.PHASE_CLOSED -> onClose()
            else -> Unit
        }
    }
    val loading = state.loading
    val failure = state.failure
    val source = state.source
    Box(modifier = Modifier.fillMaxSize().background(centraidColor("stage"))) {
        when {
            // A STALE STATE FROM THE LAST EDIT IS NOT DRAWN: until this screen
            // has seen its own editor, it is loading.
            loading != null || !armed -> CircularProgressIndicator(Modifier.align(Alignment.Center))

            failure != null -> Column(
                modifier = Modifier.align(Alignment.Center).padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                ScreenFailure(sentence = failure.sentence, remedy = failure.remedy)
                TextButton(
                    onClick = {
                        onEvent(PhotoEditorEvent(cancel = PhotoEditorEvent.CancelRequested()))
                    },
                ) { Text(text = PhotoEditorMachine.EDITOR_CANCEL, color = ink) }
            }

            source != null -> Editor(state, source, onEvent, ink, soft)
        }
    }
    if (state.discard_open) {
        AlertDialog(
            onDismissRequest = {
                onEvent(PhotoEditorEvent(discard = PhotoEditorEvent.DiscardAnswered(false)))
            },
            title = { Text(text = PhotoEditorMachine.DISCARD_QUESTION) },
            confirmButton = {
                TextButton(
                    onClick = {
                        onEvent(PhotoEditorEvent(discard = PhotoEditorEvent.DiscardAnswered(true)))
                    },
                ) { Text(text = PhotoEditorMachine.DISCARD, color = centraidColor("net")) }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        onEvent(PhotoEditorEvent(discard = PhotoEditorEvent.DiscardAnswered(false)))
                    },
                ) { Text(text = PhotoEditorMachine.KEEP_EDITING) }
            },
        )
    }
}

@Composable
private fun Editor(
    state: PhotoEditorState,
    source: PhotoEditSource,
    onEvent: (PhotoEditorEvent) -> Unit,
    ink: Color,
    soft: Color,
) {
    val plan = state.plan ?: PhotoEditorMachine.FRESH_PLAN
    val editing = state.phase == PhotoEditorState.Phase.PHASE_EDITING
    // THE ORIGINAL WHEN IT IS HERE — it is what Save renders — and the
    // thumbnail when it is not, so the stage is never a broken image.
    val path = source.original_path?.takeIf { it.isNotEmpty() }
        ?: source.thumbnail_path?.takeIf { it.isNotEmpty() }
    val preview by produceState<ImageBitmap?>(initialValue = null, path) {
        value = path?.let { withContext(Dispatchers.IO) { PhotoEditRenderer.preview(it) } }
    }
    Column(modifier = Modifier.fillMaxSize().padding(vertical = 8.dp)) {
        // THE STAMP: what this is and where it came from. WHEN outranks WHAT,
        // as on the lightbox.
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(text = PhotoEditorMachine.EDITOR_TITLE, color = ink, style = centraidType("control"))
            Text(text = editorMeta(source.captured_at, source.captured_utc_offset_minutes ?: 0), color = soft, style = centraidType("small"))
        }
        BoxWithConstraints(
            modifier = Modifier.fillMaxWidth().weight(1f).padding(16.dp),
            contentAlignment = Alignment.Center,
        ) {
            val image = preview
            if (image == null) {
                Text(
                    text = if (path == null) {
                        "This photograph is not on this device yet."
                    } else {
                        PhotoEditorMachine.EDITOR_TITLE
                    },
                    color = soft,
                    style = centraidType("small"),
                    textAlign = TextAlign.Center,
                )
            } else {
                Stage(image, plan, editing, maxWidth.value, maxHeight.value, onEvent, ink)
            }
        }
        // THE ROTATED FRAME'S SHAPE, for a centred ratio crop. The stage is the
        // one thing that has measured the photograph — oriented, as drawn — and
        // the reducer has no image, so the ratio chips carry it. Zero before
        // the preview lands, which the reducer answers with the whole frame.
        val sourceRatio = preview?.let { it.width.toDouble() / it.height.coerceAtLeast(1) } ?: 0.0
        val frameRatio = if (sourceRatio > 0.0) {
            PhotoEditorMachine.rotatedFrameRatio(sourceRatio, PhotoEditorMachine.totalRotation(plan))
        } else {
            0.0
        }
        EditBar(state, plan, editing, frameRatio, onEvent, ink, soft)
    }
}

/**
 * THE PHOTOGRAPH, ITS FRAME AND THE CROP OVER IT.
 *
 * The frame is the ROTATED box fitted into the space: straighten grows it
 * rather than swapping its sides, and the crop is in fractions of it. The image
 * is drawn at its unrotated size inside that frame and turned about its centre,
 * FLIP FIRST AND ROTATION SECOND — the order the renderer draws in, so the
 * stage and the saved pixels are one picture.
 */
@Composable
private fun Stage(
    image: ImageBitmap,
    plan: PhotoEditPlan,
    editing: Boolean,
    maxWidthDp: Float,
    maxHeightDp: Float,
    onEvent: (PhotoEditorEvent) -> Unit,
    ink: Color,
) {
    val rotation = PhotoEditorMachine.totalRotation(plan)
    val sourceRatio = image.width.toDouble() / image.height.coerceAtLeast(1)
    val frameRatio = PhotoEditorMachine.rotatedFrameRatio(sourceRatio, rotation)
    val (frameW, frameH) = if (maxWidthDp / maxHeightDp.coerceAtLeast(1f) > frameRatio) {
        Pair((maxHeightDp * frameRatio).toFloat(), maxHeightDp)
    } else {
        Pair(maxWidthDp, (maxWidthDp / frameRatio).toFloat())
    }
    val unrotated = PhotoEditorMachine.rotatedBox(sourceRatio, 1.0, rotation)
    val scale = if (unrotated.first > 0) frameW / unrotated.first.toFloat() else 0f
    val imageW = (sourceRatio * scale).toFloat()
    val imageH = scale
    val crop = plan.crop ?: PhotoEditorMachine.FULL_CROP
    val density = LocalDensity.current
    val framePx = with(density) { Size(frameW.dp.toPx(), frameH.dp.toPx()) }
    val mask = centraidColor("stage").copy(alpha = MASK_ALPHA)
    val thirds = centraidColor("stageLine")
    val flipX = if (plan.flip == PhotoEditPlan.Flip.FLIP_HORIZONTAL) -1f else 1f
    val flipY = if (plan.flip == PhotoEditPlan.Flip.FLIP_VERTICAL) -1f else 1f
    Box(
        modifier = Modifier
            .size(frameW.dp, frameH.dp)
            .semantics {
                contentDescription = "Crop area"
                stateDescription = "Drag to move the crop, pinch to resize it"
                // NOTHING IS REACHABLE BY GESTURE ALONE (§15). The drag and the
                // pinch have spoken equivalents, one step at a time.
                if (editing) customActions = cropActions(onEvent)
            }
            .pointerInput(framePx, editing) {
                if (!editing) return@pointerInput
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    var zoom = 1f
                    var travelled = Offset.Zero
                    var dragging = false
                    do {
                        val event = awaitPointerEvent()
                        val pressed = event.changes.count { it.pressed }
                        if (pressed >= 2) {
                            zoom *= event.calculateZoom()
                        } else if (pressed == 1 && zoom == 1f) {
                            val pan = event.calculatePan()
                            travelled += pan
                            // v0's `minDistance(4)`, as the platform's own slop:
                            // a tap is not a drag of two pixels.
                            if (!dragging && travelled.getDistance() > viewConfiguration.touchSlop) {
                                dragging = true
                            }
                            if (dragging && pan != Offset.Zero && framePx.width > 0f) {
                                onEvent(
                                    PhotoEditorEvent(
                                        crop_moved = PhotoEditorEvent.CropMoved(
                                            dx = (pan.x / framePx.width).toDouble(),
                                            dy = (pan.y / framePx.height).toDouble(),
                                        ),
                                    ),
                                )
                            }
                        }
                        event.changes.forEach { if (it.positionChanged()) it.consume() }
                    } while (event.changes.any { it.pressed })
                    // ONCE PER PINCH, with the total factor: rescaling per frame
                    // drifts. Pinching apart shrinks the crop's share of the
                    // frame, so the factor is inverted — v0's rule.
                    if (zoom != 1f && zoom > 0f) {
                        onEvent(
                            PhotoEditorEvent(
                                crop_scaled = PhotoEditorEvent.CropScaled(factor = 1.0 / zoom),
                            ),
                        )
                    }
                }
            },
    ) {
        Image(
            bitmap = image,
            contentDescription = null, // decorative: the crop area carries the label
            contentScale = ContentScale.FillBounds,
            modifier = Modifier
                .offset(((frameW - imageW) / 2).dp, ((frameH - imageH) / 2).dp)
                .size(imageW.dp, imageH.dp)
                .graphicsLayer {
                    scaleX = flipX
                    scaleY = flipY
                    rotationZ = rotation.toFloat()
                },
        )
        Canvas(modifier = Modifier.size(frameW.dp, frameH.dp)) {
            val w = size.width
            val h = size.height
            val left = (crop.x * w).toFloat()
            val top = (crop.y * h).toFloat()
            val boxW = (crop.w * w).toFloat()
            val boxH = (crop.h * h).toFloat()
            // FOUR PANES, not a punched hole: the same shape v0 drew, and the
            // one that reads the same under every renderer.
            drawRect(mask, Offset(0f, 0f), Size(w, top))
            drawRect(mask, Offset(0f, top + boxH), Size(w, h - top - boxH))
            drawRect(mask, Offset(0f, top), Size(left, boxH))
            drawRect(mask, Offset(left + boxW, top), Size(w - left - boxW, boxH))
            // THE THIRDS, in the stage's own hairline, and the box in its ink.
            for (step in 1..2) {
                val x = left + boxW * step / 3f
                val y = top + boxH * step / 3f
                drawLine(thirds, Offset(x, top), Offset(x, top + boxH), strokeWidth = 1.dp.toPx())
                drawLine(thirds, Offset(left, y), Offset(left + boxW, y), strokeWidth = 1.dp.toPx())
            }
            drawRect(ink, Offset(left, top), Size(boxW, boxH), style = Stroke(width = 1.dp.toPx()))
        }
    }
}

/** The spoken equivalents of the drag and the pinch. */
private fun cropActions(onEvent: (PhotoEditorEvent) -> Unit): List<CustomAccessibilityAction> {
    fun move(label: String, dx: Double, dy: Double) = CustomAccessibilityAction(label) {
        onEvent(PhotoEditorEvent(crop_moved = PhotoEditorEvent.CropMoved(dx = dx, dy = dy)))
        true
    }
    fun scale(label: String, factor: Double) = CustomAccessibilityAction(label) {
        onEvent(PhotoEditorEvent(crop_scaled = PhotoEditorEvent.CropScaled(factor = factor)))
        true
    }
    return listOf(
        move("Move crop left", -STEP, 0.0),
        move("Move crop right", STEP, 0.0),
        move("Move crop up", 0.0, -STEP),
        move("Move crop down", 0.0, STEP),
        scale("Make crop larger", GROW),
        scale("Make crop smaller", 1.0 / GROW),
    )
}

/**
 * TOOLS, SENTENCE AND COMMITS SHARE THIS BAR — v0's `editBar`.
 *
 * The tools are two rows that scroll sideways rather than one that wraps: the
 * transforms and the ratios are two questions, and a row that reflows as
 * "Straighten 0°" becomes "Straighten −12°" is a row that moves under the
 * member's thumb.
 */
@Composable
private fun EditBar(
    state: PhotoEditorState,
    plan: PhotoEditPlan,
    editing: Boolean,
    frameRatio: Double,
    onEvent: (PhotoEditorEvent) -> Unit,
    ink: Color,
    soft: Color,
) {
    val line = centraidColor("stageLine")
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            // "CROP" IS ALWAYS SELECTED: it is the mode this editor is in, and
            // pressing it returns the crop to the whole frame (v0).
            Tool("Crop", selected = true, enabled = editing, ink, soft, line) {
                onEvent(ratioEvent(PhotoEditPlan.Ratio.RATIO_ORIGINAL, 0.0))
            }
            Tool("Rotate 90°", selected = false, enabled = editing, ink, soft, line) {
                onEvent(PhotoEditorEvent(rotate = PhotoEditorEvent.RotateRequested()))
            }
            Tool(state.straighten_label, selected = false, enabled = editing, ink, soft, line) {
                onEvent(PhotoEditorEvent(straighten = PhotoEditorEvent.StraightenStepped()))
            }
            Tool(
                state.flip_label,
                selected = plan.flip != PhotoEditPlan.Flip.FLIP_UNSPECIFIED,
                enabled = editing,
                ink,
                soft,
                line,
            ) {
                onEvent(PhotoEditorEvent(flip = PhotoEditorEvent.FlipCycled()))
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            listOf(
                PhotoEditPlan.Ratio.RATIO_ORIGINAL,
                PhotoEditPlan.Ratio.RATIO_SQUARE,
                PhotoEditPlan.Ratio.RATIO_THREE_TWO,
            ).forEach { ratio ->
                Tool(
                    PhotoEditorMachine.ratioName(ratio),
                    // ORIGINAL IS NEVER DRAWN SELECTED, as in v0: it is the
                    // absence of a ratio, and "Crop" already says what mode
                    // this is.
                    selected = plan.ratio == ratio && ratio != PhotoEditPlan.Ratio.RATIO_ORIGINAL,
                    enabled = editing,
                    ink,
                    soft,
                    line,
                ) {
                    onEvent(ratioEvent(ratio, frameRatio))
                }
            }
            Tool("Reset", selected = false, enabled = editing && state.edited, ink, soft, line) {
                onEvent(PhotoEditorEvent(reset = PhotoEditorEvent.ResetRequested()))
            }
        }
        Text(
            text = PhotoEditorMachine.SAVE_AS_NEW_EXPLANATION,
            color = soft,
            style = centraidType("small"),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Tool(PhotoEditorMachine.EDITOR_CANCEL, selected = false, enabled = editing, ink, soft, line) {
                onEvent(PhotoEditorEvent(cancel = PhotoEditorEvent.CancelRequested()))
            }
            Commit(state, editing, onEvent, ink, soft, line)
        }
        // THE REFUSAL IS VISIBLE TEXT, never only an accessibility hint (v0's
        // §6/§18) — and a save that did not land says so in the same place.
        val failure = state.save_failure
        val refusal = when {
            failure != null && failure.sentence.isNotEmpty() ->
                listOf(failure.sentence, failure.remedy).filter { it.isNotEmpty() }.joinToString(" ")
            else -> state.save_refusal
        }
        if (refusal.isNotEmpty()) {
            Text(text = refusal, color = ink, style = centraidType("small"))
        }
        // THE ONE STATUS LINE, and it says "nothing written yet" until
        // something is.
        Text(
            text = state.status_line,
            color = soft,
            style = centraidType("mono"),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * THE ONE FILLED ELEMENT. A commit that cannot fire is OUTLINED, never a
 * dimmed fill (DESIGN.md invariant 3), and says why beneath.
 */
@Composable
private fun Commit(
    state: PhotoEditorState,
    editing: Boolean,
    onEvent: (PhotoEditorEvent) -> Unit,
    ink: Color,
    soft: Color,
    line: Color,
) {
    val live = editing && state.save_refusal.isEmpty()
    val shape = RoundedCornerShape(radius("md").dp)
    Box(
        modifier = Modifier
            .heightIn(min = TARGET.dp)
            .clip(shape)
            .then(if (live) Modifier.background(ink) else Modifier.border(1.dp, line, shape))
            .clickable(enabled = live, role = Role.Button) {
                onEvent(PhotoEditorEvent(save = PhotoEditorEvent.SaveRequested()))
            }
            .semantics {
                contentDescription = PhotoEditorMachine.SAVE_AS_NEW
                if (!live) disabled()
            }
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = PhotoEditorMachine.SAVE_AS_NEW,
            color = if (live) centraidColor("stage") else soft,
            style = centraidType("control"),
        )
    }
}

@Composable
private fun Tool(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    ink: Color,
    soft: Color,
    line: Color,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(radius("md").dp)
    Box(
        modifier = Modifier
            .heightIn(min = TARGET.dp)
            .clip(shape)
            .border(1.dp, if (selected) ink else line, shape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics {
                contentDescription = label
                this.selected = selected
            }
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = label, color = if (enabled) ink else soft, style = centraidType("control"))
    }
}

/**
 * THE EDIT BUTTON ON THE LIGHTBOX'S BAR (#1029, photos port).
 *
 * It lives HERE, beside the screen it opens, so the lightbox carries one line
 * for it and no knowledge of the editor. The route is handed down through
 * [LocalPhotoEditOpener] by the composition root, which is the only file that
 * may name a destination.
 *
 * Live, or refused with the sentence [PhotoEditorMachine.editRefusal] gives —
 * a video, or an original this phone does not hold yet. The lightbox's own
 * status line already carries "Load the original" for the second.
 */
@Composable
internal fun PhotoEditButton(state: PhotoLightboxState, detail: PhotoDetail, ink: Color, soft: Color) {
    val open = LocalPhotoEditOpener.current
    val refusal = PhotoEditorMachine.editRefusal(detail)
    val enabled = refusal == null && open != null
    IconButton(
        onClick = { open?.invoke(detail.asset_id, state.neighbour_asset_ids) },
        enabled = enabled,
        modifier = Modifier.size(48.dp),
    ) {
        CentraidIcon(
            iconKey = "Sliders",
            tint = if (enabled) ink else soft,
            size = 24.dp,
            modifier = Modifier.semantics {
                contentDescription = "Edit"
                if (refusal != null) stateDescription = refusal
            },
        )
    }
}

/**
 * WHERE "EDIT" GOES. Provided by `MainActivity` around the lightbox; absent
 * (a preview, a fixture) means the button draws refused rather than live over
 * nothing.
 */
public val LocalPhotoEditOpener: androidx.compose.runtime.ProvidableCompositionLocal<
    ((assetId: String, neighbours: List<String>) -> Unit)?,
    > = staticCompositionLocalOf { null }

private fun ratioEvent(ratio: PhotoEditPlan.Ratio, frameRatio: Double): PhotoEditorEvent =
    PhotoEditorEvent(ratio = PhotoEditorEvent.RatioChosen(ratio = ratio, frame_ratio = frameRatio))

/**
 * "from a photograph taken 30 July 2026" — v0's `editorMeta`, and "from a
 * photograph" when the row records no time. The day is the one the shutter
 * fired on, in the capture's own zone, so it names the day the Library and the
 * viewer file the photograph under; no offset is UTC, as there.
 */
private fun editorMeta(capturedAt: String, offsetMinutes: Int): String {
    if (capturedAt.length < 19) return "from a photograph"
    val parsed = runCatching {
        java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US).apply {
            timeZone = java.util.TimeZone.getTimeZone("UTC")
        }.parse(capturedAt.substring(0, 19))
    }.getOrNull() ?: return "from a photograph"
    val zone = java.util.TimeZone.getTimeZone("UTC").apply { rawOffset = offsetMinutes * 60_000 }
    return "from a photograph taken " +
        java.text.DateFormat.getDateInstance(java.text.DateFormat.LONG).apply { timeZone = zone }.format(parsed)
}

@Composable
private fun radius(name: String): Int = LocalCentraidTokens.current.radii[name] ?: 0

/** v0's `maskFill`: the stage colour at `8C` — alpha on the colour, never on the pane. */
private const val MASK_ALPHA: Float = 0x8C / 255f

/** The coarse target floor (DESIGN.md: 44 on touch). */
private const val TARGET: Int = 44

/** One spoken step of the crop: a twentieth of the frame. */
private const val STEP: Double = 0.05

/** One spoken pinch. */
private const val GROW: Double = 1.1

/**
 * THE ANDROID HALF OF v0's `photo-edit-save.ts`: decode, draw, encode.
 *
 * On the platform because decoding a photograph is platform I/O; what happens
 * to the JPEG afterwards — staging and the commit — is `PhotoEditorBridge`'s,
 * and is the camera roll's own path.
 */
internal object PhotoEditRenderer {
    /** A stage-sized decode, oriented. Never the full original: that is for Save. */
    fun preview(path: String): ImageBitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= PREVIEW_EDGE) sample *= 2
        val bitmap = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: return null
        return oriented(bitmap, path).asImageBitmap()
    }

    /** What [render] made, or why it could not. */
    sealed interface Rendered {
        data class Made(val path: String, val width: Int, val height: Int) : Rendered

        data class Refused(val sentence: String) : Rendered
    }

    /**
     * FLIP, ROTATE, THEN CROP — the crop is in fractions of the ROTATED frame
     * (v0's `renderEdit`), and the order is the stage's, so what is saved is
     * what was on screen.
     *
     * JPEG at 0.92, v0's quality and the web editor's, so the two surfaces
     * write the same file for the same edit.
     */
    fun render(cacheDir: java.io.File, sourcePath: String, planBytes: ByteArray): Rendered {
        val plan = runCatching { PhotoEditPlan.ADAPTER.decode(planBytes) }.getOrNull()
            ?: return Rendered.Refused(COULD_NOT_DRAW)
        val decoded = try {
            BitmapFactory.decodeFile(sourcePath)
        } catch (tooLarge: OutOfMemoryError) {
            null
        } ?: return Rendered.Refused("Centraid could not open the original.")
        return try {
            val source = oriented(decoded, sourcePath)
            val rotation = PhotoEditorMachine.totalRotation(plan).toFloat()
            val matrix = Matrix().apply {
                postScale(
                    if (plan.flip == PhotoEditPlan.Flip.FLIP_HORIZONTAL) -1f else 1f,
                    if (plan.flip == PhotoEditPlan.Flip.FLIP_VERTICAL) -1f else 1f,
                    source.width / 2f,
                    source.height / 2f,
                )
                postRotate(rotation, source.width / 2f, source.height / 2f)
            }
            val turned = if (matrix.isIdentity) {
                source
            } else {
                Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
            }
            val crop = PhotoEditorMachine.clampCrop(plan.crop ?: PhotoEditorMachine.FULL_CROP)
            val cropped = if (crop.w >= 1.0 && crop.h >= 1.0) {
                turned
            } else {
                val (x, y, w, h) = PhotoEditorMachine.cropPixels(crop, turned.width, turned.height).toList()
                Bitmap.createBitmap(turned, x, y, w, h)
            }
            val file = java.io.File(cacheDir, "edit-" + java.util.UUID.randomUUID() + ".jpg")
            file.outputStream().use { out ->
                if (!cropped.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)) {
                    return Rendered.Refused(COULD_NOT_DRAW)
                }
            }
            Rendered.Made(file.absolutePath, cropped.width, cropped.height)
        } catch (tooLarge: OutOfMemoryError) {
            Rendered.Refused(COULD_NOT_DRAW)
        }
    }

    /**
     * THE CAMERA'S OWN TURN, applied before anything the member did. A
     * photograph whose pixels are stored sideways with an EXIF orientation
     * beside them would otherwise be cropped by a rectangle drawn on the
     * upright stage and cut from the sideways bytes.
     */
    private fun oriented(bitmap: Bitmap, path: String): Bitmap {
        val orientation = runCatching {
            android.media.ExifInterface(path).getAttributeInt(
                android.media.ExifInterface.TAG_ORIENTATION,
                android.media.ExifInterface.ORIENTATION_NORMAL,
            )
        }.getOrDefault(android.media.ExifInterface.ORIENTATION_NORMAL)
        val matrix = Matrix()
        when (orientation) {
            android.media.ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
            android.media.ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
            android.media.ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
            android.media.ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.setRotate(90f)
                matrix.postScale(-1f, 1f)
            }
            android.media.ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
            android.media.ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.setRotate(-90f)
                matrix.postScale(-1f, 1f)
            }
            android.media.ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
            else -> return bitmap
        }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    private const val PREVIEW_EDGE: Int = 2048
    private const val JPEG_QUALITY: Int = 92
    private const val COULD_NOT_DRAW: String = "Centraid could not draw the edit."
}

/**
 * THE SHELL'S HALF OF THE SAVE, installed once per bridge (#1029, photos
 * port). Off the main thread, because a full-size decode is hundreds of
 * milliseconds; the bridge takes the file from there — and the original's
 * date, place and caption with it, so no clock is read here.
 */
public fun installPhotoEditRenderer(
    bridge: dev.centraid.shared.apps.photos.PhotoEditorBridge,
    cacheDir: java.io.File,
) {
    bridge.onRender = { key, sourcePath, plan ->
        CoroutineScope(Dispatchers.Default).launch {
            when (val made = PhotoEditRenderer.render(cacheDir, sourcePath, plan)) {
                is PhotoEditRenderer.Rendered.Made ->
                    bridge.rendered(key = key, path = made.path, width = made.width, height = made.height)
                is PhotoEditRenderer.Rendered.Refused -> bridge.renderRefused(key, made.sentence)
            }
        }
    }
}
