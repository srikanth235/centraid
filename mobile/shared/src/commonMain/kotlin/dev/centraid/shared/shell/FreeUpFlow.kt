package dev.centraid.shared.shell

import dev.centraid.shared.sync.CoreOriginals
import dev.centraid.shared.sync.DeleteCapability
import dev.centraid.shared.sync.DeleteOutcome
import dev.centraid.shared.sync.FreeUpDoors
import dev.centraid.shared.sync.LibraryDeleter
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * FREE UP SPACE, RUN (#1080 A19, A20): the shell's half. Ask the core what is
 * safe to free, hand those items to the installed [LibraryDeleter] (which shows
 * the system's own confirmation and removes whole assets), tell the core exactly
 * the hashes that went, and count again. Every answer is the [Facts] Rust makes
 * the row's sentences from (`photos::keep_originals`); this holds none.
 *
 * The deleter is read at each use: Android installs and clears its own with the
 * activity.
 */
public class FreeUpFlow(
    private val doors: FreeUpDoors,
    private val census: suspend () -> CoreOriginals.Census?,
    private val deleter: () -> LibraryDeleter?,
) {
    /** What the platform and the core said, as the screen takes it. */
    public data class Facts(
        val offered: Boolean = false,
        val counted: Boolean = false,
        val onPhoneCount: Long = 0,
        val onPhoneBytes: Long = 0,
        val keptCount: Long = 0,
        val checked: Boolean = false,
        val releasableCount: Int = 0,
        val releasableBytes: Long = 0,
        val outcome: Outcome = Outcome.NONE,
        val freedBytes: Long = 0,
        val platformError: String = "",
    )

    public enum class Outcome { NONE, FREED, NOTHING_REMOVED, NOT_RECORDED, NOT_CHECKED, PLATFORM_ERROR }

    /** What the installed deleter can do; NONE when none is installed. */
    public fun capability(): DeleteCapability = deleter()?.capability() ?: DeleteCapability.NONE

    /** The row as it stands, with [outcome] on it. */
    public suspend fun count(outcome: Outcome = Outcome.NONE, freedBytes: Long = 0, platformError: String = ""): Facts {
        if (capability() != DeleteCapability.SYSTEM_CONFIRMATION) return Facts(offered = false)
        val found = census()
        val list = doors.releasable(LIMIT)
        val items = list?.items.orEmpty()
        return Facts(
            offered = true,
            counted = found != null,
            onPhoneCount = found?.onPhoneCount ?: 0,
            onPhoneBytes = found?.onPhoneBytes ?: 0,
            keptCount = found?.keptCount ?: 0,
            checked = list != null,
            releasableCount = items.size,
            releasableBytes = items.sumOf { it.size },
            outcome = outcome,
            freedBytes = freedBytes,
            platformError = platformError,
        )
    }

    /** Free what is safe; answers the row recounted, saying what happened. */
    public suspend fun free(): Facts {
        val hand = deleter()?.takeIf { it.capability() == DeleteCapability.SYSTEM_CONFIRMATION } ?: return count()
        val list = doors.releasable(LIMIT) ?: return count(Outcome.NOT_CHECKED)
        val items = list.items.filter { it.osRef.isNotEmpty() }
        if (items.isEmpty()) return count(Outcome.NOTHING_REMOVED)
        val outcome = suspendCancellableCoroutine<DeleteOutcome> { asked ->
            hand.delete(items) { answer -> if (asked.isActive) asked.resume(answer) }
        }
        // ONLY WHAT THE PLATFORM SAYS WENT is reported, by the hash it named.
        val gone = outcome.deleted.map { it.toList() }.toSet()
        val freed = items.filter { it.contentHash.toList() in gone }
        return when {
            freed.isNotEmpty() && doors.released(freed.map { it.contentHash }) == null ->
                count(Outcome.NOT_RECORDED)
            freed.isNotEmpty() -> count(Outcome.FREED, freedBytes = freed.sumOf { it.size })
            outcome.error != null -> count(Outcome.PLATFORM_ERROR, platformError = outcome.error.orEmpty())
            else -> count(Outcome.NOTHING_REMOVED)
        }
    }

    public companion object {
        /** One tap frees at most this many originals, oldest first; the next tap frees more. */
        public const val LIMIT: Long = 1_000
    }
}
