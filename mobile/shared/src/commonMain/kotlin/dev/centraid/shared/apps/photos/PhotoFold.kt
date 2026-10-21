package dev.centraid.shared.apps.photos

/**
 * AN EDIT DRAWS, AND THE CAMERA'S ORIGINAL STAYS UNDERNEATH (#1127, A20(1), R-1127-5).
 *
 * A photograph the member edited in the phone's Photos app comes into the
 * vault as two photographs of one capture (`CameraRoll`): the camera's bytes,
 * and the edit's render with `edited_from` naming them. Both carry the
 * capture's `burst`, and a library read draws only the NEWEST live
 * photograph of a burst — so the grid shows the edit, the original is still
 * there, and trashing or archiving the edit brings the original back. A
 * second edit folds the first the same way.
 *
 * ## Why a group marks it, and not the lineage alone
 *
 * `edited_from` names an original for every edit, including a crop saved
 * from Centraid's own editor, and R-1029-PH-5 keeps both of those drawn: the
 * editor's save is a new photograph the member chose to make. Only the walker
 * gives an edit a `burst`, so only a GROUPED photograph folds what
 * it was made from. A Live Photo's movie shares its still's burst and is a
 * `video` (a `form`), which this predicate never touches (the grid folds the
 * movie itself, `live`).
 *
 * ## The predicate
 *
 * A photograph is folded when a live, unarchived, grouped photograph
 * SUPERSEDES it, in one of two ways. **It was made from it**: the camera original
 * of an iOS edit, and an Android file edited in place, whose earlier version carries
 * no burst (it was backed up before the edit existed) and is named by the edit's
 * lineage alone. **Or it shares its burst and is newer**: not the photograph it was
 * made from, and created after it (an id is minted in time order, so the larger id
 * is the newer), so a second edit folds the first. `NULL` bursts never compare
 * equal, so an ungrouped photograph is never folded by the second arm.
 *
 * ## One scan, not one per row
 *
 * The folded set is computed ONCE, from the grouped photographs (a library holds a
 * few of them beside its ninety thousand others), and the grid asks `NOT IN` it. A
 * correlated `NOT EXISTS` would scan `photo` once per row and no index serves a
 * burst. Liveness and the archive are the entity's and an edge's: a photograph is
 * live when its `entity` is not in the trash, and archived when it is `tagged`
 * `flag:archived`.
 *
 * The text is also read, as text, by `crates/vault/tests/page_fold.rs`, which
 * runs it through the page door over real rows — keep each one raw string.
 */
internal object PhotoFold {
    /** The photograph's entity is not in the trash. */
    const val NOT_TRASHED: String = """id IN (SELECT id FROM entity WHERE deleted_at IS NULL)"""

    /** The photograph is not put away: no `archived` flag on it. */
    const val NOT_ARCHIVED: String = """id NOT IN (SELECT from_id FROM edge WHERE rel = 'tagged' AND to_id = 'flag:archived')"""

    /** The photograph is put away. */
    const val ARCHIVED: String = """id IN (SELECT from_id FROM edge WHERE rel = 'tagged' AND to_id = 'flag:archived')"""

    /** The photograph is trashed. */
    const val TRASHED: String = """id IN (SELECT id FROM entity WHERE deleted_at IS NOT NULL)"""

    /** The photograph is starred: the `starred` flag is on it. */
    const val STARRED: String = """id IN (SELECT from_id FROM edge WHERE rel = 'tagged' AND to_id = 'flag:starred')"""

    const val FOLDED: String = """id NOT IN (SELECT e.edited_from FROM photo e WHERE e.form = 'photo' AND e.burst IS NOT NULL AND e.edited_from IS NOT NULL AND e.id IN (SELECT id FROM entity WHERE deleted_at IS NULL) AND e.id NOT IN (SELECT from_id FROM edge WHERE rel = 'tagged' AND to_id = 'flag:archived') UNION SELECT o.id FROM photo n JOIN photo o ON o.burst = n.burst AND o.id <> n.id AND o.form = 'photo' AND (o.edited_from IS NULL OR o.edited_from <> n.id) AND n.id > o.id WHERE n.form = 'photo' AND n.burst IS NOT NULL AND n.id IN (SELECT id FROM entity WHERE deleted_at IS NULL) AND n.id NOT IN (SELECT from_id FROM edge WHERE rel = 'tagged' AND to_id = 'flag:archived'))"""

    /** The library's live predicate with the fold: what the grid, the shelves and search read. */
    const val LIVE: String = "$NOT_TRASHED AND $NOT_ARCHIVED AND $FOLDED"
}
