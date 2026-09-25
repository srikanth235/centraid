package dev.centraid.android.kit

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.screen.v1.Autosave
import centraid.screen.v1.SearchField
import centraid.screen.v1.StatusLine as StatusLineMessage
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE ROOMS (DESIGN.md "The seven rooms"; K5, #1029).
 *
 * A screen is one of these and supplies content and copy; the room owns the
 * header, the back or close control, search, the status host and the band
 * slot. A screen that hand-rolls any of those is a finding, not a variant.
 * `HomeRoom`, `SystemPlace` and `StageRoom` are Home's, Settings' and the
 * lightbox's and are not in this kit yet.
 */

/**
 * The header's one trailing action (≤1 by construction): an icon key from the
 * catalog, and the words a screen reader says for it.
 */
public data class RoomAction(
    val iconKey: String,
    val label: String,
    val testTag: String = "room-action",
    val onPress: () -> Unit,
)

/** Search on an [AppPlace]: the kit `SearchField` and its two events. */
public data class RoomSearch(
    val field: SearchField,
    val placeholder: String,
    val onTerm: (String) -> Unit,
    val onClose: () -> Unit,
    val label: String = KitWords.SEARCH,
    val closeLabel: String = KitWords.CLOSE_SEARCH,
)

/**
 * `AppPlace`: an app's root. `AppHeader` (mark + name + ≤1 trailing action),
 * the search field under it while [search] is open, [content], the status line
 * and the app's band at the foot — a render prop, so the band stays the app's.
 */
@Composable
public fun AppPlace(
    app: String,
    title: String,
    modifier: Modifier = Modifier,
    meta: String = "",
    trailing: RoomAction? = null,
    search: RoomSearch? = null,
    status: String = "",
    band: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Column(modifier.fillMaxSize().testTag("$app-place")) {
        Row(
            Modifier.fillMaxWidth().padding(start = KitGeometry.GUTTER, end = 8.dp, top = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AppMark(appId = app, size = 28.dp, modifier = Modifier.clearAndSetSemantics { })
            Column(Modifier.weight(1f).padding(start = 10.dp)) {
                RoomTitle(title)
                if (meta.isNotEmpty()) {
                    Text(meta, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
                }
            }
            if (trailing != null) IconKey(trailing.iconKey, trailing.label, trailing.testTag, onPress = trailing.onPress)
        }
        if (search != null && search.field.open_) {
            CentraidSearchField(
                field = search.field,
                placeholder = search.placeholder,
                onTerm = search.onTerm,
                onClose = search.onClose,
                label = search.label,
                closeLabel = search.closeLabel,
            )
        }
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
        StatusLine(status)
        band?.invoke()
    }
}

/**
 * `PushedPage`: content a member pushed into. `PlaceHeader` with back to the
 * NAMED parent ([parentTitle] is what the back key says), the title, ≤1
 * trailing action; the status line at the foot. No band.
 */
@Composable
public fun PushedPage(
    title: String,
    parentTitle: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    trailing: RoomAction? = null,
    status: String = "",
    content: @Composable () -> Unit,
) {
    Column(modifier.fillMaxSize().testTag("pushed-page")) {
        Row(
            Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, top = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                Modifier
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .clip(RoundedCornerShape(KitGeometry.RADIUS))
                    .clickable(onClick = onBack)
                    .padding(horizontal = 8.dp)
                    .testTag("room-back")
                    .clearAndSetSemantics {
                        contentDescription = "${KitWords.BACK} to $parentTitle"
                        role = Role.Button
                    },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CentraidIcon(iconKey = "ChevronLeft", tint = centraidColor("textSoft"), size = 18.dp)
                Text(
                    parentTitle,
                    style = centraidType("annotLabelOn"),
                    color = centraidColor("textSoft"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.weight(1f))
            if (trailing != null) IconKey(trailing.iconKey, trailing.label, trailing.testTag, onPress = trailing.onPress)
        }
        RoomTitle(title, Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp))
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
        StatusLine(status)
    }
}

/**
 * `EditorRoom`: full screen, autosave, CLOSE = DONE (#1015 D3), band hidden.
 *
 * The close key and the system back gesture both call [onClose] (the shell's
 * pop). [onDeparted] runs when the room leaves composition by ANY road — close,
 * back, Home — and is where the route calls its bridge's `departed()`, so
 * unsaved words are saved on the way out. The autosave status line is hosted
 * under the header, never as a button: there is no Save.
 */
@Composable
public fun EditorRoom(
    title: String,
    status: Autosave?,
    onClose: () -> Unit,
    onDeparted: () -> Unit,
    modifier: Modifier = Modifier,
    closeLabel: String = KitWords.DONE,
    trailing: RoomAction? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val departed = rememberUpdatedState(onDeparted)
    DisposableEffect(Unit) { onDispose { departed.value() } }
    BackHandler(onBack = onClose)
    Column(modifier.fillMaxSize().testTag("editor-room")) {
        Row(
            Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, top = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconKey("X", closeLabel, "room-close", bordered = false, onPress = onClose)
            Column(Modifier.weight(1f).padding(horizontal = 4.dp)) {
                if (title.isNotEmpty()) {
                    Text(
                        title,
                        style = centraidType("smallStrong"),
                        color = centraidColor("text"),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.semantics { heading() },
                    )
                }
                AutosaveStatus(status)
            }
            if (trailing != null) IconKey(trailing.iconKey, trailing.label, trailing.testTag, onPress = trailing.onPress)
        }
        Column(Modifier.weight(1f).fillMaxWidth(), content = content)
    }
}

/** The one ink button a [SheetRoom] may carry. */
public data class SheetPrimary(
    val label: String,
    val destructive: Boolean = false,
    val testTag: String = "sheet-primary",
    val onPress: () -> Unit,
)

/**
 * `SheetRoom`: the grabber (Material's drag handle), a title carrying the
 * noun, [content], the status line, and ≤1 ink button. A destructive primary
 * is the OUTLINED `net` button, never a filled one.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SheetRoom(
    title: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    primary: SheetPrimary? = null,
    status: String = "",
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = centraidColor("bg")) {
        Column(modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 16.dp).testTag("sheet-room")) {
            if (title.isNotEmpty()) RoomTitle(title, Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp))
            content()
            StatusLine(status)
            if (primary != null) {
                InkButton(
                    label = primary.label,
                    destructive = primary.destructive,
                    testTag = primary.testTag,
                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                    onPress = primary.onPress,
                )
            }
        }
    }
}

/**
 * A full-width button. Ink (`accent` fill) for the one act a sheet offers;
 * a destructive act is outlined in `net` with `net` words and no fill
 * (the hand-off's "destructive outline").
 */
@Composable
public fun InkButton(
    label: String,
    modifier: Modifier = Modifier,
    destructive: Boolean = false,
    testTag: String = "kit-ink-button",
    onPress: () -> Unit,
) {
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Box(
        modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(shape)
            .then(
                if (destructive) {
                    Modifier.border(KitGeometry.HAIRLINE, centraidColor("net"), shape)
                } else {
                    Modifier.background(centraidColor("accent"))
                },
            )
            .clickable(onClick = onPress)
            .testTag(testTag)
            .semantics { role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = centraidType("control"),
            color = centraidColor(if (destructive) "net" else "onAccent"),
        )
    }
}

/** A room's title: the `title` rung, a heading to a screen reader. */
@Composable
internal fun RoomTitle(title: String, modifier: Modifier = Modifier) {
    Text(
        title,
        style = centraidType("title"),
        color = centraidColor("text"),
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier.semantics { heading() },
    )
}

/** THE STATUS HOST: one quiet line, drawn only when there is something to say. */
@Composable
public fun StatusLine(status: String, modifier: Modifier = Modifier) {
    if (status.isEmpty()) return
    Text(
        status,
        style = centraidType("annotLabel"),
        color = centraidColor("textSoft"),
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp)
            .testTag("room-status"),
    )
}

/**
 * THE KIT `StatusLine` MESSAGE: one clause and at most one verb ("Undo"). A
 * refusal is `net` ink and the core's sentence; [onAct] is the screen's own
 * `StatusActed` event. Drawn only when there is a sentence.
 */
@Composable
public fun StatusLine(line: StatusLineMessage?, modifier: Modifier = Modifier, onAct: () -> Unit) {
    if (line == null || line.sentence.isEmpty()) return
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)
            .testTag("room-status-line"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            line.sentence,
            style = centraidType("annotLabel"),
            color = centraidColor(if (line.refused) "net" else "textSoft"),
            modifier = Modifier.weight(1f),
        )
        if (line.action_label.isNotEmpty()) {
            QuietButton(line.action_label, testTag = "room-status-act", onPress = onAct)
        }
    }
}

/**
 * AN ICON-ONLY KEY: a 44dp target, a 36dp plate, one catalog mark, and the
 * label as its whole description (the mark itself says nothing).
 */
@Composable
public fun IconKey(
    iconKey: String,
    label: String,
    testTag: String,
    modifier: Modifier = Modifier,
    bordered: Boolean = true,
    onPress: () -> Unit,
) {
    Box(
        modifier
            .size(KitGeometry.ROW_MIN)
            .clip(RoundedCornerShape(KitGeometry.RADIUS))
            .clickable(onClick = onPress)
            .testTag(testTag)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(36.dp)
                .then(
                    if (bordered) {
                        Modifier.border(KitGeometry.HAIRLINE, centraidColor("line"), RoundedCornerShape(KitGeometry.RADIUS))
                    } else {
                        Modifier
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            CentraidIcon(iconKey = iconKey, tint = centraidColor("textSoft"), size = 18.dp)
        }
    }
}

