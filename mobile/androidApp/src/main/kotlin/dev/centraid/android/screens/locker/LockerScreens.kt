package dev.centraid.android.screens.locker

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.autofill.ContentDataType
import androidx.compose.ui.semantics.contentDataType
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import centraid.screen.v1.LockerChoice
import centraid.screen.v1.LockerCountdown
import centraid.screen.v1.LockerEditorEvent
import centraid.screen.v1.LockerEditorState
import centraid.screen.v1.LockerFieldRow
import centraid.screen.v1.LockerGeneratorEvent
import centraid.screen.v1.LockerGeneratorState
import centraid.screen.v1.LockerHomeEvent
import centraid.screen.v1.LockerHomeState
import centraid.screen.v1.LockerInputRow
import centraid.screen.v1.LockerItemEvent
import centraid.screen.v1.LockerItemState
import centraid.screen.v1.LockerLockState
import centraid.screen.v1.LockerRow
import centraid.screen.v1.SectionHead
import centraid.screen.v1.WriteState
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppMark
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.NoAutofill
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.StatusChipView
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

// Locker's Compose views (#1047, D-5). THEY DECIDE NOTHING: every word, mask,
// verb, chip and empty state is the shared machines' (`apps/locker/*`); a view
// draws a state and forwards what the member did. The wall, the prompt and the
// clipboard are the seam's (`LockerSeam.kt`), wired in `LockerRoutes`.

// ---------------------------------------------------------------------------
// locker.lock — the wall drawn over every Locker destination while `cover`
// ---------------------------------------------------------------------------

@Composable
internal fun LockerWall(wall: LockerLockState, onUnlock: () -> Unit, onWords: () -> Unit) {
    val failing = wall.phase == LockerLockState.Phase.PHASE_FAILED ||
        wall.phase == LockerLockState.Phase.PHASE_UNAVAILABLE
    LazyColumn(
        Modifier
            .fillMaxSize()
            .testTag("locker-wall")
            .semantics { contentDescription = wall.accessibility_label },
    ) {
        item(key = "mark") {
            Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 24.dp)) {
                AppMark(appId = "locker", size = 40.dp, modifier = Modifier.clearAndSetSemantics { })
                Text(
                    wall.title,
                    style = centraidType("title"),
                    color = centraidColor("text"),
                    modifier = Modifier.padding(top = 16.dp).semantics { heading() },
                )
                if (wall.body.isNotEmpty()) {
                    Text(
                        wall.body,
                        style = centraidType("body"),
                        color = centraidColor("textSoft"),
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                if (wall.notice.isNotEmpty()) {
                    Text(
                        wall.notice,
                        style = centraidType("annotLabel"),
                        color = centraidColor(if (failing) "net" else "textSoft"),
                        modifier = Modifier.padding(top = 12.dp).testTag("locker-wall-notice"),
                    )
                }
                if (wall.unlock_label.isNotEmpty()) {
                    InkButton(
                        label = wall.unlock_label,
                        testTag = "locker-unlock",
                        modifier = Modifier.padding(top = 20.dp),
                        onPress = onUnlock,
                    )
                }
                // NO KEY ON THIS PHONE (#1047 E1/E3): the words hand it back.
                if (wall.words_label.isNotEmpty()) {
                    InkButton(
                        label = wall.words_label,
                        testTag = "locker-words",
                        modifier = Modifier.padding(top = 20.dp),
                        onPress = onWords,
                    )
                }
            }
        }
        items(wall.facts, key = { "fact-" + it.label }) { fact -> FieldRow(key = fact.label, value = fact.detail) }
    }
}

// ---------------------------------------------------------------------------
// locker.home — Items · Review · Generate · Search, More as a sheet
// ---------------------------------------------------------------------------

