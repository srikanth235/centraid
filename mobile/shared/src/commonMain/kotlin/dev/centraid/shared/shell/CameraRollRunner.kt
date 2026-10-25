package dev.centraid.shared.shell

import centraid.screen.v1.BackupState
import centraid.screen.v1.MediaPermission
import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.sync.ShelfDrain
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex

/**
 * THE CAMERA ROLL'S RUNNER (#1025 S6; #1135).
 *
 * The Photos screen is Rust's: it words the banner and offers the remedies, and
 * asks for them through a `CameraRoll` effect. The shell turns the effect into a
 * [CameraRollSeat.Request], which this runner serves: the OS prompt, and a pass
 * of the roll. What it learns goes back through the same seat (the grant, each
 * pass's state), and [PhotosDevice] forwards it to the screen as events.
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
    private val seat: CameraRollSeat,
    private val scope: CoroutineScope,
    /** Which vault the roll is being offered to. See [CameraRoll.cursorKey]. */
    private val vaultId: () -> String?,
    /**
     * A pass imported something: `ShelfDrain.afterImport`. The import seals
     * into the spool in the same stream when a destination is paired, so
     * what was just staged moves now rather than at the next window.
     */
    private val afterImport: suspend () -> Unit = {},
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
        seat.permissionChanged(services.mediaLibrary.permission())
    }

    /**
     * Serve the screen's requests, and hear the library.
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
            // TO THE END, after a walk already going: a burst of a hundred
            // photographs is more than one page, and a change that lands while
            // the last page is read must not be dropped (#1080, the simulator
            // edge cases).
            scope.launch { walkToEnd() }
        }
        return scope.launch {
            syncPermission()
            seat.requests.collect { request ->
                when (request) {
                    CameraRollSeat.Request.ASK_PERMISSION -> scope.launch { ask() }
                    CameraRollSeat.Request.IMPORT_NOW -> scope.launch { walkToEnd() }
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
    public suspend fun ask(answered: () -> Unit = {}) {
        val answer = services.mediaLibrary.requestPermission()
        seat.permissionChanged(answer)
        // The prompt is gone once the platform answers, so a caller with more
        // to ask (a made vault's other imports) asks now, not after the walk.
        answered()
        if (answer == MediaPermission.MEDIA_PERMISSION_GRANTED ||
            // LIMITED COUNTS, and it is the state this whole path exists to
            // handle honestly: a selection is a real library the member chose,
            // and backing up nothing while they watch their chosen photographs
            // sit there is the failure.
            answer == MediaPermission.MEDIA_PERMISSION_LIMITED
        ) {
            walkToEnd()
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
     * `Backup` effect, and the session's passes ([follow]) — walk to the end
     * too: only a background window needs a bounded page, and none walks.
     */
    public suspend fun pass() {
        val vault = vaultId() ?: return
        if (!passing.tryLock()) return
        walk(vault)
    }

    /**
     * THE WALK A PASS ASKS FOR: to the end of the roll, and AFTER a walk
     * already going rather than instead of it. "Back up now" that returned
     * while an earlier walk was still importing would run its asked pass
     * without what that walk brings in.
     */
    public suspend fun walkToEnd() {
        val vault = vaultId() ?: return
        passing.lock()
        walk(vault)
    }

    /**
     * FOLLOW THE SESSION'S PASSES (#1080, the simulator edge cases;
     * R-1029-PH-4): the app opening, the app becoming active and "Back up now"
     * walk the roll first ([ShelfDrain.installWalk]), and the roll is walked
     * once now — the app has just opened, and a roll the member filled while
     * Centraid was closed is this walk's to bring in.
     */
    public fun follow(drain: ShelfDrain) {
        drain.installWalk { walkToEnd() }
        scope.launch { walkToEnd() }
    }

    /**
     * Passes until the roll is walked, with every state they publish reaching
     * the [seat]. [passing] is held on entry and released here.
     */
    private suspend fun walk(vault: String) {
        var imported = 0
        try {
            repeat(MAX_PASSES) {
                val report = roll.pass(vault) { state -> scope.launch { publish(state) } }
                imported += report.queued - report.alreadyHeld
                if (report.enumerated == 0 ||
                    report.state.phase != BackupState.Phase.PHASE_TRANSFERRING
                ) {
                    return
                }
            }
        } finally {
            passing.unlock()
            if (imported > 0) scope.launch { afterImport() }
        }
    }

    private companion object {
        /** A hundred thousand items at `CameraRoll.PAGE`, and never a loop. */
        const val MAX_PASSES: Int = 4_000
    }

    private fun publish(state: BackupState) {
        seat.backupChanged(state)
    }
}
