package dev.centraid.shared.shell

import centraid.core.v1.FreeUpFacts
import centraid.core.v1.OriginalFetchOutcome
import centraid.core.v1.OriginalFetched
import centraid.core.v1.PhotosBackupChanged
import centraid.core.v1.PhotosBackupPhase
import centraid.core.v1.PhotosHomeEvent
import centraid.core.v1.PhotosMediaPermission
import centraid.core.v1.PhotosPermissionChanged
import centraid.screen.v1.BackupState
import centraid.screen.v1.MediaPermission
import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.sync.CoreBackupDoors
import dev.centraid.shared.sync.CoreFreeUpDoors
import dev.centraid.shared.sync.CoreOriginals
import dev.centraid.shared.sync.FetchedOriginal
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * THE DEVICE'S HALF OF PHOTOS (#1135, lane D): what the Rust screens ask the
 * phone for that is not a screen's to do. Four jobs, none of which decides a word
 * a person reads:
 *
 * * **the camera roll** ([CameraRollRunner] over a [CameraRollSeat]): the OS
 *   prompt, a pass of the roll, and the grant and the pass's progress forwarded
 *   to the screen as events ([observe]);
 * * **free up space** ([FreeUpFlow]): count, or free behind the system's
 *   confirmation, answered as [FreeUpFacts] bytes;
 * * **an original back from the gateway** ([fetchOriginal]), answered as
 *   [OriginalFetched] bytes.
 *
 * Bytes, not objects, on every edge Swift crosses: Swift holds SwiftProtobuf's
 * messages and Kotlin Wire's, generated from one schema, so the encoded form is
 * what both agree on. Android uses the same class.
 */
public class PhotosDevice {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val seat = CameraRollSeat()
    private var roll: CameraRollRunner? = null
    private var freeUp: FreeUpFlow? = null
    private var session: HomeSession? = null

    /** Put the device's half on the session's core, and start serving. */
    public fun attach(session: HomeSession): Unit = attach(session, platformServices())

    /** [attach] with the platform given, for a test with fakes. */
    public fun attach(session: HomeSession, services: PlatformServices) {
        this.session = session
        val census = CoreOriginals { session.shelf.core() }
        freeUp = FreeUpFlow(CoreFreeUpDoors { session.shelf.core() }, { census.census()?.census }) {
            session.libraryDeleter
        }
        roll = CameraRollRunner(
            services = services,
            roll = CameraRoll(
                services = services,
                core = { session.shelf.core() },
                // A BACKUP IS A WRITE (#1029 F1). A vault that moved to the
                // member's other phone takes no photographs.
                readOnly = {
                    if (session.shelf.foregroundHolding()?.readOnly == true) Shelf.MOVED_SENTENCE else null
                },
            ),
            seat = seat,
            // READ AT EACH USE, not captured: a vault switch moves the
            // foreground, and a roll is walked once PER VAULT because a
            // photograph offered to two vaults is two uploads.
            vaultId = { session.shelf.foregroundHolding()?.vaultId },
            scope = scope,
            afterImport = { session.drain.afterImport() },
        ).also {
            it.start()
            // AND THE SESSION'S PASSES WALK IT (R-1029-PH-4): opening the app and
            // "Back up now" bring in what the member took while it was closed.
            it.follow(session.drain)
        }
    }

    /**
     * Forward the grant and the pass's progress to the screen, as encoded
     * `PhotosHomeEvent`s, starting with the current ones.
     */
    public fun observe(onEvent: (ByteArray) -> Unit) {
        scope.launch { seat.permission.collect { onEvent(permissionEvent(it)) } }
        scope.launch { seat.backup.collect { onEvent(backupEvent(it)) } }
    }

    /** The Photos cover is on screen: read the grant again (a read, never an ask). */
    public fun opened() {
        scope.launch { roll?.syncPermission() }
    }

    /** What a `CameraRoll` effect asked of the roll: 1 ask the prompt, 4 run a pass. */
    public fun perform(action: Int) {
        when (action) {
            ACTION_ASK_PERMISSION -> seat.request(CameraRollSeat.Request.ASK_PERMISSION)
            ACTION_IMPORT_NOW -> seat.request(CameraRollSeat.Request.IMPORT_NOW)
            else -> Unit
        }
    }

    /** Run one camera-roll pass now (a foreground wake, "Back up now"). */
    public fun backUpNow() {
        scope.launch { roll?.pass() }
    }

    /**
     * A VAULT WAS JUST MADE: ask for the camera roll and bring it in
     * (R-ONBOARD-8). [answered] runs once the platform has answered, before the
     * walk, which can take minutes.
     */
    public fun askForPhotos(answered: () -> Unit) {
        scope.launch {
            val runner = roll
            if (runner == null) answered() else runner.ask(answered)
        }
    }

    /** A `FreeUpSpace` effect: [free] false counts, true frees. Answers encoded [FreeUpFacts]. */
    public fun freeUp(free: Boolean, onFacts: (ByteArray) -> Unit) {
        scope.launch {
            val flow = freeUp
            val facts = if (flow == null) FreeUpFlow.Facts() else if (free) flow.free() else flow.count()
            onFacts(factsOf(facts).encode())
        }
    }

