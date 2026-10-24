package dev.centraid.shared.nav

import centraid.core.v1.DocsDestination
import centraid.core.v1.DocsDocumentRoute
import centraid.core.v1.DocsDriveRoute
import centraid.core.v1.Route

/**
 * WHERE THE SHELL ENTERS DOCS FROM OUTSIDE IT (#1135): Home's tile and search,
 * a chat card, a reference whose noun is a document or a folder. Inside Docs a
 * row carries the `Route` Rust built; these are the only routes the shell
 * spells, because the caller holds an id and no row.
 *
 * INTERIM: the shell lane (#1135) replaces the KMP stack with Rust's and
 * deletes this file, as it deletes [AgendaEntry]; a front door then asks Rust
 * for the route.
 */
public object DocsEntry {
    private const val DRIVE: String = "docs.drive"
    private const val DOCUMENT: String = "docs.document"

    /** The drive at its tab: All, Folders, Starred or Recently added. */
    public fun home(destination: DocsDestination = DocsDestination.DOCS_DESTINATION_ALL): Destination.RustScreen =
        Destination.RustScreen(
            Route(screen = DRIVE).copy(docs_drive = DocsDriveRoute(destination = destination)),
        )

    /** One folder's page; [parent] is the pushing page's title, which its back control says. */
    public fun folder(folderId: String, name: String = "", parent: String = ""): Destination.RustScreen =
        Destination.RustScreen(
            Route(screen = DRIVE).copy(
                docs_drive = DocsDriveRoute(
                    destination = DocsDestination.DOCS_DESTINATION_FOLDERS,
                    folder_id = folderId,
                    folder_name = name,
                    parent = parent,
                ),
            ),
        )

    /** One document; the title rides along so the head has words at once. */
    public fun document(documentId: String, title: String = "", parent: String = ""): Destination.RustScreen =
        Destination.RustScreen(
            Route(screen = DOCUMENT).copy(
                docs_document = DocsDocumentRoute(document_id = documentId, title = title, parent = parent),
            ),
        )
}
