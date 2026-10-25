package dev.centraid.android.screens

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.Build
import java.io.File

/**
 * WHAT THE LIGHTBOX NEEDS OF THE ORIGINAL'S FILE THAT ONLY THE PLATFORM CAN READ
 * (#1135): its camera, and a still decoded upright.
 *
 * The hand-offs this file used to carry (send a copy, save to the library, copy a
 * location) are Rust's now: `photos.lightbox` asks for `ExportOriginals` and
 * `ClipboardSet`, and the shell performs them.
 */
internal object PhotoHandOff {
    /**
     * THE CAMERA, OUT OF THE ORIGINAL'S OWN HEADER. The vault's row cannot
     * say, and a camera writes its make and model
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
