package dev.centraid.android.kit

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import centraid.core.v1.ChatEvent
import centraid.core.v1.DeleteModelFile
import centraid.core.v1.EffectDone
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectRequest
import centraid.core.v1.EffectResult
import centraid.core.v1.LibraryPhotoPicked
import centraid.core.v1.ModelDownload
import centraid.core.v1.ScreenEvent
import dev.centraid.core.Screens
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okio.ByteString.Companion.toByteString
import java.io.ByteArrayOutputStream
import java.io.File
import dev.centraid.android.screens.chat.ChatDeviceFacts
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * THE CHAT'S PLATFORM WORK (#1135, lane I): the two effects the chat screen asks that only this
 * shell can do. The assistant itself is the core's (it loads and runs a turn off this thread and
 * streams into the chat screen); nothing about it is performed here.
 *
 * * `ModelDownload`: the only thing Centraid ever fetches. Rust names the file (url, name, digest,
 *   size) and the directory; this shell moves the bytes, hashes them and keeps the file only when
 *   the digest is the one Rust named. It answers `EffectDone` at once and reports the transfer to
 *   the chat as `ChatEvent.download_progress` / `download_finished`.
 * * `PickLibraryPhoto`: the system photo picker (no permission), one image, converted to JPEG at
 *   most 1024 px on the long edge, with a small thumbnail file the composer draws.
 */
internal object ChatEffects {
    /** The transfer outlives the screen that asked: a process-wide scope, one transfer per file. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val running = ConcurrentHashMap<String, Boolean>()

    /** Whether the member allowed mobile data for the transfer into each file (#1188 download rules). */
    private val allowed = ConcurrentHashMap<String, Boolean>()

    private const val SEND_EDGE = 1024
    private const val THUMB_EDGE = 160

    /**
     * The model file the new one replaced: a name in the models folder, nothing else. The new file
     * was fetched, verified and loaded before Rust asks, and a name that is not a plain file name
     * deletes nothing.
     */
    fun deleteModelFile(asked: DeleteModelFile): EffectResult {
        val name = asked.file_name
        if (name.isEmpty() || name.contains('/') || name.contains("..")) return EffectResult(done = EffectDone())
        File(asked.models_dir, name).delete()
        return EffectResult(done = EffectDone())
    }

    /** Start the download Rust asked for; answers at once. */
    fun download(context: Context, screens: Screens, request: EffectRequest, asked: ModelDownload): EffectResult {
        val target = File(asked.models_dir, asked.file_name)
        // Mobile data was allowed for the rest of a transfer that was waiting for Wi-Fi: the one
        // that is going reads the new word at its next step and carries on from where it is.
        allowed[target.path] = asked.allow_cellular
        if (running.putIfAbsent(target.path, true) != null) return EffectResult(done = EffectDone())
        scope.launch {
            var ok = false
            while (true) {
                try {
                    ok = fetch(context, screens, request.instance, asked, target)
                    break
                } catch (held: HeldForWifi) {
                    continue
                } catch (failed: Exception) {
                    break
                }
            }
            running.remove(target.path)
            report(screens, request.instance) {
                ChatEvent(download_finished = ChatEvent.DownloadFinished(ok = ok, vision = asked.vision))
            }
        }
        return EffectResult(done = EffectDone())
    }

    private suspend fun report(screens: Screens, instance: Long, event: () -> ChatEvent) {
        screens.send(instance, ScreenEvent(chat = event()))
    }

    /** The transfer let go of its connection because the phone moved to mobile data. */
    private class HeldForWifi : Exception()

    private fun blocked(context: Context, target: File): Boolean =
        allowed[target.path] != true &&
            ChatDeviceFacts.network(context) == centraid.core.v1.ChatEvent.DeviceFacts.Network.NETWORK_CELLULAR

