package dev.centraid.android.screens.docs

import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import centraid.core.v1.DocsAction
import centraid.core.v1.DocsFolderNode
import centraid.core.v1.DocsLabelChip
import centraid.core.v1.DocsRowView
import dev.centraid.android.R
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.screens.decodeUpright
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

// DOCS' PICTURES AND PALETTE (#1173). A document's thumbnail is the file the core hands out
// (`thumbnail_path`): an image, or a PDF's first page, decoded off the main thread at the size it
// is drawn. A label's colour is a key of the one list palette (`color_key`, always set by Rust);
// this only looks the colour resource up. The SwiftUI twin is `DocsThumbnails.swift`.

/** The list-palette colour a `color_key` names (`values/colors.xml`, generated from `[list]`). */
@Composable
internal fun docsListColor(key: String): Color = colorResource(
    when (key) {
        "blue" -> R.color.centraid_list_blue
        "mustard" -> R.color.centraid_list_mustard
        "violet" -> R.color.centraid_list_violet
        "petrol" -> R.color.centraid_list_petrol
        "indigo" -> R.color.centraid_list_indigo
        "raspberry" -> R.color.centraid_list_raspberry
        "orchid" -> R.color.centraid_list_orchid
        else -> R.color.centraid_list_graphite
    },
)

/** A label's colour dot. */
@Composable
internal fun DocsDot(colorKey: String, size: androidx.compose.ui.unit.Dp = 8.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(docsListColor(colorKey)))
}

private const val THUMB_PIXELS = 360

private fun pdfThumbnail(path: String): ImageBitmap? = runCatching {
    ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
        PdfRenderer(descriptor).use { renderer ->
            if (renderer.pageCount == 0) return@use null
            renderer.openPage(0).use { page ->
                val height = (THUMB_PIXELS.toLong() * page.height / page.width.coerceAtLeast(1)).toInt().coerceIn(1, THUMB_PIXELS * 2)
                val bitmap = Bitmap.createBitmap(THUMB_PIXELS, height, Bitmap.Config.ARGB_8888)
                bitmap.eraseColor(android.graphics.Color.WHITE)
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                bitmap.asImageBitmap()
            }
        }
    }
}.getOrNull()

