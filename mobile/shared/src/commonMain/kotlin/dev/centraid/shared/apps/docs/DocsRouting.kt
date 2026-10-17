package dev.centraid.shared.apps.docs

import centraid.screen.v1.DocsDocumentEvent
import centraid.screen.v1.DocsDocumentState
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsDriveState
import centraid.screen.v1.DocsIngestState
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.ScreenMove
import dev.centraid.shared.nav.ScreenMoves
import dev.centraid.shared.nav.ScreenOpening
import dev.centraid.shared.nav.ScreenOpenings

/**
 * WHERE DOCS' INTENTS GO, ONCE (#1046, docs port).
 *
 * A folder, a document, the More sheet's Trash, a crumb and Edit change
 * nothing in their machines (or only close a sheet); the shell pushes. WHICH
 * page lives here: Android pushes the [Destination], and iOS asks [route] for
 * the same push spelled. Every push hands the pushed page the PUSHING page's
 * own title as its `parent`, which its back control says (#1047). A folder
 * with no id is the Folders tab's top level, not a page: nothing here opens it.
 */
public object DocsRouting {
    /** The drive's intents, from the drive or a folder page (one machine on two keys). */
    public fun drive(event: DocsDriveEvent, state: DocsDriveState): Destination? {
        val here = state.chrome?.title.orEmpty()
        val folder = event.folder_picked
        val document = event.document_picked
        return when {
            folder != null -> folderOf(folder.folder_id, folder.name, here)
            document != null -> documentOf(document.document_id, document.title, here)
            event.trash_opened != null -> Destination.DocsTrash
            else -> null
        }
    }

    /** A document's crumb opens its folder; Edit opens the text editor. */
    public fun document(event: DocsDocumentEvent, state: DocsDocumentState): Destination? {
        val folder = event.folder_picked
        val edit = event.edit_requested
        return when {
            folder != null -> folderOf(folder.folder_id, folder.name, headTitle(state))
            edit != null && edit.document_id.isNotEmpty() -> Destination.DocsEditor(edit.document_id, edit.title)
            else -> null
        }
    }

    /**
     * FILED, WHEREVER THE MEMBER IS (#1047): the new document, once per
     * request — Text opens its editor, anything else its page, whose back
     * word is the state's `parent`. Null until the ingest has filed a request
     * it has not routed; the shell tells the bridge `routed` after the push.
     */
    public fun filed(state: DocsIngestState): Destination? {
        if (state.phase != DocsIngestState.Phase.PHASE_FILED || state.routed || state.document_id.isEmpty()) return null
        return if (state.open_editor) {
            Destination.DocsEditor(state.document_id, state.title)
        } else {
            Destination.DocsDocument(state.document_id, state.title, parent = state.parent)
        }
    }

    /**
     * THE SAME DECISIONS FOR A SHELL THAT SENDS BYTES: [event] is what screen
     * [screenId] just forwarded and [state] is that screen's own state. Null
     * for an event that routes nowhere, a screen that is not Docs', or bytes
     * that do not decode.
     */
    public fun route(screenId: String, event: ByteArray, state: ByteArray): ScreenMove? {
        val destination = runCatching {
            when (screenId) {
                DocsDriveMachine.SCREEN_ID, DocsDriveMachine.FOLDER_SCREEN_ID ->
                    drive(DocsDriveEvent.ADAPTER.decode(event), DocsDriveState.ADAPTER.decode(state))
                DocsDocumentMachine.SCREEN_ID -> document(DocsDocumentEvent.ADAPTER.decode(event), DocsDocumentState.ADAPTER.decode(state))
                else -> null
            }
        }.getOrNull()
        return ScreenMoves.push(destination)
    }

    /** [filed] for a shell that sends bytes: [state] is the encoded `DocsIngestState`. */
    public fun filedOpening(state: ByteArray): ScreenOpening? =
        runCatching { filed(DocsIngestState.ADAPTER.decode(state)) }.getOrNull()?.let(ScreenOpenings::of)

    /** The document page's head words: the row's title, else the route's hint. */
    private fun headTitle(state: DocsDocumentState): String =
        state.data_?.row?.title?.ifEmpty { null } ?: state.title_hint

    private fun folderOf(folderId: String, name: String, parent: String): Destination? =
        if (folderId.isEmpty()) null else Destination.DocsFolder(folderId, name, parent)

    private fun documentOf(documentId: String, title: String, parent: String): Destination? =
        if (documentId.isEmpty()) null else Destination.DocsDocument(documentId, title, parent)
}
