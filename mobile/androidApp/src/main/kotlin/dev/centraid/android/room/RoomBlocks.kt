package dev.centraid.android.room

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.core.v1.RoomBlock
import centraid.core.v1.RoomCanvasEvent
import centraid.core.v1.RoomChange
import centraid.core.v1.RoomCheck
import centraid.core.v1.RoomCheckState
import centraid.core.v1.RoomChip
import centraid.core.v1.RoomChoice
import centraid.core.v1.RoomChoiceStyle
import centraid.core.v1.RoomConfirm
import centraid.core.v1.RoomConfirmClass
import centraid.core.v1.RoomEmpty
import centraid.core.v1.RoomFactKind
import centraid.core.v1.RoomFacts
import centraid.core.v1.RoomFigure
import centraid.core.v1.RoomGlance
import centraid.core.v1.RoomGlyph
import centraid.core.v1.RoomHero
import centraid.core.v1.RoomMark
import centraid.core.v1.RoomMedia
import centraid.core.v1.RoomMediaKind
import centraid.core.v1.RoomMenu
import centraid.core.v1.RoomMenuItem
import centraid.core.v1.RoomProgress
import centraid.core.v1.RoomProse
import centraid.core.v1.RoomRow
import centraid.core.v1.RoomSection
import centraid.core.v1.RoomTiles
import centraid.core.v1.RoomTone
import centraid.core.v1.RoomTrash
import centraid.core.v1.RoomWall
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ChoiceStack
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitChip
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.KitPillButton
import dev.centraid.android.kit.KitProgressBar
import dev.centraid.android.kit.KitRowAction
import dev.centraid.android.kit.KitSegmented
import dev.centraid.android.kit.KitSwipeRow
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitTile
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitCard
import dev.centraid.android.kit.kitTextStyle
import dev.centraid.android.kit.menuTestIds
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidDark
import dev.centraid.design.CentraidScale

@Composable
internal fun RoomBlockView(
    block: RoomBlock,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
    modifier: Modifier = Modifier,
    onCanvas: (RoomCanvasEvent) -> Unit = {},
) {
    when {
        block.hero != null -> RoomHeroBlock(block.hero!!, onTap, modifier)
        block.section != null -> RoomSectionBlock(block.section!!, onTap, onChange, modifier, onCanvas)
        block.row != null -> RoomRowBlock(block.row!!, onTap, modifier = modifier)
        block.facts != null -> RoomFactsBlock(block.facts!!, onTap, modifier)
        block.form != null -> RoomFormBlock(block.form!!, onTap, onChange, modifier)
        block.choice != null -> RoomChoiceBlock(block.choice!!, onChange, modifier)
        block.figure != null -> RoomFigureBlock(block.figure!!, onTap, modifier)
        block.prose != null -> RoomProseBlock(block.prose!!, onTap, modifier)
        block.media != null -> RoomMediaBlock(block.media!!, onTap, modifier)
        block.progress != null -> RoomProgressBlock(block.progress!!, onTap, modifier)
        block.empty != null -> RoomEmptyBlock(block.empty!!, onTap, modifier)
        block.wall != null -> RoomWallBlock(block.wall!!, onTap, modifier)
        block.tiles != null -> RoomTilesBlock(block.tiles!!, onTap, modifier)
        block.glance != null -> RoomGlanceBlock(block.glance!!, onTap, modifier)
        block.trash != null -> RoomTrashBlock(block.trash!!, onTap, modifier)
        block.confirm != null -> RoomConfirmBlock(block.confirm!!, onTap, modifier)
        block.menu != null -> RoomMenuBlock(block.menu!!, onTap, modifier)
        block.attachments != null -> RoomAttachmentsBlock(block.attachments!!, onTap, modifier)
        block.linked != null -> RoomLinkedBlock(block.linked!!, onTap, modifier)
        block.mentioned_in != null -> RoomMentionedInBlock(block.mentioned_in!!, onTap, modifier)
        block.says != null -> RoomSaysBlock(block.says!!, onTap, modifier)
        block.earlier_versions != null -> RoomEarlierVersionsBlock(block.earlier_versions!!, onTap, modifier)
        block.origin != null -> RoomOriginBlock(block.origin!!, onTap, modifier)
        block.calendar_grid != null -> RoomCanvasPlaceholder("calendar_grid", block.calendar_grid!!.anchor_day, modifier)
        block.photo_grid != null -> RoomCanvasPlaceholder("photo_grid", "", modifier)
        block.note_editor != null -> RoomCanvasPlaceholder("note_editor", block.note_editor!!.title, modifier)
        block.chart != null -> ChartCanvas(block.chart!!, onCanvas, modifier)
    }
}

