package dev.centraid.shared.apps.docs

import dev.centraid.shared.kit.jsonString

/**
 * DOCS' WRITES: the vault's `core.*` document commands, their inputs, and the
 * keys a menu or a sheet sends (#1046, docs port).
 *
 * Every input is hand-built JSON (`commonMain` has no JSON library) naming
 * ONLY the schema's fields — each schema is `additionalProperties: false`.
 *
 * THERE IS NO DESTROY COMMAND. `core.empty_document_trash` ends every grace
 * window; nothing removes a trashed document (`docs.proto`'s header).
 */
public object DocsWrites {
    public const val APP_ID: String = "docs"

    public const val STAR: String = "core.star_document"
    public const val UNSTAR: String = "core.unstar_document"
    public const val RENAME: String = "core.rename_document"
    public const val MOVE: String = "core.move_document"
    public const val TRASH: String = "core.trash_document"
    public const val RESTORE: String = "core.restore_document"
    public const val EMPTY_TRASH: String = "core.empty_document_trash"
    public const val EDIT: String = "core.edit_document"
    public const val RESTORE_VERSION: String = "core.restore_document_version"
    public const val CREATE_FOLDER: String = "core.create_folder"
    public const val TAG: String = "core.tag_item"
    public const val UNTAG: String = "core.untag_item"

    /** `core.tag_item`'s subject type for a document. */
    public const val DOCUMENT_TYPE: String = "core.document"

    // The keys a `DocsAction` carries, and so what `ActionPicked` sends.
    public const val KEY_EDIT: String = "edit"
    public const val KEY_STAR: String = "star"
    public const val KEY_UNSTAR: String = "unstar"
    public const val KEY_RENAME: String = "rename"
    public const val KEY_MOVE: String = "move"
    public const val KEY_LABELS: String = "labels"
    public const val KEY_TRASH: String = "trash"
    public const val KEY_RESTORE: String = "restore"
    public const val KEY_MORE: String = "more"

    // The More and Add sheets' keys.
    public const val KEY_RECENT: String = "recent"
    public const val KEY_TRASH_SHELF: String = "trash_shelf"
    public const val KEY_UPLOAD: String = "upload"
    public const val KEY_SCAN: String = "scan"
    public const val KEY_TEXT: String = "text"
    public const val KEY_NEW_FOLDER: String = "new_folder"

    /** The move sheet's key for the drive's top level (a folder id is never empty). */
    public const val KEY_TOP_LEVEL: String = "top"

    public fun documentOnly(documentId: String): String = obj("document_id" to documentId)

    public fun rename(documentId: String, title: String): String =
        obj("document_id" to documentId, "title" to title)

    /** No folder is the top level: the command files it back under the root. */
    public fun move(documentId: String, folderId: String): String =
        if (folderId.isEmpty()) documentOnly(documentId) else obj("document_id" to documentId, "folder_id" to folderId)

    /**
     * `core.edit_document`: `body_text` is REQUIRED, so it is always sent,
     * and `title` only when it changed. Each save mints a new version.
     */
    public fun edit(documentId: String, body: String, title: String?): String =
        if (title == null) {
            obj("document_id" to documentId, "body_text" to body)
        } else {
            obj("document_id" to documentId, "body_text" to body, "title" to title)
        }

    public fun restoreVersion(documentId: String, contentId: String): String =
        obj("document_id" to documentId, "content_id" to contentId)

    /** The vault mints the folder id; no parent is the top level. */
    public fun createFolder(name: String, parentId: String): String =
        if (parentId.isEmpty()) obj("name" to name) else obj("name" to name, "parent_folder_id" to parentId)

    public fun tag(documentId: String, label: String): String =
        obj("subject_type" to DOCUMENT_TYPE, "subject_id" to documentId, "label" to label)

    public fun untag(tagId: String): String = obj("tag_id" to tagId)

    private fun obj(vararg fields: Pair<String, String>): String =
        fields.joinToString(",", prefix = "{", postfix = "}") { (k, v) -> "${jsonString(k)}:${jsonString(v)}" }
}
