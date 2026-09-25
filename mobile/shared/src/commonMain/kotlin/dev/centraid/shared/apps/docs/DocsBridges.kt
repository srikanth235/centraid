package dev.centraid.shared.apps.docs

import centraid.screen.v1.DocsDocumentEvent
import centraid.screen.v1.DocsDocumentState
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsDriveState
import centraid.screen.v1.DocsEditorEvent
import centraid.screen.v1.DocsEditorState
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashListState
import dev.centraid.shared.kit.ScreenBridge

/**
 * What both shells hold for Docs' drive (#1046, docs port): the kit's
 * [ScreenBridge], named so the Swift symbol is the app's. One per drive page:
 * the drive at its band, and each folder page pushed over it.
 *
 * A shell pushes `Destination.DocsHome` (or `DocsFolder`) and calls [open].
 * Intents on the events it forwards — `FolderPicked`, `DocumentPicked`,
 * `AddRequested`, `TrashOpened` — are the shell's to route.
 */
public class DocsDriveBridge : ScreenBridge<DocsDriveState, DocsDriveEvent>(
    machine = DocsDriveMachine,
    events = DocsDriveEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, DocsDriveReads, DocsDriveReads, left = w.left) },
) {
    /** Land on [destination]; `DESTINATION_FOLDERS` with a [folderId] is that folder's page. */
    public fun open(
        destination: DocsDriveState.Destination = DocsDriveState.Destination.DESTINATION_ALL,
        folderId: String = "",
        folderName: String = "",
    ) {
        forward(
            DocsDriveEvent(
                opened = DocsDriveEvent.Opened(destination = destination, folder_id = folderId, folder_name = folderName),
            ),
        )
    }

    // SWIFT CANNOT OMIT A KOTLIN DEFAULT ARGUMENT: each overload below is the
    // call with the defaults spelled out.
    public fun open() {
        open(DocsDriveState.Destination.DESTINATION_ALL, "", "")
    }

    public fun open(destination: DocsDriveState.Destination) {
        open(destination, "", "")
    }
}

/** One document's page. Leaving saves an open rename (close = done). */
public class DocsDocumentBridge : ScreenBridge<DocsDocumentState, DocsDocumentEvent>(
    machine = DocsDocumentMachine,
    events = DocsDocumentEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, DocsDocumentReads, DocsDocumentReads, left = w.left) },
) {
    public fun open(documentId: String, title: String = "") {
        forward(DocsDocumentEvent(opened = DocsDocumentEvent.Opened(document_id = documentId, title = title)))
    }

    /** Swift cannot omit [title]'s default: this is the call without it. */
    public fun open(documentId: String) {
        open(documentId, "")
    }
}

/**
 * The text editor. Closing it is `leave()` (or `departed()` for a bridge the
 * shell keeps): close = done, so unsaved words are saved on the way out.
 */
public class DocsEditorBridge : ScreenBridge<DocsEditorState, DocsEditorEvent>(
    machine = DocsEditorMachine,
    events = DocsEditorEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, DocsEditorReads, DocsEditorReads, left = w.left) },
) {
    public fun open(documentId: String, title: String = "") {
        forward(DocsEditorEvent(opened = DocsEditorEvent.Opened(document_id = documentId, title = title)))
    }

    /** Swift cannot omit [title]'s default: this is the call without it. */
    public fun open(documentId: String) {
        open(documentId, "")
    }
}

/** Docs' trash: the kit's trash screen, restore and Empty trash, no purge. */
public class DocsTrashBridge : ScreenBridge<TrashListState, TrashListEvent>(
    machine = DocsTrashMachine,
    events = TrashListEvent.ADAPTER,
    wire = { w -> w.session.attachScreen(w.host, DocsTrashReads, DocsTrashReads, left = w.left) },
) {
    public fun open() {
        forward(TrashListEvent(opened = TrashListEvent.Opened()))
    }
}
