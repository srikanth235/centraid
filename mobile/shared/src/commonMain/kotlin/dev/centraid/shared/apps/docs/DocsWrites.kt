package dev.centraid.shared.apps.docs

import dev.centraid.shared.kit.jsonString

/**
 * DOCS' WRITES: the vault's `document.*` commands and the shared verbs a
 * document takes (`entity.*`, `flag.*`, `tag.*`, `container.create`), their
 * inputs, and the keys a menu or a sheet sends (#1135).
 *
 * Every input is hand-built JSON (`commonMain` has no JSON library) naming
 * ONLY the schema's fields — each schema is `additionalProperties: false`.
 * A document is addressed by its own `id` in every command; a star is the
 * shared `flag.set` of the `starred` flag.
 *
 * DESTROYING IS `entity.purge` (one trashed document) and `entity.empty_trash`
 * (every trashed document), both confirm-gated (D-1 of 2026-09-25). A new
 * document is `document.add` over staged bytes ([upload]) or
 * `document.create_text` ([createText]).
 */
public object DocsWrites {
    public const val APP_ID: String = "docs"

    public const val STAR: String = "flag.set"
    public const val UNSTAR: String = "flag.clear"
    public const val RENAME: String = "entity.retitle"
    public const val MOVE: String = "document.move"
    public const val TRASH: String = "entity.trash"
    public const val RESTORE: String = "entity.restore"
    public const val EMPTY_TRASH: String = "entity.empty_trash"
    public const val PURGE: String = "entity.purge"
    public const val ADD: String = "document.add"
    public const val CREATE_TEXT: String = "document.create_text"
    public const val EDIT: String = "document.edit"
    public const val REPLACE_CONTENT: String = "document.replace"
    public const val RESTORE_VERSION: String = "document.restore_version"
    public const val CREATE_FOLDER: String = "container.create"
    public const val TAG: String = "tag.add"
    public const val UNTAG: String = "tag.remove"

    /** The kind of entity a document is: what the trash and the empty-trash command are scoped to. */
    public const val DOCUMENT_KIND: String = "document"

    /** The flag a star is. */
    public const val STARRED_FLAG: String = "starred"

    // The keys a `DocsAction` carries, and so what `ActionPicked` sends.
    public const val KEY_EDIT: String = "edit"
    public const val KEY_STAR: String = "star"
    public const val KEY_UNSTAR: String = "unstar"
    public const val KEY_RENAME: String = "rename"
    public const val KEY_MOVE: String = "move"
    public const val KEY_LABELS: String = "labels"
    public const val KEY_TRASH: String = "trash"
    public const val KEY_RESTORE: String = "restore"
    public const val KEY_PURGE: String = "purge"
    public const val KEY_MORE: String = "more"

    // The More and Add sheets' keys.
    public const val KEY_RECENT: String = "recent"
    public const val KEY_TRASH_SHELF: String = "trash_shelf"
    public const val KEY_UPLOAD: String = "upload"
    public const val KEY_SCAN: String = "scan"
    public const val KEY_TEXT: String = "text"
    public const val KEY_NEW_FOLDER: String = "new_folder"

    // Following folders on the phone (#1127): the Add sheet's row, More's row, and a followed
    // folder's row on the Followed sheet (`stop:` and the folder's origin id).
    public const val KEY_FOLLOW_FOLDER: String = "follow_folder"
    public const val KEY_FOLLOWED: String = "followed"
    public const val KEY_STOP_PREFIX: String = "stop:"

    /** The move sheet's key for the drive's top level (a folder id is never empty). */
    public const val KEY_TOP_LEVEL: String = "top"

    /** `{id}`: trash, restore and purge. */
    public fun documentOnly(documentId: String): String = obj("id" to documentId)

    /** `flag.set` / `flag.clear` of the star. */
    public fun star(documentId: String): String = obj("id" to documentId, "flag" to STARRED_FLAG)

    /** `entity.empty_trash` over documents only. */
    public fun emptyTrash(): String = obj("kind" to DOCUMENT_KIND)

    public fun rename(documentId: String, title: String): String = obj("id" to documentId, "title" to title)

    /** No folder is the top level: the command files it back under the root. */
    public fun move(documentId: String, folderId: String): String =
        if (folderId.isEmpty()) documentOnly(documentId) else obj("id" to documentId, "folder_id" to folderId)

    /**
     * `document.edit`: the words go whole in `body_text` (each save is a new
     * revision), and `title` only when it changed.
     */
    public fun edit(documentId: String, body: String, title: String?): String =
        if (title == null) {
            obj("id" to documentId, "body_text" to body)
        } else {
            obj("id" to documentId, "body_text" to body, "title" to title)
        }

    /** `document.replace` over staged bytes: the old bytes become a revision of the same document. */
    public fun replaceContent(documentId: String, blob: String, size: Long, mediaType: String): String =
        obj("id" to documentId, "blob" to blob, "size" to size, "media_type" to mediaType)

    /** `document.restore_version`: [seq] is a version's number on the wire. */
    public fun restoreVersion(documentId: String, seq: Int): String = obj("id" to documentId, "seq" to seq)

    /** The vault mints the folder id; no parent is the top level. */
    public fun createFolder(name: String, parentId: String): String =
        if (parentId.isEmpty()) {
            obj("kind" to "folder", "title" to name)
        } else {
            obj("kind" to "folder", "title" to name, "parent" to parentId)
        }

    public fun tag(documentId: String, label: String): String = obj("id" to documentId, "label" to label)

    /** `tag.remove` names the label, not an edge. */
    public fun untag(documentId: String, label: String): String = obj("id" to documentId, "label" to label)

    /**
     * `document.add` over bytes already staged (`Staging.stage`): the core
     * names them by [blob] and [size]; [documentId] is the id this phone
     * minted; no [folderId] is the top level.
     */
    public fun upload(
        documentId: String,
        blob: String,
        size: Long,
        mediaType: String,
        title: String,
        folderId: String,
    ): String = obj(
        *listOfNotNull(
            "id" to documentId,
            "blob" to blob,
            "size" to size,
            "media_type" to mediaType,
            "title" to title,
            folderId.takeIf { it.isNotEmpty() }?.let { "folder_id" to it },
        ).toTypedArray(),
    )

    /**
     * `document.create_text`: an empty `text/plain` document the editor then
     * fills — the core turns words into bytes, so no `data:` URI is spelled
     * here (R-1047-Q4). No [folderId] is the top level.
     */
    public fun createText(documentId: String, title: String, folderId: String): String = obj(
        *listOfNotNull(
            "id" to documentId,
            "title" to title,
            folderId.takeIf { it.isNotEmpty() }?.let { "folder_id" to it },
        ).toTypedArray(),
    )

    /** Strings and whole numbers only: every field a Docs schema names is one of the two. */
    private fun obj(vararg fields: Pair<String, Any>): String =
        fields.joinToString(",", prefix = "{", postfix = "}") { (k, v) ->
            "${jsonString(k)}:${if (v is String) jsonString(v) else v.toString()}"
        }
}
