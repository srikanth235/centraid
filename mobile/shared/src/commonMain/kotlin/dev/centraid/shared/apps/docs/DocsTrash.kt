package dev.centraid.shared.apps.docs

import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.kit.TrashCopy
import dev.centraid.shared.kit.TrashMachine
import dev.centraid.shared.kit.TrashReads
import dev.centraid.shared.kit.TrashSpec

/**
 * DOCS' TRASH: the kit's one trash screen with Docs as the parameter.
 *
 * DOCS DESTROYS, ON PHOTOS' PATH (D-1 of 2026-09-25, `docs.proto`'s header):
 * "Delete forever" is `core.purge_document` and "Empty trash" is
 * `core.empty_document_trash`, each behind the kit's destructive confirm —
 * the row goes now and its bytes are released when nothing else names them.
 * So the kit's own sentences ("leaves this vault for good") are true here.
 * No sweep runs on the phone, so no row says when it will be erased.
 */
public val DocsTrashSpec: TrashSpec = TrashSpec(
    appId = DocsWrites.APP_ID,
    table = "core_document",
    restoreCommand = DocsWrites.RESTORE,
    purgeCommand = DocsWrites.PURGE,
    emptyCommand = DocsWrites.EMPTY_TRASH,
    idColumn = "document_id",
    titleColumn = "title",
    purgeWindowDays = 30,
    copy = TrashCopy(emptyStateBody = DocsCopy.TRASH_EMPTY_STATE_BODY),
    backLabel = DocsCopy.APP_TITLE,
)

/**
 * The kit's machine. Docs' one word of its own is the empty state's 30-day
 * window; every law and every confirm is the kit's.
 */
public val DocsTrashMachine: TrashMachine = TrashMachine(DocsTrashSpec)

/** What Docs' trash reads and writes: the kit's, over `core_document`. */
public val DocsTrashReads: TrashReads = TrashReads(DocsTrashSpec)
