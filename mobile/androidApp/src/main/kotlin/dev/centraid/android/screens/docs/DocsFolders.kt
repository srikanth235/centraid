package dev.centraid.android.screens.docs

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import dev.centraid.shared.apps.docs.FilesImport
import dev.centraid.shared.apps.docs.FilesRead
import dev.centraid.shared.apps.docs.FilesReader
import dev.centraid.shared.apps.docs.PhoneFile
import dev.centraid.shared.apps.docs.PhoneFileBytes
import dev.centraid.shared.sync.phone.PhoneOriginRef
import java.io.InputStream

/**
 * THE ACCESS THE MEMBER GAVE TO THE FOLDERS DOCS FOLLOWS (#1127, R-1127-7), Android's half.
 *
 * Kept by the SHELL, never the vault: the tree URI the Storage Access Framework returned, with the
 * persisted read grant (`takePersistableUriPermission`), under the folder's origin id
 * (`folder:<uuid>`) in the app's own preferences. The vault holds only the origin and its links.
 * Only the member's "Follow a folder" tap opens the system picker; a following pass reads over
 * grants that already exist and never asks.
 */
internal object FolderAccess {
    private const val PREFS = "docs.folders"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Keep [tree] (the picker's result) under [origin], with the grant that survives a restart. */
    fun remember(context: Context, origin: String, tree: Uri): Boolean {
        return try {
            context.contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            prefs(context).edit().putString(origin, tree.toString()).apply()
            true
        } catch (why: SecurityException) {
            false
        }
    }

    /** The tree [origin] names, or null when the shell holds no grant for it any more (revoked, cleared): the folder is gone. */
    fun tree(context: Context, origin: String): Uri? {
        val tree = prefs(context).getString(origin, null)?.let(Uri::parse) ?: return null
        val held = context.contentResolver.persistedUriPermissions.any { it.uri == tree && it.isReadPermission }
        return tree.takeIf { held }
    }

    /** The origin already following [tree]: picking a folder twice is not a second origin. */
    fun following(context: Context, tree: Uri): String? =
        prefs(context).all.entries.firstOrNull { it.value == tree.toString() }?.key

    /** The member stopped following [origin], or a pick was refused: the grant and the record go. */
    fun forget(context: Context, origin: String) {
        val tree = prefs(context).getString(origin, null)?.let(Uri::parse)
        prefs(context).edit().remove(origin).apply()
        // A grant another origin still names (the same tree picked twice cannot happen, see [following]) is kept.
        if (tree != null && prefs(context).all.values.none { it == tree.toString() }) {
            runCatching {
                context.contentResolver.releasePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
    }

    /** A folder's name as its provider shows it, or empty when the provider will not say. */
    fun name(context: Context, tree: Uri): String = runCatching {
        val root = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        context.contentResolver.query(root, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0).orEmpty() else ""
        }.orEmpty()
    }.getOrDefault("")
}

/** A file's bytes from the provider's stream. */
private class StreamBytes(private val input: InputStream) : PhoneFileBytes {
    override fun read(max: Int): ByteArray {
        val buffer = ByteArray(max)
        val count = input.read(buffer)
        return if (count <= 0) ByteArray(0) else buffer.copyOf(count)
    }

    override fun close() {
        runCatching { input.close() }
    }
}

/**
 * THE FOLLOWER'S FOLDER READER (#1127): a LISTING of every followed folder, over the grants the
 * member already gave, with `DocumentsContract` (children queried one directory at a time, no
 * `DocumentFile` and no bytes). Called off the main thread by [dev.centraid.android.kit.AndroidPhoneFollow].
 *
 * - **A folder with no grant, or whose root the provider will not answer for, is left out of
 *   `origins`**: the shared engine takes it for gone and asks (R-1127-9).
 * - **A directory the provider would not list makes the read incomplete**, so nothing is trashed
 *   or held because of it (R-1127-3).
 * - Hidden names (a leading `.`), virtual documents (a Google Doc with no bytes) and files whose
 *   provider states no size are skipped.
 */
internal class AndroidFolderReader(private val context: Context) : FilesReader {
    override fun read(followed: List<String>, deliver: (FilesRead?) -> Unit) {
        val files = mutableListOf<PhoneFile>()
        val origins = mutableListOf<PhoneOriginRef>()
        var complete = true
        for (origin in followed) {
            val tree = FolderAccess.tree(context, origin) ?: continue
            val name = FolderAccess.name(context, tree)
            if (name.isEmpty()) continue
            origins += FilesImport.folder(origin, name)
            if (!walk(origin, tree, files)) complete = false
        }
        deliver(FilesRead(files, origins, complete))
    }

    /** Every file under [tree], breadth-first. False when a directory could not be listed. */
    private fun walk(origin: String, tree: Uri, into: MutableList<PhoneFile>): Boolean {
        var complete = true
        val pending = ArrayDeque<Pair<String, String>>()
        pending.add(DocumentsContract.getTreeDocumentId(tree) to "")
        while (pending.isNotEmpty()) {
            val (documentId, prefix) = pending.removeFirst()
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId)
            val cursor = try {
                context.contentResolver.query(children, COLUMNS, null, null, null)
            } catch (why: Exception) {
                null
            }
            if (cursor == null) {
                complete = false
                continue
            }
            cursor.use {
                while (it.moveToNext()) {
                    val id = it.getString(0) ?: continue
                    val name = it.getString(1).orEmpty()
                    val mime = it.getString(2).orEmpty()
                    val flags = it.getInt(5)
                    if (name.isEmpty() || name.startsWith(".")) continue
                    val path = prefix + name
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        pending.add(id to "$path/")
                        continue
                    }
                    val virtual = flags and DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT != 0
                    if (virtual || it.isNull(3)) continue
                    val uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)
                    into += PhoneFile(
                        origin = origin,
                        path = path,
                        size = it.getLong(3),
                        modifiedMs = if (it.isNull(4)) 0L else it.getLong(4),
                        mediaType = mime.takeUnless { type -> type == OCTET_STREAM }.orEmpty(),
                        open = { open(uri) },
                    )
                }
            }
        }
        return complete
    }

    private fun open(uri: Uri): PhoneFileBytes? = try {
        context.contentResolver.openInputStream(uri)?.let(::StreamBytes)
    } catch (why: Exception) {
        null
    }

    private companion object {
        const val OCTET_STREAM = "application/octet-stream"
        val COLUMNS = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            DocumentsContract.Document.COLUMN_FLAGS,
        )
    }
}
