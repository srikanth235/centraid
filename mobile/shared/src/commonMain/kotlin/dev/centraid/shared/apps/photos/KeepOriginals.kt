package dev.centraid.shared.apps.photos

import centraid.screen.v1.FreeUpSpace
import centraid.screen.v1.KeepOriginalsRow
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotoShelfEvent
import centraid.screen.v1.PhotoShelfState
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.PhotosGridState
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.CoreOriginals
import dev.centraid.shared.sync.DrainCopy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * "KEEP ORIGINALS ON THIS PHONE" AND "FREE UP SPACE" (#1029, the photos port —
 * v0's `album-keep-originals.ts`, `photos-library-pins.ts` and
 * `free-up-space.ts`).
 *
 * Two surfaces over one core door ([CoreOriginals]): an album shelf's switch,
 * which puts that album on this phone's keep list, and the More sheet's row,
 * which says what freeing space could reclaim. The reducer halves are pure
 * functions here so [PhotoShelfMachine] and [PhotosGridMachine] each carry one
 * line per event; the I/O halves are the two `attach` functions, which watch a
 * host's state and answer it through its own events — the reducer stays the
 * only writer of a screen's state.
 *
 * ## WHY "FREE UP SPACE" IS A STATEMENT AND NOT A BUTTON
 *
 * v0 deleted a device original only where a copy elsewhere was PROVED. On a
 * phone that is the vault, the only copy elsewhere is the laptop's backup, and
 * that backup carries the vault's rows and never an original's bytes
 * (`originals.proto`, R-1029-PH-1). So every original on this phone is the
 * only copy of itself, and the row says exactly that — with the count and the
 * size, which is what a member deciding whether to worry needs — rather than
 * offering a verb whose only possible effect is to destroy a photograph. The
 * keep list is live all the same: it is the member's standing answer, and the
 * census already reads it to say how much of this phone's library is kept.
 */
public object KeepOriginals {

    /** The switch's own words. */
    public const val TITLE: String = "Keep originals on this phone"

    /** Its spoken label, which says what the switch acts on. */
    public const val LABEL: String = "Keep this album's originals on this phone"

    /** Before the keep list has answered for this album (v0's `pinsReady`). */
    public const val CHECKING: String = "Checking this album's originals"

    /** A list the core would not read or write. The switch stays disabled. */
    public const val UNREADABLE: String =
        "This phone's keep list could not be read, so this album's setting is not shown."

    /** The More sheet row's title. */
    public const val FREE_UP_TITLE: String = "Free up space"

    /** While the census runs. */
    public const val COUNTING: String = "Counting the originals on this phone…"

    /** A core that could not count — no content store, or a refused read. */
    public const val NOT_COUNTED: String = "Not counted yet."

    /**
     * WHY NOTHING CAN BE FREED. A fact about the backup, stated plainly, and
     * the reason the row has no verb.
     */
    public const val NOT_BACKED_UP: String =
        "None can be freed yet. Your laptop's backup does not hold originals, " +
            "so this phone has the only copy of each."

    // -----------------------------------------------------------------------
    // The album shelf's switch — reducer halves
    // -----------------------------------------------------------------------

    /**
     * The row a freshly opened shelf starts with. Offered on an album and on
     * nothing else: a switch on the favourites would be a keep list of a
     * predicate, which is not a thing the list can hold.
     */
    public fun opened(shelf: PhotoShelf?): KeepOriginalsRow =
        if (shelf?.album != null) {
            KeepOriginalsRow(offered = true, ready = false, meta = CHECKING)
        } else {
            KeepOriginalsRow()
        }

    /**
     * The member flipped the switch. **Null is "ignore"**: before the list has
     * answered, while a change is already on its way, or a flip to the value it
     * already holds. The row shows the member's answer at once and holds still
     * until the list confirms it.
     */
    public fun toggled(row: KeepOriginalsRow?, keep: Boolean): KeepOriginalsRow? =
        row?.takeIf { it.offered && it.ready && !it.saving && it.keep != keep }
            ?.copy(keep = keep, saving = true, meta = meta(keep))

