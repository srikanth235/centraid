package dev.centraid.android.screens

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.ExifInterface
import android.os.Build
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import centraid.core.v1.ContentRef
import centraid.core.v1.ContentUrlRequest
import centraid.core.v1.ContentSource
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectResult
import centraid.core.v1.Envelope
import centraid.core.v1.ExportOriginals
import centraid.core.v1.OriginalsExported
import centraid.core.v1.Request
import dev.centraid.android.backup.LibraryRefs
import dev.centraid.android.kit.EffectReason
import dev.centraid.android.kit.writeFailureReason
import dev.centraid.android.session.Stage
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val COPIES_AUTHORITY_SUFFIX = ".photocopies"
private const val BATCH_DIR = "shared-copies/batch"

internal fun mediaPermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> arrayOf(
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VIDEO,
        Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
    )
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> arrayOf(
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VIDEO,
    )
    else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
}

internal suspend fun performExportOriginals(
    context: Context,
    core: CentraidCore,
    export: ExportOriginals,
): EffectResult {
    if (export.mode == ExportOriginals.Mode.MODE_ARCHIVE) {
        return performArchiveOriginal(context, core, export)
    }
    val located = withContext(Dispatchers.IO) { locateOriginals(context, core, export.photo_ids) }
    val missing = located.missing
    var storageFull = false
    fun exported(status: OriginalsExported.Status, handed: Int = 0) = EffectResult(
        originals_exported = OriginalsExported(status = status, handed = handed, missing = missing),
    )
    if (located.originals.isEmpty()) return exported(OriginalsExported.Status.STATUS_NONE_HERE)
    return when (export.mode) {
        ExportOriginals.Mode.MODE_SEND -> {
            val files = withContext(Dispatchers.IO) {
                prepareCopies(context, located.originals) { storageFull = true }
            } ?: return exported(
                if (storageFull) {
                    OriginalsExported.Status.STATUS_STORAGE_FULL
                } else {
                    OriginalsExported.Status.STATUS_LOCATION_NOT_REMOVABLE
                },
            )
            val authority = context.packageName + COPIES_AUTHORITY_SUFFIX
            val uris = ArrayList(files.map { FileProvider.getUriForFile(context, authority, it) })
            val send = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
                type = when {
                    located.originals.all { it.isVideo } -> "video/*"
                    located.originals.none { it.isVideo } -> "image/*"
                    else -> "*/*"
                }
                putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(
                Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            exported(OriginalsExported.Status.STATUS_DONE, files.size)
        }
        ExportOriginals.Mode.MODE_SAVE -> {
            val saved = withContext(Dispatchers.IO) {
                saveToLibrary(context, located.originals) { storageFull = true }
            }
            if (saved < 0) {
                exported(
                    if (storageFull) OriginalsExported.Status.STATUS_STORAGE_FULL else OriginalsExported.Status.STATUS_FAILED,
                )
            } else {
                exported(OriginalsExported.Status.STATUS_DONE, saved)
            }
        }
        else -> EffectResult(failed = EffectFailed(reason = EffectReason.UNSUPPORTED))
    }
}

private suspend fun performArchiveOriginal(
    context: Context,
    core: CentraidCore,
    export: ExportOriginals,
): EffectResult {
    if (export.export_job_id.isBlank() || export.export_photo_id.isBlank() ||
        Stage.raw(export.export_content_hash).size != 32 || export.export_byte_size < 0L
    ) {
        return archiveResult(
            OriginalsExported.ArchiveDisposition.ARCHIVE_DISPOSITION_UNREADABLE,
            OriginalsExported.Status.STATUS_FAILED,
        )
    }
    val row = LibraryRefs.row(export.export_os_ref)
        ?: return archiveResult(
            OriginalsExported.ArchiveDisposition.ARCHIVE_DISPOSITION_UNAVAILABLE,
            OriginalsExported.Status.STATUS_NONE_HERE,
        )
    val baseUri = if (row.video) {
        MediaStore.Video.Media.EXTERNAL_CONTENT_URI
    } else {
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    }
    val uri = ContentUris.withAppendedId(baseUri, row.id)
    val stream = try {
        withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri) }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: SecurityException) {
        null
    } catch (_: Exception) {
        return archiveResult(
            OriginalsExported.ArchiveDisposition.ARCHIVE_DISPOSITION_UNREADABLE,
            OriginalsExported.Status.STATUS_FAILED,
        )
    } ?: return archiveResult(
        OriginalsExported.ArchiveDisposition.ARCHIVE_DISPOSITION_UNAVAILABLE,
        OriginalsExported.Status.STATUS_NONE_HERE,
    )

    val outcome = stream.use { input ->
        Stage.stage(
            core = core,
            mediaType = export.export_media_type.ifEmpty { "application/octet-stream" },
            byteSize = export.export_byte_size,
            archiveJobId = export.export_job_id,
            archivePhotoId = export.export_photo_id,
            archiveHash = export.export_content_hash,
            read = Stage.slices(input),
        )
    }
    return when (outcome) {
        is Stage.Outcome.Staged -> archiveResult(
            OriginalsExported.ArchiveDisposition.ARCHIVE_DISPOSITION_STAGED,
            OriginalsExported.Status.STATUS_DONE,
            handed = 1,
            stageId = outcome.handle.export_stage_id,
        )
        is Stage.Outcome.Refused -> archiveResult(
            OriginalsExported.ArchiveDisposition.ARCHIVE_DISPOSITION_UNREADABLE,
            if (outcome.full) OriginalsExported.Status.STATUS_STORAGE_FULL else OriginalsExported.Status.STATUS_FAILED,
        )
    }
}

