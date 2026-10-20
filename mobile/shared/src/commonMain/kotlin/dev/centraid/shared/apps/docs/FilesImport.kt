package dev.centraid.shared.apps.docs

import dev.centraid.core.CentraidCore
import dev.centraid.shared.sync.phone.GoneChoice
import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneIds
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneRecord
import dev.centraid.shared.sync.phone.PhoneReport
import dev.centraid.shared.sync.phone.PhoneSnapshot
import dev.centraid.shared.sync.phone.PhoneSource
import dev.centraid.shared.sync.phone.PhoneStore
import dev.centraid.shared.sync.phone.PhoneSync
import dev.centraid.shared.sync.rfc3339FromEpochMillis
import okio.Path.Companion.toPath
import okio.buffer
import kotlin.time.Clock

/**
 * THE BYTES OF ONE FILE, as the shell opens them: `read` answers the next slice (empty at the end)
 * and `close` releases the file. Streamed, because a 900 MB video never exists in memory at once
 * (`Staging.stage`'s reason).
 */
public interface PhoneFileBytes {
    public fun read(max: Int): ByteArray

    public fun close()
}

/**
 * ONE FILE OF A PICKED FOLDER, as the shell found it (#1127, R-1127-7). A listing carries no bytes:
 * [open] is called only when the file is new or its size or modification time moved, so a rescan
 * of an unchanged folder reads nothing.
 *
 * @property origin the folder's origin id (`folder:<uuid>`), as the vault holds it.
 * @property path the file's path relative to the folder, `/`-separated.
 * @property size its length in bytes.
 * @property modifiedMs its modification time, epoch milliseconds.
 * @property mediaType the OS's name for its type, or empty (read off the name).
 * @property open the file's bytes, or null when it cannot be read now.
 */
public class PhoneFile(
    public val origin: String,
    public val path: String,
    public val size: Long,
    public val modifiedMs: Long,
    public val mediaType: String,
    public val open: () -> PhoneFileBytes?,
) {
    /** The name a document is filed under: the last component of the path. */
    public val name: String get() = path.substringAfterLast('/')
}

/** HOW A SHELL OPENS A FILE IT CAN NAME BY PATH (iOS, over a folder whose access it holds). */
public object PhoneFileSources {
    /** The bytes of the file at [path], streamed; null when it cannot be opened. */
    public fun atPath(path: String): PhoneFileBytes? = try {
        val source = okio.FileSystem.SYSTEM.source(path.toPath()).buffer()
        object : PhoneFileBytes {
            override fun read(max: Int): ByteArray {
                if (source.exhausted()) return ByteArray(0)
                source.request(max.toLong())
                return source.readByteArray(minOf(source.buffer.size, max.toLong()))
            }

            override fun close() {
                source.close()
            }
        }
    } catch (failed: okio.IOException) {
        null
    }
}

/** A followed folder as the vault holds it: its origin id, the shell's name for it, and its documents. */
public data class FollowedFolder(
    public val originId: String,
    public val phoneOrigin: String,
    public val name: String,
    public val documents: Int,
)

/**
 * FILES → DOCS (#1127, R-1127-7): a picked folder is followed one way, phone → vault (R-1127-1).
 * A file the vault lacks becomes a document, a changed file becomes a **new revision of the same
 * document** (never a second one), a removed file sends its document to the trash (R-1127-3), a
 * document the member edited in Centraid (a new revision, a rename) detaches and is never
 * overwritten (R-1127-2), and a folder that is no longer reachable is held and asked about
 * (R-1127-9). Nothing is written to the folder.
 *
 * ## What is followed
 *
 * A file's phone id is `local:<folder uuid>/<path>` (R-1127-10): the path alone would be the same
 * id in two followed folders, and a link is unique by its phone id. **A rename on the phone is a
 * remove plus an add**: the old document goes to the trash and the new name files a new one.
 * Recursive; hidden files, packages and bundles, empty files, and anything the Docs ingest
 * refuses are not read as records (the shell skips the first two, [snapshot] the rest).
 *
 * ## The fingerprint
 *
 * The phone's half is the file's size and modification time with its title: the cheap pre-check
 * that decides whether a file is read at all. The vault's half is the CONTENT HASH of the bytes
 * Centraid last stored and the document's title ([VaultRow.fields]): a new revision or a rename
 * made in Docs moves it, and that is how an edit is told from the phone's own change.
 */
public object FilesImport {
    /** What one pass did. */
    public data class Outcome(
        public val added: Int,
        public val refused: Int,
        public val updated: Int = 0,
        public val trashed: Int = 0,
        public val gone: List<dev.centraid.shared.sync.phone.OriginGone> = emptyList(),
    )

