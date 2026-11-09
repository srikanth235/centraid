package dev.centraid.android.kit

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.SheetValue
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.text.font.FontWeight
import dev.centraid.design.CentraidScale
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
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.SecureFlagPolicy
import centraid.core.v1.Autosave
import centraid.core.v1.StatusLine as StatusLineMessage
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE ROOMS (product-intuition/references/design-behaviour.md § Rooms; K5, #1029).
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
    /** Drawn as the accent pill with the label in white (an editor's Save), not as an icon key. */
    val pill: Boolean = false,
    /** A pill that cannot be pressed yet is drawn quiet. */
    val enabled: Boolean = true,
    val onPress: () -> Unit,
)

/**
 * Search on an [AppPlace]: the kit `SearchField` and its events.
 *
 * SEARCH IS ALWAYS IN THE SAME PLACE (R-CHROME-2): a round key at the trailing end of the app's
 * band, the way the system Photos app has it. Closed, the band draws the key
 * ([LocalBandSearchKey], handed to [AppBand] by [AppPlace]) and a tap sends [onOpen]; open, the
 * field takes the band's place at the foot ([BandSearchField]) and its close key brings the band
 * back. Never a More row, a header glyph or a band tab; an app with no search slot gets no key.
 * An app whose search is a page of its own (Photos, Money) pushes it from [onOpen] and never sets
 * `field.open_`.
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
 * HOW FAR THE BAND REACHES UP INTO THE CONTENT: the foot's height (the band and the status lines
 * above it) while an [AppPlace] was asked to run its content under the band, and zero everywhere
 * else. A scroller that runs under the band gives its last row this much bottom padding, so the
 * row can still scroll clear of the band ([bandFootPadding]).
 */
public val LocalBandClearance: ProvidableCompositionLocal<Dp> = compositionLocalOf { 0.dp }

/**
 * THE BOTTOM PADDING OF A SCROLLER UNDER THE BAND: the band's clearance and, beyond it, the same
 * breathing room the SwiftUI shell leaves (`BandPolicy.FOOT_MARGIN`).
 */
@Composable
public fun bandFootPadding(): PaddingValues =
    PaddingValues(bottom = LocalBandClearance.current + BandPolicy.FOOT_MARGIN.dp)

/**
 * THE PLACE'S BODY AND ITS FOOT: [content] and, at the bottom, [foot] (the status lines and the
 * band). With [contentUnderBand] the content is laid out the whole height and the foot floats over
 * its end, so what scrolls shows around the band's floating pills; [LocalBandClearance] then says how much
 * of it the foot covers. Without it the content ends where the foot begins, as it always did.
 */
@Composable
private fun BandStage(
    modifier: Modifier,
    contentUnderBand: Boolean,
    foot: @Composable () -> Unit,
    content: @Composable () -> Unit,
) {
    SubcomposeLayout(modifier) { constraints ->
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        val footPlaceables = subcompose("foot", foot)
            .map { it.measure(Constraints(minWidth = width, maxWidth = width)) }
        val footHeight = minOf(footPlaceables.maxOfOrNull { it.height } ?: 0, height)
        val room = if (contentUnderBand) height else height - footHeight
        val clearance = if (contentUnderBand) footHeight.toDp() else 0.dp
        val contentPlaceables = subcompose("content") {
            CompositionLocalProvider(LocalBandClearance provides clearance) {
                Box(Modifier.fillMaxSize()) { content() }
            }
        }.map { it.measure(Constraints.fixed(width, room)) }
        layout(width, height) {
            contentPlaceables.forEach { it.place(0, 0) }
            footPlaceables.forEach { it.place(0, height - footHeight) }
        }
    }
}

/**
 * `AppPlace`: an app's root. `AppHeader` (mark + name + the filter menu + ≤1 trailing action),
 * [content], the status line
 * and the app's band at the foot — a render prop, so the band stays the app's. Search is the
 * band's trailing key, and the open field takes the band's place at the foot (see [RoomSearch]).
 * [statusLine] is the status host's second form, for a line that carries a
 * verb or a bar ([ProgressStatusLine]); it docks where [status] does.
 *
 * **THE BAND IS A SOLID TONAL FLOATING PILL** ([bandGround]), and with [contentUnderBand] the
 * content runs under it, as the SwiftUI shell's always does. A screen that sets it owes its
 * scrollers the bottom padding in [bandFootPadding]; one that does not keeps its content above the
 * band, which is the old layout.
 */