/** One tile of the grid: a 96 x 120 page with its picture (or its kind's icon) and badge, then title and meta. */
@Composable
internal fun DocsDocTile(
    row: DocsRowView,
    onTap: () -> Unit,
    onMenu: () -> Unit,
    menuLabel: String,
    modifier: Modifier = Modifier,
) {
    val picture by produceState<ImageBitmap?>(initialValue = null, row.thumbnail_path) {
        value = if (row.thumbnail_path.isEmpty()) {
            null
        } else {
            withContext(Dispatchers.IO) {
                if (row.badge == "PDF") pdfThumbnail(row.thumbnail_path) else decodeUpright(row.thumbnail_path, THUMB_PIXELS)?.asImageBitmap()
            }
        }
    }
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Column(
        modifier
            .clickable(onClick = onTap)
            .padding(vertical = 8.dp, horizontal = 6.dp)
            .clearAndSetSemantics {
                contentDescription = row.accessibility_label.ifEmpty { row.title }
                role = Role.Button
                // The row menu is the long press; the tile says so for assistive tech.
                this.onLongClickLabelFor(menuLabel, onMenu)
            }
            .testTag("docs-row-${row.document_id}"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier
                .width(96.dp)
                .height(120.dp)
                .clip(shape)
                .background(androidx.compose.ui.res.colorResource(R.color.centraid_surface_card))
                .border(1.dp, androidx.compose.ui.res.colorResource(R.color.centraid_surface_border), shape),
        ) {
            val bitmap = picture
            if (bitmap != null) {
                Image(bitmap, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize()) // decorative: the tile names the document
            } else {
                Box(Modifier.matchParentSize(), contentAlignment = Alignment.Center) {
                    CentraidIcon(row.kind_icon_key.ifEmpty { "FileText" }, tint = centraidColor("textSoft"), size = 30.dp)
                }
            }
            Text(
                row.badge,
                style = centraidType("annotLabel"),
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White,
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(6.dp)
                    .clip(RoundedCornerShape(KitGeometry.RADIUS / 3))
                    .background(androidx.compose.ui.res.colorResource(R.color.centraid_text_ink))
                    .padding(horizontal = 4.dp, vertical = 1.dp),
            )
        }
        Text(row.title, style = centraidType("smallStrong"), color = centraidColor("text"), maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (row.dot_color_key.isNotEmpty()) DocsDot(row.dot_color_key, 6.dp)
            Text(row.meta, style = centraidType("annotLabel"), color = centraidColor("textSoft"), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

private fun androidx.compose.ui.semantics.SemanticsPropertyReceiver.onLongClickLabelFor(label: String, action: () -> Unit) {
    if (label.isNotEmpty()) {
        onLongClick(label) {
            action()
            true
        }
    }
}

/** A folder's tile in Browse: the folder in the app's colour, its name and count. */
@Composable
internal fun DocsFolderTile(folder: DocsFolderNode, modifier: Modifier = Modifier, onTap: () -> Unit) {
    Column(
        modifier
            .clickable(onClick = onTap)
            .padding(vertical = 8.dp, horizontal = 6.dp)
            .clearAndSetSemantics {
                contentDescription = folder.accessibility_label.ifEmpty { folder.name }
                role = Role.Button
            }
            .testTag("docs-folder-${folder.folder_id}"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.width(96.dp).height(120.dp), contentAlignment = Alignment.Center) {
            CentraidIcon("Folder", tint = androidx.compose.ui.res.colorResource(R.color.centraid_app_docs), size = 56.dp)
        }
        Text(folder.name, style = centraidType("smallStrong"), color = centraidColor("text"), maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        Text(folder.count_label, style = centraidType("annotLabel"), color = centraidColor("textSoft"), maxLines = 1)
    }
}

/** THE LABEL CHIPS over a shelf: a dot and a word each, the one filtering tinted in the app's colour. */
@Composable
internal fun DocsLabelChips(chips: List<DocsLabelChip>, onPick: (String) -> Unit) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (chip in chips) {
            val accent = androidx.compose.ui.res.colorResource(R.color.centraid_app_docs)
            Row(
                Modifier
                    .heightIn(min = 32.dp)
                    .clip(CircleShape)
                    .background(if (chip.selected) accent.copy(alpha = 0.16f) else androidx.compose.ui.res.colorResource(R.color.centraid_surface_line))
                    .clickable { onPick(chip.label) }
                    .padding(horizontal = 10.dp)
                    .semantics { selected = chip.selected; role = Role.Button }
                    .testTag("docs-label-chip-${chip.label}"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                DocsDot(chip.color_key)
                Text(
                    chip.label,
                    style = centraidType("annotLabel"),
                    color = if (chip.selected) androidx.compose.ui.res.colorResource(R.color.centraid_app_docs_text) else centraidColor("text"),
                    maxLines = 1,
                )
            }
        }
    }
}

/** THE QUICK LOOK BAR: Share, Star, Labels, Move, Trash (Restore and Delete forever in the trash), each a key. */
@Composable
internal fun DocsQuickLookBar(actions: List<DocsAction>, onPick: (DocsAction) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .clip(CircleShape)
            .background(androidx.compose.ui.res.colorResource(R.color.centraid_surface_card))
            .border(1.dp, androidx.compose.ui.res.colorResource(R.color.centraid_surface_border), CircleShape)
            .height(56.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (action in actions) {
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 48.dp)
                    .clickable(enabled = action.enabled, role = Role.Button) { onPick(action) }
                    .semantics { contentDescription = action.label }
                    .testTag("docs-bar-${action.key}"),
                contentAlignment = Alignment.Center,
            ) {
                CentraidIcon(
                    action.icon_key,
                    tint = when {
                        action.destructive -> centraidColor("net")
                        action.key == "unstar" || action.key == "share" -> androidx.compose.ui.res.colorResource(R.color.centraid_app_docs_text)
                        else -> centraidColor("text")
                    },
                    size = 22.dp,
                )
            }
        }
    }
}