@Composable
internal fun RoomHairline(startIndent: Dp = 0.dp) {
    Spacer(
        Modifier
            .padding(start = startIndent)
            .fillMaxWidth()
            .height(KitGeometry.HAIRLINE)
            .background(Surface.line),
    )
}

@Composable
internal fun roomToneColor(tone: RoomTone): Color = when (tone) {
    RoomTone.ROOM_TONE_SEAM, RoomTone.ROOM_TONE_WARNING -> StateColor.Amber.text
    RoomTone.ROOM_TONE_NET -> StateColor.Red.text
    RoomTone.ROOM_TONE_ACCENT -> appAccent().text
    else -> Surface.ink
}

// RoomTone and RoomChip are passed directly to kit/Rows.kt.

@Composable
internal fun RoomMarkView(
    mark: RoomMark,
    onTap: (String) -> Unit,
    size: Dp = 36.dp,
    modifier: Modifier = Modifier,
) {
    when {
        mark.glyph != null -> {
            val glyph = mark.glyph!!
            val accent = appAccent()
            Box(
                modifier
                    .size(size)
                    .clip(RoundedCornerShape((size.value * 0.28f).dp))
                    .background(accent.wash(centraidDark()))
                    .clearAndSetSemantics { },
                contentAlignment = Alignment.Center,
            ) {
                CentraidIcon(
                    iconKey = glyph.icon.ifEmpty { "CheckCircle" },
                    tint = accent.text,
                    size = (size.value * 0.52f).dp,
                )
            }
        }
        mark.thumb != null -> {
            val thumb = mark.thumb!!
            Box(
                modifier
                    .size(size)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Surface.fill)
                    .semantics { if (thumb.alt.isNotEmpty()) contentDescription = thumb.alt },
                contentAlignment = Alignment.Center,
            ) {
                CentraidIcon(iconKey = "Image", tint = Surface.meta, size = (size.value * 0.5f).dp)
            }
        }
        mark.check != null -> RoomCheckView(mark.check!!, onTap, modifier)
    }
}

