package dev.centraid.android.screens.docs

import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.DocsAction
import centraid.core.v1.DocsLabelChip
import centraid.core.v1.DocsLabelColor
import centraid.core.v1.DocsRowView
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.android.screens.decodeUpright
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
internal fun DocsThumbnail(row: DocsRowView, modifier: Modifier = Modifier) {
    val bitmap by produceState<ImageBitmap?>(null, row.preview_path, row.media_type) {
        value = null
        value = withContext(Dispatchers.IO) { documentThumbnail(row.preview_path, row.media_type) }
    }
    val excerpt by produceState("", row.preview_path, row.media_type) {
        value = ""
        if (row.preview_path.isNotEmpty() && row.media_type.startsWith("text/")) {
            value = withContext(Dispatchers.IO) {
                try { File(row.preview_path).inputStream().use { ByteArray(4096).let { bytes -> val count = it.read(bytes); if (count > 0) String(bytes, 0, count, Charsets.UTF_8) else "" } } } catch (_: java.io.IOException) { "" }
            }
        }
    }
    Box(modifier.clip(RoundedCornerShape(KitGeometry.RADIUS)).background(centraidColor("bgElev")), contentAlignment = Alignment.Center) {
        // decorative: the enclosing row already speaks the document title and kind.
        if (bitmap != null) Image(bitmap = bitmap!!, contentDescription = null, modifier = Modifier.fillMaxSize().padding(4.dp), contentScale = ContentScale.Fit) // decorative: the row speaks the title and kind.
        else if (excerpt.isNotEmpty()) Text(excerpt, style = centraidType("annotLabel"), color = centraidColor("text"), modifier = Modifier.fillMaxSize().padding(8.dp))
        else CentraidIcon(row.kind_icon_key, tint = centraidColor("docsText"), size = 30.dp)
        Text(row.kind_label, style = centraidType("annotLabel"), color = centraidColor("docsText"),
            modifier = Modifier.align(Alignment.BottomEnd).padding(4.dp).background(centraidColor("docsTint"), RoundedCornerShape(KitGeometry.RADIUS)).padding(horizontal = 6.dp, vertical = 3.dp))
    }
}

private fun documentThumbnail(path: String, media: String): ImageBitmap? {
    if (path.isEmpty()) return null
    return try {
        if (media == "application/pdf") {
            ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY).use { file ->
                PdfRenderer(file).use { pdf ->
                    if (pdf.pageCount == 0) return null
                    pdf.openPage(0).use { page ->
                        val scale = 320f / maxOf(page.width, page.height).coerceAtLeast(1)
                        val bitmap = Bitmap.createBitmap((page.width * scale).toInt().coerceAtLeast(1), (page.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
                        bitmap.eraseColor(android.graphics.Color.WHITE)
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        bitmap.asImageBitmap()
                    }
                }
            }
        } else if (media.startsWith("image/")) decodeUpright(path, maxDimension = 320)?.asImageBitmap() else null
    } catch (_: Exception) { null }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun DocsLabelChips(labels: List<DocsLabelChip>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(horizontal = 8.dp)) {
        labels.forEach { label ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Box(Modifier.size(8.dp).background(centraidColor(label.color_key), CircleShape))
                Text(label.label, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
            }
        }
    }
}

@Composable
internal fun DocsLabelColorMenu(chip: DocsLabelChip, colors: List<DocsLabelColor>, label: String, onPick: (String) -> Unit) {
    var opened by remember(chip.tag_id) { mutableStateOf(false) }
    Box {
        Row(Modifier.fillMaxWidth().clickable { opened = true }.padding(12.dp).heightIn(min = 44.dp)
            .semantics { contentDescription = "$label, ${chip.label}" }.testTag("docs-label-color-${chip.tag_id}"),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(12.dp).background(centraidColor(chip.color_key), CircleShape))
            Text(label, style = centraidType("body"), color = centraidColor("text"))
        }
        DropdownMenu(expanded = opened, onDismissRequest = { opened = false }) {
            colors.forEach { color -> DropdownMenuItem(text = { Text(color.label) }, leadingIcon = { Box(Modifier.size(12.dp).background(centraidColor(color.key), CircleShape)) }, onClick = { opened = false; onPick(color.key) }) }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun DocsDocumentActions(actions: List<DocsAction>, onAction: (DocsAction) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(16.dp)) {
        actions.filter { it.key in listOf("share", "star", "unstar", "labels", "move", "trash") }.forEach { action ->
            OutlineButton(label = action.label, testTag = "docs-document-${action.key}") { if (action.enabled) onAction(action) }
        }
    }
}
