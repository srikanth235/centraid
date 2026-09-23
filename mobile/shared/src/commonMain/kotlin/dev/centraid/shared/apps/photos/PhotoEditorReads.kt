package dev.centraid.shared.apps.photos

import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.PhotoEditSource
import centraid.screen.v1.PhotoEditorEvent
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.sync.LinkConditions

/**
 * WHAT THE EDITOR READS (#1029, photos port).
 *
 * Two doors, and the second is the reason this is not `PhotoLightboxReads`:
 *
 * 1. **The page door**, for the asset's own row — kind, title, capture time,
 *    and the three computed columns that say what this phone holds of it.
 * 2. **The byte door** (`ContentUrlRequest`), for the ORIGINAL's path. The
 *    page door's `with_held_thumbnail` hands out the DRAWABLE path and only a
 *    1/0 for the original — "this column hands out no path", in `page.rs`'s
 *    own words — and an editor that rendered from the drawable would save a
 *    thumbnail-sized photograph. `PhotoEditorBridge` asks the byte door; this
 *    object states what it asks for and what the answer becomes.
 *
 * Everything here is DATA, provable on a machine with no vault. The trip is
 * the bridge's.
 */
public object PhotoEditorReads {
    /** `media_asset` and nothing else: the editor never writes a row it reads. */
    public const val TABLE: String = "media_asset"

    /** What the byte door calls the reading this asset makes of its bytes. */
    public const val OWNER_TYPE: String = "media.asset"

    /**
     * One photograph, bound by id.
     *
     * The order is still stated on a read that returns at most one row, for
     * `PhotoLightboxReads`' reason: the door reads its cursor off the two
     * columns the `ORDER BY` names, and a statement that dropped them breaks
     * the moment its predicate widens.
     */
    public fun query(assetId: String): PageQuery = PageQuery(
        name = "photos.editor.asset",
        select = listOf(
            "asset_id",
            "kind",
            "title",
            "captured_at",
            "content_id",
            // THE ORIGINAL'S OFFSET AND PLACE, which the new photograph keeps.
            "tz_offset_min",
            "place_id",
        ),
        from = TABLE,
        where_ = "asset_id = ?",
        bind = listOf(Value(text = assetId)),
        order = PageOrder(sort_column = "captured_at", pk_column = "asset_id", descending = true),
        with_held_thumbnail = true,
    )

    /** The content id the byte door is asked about, or empty. */
    public fun contentId(row: Row): String = row.text(CONTENT_ID)

    /**
     * The row plus the byte door's answer, as the editor's source.
     *
     * [originalPath] is null when the byte door had none, and [absentReason]
     * is then its own member-facing sentence — never a path, never a sha.
     */
    public fun arrived(row: Row, originalPath: String?, absentReason: String): PhotoEditorEvent {
        val kind = PhotosReads.kindOf(row.text(KIND))
        val originalHeld = row.integer(ORIGINAL_HELD) > 0L
        return PhotoEditorEvent(
            data_ = PhotoEditorEvent.DataArrived(
                source = PhotoEditSource(
                    asset_id = row.text(ASSET_ID),
                    thumbnail_path = row.text(THUMBNAIL).ifEmpty { null },
                    // THE BYTE DOOR'S PATH ONLY WHEN THE PAGE DOOR AGREES THE
                    // ORIGINAL IS HELD. Both ask the same store; requiring both
                    // is what keeps a racing fetch from handing the renderer a
                    // file that is still being written.
                    original_path = originalPath?.takeIf { it.isNotEmpty() && originalHeld },
                    title = row.text(TITLE),
                    captured_at = row.text(CAPTURED_AT),
                    kind = kind,
                    held = PhotosReads.heldOf(
                        thumbnail = row.text(THUMBNAIL).isNotEmpty(),
                        originalHeld = originalHeld,
                        originalHash = row.text(ORIGINAL_HASH),
                        kind = kind,
                        rule = LinkConditions.rule,
                        metered = LinkConditions.metered,
                    ),
                    original_absent_reason = absentReason,
                    // NULL IS NOT ZERO. `tz_offset_min` is nullable, and a
                    // missing offset written onto the edit as `0` would claim
                    // the camera recorded Greenwich.
                    captured_utc_offset_minutes = row.values.getOrNull(TZ_OFFSET)?.integer?.toInt(),
                    place_id = row.text(PLACE_ID),
                ),
            ),
        )
    }

    /** AN EMPTY PAGE IS A PHOTOGRAPH THAT IS NOT HERE, never an empty editor. */
    public fun missing(): PhotoEditorEvent =
        refused(Reads.refused("Centraid could not find this photograph on this device."))

    public fun refused(failure: ReadFailure): PhotoEditorEvent =
        PhotoEditorEvent(refused = PhotoEditorEvent.ReadRefused(failure = failure))

    private const val ASSET_ID: Int = 0
    private const val KIND: Int = 1
    private const val TITLE: Int = 2
    private const val CAPTURED_AT: Int = 3
    private const val CONTENT_ID: Int = 4
    private const val TZ_OFFSET: Int = 5
    private const val PLACE_ID: Int = 6

    /**
     * The three computed columns, in the order `crates/core`'s `api::page`
     * appends them — after the seven this statement named. They move with the
     * `select` list above and nowhere else.
     */
    private const val THUMBNAIL: Int = 7
    private const val ORIGINAL_HASH: Int = 8
    private const val ORIGINAL_HELD: Int = 9

    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    private fun Row.integer(index: Int): Long = values.getOrNull(index)?.integer ?: 0L
}