@Composable
private fun RoomCheckView(
    check: RoomCheck,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val accent = appAccent().fill
    val shape = CircleShape
    Box(
        modifier
            .size(KitGeometry.ROW_MIN)
            .clip(shape)
            .clickable(enabled = check.selector_id.isNotEmpty()) { onTap(check.selector_id) }
            .testTag(check.selector_id.ifEmpty { "room-check" })
            .semantics { role = Role.Checkbox },
        contentAlignment = Alignment.Center,
    ) {
        when (check.state) {
            RoomCheckState.ROOM_CHECK_STATE_ON -> Box(
                Modifier.size(22.dp).clip(shape).background(accent),
                contentAlignment = Alignment.Center,
            ) {
                CentraidIcon("Check", tint = Color.White, size = 14.dp)
            }
            RoomCheckState.ROOM_CHECK_STATE_MIXED -> Box(
                Modifier.size(22.dp).clip(shape).background(Surface.fill).border(1.5.dp, Surface.border, shape),
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.width(10.dp).height(2.dp).background(Surface.meta))
            }
            RoomCheckState.ROOM_CHECK_STATE_PARTIAL -> Box(
                Modifier.size(22.dp).clip(shape).border(1.5.dp, accent, shape),
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.size(10.dp).clip(shape).background(accent))
            }
            else -> Box(Modifier.size(22.dp).clip(shape).border(1.5.dp, Surface.border, shape))
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun RoomHeroBlock(
    hero: RoomHero,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp)
            .testTag("block-hero"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        hero.mark?.let { RoomMarkView(it, onTap, size = 72.dp) }
        KitText(hero.title, KitType.Hero, Surface.ink, Modifier.semantics { heading() })
        if (hero.noun.isNotEmpty()) {
            KitText(hero.noun, KitType.Meta, Surface.meta)
        }
        hero.lines.forEach { line ->
            KitText(line, KitType.Meta, Surface.body)
        }
        if (hero.chips.isNotEmpty()) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                hero.chips.forEach { chip ->
                    dev.centraid.android.kit.StatusChipView(chip)
                }
            }
        }
        if (hero.primary != null || hero.menu != null) {
            Row(
                Modifier.padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                hero.primary?.let { primary ->
                    KitPillButton(
                        label = primary.label,
                        enabled = primary.enabled,
                        testTag = primary.selector_id.ifEmpty { "hero-primary" },
                        onPress = { onTap(primary.selector_id) },
                    )
                }
                hero.menu?.let { menu ->
                    Box {
                        IconKey(
                            iconKey = "MoreHoriz",
                            label = KitWords.BAND_MORE,
                            testTag = menu.selector_id.ifEmpty { "hero-menu" },
                            onPress = { menuOpen = true },
                        )
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
        }
    }
}

@Composable
internal fun RoomSectionBlock(
    section: RoomSection,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
    modifier: Modifier = Modifier,
    onCanvas: (RoomCanvasEvent) -> Unit = {},
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp)
            .testTag(section.selector_id.ifEmpty { "block-section" }),
    ) {
        if (section.heading.isNotEmpty() || section.trailing != null) {
            Row(
                Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val label = if (section.count_label.isNotEmpty()) {
                    "${section.heading} · ${section.count_label}"
                } else {
                    section.heading
                }
                if (label.isNotEmpty()) {
                    KitText(label, KitType.Group, Surface.meta, Modifier.weight(1f).semantics { heading() })
                } else {
                    Spacer(Modifier.weight(1f))
                }
                section.trailing?.let { trailing ->
                    KitLink(
                        label = trailing.label,
                        onClick = { onTap(trailing.selector_id) },
                        dense = true,
                        enabled = trailing.enabled,
                        modifier = Modifier.testTag(trailing.selector_id.ifEmpty { "section-trailing" }),
                    )
                }
            }
        }
        val allRows = section.blocks.isNotEmpty() && section.blocks.all { it.row != null }
        if (allRows) {
            Column(Modifier.fillMaxWidth().kitCard()) {
                section.blocks.forEachIndexed { index, child ->
                    RoomRowBlock(
                        row = child.row!!,
                        onTap = onTap,
                        hairline = index < section.blocks.lastIndex,
                    )
                }
            }
        } else {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                section.blocks.forEach { child ->
                    RoomBlockView(child, onTap = onTap, onChange = onChange, onCanvas = onCanvas)
                }
            }
        }
        if (section.next_page_selector_id.isNotEmpty()) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                KitLink(
                    label = KitWords.SHOW_MORE,
                    onClick = { onTap(section.next_page_selector_id) },
                    modifier = Modifier.testTag(section.next_page_selector_id),
                )
            }
        }
    }
}

@Composable
internal fun RoomRowBlock(
    row: RoomRow,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
    hairline: Boolean = true,
) {
    val swipeActions = buildList {
        row.swipe?.let { swipe ->
            add(
                KitRowAction(
                    id = swipe.selector_id.ifEmpty { "trash" },
                    label = swipe.label.ifEmpty { KitWords.DELETE },
                    tone = KitRowAction.Tone.Red,
                    onPress = { onTap(swipe.selector_id) },
                ),
            )
        }
        row.menu?.sections?.forEach { section ->
            section.items.forEach { item ->
                add(
                    KitRowAction(
                        id = item.selector_id,
                        label = item.label,
                        tone = if (item.destructive) KitRowAction.Tone.Red else KitRowAction.Tone.Neutral,
                        menuOnly = true,
                        onPress = { if (item.enabled) onTap(item.selector_id) },
                    ),
                )
            }
        }
    }
    val tap = if (row.selector_id.isNotEmpty()) ({ onTap(row.selector_id) }) else null
    val content: @Composable () -> Unit = {
        Row(
            Modifier
                .fillMaxWidth()
                .background(if (row.selected) Surface.fill else Color.Transparent),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (row.selected) {
                Box(Modifier.padding(start = 12.dp)) {
                    CentraidIcon("Check", tint = appAccent().text, size = 16.dp)
                }
            }
            row.mark?.let { mark ->
                Box(Modifier.padding(start = 12.dp)) {
                    RoomMarkView(mark, onTap, size = 34.dp)
                }
            }
            CentraidRow(
                title = row.title,
                meta = row.meta,
                trailing = row.trailing,
                trailingTone = row.trailing_tone,
                chips = row.chips,
                dimmed = row.dimmed,
                pending = row.pending,
                a11y = row.a11y_label,
                testTag = row.selector_id.ifEmpty { "block-row" },
                onTap = if (swipeActions.isEmpty()) tap else null,
                hairline = hairline,
                modifier = Modifier.weight(1f),
            )
        }
    }
    if (swipeActions.isNotEmpty()) {
        KitSwipeRow(
            actions = swipeActions,
            onTap = tap,
            modifier = modifier.fillMaxWidth(),
            content = content,
        )
    } else {
        Box(modifier.fillMaxWidth()) { content() }
    }
}