@Composable
internal fun LockerHomeScreen(
    state: LockerHomeState,
    generator: LockerGeneratorState,
    onEvent: (LockerHomeEvent) -> Unit,
    onGenerator: (LockerGeneratorEvent) -> Unit,
    onHome: () -> Unit,
) {
    val chrome = state.chrome
    val data = state.data_
    val generating = state.destination == LockerHomeState.Destination.DESTINATION_GENERATE
    val field = state.search
    AppPlace(
        title = chrome?.title.orEmpty(),
        trailing = chrome?.add_label?.takeIf { it.isNotEmpty() }?.let { label ->
            RoomAction("Plus", label, "locker-add") { onEvent(LockerHomeEvent(add = LockerHomeEvent.AddItem())) }
        },
        search = if (field != null && field.open_) {
            RoomSearch(
                field = field,
                placeholder = chrome?.search_placeholder.orEmpty(),
                onTerm = { onEvent(LockerHomeEvent(search_typed = LockerHomeEvent.SearchTyped(term = it))) },
                onClose = { onEvent(LockerHomeEvent(search_closed = LockerHomeEvent.SearchClosed())) },
                closeLabel = chrome?.close_label.orEmpty().ifEmpty { KitWords.CLOSE_SEARCH },
            )
        } else {
            null
        },
        status = if (generating) "" else data?.status_line.orEmpty(),
        band = if (state.band.isEmpty()) {
            null
        } else {
            {
                // MORE IS ONE OF THE MACHINE'S FIVE TABS, with its own word and
                // mark, so it is drawn as a tab and not as the kit's More.
                AppBand(
                    app = "locker",
                    tabs = state.band.map {
                        AppBandTab(key = it.key, label = it.label, iconKey = it.icon_key, selected = it.current)
                    },
                    onSelect = { key -> onEvent(LockerHomeEvent(band = LockerHomeEvent.BandPicked(key = key))) },
                    onHome = onHome,
                )
            }
        },
    ) {
        if (generating) {
            LockerGeneratorBody(generator, onGenerator)
        } else {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, data, state.denied),
                onRetry = { onEvent(LockerHomeEvent(refreshed = LockerHomeEvent.Refreshed())) },
                retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
                skeleton = { RowSkeleton() },
            ) { home ->
                LazyColumn(Modifier.fillMaxSize().testTag("locker-home-list")) {
                    when (state.destination) {
                        LockerHomeState.Destination.DESTINATION_REVIEW -> review(home, onEvent)
                        LockerHomeState.Destination.DESTINATION_SEARCH -> search(state, home, onEvent)
                        else -> items(home, onEvent)
                    }
                }
            }
        }
    }
    val close = { onEvent(LockerHomeEvent(sheet_closed = LockerHomeEvent.SheetClosed())) }
    when (state.sheet) {
        LockerHomeState.Sheet.SHEET_MORE -> OptionSheet(
            title = chrome?.more_title.orEmpty(),
            options = chrome?.more_rows.orEmpty().map { SheetOption(key = it.key, label = it.label, iconKey = it.icon_key, detail = it.meta) },
            onPick = { key -> onEvent(LockerHomeEvent(more = LockerHomeEvent.MorePicked(key = key))) },
            onDismiss = close,
        )
        LockerHomeState.Sheet.SHEET_FACTS -> SheetRoom(title = chrome?.facts_title.orEmpty(), onDismiss = close) {
            chrome?.facts.orEmpty().forEach { fact -> FieldRow(key = fact.label, value = fact.detail) }
        }
        else -> Unit
    }
}

/** `AppPlace` for Locker: the kit room, named here so the app id is said once. */
@Composable
private fun AppPlace(
    title: String,
    trailing: RoomAction?,
    search: RoomSearch?,
    status: String,
    band: (@Composable () -> Unit)?,
    content: @Composable () -> Unit,
) {
    dev.centraid.android.kit.AppPlace(
        app = "locker",
        title = title,
        trailing = trailing,
        search = search,
        status = status,
        band = band,
        content = content,
    )
}

private fun LazyListScope.items(home: centraid.screen.v1.LockerHomeData, onEvent: (LockerHomeEvent) -> Unit) {
    if (home.filters.isNotEmpty()) {
        item(key = "filters") {
            LockerChoices(home.filters, testTag = "locker-filter") { key ->
                onEvent(LockerHomeEvent(filter = LockerHomeEvent.FilterPicked(key = key)))
            }
        }
    }
    val empty = home.items_empty
    if (home.rows.isEmpty() && empty != null) {
        item(key = "empty") {
            Box(Modifier.heightIn(min = 320.dp)) {
                EmptyStateView(empty, onAction = { onEvent(LockerHomeEvent(add = LockerHomeEvent.AddItem())) })
            }
        }
    }
    items(home.rows, key = { "i-" + it.item_id }) { row ->
        LockerRowView(row) { onEvent(LockerHomeEvent(item = LockerHomeEvent.ItemPicked(item_id = row.item_id))) }
    }
    if (home.window.isNotEmpty()) item(key = "window") { LockerNote(home.window) }
}

