package dev.centraid.android.session

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import centraid.core.v1.Envelope
import centraid.core.v1.LibraryAssetsRequest
import centraid.core.v1.LibraryDerivatives
import centraid.core.v1.LibraryStage
import centraid.core.v1.Request
import centraid.core.v1.RollPage
import dev.centraid.android.backup.LibraryRefs
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.time.Instant

internal data class RollAssetRecord(
    val after: String,
    val video: Boolean,
    val capturedAt: String,
    val offsetMinutes: Int,
    val captureGroup: String,
    val changedInPlace: Boolean,
    val ref: String,
    val width: Int,
    val height: Int,
    val durationSeconds: Double,
    val latitude: Double?,
    val longitude: Double?,
)

internal data class RollPageResult(
    val assets: List<RollAssetRecord>,
    val nextCursor: String,
    val exhausted: Boolean,
)

internal data class LibraryStageOutcome(
    val ready: Boolean,
    val gone: Boolean = false,
    val sentence: String = "",
    val mediaType: String = "",
    val contentHash: String = "",
    val byteSize: Long = 0L,
    val alreadyHeld: Boolean = false,
    val derivativesHeld: List<String> = emptyList(),
    val priorAssetId: String = "",
    val priorContentHash: String = "",
)

internal object LibraryRoll {
    fun page(context: Context, ask: RollPage): RollPageResult = page(context, ask.cursor, ask.limit)

