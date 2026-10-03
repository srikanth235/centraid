package dev.centraid.shared.sync

import dev.centraid.core.CentraidCore
import okio.ByteString.Companion.toByteString

/**
 * One original that may leave this phone (`Releasable`, seam contract A19,
 * A20): every content hash under its `os_ref` is confirmed by a gateway, it is
 * not edited, and it is in no album the member keeps here.
 *
 * The shells receive these whole ([LibraryDeleter.delete]): the hash to answer
 * with, the reference to delete by, and the media type, so Android can pick
 * the collection a uri belongs to.
 */
public class ReleasableItem(
    /** The content hash, raw — what [DeleteOutcome.deleted] hands back. */
    public val contentHash: ByteArray,
    /** The library's reference — what the walker staged it under. */
    public val osRef: String,
    public val size: Long,
    public val mediaType: String,
) {
    /** Lowercase hex, as every content hash above the wire is ([ContentHash]). */
    public val hex: String get() = ContentHash.hex(contentHash.toByteString())

    override fun equals(other: Any?): Boolean = other is ReleasableItem &&
        other.contentHash.contentEquals(contentHash) && other.osRef == osRef &&
        other.size == size && other.mediaType == mediaType

    override fun hashCode(): Int = contentHash.contentHashCode() * 31 + osRef.hashCode()

    override fun toString(): String = "ReleasableItem($hex, $osRef, $size, $mediaType)"
}

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

    /** The originals the platform deleted, by raw content hash; answers how many the core recorded. */
    public suspend fun released(contentHashes: List<ByteArray>): Int?
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

    override suspend fun released(contentHashes: List<ByteArray>): Int? = null
}

/**
 * THE SHELL'S HAND ON THE OS LIBRARY (#1080 A20), installed — never expected.
 *
 * iOS installs one through `HomeBridge.installLibraryDeleter`; Android
 * installs its own on `HomeSession.installLibraryDeleter` when the activity is
 * created and clears it when the activity is destroyed, because it holds the
 * activity's launcher for the system's confirmation. **The core never deletes
 * from the library**; this is the one place anything does.
 */
public interface LibraryDeleter {
    /** Whether this platform can delete behind the system's own confirmation. */
    public fun capability(): DeleteCapability

    /**
     * Remove [items] from the library behind the system's confirmation
     * (`PHAssetChangeRequest.deleteAssets` on iOS, `MediaStore.createDeleteRequest`
     * on Android 11 and up) and answer through [done], once, with what went.
     * An asset is removed whole or not at all.
     */
    public fun delete(items: List<ReleasableItem>, done: (DeleteOutcome) -> Unit)
}

/** Whether a free-up can be offered at all. */
public enum class DeleteCapability {
    /** The system shows its own confirmation and deletes on a yes. */
    SYSTEM_CONFIRMATION,

    /** Nothing here can delete: the More sheet draws no row. */
    NONE,
}

/**
 * What a [LibraryDeleter.delete] came to. Only [deleted] is reported to the
 * core (`released`); [declined] is the member's no in the system's dialog;
 * [error] is the platform's own words when it could not.
 */
public class DeleteOutcome(
    /** Raw content hashes of the items the platform removed. */
    public val deleted: List<ByteArray>,
    public val declined: Boolean,
    public val error: String?,
)
