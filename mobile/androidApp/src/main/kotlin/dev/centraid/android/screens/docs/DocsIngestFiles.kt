package dev.centraid.android.screens.docs

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.graphics.pdf.PdfDocument
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import androidx.core.content.FileProvider
import dev.centraid.android.screens.decodeUpright
import java.io.File
import java.util.UUID

/**
 * THE FILES A DOCS INGEST HANDS THE BRIDGE (#1047, R-1047-Q4).
 *
 * `DocsIngestBridge.picked` takes a PATH on this device, never bytes, so a
 * large file streams through the stage frames without ever sitting in memory.
 * This is the Android half of that seam: the Storage Access Framework's
 * `content://` stream copied into the app's cache, and a camera capture
 * written out as a one-page PDF. Every file made here is OWNED by the bridge,
 * which deletes it once the document is filed or the member dismisses.
 *
 * Blocking I/O throughout: callers run these off the main thread.
 */
internal object DocsIngestFiles {
    /** Under `cacheDir`: the OS may clear it, and nothing here outlives an ingest. */
    private const val INGEST_DIR = "docs-ingest"

    /** The camera's landing folder — `res/xml/docs_scans.xml` names it. */
    private const val SCAN_DIR = "docs-scans"

    /** `<applicationId>.docsscans` — [DocsScanProvider]'s authority in the manifest. */
    private const val AUTHORITY_SUFFIX = ".docsscans"

    /** A scan's longest side, in pixels: a page legible on any screen, not a 48 MP photograph. */
    private const val SCAN_DECODE = 2480

    /** An A4 page's width in PDF points; the height follows the photograph. */
    private const val PAGE_WIDTH_POINTS = 595

    /** What the picker handed back, copied: the path, the name it is filed under, its type. */
    data class Copied(val path: String, val name: String, val mediaType: String)

    /**
     * Copy [uri]'s stream into the cache. Null when the provider would not
     * open it — the member's file is theirs, and a partial copy is deleted.
     */
    fun copy(context: Context, uri: Uri): Copied? {
        val resolver = context.contentResolver
        val name = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        }.getOrNull().orEmpty()
        val type = runCatching { resolver.getType(uri) }.getOrNull().orEmpty()
        val folder = File(context.cacheDir, INGEST_DIR).apply { mkdirs() }
        // THE NAME IS NOT A PATH: a provider's display name is the member's
        // words, and a slash in it must not reach outside the folder.
        val file = File(folder, UUID.randomUUID().toString())
        return try {
            val copied = resolver.openInputStream(uri)?.use { input ->
                file.outputStream().use { output -> input.copyTo(output) }
                true
            } ?: false
            if (copied) Copied(file.absolutePath, name, type) else null.also { discard(file) }
        } catch (why: Exception) {
            discard(file)
            null
        }
    }

    /** A fresh file for the camera to write, and the `content://` URI it writes through. */
    fun scanTarget(context: Context): Pair<File, Uri> {
        val folder = File(context.cacheDir, SCAN_DIR).apply { mkdirs() }
        val file = File(folder, UUID.randomUUID().toString() + ".jpg")
        return file to FileProvider.getUriForFile(context, context.packageName + AUTHORITY_SUFFIX, file)
    }

    /**
     * THE SCAN AS A PDF: the camera's photograph, upright, on one page the
     * photograph's own shape. The photograph is deleted either way; null when
     * it would not decode (the camera wrote nothing, or not an image).
     */
    fun scanToPdf(context: Context, photo: File): File? {
        try {
            val bitmap = decodeUpright(photo.absolutePath, maxDimension = SCAN_DECODE) ?: return null
            val pageHeight = (PAGE_WIDTH_POINTS.toLong() * bitmap.height / bitmap.width.coerceAtLeast(1)).toInt().coerceAtLeast(1)
            val folder = File(context.cacheDir, INGEST_DIR).apply { mkdirs() }
            val out = File(folder, UUID.randomUUID().toString() + ".pdf")
            val document = PdfDocument()
            try {
                val page = document.startPage(PdfDocument.PageInfo.Builder(PAGE_WIDTH_POINTS, pageHeight, 1).create())
                val canvas: Canvas = page.canvas
                canvas.drawColor(Color.WHITE)
                canvas.drawBitmap(bitmap, null, Rect(0, 0, PAGE_WIDTH_POINTS, pageHeight), null)
                document.finishPage(page)
                out.outputStream().use { document.writeTo(it) }
            } finally {
                document.close()
                bitmap.recycle()
            }
            return out
        } catch (why: Exception) {
            return null
        } finally {
            discard(photo)
        }
    }

    /**
     * Delete a file this object made. One that will not go stays under
     * `cacheDir`, which the OS clears, so a failure is logged and never thrown:
     * nothing here outlives an ingest by design, and a cache file by accident.
     */
    fun discard(file: File) {
        if (file.exists() && !file.delete()) Log.w("Centraid", "docs ingest: could not delete ${file.name}")
    }
}

/**
 * THE CAMERA'S WAY IN (#1047): a `FileProvider` of its own, over
 * `res/xml/docs_scans.xml`, so the system camera app can write a scan into
 * this app's cache. A separate provider rather than a second path on Photos'
 * `photocopies` one: that provider is the one folder a photograph LEAVES this
 * phone from, and a scan's landing folder is the opposite direction.
 */
public class DocsScanProvider : FileProvider()
