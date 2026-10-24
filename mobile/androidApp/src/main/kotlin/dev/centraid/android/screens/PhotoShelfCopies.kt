package dev.centraid.android.screens

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
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectResult
import centraid.core.v1.Envelope
import centraid.core.v1.ExportOriginals
import centraid.core.v1.LoadRequest
import centraid.core.v1.OriginalsExported
import centraid.core.v1.Request
import centraid.core.v1.Value
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.design.copy.PhotosCopy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * THE ORIGINALS OF A PICK, HANDED TO THE PLATFORM (#1135): the generic
 * `ExportOriginals` performer. "Send a copy" puts copies in the system share
 * sheet; "Download original" puts them in this device's own photos. Neither
 * writes to the vault. Rust (`photos/shelf.rs`) asks for it with the photograph
 * ids, owns every sentence and reads the closed [OriginalsExported] this answers;
 * this file does what only Android can — find each original on this phone, take
 * the place out of the bytes, the chooser, `MediaStore`.
 *
 * **HOW AN ORIGINAL IS FOUND.** Two trips through the core's one door: `photos.photo`
 * for each photograph's content item, then the byte door ([ContentUrlRequest]) for
 * where those bytes are on this device. A photograph whose original is not here
 * is counted in `missing` rather than silently dropped.
 *
 * **THE LOCATION IS TAKEN OUT OF THE BYTES, OR NOTHING IS SENT** (#816). A place
 * left out of the words while the file carries its coordinates discloses it
 * anyway. A photograph's GPS tags are cleared in place on the COPY with
 * `ExifInterface` — no re-encode, so capture time and orientation survive — and a
 * format `ExifInterface` cannot rewrite (HEIF, a video) stops the whole send
 * with `STATUS_LOCATION_NOT_REMOVABLE` rather than going out whole.
 *
 * The copies live under `cacheDir/shared-copies/batch`, inside the one folder
 * the lightbox's `FileProvider` serves (`res/xml/shared_copies.xml`), and each
 * send clears the previous send's: they are plaintext outside the vault, and a
 * chooser does not say when it is done.
 *
 * The SwiftUI twin is `ShelfCopyExport.swift`.
 */
internal suspend fun performExportOriginals(
    context: Context,
    core: CentraidCore,
    export: ExportOriginals,
): EffectResult {
    val located = locateOriginals(core, export.photo_ids)
    val missing = located.missing
    fun exported(status: OriginalsExported.Status, handed: Int = 0) = EffectResult(
        originals_exported = OriginalsExported(status = status, handed = handed, missing = missing),
    )
    if (located.originals.isEmpty()) return exported(OriginalsExported.Status.STATUS_NONE_HERE)
    return when (export.mode) {
        ExportOriginals.Mode.MODE_SEND -> {
            val files = withContext(Dispatchers.IO) { prepare(context, located.originals, export.keep_location) }
                ?: return exported(OriginalsExported.Status.STATUS_LOCATION_NOT_REMOVABLE)
            val authority = context.packageName + COPIES_AUTHORITY_SUFFIX
            val uris = ArrayList(files.map { FileProvider.getUriForFile(context, authority, it) })
            val send = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
                type = if (located.originals.all { it.isVideo }) "video/*" else if (located.originals.none { it.isVideo }) "image/*" else "*/*"
                putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(
                Intent.createChooser(send, PhotosCopy.PHOTOS_SEND_COPY).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            exported(OriginalsExported.Status.STATUS_DONE, files.size)
        }

        ExportOriginals.Mode.MODE_SAVE -> {
            val saved = withContext(Dispatchers.IO) { saveToPhotos(context, located.originals) }
            if (saved < 0) {
                exported(OriginalsExported.Status.STATUS_FAILED)
            } else {
                exported(OriginalsExported.Status.STATUS_DONE, saved)
            }
        }

        else -> EffectResult(failed = EffectFailed(reason = "no export mode"))
    }
}

/** One original this device holds, located for a platform hand-off. */
internal data class LocatedOriginal(
    val assetId: String,
    val path: String,
    val mediaType: String,
    val isVideo: Boolean,
)

/** What [locateOriginals] found, and how many of the pick it did not. */
internal data class Located(val originals: List<LocatedOriginal>, val missing: Int)

/** `ContentUrlRequest`'s own ceiling (`MAX_CONTENT_URLS`), asked in slices. */
private const val URL_BATCH: Int = 100

/** WHERE EACH PICKED ORIGINAL IS ON THIS DEVICE, in the pick's order, and how many are not here. */
private suspend fun locateOriginals(core: CentraidCore, photoIds: List<String>): Located {
    val ids = photoIds.filter { it.isNotEmpty() }.distinct()
    // The content item and the form of each photograph, from the one read.
    val known = LinkedHashMap<String, Pair<String, Boolean>>()
    for (id in ids) {
        val outcome = core.call(
            Envelope(
                request = Request(
                    load = LoadRequest(app = "photos", query = "photo", params = mapOf("id" to Value(text = id))),
                ),
            ),
        )
        val cell = (outcome as? CoreOutcome.Answered)?.value?.response?.load?.answer?.photos_photo?.photo?.cell
        if (cell != null && cell.content_id.isNotEmpty()) known[id] = cell.content_id to (cell.form == "video")
    }
    val found = mutableListOf<LocatedOriginal>()
    known.keys.chunked(URL_BATCH).forEach { slice ->
        val refs = slice.map { id ->
            ContentRef(content_id = known.getValue(id).first, owner_type = "photo", owner_id = id)
        }
        val outcome = core.call(Envelope(request = Request(content_urls = ContentUrlRequest(refs = refs))))
        val urls = (outcome as? CoreOutcome.Answered)?.value?.response?.content_urls?.urls.orEmpty()
        // ONE ANSWER PER REF, IN ORDER (`ContentUrls`' own rule), so the zip is by
        // position and a short answer pairs nothing wrongly.
        slice.forEachIndexed { index, id ->
            val url = urls.getOrNull(index)
            val path = url?.path
            if (url != null && url.content_id == refs[index].content_id && !path.isNullOrEmpty()) {
                found += LocatedOriginal(
                    assetId = id,
                    path = path,
                    mediaType = url.media_type,
                    isVideo = known.getValue(id).second,
                )
            }
        }
    }
    return Located(found, ids.size - found.size)
}

/** `<applicationId>.photocopies` — the manifest's one `FileProvider`, `PhotoHandOff`'s. */
private const val COPIES_AUTHORITY_SUFFIX: String = ".photocopies"

/** Under `shared_copies.xml`'s `shared-copies/`, in the batch's own subfolder. */
private const val COPIES_FOLDER: String = "shared-copies/batch"

/**
 * Copies under [COPIES_FOLDER], named by type, the location taken out unless
 * the member kept it. Null when a file's location could not be taken out.
 */
private fun prepare(context: Context, originals: List<LocatedOriginal>, keepLocation: Boolean): List<File>? {
    val folder = File(context.cacheDir, COPIES_FOLDER)
    folder.deleteRecursively()
    folder.mkdirs()
    return originals.mapIndexed { index, original ->
        val target = File(folder, fileName(original, index))
        val copied = runCatching { File(original.path).copyTo(target, overwrite = true) }.isSuccess
        if (!copied) return null
        if (!keepLocation && !stripLocation(target, original)) return null
        target
    }
}

/**
 * THE GPS TAGS, CLEARED ON THE COPY. `ExifInterface` rewrites JPEG, PNG and
 * WebP in place; anything else — HEIF, every video — cannot be cleaned here,
 * so it is refused rather than sent whole.
 */
private fun stripLocation(file: File, original: LocatedOriginal): Boolean {
    if (original.isVideo) return false
    val type = original.mediaType.lowercase()
    if (type != "image/jpeg" && type != "image/png" && type != "image/webp") return false
    return runCatching {
        val exif = ExifInterface(file.absolutePath)
        GPS_TAGS.forEach { tag -> exif.setAttribute(tag, null) }
        exif.saveAttributes()
    }.isSuccess
}

private val GPS_TAGS: List<String> = listOf(
    ExifInterface.TAG_GPS_LATITUDE,
    ExifInterface.TAG_GPS_LATITUDE_REF,
    ExifInterface.TAG_GPS_LONGITUDE,
    ExifInterface.TAG_GPS_LONGITUDE_REF,
    ExifInterface.TAG_GPS_ALTITUDE,
    ExifInterface.TAG_GPS_ALTITUDE_REF,
    ExifInterface.TAG_GPS_TIMESTAMP,
    ExifInterface.TAG_GPS_DATESTAMP,
    ExifInterface.TAG_GPS_PROCESSING_METHOD,
    ExifInterface.TAG_GPS_AREA_INFORMATION,
    ExifInterface.TAG_GPS_DEST_LATITUDE,
    ExifInterface.TAG_GPS_DEST_LATITUDE_REF,
    ExifInterface.TAG_GPS_DEST_LONGITUDE,
    ExifInterface.TAG_GPS_DEST_LONGITUDE_REF,
    ExifInterface.TAG_GPS_IMG_DIRECTION,
    ExifInterface.TAG_GPS_IMG_DIRECTION_REF,
    ExifInterface.TAG_GPS_SPEED,
    ExifInterface.TAG_GPS_SPEED_REF,
    ExifInterface.TAG_GPS_TRACK,
    ExifInterface.TAG_GPS_TRACK_REF,
)

/**
 * Into this device's photos, under `Pictures/Centraid` or `Movies/Centraid`.
 * The count saved, or -1 when the store refused.
 *
 * **ANDROID 10 AND LATER.** Before it, `MediaStore` wants
 * `WRITE_EXTERNAL_STORAGE`, a runtime grant this app does not ask for; on
 * those devices the save is refused with the export-failed sentence rather
 * than a permission prompt nothing else in Photos needs.
 */
private fun saveToPhotos(context: Context, originals: List<LocatedOriginal>): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return -1
    val resolver = context.contentResolver
    var saved = 0
    originals.forEachIndexed { index, original ->
        val collection = if (original.isVideo) {
            MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        } else {
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, fileName(original, index))
            put(MediaStore.MediaColumns.MIME_TYPE, original.mediaType.ifEmpty { if (original.isVideo) "video/mp4" else "image/jpeg" })
            put(MediaStore.MediaColumns.RELATIVE_PATH, if (original.isVideo) "Movies/Centraid" else "Pictures/Centraid")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values) ?: return -1
        val written = runCatching {
            resolver.openOutputStream(uri)?.use { out -> File(original.path).inputStream().use { it.copyTo(out) } }
        }.getOrNull() != null
        if (!written) {
            resolver.delete(uri, null, null)
            return -1
        }
        resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        saved += 1
    }
    return saved
}

/** `Photo 1.jpg`, `Video 2.mp4` — the extension from the media type the byte door reported. */
private fun fileName(original: LocatedOriginal, index: Int): String {
    val stem = if (original.isVideo) PhotosCopy.PHOTOS_CELL_VIDEO else PhotosCopy.PHOTOGRAPH
    val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(original.mediaType)
        ?: if (original.isVideo) "mp4" else "jpg"
    return "$stem ${index + 1}.$ext"
}