@Composable
public fun AppPlace(
    app: String,
    title: String,
    modifier: Modifier = Modifier,
    meta: String = "",
    trailing: RoomAction? = null,
    search: RoomSearch? = null,
    /** A KEY BEFORE THE FILTER (#1173): the tonal lock key of Locker's header; null elsewhere. */
    lead: RoomAction? = null,
    /**
     * THE HEADER'S FILTER BUTTON (R-CHROME-3): Rust's `FilterMenu`, drawn as a menu beside the
     * app's one trailing action. Null where the app has nothing to filter or sort.
     */
    filter: RoomFilter? = null,
    /** The scope the page is in, under the app's name (Notes' notebook, Money's month). */
    subtitle: RoomSubtitle? = null,
    /**
     * A BAR OF THE PLACE'S OWN (#1173): the Calendar's header. [barLeading] stands at the start of
     * the key row and the page draws no title; [barActions] sit before the app's keys.
     */
    barLeading: (@Composable () -> Unit)? = null,
    barActions: (@Composable () -> Unit)? = null,
    /** Reminders' board keeps its big title under the same bar; the Calendar's has none. */
    barShowsTitle: Boolean = false,
    status: String = "",
    statusLine: (@Composable () -> Unit)? = null,
    band: (@Composable () -> Unit)? = null,
    contentUnderBand: Boolean = false,
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalAppAccentId provides app) {
    Column(modifier.fillMaxSize().background(Surface.page).testTag("$app-place")) {
        // THE HEADER (#1173, round 9): THE TITLE SITS IN THE TOP ROW, large at the leading edge
        // with the scope under it, and at most two keys at the trailing end (the tonal filter
        // key, then the filled accent `+`). A place's own bar (the Calendar's month chip) is one
        // control row under the title.
        val showsTitle = barLeading == null || barShowsTitle
        Row(
            Modifier.fillMaxWidth().padding(start = KitGeometry.GUTTER, end = KitGeometry.GUTTER, top = 8.dp, bottom = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            if (!showsTitle && barLeading != null) {
                // NO TITLE (the Calendar's Day and Week): the month chip is the page's name and
                // stands in the top row, where the title would.
                barLeading.invoke()
                Spacer(Modifier.weight(1f))
            }
            if (showsTitle) Column(Modifier.weight(1f).padding(top = 2.dp)) {
                RoomTitle(title)
                if (showsTitle && meta.isNotEmpty()) {
                    KitText(meta, KitType.Meta, Surface.meta)
                }
                if (showsTitle && subtitle != null) RoomSubtitleLine(subtitle)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                barActions?.invoke()
                if (lead != null) HeaderVerb(lead)
                if (filter != null) FilterMenuButton(app, filter)
                if (trailing != null) HeaderVerb(trailing)
            }
        }
        if (barLeading != null && showsTitle) {
            Row(
                Modifier.fillMaxWidth().padding(start = KitGeometry.GUTTER, end = KitGeometry.GUTTER, bottom = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                barLeading.invoke()
            }
        }
        BandStage(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentUnderBand = contentUnderBand,
            foot = {
                Column(Modifier.fillMaxWidth()) {
                    // THE LINES STAND ON THE PAGE'S COLOUR: they are text, and text over a
                    // photograph is not legible. The floating pill is the band's alone.
                    Column(Modifier.fillMaxWidth().background(Surface.page)) {
                        StatusLine(status)
                        statusLine?.invoke()
                        // THE SHELL'S LINE SITS ON THE BAND, never under it.
                        LocalShellLine.current?.invoke()
                    }
                    Column(Modifier.fillMaxWidth().bandStrip()) {
                        if (search != null && search.field.open_) {
                            // OPEN SEARCH TAKES THE BAND'S PLACE, and stays there while the keyboard
                            // goes (its search key) so the foot is never a blank.
                            BandSearchField(
                                field = search.field,
                                placeholder = search.placeholder,
                                onTerm = search.onTerm,
                                onClose = search.onClose,
                                label = search.label,
                                closeLabel = search.closeLabel,
                                testTag = "$app-search",
                            )
                        } else {
                            // THE BAND'S TRAILING KEY is the app's search, when it has one.
                            CompositionLocalProvider(
                                LocalBandSearchKey provides search?.let { BandSearchKey(it.placeholder, it.onOpen) },
                            ) { band?.invoke() }
                        }
                    }
                }
            },
            content = content,
        )
    }
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
    /** A second key before the trailing one: the "…" that opens a page's verbs (a Locker item). */
    more: RoomAction? = null,
    /** The header's filter menu, beside the one trailing action, for a pushed list (Docs' folder). */
    filter: RoomFilter? = null,
    /** The app's id, which the filter menu's test tags are made from (`<app>-filter-menu`). */
    app: String = "",
    status: String = "",
    statusLine: (@Composable () -> Unit)? = null,
    backSpoken: String? = null,
    /** A scope line under the title (Trash's "3 items"): the machine's, empty for none. */
    meta: String = "",
    /** The title in a colour of the page's own (a smart list's, a list's), with its glyph before it. */
    titleColor: androidx.compose.ui.graphics.Color? = null,
    titleIcon: String = "",
    titleTag: String? = null,
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalAppAccentId provides app.ifEmpty { LocalAppAccentId.current }) {
    Column(modifier.fillMaxSize().background(Surface.page).testTag("pushed-page")) {
        // THE TITLE IS IN THE TOP ROW (#1173, round 9): the back chevron, the title inline beside
        // it, the page's keys at the end; the scope line, if any, under the title.
        Row(
            Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, top = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // THE BACK KEY IS A CHEVRON (#1173): a drill-in page is the only place one appears.
            // The parent's name is what a screen reader says.
            IconKey(
                "ChevronLeft",
                backSpoken ?: KitWords.backTo(parentTitle),
                "room-back",
                onPress = onBack,
            )
            Column(Modifier.weight(1f).padding(horizontal = 4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (titleIcon.isNotEmpty() && titleColor != null) {
                        CentraidIcon(titleIcon, tint = titleColor, size = 20.dp, modifier = Modifier.padding(end = 6.dp))
                    }
                    KitText(
                        title,
                        KitType.Section,
                        titleColor ?: Surface.ink,
                        modifier = Modifier.semantics { heading() }.let { if (titleTag != null) it.testTag(titleTag) else it },
                        maxLines = 1,
                    )
                }
                if (meta.isNotEmpty()) {
                    KitText(meta, KitType.Meta, Surface.meta, Modifier.testTag("page-meta"))
                }
            }
            if (filter != null) FilterMenuButton(app, filter)
            if (more != null) HeaderVerb(more)
            if (trailing != null) HeaderVerb(trailing)
        }
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
        StatusLine(status)
        statusLine?.invoke()
        LocalShellLine.current?.invoke()
    }
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
            if (trailing != null && trailing.pill) {
                KitPillButton(trailing.label, trailing.onPress, testTag = trailing.testTag, enabled = trailing.enabled)
            } else if (trailing != null) {
                IconKey(trailing.iconKey, trailing.label, trailing.testTag, onPress = trailing.onPress)
            }
        }
        Column(Modifier.weight(1f).fillMaxWidth(), content = content)
    }
}