@Composable
internal fun RoomFactsBlock(
    facts: RoomFacts,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .kitCard()
            .testTag("block-facts"),
    ) {
        facts.facts.forEachIndexed { index, fact ->
            val mono = fact.kind == RoomFactKind.ROOM_FACT_KIND_SECRET
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    if (fact.label.isNotEmpty()) {
                        KitText(fact.label, KitType.Meta, Surface.meta)
                    }
                    Text(
                        text = if (fact.sealed_) "••••••" else fact.value_,
                        style = kitTextStyle(KitType.Row).copy(
                            fontFamily = if (mono) FontFamily.Monospace else kitTextStyle(KitType.Row).fontFamily,
                        ),
                        color = if (fact.kind == RoomFactKind.ROOM_FACT_KIND_LINK) appAccent().text else Surface.ink,
                    )
                }
                if (fact.reveal_selector_id.isNotEmpty()) {
                    KitLink(
                        label = if (fact.sealed_) KitWords.OPEN else KitWords.DISMISS,
                        onClick = { onTap(fact.reveal_selector_id) },
                        dense = true,
                        modifier = Modifier.testTag(fact.reveal_selector_id),
                    )
                }
                if (fact.copy_selector_id.isNotEmpty()) {
                    IconKey("Copy", KitWords.DETAILS, fact.copy_selector_id, bordered = false) {
                        onTap(fact.copy_selector_id)
                    }
                }
                if (fact.open_selector_id.isNotEmpty()) {
                    KitLink(
                        label = KitWords.OPEN,
                        onClick = { onTap(fact.open_selector_id) },
                        dense = true,
                        modifier = Modifier.testTag(fact.open_selector_id),
                    )
                }
            }
            if (index < facts.facts.lastIndex) {
                RoomHairline(startIndent = 14.dp)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun RoomChoiceBlock(
    choice: RoomChoice,
    onChange: (RoomChange) -> Unit,
    modifier: Modifier = Modifier,
) {
    var seq by remember(choice.selector_id) { mutableLongStateOf(0L) }
    val pick: (String) -> Unit = { optionId ->
        seq += 1L
        onChange(RoomChange(selector_id = choice.selector_id, seq = seq, option = optionId))
    }
    Column(
        modifier
            .fillMaxWidth()
            .testTag(choice.selector_id.ifEmpty { "block-choice" }),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (choice.label.isNotEmpty() && choice.style != RoomChoiceStyle.ROOM_CHOICE_STYLE_MENU) {
            KitText(choice.label, KitType.Meta, Surface.meta)
        }
        when (choice.style) {
            RoomChoiceStyle.ROOM_CHOICE_STYLE_SEGMENTED -> {
                val selected = choice.options.firstOrNull { it.selected }?.id.orEmpty()
                KitSegmented(
                    options = choice.options.map { it.id to it.label },
                    selected = selected,
                    onSelect = pick,
                )
            }
            RoomChoiceStyle.ROOM_CHOICE_STYLE_CHIPS -> {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    choice.options.forEach { option ->
                        KitChip(
                            label = option.label,
                            selected = option.selected,
                            onClick = { pick(option.id) },
                            modifier = Modifier.testTag("${choice.selector_id}-${option.id}"),
                        )
                    }
                }
            }
            RoomChoiceStyle.ROOM_CHOICE_STYLE_MENU -> {
                var expanded by remember { mutableStateOf(false) }
                val current = choice.options.filter { it.selected }.joinToString(", ") { it.label }
                Box {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .kitCard()
                            .heightIn(min = KitGeometry.ROW_MIN)
                            .clickable { expanded = true }
                            .padding(horizontal = 14.dp, vertical = 10.dp)
                            .semantics { role = Role.Button },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        KitText(choice.label, KitType.Row, Surface.ink, Modifier.weight(1f))
                        KitText(current, KitType.Meta, Surface.meta, Modifier.padding(end = 6.dp))
                        CentraidIcon("ChevronDown", tint = Surface.meta, size = 14.dp)
                    }
                    DropdownMenu(
                        expanded = expanded,
                        onDismissRequest = { expanded = false },
                        modifier = Modifier.menuTestIds(),
                        containerColor = Surface.card,
                    ) {
                        choice.options.forEach { option ->
                            DropdownMenuItem(
                                text = { Text(option.label, color = Surface.ink) },
                                leadingIcon = {
                                    if (option.selected) {
                                        CentraidIcon("Check", tint = appAccent().text, size = 16.dp)
                                    } else {
                                        Spacer(Modifier.size(16.dp))
                                    }
                                },
                                onClick = {
                                    if (!choice.multiple) expanded = false
                                    pick(option.id)
                                },
                                modifier = Modifier
                                    .testTag("${choice.selector_id}-${option.id}")
                                    .semantics { selected = option.selected },
                            )
                        }
                    }
                }
            }
            else -> {
                Column(Modifier.fillMaxWidth().kitCard()) {
                    choice.options.forEachIndexed { index, option ->
                        SheetRow(
                            label = option.label,
                            selected = option.selected,
                            divider = index < choice.options.lastIndex,
                            testTag = "${choice.selector_id}-${option.id}",
                            onTap = { pick(option.id) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
internal fun RoomFigureBlock(
    figure: RoomFigure,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val clickable = figure.selector_id.isNotEmpty()
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .kitCard()
            .then(
                if (clickable) {
                    Modifier.clickable { onTap(figure.selector_id) }.semantics { role = Role.Button }
                } else {
                    Modifier
                },
            )
            .padding(16.dp)
            .testTag(figure.selector_id.ifEmpty { "block-figure" }),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (figure.label.isNotEmpty()) {
            KitText(figure.label, KitType.Meta, Surface.meta)
        }
        KitText(figure.value_, KitType.Title, roomToneColor(figure.tone))
        if (figure.caption.isNotEmpty()) {
            KitText(figure.caption, KitType.Meta, Surface.meta)
        }
    }
}

@Composable
internal fun RoomProseBlock(
    prose: RoomProse,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val linkColor = appAccent().text
    val annotated = remember(prose.text, prose.spans, linkColor) {
        buildAnnotatedString {
            append(prose.text)
            prose.spans.forEach { span ->
                val start = span.start.coerceIn(0, prose.text.length)
                val end = span.end.coerceIn(start, prose.text.length)
                if (end > start && span.selector_id.isNotEmpty()) {
                    addLink(
                        LinkAnnotation.Clickable(
                            tag = span.selector_id,
                            styles = TextLinkStyles(
                                style = SpanStyle(
                                    color = linkColor,
                                    fontWeight = FontWeight.SemiBold,
                                    textDecoration = TextDecoration.Underline,
                                ),
                            ),
                            linkInteractionListener = { onTap(span.selector_id) },
                        ),
                        start,
                        end,
                    )
                }
            }
        }
    }
    Text(
        text = annotated,
        style = kitTextStyle(KitType.Row),
        color = Surface.body,
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)
            .testTag("block-prose"),
    )
}

@Composable
internal fun RoomMediaBlock(
    media: RoomMedia,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val ratio = (media.aspect_milli.takeIf { it > 0 } ?: 1500) / 1000f
    val icon = when (media.kind) {
        RoomMediaKind.ROOM_MEDIA_KIND_VIDEO -> "Play"
        RoomMediaKind.ROOM_MEDIA_KIND_SCAN, RoomMediaKind.ROOM_MEDIA_KIND_FILE -> "FileText"
        else -> "Image"
    }
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag(media.selector_id.ifEmpty { "block-media" }),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(ratio.coerceIn(0.5f, 3f))
                .clip(RoundedCornerShape(CentraidScale.cardRadius.dp))
                .background(Surface.fill)
                .then(
                    if (media.selector_id.isNotEmpty()) {
                        Modifier.clickable { onTap(media.selector_id) }.semantics { role = Role.Button }
                    } else {
                        Modifier
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            CentraidIcon(iconKey = icon, tint = Surface.meta, size = 32.dp)
            if (media.duration_label.isNotEmpty()) {
                Box(
                    Modifier
                        .align(Alignment.BottomEnd)
                        .padding(10.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(centraidColor("stage").copy(alpha = 0.72f))
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                ) {
                    KitText(media.duration_label, KitType.Badge, Color.White)
                }
            }
        }
        if (media.caption.isNotEmpty()) {
            KitText(media.caption, KitType.Meta, Surface.meta)
        }
    }
}

@Composable
internal fun RoomProgressBlock(
    progress: RoomProgress,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val fraction = if (progress.total > 0L) progress.done.toFloat() / progress.total.toFloat() else 0f
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .kitCard()
            .padding(14.dp)
            .testTag("block-progress"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                if (progress.label.isNotEmpty()) KitText(progress.label, KitType.Row, Surface.ink)
                if (progress.count_label.isNotEmpty()) KitText(progress.count_label, KitType.Meta, Surface.meta)
            }
            progress.cancel?.let { cancel ->
                KitLink(
                    label = cancel.label.ifEmpty { KitWords.CANCEL },
                    onClick = { onTap(cancel.selector_id) },
                    dense = true,
                    enabled = cancel.enabled,
                    modifier = Modifier.testTag(cancel.selector_id.ifEmpty { "progress-cancel" }),
                )
            }
        }
        KitProgressBar(fraction = fraction, height = 6.dp)
    }
}

@Composable
internal fun RoomEmptyBlock(
    empty: RoomEmpty,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 32.dp, vertical = 36.dp)
            .testTag("block-empty"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        empty.glyph?.let { RoomGlyphWash(it) }
        if (empty.title.isNotEmpty()) {
            Text(
                empty.title,
                style = kitTextStyle(KitType.Section),
                color = Surface.ink,
                textAlign = TextAlign.Center,
            )
        }
        if (empty.body.isNotEmpty()) {
            Text(
                empty.body,
                style = kitTextStyle(KitType.Row),
                color = Surface.meta,
                textAlign = TextAlign.Center,
            )
        }
        empty.action?.let { action ->
            KitPillButton(
                label = action.label,
                enabled = action.enabled,
                testTag = action.selector_id.ifEmpty { "empty-action" },
                modifier = Modifier.padding(top = 6.dp),
                onPress = { onTap(action.selector_id) },
            )
        }
    }
}

@Composable
private fun RoomGlyphWash(glyph: RoomGlyph) {
    val accent = appAccent()
    Box(
        Modifier
            .size(56.dp)
            .clip(CircleShape)
            .background(accent.wash(centraidDark()))
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(iconKey = glyph.icon.ifEmpty { "CheckCircle" }, tint = accent.text, size = 26.dp)
    }
}

@Composable
internal fun RoomWallBlock(
    wall: RoomWall,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 28.dp, vertical = 36.dp)
            .testTag("block-wall"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        KitTile(iconKey = "Lock", size = 56.dp)
        if (wall.title.isNotEmpty()) {
            Text(
                wall.title,
                style = kitTextStyle(KitType.Hero),
                color = Surface.ink,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() },
            )
        }
        if (wall.body.isNotEmpty()) {
            Text(
                wall.body,
                style = kitTextStyle(KitType.Row),
                color = Surface.meta,
                textAlign = TextAlign.Center,
            )
        }
        if (wall.failure.isNotEmpty()) {
            Text(
                wall.failure,
                style = kitTextStyle(KitType.Meta),
                color = StateColor.Red.text,
                textAlign = TextAlign.Center,
                modifier = Modifier.testTag("wall-failure"),
            )
        }
        wall.unlock?.let { unlock ->
            InkButton(
                label = unlock.label,
                enabled = unlock.enabled,
                iconKey = unlock.icon,
                testTag = unlock.selector_id.ifEmpty { "wall-unlock" },
                modifier = Modifier.padding(top = 8.dp),
                onPress = { onTap(unlock.selector_id) },
            )
        }
    }
}

@Composable
internal fun RoomTilesBlock(
    tiles: RoomTiles,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val rows = tiles.tiles.chunked(2)
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag("block-tiles"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        rows.forEach { pair ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                pair.forEach { tile ->
                    Column(
                        Modifier
                            .weight(1f)
                            .kitCard()
                            .heightIn(min = 96.dp)
                            .clickable(enabled = tile.selector_id.isNotEmpty()) { onTap(tile.selector_id) }
                            .padding(14.dp)
                            .testTag(tile.selector_id.ifEmpty { "tile-${tile.label}" })
                            .semantics(mergeDescendants = true) { role = Role.Button },
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        tile.glyph?.let { glyph ->
                            CentraidIcon(
                                iconKey = glyph.icon.ifEmpty { "CheckCircle" },
                                tint = appAccent().text,
                                size = 22.dp,
                            )
                        }
                        KitText(tile.label, KitType.Row, Surface.ink, maxLines = 1)
                        if (tile.subtitle.isNotEmpty()) {
                            KitText(tile.subtitle, KitType.Meta, Surface.meta, maxLines = 2)
                        }
                    }
                }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
internal fun RoomGlanceBlock(
    glance: RoomGlance,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .kitCard()
            .then(
                if (glance.selector_id.isNotEmpty()) {
                    Modifier.clickable { onTap(glance.selector_id) }.semantics { role = Role.Button }
                } else {
                    Modifier
                },
            )
            .padding(14.dp)
            .testTag(glance.selector_id.ifEmpty { "block-glance" }),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            glance.glyph?.let { glyph ->
                CentraidIcon(iconKey = glyph.icon.ifEmpty { "Calendar" }, tint = appAccent().text, size = 18.dp)
            }
            KitText(glance.title, KitType.Group, appAccent().text, Modifier.weight(1f))
        }
        glance.lines.forEach { line ->
            KitText(line, KitType.Row, Surface.ink, maxLines = 2)
        }
    }
}

@Composable
internal fun RoomTrashBlock(
    trash: RoomTrash,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag("block-trash"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (trash.heading.isNotEmpty()) {
            KitText(trash.heading, KitType.Section, Surface.ink, Modifier.semantics { heading() })
        }
        if (trash.retention.isNotEmpty()) {
            KitText(trash.retention, KitType.Meta, Surface.meta)
        }
        if (trash.rows.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().kitCard()) {
                trash.rows.forEachIndexed { index, row ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = KitGeometry.ROW_MIN)
                            .padding(horizontal = 14.dp, vertical = 8.dp)
                            .testTag(row.selector_id.ifEmpty { "trash-row-$index" }),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        row.mark?.let { RoomMarkView(it, onTap, size = 32.dp) }
                        Column(Modifier.weight(1f)) {
                            KitText(row.title, KitType.Row, Surface.ink, maxLines = 2)
                            if (row.meta.isNotEmpty()) KitText(row.meta, KitType.Meta, Surface.meta, maxLines = 2)
                        }
                        if (row.restore_selector_id.isNotEmpty()) {
                            KitLink(
                                label = KitWords.OPEN,
                                onClick = { onTap(row.restore_selector_id) },
                                dense = true,
                                modifier = Modifier.testTag(row.restore_selector_id),
                            )
                        }
                        if (row.purge_selector_id.isNotEmpty()) {
                            IconKey("Trash", KitWords.DELETE, row.purge_selector_id, bordered = false) {
                                onTap(row.purge_selector_id)
                            }
                        }
                    }
                    if (index < trash.rows.lastIndex) RoomHairline(startIndent = 14.dp)
                }
            }
        }
        trash.empty_trash?.let { emptyAction ->
            InkButton(
                label = emptyAction.label,
                destructive = true,
                enabled = emptyAction.enabled,
                testTag = emptyAction.selector_id.ifEmpty { "trash-empty" },
                onPress = { onTap(emptyAction.selector_id) },
            )
        }
        if (trash.next_page_selector_id.isNotEmpty()) {
            KitLink(
                label = KitWords.SHOW_MORE,
                onClick = { onTap(trash.next_page_selector_id) },
                modifier = Modifier.testTag(trash.next_page_selector_id),
            )
        }
    }
}

