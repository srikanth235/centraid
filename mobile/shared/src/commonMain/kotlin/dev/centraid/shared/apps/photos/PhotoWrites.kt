package dev.centraid.shared.apps.photos

import dev.centraid.shared.kit.jsonString

/**
 * PHOTOS' WRITES (#1135): the vault's `photo.*`, `album.*` and `place.*` commands
 * and the shared verbs a photograph or an album takes (`entity.*`, `flag.*`,
 * `tag.*`, `edge.*`, `container.create`), their inputs, and the table sets a
 * change event names.
 *
 * A photograph, an album and a place are addressed by their own `id` in every
 * command. A star and the archive are the shared `flag.set` / `flag.clear` of the
 * `starred` and `archived` flags; an album's membership is an ordered `contains`
 * edge from the album to the photograph. Every input is hand-built JSON
 * (`commonMain` has no JSON library) naming ONLY the schema's fields — each
 * schema is `additionalProperties: false`.
 */
public object PhotoWrites {
    public const val APP_ID: String = "photos"

    public const val ADD: String = "photo.add"
    public const val EDIT: String = "photo.edit"
    public const val SET_PLACE: String = "photo.set_place"
    public const val SET_COVER: String = "album.set_cover"
    public const val RETITLE: String = "entity.retitle"
    public const val TRASH: String = "entity.trash"
    public const val RESTORE: String = "entity.restore"
    public const val PURGE: String = "entity.purge"
    public const val EMPTY_TRASH: String = "entity.empty_trash"
    public const val FLAG_SET: String = "flag.set"
    public const val FLAG_CLEAR: String = "flag.clear"
    public const val TAG: String = "tag.add"
    public const val UNTAG: String = "tag.remove"
    public const val EDGE_ADD: String = "edge.add"
    public const val EDGE_REMOVE: String = "edge.remove"
    public const val CREATE_CONTAINER: String = "container.create"
    public const val STAGE_BLOB: String = "blob.stage"

    /** The kind of entity a photograph is: what the trash and the empty-trash command are scoped to. */
    public const val PHOTO_KIND: String = "photo"

    /** The flags a photograph carries. */
    public const val STARRED: String = "starred"
    public const val ARCHIVED: String = "archived"

    /**
     * THE KEY'S FIRST WORD for the album's own verbs. Two of them are commands another verb shares
     * (`entity.retitle`, `entity.trash`), and a settle is told what it was about by its key, so
     * each album verb keys under a name of its own.
     */
    public const val KEY_RENAME_ALBUM: String = "album-rename"
    public const val KEY_DELETE_ALBUM: String = "album-delete"
    public const val KEY_CREATE_ALBUM: String = "album-create"

    /** The tables a photograph's own reads depend on. */
    public val LIBRARY: Set<String> = setOf("photo", "entity", "edge", "place", "derivative", "blob")

    /** The tables the albums and the album sheets read. */
    public val ALBUMS: Set<String> = setOf("container", "edge", "entity", "photo", "blob")

    /** `{id}`: trash, restore, purge. */
    public fun idOnly(id: String): String = "{\"id\":${jsonString(id)}}"

    /** `flag.set` / `flag.clear` of [flag] on [id]. */
    public fun flag(id: String, flag: String): String = "{\"id\":${jsonString(id)},\"flag\":${jsonString(flag)}}"

    public fun flagCommand(on: Boolean): String = if (on) FLAG_SET else FLAG_CLEAR

    public fun retitle(id: String, title: String): String =
        "{\"id\":${jsonString(id)},\"title\":${jsonString(title)}}"

    /** `entity.empty_trash` over photographs only. */
    public fun emptyTrash(): String = "{\"kind\":${jsonString(PHOTO_KIND)}}"

    /** `tag.add` / `tag.remove`: a label on a photograph, by its words. */
    public fun label(id: String, label: String): String =
        "{\"id\":${jsonString(id)},\"label\":${jsonString(label)}}"

    /** `photo.set_place`: no place is "back to unknown", by OMITTING the field. */
    public fun setPlace(id: String, placeId: String): String =
        if (placeId.isEmpty()) idOnly(id) else "{\"id\":${jsonString(id)},\"place_id\":${jsonString(placeId)}}"

    /** `album.set_cover`: the album, and the photograph that becomes its key photo. */
    public fun setCover(albumId: String, photoId: String): String =
        "{\"id\":${jsonString(albumId)},\"photo_id\":${jsonString(photoId)}}"

    /** `edge.add` / `edge.remove` of one photograph in one album. */
    public fun membership(albumId: String, photoId: String): String =
        "{\"from\":${jsonString(albumId)},\"rel\":\"contains\",\"to\":${jsonString(photoId)}}"

    /** `container.create` of an album: the vault mints its id. */
    public fun createAlbum(title: String): String =
        "{\"kind\":\"album\",\"title\":${jsonString(title)}}"

    /** `photo.edit`: a photograph's capture time and zone, or the one it was edited from. */
    public fun edit(id: String, takenAt: String?, offsetMin: Int?): String = buildString {
        append("{\"id\":").append(jsonString(id))
        append(",\"taken_at\":").append(takenAt?.let(::jsonString) ?: "null")
        append(",\"offset_min\":").append(offsetMin?.toString() ?: "null")
        append('}')
    }
}
