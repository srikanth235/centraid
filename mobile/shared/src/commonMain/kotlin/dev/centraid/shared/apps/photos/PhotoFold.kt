package dev.centraid.shared.apps.photos

/**
 * AN EDIT DRAWS, AND THE CAMERA'S ORIGINAL STAYS UNDERNEATH (#1127, A20(1), R-1127-5).
 *
 * A photograph the member edited in the phone's Photos app comes into the
 * vault as two assets of one capture (`CameraRoll`): the camera's bytes, and
 * the edit's render with `source_asset_id` naming them. Both carry the
 * asset's `capture_group_id`, and a library read draws only the NEWEST live
 * photograph of a group — so the grid shows the edit, the original is still
 * there, and trashing or archiving the edit brings the original back. A
 * second edit folds the first the same way.
 *
 * ## Why a group marks it, and not the lineage alone
 *
 * `source_asset_id` names an original for every edit, including a crop saved
 * from Centraid's own editor, and R-1029-PH-5 keeps both of those drawn: the
 * editor's save is a new photograph the member chose to make. Only the walker
 * gives an edit a `capture_group_id`, so only a GROUPED photograph folds what
 * it was made from. A Live Photo's movie shares its still's group and is a
 * `video`, which this predicate never touches (the grid folds the movie
 * itself, `live`).
 *
 * ## The predicate
 *
 * An asset is folded when a live, grouped photograph SUPERSEDES it, in one of
 * two ways. **It was made from it**: the camera original of an iOS edit, and
 * an Android file edited in place, whose earlier version carries no group (it
 * was backed up before the edit existed) and is named by the edit's lineage
 * alone. **Or it shares its group and is newer**: not the asset it was made
 * from, and created after it (the id breaks a tie inside one millisecond), so
 * a second edit folds the first. `NULL` groups never compare equal, so an
 * ungrouped photograph is never folded by the second arm.
 *
 * The text is also read, as text, by `crates/vault/tests/page_fold.rs`, which
 * runs it through the page door over real rows — keep it one raw string.
 */
internal object PhotoFold {
    const val FOLDED: String = """NOT EXISTS (SELECT 1 FROM media_asset n WHERE n.kind = 'photo' AND media_asset.kind = 'photo' AND n.deleted_at IS NULL AND n.archived_at IS NULL AND n.asset_id <> media_asset.asset_id AND n.capture_group_id IS NOT NULL AND (n.source_asset_id = media_asset.asset_id OR (n.capture_group_id = media_asset.capture_group_id AND (media_asset.source_asset_id IS NULL OR media_asset.source_asset_id <> n.asset_id) AND (n.created_at > media_asset.created_at OR (n.created_at = media_asset.created_at AND n.asset_id > media_asset.asset_id)))))"""

    /** The library's live predicate with the fold: what the grid, the shelves and search read. */
    const val LIVE: String = "deleted_at IS NULL AND archived_at IS NULL AND $FOLDED"
}
