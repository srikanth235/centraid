package dev.centraid.android.screens.photos

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import centraid.core.v1.EditRendered
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectResult
import centraid.core.v1.PhotosEditCrop
import centraid.core.v1.PhotosEditPlan
import centraid.core.v1.RenderEdit
import dev.centraid.core.CentraidCore
import dev.centraid.android.session.Stage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * THE PIXEL HALF OF THE EDITOR (#1135): decode, draw, encode. The platform's
 * because decoding a photograph is platform I/O; everything else (the plan, its
 * clamping, the save as a new photograph) is Rust's. A [RenderEdit] effect carries
 * the original's file and the plan; this renders it, streams the JPEG through the
 * stage door and answers [EditRendered] with the staged hash.
 */
internal object PhotosEditRender {
    /** The longest edge of the stage's decode, in pixels: a preview, never the original. */
    private const val PREVIEW_EDGE: Int = 2048

    private val FULL_CROP = PhotosEditCrop(x = 0.0, y = 0.0, w = 1.0, h = 1.0)

    /** A stage-sized decode, oriented. Never the full original: that is for Save. */
    fun preview(path: String): ImageBitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= PREVIEW_EDGE) sample *= 2
        val bitmap = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: return null
        return oriented(bitmap, path).asImageBitmap()
    }

    /** Render [effect] and stage the result; a failure is `EffectFailed`, never silence. */
    suspend fun perform(cacheDir: File, core: CentraidCore, effect: RenderEdit): EffectResult =
        withContext(Dispatchers.Default) {
            val made = render(cacheDir, effect) ?: return@withContext failed("the edit could not be drawn")
            try {
                val size = made.file.length()
                val staged = made.file.inputStream().use { source ->
                    Stage.stage(core, MEDIA_TYPE, size, read = Stage.slices(source))
                }
                when (staged) {
                    is Stage.Outcome.Refused -> failed(staged.sentence)
                    is Stage.Outcome.Staged -> EffectResult(
                        edit_rendered = EditRendered(
                            content_hash = staged.handle.content_hash,
                            media_type = MEDIA_TYPE,
                            width = made.width,
                            height = made.height,
                            byte_size = staged.handle.byte_size,
                        ),
                    )
                }
            } finally {
                made.file.delete()
            }
        }

    private class Made(val file: File, val width: Int, val height: Int)

    /**
     * FLIP, ROTATE, THEN CROP: the crop is in fractions of the ROTATED frame, and
     * the order is the stage's, so what is saved is what was on screen. JPEG at the
     * effect's quality, the web editor's 0.92.
     */
    private fun render(cacheDir: File, effect: RenderEdit): Made? {
        val plan = effect.plan ?: return null
        val decoded = try {
            BitmapFactory.decodeFile(effect.source_path)
        } catch (tooLarge: OutOfMemoryError) {
            null
        } ?: return null
        return try {
            val source = oriented(decoded, effect.source_path)
            val rotation = ((plan.quarters % 4) * 90 + plan.straighten).toFloat()
            val matrix = Matrix().apply {
                postScale(
                    if (plan.flip == PhotosEditPlan.Flip.FLIP_HORIZONTAL) -1f else 1f,
                    if (plan.flip == PhotosEditPlan.Flip.FLIP_VERTICAL) -1f else 1f,
                    source.width / 2f,
                    source.height / 2f,
                )
                postRotate(rotation, source.width / 2f, source.height / 2f)
            }
            val turned = if (matrix.isIdentity) {
                source
            } else {
                Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
            }
            val crop = clamp(plan.crop ?: FULL_CROP)
            val cropped = if (crop.w >= 1.0 && crop.h >= 1.0) {
                turned
            } else {
                val (x, y, w, h) = cropPixels(crop, turned.width, turned.height)
                Bitmap.createBitmap(turned, x, y, w, h)
            }
            val file = File(cacheDir, "edit-" + UUID.randomUUID() + ".jpg")
            val quality = effect.jpeg_quality_percent.takeIf { it > 0 } ?: 92
            val ok = file.outputStream().use { out -> cropped.compress(Bitmap.CompressFormat.JPEG, quality, out) }
            if (!ok) return null
            Made(file, cropped.width, cropped.height)
        } catch (tooLarge: OutOfMemoryError) {
            null
        }
    }

    /** Rust's clamp: a side below a tenth grows to it, and the rectangle stays inside the frame. */
    private fun clamp(rect: PhotosEditCrop): PhotosEditCrop {
        val w = rect.w.coerceIn(0.1, 1.0)
        val h = rect.h.coerceIn(0.1, 1.0)
        return PhotosEditCrop(x = rect.x.coerceIn(0.0, 1.0 - w), y = rect.y.coerceIn(0.0, 1.0 - h), w = w, h = h)
    }

    /** Rust's `crop_pixels`: HALF UP (v0's `Math.round`), clamped to the bitmap. */
    private fun cropPixels(rect: PhotosEditCrop, width: Int, height: Int): List<Int> {
        fun halfUp(value: Double) = floor(value + 0.5).toInt()
        val w = max(1, halfUp(rect.w * width))
        val h = max(1, halfUp(rect.h * height))
        val x = halfUp(rect.x * width).coerceIn(0, max(0, width - w))
        val y = halfUp(rect.y * height).coerceIn(0, max(0, height - h))
        return listOf(x, y, min(w, width), min(h, height))
    }

    /**
     * THE CAMERA'S OWN TURN, applied before anything the member did: a photograph
     * stored sideways with an EXIF orientation would otherwise be cropped by a
     * rectangle drawn on the upright stage and cut from the sideways bytes.
     */
    private fun oriented(bitmap: Bitmap, path: String): Bitmap {
        val orientation = runCatching {
            android.media.ExifInterface(path).getAttributeInt(
                android.media.ExifInterface.TAG_ORIENTATION,
                android.media.ExifInterface.ORIENTATION_NORMAL,
            )
        }.getOrDefault(android.media.ExifInterface.ORIENTATION_NORMAL)
        val matrix = Matrix()
        when (orientation) {
            android.media.ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
            android.media.ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
            android.media.ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
            android.media.ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.setRotate(90f)
                matrix.postScale(-1f, 1f)
            }
            android.media.ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
            android.media.ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.setRotate(-90f)
                matrix.postScale(-1f, 1f)
            }
            android.media.ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
            else -> return bitmap
        }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    private fun failed(reason: String) = EffectResult(failed = EffectFailed(reason = reason))

    private const val MEDIA_TYPE: String = "image/jpeg"
}