    /** A `FetchOriginal` effect. Answers encoded [OriginalFetched], the hash echoed. */
    public fun fetchOriginal(contentHash: String, onFetched: (ByteArray) -> Unit) {
        scope.launch {
            val pinned = session?.shelf?.core()
            val answer = CoreBackupDoors { pinned }.fetchOriginal(contentHash)
            val outcome = when (answer?.first) {
                FetchedOriginal.LANDED -> OriginalFetchOutcome.ORIGINAL_FETCH_OUTCOME_LANDED
                FetchedOriginal.ALREADY_HELD -> OriginalFetchOutcome.ORIGINAL_FETCH_OUTCOME_ALREADY_HELD
                FetchedOriginal.NOT_IN_BACKUP -> OriginalFetchOutcome.ORIGINAL_FETCH_OUTCOME_NOT_IN_BACKUP
                FetchedOriginal.UNTRUSTED -> OriginalFetchOutcome.ORIGINAL_FETCH_OUTCOME_UNTRUSTED
                FetchedOriginal.DAMAGED -> OriginalFetchOutcome.ORIGINAL_FETCH_OUTCOME_DAMAGED
                FetchedOriginal.UNREACHABLE, null -> OriginalFetchOutcome.ORIGINAL_FETCH_OUTCOME_UNREACHABLE
            }
            onFetched(
                OriginalFetched(outcome = outcome, path = answer?.second.orEmpty(), content_hash = contentHash).encode(),
            )
        }
    }

    /** Release the scope. */
    public fun close() {
        scope.cancel()
    }

    public companion object {
        /** `CameraRoll.Action` numbers, as the wire spells them. */
        public const val ACTION_ASK_PERMISSION: Int = 1
        public const val ACTION_IMPORT_NOW: Int = 4

        internal fun permissionEvent(permission: MediaPermission): ByteArray = PhotosHomeEvent(
            permission = PhotosPermissionChanged(
                permission = when (permission) {
                    MediaPermission.MEDIA_PERMISSION_NOT_ASKED -> PhotosMediaPermission.PHOTOS_MEDIA_PERMISSION_NOT_ASKED
                    MediaPermission.MEDIA_PERMISSION_GRANTED -> PhotosMediaPermission.PHOTOS_MEDIA_PERMISSION_GRANTED
                    MediaPermission.MEDIA_PERMISSION_LIMITED -> PhotosMediaPermission.PHOTOS_MEDIA_PERMISSION_LIMITED
                    MediaPermission.MEDIA_PERMISSION_DENIED -> PhotosMediaPermission.PHOTOS_MEDIA_PERMISSION_DENIED
                    MediaPermission.MEDIA_PERMISSION_RESTRICTED -> PhotosMediaPermission.PHOTOS_MEDIA_PERMISSION_RESTRICTED
                    MediaPermission.MEDIA_PERMISSION_UNSPECIFIED -> PhotosMediaPermission.PHOTOS_MEDIA_PERMISSION_UNSPECIFIED
                },
            ),
        ).encode()

        internal fun backupEvent(state: BackupState): ByteArray = PhotosHomeEvent(
            backup = PhotosBackupChanged(
                phase = when (state.phase) {
                    BackupState.Phase.PHASE_IDLE -> PhotosBackupPhase.PHOTOS_BACKUP_PHASE_IDLE
                    BackupState.Phase.PHASE_ENUMERATING -> PhotosBackupPhase.PHOTOS_BACKUP_PHASE_ENUMERATING
                    BackupState.Phase.PHASE_TRANSFERRING -> PhotosBackupPhase.PHOTOS_BACKUP_PHASE_TRANSFERRING
                    BackupState.Phase.PHASE_WAITING_FOR_POWER -> PhotosBackupPhase.PHOTOS_BACKUP_PHASE_WAITING_FOR_POWER
                    BackupState.Phase.PHASE_WAITING_FOR_UNMETERED -> PhotosBackupPhase.PHOTOS_BACKUP_PHASE_WAITING_FOR_UNMETERED
                    BackupState.Phase.PHASE_PARKED_LOW_DISK -> PhotosBackupPhase.PHOTOS_BACKUP_PHASE_PARKED_LOW_DISK
                    BackupState.Phase.PHASE_DONE -> PhotosBackupPhase.PHOTOS_BACKUP_PHASE_DONE
                    BackupState.Phase.PHASE_UNSPECIFIED -> PhotosBackupPhase.PHOTOS_BACKUP_PHASE_UNSPECIFIED
                },
                assets_transferred_this_session = state.assets_transferred_this_session,
                assets_remaining = state.assets_remaining,
                paused_reason = state.paused_reason,
            ),
        ).encode()

        internal fun factsOf(facts: FreeUpFlow.Facts): FreeUpFacts = FreeUpFacts(
            offered = facts.offered,
            counted = facts.counted,
            on_phone_count = facts.onPhoneCount.toInt(),
            on_phone_bytes = facts.onPhoneBytes,
            kept_count = facts.keptCount.toInt(),
            checked = facts.checked,
            releasable_count = facts.releasableCount,
            releasable_bytes = facts.releasableBytes,
            outcome = when (facts.outcome) {
                FreeUpFlow.Outcome.NONE -> FreeUpFacts.Outcome.OUTCOME_UNSPECIFIED
                FreeUpFlow.Outcome.FREED -> FreeUpFacts.Outcome.OUTCOME_FREED
                FreeUpFlow.Outcome.NOTHING_REMOVED -> FreeUpFacts.Outcome.OUTCOME_NOTHING_REMOVED
                FreeUpFlow.Outcome.NOT_RECORDED -> FreeUpFacts.Outcome.OUTCOME_NOT_RECORDED
                FreeUpFlow.Outcome.NOT_CHECKED -> FreeUpFacts.Outcome.OUTCOME_NOT_CHECKED
                FreeUpFlow.Outcome.PLATFORM_ERROR -> FreeUpFacts.Outcome.OUTCOME_PLATFORM_ERROR
            },
            freed_bytes = facts.freedBytes,
            platform_error = facts.platformError,
        )
    }
}