    /**
     * What the list said about [albumId]. **Null is "not this album's
     * answer"** — one that landed after the member moved to another album, or
     * on a shelf that offers no row.
     */
    public fun settled(
        row: KeepOriginalsRow?,
        shownAlbumId: String?,
        albumId: String,
        keep: Boolean,
        refusal: String,
    ): KeepOriginalsRow? {
        if (row == null || !row.offered || shownAlbumId != albumId) return null
        return if (refusal.isEmpty()) {
            row.copy(ready = true, saving = false, keep = keep, meta = meta(keep))
        } else {
            row.copy(ready = false, saving = false, keep = false, meta = refusal)
        }
    }

    /**
     * The line under the switch, derived from the switch (v0's
     * `keepOriginalsMeta`). It used to be the constant "Excluded from Free up
     * vault", which printed a fact that was false whenever the switch was off.
     */
    public fun meta(keep: Boolean): String =
        if (keep) "Kept out of Free up space" else "Included in Free up space"

    // -----------------------------------------------------------------------
    // The More sheet's row
    // -----------------------------------------------------------------------

    /** The row while the census runs. */
    public fun counting(): FreeUpSpace = FreeUpSpace(counted = false, meta = COUNTING)

    /** The row from what the core counted; null is [NOT_COUNTED], never zero. */
    public fun freeUp(census: CoreOriginals.Census?): FreeUpSpace {
        if (census == null) return FreeUpSpace(counted = false, meta = NOT_COUNTED)
        if (census.onPhoneCount <= 0L) {
            return FreeUpSpace(counted = true, meta = "No originals on this phone")
        }
        val noun = if (census.onPhoneCount == 1L) "original" else "originals"
        val kept = when {
            census.keptCount <= 0L -> ""
            census.keptCount == 1L -> " One of them is in an album you keep on this phone."
            else -> " ${census.keptCount} of them are in albums you keep on this phone."
        }
        return FreeUpSpace(
            counted = true,
            meta = "${census.onPhoneCount} $noun · ${DrainCopy.bytes(census.onPhoneBytes)} on this phone",
            reason = NOT_BACKED_UP + kept,
        )
    }

    // -----------------------------------------------------------------------
    // The I/O halves
    // -----------------------------------------------------------------------

    /**
     * THE ALBUM SHELF'S SWITCH, served. Watches the shelf's album and its row:
     * a row that is checking asks for the list, a row that is saving writes
     * its answer, and either way the list's reply comes back as
     * `KeepOriginalsSettled` naming the album it is about.
     */
    public fun attachShelf(
        session: HomeSession,
        host: ScreenHost<PhotoShelfState, PhotoShelfEvent>,
        scope: CoroutineScope,
    ) {
        val door = CoreOriginals { session.shelf.core() }
        scope.launch {
            host.state
                .map { it.shelf?.album?.collection_id to it.keep_originals }
                .distinctUntilChanged()
                .collect { (albumId, row) ->
                    if (albumId == null || row == null || !row.offered) return@collect
                    val answer = when {
                        row.saving -> door.keep(albumId, row.keep)
                        !row.ready && row.meta == CHECKING -> door.kept()
                        else -> return@collect
                    }
                    host.send(
                        PhotoShelfEvent(
                            keep_originals_settled = PhotoShelfEvent.KeepOriginalsSettled(
                                keep = answer?.keptAlbumIds?.contains(albumId) == true,
                                refusal = if (answer == null) UNREADABLE else "",
                                album_id = albumId,
                            ),
                        ),
                    )
                }
        }
    }

    /**
     * THE MORE SHEET'S ROW, served. Counted each time the sheet opens, because
     * a count is only as fresh as the last import, and never while it is shut:
     * a census lists the whole content store.
     */
    public fun attachGrid(
        session: HomeSession,
        host: ScreenHost<PhotosGridState, PhotosGridEvent>,
        scope: CoroutineScope,
    ) {
        val door = CoreOriginals { session.shelf.core() }
        scope.launch {
            host.state
                .map { it.sheet == PhotosGridState.Sheet.SHEET_MORE }
                .distinctUntilChanged()
                .filter { it }
                .collect {
                    host.send(PhotosGridEvent(free_up_counted = PhotosGridEvent.FreeUpCounted(counting())))
                    val census = door.census()?.census
                    host.send(PhotosGridEvent(free_up_counted = PhotosGridEvent.FreeUpCounted(freeUp(census))))
                }
        }
    }
}
