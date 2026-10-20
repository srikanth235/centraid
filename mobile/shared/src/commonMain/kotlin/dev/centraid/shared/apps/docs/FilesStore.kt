package dev.centraid.shared.apps.docs

import centraid.core.v1.Value
import dev.centraid.core.CentraidCore
import dev.centraid.shared.shell.Staging
import dev.centraid.shared.sync.phone.CorePhoneStore
import dev.centraid.shared.sync.phone.PhoneRecord
import dev.centraid.shared.sync.phone.PhoneSource
import dev.centraid.shared.sync.phone.VaultRow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * HOW A FILE'S BYTES REACH THE VAULT: stream [file] through the stage frames and answer the
 * content hash the core named, or null when it would not take them (unreadable, refused). A seam
 * so a spec drives [FilesStore] without a core that can stage.
 */
internal fun interface FileStager {
    suspend fun stage(file: PhoneFile): String?
}

/** The session core's stager: the camera roll's door, with the media type read off the name. */
internal class CoreFileStager(private val core: CentraidCore) : FileStager {
    override suspend fun stage(file: PhoneFile): String? {
        val bytes = file.open() ?: return null
        return try {
            // Off the main thread: the follower runs there, and a read of a big file blocks.
            val outcome = Staging.stage(core, DocsIngestMachine.mediaTypeOf(file.name, file.mediaType), file.size) { max ->
                withContext(Dispatchers.Default) { bytes.read(max) }
            }
            (outcome as? Staging.Outcome.Ok)?.staged?.contentHash
        } catch (@Suppress("TooGenericExceptionCaught") failed: Exception) {
            // A file that vanished or would not read mid-stream is a refused file, not a failed pass.
            null
        } finally {
            runCatching { bytes.close() }
        }
    }
}

/**
 * DOCS' SIDE OF A FOLDER PASS: the documents a link may name, read through the page door, and the
 * three writes the engine asks, through the commands a screen uses. A document followed from a
 * folder is an ordinary document (R-ONBOARD-4); only the link says where it came from.
 */
internal class FilesStore(
    core: CentraidCore,
    private val stager: FileStager = CoreFileStager(core),
    private val mintId: () -> String = { DocsIngestBridge.mintId() },
) : CorePhoneStore(core, PhoneSource.FILES) {
    /** Unlinked live documents by (title, content hash): what a new file may be adopted into. Built once, on the first add. */
    private var pool: MutableMap<Pair<String, String>, MutableList<String>>? = null

    override suspend fun rows(): Map<String, VaultRow>? = read(documentId = null)

    override suspend fun row(entityId: String): VaultRow? = read(entityId)?.get(entityId)

    private suspend fun read(documentId: String?): Map<String, VaultRow>? {
        val only = documentId?.let { Value(text = it) }
        val binds = listOfNotNull(only)
        val documents = pageAll(
            "phone.files.documents",
            listOf("document_id", "title", "current_content_id", "deleted_at"),
            "core_document",
            "document_id",
            if (only == null) null else "document_id = ?",
            binds,
        ) ?: return null
        val hashes = pageAll(
            "phone.files.hashes",
            listOf("content_id", "content_hash"),
            "core_content_item",
            "content_id",
            "content_id IN (SELECT current_content_id FROM core_document" + (if (only == null) ")" else " WHERE document_id = ?)"),
            binds,
        ) ?: return null
        val hashOf = hashes.associate { it.text(0) to it.text(1) }
        return documents.associate { document ->
            val id = document.text(0)
            val hash = hashOf[document.text(2)].orEmpty()
            id to VaultRow(
                entityId = id,
                fields = FilesImport.vaultFields(hash, document.text(1)),
                trashed = document.text(3).isNotEmpty(),
                attributes = Held(hash, document.text(1)),
            )
        }
    }

    /** What the store keeps of a document beside its fields. */
    private class Held(val hash: String, val title: String)

    override suspend fun add(record: PhoneRecord): String? {
        val file = record.attributes as? FileAttributes ?: return null
        val hash = stager.stage(file.file) ?: return null
        adopt(file.title, hash)?.let { return it }
        val id = mintId()
        command(DocsWrites.ADD, DocsWrites.upload(id, hash, file.title, "")) ?: return null
        return id
    }

    /**
     * A DOCUMENT THE MEMBER ALREADY HAS FOR THIS FILE: live, linked to no file, with this title and
     * these exact bytes. It is taken for the file's own (its link is made, nothing is written to
     * it), so following a folder the member once uploaded from does not file everything twice.
     */
    private suspend fun adopt(title: String, hash: String): String? {
        val candidates = pool ?: build().also { pool = it }
        return candidates[title to hash]?.removeFirstOrNull()
    }

    private suspend fun build(): MutableMap<Pair<String, String>, MutableList<String>> {
        val built = mutableMapOf<Pair<String, String>, MutableList<String>>()
        val rows = rows() ?: return built
        val linked = links()?.mapNotNull { it.entityId }?.toSet() ?: return built
        for ((id, row) in rows) {
            if (row.trashed || id in linked) continue
            val held = row.attributes as? Held ?: continue
            if (held.hash.isEmpty()) continue
            built.getOrPut(held.title to held.hash) { mutableListOf() } += id
        }
        return built
    }

    /**
     * THE FILE NOW, AS A NEW REVISION OF THE SAME DOCUMENT. Bytes equal to the ones the document
     * holds (a touched file, a copy over itself) are not a revision: nothing is written and the
     * link is refreshed.
     */
    override suspend fun update(entityId: String, record: PhoneRecord): Boolean {
        val file = record.attributes as? FileAttributes ?: return false
        val hash = stager.stage(file.file) ?: return false
        val held = row(entityId)?.attributes as? Held ?: return false
        if (held.hash == hash) return true
        return command(DocsWrites.REPLACE_CONTENT, DocsWrites.replaceContent(entityId, hash)) != null
    }

    override suspend fun trash(entityId: String): Boolean =
        command(DocsWrites.TRASH, DocsWrites.documentOnly(entityId)) != null

    /** The folders the vault follows, with the documents each holds; null when the vault would not say. */
    suspend fun followed(): List<FollowedFolder>? {
        val origins = origins() ?: return null
        val links = links() ?: return null
        val live = links.filter { it.entityId != null }.groupingBy { it.originId }.eachCount()
        return origins.map { FollowedFolder(it.originId, it.phoneOrigin, it.label, live[it.originId] ?: 0) }
            .sortedBy { it.name.lowercase() }
    }
}
