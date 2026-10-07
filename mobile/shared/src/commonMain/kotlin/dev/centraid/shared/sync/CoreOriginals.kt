package dev.centraid.shared.sync

import centraid.core.v1.Envelope
import centraid.core.v1.KeepAlbumOriginals
import centraid.core.v1.KeptAlbumsRead
import centraid.core.v1.OriginalsCensusRead
import centraid.core.v1.OriginalsRequest
import centraid.core.v1.OriginalsResponse
import centraid.core.v1.Request
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome

/**
 * `originals = 19` — THE KEEP LIST AND THE CENSUS, AS THE SHELL'S DOOR (#1029,
 * the photos port; `crates/api-proto/proto/centraid/core/v1/originals.proto`).
 *
 * [CoreBackupStatus]'s shape: one `Envelope` per call over the ABI the session
 * already holds, the core asked of a SUPPLIER so a vault switch is followed,
 * and **null for every failure, never a throw**. What null means differs by
 * caller and each caller says: the album row reads it as "could not be read"
 * and disables its switch; the More sheet reads it as "not counted".
 *
 * There is no release verb here because there is none on the core — see
 * `originals.proto` for why no original can be released yet.
 */
public class CoreOriginals(private val core: () -> CentraidCore?) {

    /** The keep list as it stands. */
    public suspend fun kept(): Answer? = ask(OriginalsRequest(kept = KeptAlbumsRead()))

    /** Put one album on the keep list, or take it off. Idempotent. */
    public suspend fun keep(albumId: String, keep: Boolean): Answer? =
        ask(OriginalsRequest(keep = KeepAlbumOriginals(album_id = albumId, keep = keep)))

    /** The originals whole on this phone, and the kept share of them. */
    public suspend fun census(): Answer? = ask(OriginalsRequest(census = OriginalsCensusRead()))

    private suspend fun ask(request: OriginalsRequest): Answer? {
        val open = core() ?: return null
        val answer = open.call(Envelope(request_id = 0, request = Request(originals = request)))
        val originals: OriginalsResponse =
            (answer as? CoreOutcome.Answered)?.value?.response?.originals ?: return null
        return Answer(
            keptAlbumIds = originals.kept_album_ids.toSet(),
            census = originals.census?.let { found ->
                Census(
                    onPhoneCount = found.on_phone?.count ?: 0,
                    onPhoneBytes = found.on_phone?.bytes ?: 0,
                    keptCount = found.kept?.count ?: 0,
                    keptBytes = found.kept?.bytes ?: 0,
                )
            },
        )
    }

    /**
     * What the core said. [census] is null on every answer but a census's, and
     * on a census from a core with no content store — which is "not counted"
     * and never zero.
     */
    public data class Answer(
        public val keptAlbumIds: Set<String>,
        public val census: Census?,
    )

    public data class Census(
        public val onPhoneCount: Long,
        public val onPhoneBytes: Long,
        public val keptCount: Long,
        public val keptBytes: Long,
    )
}
