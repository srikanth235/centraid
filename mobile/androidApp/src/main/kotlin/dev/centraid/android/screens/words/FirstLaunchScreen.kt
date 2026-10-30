package dev.centraid.android.screens.words

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import centraid.core.v1.HomeFirstLaunch
import centraid.core.v1.HomeFirstLaunchSlide
import dev.centraid.android.kit.AppMark
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.rememberReducedMotion
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import kotlin.math.min
import kotlinx.coroutines.launch

/**
 * THE FIRST-LAUNCH GATE: what a device that holds no vault opens onto, in
 * place of Home. Same screen as iOS `FirstLaunchView`.
 *
 * ## Three paper slips, because the model is the unfamiliar part
 *
 * The apps on the phone, an assistant that runs there too, and encrypted
 * backups to systems the member owns: three claims, none of which needs the 24
 * words to be understood. So the gate is a small deck of three slips, each a
 * title and a sentence under a picture drawn from the system's own parts (the
 * real app marks, a question and its answer, the `net` rule for the one thing
 * that leaves the device). A slip is DESIGN.md's raised paper (`bgElev`, a
 * hairline, the `lg` radius). No feature tour: the apps are shown as one house.
 *
 * Next flings the top slip away (so does a swipe left anywhere on the deck; a
 * swipe right brings the last one back); the slips behind are the count of what
 * is left. Restore is on every slip, and Skip jumps to the last one, where it
 * goes: a member with their words in hand is never made to sit through the
 * model. The ink button is one control changing its verb: [HomeFirstLaunch.next_label]
 * until the last slip, then [HomeFirstLaunch.make_label].
 *
 * **It decides nothing**: Home draws it while Rust says the phone holds no
 * vault; every word is Rust's (`HomeState.first_launch`, the slips' in the order
 * it lists them) and the house's marks are Home's own roster (#1129). [onMake]
 * and [onRestore] are Home's `MakePressed` and `RestorePressed`, which push the
 * words pages over it, so cancelling out of either lands back here, and the gate
 * goes only when the shelf holds a vault. The page the deck is on is the one
 * thing the view keeps: where the member is in reading the model.
 *
 * Reduced motion drops every movement (the slips change place at once).
 */
@Composable
internal fun FirstLaunchScreen(gate: HomeFirstLaunch, onMake: () -> Unit, onRestore: () -> Unit) {
    var page by rememberSaveable { mutableIntStateOf(0) }
    val reduceMotion = rememberReducedMotion()
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val swipe = with(density) { SWIPE.dp.toPx() }
    // THE SLIP UNDER THE FINGER follows it; [dragOwner] is the slip the drag
    // began on, so a throw that changes the page settles that slip, not the next.
    val drag = remember { Animatable(0f) }
    var dragOwner by remember { mutableIntStateOf(0) }
    val settle: AnimationSpec<Float> = if (reduceMotion) snap() else entry()

    Column(
        Modifier
            .fillMaxSize()
            .background(centraidColor("bg"))
            .testTag("first-launch"),
    ) {
        // SKIP LEAVES ON THE LAST PAGE, which has nowhere further to skip to;
        // its place is kept so the header never reflows.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
            horizontalArrangement = Arrangement.End,
        ) {
            if (page < LAST) {
                KitLink(
                    label = gate.skip_label,
                    onClick = { page = LAST },
                    modifier = Modifier.testTag("first-launch-skip"),
                )
            } else {
                Spacer(Modifier.size(CentraidGeometry.TARGET_MIN_COARSE.dp))
            }
        }

        Spacer(Modifier.weight(1f))

        // THE WHOLE BAND IS THE SURFACE, not only the slip under the finger: a
        // swipe that starts on the paper's margin still turns the deck.
        Box(
            Modifier
                .fillMaxWidth()
                .height(SLIP_HEIGHT.dp)
                .pointerInput(page) {
                    var travelled = 0f
                    detectHorizontalDragGestures(
                        onDragStart = {
                            travelled = 0f
                            dragOwner = page
                        },
                        onDragEnd = {
                            val forward = travelled < -swipe && page < LAST
                            val back = travelled > swipe && page > 0
                            scope.launch { drag.animateTo(0f, settle) }
                            if (forward) page += 1 else if (back) page -= 1
                        },
                        onDragCancel = { scope.launch { drag.animateTo(0f, settle) } },
                        onHorizontalDrag = { change, amount ->
                            change.consume()
                            travelled += amount
                            // THE LAST SLIP STAYS PUT when thrown: it carries the way in.
                            if (page < LAST) scope.launch { drag.snapTo(min(0f, travelled)) }
                        },
                    )
                },
            contentAlignment = Alignment.Center,
        ) {
            Box(
                Modifier.fillMaxSize().padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.widthIn(max = SLIP_WIDTH.dp).fillMaxSize()) {
                    // THE SLIDE'S WORDS ARE RUST'S, in the order it lists them.
                    SLIPS.forEachIndexed { index, id ->
                        val slide = gate.slides.getOrNull(index) ?: HomeFirstLaunchSlide()
                        Slip(
                            index = index,
                            page = page,
                            id = id,
                            title = slide.title,
                            sentence = slide.body,
                            drag = if (index == dragOwner) drag.value else 0f,
                            settle = settle,
                        ) {
                            when (index) {
                                0 -> HouseScene(gate.apps)
                                1 -> AssistantScene()
                                else -> CopyScene()
                            }
                        }
                    }
                }
            }
        }

        Spacer(Modifier.weight(1f))

        // THE SAME TWO CONTROLS THE WORDS SCREENS DRAW: ink for the act, a quiet
        // link for the way back. One ink element per view, so "Next" and "Get
        // started" are the same button changing its verb.
        Box(Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp).padding(bottom = 24.dp)) {
            WordsControls(
                primary = if (page < LAST) gate.next_label else gate.make_label,
                primaryEnabled = true,
                secondary = gate.restore_label,
                prefix = "first-launch",
                onPrimary = { if (page < LAST) page += 1 else onMake() },
                onSecondary = onRestore,
            )
        }
    }
}

