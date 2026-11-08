package dev.centraid.android.screens.photos

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import dev.centraid.android.kit.KitSegmented
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.kitTextStyle
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.produceState
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
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import androidx.compose.ui.text.font.FontWeight
import dev.centraid.design.CentraidScale
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.kit.StageSpinner
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

import centraid.core.v1.PhotosEditCrop
import centraid.core.v1.PhotosEditPlan
import centraid.core.v1.PhotosEditorData
import centraid.core.v1.PhotosEditorEvent
import centraid.core.v1.PhotosEditorState
import centraid.core.v1.PhotosEditorWords
import centraid.core.v1.Route
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/**
 * THE PHOTO EDITOR (#1135): `photos.editor`, drawn. Crop, rotate, straighten,
 * flip. Everything this says is Rust's: the status line, the two live labels, the
 * refusal and the ratio names. What is this file's own is the GEOMETRY of the
 * stage and the gesture's translation into fractions: Rust has no image and
 * cannot know how wide the frame is. The SwiftUI twin is `PhotosEditorView.swift`.
 *
 * `stage` is its own ground and the same literal in both themes, for the
 * lightbox's reason. The crop's four mask panes are the STAGE colour with alpha
 * on the colour (v0's `maskFill`), never `alpha` on a container.
 */
@Composable
public fun PhotosEditorScreen(
    state: PhotosEditorState,
    onEvent: (PhotosEditorEvent) -> Unit,
    /** The member left without saving. The shell pops. */
    onClose: () -> Unit,
    /** The new photograph is in the vault. The shell pops and opens it. */
    onSaved: (Route) -> Unit,
) {
    // THE PAGE IS THE CARD PAGE (#1173); only the photograph's own ground is the stage.
    val ink = Surface.ink
    val soft = Surface.meta
    val words = state.words ?: PhotosEditorWords()
    // BACK IS CANCEL, and Cancel asks first when there is something to lose. It
    // is inert while a save runs: a back that fell through mid-save would pop an
    // editor whose render is still in flight.
    BackHandler {
        if (state.phase == PhotosEditorState.Phase.PHASE_EDITING) {
            onEvent(PhotosEditorEvent(cancel = PhotosEditorEvent.Cancelled()))
        }
    }
    // RUST SAYS WHEN TO LEAVE; the shell does the leaving.
    LaunchedEffect(state.dismissed) {
        if (state.dismissed) {
            val saved = state.saved_route
            if (saved != null) onSaved(saved) else onClose()
        }
    }
    val loading = state.loading
    val failure = state.failure
    val data = state.data_
    Box(modifier = Modifier.fillMaxSize().background(Surface.page)) {
        when {
            loading != null -> StageSpinner(modifier = Modifier.align(Alignment.Center))

            failure != null -> Column(
                modifier = Modifier.align(Alignment.Center).padding(KitGeometry.GUTTER),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                ScreenFailure(sentence = failure.sentence, remedy = failure.remedy)
                OutlineButton(
                    label = words.cancel,
                    testTag = "editor-failure-cancel",
                    ink = "text",
                    onPress = { onEvent(PhotosEditorEvent(cancel = PhotosEditorEvent.Cancelled())) },
                )
            }

            data != null -> Editor(state, data, words, onEvent, ink, soft)
        }
    }
    state.discard?.let { discard ->
        ConfirmSheet(
            confirm = discard,
            cancelLabel = words.cancel,
            onConfirm = { onEvent(PhotosEditorEvent(discard = PhotosEditorEvent.DiscardAnswered(discard = true))) },
            onDismiss = { onEvent(PhotosEditorEvent(discard = PhotosEditorEvent.DiscardAnswered(discard = false))) },
        )
    }
}