private fun archiveResult(
    disposition: OriginalsExported.ArchiveDisposition,
    status: OriginalsExported.Status,
    handed: Int = 0,
    stageId: String = "",
): EffectResult = EffectResult(
    originals_exported = OriginalsExported(
        status = status,
        handed = handed,
        missing = if (disposition == OriginalsExported.ArchiveDisposition.ARCHIVE_DISPOSITION_STAGED) 0 else 1,
        archive_disposition = disposition,
        archive_stage_id = stageId,
    ),
)

private data class LocatedOriginal(
    val file: File,
    val mediaType: String,
    val isVideo: Boolean,
)

private data class LocatedBatch(
    val originals: List<LocatedOriginal>,
    val missing: Int,
)

private suspend fun locateOriginals(
    context: Context,
    core: CentraidCore,
    photoIds: List<String>,
): LocatedBatch {
    val ids = photoIds.filter { it.isNotEmpty() }.distinct()
    if (ids.isEmpty()) return LocatedBatch(emptyList(), 0)
    val found = mutableListOf<LocatedOriginal>()
    val scratch = File(context.cacheDir, "$BATCH_DIR/lib").apply {
        deleteRecursively()
        mkdirs()
    }
    for (chunk in ids.chunked(100)) {
        val refs = chunk.map { id -> ContentRef(content_id = id, owner_type = "photo", owner_id = id) }
        val response = when (
            val outcome = core.call(
                Envelope(request_id = 0, request = Request(content_urls = ContentUrlRequest(refs = refs))),
            )
        ) {
            is CoreOutcome.Answered -> outcome.value.response?.content_urls
            is CoreOutcome.Failed -> null
        } ?: continue
        for (url in response.urls) {
            val mime = url.media_type.ifEmpty { "image/jpeg" }
            val isVideo = mime.startsWith("video/")
            val localPath = url.path.orEmpty()
            if (localPath.isNotEmpty()) {
                val file = File(localPath)
                if (file.isFile) found.add(LocatedOriginal(file, mime, isVideo))
            } else if (url.source == ContentSource.CONTENT_SOURCE_OS_LIBRARY && url.os_ref.isNotEmpty()) {
                val row = LibraryRefs.row(url.os_ref) ?: continue
                val baseUri = if (row.video) {
                    MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                } else {
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                }
                val uri = ContentUris.withAppendedId(baseUri, row.id)
                val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime).orEmpty().ifEmpty { "bin" }
                val dest = File(scratch, "${row.id}.$ext")
                val copied = runCatching {
                    context.contentResolver.openInputStream(uri)?.use { input ->
                        dest.outputStream().use { out -> input.copyTo(out) }
                    } != null
                }.getOrDefault(false)
                if (copied) found.add(LocatedOriginal(dest, mime, isVideo))
            }
        }
    }
    return LocatedBatch(found, (ids.size - found.size).coerceAtLeast(0))
}

