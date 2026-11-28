package dev.centraid.android.room

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.RoomAttachments
import centraid.core.v1.RoomEarlierVersions
import centraid.core.v1.RoomLinked
import centraid.core.v1.RoomMentionedIn
import centraid.core.v1.RoomOrigin
import centraid.core.v1.RoomSays
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.kitCard

@Composable
internal fun RoomAttachmentsBlock(
    block: RoomAttachments,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Column(modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER).testTag("block-attachments")) {
        Row(
            Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (block.heading.isNotEmpty()) {
                KitText(
                    block.heading,
                    KitType.Group,
                    Surface.meta,
                    Modifier.weight(1f).semantics { heading() },
                )
            }
            block.add?.let { addMenu ->
                Box {
                    KitLink(
                        label = "+",
                        onClick = { menuOpen = true },
                        dense = true,
                        modifier = Modifier.testTag(addMenu.selector_id.ifEmpty { "attachments-add" }),
                    )
                    RoomDropdownMenu(
                        menu = addMenu,
                        expanded = menuOpen,
                        onDismiss = { menuOpen = false },
                        onTap = { selectorId ->
                            menuOpen = false
                            onTap(selectorId)
                        },
                    )
                }
            }
        }
        if (block.items.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().kitCard()) {
                block.items.forEachIndexed { index, row ->
                    RoomRowBlock(
                        row = row,
                        onTap = onTap,
                        hairline = index < block.items.lastIndex,
                    )
                }
            }
        }
        if (block.next_page_selector_id.isNotEmpty()) {
            KitLink(
                label = KitWords.SHOW_MORE,
                onClick = { onTap(block.next_page_selector_id) },
                modifier = Modifier.testTag(block.next_page_selector_id),
            )
        }
    }
}

@Composable
internal fun RoomLinkedBlock(
    block: RoomLinked,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER).testTag("block-linked")) {
        Row(
            Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (block.heading.isNotEmpty()) {
                KitText(
                    block.heading,
                    KitType.Group,
                    Surface.meta,
                    Modifier.weight(1f).semantics { heading() },
                )
            }
            block.add?.let { action ->
                KitLink(
                    label = action.label.ifEmpty { "+" },
                    onClick = { onTap(action.selector_id) },
                    dense = true,
                    enabled = action.enabled,
                    modifier = Modifier.testTag(action.selector_id.ifEmpty { "linked-add" }),
                )
            }
        }
        if (block.items.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().kitCard()) {
                block.items.forEachIndexed { index, row ->
                    RoomRowBlock(
                        row = row,
                        onTap = onTap,
                        hairline = index < block.items.lastIndex,
                    )
                }
            }
        }
        if (block.next_page_selector_id.isNotEmpty()) {
            KitLink(
                label = KitWords.SHOW_MORE,
                onClick = { onTap(block.next_page_selector_id) },
                modifier = Modifier.testTag(block.next_page_selector_id),
            )
        }
    }
}

@Composable
internal fun RoomMentionedInBlock(
    block: RoomMentionedIn,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER).testTag("block-mentioned-in")) {
        if (block.heading.isNotEmpty()) {
            KitText(
                block.heading,
                KitType.Group,
                Surface.meta,
                Modifier.padding(top = 12.dp, bottom = 4.dp).semantics { heading() },
            )
        }
        if (block.items.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().kitCard()) {
                block.items.forEachIndexed { index, row ->
                    RoomRowBlock(
                        row = row,
                        onTap = onTap,
                        hairline = index < block.items.lastIndex,
                    )
                }
            }
        }
        if (block.next_page_selector_id.isNotEmpty()) {
            KitLink(
                label = KitWords.SHOW_MORE,
                onClick = { onTap(block.next_page_selector_id) },
                modifier = Modifier.testTag(block.next_page_selector_id),
            )
        }
    }
}

@Composable
internal fun RoomSaysBlock(
    block: RoomSays,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER).testTag("block-says")) {
        if (block.heading.isNotEmpty()) {
            KitText(
                block.heading,
                KitType.Group,
                Surface.meta,
                Modifier.padding(top = 12.dp, bottom = 4.dp).semantics { heading() },
            )
        }
        Column(Modifier.fillMaxWidth().kitCard()) {
            block.fields.forEachIndexed { index, field ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = KitGeometry.ROW_MIN)
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Column(Modifier.weight(1f)) {
                        if (field.label.isNotEmpty()) {
                            KitText(field.label, KitType.Meta, Surface.meta)
                        }
                        KitText(field.stated, KitType.Row, Surface.ink)
                        if (field.mine.isNotEmpty()) {
                            KitText(field.mine, KitType.Meta, Surface.meta)
                        }
                    }
                    if (field.take_selector_id.isNotEmpty() && block.take_label.isNotEmpty()) {
                        KitLink(
                            label = block.take_label,
                            onClick = { onTap(field.take_selector_id) },
                            dense = true,
                            modifier = Modifier.testTag(field.take_selector_id),
                        )
                    }
                }
                if (index < block.fields.lastIndex) {
                    RoomHairline(startIndent = 14.dp)
                }
            }
        }
    }
}

@Composable
internal fun RoomEarlierVersionsBlock(
    block: RoomEarlierVersions,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val clickable = block.selector_id.isNotEmpty()
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)
            .kitCard()
            .heightIn(min = KitGeometry.ROW_MIN)
            .then(
                if (clickable) {
                    Modifier.clickable { onTap(block.selector_id) }
                        .semantics { role = Role.Button }
                } else {
                    Modifier
                },
            )
            .padding(horizontal = 14.dp, vertical = 10.dp)
            .testTag(block.selector_id.ifEmpty { "block-earlier-versions" }),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        KitText(block.summary, KitType.Row, Surface.ink, Modifier.weight(1f))
        if (block.count > 0) {
            KitText(block.count.toString(), KitType.Meta, Surface.meta)
        }
        if (clickable) {
            CentraidIcon("ChevronRight", tint = Surface.meta, size = 16.dp)
        }
    }
}

@Composable
internal fun RoomOriginBlock(
    block: RoomOrigin,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val clickable = block.selector_id.isNotEmpty()
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .then(
                if (clickable) {
                    Modifier.clickable { onTap(block.selector_id) }
                        .semantics { role = Role.Button }
                } else {
                    Modifier
                },
            )
            .padding(horizontal = KitGeometry.GUTTER, vertical = 10.dp)
            .testTag(block.selector_id.ifEmpty { "block-origin" }),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitText(block.line, KitType.Meta, Surface.meta, Modifier.weight(1f))
        if (clickable) {
            CentraidIcon("ChevronRight", tint = Surface.meta, size = 14.dp)
        }
    }
}
