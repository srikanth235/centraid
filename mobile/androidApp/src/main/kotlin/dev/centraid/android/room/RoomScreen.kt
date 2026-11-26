package dev.centraid.android.room

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.core.v1.Room
import centraid.core.v1.RoomBand
import centraid.core.v1.RoomBlock
import centraid.core.v1.RoomChange
import centraid.core.v1.RoomFilterMenu
import centraid.core.v1.RoomHeader
import centraid.core.v1.RoomKey
import centraid.core.v1.RoomKeyRole
import centraid.core.v1.RoomKind
import centraid.core.v1.RoomSearch
import centraid.core.v1.RoomSelection
import centraid.core.v1.RoomStatusLine
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.BandPolicy
import dev.centraid.android.kit.BandSearchKey
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.FailureView
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.KitPillButton
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.LocalBandSearchKey
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SecureWindow
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.StageKey
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.bandFloor
import dev.centraid.android.kit.bandGround
import dev.centraid.android.kit.kitCard
import dev.centraid.android.kit.kitStatusPill
import dev.centraid.android.kit.kitTextStyle
import dev.centraid.android.kit.menuTestIds
import dev.centraid.android.kit.readableColumn
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import androidx.compose.runtime.CompositionLocalProvider
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter

@Composable
internal fun RoomView(
    room: Room,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
    onScrolled: (anchorSelectorId: String, fractionMilli: Int) -> Unit = { _, _ -> },
    modifier: Modifier = Modifier,
    inlineSheet: Boolean = false,
) {
    if (room.secure) SecureWindow(secure = true)
    val backSelector = room.header_?.back?.selector_id.orEmpty()
    if (backSelector.isNotEmpty()) {
        BackHandler { onTap(backSelector) }
    }

    when (room.kind) {
        RoomKind.ROOM_KIND_STAGE -> RoomStageLayout(room, onTap, onChange, modifier)
        RoomKind.ROOM_KIND_SHEET -> if (inlineSheet) {
            RoomSheetBody(room, onTap, onChange, modifier)
        } else {
            RoomSheetModal(room, onTap, onChange, modifier)
        }
        else -> RoomStandardLayout(room, onTap, onChange, onScrolled, modifier)
    }
}

