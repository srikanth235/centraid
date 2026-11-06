package dev.centraid.android.kit

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * ONE ACTION ON A ROW (#1173, the Swipe board): Details, Flag, Delete. The same actions are the
 * swipe and the long-press menu, so a row that can be swiped can be reached without a swipe too.
 * The labels are the machine's (`KitWords.DETAILS`, `FLAG`, `DELETE`); what each does is the
 * screen's own event, so [onPress] sends it.
 */
public data class KitRowAction(
    val id: String,
    val label: String,
    val tone: Tone = Tone.Neutral,
    val onPress: () -> Unit,
) {
    public enum class Tone {
        /** Details: a quiet graphite fill. */
        Neutral,

        /** Flag: the state's amber, because a flag says "look at this". */
        Amber,

        /** Delete: the state's red. */
        Red,
    }
}

private val ACTION_WIDTH = 76.dp

/**
 * A ROW WITH ITS ACTIONS BEHIND IT. Dragging toward the start edge REVEALS them and never
 * performs one: no full swipe, so a slip never deletes (the same rule as iOS's
 * `allowsFullSwipe: false`). A long press opens the same actions as a menu. A row with no
 * actions is drawn as it is.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
public fun KitSwipeRow(
    actions: List<KitRowAction>,
    modifier: Modifier = Modifier,
    onTap: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    if (actions.isEmpty()) {
        Box(modifier) { content() }
        return
    }
    val density = LocalDensity.current
    val reveal = with(density) { (ACTION_WIDTH * actions.size).toPx() }
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    val graphite = appAccent("locker").fill
    Box(modifier) {
        // THE ACTIONS sit behind the row, at the end edge; Delete is the one nearest it.
        Row(Modifier.align(Alignment.CenterEnd).fillMaxHeight()) {
            actions.forEach { action ->
                val fill = when (action.tone) {
                    KitRowAction.Tone.Neutral -> graphite
                    KitRowAction.Tone.Amber -> StateColor.Amber.fill
                    KitRowAction.Tone.Red -> StateColor.Red.fill
                }
                Box(
                    Modifier
                        .width(ACTION_WIDTH)
                        .fillMaxHeight()
                        .background(fill)
                        .clickable {
                            scope.launch { offset.animateTo(0f) }
                            action.onPress()
                        }
                        .testTag("row-action-${action.id}")
                        .semantics { role = Role.Button },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(action.label, style = kitTextStyle(KitType.Meta), color = Color.White, maxLines = 1)
                }
            }
        }
        Box(
            Modifier
                .offset { IntOffset(offset.value.roundToInt(), 0) }
                .background(Surface.card)
                .draggable(
                    orientation = Orientation.Horizontal,
                    state = rememberDraggableState { delta ->
                        scope.launch { offset.snapTo((offset.value + delta).coerceIn(-reveal, 0f)) }
                    },
                    onDragStopped = {
                        scope.launch { offset.animateTo(if (offset.value < -reveal / 2) -reveal else 0f) }
                    },
                )
                .combinedClickable(
                    onClick = {
                        if (offset.value != 0f) scope.launch { offset.animateTo(0f) } else onTap?.invoke()
                    },
                    onLongClick = { menu = true },
                ),
        ) {
            content()
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = Surface.card) {
                actions.forEach { action ->
                    DropdownMenuItem(
                        text = {
                            Text(
                                action.label,
                                color = if (action.tone == KitRowAction.Tone.Red) StateColor.Red.text else Surface.ink,
                            )
                        },
                        onClick = {
                            menu = false
                            action.onPress()
                        },
                        modifier = Modifier.testTag("row-menu-${action.id}"),
                    )
                }
            }
        }
    }
}
