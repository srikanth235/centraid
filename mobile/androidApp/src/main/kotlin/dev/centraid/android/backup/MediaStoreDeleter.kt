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
import centraid.core.v1.LibraryDeleteItem
import centraid.core.v1.LibraryDeleted
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
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
 * so [offered] is false there and the More sheet draws no row
 * (`minSdk` is an owner question, `docs/release/v1-handoffs.md` PH4).
 *
 * **One per activity.** The dialog's answer comes back through an activity
 * result launcher, which must be registered before the activity starts — so
 * `MainActivity` builds this as a field and its effects host performs Rust's
 * `LibraryDelete` with it (`kit/ScreenEffects.kt`), and a rotation never leaves a
 * destroyed activity holding the member's answer. Which originals are safe to
 * free, and what the member reads, are Rust's (`photos::free_up`). A request in flight across a rotation is kept by the
 * process ([Waiting]), because the result is delivered to the NEW activity's
 * launcher, registered under the same key.
 *
 * Three rules, each with its reason, decided by [LibraryDeletion] (the pure
 * half, unit-tested) and read off the store here: the collection is the item's
 * media type; a row that changed since it was backed up (its `SIZE` is not
 * `LibraryDeleteItem.size`) or that the store no longer has is kept; and what is
 * reported is what the request removed, the member's no being `declined` and
 * anything else `error`.
 */
internal class MediaStoreDeleter(private val activity: ComponentActivity) {
    // READ AT FIRST USE, NOT AT CONSTRUCTION: this is built while its activity
    // is constructed, before it has a context, and only the launcher below may
    // be made that early.
    private val resolver: ContentResolver by lazy { activity.applicationContext.contentResolver }
    private val main = Handler(Looper.getMainLooper())

    private val launcher: ActivityResultLauncher<IntentSenderRequest> =
        activity.registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
            answered(result.resultCode == Activity.RESULT_OK)
        }

    /** Whether this platform deletes behind the system's own confirmation (API 30 and up). */
    val offered: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

    fun delete(items: List<LibraryDeleteItem>, done: (LibraryDeleted) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            done(NOTHING)
            return
        }
        // THE STORE IS READ OFF THE MAIN THREAD; the dialog is launched on it.
        io.execute { ask(items, done) }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun ask(items: List<LibraryDeleteItem>, done: (LibraryDeleted) -> Unit) {
        val asked = items.mapNotNull { item ->
            val uri = uriOf(item) ?: return@mapNotNull null
            // RULE 2.
            if (LibraryDeletion.unchanged(sizeOf(uri), item.size)) item to uri else null
        }
        // NOTHING TO ASK ABOUT asks nothing: no dialog for zero items.
        if (asked.isEmpty()) {
            done(NOTHING)
            return
        }
        val request = try {
            MediaStore.createDeleteRequest(resolver, asked.map { it.second })
        } catch (refused: IllegalArgumentException) {
            done(LibraryDeletion.failed(refused))
            return
        } catch (refused: SecurityException) {
            done(LibraryDeletion.failed(refused))
            return
        }
        main.post {
            Waiting.replace(Waiting(asked, done))
            try {
                launcher.launch(IntentSenderRequest.Builder(request.intentSender).build())
            } catch (gone: ActivityNotFoundException) {
                Waiting.take()?.done?.invoke(LibraryDeletion.failed(gone))
            } catch (gone: IllegalStateException) {
                // The launcher's activity is gone: nothing was asked.
                Waiting.take()?.done?.invoke(LibraryDeletion.failed(gone))
            }
        }
    }

    /** The dialog answered, on the main thread. */
    private fun answered(yes: Boolean) {
        val waiting = Waiting.take() ?: return
        // RULE 3.
        val gone = { LibraryDeletion.deletedHashes(waiting.asked, { it.first.content_hash }, { exists(it.second) }) }
        if (yes) io.execute { waiting.done(LibraryDeletion.answer(true, gone)) } else waiting.done(LibraryDeletion.answer(false, gone))
    }

    /** RULE 1. Null when the ref names no row, or names the other collection. */
    private fun uriOf(item: LibraryDeleteItem): Uri? {
        val row = LibraryDeletion.target(item.media_type, item.os_ref) ?: return null
        val base = if (row.video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        return ContentUris.withAppendedId(base, row.id)
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

    /**
     * THE REQUEST IN FLIGHT, kept by the process and touched on the main
     * thread only. A second request answers the first with nothing, so each
     * `done` is called exactly once.
     */
    private class Waiting(
        val asked: List<Pair<LibraryDeleteItem, Uri>>,
        val done: (LibraryDeleted) -> Unit,
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
        val NOTHING = LibraryDeleted()

        /** One thread for the store's reads, shared by every activity's deleter. */
        val io: Executor = Executors.newSingleThreadExecutor { work ->
            Thread(work, "centraid-library-delete").apply { isDaemon = true }
        }
    }
}
