package dev.centraid.shared.screen

import centraid.screen.v1.BackupState
import centraid.screen.v1.Loading
import centraid.screen.v1.MediaPermission
import centraid.screen.v1.PhotosGridData
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.PhotosGridState

/**
 * The Photos grid, with camera-roll backup (#1020, D-1020-E3).
 *
 * The screen where four of the census's traps meet: the OS grant is a state and
 * not a route, `more` is a sheet and not a destination, a failed read is not an
 * empty grid, and low disk PARKS rather than evicting.
 *
 * ## The distinction this screen exists to keep
 *
 * **The grid reads the VAULT; the backup reads the CAMERA ROLL.** They are two
 * planes with two permissions, and conflating them is how a denied media
 * permission blanks a library the member already owns. So a permission change
 * moves `backup` and never `content`.
 */
public object PhotosGridMachine : ScreenMachine<PhotosGridState, PhotosGridEvent> {
    public const val SCREEN_ID: String = "photos.grid"

    override fun initial(): PhotosGridState = PhotosGridState(
        destination = PhotosGridState.Destination.DESTINATION_LIBRARY,
        permission = MediaPermission.MEDIA_PERMISSION_NOT_ASKED,
        loading = Loading(first_load = true),
        sheet = PhotosGridState.Sheet.SHEET_NONE,
        backup = BackupState(phase = BackupState.Phase.PHASE_IDLE),
    )

    override fun reduce(state: PhotosGridState, event: PhotosGridEvent): Step<PhotosGridState> =
        when {
            event.opened != null -> firstLoad(state)

            // A BAND DESTINATION IS A PARAMETER (`navigation.ts:19-24`).
            event.destination != null ->
                firstLoad(state.copy(destination = event.destination.destination))

            event.next_page != null -> Step(
                state,
                listOf(ScreenEffect.ReadPage(SCREEN_ID, event.next_page.after_cursor)),
            )

            event.data_ != null -> Step(
                state.copy(
                    loading = null,
                    failure = null,
                    data_ = merge(state.data_, event.data_.data_),
                ),
            )

            event.refused != null -> {
                val failure = event.refused.failure
                Step(
                    state.copy(
                        loading = null,
                        data_ = null,
                        failure = failure,
                        // LOW DISK PARKS THE BACKUP TOO. One cause, two planes,
                        // and the member sees one sentence about each rather
                        // than a grid that fails and a backup that keeps
                        // claiming to run.
                        backup = if (Reads.isParked(failure)) {
                            (state.backup ?: BackupState()).copy(
                                phase = BackupState.Phase.PHASE_PARKED_LOW_DISK,
                                paused_reason = failure?.sentence ?: "",
                            )
                        } else {
                            state.backup
                        },
                    ),
                )
            }

            // AN OS PERMISSION IS A STATE, NOT A ROUTE (#712,
            // `navigation.ts:41-42`) — and it moves the BACKUP, never the grid.
            event.permission != null -> {
                val permission = event.permission.permission
                Step(
                    state.copy(
                        permission = permission,
                        backup = (state.backup ?: BackupState()).copy(
                            phase = if (canEnumerate(permission)) {
                                state.backup?.phase ?: BackupState.Phase.PHASE_IDLE
                            } else {
                                BackupState.Phase.PHASE_IDLE
                            },
                            paused_reason = pausedReason(permission),
                        ),
                    ),
                    // The ask is not re-issued from here: the answer arrived,
                    // and asking again on every answer is a permission prompt
                    // loop.
                )
            }

            event.permission_requested != null -> Step(
                state,
                listOf(ScreenEffect.RequestMediaPermission),
            )

            // A DISCRIMINATED UNION, NOT A BAG OF OPTIONALS
            // (`navigation.ts:43-46`). Opening a state view is a navigation
            // effect the shell performs; the grid's own state does not change,
            // which is why there is no `state_view` field on the state.
            event.state_view != null -> Step(state)

            // `more` IS A SHEET, NEVER A DESTINATION. It cannot change the
            // band, and the type system is what says so: `Sheet` and
            // `Destination` are two enums and neither admits the other's
            // values.
            event.sheet != null -> Step(state.copy(sheet = event.sheet.sheet))

            event.backup != null -> Step(state.copy(backup = event.backup.backup))

            event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

            else -> Step(state)
        }

    /**
     * Can the backup enumerate the camera roll?
     *
     * `LIMITED` COUNTS. iOS's limited selection is a real library the member
     * chose, and a backup that treated it as a denial would back up nothing
     * while the member watched their selected photos sit there.
     */
    public fun canEnumerate(permission: MediaPermission): Boolean = when (permission) {
        MediaPermission.MEDIA_PERMISSION_GRANTED,
        MediaPermission.MEDIA_PERMISSION_LIMITED,
        -> true

        MediaPermission.MEDIA_PERMISSION_UNSPECIFIED,
        MediaPermission.MEDIA_PERMISSION_NOT_ASKED,
        MediaPermission.MEDIA_PERMISSION_DENIED,
        MediaPermission.MEDIA_PERMISSION_RESTRICTED,
        -> false
    }

    /**
     * FOUR REASONS, FOUR SENTENCES. "Not asked" has a button, "denied" has a
     * trip to Settings, and "restricted" has neither — one sentence for all
     * three would be a sentence that is wrong for two of them.
     */
    private fun pausedReason(permission: MediaPermission): String = when (permission) {
        MediaPermission.MEDIA_PERMISSION_GRANTED -> ""
        MediaPermission.MEDIA_PERMISSION_LIMITED ->
            "Centraid backs up the photos you selected."
        MediaPermission.MEDIA_PERMISSION_NOT_ASKED ->
            "Centraid needs access to your photos to back them up."
        MediaPermission.MEDIA_PERMISSION_DENIED ->
            "Photo access is off. Turn it on in Settings to back up your camera roll."
        MediaPermission.MEDIA_PERMISSION_RESTRICTED ->
            "This device does not allow photo access."
        MediaPermission.MEDIA_PERMISSION_UNSPECIFIED -> ""
    }

    private fun firstLoad(state: PhotosGridState): Step<PhotosGridState> = Step(
        state.copy(
            loading = Loading(first_load = true),
            failure = null,
            data_ = null,
        ),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    private fun merge(existing: PhotosGridData?, arriving: PhotosGridData?): PhotosGridData? {
        if (arriving == null) return existing
        if (existing == null) return arriving
        val known = existing.cells.map { it.asset_id }.toSet()
        return arriving.copy(cells = existing.cells + arriving.cells.filterNot { it.asset_id in known })
    }
}