/** A sheet's full-width keys (the ink button and the text key under it): the boards draw them 50 tall. */
private val SHEET_KEY_HEIGHT = 50.dp

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
    /** Drawn as a centred text key in the link ink, no outline (the style sheets' Cancel). */
    val link: Boolean = false,
    /** With [link]: the word is the page's ink, not the app's (the confirm's Cancel). */
    val pageInk: Boolean = false,
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
 * **[expanded] true skips the half detent**: the sheet opens at the height of its content (a
 * list of rows, #1173) and at full height when the content is taller, which is also what a
 * screen that is a page in a sheet wants. Defaults leave a sheet as Material draws it.
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
    /** A pill in the title row (a large sheet's Done), drawn quiet while it is not enabled. */
    headerAction: SheetPrimary? = null,
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
        containerColor = Surface.sheet,
        properties = ModalBottomSheetProperties(
            securePolicy = if (secure) SecureFlagPolicy.SecureOn else SecureFlagPolicy.Inherit,
            shouldDismissOnBackPress = swipeable,
            shouldDismissOnClickOutside = swipeable,
        ),
    ) {
        // A SHEET IS ITS OWN WINDOW, so the root's `testTagsAsResourceId` (MainActivity,
        // Q-1128-2) does not reach it: the sheet sets it again for Maestro's `id:` selectors.
        Column(
            modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 16.dp)
                .semantics { testTagsAsResourceId = true }
                .testTag("sheet-room"),
        ) {
            if (headerAction != null) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RoomTitle(title, Modifier.weight(1f))
                    KitPillButton(headerAction.label, headerAction.onPress, testTag = headerAction.testTag, enabled = headerAction.enabled)
                }
            } else if (title.isNotEmpty()) {
                RoomTitle(title, Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp))
            }
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
                        if (outline.link) {
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = SHEET_KEY_HEIGHT)
                                    .clickable(onClick = outline.onPress)
                                    .testTag(outline.testTag),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    outline.label,
                                    style = centraidType("sheetKey"),
                                    color = if (outline.pageInk) Surface.ink else appAccent().text,
                                )
                            }
                        } else {
                            OutlineButton(outline.label, testTag = outline.testTag, ink = outline.ink, onPress = outline.onPress)
                        }
                    }
                }
            }
        }
    }
}