    /** The origin id the shell mints when the member picks a folder. */
    public fun origin(id: String): String = "$FOLDER:$id"

    /** The folder as the vault names its origin. */
    public fun folder(origin: String, name: String): PhoneOriginRef =
        PhoneOriginRef(origin, PhoneFields.squash(name).ifEmpty { origin })

    /** A file's phone id: its folder's uuid and its path (R-1127-10). */
    public fun phoneId(origin: String, path: String): String =
        PhoneIds.local("${origin.removePrefix("$FOLDER:")}/$path")

    /** The phone's half of a link's fingerprint: the pre-check and the title. */
    internal fun fields(size: Long, modifiedMs: Long, title: String): PhoneFields = PhoneFields.of {
        exact("stat", "$size:$modifiedMs")
        text("title", title)
    }

    /** The vault's half: the content hash of the bytes Centraid holds and the title it holds them under. */
    internal fun vaultFields(contentHash: String, title: String): PhoneFields = PhoneFields.of {
        exact("content", contentHash)
        text("title", title)
    }

    /**
     * A READ OF THE FOLDERS AS A SNAPSHOT: one record per file, named, non-empty, hidden ones
     * dropped, one per phone id. [origins] lists every folder that resolved, empty ones too; a
     * folder the shell could not reach is left out of it, which is what [PhoneSync] reads as gone.
     */
    public fun snapshot(
        files: List<PhoneFile>,
        origins: List<PhoneOriginRef>,
        complete: Boolean,
        readAt: String,
    ): PhoneSnapshot {
        val present = origins.map { it.id }.toSet()
        val seen = mutableSetOf<String>()
        val records = files.mapNotNull { file ->
            val title = PhoneFields.squash(file.name)
            val id = phoneId(file.origin, file.path)
            val hidden = file.path.split('/').any { it.startsWith(".") }
            if (title.isEmpty() || hidden || file.size <= 0 || file.origin !in present || !seen.add(id)) return@mapNotNull null
            PhoneRecord(
                phoneId = id,
                origin = file.origin,
                fields = fields(file.size, file.modifiedMs, title),
                attributes = FileAttributes(file, title),
            )
        }
        return PhoneSnapshot(PhoneSource.FILES, complete, readAt, origins, records)
    }

    /** ONE PASS over [store] with [snapshot]. */
    internal suspend fun sync(store: PhoneStore, snapshot: PhoneSnapshot): Outcome {
        val report = PhoneSync.run(store, snapshot)
        return outcome(report)
    }

    /** One pass over [files] in the vault [core] holds. */
    public suspend fun run(
        core: CentraidCore,
        files: List<PhoneFile>,
        origins: List<PhoneOriginRef>,
        complete: Boolean,
    ): Outcome = sync(FilesStore(core), snapshot(files, origins, complete, readAt()))

    /** The member's answer to a folder held (R-1127-9): [GoneChoice.KEEP] is the default. */
    public suspend fun resolveGone(
        core: CentraidCore,
        originId: String,
        choice: GoneChoice,
        seenBefore: String? = null,
    ): Outcome {
        val report = PhoneSync.resolveGone(FilesStore(core), originId, choice, seenBefore)
        return Outcome(added = 0, refused = report.refused.size, trashed = report.trashed)
    }

    /** The folders the vault follows, with the documents each holds; null when the vault would not say. */
    public suspend fun followed(core: CentraidCore): List<FollowedFolder>? = FilesStore(core).followed()

    /** Follow a folder the member just picked: its origin, so the next pass reads it. False when refused. */
    public suspend fun follow(core: CentraidCore, folder: PhoneOriginRef): Boolean =
        FilesStore(core).origin(folder.id, folder.label) != null

    /**
     * STOP FOLLOWING [originId]: its links are forgotten and the origin retired. **Every document
     * stays** and is an ordinary one from now on; nothing is trashed. False when the vault refused
     * part of it (the rest is done, and stopping again finishes it).
     */
    public suspend fun stop(core: CentraidCore, originId: String): Boolean {
        val store = FilesStore(core)
        val links = store.links() ?: return false
        var clean = true
        for (link in links.filter { it.originId == originId }) clean = store.forget(link.linkId) && clean
        return store.retireOrigin(originId) && clean
    }

    private fun outcome(report: PhoneReport): Outcome = Outcome(
        added = report.added,
        refused = report.refused.size,
        updated = report.updated,
        trashed = report.trashed,
        gone = report.gone,
    )

    internal fun readAt(): String = rfc3339FromEpochMillis(Clock.System.now().toEpochMilliseconds())

    /** The prefix of a folder origin: `folder:<uuid>`. */
    public const val FOLDER: String = "folder"
}

/** What a file's writer needs and the engine never reads. */
internal class FileAttributes(val file: PhoneFile, val title: String)