/** DESIGN.md invariant 5, lowered once for this screen: entry and settle at 280ms on the entry curve. */
private fun entry(): AnimationSpec<Float> = tween(ENTRY_MS, easing = CubicBezierEasing(0.2f, 0.7f, 0.2f, 1f))

/**
 * One slip, placed by how far it is from the top of the deck: thrown (already
 * read) it leaves up and to the left; the top one follows the finger; the two
 * behind step down and in, tilted a little apart. Only the top slip is read by
 * TalkBack, so the deck is never a pile of sentences.
 */
@Composable
private fun Slip(
    index: Int,
    page: Int,
    id: String,
    title: String,
    sentence: String,
    drag: Float,
    settle: AnimationSpec<Float>,
    scene: @Composable () -> Unit,
) {
    val rel = index - page
    val tilt = TILTS[index]
    val depth = rel.coerceIn(0, 2)
    val rotation by animateFloatAsState(if (rel < 0) THROWN_TILT else tilt, settle, label = "slip-tilt")
    val x by animateFloatAsState(if (rel < 0) THROWN_X else 0f, settle, label = "slip-x")
    val y by animateFloatAsState(if (rel < 0) THROWN_Y else depth * STEP_Y, settle, label = "slip-y")
    val scale by animateFloatAsState(if (rel < 0) 1f else 1f - depth * STEP_SCALE, settle, label = "slip-scale")
    val alpha by animateFloatAsState(if (rel < 0) 0f else 1f, settle, label = "slip-alpha")
    val radius = RoundedCornerShape((LocalCentraidTokens.current.radii["lg"] ?: 0).dp)
    val seen = if (rel == 0) {
        Modifier.testTag("first-launch-$id")
    } else {
        Modifier.clearAndSetSemantics { }
    }
    Column(
        Modifier
            .fillMaxSize()
            .zIndex((10 - rel).toFloat())
            .graphicsLayer {
                translationX = x.dp.toPx() + drag
                translationY = y.dp.toPx()
                rotationZ = rotation + drag / density / DRAG_TILT
                scaleX = scale
                scaleY = scale
                this.alpha = alpha
            }
            .background(centraidColor("bgElev"), radius)
            .border(1.dp, centraidColor("line"), radius)
            .then(seen)
            .padding(24.dp),
    ) {
        Box(
            Modifier.fillMaxWidth().padding(top = 10.dp).clearAndSetSemantics { },
            contentAlignment = Alignment.TopCenter,
        ) { scene() }
        Spacer(Modifier.height(16.dp))
        Spacer(Modifier.weight(1f))
        Text(
            title,
            style = centraidType("display"),
            color = centraidColor("text"),
            modifier = Modifier.semantics { heading() },
        )
        Text(
            sentence,
            style = centraidType("body"),
            color = centraidColor("textSoft"),
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

/**
 * EVERY APP'S MARK AS ONE HOUSE: rooms in one place, not separate products. The
 * marks are Home's own roster ([apps], #1129), so an app that gets a tile is in
 * the house too; five to a row at 40dp is the same width the grid always took,
 * and fits the narrowest phone's slip.
 */
@Composable
private fun HouseScene(apps: List<String>) {
    Box(Modifier.fillMaxWidth().height(SCENE_HEIGHT.dp).padding(top = 18.dp), contentAlignment = Alignment.TopCenter) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            apps.chunked(5).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { appId -> AppMark(appId = appId, size = 40.dp) }
                }
            }
        }
    }
}