private fun LazyListScope.review(home: centraid.screen.v1.LockerHomeData, onEvent: (LockerHomeEvent) -> Unit) {
    val clear = home.review_clear
    if (clear != null) {
        item(key = "clear") { Box(Modifier.heightIn(min = 200.dp)) { EmptyStateView(clear, onAction = null) } }
    }
    home.review.forEach { section ->
        item(key = "s-" + section.key) {
            section.head?.let { SectionHeader(it) }
            LockerNote(section.reason)
        }
        items(section.rows, key = { "r-" + section.key + "-" + it.item_id }) { row ->
            LockerRowView(row) { onEvent(LockerHomeEvent(item = LockerHomeEvent.ItemPicked(item_id = row.item_id))) }
        }
    }
    if (home.review_unchecked.isNotEmpty()) {
        item(key = "unchecked-head") { SectionHeader(SectionHead(title = home.review_unchecked_title)) }
        items(home.review_unchecked, key = { "u-" + it.label }) { fact -> FieldRow(key = fact.label, value = fact.detail) }
    }
    if (home.review_note.isNotEmpty()) item(key = "note") { LockerNote(home.review_note) }
}

private fun LazyListScope.search(state: LockerHomeState, home: centraid.screen.v1.LockerHomeData, onEvent: (LockerHomeEvent) -> Unit) {
    val term = state.search?.term.orEmpty()
    if (term.isBlank()) {
        // THE HANDOFF'S SEARCH NOTE: what is never searched, said before a term.
        item(key = "note") { LockerNote(state.chrome?.search_note.orEmpty()) }
        return
    }
    val empty = home.search_empty
    if (home.hits.isEmpty() && empty != null) {
        item(key = "empty") { Box(Modifier.heightIn(min = 240.dp)) { EmptyStateView(empty, onAction = null) } }
    }
    items(home.hits, key = { "h-" + it.item_id }) { row ->
        LockerRowView(row) { onEvent(LockerHomeEvent(item = LockerHomeEvent.ItemPicked(item_id = row.item_id))) }
    }
}

/** THE HANDOFF'S ITEM ROW: the type chip, the one kit row, and the star. */
@Composable
internal fun LockerRowView(row: LockerRow, onTap: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onTap).padding(start = KitGeometry.GUTTER),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TypeChip(row.type_chip)
        CentraidRow(
            title = row.title,
            modifier = Modifier.weight(1f),
            meta = row.meta,
            chips = row.chips,
            a11y = row.accessibility_label,
            testTag = "locker-row-${row.item_id}",
            onTap = onTap,
        )
        if (row.starred) {
            CentraidIcon(
                iconKey = "Star",
                tint = centraidColor("textSoft"),
                size = 14.dp,
                modifier = Modifier.padding(end = KitGeometry.GUTTER).clearAndSetSemantics { },
            )
        }
    }
}

/** The type's two letters on the rose wash. */
@Composable
private fun TypeChip(letters: String, modifier: Modifier = Modifier) {
    if (letters.isEmpty()) return
    Box(
        modifier
            .size(32.dp)
            .clip(RoundedCornerShape(KitGeometry.RADIUS))
            .background(centraidColor("cRose").copy(alpha = 0.14f))
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        Text(letters, style = centraidType("eyebrow"), color = centraidColor("cRose"))
    }
}

/** A quiet sentence under a list or a field: the machine's, drawn only when present. */
@Composable
private fun LockerNote(text: String, modifier: Modifier = Modifier, ink: String = "textSoft") {
    if (text.isEmpty()) return
    Text(
        text,
        style = centraidType("annotLabel"),
        color = centraidColor(ink),
        modifier = modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
    )
}

/** A row of the machine's choices as outlined chips; the selected one is filled. */
@Composable
private fun LockerChoices(choices: List<LockerChoice>, testTag: String, onPick: (String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        choices.forEach { choice -> ChoiceChip(choice, "$testTag-${choice.key}") { onPick(choice.key) } }
    }
}

@Composable
private fun ChoiceChip(choice: LockerChoice, testTag: String, onPick: () -> Unit) {
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    val words = if (choice.detail.isEmpty()) choice.label else "${choice.label} ${choice.detail}"
    Text(
        words,
        style = centraidType("annotLabelOn"),
        color = centraidColor(if (choice.selected) "onAccent" else "text"),
        maxLines = 1,
        modifier = Modifier
            .heightIn(min = 36.dp)
            .clip(shape)
            .then(
                if (choice.selected) {
                    Modifier.background(centraidColor("accent"))
                } else {
                    Modifier.border(KitGeometry.HAIRLINE, centraidColor("line"), shape)
                },
            )
            .clickable(onClick = onPick)
            .padding(horizontal = 12.dp, vertical = 9.dp)
            .testTag(testTag)
            .semantics {
                role = Role.Tab
                selected = choice.selected
            },
    )
}

