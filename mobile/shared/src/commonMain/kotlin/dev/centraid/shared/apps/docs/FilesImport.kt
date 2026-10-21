package dev.centraid.shared.apps.docs

import centraid.core.v1.Value
import dev.centraid.core.CentraidCore
import dev.centraid.shared.kit.PhoneImport
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.shell.Staging
import dev.centraid.shared.sync.phone.PhoneDevice
import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhonePages
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okio.Path.Companion.toPath
import okio.buffer

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

/** WHAT STAGING A FILE ANSWERED: the content hash the core named, and the bytes it counted. */
internal class StagedFile(val hash: String, val size: Long)

/**
 * HOW A FILE'S BYTES REACH THE VAULT: stream [file] through the stage frames and answer what the
 * core named, or null when it would not take them (unreadable, refused). A seam so a spec drives
 * [FilesImport] without a core that can stage.
 */
internal fun interface FileStager {
    suspend fun stage(file: PhoneFile): StagedFile?
}

/** The session core's stager: the camera roll's door, with the media type read off the name. */
internal class CoreFileStager(private val core: CentraidCore) : FileStager {
    override suspend fun stage(file: PhoneFile): StagedFile? {
        val bytes = file.open() ?: return null
        return try {
            // Off the main thread: the follower runs there, and a read of a big file blocks.
            val outcome = Staging.stage(core, FilesImport.mediaTypeOf(file), file.size) { max ->
                withContext(Dispatchers.Default) { bytes.read(max) }
            }
            (outcome as? Staging.Outcome.Ok)?.staged?.let { StagedFile(it.contentHash, it.byteSize) }
        } catch (@Suppress("TooGenericExceptionCaught") failed: Exception) {
            // A file that vanished or would not read mid-stream is a refused file, not a failed pass.
            null
        } finally {
            runCatching { bytes.close() }
        }
    }
}

/**
 * FILES → DOCS (#1127, R-1127-7; #1135): a picked folder is followed one way, phone → vault
 * (R-1127-1). The phone sends RECORDS and **the vault merges**, in one command per folder,
 * `follow.files`: a file the vault lacks becomes a document in the folder's own Docs folder, a
 * changed file is **a new revision of the same document** (never a second one), a file gone from a
 * complete read goes to the trash if the member never touched its document, and a document the
 * member edited in Centraid (a new revision, a rename) stands and is never overwritten
 * (R-1127-2). Nothing is written to the folder.
 *
 * ## What is followed
 *
 * A file's record is its path under its folder (the folder is the origin: `folder:<uuid>`,
 * R-1127-10), the title it is filed under, its bytes' hash and media type, and its `stat`, the
 * file's size and modification time. **A rename on the phone is a remove plus an add**: the old
 * document goes to the trash if untouched and the new name files a new one, or is found by its
 * name among the documents nothing follows. Recursive; hidden files, empty files and packages are
 * not read as records. A folder the shell cannot reach is simply not sent: nothing is trashed on
 * the strength of a folder nobody could read.
 *
 * ## The pre-check
 *
 * The phone reads no bytes of a file whose `stat` the vault already holds as last stated
 * (`source.stated`): a rescan of an unchanged folder stages nothing and sends the stat alone. A
 * file that is new or moved is streamed through the stage door, claimed (`blob.stage`, the size
 * the core counted) and named by the record, so no bytes sit in the vault that nothing names.
 */
public object FilesImport {
    /** What one pass did. */
    public data class Outcome(
        public val added: Int,
        public val refused: Int,
        public val updated: Int = 0,
        public val trashed: Int = 0,
    )

    /** The origin id the shell mints when the member picks a folder. */
    public fun origin(id: String): String = "$FOLDER:$id"

    /** The folder as the vault names its origin. */
    public fun folder(origin: String, name: String): PhoneOriginRef =
        PhoneOriginRef(origin, PhoneFields.squash(name).ifEmpty { origin })

    /** The prefix of a folder origin: `folder:<uuid>`. */
    public const val FOLDER: String = "folder"

