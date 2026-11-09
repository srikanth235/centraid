package dev.centraid.android.kit

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import centraid.core.v1.BytesPicked
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectResult
import centraid.core.v1.PickedBytes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okio.ByteString.Companion.toByteString

/** The most files one pick returns (Notes' import takes 5,000). */
private const val MAX_FILES = 5_000

/**
 * `PickBytes` with `multiple` (#1173): the chosen documents, each by its name. A dismissal (no
 * documents) is a cancel; a file that cannot be read is left out, not the rest.
 */
internal suspend fun pickMany(context: Context, uris: List<Uri>): EffectResult {
    if (uris.isEmpty()) return EffectResult(bytes_picked = BytesPicked(cancelled = true))
    return withContext(Dispatchers.IO) {
        val files = uris.take(MAX_FILES).mapNotNull { uri ->
            runCatching {
                val resolver = context.contentResolver
                val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0) else null
                }.orEmpty()
                val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching null
                PickedBytes(name = name, media_type = resolver.getType(uri).orEmpty(), content = bytes.toByteString())
            }.getOrNull()
        }
        EffectResult(bytes_picked = BytesPicked(files = files))
    }
}

/**
 * `PickBytes` with `folder` (#1173): every file below the chosen tree whose extension is among
 * `accept`'s (any, when none is named), each named by its path below the folder, `/` separated.
 * Hidden files and folders are skipped. A dismissal is a cancel.
 */
internal suspend fun pickFolder(context: Context, tree: Uri?, accept: List<String>): EffectResult {
    tree ?: return EffectResult(bytes_picked = BytesPicked(cancelled = true))
    val extensions = accept.filter { !it.contains('/') }.map { it.trim().removePrefix(".").lowercase() }.toSet()
    return withContext(Dispatchers.IO) {
        runCatching {
            val resolver = context.contentResolver
            val files = ArrayList<PickedBytes>()
            val pending = ArrayDeque<Pair<String, String>>()
            pending.add(DocumentsContract.getTreeDocumentId(tree) to "")
            val columns = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
            )
            while (pending.isNotEmpty() && files.size < MAX_FILES) {
                val (documentId, prefix) = pending.removeFirst()
                val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId)
                resolver.query(children, columns, null, null, null)?.use { cursor ->
                    while (cursor.moveToNext() && files.size < MAX_FILES) {
                        val id = cursor.getString(0) ?: continue
                        val name = cursor.getString(1).orEmpty()
                        val mime = cursor.getString(2).orEmpty()
                        if (name.isEmpty() || name.startsWith(".")) continue
                        if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                            pending.add(id to "$prefix$name/")
                            continue
                        }
                        if (extensions.isNotEmpty() && name.substringAfterLast('.', "").lowercase() !in extensions) continue
                        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)
                        val bytes = runCatching { resolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() ?: continue
                        files.add(PickedBytes(name = prefix + name, media_type = mime, content = bytes.toByteString()))
                    }
                }
            }
            EffectResult(bytes_picked = BytesPicked(files = files))
        }.getOrElse { EffectResult(failed = EffectFailed(reason = "the folder could not be read")) }
    }
}