// ---------------------------------------------------------------------------
// locker.generator — in Home's Generate slot, or pushed on its own page
// ---------------------------------------------------------------------------

@Composable
internal fun LockerGeneratorPage(
    state: LockerGeneratorState,
    parent: String,
    onEvent: (LockerGeneratorEvent) -> Unit,
    onBack: () -> Unit,
) {
    // NO LOCK VERB IN THE APP BAR (D-8, #1047): locking is the More sheet's
    // Lock row, as on iOS.
    PushedPage(
        title = state.title,
        parentTitle = parent,
        onBack = onBack,
    ) {
        LockerGeneratorBody(state, onEvent)
    }
}

@Composable
internal fun LockerGeneratorBody(state: LockerGeneratorState, onEvent: (LockerGeneratorEvent) -> Unit) {
    LazyColumn(Modifier.fillMaxSize().testTag("locker-generator")) {
        item(key = "output") {
            Column(Modifier.fillMaxWidth().padding(KitGeometry.GUTTER)) {
                // THE OUTPUT AT THE DISPLAY RUNG, in a bordered box. Not
                // selectable: the Copy verb is the one way off the screen.
                Box(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 72.dp)
                        .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), RoundedCornerShape(KitGeometry.RADIUS))
                        .padding(12.dp)
                        .semantics { contentDescription = state.accessibility_label },
                    contentAlignment = Alignment.CenterStart,
                ) {
                    Text(
                        state.output,
                        style = centraidType("display").copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
                        color = centraidColor("text"),
                        modifier = Modifier.testTag("locker-generator-output"),
                    )
                }
                if (state.strength.isNotEmpty()) {
                    Text(
                        state.strength,
                        style = centraidType("annotLabel"),
                        color = centraidColor("textSoft"),
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
                Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (state.regenerate_label.isNotEmpty()) {
                        QuietButton(state.regenerate_label, testTag = "locker-regenerate") {
                            onEvent(LockerGeneratorEvent(regenerate = LockerGeneratorEvent.Regenerate()))
                        }
                    }
                    if (state.copy_label.isNotEmpty()) {
                        QuietButton(state.copy_label, testTag = "locker-generator-copy") {
                            onEvent(LockerGeneratorEvent(copy = LockerGeneratorEvent.CopyTapped()))
                        }
                    }
                    if (state.use_label.isNotEmpty()) {
                        QuietButton(state.use_label, testTag = "locker-generator-use") {
                            onEvent(LockerGeneratorEvent(use = LockerGeneratorEvent.UseTapped()))
                        }
                    }
                }
            }
        }
        if (state.kinds.isNotEmpty()) {
            item(key = "kinds") {
                LockerLabel(state.kinds_label)
                LockerChoices(state.kinds, testTag = "locker-kind") { key ->
                    onEvent(LockerGeneratorEvent(kind_picked = LockerGeneratorEvent.KindPicked(key = key)))
                }
            }
        }
        if (state.length_max > state.length_min) {
            item(key = "length") {
                LockerLabel(state.length_label)
                LengthSlider(state) { length -> onEvent(LockerGeneratorEvent(length = LockerGeneratorEvent.LengthChanged(length = length))) }
            }
        }
        if (state.include.isNotEmpty()) {
            item(key = "include") {
                LockerLabel(state.include_label)
                LockerChoices(state.include, testTag = "locker-include") { key ->
                    onEvent(LockerGeneratorEvent(include = LockerGeneratorEvent.IncludeToggled(key = key)))
                }
                LockerNote(state.lookalike_note)
            }
        }
        item(key = "status") { StatusLine(state.status, onAct = {}) }
    }
}

/**
 * THE LENGTH, as a slider over the machine's bounds. The thumb moves with the
 * finger and the machine hears each whole step once; the state's `length`
 * replaces the thumb's position whenever it changes.
 */