@Composable
private fun Editor(
    state: PhotosEditorState,
    data: PhotosEditorData,
    words: PhotosEditorWords,
    onEvent: (PhotosEditorEvent) -> Unit,
    ink: Color,
    soft: Color,
) {
    val plan = state.plan ?: PhotosEditPlan()
    val editing = state.phase == PhotosEditorState.Phase.PHASE_EDITING
    // THE ORIGINAL WHEN IT IS HERE (it is what Save renders) and the thumbnail
    // when it is not, so the stage is never a broken image.
    val path = data.original_path.takeIf { it.isNotEmpty() }
        ?: data.tile?.thumbnail_path?.takeIf { it.isNotEmpty() }
    val preview by produceState<ImageBitmap?>(initialValue = null, path) {
        value = path?.let { withContext(Dispatchers.IO) { PhotosEditRender.preview(it) } }
    }
    Column(modifier = Modifier.fillMaxSize().padding(vertical = 8.dp)) {
        // THE TOP BAR, as the board draws it: the way out, the one-line title and the commit.
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Tool(words.cancel, selected = false, enabled = editing, ink, soft, line = centraidColor("stageLine")) {
                onEvent(PhotosEditorEvent(cancel = PhotosEditorEvent.Cancelled()))
            }
            Text(
                text = state.title,
                color = ink,
                style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                textAlign = TextAlign.Center,
                maxLines = 1,
                modifier = Modifier.weight(1f),
            )
            Commit(state, words, editing, onEvent, ink, soft, centraidColor("stageLine"))
        }
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .padding(KitGeometry.GUTTER)
                .clip(RoundedCornerShape(CentraidScale.cardRadius.dp)),
            contentAlignment = Alignment.Center,
        ) {
            val image = preview
            if (image == null) {
                Text(
                    text = if (path == null) state.save_refusal else words.loading,
                    color = centraidColor("onStageSoft"),
                    style = centraidType("small"),
                    textAlign = TextAlign.Center,
                )
            } else {
                Stage(image, plan, editing, words, maxWidth.value, maxHeight.value, onEvent, centraidColor("onStage"))
            }
        }
        // THE BOARD'S LINE UNDER THE STAGE: how the crop is moved and resized.
        Text(
            text = words.crop_hint,
            color = soft,
            style = kitTextStyle(KitType.Meta),
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        )
        // THE ROTATED FRAME'S SHAPE, for a centred ratio crop. The stage is the
        // one thing that has measured the photograph, oriented, as drawn, so the
        // ratio chips carry it. Zero before the preview lands, which Rust answers
        // with the whole frame.
        val sourceRatio = preview?.let { it.width.toDouble() / it.height.coerceAtLeast(1) } ?: 0.0
        val frameRatio = if (sourceRatio > 0.0) rotatedFrameRatio(sourceRatio, totalRotation(plan)) else 0.0
        EditBar(state, data, words, editing, frameRatio, onEvent, ink, soft)
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
    plan: PhotosEditPlan,
    editing: Boolean,
    words: PhotosEditorWords,
        maxWidthDp: Float,
    maxHeightDp: Float,
    onEvent: (PhotosEditorEvent) -> Unit,
    ink: Color,
) {
    val rotation = totalRotation(plan)
    val sourceRatio = image.width.toDouble() / image.height.coerceAtLeast(1)
    val frameRatio = rotatedFrameRatio(sourceRatio, rotation)
    val (frameW, frameH) = if (maxWidthDp / maxHeightDp.coerceAtLeast(1f) > frameRatio) {
        Pair((maxHeightDp * frameRatio).toFloat(), maxHeightDp)
    } else {
        Pair(maxWidthDp, (maxWidthDp / frameRatio).toFloat())
    }
    val unrotated = rotatedBox(sourceRatio, 1.0, rotation)
    val scale = if (unrotated.first > 0) frameW / unrotated.first.toFloat() else 0f
    val imageW = (sourceRatio * scale).toFloat()
    val imageH = scale
    val crop = plan.crop ?: PhotosEditCrop(x = 0.0, y = 0.0, w = 1.0, h = 1.0)
    val density = LocalDensity.current
    val framePx = with(density) { Size(frameW.dp.toPx(), frameH.dp.toPx()) }
    val mask = centraidColor("stage").copy(alpha = MASK_ALPHA)
    val thirds = centraidColor("stageLine")
    val flipX = if (plan.flip == PhotosEditPlan.Flip.FLIP_HORIZONTAL) -1f else 1f
    val flipY = if (plan.flip == PhotosEditPlan.Flip.FLIP_VERTICAL) -1f else 1f
    Box(
        modifier = Modifier
            .size(frameW.dp, frameH.dp)
            .semantics {
                contentDescription = words.crop_area
                stateDescription = words.crop_hint
                // NOTHING IS REACHABLE BY GESTURE ALONE (§15). The drag and the
                // pinch have spoken equivalents, one step at a time.
                if (editing) customActions = cropActions(onEvent, words)
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
                                    PhotosEditorEvent(
                                        crop_moved = PhotosEditorEvent.CropMoved(
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
                            PhotosEditorEvent(
                                crop_scaled = PhotosEditorEvent.CropScaled(factor = 1.0 / zoom),
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
            val remaining = (crop.x * w).toFloat()
            val top = (crop.y * h).toFloat()
            val boxW = (crop.w * w).toFloat()
            val boxH = (crop.h * h).toFloat()
            // FOUR PANES, not a punched hole: the same shape v0 drew, and the
            // one that reads the same under every renderer.
            drawRect(mask, Offset(0f, 0f), Size(w, top))
            drawRect(mask, Offset(0f, top + boxH), Size(w, h - top - boxH))
            drawRect(mask, Offset(0f, top), Size(remaining, boxH))
            drawRect(mask, Offset(remaining + boxW, top), Size(w - remaining - boxW, boxH))
            // THE THIRDS, in the stage's own hairline, and the box in its ink.
            for (step in 1..2) {
                val x = remaining + boxW * step / 3f
                val y = top + boxH * step / 3f
                drawLine(thirds, Offset(x, top), Offset(x, top + boxH), strokeWidth = 1.dp.toPx())
                drawLine(thirds, Offset(remaining, y), Offset(remaining + boxW, y), strokeWidth = 1.dp.toPx())
            }
            drawRect(ink, Offset(remaining, top), Size(boxW, boxH), style = Stroke(width = 1.dp.toPx()))
        }
    }
}

/** The spoken equivalents of the drag and the pinch. */
private fun cropActions(onEvent: (PhotosEditorEvent) -> Unit, words: PhotosEditorWords): List<CustomAccessibilityAction> {
    fun move(label: String, dx: Double, dy: Double) = CustomAccessibilityAction(label) {
        onEvent(PhotosEditorEvent(crop_moved = PhotosEditorEvent.CropMoved(dx = dx, dy = dy)))
        true
    }
    fun scale(label: String, factor: Double) = CustomAccessibilityAction(label) {
        onEvent(PhotosEditorEvent(crop_scaled = PhotosEditorEvent.CropScaled(factor = factor)))
        true
    }
    return listOf(
        move(words.crop_left, -STEP, 0.0),
        move(words.crop_right, STEP, 0.0),
        move(words.crop_up, 0.0, -STEP),
        move(words.crop_down, 0.0, STEP),
        scale(words.crop_larger, GROW),
        scale(words.crop_smaller, 1.0 / GROW),
    )
}

/**
 * TOOLS, SENTENCE AND COMMITS SHARE THIS BAR. The tools are two rows that scroll
 * sideways rather than one that wraps: the transforms and the ratios are two
 * questions, and a row that reflows as "Straighten 0°" becomes "Straighten −12°"
 * moves under the member's thumb.
 */
@Composable
private fun EditBar(
    state: PhotosEditorState,
    data: PhotosEditorData,
    words: PhotosEditorWords,
    editing: Boolean,
    frameRatio: Double,
    onEvent: (PhotosEditorEvent) -> Unit,
    ink: Color,
    soft: Color,
) {
    val line = centraidColor("stageLine")
    val plan = state.plan ?: PhotosEditPlan()
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // THE SHAPE: one segmented control, the chosen one raised, and the sentence saying what
        // the photograph is now.
        val ratios = state.ratios
        KitSegmented(
            options = ratios.map { it.ratio.name to it.label },
            selected = ratios.firstOrNull { it.selected }?.ratio?.name ?: PhotosEditPlan.Ratio.RATIO_ORIGINAL.name,
            onSelect = { key ->
                val ratio = ratios.firstOrNull { it.ratio.name == key }?.ratio
                if (editing && ratio != null) onEvent(ratioEvent(ratio, frameRatio))
            },
        )
        if (state.status_line.isNotEmpty()) {
            Text(
                text = state.status_line,
                color = ink,
                style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
            )
        }
        // STRAIGHTEN is one degree a press (the core's step), on a card of its own.
        Text(
            text = state.straighten_label,
            color = if (editing) ink else soft,
            style = kitTextStyle(KitType.Row),
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(CentraidScale.cardRadius.dp))
                .background(Surface.card)
                .clickable(enabled = editing, role = Role.Button) {
                    onEvent(PhotosEditorEvent(straighten = PhotosEditorEvent.Straightened()))
                }
                .heightIn(min = 52.dp)
                .padding(horizontal = 16.dp, vertical = 15.dp),
        )
        // THE THREE KEYS, equal and white: turn, mirror, start over.
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.weight(1f)) {
                Tool(words.rotate, selected = false, enabled = editing, ink, soft, line, fill = true) {
                    onEvent(PhotosEditorEvent(rotate = PhotosEditorEvent.Rotated()))
                }
            }
            Box(Modifier.weight(1f)) {
                Tool(
                    state.flip_label,
                    selected = plan.flip != PhotosEditPlan.Flip.FLIP_UNSPECIFIED,
                    enabled = editing,
                    ink,
                    soft,
                    line,
                    fill = true,
                ) {
                    onEvent(PhotosEditorEvent(flip = PhotosEditorEvent.Flipped()))
                }
            }
            Box(Modifier.weight(1f)) {
                Tool(words.reset, selected = false, enabled = editing && state.edited, ink, soft, line, fill = true) {
                    onEvent(PhotosEditorEvent(reset = PhotosEditorEvent.Reset()))
                }
            }
        }
        Text(text = words.save_explanation, color = soft, style = kitTextStyle(KitType.Meta))
        // WHERE IT CAME FROM, the board's last line.
        if (data.meta.isNotEmpty()) {
            Text(text = data.meta, color = soft, style = kitTextStyle(KitType.Meta))
        }
        // THE REFUSAL IS VISIBLE TEXT, never only an accessibility hint, and a
        // save that did not land says so in the same place.
        val failure = state.save_failure
        val refusal = when {
            failure != null && failure.sentence.isNotEmpty() ->
                listOf(failure.sentence, failure.remedy).filter { it.isNotEmpty() }.joinToString(" ")
            else -> state.save_refusal
        }
        if (refusal.isNotEmpty()) {
            Text(text = refusal, color = ink, style = centraidType("small"))
        }
    }
}