@Composable
internal fun RoomConfirmBlock(
    confirm: RoomConfirm,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .testTag("block-confirm"),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (confirm.title.isNotEmpty()) {
            KitText(confirm.title, KitType.Section, Surface.ink, Modifier.semantics { heading() })
        }
        if (confirm.warning.isNotEmpty()) {
            KitText(confirm.warning, KitType.Row, StateColor.Amber.text, Modifier.testTag("confirm-warning"))
        }
        if (confirm.body.isNotEmpty()) {
            KitText(confirm.body, KitType.Row, Surface.body)
        }
        ChoiceStack(Modifier.padding(top = 6.dp)) {
            InkButton(
                label = confirm.confirm_label,
                destructive = confirm.class_ == RoomConfirmClass.ROOM_CONFIRM_CLASS_OUTLINED,
                testTag = confirm.confirm_selector_id.ifEmpty { "confirm-primary" },
                onPress = { onTap(confirm.confirm_selector_id) },
            )
            if (confirm.cancel_label.isNotEmpty()) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = KitGeometry.ROW_MIN)
                        .clickable { onTap(confirm.cancel_selector_id) }
                        .testTag(confirm.cancel_selector_id.ifEmpty { "confirm-cancel" })
                        .semantics { role = Role.Button },
                    contentAlignment = Alignment.Center,
                ) {
                    KitText(confirm.cancel_label, KitType.Row, Surface.ink)
                }
            }
        }
    }
}