@Composable
private fun LengthSlider(state: LockerGeneratorState, onLength: (Int) -> Unit) {
    var position by remember(state.length) { mutableFloatStateOf(state.length.toFloat()) }
    Slider(
        value = position,
        onValueChange = { next ->
            position = next
            val whole = next.toInt()
            if (whole != state.length) onLength(whole)
        },
        valueRange = state.length_min.toFloat()..state.length_max.toFloat(),
        steps = (state.length_max - state.length_min - 1).coerceAtLeast(0),
        colors = SliderDefaults.colors(
            thumbColor = centraidColor("text"),
            activeTrackColor = centraidColor("text"),
            inactiveTrackColor = centraidColor("line"),
        ),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag("locker-length")
            .semantics { contentDescription = state.length_label },
    )
}

@Composable
private fun LockerLabel(text: String) {
    if (text.isEmpty()) return
    Text(
        text,
        style = centraidType("eyebrow"),
        color = centraidColor("textSoft"),
        modifier = Modifier.padding(start = KitGeometry.GUTTER, end = KitGeometry.GUTTER, top = 12.dp),
    )
}

// ---------------------------------------------------------------------------
// locker.item
// ---------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun LockerItemScreen(
    state: LockerItemState,
    onEvent: (LockerItemEvent) -> Unit,
    onOpen: (String) -> Unit,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    val data = state.data_
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = chrome?.back_label.orEmpty().ifEmpty { state.parent },
        onBack = onBack,
        trailing = chrome?.edit_label?.takeIf { it.isNotEmpty() && data?.gone == null }?.let { label ->
            RoomAction("Pencil", label, "locker-edit") { onEvent(LockerItemEvent(edit = LockerItemEvent.EditTapped())) }
        },
        status = refusal(state.write),
        statusLine = { StatusLine(state.status) { onEvent(LockerItemEvent(status_acted = LockerItemEvent.StatusActed())) } },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = { onEvent(LockerItemEvent(refreshed = LockerItemEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { item ->
            val gone = item.gone
            if (gone != null) {
                EmptyStateView(gone, onAction = null)
                return@ReadStateView
            }
            LazyColumn(Modifier.fillMaxSize().testTag("locker-item")) {
                item(key = "head") {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        TypeChip(item.type_chip)
                        Text(
                            item.type_label,
                            style = centraidType("annotLabelOn"),
                            color = centraidColor("textSoft"),
                            modifier = Modifier.padding(start = 10.dp).weight(1f),
                        )
                        if (item.starred) {
                            CentraidIcon(iconKey = "Star", tint = centraidColor("textSoft"), size = 16.dp)
                        }
                        item.chips.forEach { chip -> StatusChipView(chip, Modifier.padding(start = 8.dp)) }
                    }
                    LockerNote(item.trashed_note, ink = "net")
                    LockerNote(item.status_line)
                }
                item.sections.forEachIndexed { index, section ->
                    item(key = "sec-$index") { if (section.title.isNotEmpty()) SectionHeader(SectionHead(title = section.title)) }
                    items(section.rows, key = { "f-$index-" + it.key }) { row ->
                        LockerFieldView(row) { verb ->
                            if (verb == "open") {
                                onOpen(row.value_)
                            } else {
                                onEvent(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = row.key, verb = verb)))
                            }
                        }
                    }
                }
                if (item.tags.isNotEmpty()) {
                    item(key = "tags") {
                        SectionHeader(SectionHead(title = item.tags_label))
                        FlowRow(
                            Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            item.tags.forEach { tag ->
                                Text(
                                    tag,
                                    style = centraidType("annotLabel"),
                                    color = centraidColor("textSoft"),
                                    modifier = Modifier
                                        .border(KitGeometry.HAIRLINE, centraidColor("line"), RoundedCornerShape(4.dp))
                                        .padding(horizontal = 6.dp, vertical = 2.dp),
                                )
                            }
                        }
                    }
                }
                item(key = "memo") {
                    if (item.memo.isNotEmpty() || item.memo_action.isNotEmpty()) {
                        SectionHeader(
                            SectionHead(title = item.memo_label, verb_label = item.memo_action),
                            onVerb = { onEvent(LockerItemEvent(memo_opened = LockerItemEvent.MemoOpened())) },
                        )
                        if (item.memo.isNotEmpty()) {
                            Text(
                                item.memo,
                                style = centraidType("body"),
                                color = centraidColor("text"),
                                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
                            )
                        }
                    }
                }
                if (item.actions.isNotEmpty()) {
                    item(key = "actions") {
                        FlowRow(
                            Modifier.fillMaxWidth().padding(KitGeometry.GUTTER),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            item.actions.forEach { action ->
                                QuietButton(
                                    action.label,
                                    testTag = "locker-action-${action.key}",
                                    ink = if (action.destructive) "net" else "text",
                                ) { onEvent(LockerItemEvent(action = LockerItemEvent.ActionTapped(key = action.key))) }
                            }
                        }
                    }
                }
            }
        }
    }
    state.confirm?.let { confirm ->
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(LockerItemEvent(confirmed = LockerItemEvent.Confirmed())) },
            onDismiss = { onEvent(LockerItemEvent(dismissed = LockerItemEvent.Dismissed())) },
        )
    }
    state.memo?.let { memo ->
        val close = { onEvent(LockerItemEvent(memo_closed = LockerItemEvent.MemoClosed())) }
        val text = remember { mutableStateOf(TextFieldValue(memo.text, TextRange(memo.text.length))) }
        SheetRoom(
            title = memo.title,
            onDismiss = close,
            primary = SheetPrimary(label = memo.save_label, testTag = "locker-memo-save") {
                onEvent(LockerItemEvent(memo_saved = LockerItemEvent.MemoSaved()))
            },
        ) {
            LockerTextField(
                text = text,
                label = memo.title,
                placeholder = memo.hint,
                singleLine = false,
                testTag = "locker-memo-text",
                onEdit = { onEvent(LockerItemEvent(memo_typed = LockerItemEvent.MemoTyped(text = it))) },
            )
            if (memo.cancel_label.isNotEmpty()) {
                QuietButton(memo.cancel_label, testTag = "locker-memo-cancel", modifier = Modifier.padding(horizontal = KitGeometry.GUTTER), onPress = close)
            }
        }
    }
}

