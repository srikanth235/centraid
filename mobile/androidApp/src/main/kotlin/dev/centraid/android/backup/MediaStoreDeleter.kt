package dev.centraid.android.backup

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentResolver
import android.content.ContentUris
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import dev.centraid.shared.sync.DeleteCapability
import dev.centraid.shared.sync.DeleteOutcome
import dev.centraid.shared.sync.LibraryDeleter
import dev.centraid.shared.sync.ReleasableItem
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * FREE UP SPACE'S HAND ON MEDIASTORE (#1080 A19, A20).
 *
 * The core never deletes from the library; this class is the one place on
 * Android that does, and only behind the system's own confirmation:
 * `MediaStore.createDeleteRequest` (API 30 and up) answers a `PendingIntent`
 * whose dialog counts what goes and deletes on a yes. Below API 30 that verb
 * does not exist — API 29 asks once per item and API 28 and below not at all —
 * so [capability] answers `NONE` there and the More sheet draws no row
 * (`minSdk` is an owner question, `docs/release/v1-handoffs.md` PH4).
 *
 * **One per activity.** The dialog's answer comes back through an activity
 * result launcher, which must be registered before the activity starts — so
 * `MainActivity` builds this as a field, installs it on the session when the
 * session opens (`HomeSession.installLibraryDeleter`) and clears it when the
 * activity goes, and a rotation never leaves a destroyed activity holding the
 * member's answer. A request in flight across a rotation is kept by the
 * process ([Waiting]), because the result is delivered to the NEW activity's
 * launcher, registered under the same key.
 *
 * Three rules, each with its reason:
 *
 * 1. **The collection is the item's media type** (A20): `video/…` names
 *    `MediaStore.Video`, anything else `MediaStore.Images`. A ref whose walker
 *    prefix (`image:` / `video:`) names the other collection is skipped, never
 *    guessed at.
 * 2. **A row that changed since it was backed up is kept.** The store's `SIZE`
 *    must equal the size the core backed up; an item edited in place, or a row
 *    the store no longer has, is left out of the request.
 * 3. **What is reported is what the request removed.** On a yes each asked row
 *    is looked up again, and only a row the store no longer answers for is
 *    reported deleted. The member's no is `declined`; anything else is `error`.
 */
internal class MediaStoreDeleter(private val activity: ComponentActivity) : LibraryDeleter {
    // READ AT FIRST USE, NOT AT CONSTRUCTION: this is built while its activity
    // is constructed, before it has a context, and only the launcher below may
    // be made that early.
    private val resolver: ContentResolver by lazy { activity.applicationContext.contentResolver }
    private val main = Handler(Looper.getMainLooper())

    private val launcher: ActivityResultLauncher<IntentSenderRequest> =
        activity.registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
            answered(result.resultCode == Activity.RESULT_OK)
        }

    override fun capability(): DeleteCapability =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) DeleteCapability.SYSTEM_CONFIRMATION else DeleteCapability.NONE

    override fun delete(items: List<ReleasableItem>, done: (DeleteOutcome) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            done(NOTHING)
            return
        }
        // THE STORE IS READ OFF THE MAIN THREAD; the dialog is launched on it.
        io.execute { ask(items, done) }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun ask(items: List<ReleasableItem>, done: (DeleteOutcome) -> Unit) {
        val asked = items.mapNotNull { item ->
            val uri = uriOf(item) ?: return@mapNotNull null
            // RULE 2.
            if (sizeOf(uri) != item.size) null else item to uri
        }
        // NOTHING TO ASK ABOUT asks nothing: no dialog for zero items.
        if (asked.isEmpty()) {
            done(NOTHING)
            return
        }
        val request = try {
            MediaStore.createDeleteRequest(resolver, asked.map { it.second })
        } catch (refused: IllegalArgumentException) {
            done(failed(refused))
            return
        } catch (refused: SecurityException) {
            done(failed(refused))
            return
        }
        main.post {
            Waiting.replace(Waiting(asked, done))
            try {
                launcher.launch(IntentSenderRequest.Builder(request.intentSender).build())
            } catch (gone: ActivityNotFoundException) {
                Waiting.take()?.done?.invoke(failed(gone))
            } catch (gone: IllegalStateException) {
                // The launcher's activity is gone: nothing was asked.
                Waiting.take()?.done?.invoke(failed(gone))
            }
        }
    }

    /** The dialog answered, on the main thread. */
    private fun answered(yes: Boolean) {
        val waiting = Waiting.take() ?: return
        if (!yes) {
            waiting.done(DeleteOutcome(deleted = emptyList(), declined = true, error = null))
            return
        }
        io.execute {
            // RULE 3.
            val gone = waiting.asked.filter { (_, uri) -> !exists(uri) }.map { (item, _) -> item.contentHash }
            waiting.done(DeleteOutcome(deleted = gone, declined = false, error = null))
        }
    }

    /** RULE 1. Null when the ref names no row, or names the other collection. */
    private fun uriOf(item: ReleasableItem): Uri? {
        val video = item.mediaType.startsWith("video/")
        val ref = item.osRef
        if (ref.startsWith(VIDEO_REF) && !video) return null
        if (ref.startsWith(IMAGE_REF) && video) return null
        val id = ref.removePrefix(VIDEO_REF).removePrefix(IMAGE_REF).toLongOrNull() ?: return null
        val base = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        return ContentUris.withAppendedId(base, id)
    }

    /** The store's own size for a row, or null when it answers nothing for it. */
    private fun sizeOf(uri: Uri): Long? = try {
        resolver.query(uri, arrayOf(MediaStore.MediaColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null
        }
    } catch (refused: SecurityException) {
        null
    }

    /** Whether the store still answers for a row. A refusal reads as "still there". */
    private fun exists(uri: Uri): Boolean = try {
        resolver.query(uri, arrayOf(MediaStore.MediaColumns._ID), null, null, null)?.use { it.moveToFirst() } ?: false
    } catch (refused: SecurityException) {
        true
    }

    private fun failed(error: Exception): DeleteOutcome =
        DeleteOutcome(deleted = emptyList(), declined = false, error = error.message ?: error.javaClass.simpleName)

    /**
     * THE REQUEST IN FLIGHT, kept by the process and touched on the main
     * thread only. A second request answers the first with nothing, so each
     * `done` is called exactly once.
     */
    private class Waiting(
        val asked: List<Pair<ReleasableItem, Uri>>,
        val done: (DeleteOutcome) -> Unit,
    ) {
        companion object {
            private var current: Waiting? = null

            fun replace(next: Waiting) {
                current?.done?.invoke(NOTHING)
                current = next
            }

            fun take(): Waiting? = current.also { current = null }
        }
    }

    private companion object {
        /** The walker's prefixes (`AndroidMediaLibrary`): what a ref says its collection is. */
        const val IMAGE_REF = "image:"
        const val VIDEO_REF = "video:"

        val NOTHING = DeleteOutcome(deleted = emptyList(), declined = false, error = null)

        /** One thread for the store's reads, shared by every activity's deleter. */
        val io: Executor = Executors.newSingleThreadExecutor { work ->
            Thread(work, "centraid-library-delete").apply { isDaemon = true }
        }
    }
}
