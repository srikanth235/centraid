package dev.centraid.android.kit

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.SheetValue
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.SecureFlagPolicy
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

/**
 * Search on an [AppPlace]: the kit `SearchField` and its events.
 *
 * SEARCH IS ALWAYS IN THE SAME PLACE (R-CHROME-2): closed, the slot is a
 * field-shaped bar reading [placeholder], and a tap sends [onOpen]; open, it
 * is the field. Never a More row, a header glyph or a band tab. An app whose
 * search is a page of its own (Photos) pushes it from [onOpen] and
 * never sets `field.open_`.
 */
public data class RoomSearch(
    val field: SearchField,
    val placeholder: String,
    val onTerm: (String) -> Unit,
    val onClose: () -> Unit,
    val label: String = KitWords.SEARCH,
    val closeLabel: String = KitWords.CLOSE_SEARCH,
    val onOpen: () -> Unit = {},
)

/**
 * One chip in the room's filter row (R-CHROME-3): a filter ([selected] says
 * whether it narrows the list now) or the sort, which carries [chevron] and
 * opens an `OptionSheet` of its choices. The row sits under search, before
 * the content, in every app.
 */
public data class RoomChip(
    val testTag: String,
    val label: String,
    val count: String = "",
    val selected: Boolean = false,
    val chevron: Boolean = false,
    val spoken: String = "",
    val onPress: () -> Unit,
)

/** The search bar while search is closed: field-shaped, so it reads as the place to type. */
@Composable
public fun RoomSearchOpener(placeholder: String, testTag: String = "search-opener", onOpen: () -> Unit) {
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = KitGeometry.GUTTER, end = KitGeometry.GUTTER, top = 4.dp, bottom = 8.dp)
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(shape)
            .background(centraidColor("bgSunken"))
            .border(KitGeometry.HAIRLINE, centraidColor("line"), shape)
            .clickable(onClick = onOpen)
            .padding(horizontal = 12.dp)
            .testTag(testTag)
            .clearAndSetSemantics {
                contentDescription = placeholder
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CentraidIcon(iconKey = "Search", tint = centraidColor("textFaint"), size = 16.dp)
        Text(
            placeholder,
            style = centraidType("body"),
            color = centraidColor("textFaint"),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}

/** The filter row: chips in one line, scrolling sideways when they overflow. */
@Composable
public fun RoomChipRow(app: String, chips: List<RoomChip>) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)
            .testTag("$app-chips"),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        chips.forEach { chip ->
            val spoken = chip.spoken.ifEmpty { chip.label }
            KitChip(
                label = chip.label,
                count = chip.count,
                selected = chip.selected,
                chevron = chip.chevron,
                modifier = Modifier.testTag(chip.testTag).semantics { contentDescription = spoken },
                onClick = chip.onPress,
            )
        }
    }
}

/**
 * `AppPlace`: an app's root. `AppHeader` (mark + name + ≤1 trailing action),
 * search under it (the bar, or the field while open), the filter row of
 * [chips], [content], the status line
 * and the app's band at the foot — a render prop, so the band stays the app's.
 * [statusLine] is the status host's second form, for a line that carries a
 * verb or a bar ([ProgressStatusLine]); it docks where [status] does.
 */
@Composable
public fun AppPlace(
    app: String,
    title: String,
    modifier: Modifier = Modifier,
    meta: String = "",
    trailing: RoomAction? = null,
    search: RoomSearch? = null,
    chips: List<RoomChip> = emptyList(),
    status: String = "",
    statusLine: (@Composable () -> Unit)? = null,
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
        if (search != null) {
            if (search.field.open_) {
                CentraidSearchField(
                    field = search.field,
                    placeholder = search.placeholder,
                    onTerm = search.onTerm,
                    onClose = search.onClose,
                    label = search.label,
                    closeLabel = search.closeLabel,
                )
            } else {
                RoomSearchOpener(search.placeholder, testTag = "$app-search-open", onOpen = search.onOpen)
            }
        }
        if (chips.isNotEmpty()) RoomChipRow(app, chips)
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
        StatusLine(status)
        statusLine?.invoke()
        // THE SHELL'S LINE SITS ON THE BAND, never under it.
        LocalShellLine.current?.invoke()
        band?.invoke()
    }
}