@Composable
private fun RoomStandardLayout(
    room: Room,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
    onScrolled: (String, Int) -> Unit,
    modifier: Modifier,
) {
    val isEditor = room.kind == RoomKind.ROOM_KIND_EDITOR
    val showBand = !isEditor && room.band != null && room.selection?.on != true && room.search?.open_ != true
    val listState = rememberLazyListState()
    val readyBlocks = room.ready?.blocks.orEmpty()

    LaunchedEffect(room.restore) {
        val place = room.restore ?: return@LaunchedEffect
        if (place.anchor_selector_id.isEmpty()) return@LaunchedEffect
        val index = readyBlocks.indexOfFirst { it.selectorIdOf() == place.anchor_selector_id }
        if (index >= 0) {
            listState.scrollToItem(index, 0)
        }
    }

    LaunchedEffect(listState, readyBlocks) {
        snapshotFlow { listState.isScrollInProgress }
            .distinctUntilChanged()
            .filter { !it }
            .collect {
                val first = listState.layoutInfo.visibleItemsInfo.firstOrNull() ?: return@collect
                val selector = readyBlocks.getOrNull(first.index)?.selectorIdOf().orEmpty()
                if (selector.isNotEmpty()) {
                    val fraction = if (first.size > 0) {
                        ((-first.offset).coerceIn(0, first.size) * 1000) / first.size
                    } else {
                        0
                    }
                    onScrolled(selector, fraction.coerceIn(0, 999))
                }
            }
    }

    Column(
        modifier
            .fillMaxSize()
            .background(Surface.page)
            .testTag("room-${room.key.ifEmpty { room.kind.name.lowercase() }}"),
    ) {
        room.header_?.let { header ->
            RoomHeaderSlot(
                kind = room.kind,
                header = header,
                onTap = onTap,
            )
        }

        Box(Modifier.weight(1f).fillMaxWidth().readableColumn()) {
            when {
                room.loading != null -> RowSkeleton()
                room.failed != null -> {
                    val failed = room.failed!!
                    FailureView(
                        sentence = failed.sentence,
                        remedy = "",
                        onRetry = failed.retry_selector_id.takeIf { it.isNotEmpty() }?.let { id -> { onTap(id) } },
                        retryLabel = failed.retry_label.ifEmpty { KitWords.RETRY },
                    )
                }
                else -> {
                    val search = room.search
                    LazyColumn(
                        state = listState,
                        contentPadding = PaddingValues(top = 6.dp, bottom = 24.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        if (search != null && search.open_ && search.containers.isNotEmpty()) {
                            itemsIndexed(
                                search.containers,
                                key = { idx, row -> row.selector_id.ifEmpty { "search-container-$idx" } },
                            ) { idx, row ->
                                Box(Modifier.padding(horizontal = KitGeometry.GUTTER).kitCard()) {
                                    RoomRowBlock(row, onTap, hairline = false)
                                }
                            }
                        }
                        itemsIndexed(
                            readyBlocks,
                            key = { idx, block -> block.selectorIdOf().ifEmpty { "block-$idx" } },
                        ) { _, block ->
                            RoomBlockView(block, onTap = onTap, onChange = onChange)
                        }
                        if (search != null && search.open_ && search.ask != null) {
                            item(key = "search-ask") {
                                Box(Modifier.padding(horizontal = KitGeometry.GUTTER).kitCard()) {
                                    RoomRowBlock(search.ask!!, onTap, hairline = false)
                                }
                            }
                        }
                    }
                }
            }
        }

        Column(Modifier.fillMaxWidth().readableColumn()) {
            room.status_line?.let { statusLine ->
                RoomStatusLineSlot(statusLine, onTap)
            }
            when {
                room.selection?.on == true -> RoomSelectionSlot(room.selection!!, onTap)
                room.search?.open_ == true -> RoomSearchSlot(room.search!!, onTap, onChange)
                showBand -> RoomBandSlot(room.band!!, onTap)
            }
        }
    }
}

@Composable
private fun RoomStageLayout(
    room: Room,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
    modifier: Modifier,
) {
    val closeSelector = room.header_?.back?.selector_id
        ?: room.header_?.keys?.firstOrNull()?.selector_id.orEmpty()
    Box(
        modifier
            .fillMaxSize()
            .background(centraidColor("stage"))
            .pointerInput(closeSelector) {
                var drag = 0f
                detectVerticalDragGestures(
                    onDragEnd = {
                        if (drag > 120f && closeSelector.isNotEmpty()) onTap(closeSelector)
                        drag = 0f
                    },
                    onVerticalDrag = { _, delta -> drag += delta },
                )
            }
            .testTag("room-stage"),
    ) {
        Column(
            Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            room.ready?.blocks?.forEach { block ->
                RoomBlockView(block, onTap = onTap, onChange = onChange)
            }
        }
        if (closeSelector.isNotEmpty()) {
            StageKey(
                iconKey = "X",
                label = KitWords.DISMISS,
                onClick = { onTap(closeSelector) },
                modifier = Modifier.align(Alignment.TopEnd).padding(12.dp).testTag(closeSelector),
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RoomSheetModal(
    room: Room,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
    modifier: Modifier,
) {
    val dismissSelector = room.header_?.back?.selector_id.orEmpty()
    ModalBottomSheet(
        onDismissRequest = { if (dismissSelector.isNotEmpty()) onTap(dismissSelector) },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Surface.sheet,
    ) {
        RoomSheetBody(room, onTap, onChange, modifier)
    }
}

@Composable
internal fun RoomSheetBody(
    room: Room,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .background(Surface.sheet)
            .navigationBarsPadding()
            .padding(bottom = 16.dp)
            .semantics { testTagsAsResourceId = true }
            .testTag("room-sheet"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val title = room.header_?.title.orEmpty()
        if (title.isNotEmpty()) {
            KitText(
                title,
                KitType.Section,
                Surface.ink,
                Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp).semantics { heading() },
            )
        }
        room.ready?.blocks?.forEach { block ->
            RoomBlockView(block, onTap = onTap, onChange = onChange)
        }
        room.status_line?.let { RoomStatusLineSlot(it, onTap) }
    }
}

@Composable
internal fun RoomHeaderSlot(
    kind: RoomKind,
    header: RoomHeader,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val inline = kind == RoomKind.ROOM_KIND_PUSHED_PAGE ||
        kind == RoomKind.ROOM_KIND_EDITOR ||
        (kind == RoomKind.ROOM_KIND_SYSTEM_PLACE && header.back != null)
    Row(
        modifier
            .fillMaxWidth()
            .readableColumn()
            .padding(
                start = if (inline && header.back != null) 4.dp else KitGeometry.GUTTER,
                end = KitGeometry.GUTTER,
                top = 8.dp,
                bottom = 8.dp,
            )
            .testTag("room-header"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        header.back?.let { back ->
            IconKey(
                iconKey = if (kind == RoomKind.ROOM_KIND_EDITOR) "X" else "ChevronLeft",
                label = KitWords.backTo(back.label),
                testTag = back.selector_id.ifEmpty { "room-back" },
                bordered = false,
                onPress = { onTap(back.selector_id) },
            )
        }
        Column(Modifier.weight(1f)) {
            if (header.title.isNotEmpty()) {
                KitText(
                    header.title,
                    if (inline) KitType.Section else KitType.Title,
                    Surface.ink,
                    Modifier.semantics { heading() },
                    maxLines = if (inline) 1 else 2,
                )
            }
            if (header.subtitle.isNotEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    KitText(header.subtitle, KitType.Meta, Surface.meta, maxLines = 1)
                    if (header.subtitle_clear_selector_id.isNotEmpty()) {
                        IconKey(
                            iconKey = "X",
                            label = KitWords.DISMISS,
                            testTag = header.subtitle_clear_selector_id,
                            bordered = false,
                            onPress = { onTap(header.subtitle_clear_selector_id) },
                        )
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            header.filter?.let { filter ->
                RoomFilterSlot(filter, onTap)
            }
            header.keys.forEach { key ->
                RoomKeyButton(key, onTap)
            }
        }
    }
}

@Composable
private fun RoomKeyButton(key: RoomKey, onTap: (String) -> Unit) {
    var menuOpen by remember { mutableStateOf(false) }
    val accent = appAccent()
    Box {
        when (key.role) {
            RoomKeyRole.ROOM_KEY_ROLE_ADD -> Box(
                Modifier
                    .size(KitGeometry.ROW_MIN)
                    .clip(CircleShape)
                    .clickable(enabled = key.enabled) { onTap(key.selector_id) }
                    .testTag(key.selector_id.ifEmpty { "header-add" })
                    .clearAndSetSemantics {
                        contentDescription = key.label
                        role = Role.Button
                    },
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.size(38.dp).clip(CircleShape).background(accent.fill), contentAlignment = Alignment.Center) {
                    CentraidIcon(key.icon.ifEmpty { "Plus" }, tint = Color.White, size = 18.dp)
                }
            }
            RoomKeyRole.ROOM_KEY_ROLE_VERB -> KitPillButton(
                label = key.label,
                enabled = key.enabled,
                testTag = key.selector_id.ifEmpty { "header-verb" },
                onPress = { onTap(key.selector_id) },
            )
            else -> IconKey(
                iconKey = key.icon.ifEmpty { "MoreHoriz" },
                label = key.label.ifEmpty { KitWords.BAND_MORE },
                testTag = key.selector_id.ifEmpty { "header-key" },
                enabled = key.enabled,
                onPress = {
                    if (key.menu != null) menuOpen = true else onTap(key.selector_id)
                },
            )
        }
        key.menu?.let { menu ->
            RoomDropdownMenu(
                menu = menu,
                expanded = menuOpen,
                onDismiss = { menuOpen = false },
                onTap = { id ->
                    menuOpen = false
                    onTap(id)
                },
            )
        }
    }
}

@Composable
internal fun RoomFilterSlot(
    filter: RoomFilterMenu,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var open by remember { mutableStateOf(false) }
    val accent = appAccent()
    Box(modifier) {
        Box(
            Modifier
                .size(KitGeometry.ROW_MIN)
                .clip(CircleShape)
                .clickable { open = true }
                .testTag(filter.menu?.selector_id?.ifEmpty { "room-filter" } ?: "room-filter")
                .clearAndSetSemantics {
                    contentDescription = "Filter"
                    role = Role.Button
                },
            contentAlignment = Alignment.Center,
        ) {
            val plate = if (filter.filtering) {
                Modifier.clip(CircleShape).background(accent.fill)
            } else {
                Modifier.clip(CircleShape).background(Surface.card).border(KitGeometry.HAIRLINE, Surface.border, CircleShape)
            }
            Box(Modifier.size(38.dp).then(plate), contentAlignment = Alignment.Center) {
                CentraidIcon(
                    iconKey = "Filter",
                    tint = if (filter.filtering) Color.White else Surface.ink,
                    size = 18.dp,
                    solid = filter.filtering,
                )
            }
        }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            modifier = Modifier.menuTestIds().testTag("room-filter-menu"),
            containerColor = Surface.card,
        ) {
            if (filter.filtering && filter.clear_selector_id.isNotEmpty()) {
                DropdownMenuItem(
                    text = { Text("Clear filters", color = Surface.ink) },
                    onClick = {
                        open = false
                        onTap(filter.clear_selector_id)
                    },
                    modifier = Modifier.testTag(filter.clear_selector_id),
                )
                RoomHairline()
            }
            filter.menu?.sections?.forEachIndexed { sIdx, section ->
                if (sIdx > 0) RoomHairline()
                if (section.heading.isNotEmpty()) {
                    KitText(
                        section.heading,
                        KitType.Group,
                        Surface.meta,
                        Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                }
                section.items.forEach { item ->
                    DropdownMenuItem(
                        text = { Text(item.label, color = Surface.ink) },
                        leadingIcon = {
                            if (item.checked) {
                                CentraidIcon("Check", tint = accent.text, size = 16.dp)
                            } else {
                                Spacer(Modifier.size(16.dp))
                            }
                        },
                        enabled = item.enabled,
                        onClick = {
                            open = false
                            onTap(item.selector_id)
                        },
                        modifier = Modifier.testTag(item.selector_id),
                    )
                }
            }
        }
    }
}

@Composable
internal fun RoomBandSlot(
    band: RoomBand,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (band.home_selector_id.isEmpty() && band.more == null && band.more_selector_id.isEmpty() && band.search_selector_id.isEmpty()) {
        dev.centraid.android.kit.HomeBand(
            tabs = band.tabs.map { tab ->
                centraid.core.v1.ShellBandTab(
                    tab = tab.selector_id,
                    label = tab.label,
                    spoken = tab.label,
                    icon_key = tab.icon,
                    selected = tab.selected,
                )
            },
            onSelect = { selectorId -> onTap(selectorId) },
            modifier = modifier,
        )
        return
    }
    var moreOpen by remember { mutableStateOf(false) }
    val tabs = band.tabs.map { tab ->
        AppBandTab(
            key = tab.selector_id,
            label = tab.label,
            iconKey = tab.icon,
            selected = tab.selected,
        )
    }
    val searchKey = band.search_selector_id.takeIf { it.isNotEmpty() }?.let { id ->
        BandSearchKey(KitWords.SEARCH) { onTap(id) }
    }
    val onMore: (() -> Unit)? = when {
        band.more != null -> ({ moreOpen = true })
        band.more_selector_id.isNotEmpty() -> ({ onTap(band.more_selector_id) })
        else -> null
    }
    CompositionLocalProvider(LocalBandSearchKey provides searchKey) {
        AppBand(
            app = "room",
            tabs = tabs,
            onSelect = { selectorId -> onTap(selectorId) },
            onHome = { if (band.home_selector_id.isNotEmpty()) onTap(band.home_selector_id) },
            onMore = onMore,
            modifier = modifier,
        )
    }
    if (moreOpen && band.more != null) {
        SheetRoom(title = KitWords.BAND_MORE, onDismiss = { moreOpen = false }, expanded = true) {
            RoomMenuBlock(
                menu = band.more!!,
                onTap = { id ->
                    moreOpen = false
                    onTap(id)
                },
            )
        }
    }
}

@Composable
internal fun RoomStatusLineSlot(
    line: RoomStatusLine,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (line.sentence.isEmpty()) return
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
        if (line.action_label.isNotEmpty() && line.action_selector_id.isNotEmpty()) {
            Text(
                line.action_label,
                style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                color = appAccent().text,
                modifier = Modifier
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .clickable { onTap(line.action_selector_id) }
                    .padding(horizontal = 12.dp, vertical = 10.dp)
                    .testTag(line.action_selector_id)
                    .semantics { role = Role.Button },
            )
        }
    }
}

@Composable
internal fun RoomSearchSlot(
    search: RoomSearch,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
    modifier: Modifier = Modifier,
) {
    var seq by remember(search.selector_id) { mutableLongStateOf(0L) }
    var term by remember(search.selector_id, search.term) { mutableStateOf(search.term) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(search.open_) {
        if (search.open_) runCatching { focus.requestFocus() }
    }
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = BandPolicy.BAND_INSET.dp, vertical = 6.dp)
            .bandFloor()
            .testTag("room-search"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (search.corrected.isNotEmpty()) {
            KitText(
                search.corrected,
                KitType.Meta,
                Surface.meta,
                Modifier
                    .padding(start = 12.dp)
                    .testTag("search-corrected"),
            )
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                Modifier
                    .weight(1f)
                    .height(BandPolicy.SEARCH_HEIGHT.dp)
                    .bandGround(CircleShape)
                    .clip(CircleShape)
                    .padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CentraidIcon("Search", tint = Surface.meta, size = 16.dp)
                Box(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                    if (term.isEmpty() && search.placeholder.isNotEmpty()) {
                        KitText(search.placeholder, KitType.Row, Surface.meta, maxLines = 1)
                    }
                    BasicTextField(
                        value = term,
                        onValueChange = { next ->
                            term = next
                            seq += 1L
                            onChange(RoomChange(selector_id = search.selector_id, seq = seq, text = next))
                        },
                        singleLine = true,
                        textStyle = kitTextStyle(KitType.Row).copy(color = Surface.ink),
                        cursorBrush = SolidColor(Surface.ink),
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(focus)
                            .testTag(search.selector_id.ifEmpty { "room-search-field" }),
                    )
                }
            }
            if (search.close_selector_id.isNotEmpty()) {
                IconKey(
                    iconKey = "X",
                    label = KitWords.CLOSE_SEARCH,
                    testTag = search.close_selector_id,
                    onPress = { onTap(search.close_selector_id) },
                )
            }
        }
    }
}

@Composable
internal fun RoomSelectionSlot(
    selection: RoomSelection,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = BandPolicy.BAND_INSET.dp, vertical = 6.dp)
            .bandFloor()
            .bandGround(RoundedCornerShape(BandPolicy.BAND_RADIUS.dp))
            .padding(horizontal = 14.dp, vertical = 6.dp)
            .testTag("room-selection"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        KitText(selection.label, KitType.Row, Surface.ink, Modifier.weight(1f), maxLines = 1)
        if (selection.select_all_selector_id.isNotEmpty()) {
            KitLink(
                label = KitWords.SELECT,
                onClick = { onTap(selection.select_all_selector_id) },
                dense = true,
                modifier = Modifier.testTag(selection.select_all_selector_id),
            )
        }
        selection.actions.forEach { action ->
            if (action.icon.isNotEmpty()) {
                IconKey(
                    iconKey = action.icon,
                    label = action.label,
                    testTag = action.selector_id,
                    bordered = false,
                    enabled = action.enabled,
                    onPress = { onTap(action.selector_id) },
                )
            } else {
                KitLink(
                    label = action.label,
                    onClick = { onTap(action.selector_id) },
                    dense = true,
                    enabled = action.enabled,
                    modifier = Modifier.testTag(action.selector_id),
                )
            }
        }
        if (selection.done_selector_id.isNotEmpty()) {
            KitLink(
                label = KitWords.DONE,
                onClick = { onTap(selection.done_selector_id) },
                dense = true,
                modifier = Modifier.testTag(selection.done_selector_id),
            )
        }
    }
}

private fun RoomBlock.selectorIdOf(): String = when {
    section != null -> section!!.selector_id
    row != null -> row!!.selector_id
    choice != null -> choice!!.selector_id
    figure != null -> figure!!.selector_id
    media != null -> media!!.selector_id
    glance != null -> glance!!.selector_id
    menu != null -> menu!!.selector_id
    earlier_versions != null -> earlier_versions!!.selector_id
    origin != null -> origin!!.selector_id
    else -> ""
}