/**
 * A ROUTED SCREEN THAT IS A SHEET (`Route.sheet`: Money's target, Photos' picker), as the boards
 * draw it: the X (Cancel) at the leading edge, the title centred, the page under it and, when the
 * screen has one, a [foot] pinned to the bottom edge for its verbs. The X, the scrim, a drag down
 * and back all call [onDismiss]; the shell then pops the screen's entry, which closes the sheet.
 * It opens at full height: it is a page in a sheet, not a half-sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SheetPage(
    title: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    cancelLabel: String = KitWords.CANCEL,
    foot: (@Composable ColumnScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Surface.sheet,
    ) {
        // A SHEET IS ITS OWN WINDOW (see [SheetRoom]): Maestro's `id:` selectors need the flag again.
        Column(
            modifier.fillMaxSize().navigationBarsPadding().imePadding()
                .semantics { testTagsAsResourceId = true }
                .testTag("sheet-page"),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconKey("X", cancelLabel, "sheet-cancel", onPress = onDismiss)
                Text(
                    title,
                    style = centraidType("sheetKey"),
                    color = Surface.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f).padding(horizontal = 8.dp).semantics { heading() },
                )
                Spacer(Modifier.size(KitGeometry.ROW_MIN))
            }
            Column(Modifier.weight(1f).fillMaxWidth(), content = content)
            if (foot != null) {
                Column(Modifier.fillMaxWidth().padding(bottom = 8.dp), content = foot)
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
    /** A glyph before the label (the lock wall's face or fingerprint); empty for none. */
    iconKey: String = "",
    onPress: () -> Unit,
) {
    // THE ONE FILLED ELEMENT (#1173): a full-width pill in the app's fill under a white label; a
    // destructive one is the outlined state-red pill at the same width. Disabled is still drawn.
    val shape = RoundedCornerShape(percent = 50)
    val accent = appAccent()
    val red = StateColor.Red.text
    val fill = Surface.fill
    val border = Surface.border
    val meta = Surface.meta
    Box(
        modifier
            .fillMaxWidth()
            .heightIn(min = SHEET_KEY_HEIGHT)
            .clip(shape)
            .then(
                when {
                    !enabled && destructive -> Modifier.border(1.5.dp, border, shape)
                    !enabled -> Modifier.background(fill)
                    destructive -> Modifier.border(1.5.dp, red, shape)
                    else -> Modifier.background(accent.fill)
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
        val ink = when {
            !enabled -> meta
            destructive -> red
            else -> Color.White
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (iconKey.isNotEmpty()) {
                Box(Modifier.clearAndSetSemantics { }) { CentraidIcon(iconKey = iconKey, tint = ink, size = 20.dp) }
            }
            Text(label, style = centraidType("sheetKey"), color = ink)
        }
    }
}

/** A room's title: the `title` rung, a heading to a screen reader. */
@Composable
internal fun RoomTitle(title: String, modifier: Modifier = Modifier) {
    KitText(
        title,
        KitType.Title,
        Surface.ink,
        modifier = modifier.semantics { heading() },
        maxLines = 2,
    )
}

/** THE STATUS HOST: one quiet line, drawn only when there is something to say. */
@Composable
public fun StatusLine(status: String, modifier: Modifier = Modifier) {
    if (status.isEmpty()) return
    Box(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .kitStatusPill()
            .testTag("room-status"),
    ) {
        KitText(status, KitType.Row, Surface.ink)
    }
}

/**
 * THE ONE STATUS LINE'S SHAPE (#1173): a single pill on the card colour with a hairline edge,
 * docked above the band. It casts no shadow; state is a sentence in the pill, never a toast.
 */
@Composable
public fun Modifier.kitStatusPill(): Modifier {
    // THE BOARDS DRAW THE LINE AS A PILL (StatusLine, FirstImports): fully round.
    val shape = RoundedCornerShape(50)
    return padding(vertical = 4.dp)
        .heightIn(min = KitGeometry.ROW_MIN)
        .clip(shape)
        .background(Surface.card)
        .border(KitGeometry.HAIRLINE, Surface.border, shape)
        .padding(start = 16.dp, end = 6.dp, top = 10.dp, bottom = 10.dp)
}

/**
 * THE KIT `StatusLine` MESSAGE: one clause and at most one verb ("Undo"). A
 * refusal is `net` ink and the core's sentence; [onAct] is the screen's own
 * `StatusActed` event, and [actTag] the id its verb carries (Agenda's is
 * `agenda-status-action`, the string iOS sets). Drawn only when there is a
 * sentence.
 */
@Composable
public fun StatusLine(
    line: StatusLineMessage?,
    modifier: Modifier = Modifier,
    actTag: String = "room-status-act",
    onAct: () -> Unit,
) {
    if (line == null || line.sentence.isEmpty()) return
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .kitStatusPill()
            .testTag("room-status-line"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitText(
            line.sentence,
            KitType.Row,
            if (line.refused) StateColor.Red.text else Surface.ink,
            modifier = Modifier.weight(1f),
        )
        if (line.action_label.isNotEmpty()) {
            Text(
                line.action_label,
                style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                color = appAccent().text,
                modifier = Modifier
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .clickable(onClick = onAct)
                    .padding(horizontal = 12.dp, vertical = 10.dp)
                    .testTag(actTag)
                    .semantics { role = Role.Button },
            )
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
    leadingIcon: String = "",
) {
    if (sentence.isEmpty()) return
    Column(modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER).kitStatusPill().testTag(testTag)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // A mark before the sentence (FirstImports draws a green check once the work is done).
            if (leadingIcon.isNotEmpty()) {
                CentraidIcon(iconKey = leadingIcon, tint = StateColor.Green.text, size = 18.dp)
                Spacer(Modifier.width(10.dp))
            }
            KitText(
                sentence,
                KitType.Row,
                if (refused) StateColor.Red.text else Surface.ink,
                maxLines = 2,
                modifier = Modifier.weight(1f),
            )
            if (actionLabel.isNotEmpty()) {
                Text(
                    actionLabel,
                    style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                    color = appAccent().text,
                    modifier = Modifier
                        .heightIn(min = KitGeometry.ROW_MIN)
                        .clickable(onClick = onAct)
                        .padding(horizontal = 12.dp, vertical = 10.dp)
                        .testTag("$testTag-act")
                        .semantics { role = Role.Button },
                )
            }
            if (closeLabel.isNotEmpty()) {
                // THE CLOSE KEY IS A FILLED CIRCLE ON THE BOARDS (FirstImports).
                Box(
                    Modifier
                        .size(KitGeometry.ROW_MIN)
                        .clip(CircleShape)
                        .clickable(onClick = onClose)
                        .testTag("$testTag-close")
                        .clearAndSetSemantics {
                            contentDescription = closeLabel
                            role = Role.Button
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.size(36.dp).clip(CircleShape).background(Surface.fill), contentAlignment = Alignment.Center) {
                        CentraidIcon(iconKey = "X", tint = Surface.meta, size = 12.dp)
                    }
                }
            }
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
    // A KEY IS A TONAL CIRCLE (#1173): Material 3 Expressive draws elevation as tone, so the key
    // is the card colour on a hairline, never a shadow.
    val card = Surface.card
    val border = Surface.border
    val ink = if (enabled) Surface.ink else Surface.meta
    Box(
        modifier
            .size(KitGeometry.ROW_MIN)
            .clip(CircleShape)
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
                .size(38.dp)
                .then(
                    if (bordered) {
                        Modifier.clip(CircleShape).background(card).border(KitGeometry.HAIRLINE, border, CircleShape)
                    } else {
                        Modifier
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            CentraidIcon(iconKey = iconKey, tint = ink, size = 18.dp)
        }
    }
}

/**
 * THE HEADER'S VERB (#1173): the app's create verb ("Plus") is a filled key in the app's accent,
 * a white glyph on its fill, the one filled element in the header; any other verb (Photos'
 * Select) is the plain tonal key.
 */
@Composable
internal fun HeaderVerb(action: RoomAction) {
    if (action.iconKey == "Plus") {
        val fill = appAccent().fill
        Box(
            Modifier
                .size(KitGeometry.ROW_MIN)
                .clip(CircleShape)
                .clickable(onClick = action.onPress)
                .testTag(action.testTag)
                .clearAndSetSemantics {
                    contentDescription = action.label
                    role = Role.Button
                },
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(38.dp).clip(CircleShape).background(fill), contentAlignment = Alignment.Center) {
                CentraidIcon(iconKey = action.iconKey, tint = Color.White, size = 18.dp)
            }
        }
    } else {
        IconKey(action.iconKey, action.label, action.testTag, onPress = action.onPress)
    }
}