/**
 * `PushedPage`: content a member pushed into. `PlaceHeader` with back to the
 * NAMED parent ([parentTitle] is what the back key says), the title, ≤1
 * trailing action; the status line at the foot. No band.
 *
 * [backSpoken] replaces "Back to [parentTitle]" for a key that is not a way
 * back to a parent — an editor's "Cancel", which TalkBack read as "Back to
 * Cancel" (#1047 walk).
 */
@Composable
public fun PushedPage(
    title: String,
    parentTitle: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    trailing: RoomAction? = null,
    status: String = "",
    statusLine: (@Composable () -> Unit)? = null,
    backSpoken: String? = null,
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
                        contentDescription = backSpoken ?: KitWords.backTo(parentTitle)
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
        statusLine?.invoke()
        LocalShellLine.current?.invoke()
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
    val enabled: Boolean = true,
    val onPress: () -> Unit,
)

/**
 * AN ALTERNATIVE TO A SHEET'S PRIMARY: Cancel, Not now, or a removal. It is
 * drawn as an [OutlineButton] in the same [ChoiceStack] as the ink button,
 * under it, so the sheet's answers share one full width. [ink] is `net` when
 * it destroys.
 */
public data class SheetOutline(
    val label: String,
    val testTag: String,
    val ink: String = "text",
    val onPress: () -> Unit,
)

/**
 * `SheetRoom`: the grabber (Material's drag handle), a title carrying the
 * noun, [content], the status line, and ≤1 ink button. A destructive primary
 * is the OUTLINED `net` button, never a filled one. [outlines] are the
 * primary's alternatives, drawn under it in one [ChoiceStack].
 *
 * **[swipeable] false is a sheet nobody can walk out of**: no drag, no back
 * press, no tap outside, and the dismiss request is dropped. It is for a sheet
 * whose screen is mid-write (a vault being made, a laptop being paired), where
 * a way out would leave the machine behind the view. Read live, so a screen
 * flips it with its phase without the sheet being rebuilt.
 *
 * **[secure] true makes the sheet's own window `FLAG_SECURE`.** A sheet is a
 * dialog window, and the activity's flag does not reach one made before it was
 * set, so a sheet holding the 24 words carries the flag itself.
 *
 * **[expanded] true opens at full height** and skips the half detent, for a
 * screen that is a page in a sheet. Defaults leave a sheet as Material draws it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SheetRoom(
    title: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    primary: SheetPrimary? = null,
    outlines: List<SheetOutline> = emptyList(),
    status: String = "",
    swipeable: Boolean = true,
    secure: Boolean = false,
    expanded: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    val canLeave by rememberUpdatedState(swipeable)
    val sheetState = rememberModalBottomSheetState(
        skipPartiallyExpanded = expanded,
        confirmValueChange = { target -> target != SheetValue.Hidden || canLeave },
    )
    ModalBottomSheet(
        onDismissRequest = { if (canLeave) onDismiss() },
        sheetState = sheetState,
        sheetGesturesEnabled = swipeable,
        containerColor = centraidColor("bg"),
        properties = ModalBottomSheetProperties(
            securePolicy = if (secure) SecureFlagPolicy.SecureOn else SecureFlagPolicy.Inherit,
            shouldDismissOnBackPress = swipeable,
            shouldDismissOnClickOutside = swipeable,
        ),
    ) {
        Column(modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 16.dp).testTag("sheet-room")) {
            if (title.isNotEmpty()) RoomTitle(title, Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp))
            content()
            StatusLine(status)
            if (primary != null || outlines.isNotEmpty()) {
                ChoiceStack(Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)) {
                    if (primary != null) {
                        InkButton(
                            label = primary.label,
                            destructive = primary.destructive,
                            testTag = primary.testTag,
                            enabled = primary.enabled,
                            onPress = primary.onPress,
                        )
                    }
                    outlines.forEach { outline ->
                        OutlineButton(outline.label, testTag = outline.testTag, ink = outline.ink, onPress = outline.onPress)
                    }
                }
            }
        }
    }
}

/**
 * A full-width button. Ink (`accent` fill) for the one act a sheet offers;
 * a destructive act is outlined in `net` with `net` words and no fill
 * (the hand-off's "destructive outline"). [enabled] false is still drawn, never
 * hidden: the `textDisabled` ink on the leaf (a `bgSunken` plate for ink, a
 * `textDisabled` outline for destructive), and nothing to press. [testTag]
 * overrides the default id.
 */