    /** A media type for a file the platform named none for, off its name. */
    internal fun mediaTypeOf(file: PhoneFile): String = DocsIngestMachine.mediaTypeOf(file.name, file.mediaType)

    /** The phone's half of a record: the cheap pre-check. */
    internal fun statOf(file: PhoneFile): String = "${file.size}:${file.modifiedMs}"

    /** Whether a file is a record at all: named, not hidden, not empty. */
    internal fun usable(file: PhoneFile): Boolean =
        PhoneFields.squash(file.name).isNotEmpty() && file.size > 0 && file.path.split('/').none { it.startsWith(".") }

    /** One pass over [files] in the vault [core] holds, on [device] (this install's [PhoneDevice] unless named). */
    public suspend fun run(
        core: CentraidCore,
        files: List<PhoneFile>,
        origins: List<PhoneOriginRef>,
        complete: Boolean,
        device: String? = null,
    ): Outcome = run(core, files, origins, complete, device ?: PhoneDevice.id(), CoreFileStager(core))

    internal suspend fun run(
        core: CentraidCore,
        files: List<PhoneFile>,
        origins: List<PhoneOriginRef>,
        complete: Boolean,
        device: String,
        stager: FileStager,
    ): Outcome {
        val stated = statsOf(core)
        var outcome = Outcome(added = 0, refused = 0)
        for (origin in origins) {
            val seen = mutableSetOf<String>()
            val mine = files.filter { it.origin == origin.id && usable(it) && seen.add(it.path) }
            val held = stated?.get(origin.id).orEmpty()
            val records = mutableListOf<String>()
            var whole = complete && stated != null
            var refused = 0
            for (file in mine) {
                val record = record(core, file, held[file.path], stager)
                if (record == null) {
                    // A file that would not read is neither sent nor missed: the read is not whole.
                    refused += 1
                    whole = false
                } else {
                    records += record
                }
            }
            val told = PhoneImport.executed(core, "follow.files", input(origin, records, whole, device))
            outcome = if (told == null) {
                outcome.copy(refused = outcome.refused + refused + records.size)
            } else {
                outcome.copy(
                    added = outcome.added + count(told, "added") + count(told, "matched"),
                    updated = outcome.updated + count(told, "updated"),
                    trashed = outcome.trashed + count(told, "trashed"),
                    refused = outcome.refused + refused,
                )
            }
        }
        return outcome
    }

    /**
     * ONE FILE AS A RECORD: its stat alone when the vault already holds it as last stated, else its
     * bytes staged and claimed too. Null when the bytes could not be staged or claimed.
     */
    private suspend fun record(core: CentraidCore, file: PhoneFile, held: String?, stager: FileStager): String? {
        val title = PhoneFields.squash(file.name)
        val stat = statOf(file)
        val fields = StringBuilder("{\"title\":").append(jsonString(title))
        if (held != stat) {
            val staged = stager.stage(file) ?: return null
            // The stage door only stores and hashes: the vault counts bytes a command names.
            PhoneImport.executed(core, "blob.stage", "{\"hash\":${jsonString(staged.hash)},\"size\":${staged.size}}") ?: return null
            fields.append(",\"blob\":").append(jsonString(staged.hash))
                .append(",\"media_type\":").append(jsonString(mediaTypeOf(file)))
        }
        fields.append(",\"stat\":").append(jsonString(stat)).append('}')
        return "{\"external_id\":${jsonString(file.path)},\"fields\":$fields}"
    }

    /** The `follow.files` input for one folder. */
    internal fun input(origin: PhoneOriginRef, records: List<String>, complete: Boolean, device: String, fills: String? = null): String =
        buildString {
            append("{\"origin\":{\"ref\":").append(jsonString(origin.id))
            append(",\"label\":").append(jsonString(origin.label))
            append(",\"device_id\":").append(jsonString(device))
            if (fills != null) append(",\"fills\":").append(jsonString(fills))
            append("},\"records\":[").append(records.joinToString(",")).append("],\"complete\":").append(complete).append('}')
        }

