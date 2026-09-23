package dev.centraid.android.screens

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.ExifInterface
import android.os.Build
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import dev.centraid.shared.apps.photos.CopyExportScreen
import dev.centraid.shared.apps.photos.LocatedOriginal
import dev.centraid.shared.apps.photos.ShelfCopies
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** What a shelf asked the shell to do with its pick's originals. */
public sealed interface ShelfExport {
    /** The share sheet. `keepLocation` false takes the place out of every file first. */
    public data class Send(val keepLocation: Boolean) : ShelfExport

    /** This device's own photos, bytes as they are. */
    public data object Save : ShelfExport
}

/**
 * A COPY OF A PICK, HANDED TO THE PLATFORM (#1029, the photos port) — a
 * shelf's selection or the library's, whichever [CopyExportScreen] asked.
 *
 * "Send a copy" puts copies of the originals in the system share sheet;
 * "Download original" puts them in this device's own photos. Neither writes to
 * the vault, so neither is a reducer's business: `ShelfCopies.kt` finds the
 * originals and owns every sentence, this file does what only Android can —
 * the files, the chooser, `MediaStore` — and the result comes back through
 * [CopyExportScreen.exportSettled] as the one clause that screen shows.
 *
 * **THE LOCATION IS TAKEN OUT OF THE BYTES, OR NOTHING IS SENT** (#816). A
 * place left out of the words while the file carries its coordinates discloses
 * it anyway. A photograph's GPS tags are cleared in place on the COPY with
 * `ExifInterface` — no re-encode, so capture time and orientation survive — and
 * a format `ExifInterface` cannot rewrite (HEIF, a video) stops the whole send
 * with `ShelfCopies.LOCATION_NOT_REMOVABLE` rather than going out whole.
 *
 * The copies live under `cacheDir/shared-copies/batch` — inside the one folder
 * the lightbox's `FileProvider` serves (`PhotoHandOff`, `res/xml/
 * shared_copies.xml`), in a subfolder of their own so neither hand-off clears
 * the other's — and each send clears the previous send's: they are plaintext
 * outside the vault, and a chooser does not say when it is done.
 *
 * The SwiftUI twin is `ShelfCopyExport.swift`; the two are kept in step by hand.
 */
public suspend fun exportShelfCopies(
    context: Context,
    bridge: CopyExportScreen,
    assetIds: List<String>,
    export: ShelfExport,
) {
    val located = kotlinx.coroutines.suspendCancellableCoroutine { done ->
        bridge.locateOriginals(assetIds) { done.resumeWith(Result.success(it)) }
    }
    if (located.originals.isEmpty()) {
        bridge.exportSettled(ShelfCopies.NONE_HERE)
        return
    }
    when (export) {
        is ShelfExport.Send -> {
            val files = withContext(Dispatchers.IO) { prepare(context, located.originals, export.keepLocation) }
            if (files == null) {
                bridge.exportSettled(ShelfCopies.LOCATION_NOT_REMOVABLE)
                return
            }
            val authority = context.packageName + COPIES_AUTHORITY_SUFFIX
            val uris = ArrayList(files.map { FileProvider.getUriForFile(context, authority, it) })
            val send = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
                type = if (located.originals.all { it.isVideo }) "video/*" else if (located.originals.none { it.isVideo }) "image/*" else "*/*"
                putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(
                Intent.createChooser(send, "Send a copy").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            // THE CHOOSER SAYS WHAT IT DID; this says only what did not go.
            bridge.exportSettled(ShelfCopies.missingSentence(located.missing))
        }

        ShelfExport.Save -> {
            val saved = withContext(Dispatchers.IO) { saveToPhotos(context, located.originals) }
            bridge.exportSettled(
                if (saved < 0) {
                    ShelfCopies.EXPORT_FAILED_SENTENCE
                } else {
                    ShelfCopies.savedSentence(saved, located.missing)
                },
            )
        }
    }
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
    val stem = if (original.isVideo) "Video" else "Photo"
    val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(original.mediaType)
        ?: if (original.isVideo) "mp4" else "jpg"
    return "$stem ${index + 1}.$ext"
}
