package dev.centraid.android.backup

internal object LibraryRefs {
    const val IMAGE: String = "image:"
    const val VIDEO: String = "video:"

    data class Row(val video: Boolean, val id: Long)

    fun of(video: Boolean, id: Long): String = (if (video) VIDEO else IMAGE) + id

    fun row(ref: String): Row? {
        val id = ref.removePrefix(VIDEO).removePrefix(IMAGE).toLongOrNull() ?: return null
        return Row(video = ref.startsWith(VIDEO), id = id)
    }
}

internal object LibraryDeletion {
    fun target(mediaType: String, osRef: String): LibraryRefs.Row? {
        val video = mediaType.startsWith("video/")
        if (osRef.startsWith(LibraryRefs.VIDEO) && !video) return null
        if (osRef.startsWith(LibraryRefs.IMAGE) && video) return null
        val row = LibraryRefs.row(osRef) ?: return null
        return LibraryRefs.Row(video = video, id = row.id)
    }

    fun unchanged(stored: Long?, backedUp: Long): Boolean = stored == backedUp

    fun <T> deletedHashes(asked: List<T>, hash: (T) -> String, stillThere: (T) -> Boolean): List<String> =
        asked.filter { !stillThere(it) }.map(hash)
}
