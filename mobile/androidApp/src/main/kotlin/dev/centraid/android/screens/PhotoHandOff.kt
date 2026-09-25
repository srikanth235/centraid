package dev.centraid.android.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.Build
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoDetail
import dev.centraid.shared.apps.photos.EXACT_LOCATION_COPIED
import dev.centraid.shared.apps.photos.EXPORT_FAILED
import dev.centraid.shared.apps.photos.EXPORT_SAVED
import dev.centraid.shared.apps.photos.ExifLocationStrip
import dev.centraid.shared.apps.photos.SHARE_ORIGINAL_NOT_HERE
import dev.centraid.shared.apps.photos.SHARE_PLACE_NOT_REMOVABLE
import dev.centraid.shared.apps.photos.SharePlacePrecision
import dev.centraid.shared.apps.photos.exactLocation
import dev.centraid.shared.apps.photos.sharePlaceMessage
import dev.centraid.shared.apps.photos.sharePlaceReceipt
import dev.centraid.shared.apps.photos.sharePlaceStripsLocation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * THE PATH ONE PHOTOGRAPH TAKES OFF THIS PHONE (#816, #1029 photos port).
 *
 * v0's `photo-share.ts` and `viewer-export.ts`, and the Android twin of
 * `PhotoHandOff.swift`. Everything here is platform I/O — reading the
 * original's bytes, writing a copy, handing a content URI to the OS — which is
 * why it is the shell's and not the reducer's: the DECISION (how much of the
 * place travels) is `SHEET_SHARE` and was reduced before any of this runs, and
 * what this reports back is a [Outcome] the screen turns into a
 * `HandOffSettled`.
 *
 * **TWO FILES HAND BYTES TO THE OS, AND NO THIRD.** This one sends the
 * viewer's one photograph; `PhotoShelfCopies.kt` sends a selection, from a shelf
 * or the Library, into its own subfolder under the same `FileProvider`
 * authority. Both strip the place when the member chose to leave it behind.
 */
internal object PhotoHandOff {
    /** What a hand-off did, in the sentence the status line shows. */
    data class Outcome(val done: Boolean, val sentence: String)

    /** `AndroidManifest.xml`'s provider, and `res/xml/shared_copies.xml`'s root. */
    private const val AUTHORITY_SUFFIX = ".photocopies"
    private const val COPY_FOLDER = "shared-copies"

    /** v0's `RE_ENCODE_QUALITY`: HEIC and PNG have no walker, so they re-encode. */
    private const val RE_ENCODE_QUALITY = 92

    /**
     * SEND A COPY, stripped to the precision the member chose.
     *
     * Below `EXACT` the bytes leave through [ExifLocationStrip]; a file that
     * cannot be walked is re-encoded when it is a still and REFUSED when it is
     * not — a movie is never transcoded to lose its place, and a copy that
     * would carry a place it was told not to is not sent at all.
     */
    suspend fun send(context: Context, detail: PhotoDetail, precision: SharePlacePrecision): Outcome {
        val original = detail.original_path?.takeIf { it.isNotEmpty() }?.let(::File)
            ?.takeIf { it.isFile }
            ?: return Outcome(false, SHARE_ORIGINAL_NOT_HERE)
        val copy = withContext(Dispatchers.IO) {
            runCatching { prepare(context, detail, original, precision) }.getOrNull()
        } ?: return Outcome(false, EXPORT_FAILED)
        if (copy is Prepared.Refused) return Outcome(false, copy.sentence)
        val file = (copy as Prepared.Ready).file
        val uri = FileProvider.getUriForFile(context, context.packageName + AUTHORITY_SUFFIX, file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = copy.mediaType
            putExtra(Intent.EXTRA_STREAM, uri)
            // THE NAME TRAVELS AS WORDS, never inside the file.
            sharePlaceMessage(precision, detail.place_name)?.let { putExtra(Intent.EXTRA_TEXT, it) }
            clipData = ClipData.newRawUri("", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(
            Intent.createChooser(intent, "Send a copy").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        // STATED EVERY TIME, `none` included: silence reads as safety.
        return Outcome(true, sharePlaceReceipt(precision, detail.place_name))
    }

    /**
     * "DOWNLOAD" — THE ORIGINAL INTO THIS DEVICE'S OWN PHOTOS, as v0's
     * `saveToCameraRoll`. Saving is not a share: the bytes stay on the phone,
     * so they go as they are, place and all.
     */
    suspend fun saveToDevice(context: Context, detail: PhotoDetail): Outcome {
        val original = detail.original_path?.takeIf { it.isNotEmpty() }?.let(::File)
            ?.takeIf { it.isFile }
            ?: return Outcome(false, SHARE_ORIGINAL_NOT_HERE)
        // MEDIASTORE WITHOUT A PERMISSION IS ANDROID 10'S. Below it the write
        // needs a storage grant this app never asks for, and asking for one to
        // save one photograph would be the wrong trade.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return Outcome(false, "Saving to this device's photos needs Android 10 or later.")
        }
        val video = detail.kind == PhotoCell.Kind.KIND_VIDEO
        val mediaType = detail.original_media_type.ifEmpty { if (video) "video/mp4" else "image/jpeg" }
        return withContext(Dispatchers.IO) {
            runCatching {
                val resolver = context.contentResolver
                val collection = if (video) {
                    MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                } else {
                    MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                }
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, outgoingName(detail, mediaType))
                    put(MediaStore.MediaColumns.MIME_TYPE, mediaType)
                    put(
                        MediaStore.MediaColumns.RELATIVE_PATH,
                        (if (video) "Movies" else "Pictures") + "/Centraid",
                    )
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val target = requireNotNull(resolver.insert(collection, values))
                resolver.openOutputStream(target).use { sink ->
                    original.inputStream().use { it.copyTo(requireNotNull(sink)) }
                }
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(target, values, null, null)
                Outcome(true, EXPORT_SAVED)
            }.getOrElse { Outcome(false, EXPORT_FAILED) }
        }
    }

    /**
     * "COPY EXACT LOCATION" — the one way a coordinate leaves this screen, and
     * only because the member asked (v0's `exactLocation`, five places).
     */
    fun copyLocation(context: Context, detail: PhotoDetail): Outcome {
        if (!detail.place_has_coordinate) return Outcome(false, EXPORT_FAILED)
        val clipboard = context.getSystemService(ClipboardManager::class.java)
            ?: return Outcome(false, EXPORT_FAILED)
        clipboard.setPrimaryClip(
            ClipData.newPlainText(
                "Exact location",
                exactLocation(detail.place_latitude, detail.place_longitude),
            ),
        )
        return Outcome(true, EXACT_LOCATION_COPIED)
    }

    /**
     * THE CAMERA, OUT OF THE ORIGINAL'S OWN HEADER. The vault's row cannot
     * say (`PhotoLightboxReads`' doc), and a camera writes its make and model
     * into the file it makes. Null for a file with neither, or one this
     * device does not hold.
     */
    fun cameraOf(path: String): String? = runCatching {
        val exif = ExifInterface(path)
        val make = exif.getAttribute(ExifInterface.TAG_MAKE)?.trim().orEmpty()
        val model = exif.getAttribute(ExifInterface.TAG_MODEL)?.trim().orEmpty()
        // "Apple iPhone 15 Pro", never "Apple Apple iPhone…": a model that
        // already names its maker is left to say so once.
        when {
            model.isEmpty() -> make
            make.isEmpty() || model.startsWith(make, ignoreCase = true) -> model
            else -> "$make $model"
        }.ifEmpty { null }
    }.getOrNull()

    private sealed interface Prepared {
        data class Ready(val file: File, val mediaType: String) : Prepared

        data class Refused(val sentence: String) : Prepared
    }

    private fun prepare(
        context: Context,
        detail: PhotoDetail,
        original: File,
        precision: SharePlacePrecision,
    ): Prepared {
        val folder = File(context.cacheDir, COPY_FOLDER).apply { mkdirs() }
        // ONE COPY AT A TIME: the last hand-off's file is not a thing this
        // phone needs to keep, and a cache of every photograph ever sent is a
        // second library nobody asked for.
        folder.listFiles()?.forEach { it.delete() }
        val mediaType = detail.original_media_type.ifEmpty { "application/octet-stream" }
        if (!sharePlaceStripsLocation(precision)) {
            val file = File(folder, outgoingName(detail, mediaType))
            original.copyTo(file, overwrite = true)
            return Prepared.Ready(file, mediaType)
        }
        val still = detail.kind == PhotoCell.Kind.KIND_PHOTO
        val bytes = original.readBytes()
        val jpeg = when {
            ExifLocationStrip.isJpeg(bytes) -> bytes
            still -> reEncoded(original) ?: return Prepared.Refused(SHARE_PLACE_NOT_REMOVABLE)
            else -> return Prepared.Refused(SHARE_PLACE_NOT_REMOVABLE)
        }
        val stripped = ExifLocationStrip.strip(jpeg) ?: return Prepared.Refused(SHARE_PLACE_NOT_REMOVABLE)
        val file = File(folder, outgoingName(detail, "image/jpeg"))
        file.writeBytes(stripped.bytes)
        return Prepared.Ready(file, "image/jpeg")
    }

    /**
     * A STILL WITH NO WALKER, AS A JPEG: decoded upright and compressed, which
     * writes no metadata at all. Orientation is applied first, because the
     * header that carried it is the thing being left behind.
     */
    private fun reEncoded(original: File): ByteArray? {
        val bitmap = decodeUpright(original.path, maxDimension = 0) ?: return null
        return ByteArrayOutputStream().use { out ->
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, RE_ENCODE_QUALITY, out)) return null
            out.toByteArray()
        }
    }

    /**
     * v0's `outgoingName`: the caption when it is shaped like a file name, a
     * plain noun when it is not, and the extension the bytes actually are.
     */
    private fun outgoingName(detail: PhotoDetail, mediaType: String): String {
        val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mediaType)
            ?.let { if (it == "jpeg") "jpg" else it }
        val base = detail.title.substringAfterLast('/').trim()
            .substringBeforeLast('.')
            .replace(Regex("[^A-Za-z0-9 ._-]"), "")
            .ifEmpty { if (detail.kind == PhotoCell.Kind.KIND_VIDEO) "video" else "photograph" }
        return if (extension == null) base else "$base.$extension"
    }
}

