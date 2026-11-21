package dev.centraid.android.kit

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import centraid.core.v1.BytesPicked
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectResult
import centraid.core.v1.PickedBytes
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okio.ByteString.Companion.toByteString

/** The most files one pick returns (Notes' import takes 5,000). */
private const val MAX_FILES = 5_000

/**
 * THE SIZE CEILINGS OF ONE PICK (`PickBytes.max_bytes`, `max_total_bytes`; 0 is none), #1202: a file is
 * sized from its provider's metadata and read only up to the ceiling, so a 100 MB list or a folder of
 * thousands never sits in the heap whole, and a provider that states no size is held to the same
 * ceiling by the read itself.
 */
internal class PickLimits(private val perFile: Long, private val total: Long) {
    private var used = 0L

    sealed interface Read {
        class Bytes(val bytes: ByteArray) : Read

        data object TooLarge : Read

        data object Unreadable : Read
    }

    fun read(context: Context, uri: Uri): Read {
        val resolver = context.contentResolver
        val stated = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null
            }
        }.getOrNull()
        if (stated != null && exceeds(stated)) return Read.TooLarge
        // Never past the ceiling plus one byte: one more proves the file is over it.
        val cap = listOf(perFile, if (total > 0) total - used else 0L).filter { it > 0 }.minOrNull()
        val bytes = runCatching {
            resolver.openInputStream(uri)?.use { input ->
                val out = ByteArrayOutputStream()
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    out.write(buffer, 0, count)
                    if (cap != null && out.size() > cap) return Read.TooLarge
                }
                out.toByteArray()
            }
        }.getOrNull() ?: return Read.Unreadable
        if (exceeds(bytes.size.toLong())) return Read.TooLarge
        used += bytes.size
        return Read.Bytes(bytes)
    }

    private fun exceeds(size: Long) = (perFile > 0 && size > perFile) || (total > 0 && used + size > total)
}

/**
 * `PickBytes` with `multiple` (#1173): the chosen documents, each by its name. A dismissal (no
 * documents) is a cancel; a file that cannot be read is left out, not the rest.
 */
internal suspend fun pickMany(context: Context, uris: List<Uri>, limits: PickLimits): EffectResult {
    if (uris.isEmpty()) return EffectResult(bytes_picked = BytesPicked(cancelled = true))
    return withContext(Dispatchers.IO) {
        val files = ArrayList<PickedBytes>()
        val skipped = ArrayList<String>()
        for (uri in uris.take(MAX_FILES)) {
            val resolver = context.contentResolver
            val name = runCatching {
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0) else null
                }
            }.getOrNull().orEmpty()
            when (val read = limits.read(context, uri)) {
                is PickLimits.Read.Bytes ->
                    files.add(PickedBytes(name = name, media_type = resolver.getType(uri).orEmpty(), content = read.bytes.toByteString()))
                else -> skipped.add(name.ifEmpty { uri.lastPathSegment.orEmpty() })
            }
        }
        EffectResult(bytes_picked = BytesPicked(files = files, skipped = skipped))
    }
}

/**
 * `PickBytes` with `folder` (#1173): every file below the chosen tree whose extension is among
 * `accept`'s (any, when none is named), each named by its path below the folder, `/` separated.
 * Hidden files and folders are skipped; one over a ceiling or that would not read is named in
 * `skipped`. A dismissal is a cancel.
 */
internal suspend fun pickFolder(context: Context, tree: Uri?, accept: List<String>, limits: PickLimits): EffectResult {
    tree ?: return EffectResult(bytes_picked = BytesPicked(cancelled = true))
    val extensions = accept.filter { !it.contains('/') }.map { it.trim().removePrefix(".").lowercase() }.toSet()
    return withContext(Dispatchers.IO) {
        runCatching {
            val resolver = context.contentResolver
            val files = ArrayList<PickedBytes>()
            val skipped = ArrayList<String>()
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
                        when (val read = limits.read(context, uri)) {
                            is PickLimits.Read.Bytes -> files.add(PickedBytes(name = prefix + name, media_type = mime, content = read.bytes.toByteString()))
                            else -> skipped.add(prefix + name)
                        }
                    }
                }
            }
            EffectResult(bytes_picked = BytesPicked(files = files, skipped = skipped))
        }.getOrElse { EffectResult(failed = EffectFailed(reason = EffectReason.UNREADABLE)) }
    }
}
