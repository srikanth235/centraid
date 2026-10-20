package dev.centraid.shared.apps.docs

import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsFollowed
import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * FOLLOWING A FOLDER, BOTH SHELLS (#1127, R-1127-7): the three acts a member does with a folder,
 * and the list the drive shows. The shell owns the picker and the persisted access to the folder
 * (a security-scoped bookmark, a tree URI with a persisted grant), keyed by the folder's origin id;
 * this owns what the vault is told.
 *
 * - [follow]: the member picked a folder. The shell minted the origin ([FilesImport.origin]) and
 *   stored its access; the vault now holds the origin, and the shell asks the follower for a pass.
 * - [stop]: the member stopped following. The vault forgets the folder's links and keeps every
 *   document; the shell forgets its access and the follower is not asked for anything.
 * - [report]: tell a drive page which folders are followed, so its More sheet lists them.
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
    public fun newOrigin(): String = FilesImport.origin(DocsIngestBridge.mintId())

    /** The folder [origin], named [name] by the phone, is followed; [done] is told whether the vault took it. */
    public fun follow(origin: String, name: String, done: (Boolean) -> Unit) {
        val core = session?.shelf?.core() ?: return done(false)
        scope.launch { done(FilesImport.follow(core, FilesImport.folder(origin, name))) }
    }

    /** The folder [origin] is no longer followed; [done] is told whether the vault forgot it all. */
    public fun stop(origin: String, done: (Boolean) -> Unit) {
        val core = session?.shelf?.core() ?: return done(false)
        scope.launch {
            val row = FilesImport.followed(core)?.firstOrNull { it.phoneOrigin == origin }
            done(row == null || FilesImport.stop(core, row.originId))
        }
    }

    /** The folder a Followed sheet row's key stops (`stop:<origin>`), or null for any other key. */
    public fun stopTarget(actionKey: String): String? =
        actionKey.removePrefix(DocsWrites.KEY_STOP_PREFIX).takeIf { actionKey.startsWith(DocsWrites.KEY_STOP_PREFIX) && it.isNotEmpty() }

    /** Tell [drive] which folders are followed now. */
    public fun report(drive: DocsDriveBridge) {
        val core = session?.shelf?.core() ?: return
        scope.launch {
            val folders = FilesImport.followed(core) ?: return@launch
            drive.forward(
                DocsDriveEvent(
                    followed_changed = DocsDriveEvent.FollowedChanged(
                        followed = folders.map { DocsFollowed(origin_id = it.phoneOrigin, name = it.name, documents = it.documents) },
                    ),
                ),
            )
        }
    }

    /** The sentence a refused pick is told in. */
    public val failed: String get() = DocsCopy.FOLLOW_FAILED

    /** The sentence for a pick made with no vault. */
    public val noVault: String get() = DocsCopy.FOLLOW_NO_VAULT
}
