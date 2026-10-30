package dev.centraid.android.backup

import centraid.core.v1.LibraryDeleted

/**
 * THE SPELLING OF A LIBRARY REF (the Android twin of iOS's `LibraryRefs`): `image:<_ID>` or
 * `video:<_ID>`, one `MediaStore` row. The walker (`session/LibraryRoll.kt`) mints refs with [of]
 * and everything that reads one back, Free up space included, goes through [row], so the two
 * cannot drift apart.
 */
internal object LibraryRefs {
    const val IMAGE: String = "image:"
    const val VIDEO: String = "video:"

    /** The collection and `_ID` a ref names. */
    data class Row(val video: Boolean, val id: Long)

    /** The ref the walker writes for a row. */
    fun of(video: Boolean, id: Long): String = (if (video) VIDEO else IMAGE) + id

    /** The row a ref names; a bare `_ID` (an early build's ref) was always an image. Null when no id follows. */
    fun row(ref: String): Row? {
        val id = ref.removePrefix(VIDEO).removePrefix(IMAGE).toLongOrNull() ?: return null
        return Row(video = ref.startsWith(VIDEO), id = id)
    }
}

/**
 * FREE UP SPACE'S PURE HALF (#1080 A19, A20), so a test can show each rule refuse without a
 * `ContentResolver`. The platform's half is `MediaStoreDeleter`; the rules, each with its reason:
 *
 * 1. **The collection is the item's media type** ([target]): `video/…` names `MediaStore.Video`,
 *    anything else `MediaStore.Images`. A ref whose prefix names the other collection is skipped,
 *    never guessed at.
 * 2. **A row that changed since it was backed up is kept** ([unchanged]): the store's `SIZE` must
 *    equal the size the core backed up. (MediaStore has no edit revision, Live Photo or camera
 *    original row: size is the one witness, and the core supplies it.)
 * 3. **What is reported is what the request removed** ([answer], [deletedHashes]): on a yes only a
 *    row the store no longer answers for is reported deleted. The member's no is `declined`;
 *    anything else is `error` with nothing reported deleted ([failed]).
 */
internal object LibraryDeletion {
    /** RULE 1. The row an item's ref names in the collection its media type names; null when it names none, or the other one. */
    fun target(mediaType: String, osRef: String): LibraryRefs.Row? {
        val video = mediaType.startsWith("video/")
        if (osRef.startsWith(LibraryRefs.VIDEO) && !video) return null
        if (osRef.startsWith(LibraryRefs.IMAGE) && video) return null
        val row = LibraryRefs.row(osRef) ?: return null
        return LibraryRefs.Row(video = video, id = row.id)
    }

    /** RULE 2. Whether the store's size for a row (null when it answers nothing) is the size that was backed up. */
    fun unchanged(stored: Long?, backedUp: Long): Boolean = stored == backedUp

    /** RULE 3, the rows: the hashes of the asked items whose row the store no longer answers for. */
    fun <T> deletedHashes(asked: List<T>, hash: (T) -> String, stillThere: (T) -> Boolean): List<String> =
        asked.filter { !stillThere(it) }.map(hash)

    /** RULE 3, the dialog: a no is `declined`; a yes reports [removed], read only then. */
    fun answer(yes: Boolean, removed: () -> List<String>): LibraryDeleted =
        if (yes) LibraryDeleted(deleted_hashes = removed()) else LibraryDeleted(declined = true)

    /** RULE 3, anything else: the platform's own words, or the exception's name when it gave none. */
    fun failed(error: Exception): LibraryDeleted =
        LibraryDeleted(error = error.message ?: error.javaClass.simpleName)
}