    /** Moves the bytes (resuming a `.part` file), hashes them, and renames on a match. */
    private suspend fun fetch(context: Context, screens: Screens, instance: Long, asked: ModelDownload, target: File): Boolean {
        target.parentFile?.mkdirs()
        // WI-FI FIRST: without the member's word for mobile data the transfer waits for Wi-Fi, and a
        // partial file is kept to carry on from.
        suspend fun waitForWifi() {
            while (blocked(context, target)) kotlinx.coroutines.delay(5_000)
        }
        val part = File(target.path + ".part")
        // A CRASH BETWEEN THE LAST BYTE AND THE RENAME leaves a whole file under the part name: asking
        // for bytes past its end is refused for ever, so a file that is already the one Rust named is
        // kept at once, and any other partial file that is no shorter than the whole is cleared.
        if (part.exists() && part.length() > 0) {
            if (part.length() >= asked.bytes) {
                if (sha256(part) == asked.sha256) {
                    target.delete()
                    return part.renameTo(target)
                }
                part.delete()
            }
        }
        waitForWifi()
        val have = if (part.exists()) part.length() else 0L
        val connection = (URL(asked.url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 30_000
            readTimeout = 60_000
            if (have > 0) setRequestProperty("Range", "bytes=$have-")
        }
        try {
            val resumed = connection.responseCode == HttpURLConnection.HTTP_PARTIAL
            if (connection.responseCode != HttpURLConnection.HTTP_OK && !resumed) return false
            val total = if (resumed) have + connection.contentLengthLong else connection.contentLengthLong
            var done = if (resumed) have else 0L
            var reported = -1L
            connection.inputStream.use { input ->
                java.io.FileOutputStream(part, resumed).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        // Mobile data without the member's word: let go of the connection, wait for Wi-Fi
                        // and take the file up again from the bytes already kept.
                        if (blocked(context, target)) throw HeldForWifi()
                        output.write(buffer, 0, read)
                        done += read
                        // About a hundred reports, not one per buffer.
                        val step = if (total > 0) done * 100 / total else done / (1024 * 1024)
                        if (step != reported) {
                            reported = step
                            report(screens, instance) {
                                ChatEvent(
                                    download_progress = ChatEvent.DownloadProgress(
                                        done_bytes = done,
                                        total_bytes = maxOf(total, 0L),
                                        vision = asked.vision,
                                    ),
                                )
                            }
                        }
                    }
                }
            }
        } finally {
            connection.disconnect()
        }
        // KEPT ONLY WHEN IT IS THE FILE RUST NAMED: anything else is deleted.
        if (sha256(part) != asked.sha256) {
            part.delete()
            return false
        }
        target.delete()
        return part.renameTo(target)
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    // ------------------------------------------------------------ the library photo --

    /** The one photo-picker prompt that may be out, and its answer. */
    class PhotoDoor {
        private var waiting: CompletableDeferred<Uri?>? = null

        suspend fun pick(launch: () -> Unit): Uri? {
            val answer = CompletableDeferred<Uri?>()
            waiting = answer
            launch()
            return answer.await()
        }

        fun picked(uri: Uri?) {
            waiting?.complete(uri)
            waiting = null
        }
    }

    suspend fun pickLibraryPhoto(context: Context, door: PhotoDoor, launch: () -> Unit): EffectResult {
        val uri = door.pick(launch) ?: return EffectResult(library_photo_picked = LibraryPhotoPicked(cancelled = true))
        return withContext(Dispatchers.IO) {
            runCatching { prepared(context, uri) }.getOrElse {
                EffectResult(library_photo_picked = LibraryPhotoPicked(unreadable = true))
            }
        }
    }

    /** JPEG bytes (upright, bounded) and a small thumbnail file in the cache, swept with the cache. */
    private fun prepared(context: Context, uri: Uri): EffectResult {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        val longest = maxOf(bounds.outWidth, bounds.outHeight)
        if (longest <= 0) error("not an image")
        var sample = 1
        while (longest / (sample * 2) >= SEND_EDGE) sample *= 2
        val decoded = resolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
        } ?: error("not an image")
        val orientation = resolver.openInputStream(uri)?.use {
            ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } ?: ExifInterface.ORIENTATION_NORMAL
        val upright = scaled(rotated(decoded, orientation), SEND_EDGE)
        val jpeg = ByteArrayOutputStream().also { upright.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
        val directory = File(context.cacheDir, "chat-attach").apply { mkdirs() }
        val thumbnail = File(directory, UUID.randomUUID().toString() + ".jpg")
        thumbnail.outputStream().use { scaled(upright, THUMB_EDGE).compress(Bitmap.CompressFormat.JPEG, 80, it) }
        return EffectResult(
            library_photo_picked = LibraryPhotoPicked(
                content = jpeg.toByteString(),
                mime = "image/jpeg",
                thumbnail_path = thumbnail.path,
            ),
        )
    }

    /**
     * Remove the thumbnails in `cacheDir/chat-attach` that no chat on screen holds (#1188 C11): a
     * deleted chat's, a closed one's, and any a crash left. `keep` is every `thumbnail_path` the
     * state draws. A file written in the last minute stays: its path may be on its way to Rust.
     */
    fun sweepThumbnails(context: Context, keep: Set<String>, now: Long = System.currentTimeMillis()) {
        val directory = File(context.cacheDir, "chat-attach")
        directory.listFiles()?.forEach { file ->
            if (file.path !in keep && now - file.lastModified() > FRESH_MS) file.delete()
        }
    }

    private const val FRESH_MS = 60_000L

    private fun rotated(bitmap: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            else -> return bitmap
        }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    private fun scaled(bitmap: Bitmap, edge: Int): Bitmap {
        val longest = maxOf(bitmap.width, bitmap.height)
        if (longest <= edge) return bitmap
        val factor = edge.toFloat() / longest
        return Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * factor).toInt().coerceAtLeast(1),
            (bitmap.height * factor).toInt().coerceAtLeast(1),
            true,
        )
    }

    /** An EffectFailed for a refusal that has no result of its own. */
    fun failed(reason: String) = EffectResult(failed = EffectFailed(reason = reason))
}
