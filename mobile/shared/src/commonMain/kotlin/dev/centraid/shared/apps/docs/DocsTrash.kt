package dev.centraid.shared.apps.docs

import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.kit.TrashCopy
import dev.centraid.shared.kit.TrashMachine
import dev.centraid.shared.kit.TrashReads
import dev.centraid.shared.kit.TrashSpec

/**
 * DOCS' TRASH: the kit's one trash screen with Docs as the parameter.
 *
 * NO DESTROY PATH (`docs.proto`'s header): there is no purge command, so
 * `purgeCommand` is null and no row offers "Delete forever". "Empty trash" is
 * `core.empty_document_trash`, which ends every grace window at once — after
 * it nothing in trash can be restored, and nothing is removed either.
 */
public val DocsTrashSpec: TrashSpec = TrashSpec(
    appId = DocsWrites.APP_ID,
    table = "core_document",
    restoreCommand = DocsWrites.RESTORE,
    purgeCommand = null,
    emptyCommand = DocsWrites.EMPTY_TRASH,
    idColumn = "document_id",
    titleColumn = "title",
    purgeWindowDays = 30,
    copy = TrashCopy(emptyBody = DocsCopy.TRASH_EMPTY_BODY, emptyStateBody = DocsCopy.TRASH_EMPTY_STATE_BODY),
    backLabel = DocsCopy.APP_TITLE,
)

/**
 * The kit's machine, with Docs' own words where the kit's would be false: the
 * kit's empty-trash confirm says everything "leaves this vault for good", and
 * its empty state that deleted things "go for good" — neither is true of a
 * document here. Carried as [TrashSpec.copy]; every law is the kit's.
 */
public val DocsTrashMachine: TrashMachine = TrashMachine(DocsTrashSpec)

/** What Docs' trash reads and writes: the kit's, over `core_document`. */
public val DocsTrashReads: TrashReads = TrashReads(DocsTrashSpec)