/**
 * A QUESTION AND ITS ANSWER, DRAWN FROM THE ASSISTANT'S OWN PARTS: the member's
 * line on the right, the assistant's on the left with the app it read from — a
 * real mark, so the picture says "your things" and not "a chatbot". Bars stand
 * in for words; nothing here reads as a particular question.
 */
@Composable
private fun AssistantScene() {
    Column(
        Modifier.fillMaxWidth().height(SCENE_HEIGHT.dp).padding(top = 18.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 40.dp), horizontalArrangement = Arrangement.End) {
            Bubble(bars = listOf(92, 58), fill = "bgSunken", stroke = "line")
        }
        Row { Bubble(bars = listOf(112, 96, 64), fill = "bg", stroke = "lineStrong") }
        Row(
            Modifier.padding(start = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AppMark(appId = "agenda", size = 22.dp)
            Bar(width = 70.dp, ink = "line")
        }
    }
}

/** One chat bubble: [bars] are the widths of its lines of "words". */
@Composable
private fun Bubble(bars: List<Int>, fill: String, stroke: String) {
    val shape = RoundedCornerShape((LocalCentraidTokens.current.radii["md"] ?: 0).dp)
    Column(
        Modifier
            .background(centraidColor(fill), shape)
            .border(1.dp, centraidColor(stroke), shape)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        bars.forEach { width -> Bar(width = width.dp, ink = "text") }
    }
}

/** A 5dp capsule standing in for a line of words. */
@Composable
private fun Bar(width: Dp, ink: String) {
    Box(Modifier.size(width, 5.dp).background(centraidColor(ink), CircleShape))
}

/**
 * THE ONE THING THAT LEAVES THE DEVICE, drawn in the colour that means exactly
 * that: a `net` rule from the phone to a laptop, and a sealed copy of the vault
 * on the other machine's screen while the original stays home.
 */
@Composable
private fun CopyScene() {
    val phone = RoundedCornerShape((LocalCentraidTokens.current.radii["lg"] ?: 0).dp)
    val laptop = RoundedCornerShape((LocalCentraidTokens.current.radii["md"] ?: 0).dp)
    val net = centraidColor("net")
    Row(Modifier.fillMaxWidth().height(SCENE_HEIGHT.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(62.dp, 110.dp).border(1.5.dp, centraidColor("lineStrong"), phone),
            contentAlignment = Alignment.Center,
        ) { AppMark(appId = "locker", size = 32.dp) }
        Canvas(Modifier.weight(1f).padding(horizontal = 10.dp).height(2.dp)) {
            drawLine(
                color = net,
                start = Offset(0f, size.height / 2),
                end = Offset(size.width, size.height / 2),
                strokeWidth = 2.dp.toPx(),
                cap = StrokeCap.Round,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 6.dp.toPx())),
            )
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Box(
                Modifier.size(100.dp, 66.dp).border(1.5.dp, centraidColor("lineStrong"), laptop),
                contentAlignment = Alignment.Center,
            ) { AppMark(appId = "locker", size = 32.dp) }
            Bar(width = 124.dp, ink = "lineStrong")
        }
    }
}

/** The ids of the three slips (`first-launch-house`, `-assistant`, `-backup`), top of the deck first. */
private val SLIPS: List<String> = listOf("house", "assistant", "backup")

/** Each slip's resting tilt in degrees, a little apart so the pile reads as paper. */
private val TILTS: List<Float> = listOf(-2f, 1.5f, -1f)

private const val LAST: Int = 2
private const val SLIP_WIDTH: Int = 300
private const val SLIP_HEIGHT: Int = 420
private const val SCENE_HEIGHT: Int = 150
private const val SWIPE: Int = 80
private const val ENTRY_MS: Int = 280
private const val THROWN_TILT: Float = -18f
private const val THROWN_X: Float = -520f
private const val THROWN_Y: Float = -30f
private const val STEP_Y: Float = 14f
private const val STEP_SCALE: Float = 0.04f
private const val DRAG_TILT: Float = 24f
