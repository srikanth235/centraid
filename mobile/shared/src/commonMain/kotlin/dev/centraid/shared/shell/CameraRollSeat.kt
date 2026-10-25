package dev.centraid.shared.shell

import centraid.screen.v1.BackupState
import centraid.screen.v1.MediaPermission
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * WHERE THE CAMERA ROLL MEETS THE PHOTOS SCREEN (#1135, lane D).
 *
 * The Photos screen is Rust's (`photos.home`); it decides what the banner says
 * and which remedy it offers, and the roll (enumerating, uploading, the OS grant)
 * stays the shell's own. They meet here, in two directions and nothing else:
 *
 * * **in:** the OS grant and the pass's progress, which the shell forwards to the
 *   screen as `PhotosPermissionChanged` / `PhotosBackupChanged` events
 *   ([PhotosDevice.observe]);
 * * **out:** what the screen asked the shell to do about the roll, as the
 *   `CameraRoll` effect's actions ([Request]).
 *
 * A seat holds the last of each so a screen opened later is told at once.
 */
public class CameraRollSeat {
    private val grant = MutableStateFlow(MediaPermission.MEDIA_PERMISSION_NOT_ASKED)
    private val progress = MutableStateFlow(BackupState(phase = BackupState.Phase.PHASE_IDLE))
    private val asked = MutableSharedFlow<Request>(extraBufferCapacity = 8)

    /** The OS grant for the roll. */
    public val permission: StateFlow<MediaPermission> get() = grant

    /** The pass's last published state. */
    public val backup: StateFlow<BackupState> get() = progress

    /** What the screen asked the roll to do. */
    public val requests: SharedFlow<Request> get() = asked

    /** The runner read the grant (a read, never an ask). */
    public fun permissionChanged(permission: MediaPermission) {
        grant.value = permission
    }

    /** A pass published a state. */
    public fun backupChanged(state: BackupState) {
        progress.value = state
    }

    /** The screen asked for [request]. */
    public fun request(request: Request) {
        asked.tryEmit(request)
    }

    /** What the Photos screen can ask of the roll. */
    public enum class Request { ASK_PERMISSION, IMPORT_NOW }
}