@Composable
internal fun RoomMenuBlock(
    menu: RoomMenu,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .testTag(menu.selector_id.ifEmpty { "block-menu" }),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        menu.sections.forEach { section ->
            if (section.heading.isNotEmpty()) {
                KitText(
                    section.heading,
                    KitType.Group,
                    Surface.meta,
                    Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp).semantics { heading() },
                )
            }
            section.items.forEachIndexed { index, item ->
                SheetRow(
                    label = item.label,
                    iconKey = item.icon.takeIf { it.isNotEmpty() },
                    detail = item.secondary,
                    destructive = item.destructive,
                    selected = item.checked,
                    enabled = item.enabled,
                    divider = index < section.items.lastIndex,
                    testTag = item.selector_id.ifEmpty { "menu-item-$index" },
                    onTap = { onTap(item.selector_id) },
                )
            }
        }
    }
}

@Composable
internal fun RoomDropdownMenu(
    menu: RoomMenu,
    expanded: Boolean,
    onDismiss: () -> Unit,
    onTap: (String) -> Unit,
) {
    var activeSubmenu by remember(expanded) { mutableStateOf<RoomMenuItem?>(null) }
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = {
            activeSubmenu = null
            onDismiss()
        },
        modifier = Modifier.menuTestIds().testTag(menu.selector_id.ifEmpty { "room-dropdown" }),
        containerColor = Surface.card,
    ) {
        val sub = activeSubmenu
        if (sub != null) {
            DropdownMenuItem(
                text = { Text(sub.label, style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold), color = Surface.ink) },
                leadingIcon = { CentraidIcon("ChevronLeft", tint = Surface.meta, size = 16.dp) },
                onClick = { activeSubmenu = null },
            )
            RoomHairline()
            sub.submenu.forEach { child ->
                RoomDropdownItem(child, onTap = {
                    activeSubmenu = null
                    onTap(child.selector_id)
                }, onOpenSubmenu = {})
            }
        } else {
            menu.sections.forEachIndexed { sIndex, section ->
                if (sIndex > 0) RoomHairline()
                if (section.heading.isNotEmpty()) {
                    KitText(
                        section.heading,
                        KitType.Group,
                        Surface.meta,
                        Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                }
                section.items.forEach { item ->
                    RoomDropdownItem(
                        item = item,
                        onTap = { onTap(item.selector_id) },
                        onOpenSubmenu = { activeSubmenu = item },
                    )
                }
            }
        }
    }
}