/**
 * A FIELD ROW WITH VERBS. Sealed and concealed, it draws the machine's mask;
 * revealed, the plaintext and the countdown note. The value is plain `Text`,
 * which Compose never makes selectable — Copy is the one way off the screen.
 */
@Composable
private fun LockerFieldView(row: LockerFieldRow, onVerb: (String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .padding(start = KitGeometry.GUTTER, end = 8.dp, top = 6.dp, bottom = 6.dp)
            .testTag("locker-field-${row.key}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            Modifier
                .weight(1f)
                .then(
                    if (row.accessibility_label.isNotEmpty()) {
                        Modifier.clearAndSetSemantics { contentDescription = row.accessibility_label }
                    } else {
                        Modifier.semantics(mergeDescendants = true) { }
                    },
                ),
        ) {
            Text(row.label, style = centraidType("eyebrow"), color = centraidColor("textSoft"))
            val concealed = row.sealed_ && !row.revealed
            val shown = if (concealed) row.mask else row.value_
            val mono = row.monospace || concealed
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    shown,
                    style = if (mono) {
                        centraidType("body").copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, letterSpacing = if (concealed) androidx.compose.ui.unit.TextUnit(2f, androidx.compose.ui.unit.TextUnitType.Sp) else androidx.compose.ui.unit.TextUnit.Unspecified)
                    } else {
                        centraidType("body")
                    },
                    color = centraidColor(if (concealed) "textSoft" else "text"),
                    modifier = Modifier.testTag("locker-value-${row.key}"),
                )
                row.countdown?.takeIf { !concealed }?.let { LockerCountdownRing(it) }
            }
            if (row.note.isNotEmpty()) {
                Text(row.note, style = centraidType("annotLabel"), color = centraidColor("textFaint"))
            }
        }
        row.verbs.forEach { verb ->
            QuietButton(verb.label, testTag = "locker-verb-${row.key}-${verb.key}", modifier = Modifier.padding(start = 6.dp)) {
                onVerb(verb.key)
            }
        }
    }
}

/**
 * A ONE-TIME CODE'S LIFE (Q-1047-16): a small ring that empties as the step
 * runs out. The seconds are in the row's note too, so the ring carries no
 * semantics of its own.
 */
@Composable
private fun LockerCountdownRing(countdown: LockerCountdown) {
    val fraction = if (countdown.period > 0) (countdown.seconds_left.toFloat() / countdown.period).coerceIn(0f, 1f) else 0f
    val track = centraidColor("line")
    val ink = centraidColor(if (countdown.seconds_left <= 5) "net" else "textSoft")
    Canvas(
        Modifier
            .padding(start = 8.dp)
            .size(14.dp)
            .testTag("locker-code-countdown"),
    ) {
        val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round)
        drawArc(track, startAngle = 0f, sweepAngle = 360f, useCenter = false, style = stroke)
        drawArc(ink, startAngle = -90f, sweepAngle = 360f * fraction, useCenter = false, style = stroke)
    }
}

