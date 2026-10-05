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
import dev.centraid.shared.sync.CoreFreeUpDoors
import dev.centraid.shared.sync.CoreOriginals
import dev.centraid.shared.sync.DeleteCapability
import dev.centraid.shared.sync.DeleteOutcome
import dev.centraid.shared.sync.DrainCopy
import dev.centraid.shared.sync.FreeUpDoors
import dev.centraid.shared.sync.LibraryDeleter
import dev.centraid.shared.sync.ReleasableList
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
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
 * Two surfaces over the core's originals doors: an album shelf's switch,
 * which puts that album on this phone's keep list, and the More sheet's row,
 * which says what freeing space would reclaim and does it. The reducer halves
 * are pure functions here so [PhotoShelfMachine] and [PhotosGridMachine] each
 * carry one line per event; the I/O halves are the two `attach` functions and
 * [FreeUpFlow], which answer a host through its own events — the reducer stays
 * the only writer of a screen's state.
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

    /** WHY NOTHING CAN BE FREED YET: no original is whole on a gateway. */
    public const val NOTHING_SAFE: String =
        "None can be freed yet. An original can be freed once a gateway holds every part of it."

    /** The core could not say what is safe, so nothing is offered. */
    public const val NOT_CHECKED: String =
        "Centraid could not check which originals are safe on your gateways, so none is offered."

    /** The action: "Free up 2 GB". */
    public const val FREE_UP_ACTION: String = "Free up {size}"

    /** The notice after a free-up. */
    public const val FREED: String =
        "Freed {size}. Those photos stay in Centraid and come back from your gateways when you open one."

    /** The member said no in the system's dialog, or nothing could go. */
    public const val NOTHING_REMOVED: String = "Nothing was removed."

    /** The library let them go and the core did not record it. */
    public const val NOT_RECORDED: String =
        "The photos were removed from this phone. Centraid shows them as fetchable once it catches up."

    /** How many originals a gateway holds whole, in the row's words. */
    public fun safe(count: Int): String =
        if (count == 1) "1 photo is safe on your gateways." else "$count photos are safe on your gateways."

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
    public fun counting(): FreeUpSpace = FreeUpSpace(offered = true, counted = false, meta = COUNTING)

    /**
     * The row from what the core counted. [census] null is [NOT_COUNTED], never
     * zero; [releasable] null is [NOT_CHECKED], which offers nothing. The
     * action frees exactly what [releasable] lists, so its size is theirs.
     */
    public fun freeUp(
        census: CoreOriginals.Census?,
        releasable: ReleasableList?,
        capability: DeleteCapability = DeleteCapability.SYSTEM_CONFIRMATION,
        notice: String = "",
    ): FreeUpSpace {
        // NO ROW AT ALL where nothing can delete (A20): an action this phone
        // cannot take is not offered, and the count alone is no help to a
        // member deciding whether to free anything.
        if (capability != DeleteCapability.SYSTEM_CONFIRMATION) return FreeUpSpace(offered = false)
        if (census == null) return FreeUpSpace(offered = true, counted = false, meta = NOT_COUNTED, notice = notice)
        if (census.onPhoneCount <= 0L) {
            return FreeUpSpace(offered = true, counted = true, meta = "No originals on this phone", notice = notice)
        }
        val noun = if (census.onPhoneCount == 1L) "original" else "originals"
        val kept = when {
            census.keptCount <= 0L -> ""
            census.keptCount == 1L -> " One of them is in an album you keep on this phone."
            else -> " ${census.keptCount} of them are in albums you keep on this phone."
        }
        val row = FreeUpSpace(
            offered = true,
            counted = true,
            meta = "${census.onPhoneCount} $noun · ${DrainCopy.bytes(census.onPhoneBytes)} on this phone",
            notice = notice,
        )
        val items = releasable?.items.orEmpty()
        return when {
            releasable == null -> row.copy(reason = NOT_CHECKED + kept)
            items.isEmpty() -> row.copy(reason = NOTHING_SAFE + kept)
            else -> {
                val bytes = items.sumOf { it.size }
                row.copy(
                    reason = safe(items.size) + kept,
                    action_label = FREE_UP_ACTION.replace("{size}", DrainCopy.bytes(bytes)),
                    enabled = true,
                    releasable_count = items.size,
                    releasable_bytes = bytes,
                )
            }
        }
    }

    /**
     * The member tapped the action. **Null is "ignore"**: before the count,
     * with nothing to free, or while a free-up is already in the system's hands.
     */
    public fun tapped(row: FreeUpSpace?): FreeUpSpace? =
        row?.takeIf { it.counted && it.enabled && !it.freeing }?.copy(freeing = true, notice = "")

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
     * a census lists the whole content store. A tap ([tapped]) is run by
     * [FreeUpFlow.free], and its answer is the next count.
     */
    public fun attachGrid(
        session: HomeSession,
        host: ScreenHost<PhotosGridState, PhotosGridEvent>,
        scope: CoroutineScope,
    ) {
        val door = CoreOriginals { session.shelf.core() }
        val flow = FreeUpFlow(CoreFreeUpDoors { session.shelf.core() }, { door.census()?.census }) {
            session.libraryDeleter
        }
        fun counted(row: FreeUpSpace) = PhotosGridEvent(free_up_counted = PhotosGridEvent.FreeUpCounted(row))
        scope.launch {
            host.state
                .map { it.sheet == PhotosGridState.Sheet.SHEET_MORE }
                .distinctUntilChanged()
                .filter { it }
                .collect {
                    // NOTHING TO COUNT FOR where nothing can delete: no row.
                    if (flow.capability() == DeleteCapability.SYSTEM_CONFIRMATION) host.send(counted(counting()))
                    host.send(counted(flow.count()))
                }
        }
        scope.launch {
            host.state
                .map { it.free_up?.freeing == true }
                .distinctUntilChanged()
                .filter { it }
                .collect { host.send(counted(flow.free())) }
        }
    }
}