@Composable
public fun InkButton(
    label: String,
    modifier: Modifier = Modifier,
    destructive: Boolean = false,
    testTag: String = "kit-ink-button",
    enabled: Boolean = true,
    onPress: () -> Unit,
) {
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Box(
        modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(shape)
            .then(
                when {
                    !enabled && destructive -> Modifier.border(KitGeometry.HAIRLINE, centraidColor("textDisabled"), shape)
                    !enabled -> Modifier.background(centraidColor("bgSunken"))
                    destructive -> Modifier.border(KitGeometry.HAIRLINE, centraidColor("net"), shape)
                    else -> Modifier.background(centraidColor("accent"))
                },
            )
            .clickable(enabled = enabled, onClick = onPress)
            .testTag(testTag)
            .semantics {
                role = Role.Button
                if (!enabled) disabled()
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = centraidType("control"),
            color = centraidColor(
                when {
                    !enabled -> "textDisabled"
                    destructive -> "net"
                    else -> "onAccent"
                },
            ),
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
            OutlineButton(line.action_label, testTag = "room-status-act", onPress = onAct)
        }
    }
}

/**
 * THE STATUS LINE WITH A BAR: one clause, a DETERMINATE bar under it while
 * work with a known size runs ([permille], null for none — never a spinner),
 * at most one text verb ([actionLabel]) and a close key ([closeLabel]) that
 * puts the line away. A refusal is `net` ink. Every word is the caller's
 * state's; drawn only when there is a sentence.
 */
@Composable
public fun ProgressStatusLine(
    sentence: String,
    modifier: Modifier = Modifier,
    permille: Int? = null,
    refused: Boolean = false,
    actionLabel: String = "",
    onAct: () -> Unit = {},
    closeLabel: String = "",
    onClose: () -> Unit = {},
    testTag: String = "room-progress-line",
) {
    if (sentence.isEmpty()) return
    Column(modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp).testTag(testTag)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                sentence,
                style = centraidType("annotLabel"),
                color = centraidColor(if (refused) "net" else "textSoft"),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (actionLabel.isNotEmpty()) OutlineButton(actionLabel, testTag = "$testTag-act", onPress = onAct)
            if (closeLabel.isNotEmpty()) IconKey("X", closeLabel, "$testTag-close", bordered = false, onPress = onClose)
        }
        if (permille != null) {
            KitProgressBar(
                fraction = permille.coerceIn(0, 1000) / 1000f,
                ink = "textSoft",
                modifier = Modifier.padding(top = 4.dp),
            )
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
    enabled: Boolean = true,
    onPress: () -> Unit,
) {
    Box(
        modifier
            .size(KitGeometry.ROW_MIN)
            .clip(RoundedCornerShape(KitGeometry.RADIUS))
            .clickable(enabled = enabled, onClick = onPress)
            .testTag(testTag)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
                if (!enabled) disabled()
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(36.dp)
                .then(
                    if (bordered) {
                        Modifier.border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), RoundedCornerShape(KitGeometry.RADIUS))
                    } else {
                        Modifier
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            CentraidIcon(iconKey = iconKey, tint = centraidColor(if (enabled) "textSoft" else "textDisabled"), size = 18.dp)
        }
    }
}