// ---------------------------------------------------------------------------
// locker.editor — add or edit, explicit Save
// ---------------------------------------------------------------------------

@Composable
internal fun LockerEditorScreen(state: LockerEditorState, onEvent: (LockerEditorEvent) -> Unit) {
    val chrome = state.chrome
    val data = state.data_
    val cancel = { onEvent(LockerEditorEvent(cancel = LockerEditorEvent.CancelTapped())) }
    // NOT AUTOSAVE: back asks the machine, which confirms a dirty leave.
    BackHandler(onBack = cancel)
    // LOCKER IS THE PASSWORD STORE (#1047 E3): no autofill service is offered
    // what is typed here, to fill or to save into its own store.
    NoAutofill()
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = chrome?.cancel_label.orEmpty(),
        backSpoken = chrome?.cancel_label?.ifEmpty { null },
        onBack = cancel,
        trailing = if (data?.can_save == true && chrome?.save_label.orEmpty().isNotEmpty()) {
            RoomAction("Check", chrome!!.save_label, "locker-editor-save") { onEvent(LockerEditorEvent(save = LockerEditorEvent.SaveTapped())) }
        } else {
            null
        },
        status = refusal(state.write).ifEmpty { data?.blocked.orEmpty() },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = null,
        ) { editor ->
            LazyColumn(Modifier.fillMaxSize().testTag("locker-editor")) {
                item(key = "lede") { LockerNote(chrome?.lede.orEmpty()) }
                if (editor.types.isNotEmpty()) {
                    item(key = "types") {
                        LockerLabel(editor.types_label)
                        LockerChoices(editor.types, testTag = "locker-type") { key ->
                            onEvent(LockerEditorEvent(type = LockerEditorEvent.TypePicked(key = key)))
                        }
                    }
                }
                items(editor.inputs, key = { "in-" + state.item_id + "-" + it.key }) { input ->
                    LockerInputView(input, onEvent)
                }
                item(key = "tags-" + state.item_id) {
                    val text = rememberSentText(editor.tags_text)
                    LockerTextField(
                        text = text.first,
                        label = editor.tags_label,
                        placeholder = editor.tags_hint,
                        testTag = "locker-editor-tags",
                        onEdit = {
                            text.second(it)
                            onEvent(LockerEditorEvent(tags = LockerEditorEvent.TagsTyped(text = it)))
                        },
                    )
                }
                if (editor.compromised_label.isNotEmpty()) {
                    item(key = "compromised") {
                        LockerCompromisedRow(editor.compromised_label, editor.compromised, editor.compromised_note) { on ->
                            onEvent(LockerEditorEvent(compromised = LockerEditorEvent.CompromisedToggled(on = on)))
                        }
                    }
                }
            }
        }
    }
    state.confirm?.let { confirm ->
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(LockerEditorEvent(confirmed = LockerEditorEvent.Confirmed())) },
            onDismiss = { onEvent(LockerEditorEvent(dismissed = LockerEditorEvent.Dismissed())) },
        )
    }
}

/**
 * ONE INPUT. A secret is a masked entry on the password keyboard, which the
 * IME neither autocorrects nor suggests from nor learns.
 */
@Composable
private fun LockerInputView(input: LockerInputRow, onEvent: (LockerEditorEvent) -> Unit) {
    val text = rememberSentText(input.value_)
    Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) {
                LockerTextField(
                    text = text.first,
                    label = input.label,
                    placeholder = input.placeholder,
                    secret = input.secret,
                    singleLine = input.kind != LockerInputRow.Kind.KIND_MULTILINE,
                    keyboard = keyboardOf(input),
                    testTag = "locker-input-${input.key}",
                    onEdit = {
                        text.second(it)
                        onEvent(LockerEditorEvent(typed = LockerEditorEvent.Typed(key = input.key, value_ = it)))
                    },
                )
            }
            if (input.generate_label.isNotEmpty()) {
                QuietButton(input.generate_label, testTag = "locker-generate-${input.key}", modifier = Modifier.padding(end = KitGeometry.GUTTER)) {
                    onEvent(LockerEditorEvent(generate = LockerEditorEvent.GenerateTapped(key = input.key)))
                }
            }
        }
        if (input.note.isNotEmpty()) {
            Text(
                input.note,
                style = centraidType("annotLabel"),
                color = centraidColor("textFaint"),
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER),
            )
        }
    }
}