/**
 * FREE UP SPACE, RUN (#1080 A19, A20).
 *
 * Ask the core what is safe to free, hand those items to the shell's installed
 * [LibraryDeleter] — which shows the system's own confirmation and removes
 * whole assets — then tell the core exactly the hashes that went, and count
 * again. Every answer is a row ([KeepOriginals.freeUp]) carrying what happened
 * as its `notice`. The deleter is read at each use: Android installs and
 * clears its own with the activity.
 */
public class FreeUpFlow(
    private val doors: FreeUpDoors,
    private val census: suspend () -> CoreOriginals.Census?,
    private val deleter: () -> LibraryDeleter?,
) {
    /** What the installed deleter can do; NONE when none is installed. */
    public fun capability(): DeleteCapability = deleter()?.capability() ?: DeleteCapability.NONE

    /** The row as it stands, with [notice] on it. */
    public suspend fun count(notice: String = ""): FreeUpSpace {
        val capability = capability()
        if (capability != DeleteCapability.SYSTEM_CONFIRMATION) return KeepOriginals.freeUp(null, null, capability)
        return KeepOriginals.freeUp(census(), doors.releasable(LIMIT), capability, notice)
    }

    /** Free what is safe; answers the row recounted, saying what happened. */
    public suspend fun free(): FreeUpSpace {
        val hand = deleter()?.takeIf { it.capability() == DeleteCapability.SYSTEM_CONFIRMATION } ?: return count()
        val list = doors.releasable(LIMIT) ?: return count(KeepOriginals.NOT_CHECKED)
        val items = list.items.filter { it.osRef.isNotEmpty() }
        if (items.isEmpty()) return count(KeepOriginals.NOTHING_REMOVED)
        val outcome = suspendCancellableCoroutine<DeleteOutcome> { asked ->
            hand.delete(items) { answer -> if (asked.isActive) asked.resume(answer) }
        }
        // ONLY WHAT THE PLATFORM SAYS WENT is reported, by the hash it named.
        val gone = outcome.deleted.map { it.toList() }.toSet()
        val freed = items.filter { it.contentHash.toList() in gone }
        val notice = when {
            freed.isNotEmpty() && doors.released(freed.map { it.contentHash }) == null -> KeepOriginals.NOT_RECORDED
            freed.isNotEmpty() -> KeepOriginals.FREED.replace("{size}", DrainCopy.bytes(freed.sumOf { it.size }))
            outcome.error != null -> outcome.error
            else -> KeepOriginals.NOTHING_REMOVED
        }
        return count(notice)
    }

    public companion object {
        /** One tap frees at most this many originals, oldest first; the next tap frees more. */
        public const val LIMIT: Long = 1_000
    }
}