private fun prepareCopies(
    context: Context,
    originals: List<LocatedOriginal>,
    onStorageFull: () -> Unit,
): List<File>? {
    val folder = File(context.cacheDir, BATCH_DIR).apply {
        deleteRecursively()
        mkdirs()
    }
    val out = mutableListOf<File>()
    for ((index, item) in originals.withIndex()) {
        // Fail closed: formats ExifInterface cannot strip are never sent with location intact.
        if (item.isVideo) return null
        val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(item.mediaType).orEmpty().ifEmpty { "jpg" }
        val target = File(folder, "Photo ${index + 1}.$ext")
        try {
            item.file.copyTo(target, overwrite = true)
            val exif = ExifInterface(target.absolutePath)
            for (tag in GPS_TAGS) exif.setAttribute(tag, null)
            exif.saveAttributes()
            out.add(target)
        } catch (error: Exception) {
            if (error.writeFailureReason(EffectReason.FAILED) == EffectReason.STORAGE_FULL) onStorageFull()
            folder.deleteRecursively()
            return null
        }
    }
    return out
}

private fun saveToLibrary(
    context: Context,
    originals: List<LocatedOriginal>,
    onStorageFull: () -> Unit,
): Int {
    val resolver = context.contentResolver
    var saved = 0
    for ((index, item) in originals.withIndex()) {
        val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(item.mediaType).orEmpty()
        val stem = if (item.isVideo) "Video" else "Photo"
        val name = if (ext.isEmpty()) "$stem ${index + 1}" else "$stem ${index + 1}.$ext"
        val collection = if (item.isVideo) {
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        } else {
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, item.mediaType)
        }
        try {
            val dest = resolver.insert(collection, values) ?: return -1
            resolver.openOutputStream(dest)?.use { output ->
                item.file.inputStream().use { input -> input.copyTo(output) }
            } ?: return -1
            saved += 1
        } catch (error: Exception) {
            if (error.writeFailureReason(EffectReason.FAILED) == EffectReason.STORAGE_FULL) onStorageFull()
            return -1
        }
    }
    return saved
}

private val GPS_TAGS = arrayOf(
    ExifInterface.TAG_GPS_ALTITUDE,
    ExifInterface.TAG_GPS_ALTITUDE_REF,
    ExifInterface.TAG_GPS_AREA_INFORMATION,
    ExifInterface.TAG_GPS_DATESTAMP,
    ExifInterface.TAG_GPS_DEST_BEARING,
    ExifInterface.TAG_GPS_DEST_BEARING_REF,
    ExifInterface.TAG_GPS_DEST_DISTANCE,
    ExifInterface.TAG_GPS_DEST_DISTANCE_REF,
    ExifInterface.TAG_GPS_DEST_LATITUDE,
    ExifInterface.TAG_GPS_DEST_LATITUDE_REF,
    ExifInterface.TAG_GPS_DEST_LONGITUDE,
    ExifInterface.TAG_GPS_DEST_LONGITUDE_REF,
    ExifInterface.TAG_GPS_DIFFERENTIAL,
    ExifInterface.TAG_GPS_DOP,
    ExifInterface.TAG_GPS_IMG_DIRECTION,
    ExifInterface.TAG_GPS_IMG_DIRECTION_REF,
    ExifInterface.TAG_GPS_LATITUDE,
    ExifInterface.TAG_GPS_LATITUDE_REF,
    ExifInterface.TAG_GPS_LONGITUDE,
    ExifInterface.TAG_GPS_LONGITUDE_REF,
    ExifInterface.TAG_GPS_MAP_DATUM,
    ExifInterface.TAG_GPS_MEASURE_MODE,
    ExifInterface.TAG_GPS_PROCESSING_METHOD,
    ExifInterface.TAG_GPS_SATELLITES,
    ExifInterface.TAG_GPS_SPEED,
    ExifInterface.TAG_GPS_SPEED_REF,
    ExifInterface.TAG_GPS_STATUS,
    ExifInterface.TAG_GPS_TIMESTAMP,
    ExifInterface.TAG_GPS_TRACK,
    ExifInterface.TAG_GPS_TRACK_REF,
    ExifInterface.TAG_GPS_VERSION_ID,
)