/**
 * ONE STILL, DECODED UPRIGHT AND NO LARGER THAN IT NEEDS TO BE.
 *
 * `ImageDecoder` applies the EXIF orientation itself and decodes HEIC; below
 * Android 9 `BitmapFactory` does neither, so the rotation is read from the
 * header and applied by hand. [maxDimension] of 0 is the file's own size.
 */
internal fun decodeUpright(path: String, maxDimension: Int): Bitmap? = runCatching {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(File(path))) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val longest = maxOf(info.size.width, info.size.height)
            if (maxDimension in 1 until longest) {
                val ratio = maxDimension.toFloat() / longest
                decoder.setTargetSize(
                    (info.size.width * ratio).toInt().coerceAtLeast(1),
                    (info.size.height * ratio).toInt().coerceAtLeast(1),
                )
            }
        }
    } else {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        var sample = 1
        val longest = maxOf(bounds.outWidth, bounds.outHeight)
        if (maxDimension > 0) while (longest / (sample * 2) >= maxDimension) sample *= 2
        val decoded = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: return null
        val degrees = when (
            ExifInterface(path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        ) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
        if (degrees == 0f) {
            decoded
        } else {
            Bitmap.createBitmap(
                decoded, 0, 0, decoded.width, decoded.height,
                Matrix().apply { postRotate(degrees) }, true,
            )
        }
    }
}.getOrNull()