/**
 * THE ONE FILLED ELEMENT. A commit that cannot fire is OUTLINED, never a dimmed
 * fill (product-intuition/references/design-behaviour.md § Controls), and says why beneath.
 */
@Composable
private fun Commit(
    state: PhotosEditorState,
    words: PhotosEditorWords,
    editing: Boolean,
    onEvent: (PhotosEditorEvent) -> Unit,
    ink: Color,
    soft: Color,
    line: Color,
) {
    val live = editing && state.save_refusal.isEmpty()
    val shape = RoundedCornerShape(percent = 50)
    Box(
        modifier = Modifier
            .heightIn(min = TARGET.dp)
            .clip(shape)
            .background(if (live) appAccent("photos").fill else Surface.fill)
            .clickable(enabled = live, role = Role.Button) {
                onEvent(PhotosEditorEvent(save = PhotosEditorEvent.Saved()))
            }
            .semantics {
                contentDescription = words.save
                if (!live) disabled()
            }
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = words.save,
            color = if (live) Color.White else soft,
            style = centraidType("control").copy(fontWeight = FontWeight.SemiBold),
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
    fill: Boolean = false,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(CentraidScale.cardRadius.dp)
    Box(
        modifier = Modifier
            .then(if (fill) Modifier.fillMaxWidth() else Modifier)
            .heightIn(min = TARGET.dp)
            .clip(shape)
            .background(if (selected) appAccent("photos").fill else Surface.card)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics {
                contentDescription = label
                this.selected = selected
            }
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = if (selected) Color.White else if (enabled) ink else soft,
            style = centraidType("control"),
        )
    }
}

