package dev.centraid.shared.apps.photos

import centraid.screen.v1.KeepOriginalsRow
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotoShelfEvent
import centraid.screen.v1.PhotoShelfState
import dev.centraid.design.copy.PhotosCopy
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.CoreOriginals
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * "KEEP ORIGINALS ON THIS PHONE" AND "FREE UP SPACE" (#1029, the photos port —
 * v0's `album-keep-originals.ts`, `photos-library-pins.ts` and
 * `free-up-space.ts`).
 *
 * Two surfaces over the core's originals doors: an album shelf's switch,
 * which puts that album on this phone's keep list, and the More sheet's row,
 * which says what freeing space would reclaim and does it. The reducer halves
 * are pure functions here so [PhotoShelfMachine] carries one line per event; the
 * I/O half is `attachShelf`, which answers a host through its own events. The
 * More sheet's row is Rust's now (`photos::keep_originals`), and the free-up work
 * the phone does is [dev.centraid.shared.shell.FreeUpFlow].
 *
 * ## "FREE UP SPACE" IS A VERB AGAIN (#1080 A19)
 *
 * v0 deleted a device original only where a copy elsewhere was PROVED, and
 * until #1080 nothing could prove one: the backup carried rows and never an
 * original's bytes, so the row was a statement (R-1029-PH-1, superseded). Now
 * a gateway acknowledges every part of an original, and the core's
 * `releasable` door names the library originals whose every part a gateway
 * confirmed, outside the albums kept here. Only those are offered, the
 * platform deletes them behind the system's own confirmation, and the core is
 * told which went (`released`) so the grid shows them as fetchable. The keep
 * list is the member's standing answer, and the core reads it to leave those
 * albums out.
 */
public object KeepOriginals {

    /** The switch's own words. */
    public const val TITLE: String = PhotosCopy.PHOTOS_KEEP_ORIGINALS_TITLE

    /** Its spoken label, which says what the switch acts on. */
    public const val LABEL: String = PhotosCopy.PHOTOS_KEEP_ORIGINALS_LABEL

    /** Before the keep list has answered for this album (v0's `pinsReady`). */
    public const val CHECKING: String = "Checking this album's originals"

    /** A list the core would not read or write. The switch stays disabled. */
    public const val UNREADABLE: String =
        "This album's setting could not be read."

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
}
