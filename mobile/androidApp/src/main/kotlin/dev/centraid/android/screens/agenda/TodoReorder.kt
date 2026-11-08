package dev.centraid.android.screens.agenda

import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex

/**
 * DRAG A ROW TO REORDER IT (#1173), as iOS drags a row onto another: a long press lifts the row, a
 * vertical drag carries it, and letting go sends the one event the menu's Move up and Move down
 * send, `row_moved(task_id, before_id)`. Rust finds the position between the neighbours; this
 * only names the two ids, and only within the row's own group.
 *
 * The rows of a lazy list do not shuffle while the finger is down: the lifted row follows the
 * finger and the drop reads where its centre lies among the rows on screen.
 */
internal class TodoReorderState(
    private val list: LazyListState,
    private val onMove: (movedId: String, beforeId: String) -> Unit,
) {
    /** The item key of the row in the air, or null. */
    var draggedKey by mutableStateOf<String?>(null)
        private set

    /** How far the finger has carried it, in px. */
    var offset by mutableFloatStateOf(0f)
        private set

    fun start(key: String) {
        draggedKey = key
        offset = 0f
    }

    fun drag(dy: Float) {
        offset += dy
    }

    fun cancel() {
        draggedKey = null
        offset = 0f
    }

    /**
     * Let go: [ids] are the group's rows in order, [rowKey] maps one id to its lazy item key.
     * The row lands before the one its centre is over (or after it, when it was dragged down).
     */
    fun drop(movedId: String, ids: List<String>, rowKey: (String) -> String) {
        val moved = draggedKey
        val carried = offset
        cancel()
        if (moved == null) return
        val visible = list.layoutInfo.visibleItemsInfo
        val own = visible.firstOrNull { it.key == moved } ?: return
        val centre = own.offset + own.size / 2f + carried
        val over = ids.firstOrNull { id ->
            id != movedId && visible.any { it.key == rowKey(id) && centre >= it.offset && centre < it.offset + it.size }
        } ?: return
        val from = ids.indexOf(movedId)
        val to = ids.indexOf(over)
        if (from < 0 || to < 0) return
        // Dragged up: before the row it is over. Dragged down: before the one after it, or the end.
        val before = if (to < from) over else ids.getOrNull(to + 1).orEmpty()
        if (before != movedId) onMove(movedId, before)
    }
}

/** The lifted row follows the finger, above its neighbours, and shows a shadow. */
internal fun Modifier.todoReorderable(
    state: TodoReorderState,
    key: String,
    movedId: String,
    ids: List<String>,
    rowKey: (String) -> String,
): Modifier {
    val lifted = state.draggedKey == key
    return this
        .zIndex(if (lifted) 1f else 0f)
        .graphicsLayer { translationY = if (state.draggedKey == key) state.offset else 0f }
        .then(if (lifted) Modifier.shadow(4.dp) else Modifier)
        .pointerInput(key, ids) {
            detectDragGesturesAfterLongPress(
                onDragStart = { state.start(key) },
                onDrag = { change, amount ->
                    change.consume()
                    state.drag(amount.y)
                },
                onDragEnd = { state.drop(movedId, ids, rowKey) },
                onDragCancel = { state.cancel() },
            )
        }
}
