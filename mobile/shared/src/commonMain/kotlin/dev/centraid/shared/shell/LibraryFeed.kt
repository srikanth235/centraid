package dev.centraid.shared.shell

import dev.centraid.core.CentraidCore
import dev.centraid.shared.platform.MediaLibrary
import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.sync.NeededBytes
import dev.centraid.shared.sync.TransferRule

/**
 * THE BYTES A PASS ASKED FOR, FROM THE OS LIBRARY (#1080; seam contract A4, A8).
 *
 * The stage door seals an original in the import's own stream when it can. When
 * the spool had no room, the core kept the item's content hash and `os_ref` and
 * names it in `DrainResponse.need_bytes` once there is room again; a pass then
 * hands that list here (`ShelfDrain`'s `feed`). Each is reopened from the
 * library by its `os_ref` and streamed in again exactly as the walker staged it
 * — `source = OS_LIBRARY`, the same ref — and the core checks the bytes against
 * the hash it asked for.
 *
 * **Landed means the hash matched.** A ref that no longer finds those bytes —
 * the photograph was deleted, or lives only in iCloud on a link the rule keeps
 * it off — lands nothing, and `ShelfDrain` stops asking once a round lands
 * nothing new, so a library that will not produce a photograph cannot spin.
 */
public class LibraryFeed(
    private val services: PlatformServices,
    /** The open core of one held vault, or null when it is resting or gone. */
    private val coreFor: (vaultId: String) -> CentraidCore?,
) {
    /** Stream [needs] into [vaultId]'s core; answers how many landed under the hash asked for. */
    public suspend fun feed(vaultId: String, needs: List<NeededBytes>): Int {
        val core = coreFor(vaultId) ?: return 0
        var landed = 0
        for (need in needs) {
            if (need.osRef.isEmpty()) continue
            val opened = services.mediaLibrary.open(need.osRef, mayFetch(need.mediaType)) as? MediaLibrary.Opened.Ready
                ?: continue
            val original = opened.original
            val outcome = try {
                Staging.stage(
                    core = core,
                    mediaType = need.mediaType.ifEmpty { original.mediaType },
                    byteSize = need.size,
                    source = Staging.Source.OS_LIBRARY,
                    osRef = need.osRef,
                    read = original::read,
                )
            } catch (failed: IllegalStateException) {
                // A STREAM THAT BROKE is this item's, not the round's.
                null
            } finally {
                original.close()
            }
            if ((outcome as? Staging.Outcome.Ok)?.staged?.contentHash == need.contentHash) landed += 1
        }
        return landed
    }

    /**
     * May this round download an original from iCloud? The walker's rule
     * (`CameraRoll.mayFetch`), read from what the platform says right now:
     * an unknown link is metered, and a video never crosses a metered one.
     */
    private suspend fun mayFetch(mediaType: String): Boolean {
        val metered = services.powerAndLink.metered() ?: true
        if (!metered) return true
        return TransferRule.read(services.secureStore) == TransferRule.WIFI_AND_CELLULAR_PHOTOS &&
            mediaType.startsWith("image/")
    }
}