@Composable
private fun RoomDropdownItem(
    item: RoomMenuItem,
    onTap: () -> Unit,
    onOpenSubmenu: () -> Unit,
) {
    val hasSub = item.submenu.isNotEmpty()
    DropdownMenuItem(
        text = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    item.label,
                    color = when {
                        !item.enabled -> Surface.meta
                        item.destructive -> StateColor.Red.text
                        else -> Surface.ink
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (item.secondary.isNotEmpty()) {
                    KitText(item.secondary, KitType.Meta, Surface.meta, maxLines = 1)
                }
            }
        },
        leadingIcon = when {
            item.checked -> ({ CentraidIcon("Check", tint = appAccent().text, size = 16.dp) })
            item.icon.isNotEmpty() -> ({ CentraidIcon(item.icon, tint = if (item.destructive) StateColor.Red.text else Surface.ink, size = 16.dp) })
            else -> null
        },
        trailingIcon = if (hasSub) ({ CentraidIcon("ChevronRight", tint = Surface.meta, size = 16.dp) }) else null,
        enabled = item.enabled,
        onClick = { if (hasSub) onOpenSubmenu() else onTap() },
        modifier = Modifier
            .testTag(item.selector_id.ifEmpty { "dropdown-${item.label}" })
            .semantics { selected = item.checked },
    )
}

@Composable
private fun RoomCanvasPlaceholder(
    kind: String,
    summary: String,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(KitGeometry.GUTTER)
            .kitCard()
            .padding(20.dp)
            .testTag("canvas-placeholder-$kind"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        KitText(kind, KitType.Group, Surface.meta)
        if (summary.isNotEmpty()) KitText(summary, KitType.Row, Surface.ink)
    }
}