private fun ratioEvent(ratio: PhotosEditPlan.Ratio, frameRatio: Double): PhotosEditorEvent =
    PhotosEditorEvent(ratio = PhotosEditorEvent.RatioChosen(ratio = ratio, frame_ratio = frameRatio))

@Composable
private fun radius(name: String): Int = LocalCentraidTokens.current.radii[name] ?: 0

/** Whole degrees of turn: quarter turns plus the straighten (Rust's `total_rotation`). */
private fun totalRotation(plan: PhotosEditPlan): Int = (plan.quarters % 4) * 90 + plan.straighten

/** The grown box of a straightened frame (layout only: Rust owns the plan). */
private fun rotatedBox(width: Double, height: Double, degrees: Int): Pair<Double, Double> {
    val radians = degrees * PI / 180.0
    val c = abs(cos(radians))
    val s = abs(sin(radians))
    return Pair(width * c + height * s, width * s + height * c)
}

private fun rotatedFrameRatio(assetRatio: Double, degrees: Int): Double {
    val (width, height) = rotatedBox(assetRatio, 1.0, degrees)
    return if (height > 0.0) width / height else assetRatio
}

/** v0's `maskFill`: the stage colour at `8C`; alpha on the colour, never on the pane. */
private const val MASK_ALPHA: Float = 0x8C / 255f

/** The coarse target floor (product-intuition/references/design-behaviour.md: 44 on touch). */
private const val TARGET: Int = 44

/** One spoken step of the crop: a twentieth of the frame. */
private const val STEP: Double = 0.05

/** One spoken pinch. */
private const val GROW: Double = 1.1