/**
 * THE COMPROMISED FLAG (R-1047-F7): a switch row with its note under it. The
 * machine says what the note is — including that a newly typed password
 * clears the flag on save; this draws it.
 */
@Composable
private fun LockerCompromisedRow(label: String, on: Boolean, note: String, onToggle: (Boolean) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .toggleable(value = on, role = Role.Switch, onValueChange = onToggle)
                .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)
                .testTag("locker-editor-compromised"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, style = centraidType("body"), color = centraidColor("text"), modifier = Modifier.weight(1f))
            Switch(checked = on, onCheckedChange = null)
        }
        if (note.isNotEmpty()) {
            Text(
                note,
                style = centraidType("annotLabel"),
                color = centraidColor("textFaint"),
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER),
            )
        }
    }
}

private fun keyboardOf(input: LockerInputRow): KeyboardOptions = when {
    input.secret -> KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false)
    input.kind == LockerInputRow.Kind.KIND_EMAIL -> KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false)
    input.kind == LockerInputRow.Kind.KIND_URL -> KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false)
    input.kind == LockerInputRow.Kind.KIND_PHONE -> KeyboardOptions(keyboardType = KeyboardType.Phone)
    input.kind == LockerInputRow.Kind.KIND_NUMBER -> KeyboardOptions(keyboardType = KeyboardType.Number, autoCorrectEnabled = false)
    else -> KeyboardOptions.Default
}

/**
 * TYPING THAT CANNOT DROP A KEYSTROKE, and a value the machine changed that
 * still lands. The member's text lives here; every value this field sent is
 * remembered, so an answer that merely echoes one of them (late or not) never
 * overwrites what is typed now, while a value the member did not type — the
 * item loaded, a generated password — replaces it.
 */
@Composable
private fun rememberSentText(value: String): Pair<MutableState<TextFieldValue>, (String) -> Unit> {
    val text = remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    // THE VALUE LAST ADOPTED counts as sent: until the first keystroke's echo
    // arrives, the state still says it, and that is not a change to adopt.
    val sent = remember { mutableSetOf(value) }
    if (value != text.value.text && value !in sent) {
        text.value = TextFieldValue(value, TextRange(value.length))
        sent.clear()
        sent.add(value)
    }
    return text to { next: String -> sent.add(next) }
}

@Composable
private fun LockerTextField(
    text: MutableState<TextFieldValue>,
    label: String,
    placeholder: String,
    testTag: String,
    onEdit: (String) -> Unit,
    secret: Boolean = false,
    singleLine: Boolean = true,
    keyboard: KeyboardOptions = KeyboardOptions.Default,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp)) {
        if (label.isNotEmpty()) Text(label, style = centraidType("eyebrow"), color = centraidColor("textSoft"))
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 40.dp)
                .border(KitGeometry.HAIRLINE, centraidColor("line"), RoundedCornerShape(KitGeometry.RADIUS))
                .padding(horizontal = 10.dp, vertical = 8.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (text.value.text.isEmpty() && placeholder.isNotEmpty()) {
                Text(
                    placeholder,
                    style = centraidType("body"),
                    color = centraidColor("textFaint"),
                    modifier = Modifier.clearAndSetSemantics { },
                )
            }
            BasicTextField(
                value = text.value,
                onValueChange = { next ->
                    val changed = next.text != text.value.text
                    text.value = next
                    if (changed) onEdit(next.text)
                },
                singleLine = singleLine,
                keyboardOptions = keyboard,
                visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
                textStyle = centraidType("body").copy(
                    color = centraidColor("text"),
                    fontFamily = if (secret) androidx.compose.ui.text.font.FontFamily.Monospace else centraidType("body").fontFamily,
                ),
                cursorBrush = SolidColor(centraidColor("text")),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(testTag)
                    .semantics {
                        contentDescription = label.ifEmpty { placeholder }
                        contentDataType = ContentDataType.None
                    },
            )
        }
    }
}

/** A refused write's sentence, for the page's status line. */
internal fun refusal(write: WriteState?): String =
    if (write?.phase == WriteState.Phase.PHASE_REFUSED) write.failure?.sentence.orEmpty() else ""
