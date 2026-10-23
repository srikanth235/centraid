package dev.centraid.shared.apps.docs

import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * FOLLOWING A FOLDER, BOTH SHELLS (#1127, R-1127-7): what the vault is told when a member follows
 * or stops a folder, and the list of what is followed. Docs' screens are Rust's (#1135) and ask
 * the shell for these through the `FollowFolder` and `StopFollowing` effects; the shell owns the
 * picker and the persisted access to the folder (a security-scoped bookmark, a tree URI with a
 * persisted grant), keyed by the folder's origin id, and this owns what the follower engine
 * ([FilesImport]) writes to the vault.
 *
 * - [follow]: the member picked a folder. The shell minted the origin ([mintOrigin]) and stored
 *   its access; the vault now holds the origin, and the shell asks the follower for a pass.
 * - [stop]: the member stopped following. The vault forgets the folder's sources and keeps every
 *   document; the shell forgets its access and the follower is not asked for anything.
 * - [followed]: the folders the vault follows, for the shell to report to the drive.
 *
 * Bytes across to SwiftUI, nothing `suspend`; call on the main thread.
 */
public class DocsFollowBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null

    public fun attach(session: HomeSession) {
        this.session = session
    }

    /** The origin id for a newly picked folder: `folder:<uuid>`. */
    @OptIn(ExperimentalUuidApi::class)
    public fun mintOrigin(): String = FilesImport.origin(Uuid.random().toString())

    /** The folder [origin], named [name] by the phone, is followed; [done] is told whether the vault took it. */
    public fun follow(origin: String, name: String, done: (Boolean) -> Unit) {
        val core = session?.shelf?.core() ?: return done(false)
        scope.launch { done(FilesImport.follow(core, FilesImport.folder(origin, name))) }
    }

    /** The folder [origin] is no longer followed; [done] is told whether the vault forgot it all. */
    public fun stop(origin: String, done: (Boolean) -> Unit) {
        val core = session?.shelf?.core() ?: return done(false)
        scope.launch { done(FilesImport.stop(core, origin)) }
    }

    /** The folders the vault follows now, with the documents each holds; [deliver] is not called when the vault would not say. */
    public fun followed(deliver: (List<FollowedFolder>) -> Unit) {
        val core = session?.shelf?.core() ?: return
        scope.launch { FilesImport.followed(core)?.let(deliver) }
    }

    /** The title of the sheet a refused pick is told in: the act that was refused. */
    public val failedTitle: String get() = DocsCopy.ADD_FOLLOW

    /** The sentence a refused pick is told in. */
    public val failed: String get() = DocsCopy.FOLLOW_FAILED

    /** The sentence for a pick made with no vault. */
    public val noVault: String get() = DocsCopy.FOLLOW_NO_VAULT
}
