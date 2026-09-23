package dev.centraid.shared.shell

import centraid.screen.v1.BackupState
import centraid.screen.v1.MediaPermission
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.PhotosGridState
import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex

/**
 * THE THREE EFFECTS NOBODY SERVED (#1025 S6, D-1025-S7-74).
 *
 * `ScreenEffect.Backup`, `ScreenEffect.RequestMediaPermission` and the
 * `PHPhotoLibraryChangeObserver` nudge. All three existed as declarations —
 * the effect types were on `ScreenEffect`, `PhotosGridMachine` emitted one of
 * them, `BackupState` was on the screen's state and both shells drew it — and
 * **no runner collected any of them**. Pressing "Allow photo access" emitted an
 * effect into a `SharedFlow` with no subscriber; the backup could not be
 * started at all.
 *
 * `ScreenRuntime` is the twin of this class and serves `ReadPage` and
 * `SubmitWrite` for every screen. This is separate rather than a third branch
 * there for the reason `PerAppLayoutSpec` keeps: a camera roll is Photos'
 * business, `ScreenRuntime` is every screen's, and a runtime that grew an
 * `if` per app is a runtime every app has to be edited into.
 *
 * ## One pass at a time, and it is a `Mutex` and not a flag
 *
 * A member pressing the button twice, a library-changed nudge and a foreground
 * wake can all arrive inside one pass. Two passes over one cursor is two
 * readers of a keyset walk: both read the same cursor, both stage the same
 * photographs, and the slower one's write of the cursor moves it BACKWARDS —
 * so the roll would be re-offered for ever. [tryLock] and not `withLock`,
 * because the right answer to "a pass is already running" is to do nothing,
 * not to run a second one afterwards.
 */
public class CameraRollRunner(
    private val services: PlatformServices,
    private val roll: CameraRoll,
    private val host: ScreenHost<PhotosGridState, PhotosGridEvent>,
    private val scope: CoroutineScope,
    /** Which vault the roll is being offered to. See [CameraRoll.cursorKey]. */
    private val vaultId: () -> String?,
) {
    private val passing = Mutex()

    /**
     * Read the OS grant onto the screen. A read, never an ask (R-PHOTOS-1).
     *
     * Called on [start] and again when the Photos screen opens, because a grant
     * that landed after the session attached (Settings, a launch prompt the
     * seed raced) must be on state before the member-visible frame — otherwise
     * the banner keeps "Allow photo access" over a library the app can already
     * read (#1025 live).
     */
    public suspend fun syncPermission() {
        host.send(
            PhotosGridEvent(
                permission = PhotosGridEvent.PermissionChanged(
                    permission = services.mediaLibrary.permission(),
                ),
            ),
        )
    }

    /**
     * Collect this screen's effects, and hear the library.
     *
     * The observer is registered here and not in [CameraRoll] because it is a
     * live subscription with a lifetime, and this object has one while a pure
     * pass does not.
     *
     * **Permission is synced BEFORE the effects collector runs**, on this same
     * coroutine: a fire-and-forget launch beside the collector left the first
     * published state at `NOT_ASKED` until a later turn, and the Photos cover's
     * first frame offered the ask over an existing grant.
     */
    public fun start(): Job {
        services.mediaLibrary.onLibraryChanged {
            // A NEW CAPTURE WHILE THE APP IS ON SCREEN. It is a nudge to run the
            // ordinary pass and never a second way to learn what is new: the
            // cursor is the durable answer, and a `PHChange` read here would be
            // a second opinion about it that a backgrounded app never gets.
            scope.launch { once() }
        }
        return scope.launch {
            syncPermission()
            host.effects.collect { effect ->
                when {
                    effect is ScreenEffect.RequestMediaPermission -> scope.launch { ask() }
                    effect is ScreenEffect.Backup &&
                        effect.action != ScreenEffect.Backup.Action.PAUSE ->
                        scope.launch { once() }
                    // PAUSE STOPS THE NEXT PASS AND NEVER THE ONE RUNNING. A
                    // stage that is interrupted half way leaves the core a
                    // staging session nothing will ever end; the pass checks the
                    // transfer rule between items and stops at an item boundary,
                    // which is the same boundary every other stop uses.
                    else -> Unit
                }
            }
        }
    }

    /**
     * ASK THE PLATFORM, AND TELL THE SCREEN WHAT IT SAID.
     *
     * Then run a pass IF the answer allows one. A member who presses "Allow
     * photo access", grants it, and then has to find a second button to start
     * the backup has been asked the same question twice.
     */
    public suspend fun ask() {
        val answer = services.mediaLibrary.requestPermission()
        host.send(
            PhotosGridEvent(permission = PhotosGridEvent.PermissionChanged(permission = answer)),
        )
        if (answer == MediaPermission.MEDIA_PERMISSION_GRANTED ||
            // LIMITED COUNTS, and it is the state this whole path exists to
            // handle honestly: a selection is a real library the member chose,
            // and backing up nothing while they watch their chosen photographs
            // sit there is the failure.
            answer == MediaPermission.MEDIA_PERMISSION_LIMITED
        ) {
            once()
        }
    }

    /**
     * "IMPORT NOW": passes until the roll is walked, not one page.
     *
     * One [CameraRoll.pass] is bounded so that a background window can finish
     * one; a member who pressed the button meant their camera roll, so passes
     * follow each other while the last one ended mid-roll
     * ([BackupState.Phase.PHASE_TRANSFERRING]) and stop at the first that did
     * not — done, waiting on the transfer rule, parked, or refused. The durable
     * cursor is what makes each one start where the last stopped, and
     * [MAX_PASSES] is the ceiling a cursor that failed to advance could never
     * run past. The automatic triggers — a grant, a library change, a
     * `Backup` effect — stay one bounded pass each ([once]).
     */
    public suspend fun pass() {
        val vault = vaultId() ?: return
        if (!passing.tryLock()) return
        try {
            repeat(MAX_PASSES) {
                val report = roll.pass(vault) { state -> scope.launch { publish(state) } }
                if (report.enumerated == 0 ||
                    report.state.phase != BackupState.Phase.PHASE_TRANSFERRING
                ) {
                    return
                }
            }
        } finally {
            passing.unlock()
        }
    }

    /**
     * One pass, if one is not already running, with every state it publishes
     * reaching the screen as a `BackupChanged` event.
     *
     * The states are sent through [ScreenHost.send] rather than written onto
     * the state directly, because the reducer is the only thing that may decide
     * what a state becomes — a runner that assigned `backup` would be a second
     * writer of a screen's state and would lose whatever the reducer did
     * between two of its own frames.
     */
    private suspend fun once() {
        val vault = vaultId() ?: return
        if (!passing.tryLock()) return
        try {
            roll.pass(vault) { state -> scope.launch { publish(state) } }
        } finally {
            passing.unlock()
        }
    }

    private companion object {
        /** A hundred thousand items at `CameraRoll.PAGE`, and never a loop. */
        const val MAX_PASSES: Int = 4_000
    }

    private suspend fun publish(state: BackupState) {
        host.send(PhotosGridEvent(backup = PhotosGridEvent.BackupChanged(backup = state)))
    }
}
