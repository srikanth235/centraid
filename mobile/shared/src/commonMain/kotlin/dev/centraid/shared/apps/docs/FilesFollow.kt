package dev.centraid.shared.apps.docs

import dev.centraid.core.CentraidCore
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneFollowPass
import dev.centraid.shared.sync.phone.PhoneFollowReads
import dev.centraid.shared.sync.phone.PhoneFollowSource
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneSource

/**
 * WHAT THE SHELL READ OF THE FOLDERS for a following pass: [FilesImport.run]'s arguments.
 *
 * @property origins every followed folder that resolved and could be listed, empty ones too. **A
 *   folder the shell has no access to any more (deleted, moved, its grant lost) is left out**,
 *   and nothing is sent or trashed for it.
 * @property complete false when a listing failed part-way: nothing is then trashed or held.
 */
public data class FilesRead(
    public val files: List<PhoneFile>,
    public val origins: List<PhoneOriginRef>,
    public val complete: Boolean,
)

/** THE SHELL'S FOLDER READER: iOS security-scoped bookmarks, Android persisted tree URIs. */
public interface FilesReader {
    /**
     * Read the folders the vault follows, [followed] being their origin ids (`folder:<uuid>`), and
     * hand them to [deliver], off the main thread: a listing only, no bytes. The shell finds its
     * own access for each by that id. **Null when the shell cannot read at all**; a following
     * pass never opens a picker, which only the member's own "Follow a folder" tap does.
     */
    public fun read(followed: List<String>, deliver: (FilesRead?) -> Unit)
}

/**
 * FOLDERS → DOCS, FOLLOWED (#1127, #1135): the shell hands this to the follower with its [reader].
 * A pass sends each folder's records to the vault, which merges them ([FilesImport.run]); nothing
 * is held for a question, because the vault decides what a file gone from a complete read does
 * (a document the member never touched goes to the trash, one they did keeps its row and stops
 * following), and a folder the shell could not reach is not sent at all.
 */
public class FilesFollow(private val reader: FilesReader) : PhoneFollowSource {
    override val source: PhoneSource = PhoneSource.FILES

    override fun bind(core: CentraidCore): PhoneFollowPass = object : PhoneFollowPass {
        override suspend fun imported(): Boolean? = PhoneFollowReads.imported(core, PhoneSource.FILES)

        override suspend fun run(): List<OriginGone>? {
            val followed = FilesImport.followed(core)?.map { it.phoneOrigin } ?: return null
            val read = PhoneFollowReads.await<FilesRead> { reader.read(followed, it) } ?: return null
            FilesImport.run(core, read.files, read.origins, read.complete)
            return emptyList()
        }

        override suspend fun resolve(gone: OriginGone, keep: Boolean) = Unit
    }
}
