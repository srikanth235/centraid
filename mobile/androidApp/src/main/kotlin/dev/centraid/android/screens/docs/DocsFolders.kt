package dev.centraid.android.screens.docs

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import centraid.core.v1.FolderFile
import centraid.core.v1.FolderFileStaged
import centraid.core.v1.FolderListed
import centraid.core.v1.FoldersListing
import dev.centraid.android.session.Stage
import dev.centraid.core.CentraidCore

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

/**
 * THE FOLLOWED FOLDERS, AS `imports.files` ASKS FOR THEM (#1127; #1135): a LISTING of each folder
 * the vault follows, over the grants the member already gave, with `DocumentsContract` (children
 * queried one directory at a time, no bytes), and one file streamed through the stage door. Which
 * folders, which files are records, the stat pre-check and whether a read was whole are Rust's
 * (`crates/screens/src/imports/files.rs`).
 *
 * - **A folder with no grant, or whose root the provider will not answer for, is left out.**
 * - **A directory the provider would not list makes the listing incomplete** (R-1127-3).
 * - Hidden names (a leading `.`), virtual documents (a Google Doc with no bytes) and files whose
 *   provider states no size are not listed.
 */
internal object FolderReader {
    /** `FoldersRead`: every followed folder the shell can still open, as a listing. */
    fun list(context: Context, origins: List<String>, deviceId: String): FoldersListing {
        var complete = true
        val folders = origins.mapNotNull { origin ->
            val tree = FolderAccess.tree(context, origin) ?: return@mapNotNull null
            val label = FolderAccess.name(context, tree)
            if (label.isEmpty()) return@mapNotNull null
            val files = mutableListOf<FolderFile>()
            if (!walk(context, tree) { path, _, size, modified, mime -> files += FolderFile(path = path, size = size, modified_ms = modified, media_type = mime) }) complete = false
            FolderListed(origin = origin, label = label, files = files)
        }
        return FoldersListing(complete = complete, device_id = deviceId, folders = folders)
    }

    /** `StageFolderFile`: the file at [path] in [origin]'s folder, streamed through the stage door. */
    suspend fun stage(context: Context, core: CentraidCore, origin: String, path: String, mediaType: String): FolderFileStaged {
        val tree = FolderAccess.tree(context, origin) ?: return FolderFileStaged(ok = false)
        var found: Pair<Uri, Long>? = null
        walk(context, tree) { at, uri, size, _, _ -> if (at == path && found == null) found = uri to size }
        val (uri, size) = found ?: return FolderFileStaged(ok = false)
        val outcome = try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                Stage.stage(core, mediaType.ifEmpty { OCTET_STREAM }, size, read = Stage.slices(input))
            }
        } catch (why: Exception) {
            null
        }
        return when (outcome) {
            is Stage.Outcome.Staged ->
                FolderFileStaged(ok = true, content_hash = outcome.handle.content_hash, byte_size = outcome.handle.byte_size)
            else -> FolderFileStaged(ok = false)
        }
    }

    /** Every file under [tree], breadth-first, as `(path, uri, size, modified ms, media type)`. False when a directory could not be listed. */
    private fun walk(context: Context, tree: Uri, each: (String, Uri, Long, Long, String) -> Unit): Boolean {
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
                    each(
                        path,
                        DocumentsContract.buildDocumentUriUsingTree(tree, id),
                        it.getLong(3),
                        if (it.isNull(4)) 0L else it.getLong(4),
                        mime.takeUnless { type -> type == OCTET_STREAM }.orEmpty(),
                    )
                }
            }
        }
        return complete
    }

    private const val OCTET_STREAM = "application/octet-stream"
    private val COLUMNS = arrayOf(
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        DocumentsContract.Document.COLUMN_FLAGS,
    )
}
