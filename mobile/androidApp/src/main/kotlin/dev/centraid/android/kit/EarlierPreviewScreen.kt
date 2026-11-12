package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import centraid.core.v1.EarlierPreviewData
import centraid.core.v1.EarlierPreviewEvent
import centraid.core.v1.EarlierPreviewView
import dev.centraid.design.CentraidScale

/**
 * THE FULL PREVIEW OF ONE EARLIER VERSION, DRAWN ONCE, FROM THE SCREEN RUNTIME (#1185):
 * `<app>.earlier` opened on a version, drawn from `ViewState.earlier_preview`. A banner says which
 * version it is and what changed it; the record is its heading and one line per thing it held,
 * read only; two keys close the page or restore it. Every word is the view's; the pop (a Close, a
 * Restore, `done`) is the shell's ([onBack] and the host's `done`).
 *
 * Ids: `earlier-preview-banner`, `earlier-preview-restore`, `earlier-preview-close`,
 * `earlier-preview-status-action` (the iOS twin is `CoreEarlierPreviewView.swift`).
 */
@Composable
public fun EarlierPreviewScreen(
    view: EarlierPreviewView,
    onEvent: (EarlierPreviewEvent) -> Unit,
    onBack: () -> Unit,
) {
    PushedPage(
        title = view.title,
        parentTitle = view.back_label,
        onBack = onBack,
        statusLine = { StatusLine(view.status, actTag = "earlier-preview-status-action") { } },
    ) {
        ReadStateView(
            page = view.page!!,
            onRetry = { onEvent(EarlierPreviewEvent(refreshed = EarlierPreviewEvent.Refreshed())) },
        ) {
            val preview = view.data_ ?: return@ReadStateView
            Column(Modifier.fillMaxWidth()) {
                LazyColumn(Modifier.weight(1f).padding(horizontal = KitGeometry.GUTTER)) {
                    item(key = "banner") { PreviewBanner(preview) }
                    item(key = "record") { PreviewRecord(preview) }
                }
                PreviewKeys(preview, onEvent)
            }
        }
    }
}

@Composable
private fun PreviewBanner(preview: EarlierPreviewData) {
    Column(
        Modifier
            .padding(top = 4.dp, bottom = 12.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(CentraidScale.cardRadius.dp))
            .background(Surface.fill)
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .testTag("earlier-preview-banner")
            .semantics(mergeDescendants = true) {
                if (preview.accessibility_label.isNotEmpty()) contentDescription = preview.accessibility_label
            },
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(
            preview.banner_headline,
            style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
            color = Surface.ink,
        )
        if (preview.banner_changed.isNotEmpty()) KitText(preview.banner_changed, KitType.Meta, Surface.ink)
        KitText(preview.banner_note, KitType.Meta, Surface.meta)
    }
}

/** The record as it was: its first line as the heading, then one line per thing it held. */
@Composable
private fun PreviewRecord(preview: EarlierPreviewData) {
    Column(Modifier.fillMaxWidth().kitCard()) {
        Text(
            preview.heading,
            style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
            color = Surface.ink,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 14.dp),
        )
        preview.details.forEach { line ->
            Spacer(Modifier.fillMaxWidth().height(KitGeometry.HAIRLINE).background(Surface.line))
            Text(
                line,
                style = kitTextStyle(KitType.Row),
                color = Surface.ink,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            )
        }
    }
}

@Composable
private fun PreviewKeys(preview: EarlierPreviewData, onEvent: (EarlierPreviewEvent) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val pill = RoundedCornerShape(percent = 50)
        Box(
            Modifier
                .weight(1f)
                .heightIn(min = KitGeometry.ROW_MIN)
                .clip(pill)
                .border(1.dp, Surface.border, pill)
                .clickable { onEvent(EarlierPreviewEvent(close = EarlierPreviewEvent.Closed())) }
                .testTag("earlier-preview-close")
                .semantics { role = Role.Button },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                preview.close_label,
                style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                color = Surface.ink,
                maxLines = 1,
            )
        }
        KitPillButton(
            label = preview.restore_label,
            onPress = { onEvent(EarlierPreviewEvent(restore = EarlierPreviewEvent.Restored())) },
            modifier = Modifier.weight(1.4f),
            testTag = "earlier-preview-restore",
        )
    }
}
