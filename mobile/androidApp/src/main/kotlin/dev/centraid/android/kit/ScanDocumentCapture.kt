package dev.centraid.android.kit

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.pdf.PdfDocument
import android.media.ExifInterface
import android.net.Uri
import androidx.core.content.FileProvider
import centraid.core.v1.ShellEffectResult
import centraid.core.v1.ShellFailed
import centraid.core.v1.ShellPicked
import centraid.core.v1.ShellPickedItem
import dev.centraid.android.session.Stage
import dev.centraid.core.CentraidCore
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Capture one camera image, package it as a one-page PDF, then hand bytes to core-owned staging. */
internal suspend fun captureDocument(
    context: Context,
    core: CentraidCore,
    asking: suspend (launch: () -> Unit) -> Boolean,
    launch: (Uri) -> Unit,
): ShellEffectResult {
    val directory = File(context.cacheDir, "shared-copies/scans")
    if (!directory.exists() && !directory.mkdirs()) {
        return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNWRITABLE))
    }
    val photo = runCatching { File.createTempFile("scan-", ".jpg", directory) }.getOrNull()
        ?: return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNWRITABLE))
    val pdf = File(directory, "${photo.nameWithoutExtension}.pdf")
    try {
        val photoUri = FileProvider.getUriForFile(context, context.packageName + ".photocopies", photo)
        val captured = asking { launch(photoUri) }
        if (!captured) return ShellEffectResult(
            failed = ShellFailed(reason = EffectReason.CANCELLED, cancelled = true),
        )
        return withContext(Dispatchers.IO) {
            try {
                createSinglePagePdf(photo, pdf)
                val staged = FileInputStream(pdf).use { input ->
                    Stage.stage(core, "application/pdf", pdf.length()) { max ->
                        val bytes = ByteArray(max)
                        val count = input.read(bytes)
                        if (count <= 0) ByteArray(0) else bytes.copyOf(count)
                    }
                }
                when (staged) {
                    is Stage.Outcome.Staged -> ShellEffectResult(
                        picked = ShellPicked(items = listOf(
                            ShellPickedItem(
                                stage_handle = staged.handle,
                                name = "Scanned page.pdf",
                                media_type = "application/pdf",
                                size = staged.handle.byte_size,
                            ),
                        )),
                    )
                    is Stage.Outcome.Refused -> ShellEffectResult(
                        failed = ShellFailed(reason = if (staged.full) EffectReason.TOO_LARGE else EffectReason.UNWRITABLE),
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNREADABLE))
            }
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNAVAILABLE))
    } finally {
        photo.delete()
        pdf.delete()
    }
}

/** Decode a bounded camera bitmap and write an honest one-page PDF without auto-cropping. */
internal fun createSinglePagePdf(photo: File, pdf: File) {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(photo.absolutePath, bounds)
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "camera returned no image" }
    val sample = boundedDecodeSampleSize(bounds.outWidth, bounds.outHeight)
    val decoded = BitmapFactory.decodeFile(
        photo.absolutePath,
        BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 },
    ) ?: error("camera image could not be decoded")
    val oriented = try {
        val orientation = ExifInterface(photo.absolutePath).getAttributeInt(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.ORIENTATION_NORMAL,
        )
        val degrees = rotationForExifOrientation(orientation)
        if (degrees == 0) decoded else {
            val matrix = Matrix().apply { postRotate(degrees.toFloat()) }
            Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true).also {
                if (it !== decoded) decoded.recycle()
            }
        }
    } catch (failure: Throwable) {
        decoded.recycle()
        throw failure
    }
    val landscape = oriented.width > oriented.height
    val pageWidth = if (landscape) A4_LONG else A4_SHORT
    val pageHeight = if (landscape) A4_SHORT else A4_LONG
    val document = PdfDocument()
    try {
        val page = document.startPage(PdfDocument.PageInfo.Builder(pageWidth, pageHeight, 1).create())
        val canvas = page.canvas
        canvas.drawColor(android.graphics.Color.WHITE)
        val availableWidth = pageWidth - PAGE_MARGIN * 2f
        val availableHeight = pageHeight - PAGE_MARGIN * 2f
        val scale = minOf(availableWidth / oriented.width, availableHeight / oriented.height)
        val width = oriented.width * scale
        val height = oriented.height * scale
        val left = (pageWidth - width) / 2f
        val top = (pageHeight - height) / 2f
        canvas.drawBitmap(oriented, null, android.graphics.RectF(left, top, left + width, top + height), null)
        document.finishPage(page)
        FileOutputStream(pdf).use(document::writeTo)
    } finally {
        document.close()
        oriented.recycle()
    }
}

internal fun boundedDecodeSampleSize(width: Int, height: Int): Int {
    require(width > 0 && height > 0)
    var sample = 1
    while ((width.toLong() / sample) * (height.toLong() / sample) > MAX_DECODE_PIXELS) sample *= 2
    return sample
}

internal fun rotationForExifOrientation(orientation: Int): Int = when (orientation) {
    3 -> 180
    5, 6 -> 90
    7, 8 -> 270
    else -> 0
}

private const val MAX_DECODE_PIXELS = 16_000_000L
private const val A4_SHORT = 595
private const val A4_LONG = 842
private const val PAGE_MARGIN = 24