    /** A count of the command's output: `"added":3`. */
    private fun count(output: String, name: String): Int =
        Regex("\"$name\"\\s*:\\s*(\\d+)").find(output)?.groupValues?.get(1)?.toIntOrNull() ?: 0

    /**
     * THE STATS THE VAULT HOLDS, by folder and path: what each file last stated. Null when the
     * vault would not say, and then nothing is trashed (a read planned against a half-read table).
     */
    private suspend fun statsOf(core: CentraidCore): Map<String, Map<String, String>>? {
        val origins = PhonePages.all(core, name = "files.origins", select = listOf("id", "ref"), "origin", "id", "system = ?", listOf(Value(text = "files")))
            ?: return null
        val refOf = origins.associate { it.text(0) to it.text(1) }
        val sources = PhonePages.all(
            core,
            name = "files.sources",
            listOf("id", "origin_id", "external_id", "stated"),
            "source",
            "id",
            "system = ?",
            listOf(Value(text = "files")),
        ) ?: return null
        val stats = mutableMapOf<String, MutableMap<String, String>>()
        for (row in sources) {
            val ref = refOf[row.text(1)] ?: continue
            val stat = STAT.find(row.text(3))?.groupValues?.get(1) ?: continue
            stats.getOrPut(ref) { mutableMapOf() }[row.text(2)] = stat
        }
        return stats
    }

    private val STAT = Regex("\"stat\"\\s*:\\s*\"([^\"]*)\"")

    private fun List<Value>.text(index: Int): String = getOrNull(index)?.text.orEmpty()

    /** The folders the vault follows, with the documents each holds; null when the vault would not say. */
    public suspend fun followed(core: CentraidCore): List<FollowedFolder>? {
        val origins = PhonePages.all(
            core,
            name = "files.followed",
            listOf("id", "ref", "label"),
            "origin",
            "id",
            "system = ?",
            listOf(Value(text = "files")),
        ) ?: return null
        val sources = PhonePages.all(
            core,
            "files.followed.documents",
            listOf("id", "origin_id", "entity_id"),
            "source",
            "id",
            "system = ?",
            listOf(Value(text = "files")),
        ) ?: return null
        val live = sources.filter { it.text(2).isNotEmpty() }.groupingBy { it.text(1) }.eachCount()
        return origins.map { FollowedFolder(it.text(0), it.text(1), it.text(2), live[it.text(0)] ?: 0) }
            .sortedBy { it.name.lowercase() }
    }

    /**
     * Follow a folder the member just picked: its Docs folder (made here, named as the member
     * names the folder) and its origin, so the next pass reads it. A folder already followed keeps
     * its Docs folder. False when refused.
     */
    public suspend fun follow(core: CentraidCore, folder: PhoneOriginRef, device: String? = null): Boolean {
        val phone = device ?: PhoneDevice.id()
        val known = followed(core) ?: return false
        val fills = if (known.any { it.phoneOrigin == folder.id }) {
            null
        } else {
            val made = PhoneImport.executed(
                core,
                "container.create",
                "{\"kind\":\"folder\",\"title\":${jsonString(folder.label)}}",
            ) ?: return false
            Regex("\"id\"\\s*:\\s*\"([^\"]+)\"").find(made)?.groupValues?.get(1) ?: return false
        }
        return PhoneImport.executed(core, "follow.files", input(folder, emptyList(), complete = false, device = phone, fills = fills)) != null
    }

    /**
     * STOP FOLLOWING the folder [phoneOrigin]: its sources are forgotten and the origin retired.
     * **Every document stays** and is an ordinary one from now on; nothing is trashed. False when
     * the vault refused.
     */
    public suspend fun stop(core: CentraidCore, phoneOrigin: String): Boolean =
        PhoneImport.executed(core, "follow.stop", "{\"system\":\"files\",\"ref\":${jsonString(phoneOrigin)}}") != null
}
