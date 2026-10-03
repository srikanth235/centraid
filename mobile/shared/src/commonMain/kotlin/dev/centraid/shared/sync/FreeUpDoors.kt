package dev.centraid.shared.sync

import dev.centraid.core.CentraidCore

/**
 * One original that may leave this phone (`Releasable`, seam contract A19): it
 * lives in the OS library, a gateway confirmed every part of it, and it is in
 * no album the member keeps here.
 */
public data class ReleasableItem(
    /** Lowercase hex, as every content hash above the wire is ([ContentHash]). */
    public val contentHash: String,
    /** The library's reference — what the walker staged it under. */
    public val osRef: String,
    public val size: Long,
    public val mediaType: String,
)

/** What `releasable` answered: oldest first, and their size on this phone. */
public data class ReleasableList(
    public val items: List<ReleasableItem>,
    public val totalBytes: Long,
)

/**
 * THE TWO FREE-UP DOORS (#1080 A19: `releasable = 29`, `released = 30`).
 * Null is "no answer" — no core, a refusal, or an arm not yet available — and
 * never an empty list: a row offered over a list nobody produced would be a
 * verb nobody vouched for.
 */
public interface FreeUpDoors {
    /** At most [limit] releasable originals, oldest first. */
    public suspend fun releasable(limit: Long): ReleasableList?

    /** The originals the member deleted from the library; answers how many the core recorded. */
    public suspend fun released(contentHashes: List<String>): Int?
}

/**
 * The doors over the core's wire.
 *
 * **UNTIL THE TWO ARMS LAND** (lane C's next `envelope.proto` slice) both
 * answer null, exactly as a refused arm does, so the More sheet says it could
 * not check rather than offering to free anything. The switch to the
 * generated `ReleasableRequest` and `ReleasedRequest` is this class alone.
 */
public class CoreFreeUpDoors(private val core: () -> CentraidCore?) : FreeUpDoors {
    override suspend fun releasable(limit: Long): ReleasableList? = null

    override suspend fun released(contentHashes: List<String>): Int? = null
}