    fun page(context: Context, after: String, limit: Int): RollPageResult {
        val version = storeVersion(context)
        val position = positionOf(after, version)
        val assets = mutableListOf<RollAssetRecord>()
        var more = false
        var keysetId = position.id
        var newest = position.modified
        val resolver = context.contentResolver
        resolver.query(
            FILES,
            PROJECTION,
            "$TYPED AND ${MediaStore.Files.FileColumns._ID} > ?",
            arrayOf(position.id.toString()),
            "${MediaStore.Files.FileColumns._ID} ASC",
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                if (assets.size == limit) {
                    more = true
                    break
                }
                keysetId = cursor.getLong(0)
                newest = maxOf(newest, cursor.getLong(5))
                assets += assetOf(context, cursor, cursorOf(version, keysetId, newest, 0L), changed = false)
            }
        }
        if (!more && assets.size < limit) {
            resolver.query(
                FILES,
                PROJECTION,
                "$TYPED AND ${MediaStore.Files.FileColumns._ID} <= ? AND " +
                    "(${MediaStore.MediaColumns.DATE_MODIFIED} > ? OR " +
                    "(${MediaStore.MediaColumns.DATE_MODIFIED} = ? AND ${MediaStore.Files.FileColumns._ID} > ?))",
                arrayOf(keysetId.toString(), newest.toString(), newest.toString(), position.modifiedId.toString()),
                "${MediaStore.MediaColumns.DATE_MODIFIED} ASC, ${MediaStore.Files.FileColumns._ID} ASC",
            )?.use { cursor ->
                while (cursor.moveToNext()) {
                    if (assets.size == limit) {
                        more = true
                        break
                    }
                    val mark = cursorOf(version, keysetId, cursor.getLong(5), cursor.getLong(0))
                    assets += assetOf(context, cursor, mark, changed = true)
                }
            }
        }
        return RollPageResult(
            assets = assets,
            nextCursor = assets.lastOrNull()?.after ?: cursorOf(version, keysetId, newest, position.modifiedId),
            exhausted = !more,
        )
    }

    private fun assetOf(context: Context, cursor: Cursor, after: String, changed: Boolean): RollAssetRecord {
        val id = cursor.getLong(0)
        val video = cursor.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
        val taken = cursor.getLong(3).takeIf { it > 0L } ?: (cursor.getLong(4) * 1_000L)
        val ref = LibraryRefs.of(video, id)
        val location = if (video) null else locationOf(context, id)
        return RollAssetRecord(
            after = after,
            video = video,
            capturedAt = Instant.ofEpochMilli(taken).toString(),
            offsetMinutes = if (video) 0 else captureOffsetOf(context, id),
            captureGroup = if (changed) ref else "",
            changedInPlace = changed,
            ref = ref,
            width = cursor.getInt(6).coerceAtLeast(0),
            height = cursor.getInt(7).coerceAtLeast(0),
            durationSeconds = if (video) cursor.getLong(8).coerceAtLeast(0L) / 1_000.0 else 0.0,
            latitude = location?.first,
            longitude = location?.second,
        )
    }

    private fun locationOf(context: Context, id: Long): Pair<Double, Double>? {
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        return try {
            val original = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.setRequireOriginal(uri) else uri
            context.contentResolver.openInputStream(original)?.use { stream ->
                val found = FloatArray(2)
                if (android.media.ExifInterface(stream).getLatLong(found)) found[0].toDouble() to found[1].toDouble() else null
            }
        } catch (_: SecurityException) {
            null
        } catch (_: UnsupportedOperationException) {
            null
        } catch (_: IOException) {
            null
        }
    }

    private fun captureOffsetOf(context: Context, id: Long): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return 0
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        return try {
            context.contentResolver.openInputStream(uri)?.use { stream ->
                offsetMinutes(android.media.ExifInterface(stream).getAttribute(android.media.ExifInterface.TAG_OFFSET_TIME_ORIGINAL))
            } ?: 0
        } catch (_: SecurityException) {
            0
        } catch (_: UnsupportedOperationException) {
            0
        } catch (_: IOException) {
            0
        }
    }

    internal fun offsetMinutes(tag: String?): Int {
        val text = tag?.trim { it.isWhitespace() || it == '\u0000' }?.takeIf { it.isNotEmpty() } ?: return 0
        if (text == "Z" || text == "z") return 0
        val sign = when (text[0]) {
            '+' -> 1
            '-' -> -1
            else -> return 0
        }
        val digits = text.substring(1)
        val (hours, minutes) = when {
            digits.length == 5 && digits[2] == ':' -> digits.substring(0, 2) to digits.substring(3)
            digits.length == 4 -> digits.substring(0, 2) to digits.substring(2)
            digits.length == 2 -> digits to "00"
            else -> return 0
        }
        if (!(hours + minutes).all { it in '0'..'9' }) return 0
        if (minutes.toInt() > 59) return 0
        val total = sign * (hours.toInt() * 60 + minutes.toInt())
        return if (total in -1080..1080) total else 0
    }

    suspend fun stage(context: Context, core: CentraidCore, ask: LibraryStage): LibraryStageOutcome {
        val prior = if (ask.changed_in_place) priorOf(core, ask.ref) else null
        val uri = uriOf(ask.ref) ?: return LibraryStageOutcome(ready = false, gone = true)
        val resolver = context.contentResolver
        val type = ask.media_type.ifEmpty { resolver.getType(uri) ?: OCTET_STREAM }
        val readable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && keepsLocation(context)) {
            MediaStore.setRequireOriginal(uri)
        } else {
            uri
        }
        val descriptor = try {
            resolver.openFileDescriptor(readable, "r")
        } catch (_: SecurityException) {
            null
        } catch (_: UnsupportedOperationException) {
            null
        } catch (_: FileNotFoundException) {
            null
        } catch (_: IOException) {
            null
        } ?: return LibraryStageOutcome(ready = false, gone = true)
        val size = if (ask.byte_size > 0) ask.byte_size else descriptor.statSize.coerceAtLeast(0L)
        val outcome = try {
            ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
                Stage.stage(core, type, size, osLibrary = true, osRef = ask.ref, read = Stage.slices(input))
            }
        } catch (_: IOException) {
            Stage.Outcome.Refused("")
        }
        return when (outcome) {
            is Stage.Outcome.Refused -> LibraryStageOutcome(ready = false, sentence = outcome.sentence)
            is Stage.Outcome.Staged -> LibraryStageOutcome(
                ready = true,
                mediaType = type,
                contentHash = outcome.handle.content_hash,
                byteSize = outcome.handle.byte_size,
                alreadyHeld = outcome.handle.already_held,
                derivativesHeld = outcome.handle.derivatives_held,
                priorAssetId = prior?.first.orEmpty(),
                priorContentHash = prior?.second.orEmpty(),
            )
        }
    }

    private suspend fun priorOf(core: CentraidCore, ref: String): Pair<String, String>? {
        val answer = core.call(Envelope(request = Request(library_assets = LibraryAssetsRequest(os_ref = listOf(ref)))))
        val items = (answer as? CoreOutcome.Answered)?.value?.response?.library_assets?.items ?: return null
        val found = items.firstOrNull { it.os_ref == ref } ?: return null
        return found.asset_id to Stage.hex(found.content_hash)
    }

    suspend fun derivatives(context: Context, core: CentraidCore, ask: LibraryDerivatives) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val uri = uriOf(ask.ref) ?: return
        for (tier in ask.tiers) {
            val edge = TIER_EDGES[tier] ?: continue
            val jpeg = render(context, uri, edge) ?: continue
            Stage.stage(core, JPEG, jpeg.size.toLong(), forHash = ask.for_hash, tier = tier, read = Stage.slices(jpeg.inputStream()))
        }
    }

    private fun render(context: Context, uri: Uri, edge: Int): ByteArray? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val drawn = try {
            context.contentResolver.loadThumbnail(uri, android.util.Size(edge, edge), null)
        } catch (_: IOException) {
            null
        } catch (_: SecurityException) {
            null
        } ?: return null
        val longest = maxOf(drawn.width, drawn.height)
        val fitted = if (longest <= edge) {
            drawn
        } else {
            val scale = edge.toDouble() / longest
            Bitmap.createScaledBitmap(
                drawn,
                (drawn.width * scale).toInt().coerceAtLeast(1),
                (drawn.height * scale).toInt().coerceAtLeast(1),
                true,
            )
        }
        return ByteArrayOutputStream().also { fitted.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it) }.toByteArray()
    }

    fun uriOf(ref: String): Uri? {
        val row = LibraryRefs.row(ref) ?: return null
        val base = if (row.video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        return ContentUris.withAppendedId(base, row.id)
    }

    private fun keepsLocation(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun storeVersion(context: Context): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.getVersion(context) else ""

    private fun cursorOf(version: String, id: Long, modified: Long, modifiedId: Long): String =
        "$VERSIONED|$version|$id|$modified|$modifiedId"

    private class Position(val id: Long, val modified: Long, val modifiedId: Long)

    private fun positionOf(cursor: String, version: String): Position {
        val parts = cursor.takeIf { it.startsWith("$VERSIONED|") }?.split('|') ?: return Position(0L, 0L, 0L)
        if (parts.size < 3 || parts[1] != version) return Position(0L, 0L, 0L)
        return Position(
            id = parts[2].toLongOrNull() ?: 0L,
            modified = parts.getOrNull(3)?.toLongOrNull() ?: 0L,
            modifiedId = parts.getOrNull(4)?.toLongOrNull() ?: 0L,
        )
    }

    private val FILES: Uri get() = MediaStore.Files.getContentUri("external")
    private val PROJECTION = arrayOf(
        MediaStore.Files.FileColumns._ID,
        MediaStore.Files.FileColumns.MEDIA_TYPE,
        MediaStore.MediaColumns.SIZE,
        "datetaken",
        MediaStore.MediaColumns.DATE_ADDED,
        MediaStore.MediaColumns.DATE_MODIFIED,
        MediaStore.MediaColumns.WIDTH,
        MediaStore.MediaColumns.HEIGHT,
        "duration",
    )
    private val TYPED = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN " +
        "(${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE}, ${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})"
    private const val VERSIONED = "v"
    private const val OCTET_STREAM = "application/octet-stream"
    private const val JPEG = "image/jpeg"
    private const val JPEG_QUALITY = 80
    private val TIER_EDGES = mapOf("thumb" to 360, "preview" to 2048)
}
