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
import centraid.core.v1.LibraryStaged
import centraid.core.v1.PhotosMediaPermission
import centraid.core.v1.Request
import centraid.core.v1.RollAsset
import centraid.core.v1.RollPaged
import centraid.core.v1.RollResource
import dev.centraid.android.backup.LibraryRefs
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.time.Instant

/**
 * THE PHONE'S PHOTO LIBRARY, AS THE CAMERA-ROLL SERVICE ASKS FOR IT (#1025 S6; #1080; #1135).
 *
 * `imports.camera_roll` (`crates/screens/src/imports/camera_roll.rs`) decides the walk, the cursor,
 * what may cross which link and what is committed; this answers its effects with what MediaStore
 * says: the grant (`LibraryPermission`), one page after a cursor (`RollPage`), one resource streamed
 * through the stage door (`LibraryStage`) and the tiers the platform draws (`LibraryDerivatives`).
 */
internal object LibraryRoll {
    // ---- the grant ---------------------------------------------------------------

    /** The grant as it stands. Android 14's partial access is iOS's limited selection, the same fact. */
    fun permission(context: Context): PhotosMediaPermission {
        val name = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        return when {
            context.checkSelfPermission(name) == PackageManager.PERMISSION_GRANTED ->
                PhotosMediaPermission.PHOTOS_MEDIA_PERMISSION_GRANTED
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
                context.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) ==
                PackageManager.PERMISSION_GRANTED -> PhotosMediaPermission.PHOTOS_MEDIA_PERMISSION_LIMITED
            else -> PhotosMediaPermission.PHOTOS_MEDIA_PERMISSION_DENIED
        }
    }

    // ---- one page ----------------------------------------------------------------

    /**
     * ONE PAGE OF THE ROLL: PHOTOGRAPHS AND VIDEOS, as one keyset over `MediaStore.Files` on `_ID`.
     *
     * MediaProvider allots `_ID` with `AUTOINCREMENT`, so the keyset finds every item ADDED since
     * the last walk whatever its capture date, and never re-offers one. **The cursor carries the
     * MediaStore version** (API 29+): a rebuilt database numbers its rows again, so a cursor written
     * against another version starts the walk over (`already_held` makes that walk cheap).
     *
     * **Then the items EDITED IN PLACE since** (#1127, A20): an editor that overwrites the file keeps
     * the `_ID` and moves `DATE_MODIFIED`. Once the keyset has nothing left, the page is filled with
     * items at or below the keyset's `_ID` whose `DATE_MODIFIED` is at or past the cursor's mark,
     * oldest change first, each marked `changed_in_place` with its own ref as its capture group.
     *
     * No `LIMIT` in the sort order (Android 11 refuses the token there), so the walk reads one row
     * past the page to learn whether the roll is exhausted.
     */
    fun page(context: Context, after: String, limit: Int): RollPaged {
        val version = storeVersion(context)
        val position = positionOf(after, version)
        val assets = mutableListOf<RollAsset>()
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
        return RollPaged(
            assets = assets,
            next_cursor = assets.lastOrNull()?.after ?: cursorOf(version, keysetId, newest, position.modifiedId),
            exhausted = !more,
        )
    }

    /** One `MediaStore` row as one asset with its one resource. Columns as [PROJECTION] projects them. */
    private fun assetOf(context: Context, cursor: Cursor, after: String, changed: Boolean): RollAsset {
        val id = cursor.getLong(0)
        val video = cursor.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
        // DATE_TAKEN is the camera's; an item that never had one falls back to when it was added.
        val taken = cursor.getLong(3).takeIf { it > 0L } ?: (cursor.getLong(4) * 1_000L)
        val ref = LibraryRefs.of(video, id)
        val location = if (video) null else locationOf(context, id)
        return RollAsset(
            after = after,
            kind = if (video) RollAsset.Kind.KIND_VIDEO else RollAsset.Kind.KIND_PHOTO,
            captured_at = Instant.ofEpochMilli(taken).toString(),
            captured_utc_offset_minutes = if (video) 0 else captureOffsetOf(context, id),
            // NO INFERRED GROUPING (motion photos, RAW, bursts pass through as original bytes); an
            // item changed in place is the one exception, its own ref being its group.
            capture_group = if (changed) ref else "",
            changed_in_place = changed,
            resources = listOf(RollResource(ref = ref, role = RollResource.Role.ROLE_ORIGINAL)),
            // WHAT THE LIBRARY KNOWS (#1146 D5): the pixel box and a movie's length, 0 when the row
            // has none; where it was taken, only when the file's own EXIF says (a pair or nothing).
            width = cursor.getInt(6).coerceAtLeast(0),
            height = cursor.getInt(7).coerceAtLeast(0),
            duration_s = if (video) cursor.getLong(8).coerceAtLeast(0L) / 1_000.0 else 0.0,
            latitude = location?.first,
            longitude = location?.second,
        )
    }

    /**
     * WHERE AN IMAGE WAS TAKEN, from its own EXIF (a pair or nothing). Android 10+ redacts the
     * location unless the original is asked for (and `ACCESS_MEDIA_LOCATION` granted); a refusal,
     * a missing tag or a file that will not open is no location, never a guess.
     */
    private fun locationOf(context: Context, id: Long): Pair<Double, Double>? {
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        return try {
            val original = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.setRequireOriginal(uri) else uri
            context.contentResolver.openInputStream(original)?.use { stream ->
                val found = FloatArray(2)
                if (android.media.ExifInterface(stream).getLatLong(found)) found[0].toDouble() to found[1].toDouble() else null
            }
        } catch (refused: SecurityException) {
            null
        } catch (unsupported: UnsupportedOperationException) {
            null
        } catch (failed: IOException) {
            null
        }
    }

    /**
     * THE CAPTURE'S ZONE, MINUTES EAST OF UTC, from the file's own EXIF `OffsetTimeOriginal`
     * (D-1025-S7-77; never `OffsetTime`, the zone of the file's last change). Zero whenever the tag
     * cannot be read, and never the phone's own zone. The framework parses it from API 31.
     */
    private fun captureOffsetOf(context: Context, id: Long): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return 0
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        return try {
            context.contentResolver.openInputStream(uri)?.use { stream ->
                offsetMinutes(android.media.ExifInterface(stream).getAttribute(android.media.ExifInterface.TAG_OFFSET_TIME_ORIGINAL))
            } ?: 0
        } catch (refused: SecurityException) {
            0
        } catch (unsupported: UnsupportedOperationException) {
            0
        } catch (failed: IOException) {
            0
        }
    }

    /**
     * `OffsetTimeOriginal` as minutes east of UTC: `Z`, `±HH:MM`, `±HHMM` or `±HH`, ASCII digits,
     * minutes under 60, within ±18 hours; zero for anything else (D-1025-S7-77).
     */
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

    // ---- one resource, through the stage door --------------------------------------

    /**
     * Stream one resource through the stage door as `OS_LIBRARY` with its ref, and answer what the
     * core named. Android's media store holds what is on the device, so `allow_network` has nothing
     * to say here and nothing is ever `IN_CLOUD`. With `changed_in_place` the core is first asked
     * which asset the ref was last backed up as (`library_assets`), BEFORE the new bytes are staged.
     */
    suspend fun stage(context: Context, core: CentraidCore, ask: LibraryStage): LibraryStaged {
        val prior = if (ask.changed_in_place) priorOf(core, ask.ref) else null
        val uri = uriOf(ask.ref) ?: return gone()
        val resolver = context.contentResolver
        val type = ask.media_type.ifEmpty { resolver.getType(uri) ?: OCTET_STREAM }
        val readable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && keepsLocation(context)) {
            MediaStore.setRequireOriginal(uri)
        } else {
            uri
        }
        // A REFUSAL IS THIS ONE ITEM GONE, never a reason to end a pass: a revoked or partial grant,
        // a row whose file went between the page and now, a provider that could not produce it.
        val descriptor = try {
            resolver.openFileDescriptor(readable, "r")
        } catch (refused: SecurityException) {
            null
        } catch (unsupported: UnsupportedOperationException) {
            null
        } catch (missing: FileNotFoundException) {
            null
        } catch (failed: IOException) {
            null
        } ?: return gone()
        // `statSize` is -1 for a pipe; zero is "unknown" to the stage door.
        val size = if (ask.byte_size > 0) ask.byte_size else descriptor.statSize.coerceAtLeast(0L)
        val outcome = try {
            ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
                Stage.stage(core, type, size, osLibrary = true, osRef = ask.ref, read = Stage.slices(input))
            }
        } catch (failed: IOException) {
            Stage.Outcome.Refused("")
        }
        return when (outcome) {
            is Stage.Outcome.Refused ->
                LibraryStaged(outcome = LibraryStaged.Outcome.OUTCOME_FAILED, sentence = outcome.sentence)
            is Stage.Outcome.Staged -> LibraryStaged(
                outcome = LibraryStaged.Outcome.OUTCOME_READY,
                media_type = type,
                content_hash = outcome.handle.content_hash,
                byte_size = outcome.handle.byte_size,
                already_held = outcome.handle.already_held,
                derivatives_held = outcome.handle.derivatives_held,
                prior_asset_id = prior?.first.orEmpty(),
                prior_content_hash = prior?.second.orEmpty(),
            )
        }
    }

    private fun gone(): LibraryStaged = LibraryStaged(outcome = LibraryStaged.Outcome.OUTCOME_GONE)

    /** The asset and bytes the vault last filed [ref] as, or null: the lookup only ever adds a lineage. */
    private suspend fun priorOf(core: CentraidCore, ref: String): Pair<String, String>? {
        val answer = core.call(Envelope(request = Request(library_assets = LibraryAssetsRequest(os_ref = listOf(ref)))))
        val items = (answer as? CoreOutcome.Answered)?.value?.response?.library_assets?.items ?: return null
        val found = items.firstOrNull { it.os_ref == ref } ?: return null
        return found.asset_id to Stage.hex(found.content_hash)
    }

    // ---- the tiers the platform draws -----------------------------------------------

    /**
     * Render each tier asked for (`loadThumbnail`, API 29+: upright, the current edit) fitted to the
     * tier's long edge, JPEG 80 with no metadata, and stage it as a derivative of `for_hash`. A tier
     * that fails costs nothing but itself; below API 29 nothing is drawn.
     */
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
        } catch (failed: IOException) {
            null
        } catch (refused: SecurityException) {
            null
        } ?: return null
        val longest = maxOf(drawn.width, drawn.height)
        // "CLOSE TO THE REQUESTED SIZE, BUT MAY BE LARGER": fitted here.
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

    // ---- refs and cursors -----------------------------------------------------------

    /** The content uri a ref names; a bare `_ID` (an early build's ref) was always an image. */
    fun uriOf(ref: String): Uri? {
        val row = LibraryRefs.row(ref) ?: return null
        val base = if (row.video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        return ContentUris.withAppendedId(base, row.id)
    }

    /** Whether the member let Centraid read where a photograph was taken (then the GPS tags are kept). */
    private fun keepsLocation(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun storeVersion(context: Context): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.getVersion(context) else ""

    /** `v|<version>|<_ID>|<DATE_MODIFIED mark>|<_ID of the last changed item>`. */
    private fun cursorOf(version: String, id: Long, modified: Long, modifiedId: Long): String =
        "$VERSIONED|$version|$id|$modified|$modifiedId"

    private class Position(val id: Long, val modified: Long, val modifiedId: Long)

    /** Where to walk after: the start for no cursor, an unversioned one, or one from another MediaStore version. */
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
        // `MediaStore.MediaColumns.DATE_TAKEN`, spelled out: the constant is API 29's.
        "datetaken",
        MediaStore.MediaColumns.DATE_ADDED,
        MediaStore.MediaColumns.DATE_MODIFIED,
        MediaStore.MediaColumns.WIDTH,
        MediaStore.MediaColumns.HEIGHT,
        // `MediaStore.MediaColumns.DURATION` (milliseconds; a movie's), spelled out: API 29's.
        "duration",
    )
    private val TYPED = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN " +
        "(${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE}, ${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})"
    private const val VERSIONED = "v"
    private const val OCTET_STREAM = "application/octet-stream"
    private const val JPEG = "image/jpeg"

    /** `crates/media/src/renditions.rs`' quality and long edges, as the platform draws them. */
    private const val JPEG_QUALITY = 80
    private val TIER_EDGES = mapOf("thumb" to 360, "preview" to 2048)
}
