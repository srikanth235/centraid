package dev.centraid.android.screens.docs

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.DocsCapture
import centraid.screen.v1.DocsDocumentEvent
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsDriveState
import centraid.screen.v1.DocsSheet
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.TrashListScreen
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.shared.apps.docs.DocsDocumentBridge
import dev.centraid.shared.apps.docs.DocsDriveBridge
import dev.centraid.shared.apps.docs.DocsEditorBridge
import dev.centraid.shared.apps.docs.DocsTrashBridge
import dev.centraid.shared.apps.docs.DocsWrites
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope

/**
 * DOCS' ROUTES (#1046, docs port): the drive (All · Folders · Starred, More
 * as a sheet), a folder as a pushed page, a document, the text editor and the
 * trash. The drive's machine names capture and the trash as INTENTS; this is
 * where they become the OS's file picker and a push.
 *
 * TWO DRIVE BRIDGES: one for the band's page and one for the folder page
 * pushed over it (a bridge's host is built once and never re-created, and a
 * folder page is its own read). The folder bridge re-opens on each folder
 * entry, so a nested folder popped back to reads its own shelf again.
 */
public class DocsRoutes : AppRoutes {
    private val drive = DocsDriveBridge()
    private val folder = DocsDriveBridge()
    private val document = DocsDocumentBridge()
    private val editor = DocsEditorBridge()
    private val trash = DocsTrashBridge()

    override fun handles(destination: Destination): Boolean = when (destination) {
        is Destination.DocsHome, is Destination.DocsFolder, is Destination.DocsDocument, is Destination.DocsEditor,
        Destination.DocsTrash,
        -> true
        else -> false
    }

    // `open()` ON THE PUSH: coming back from a document keeps the drive's tab,
    // filters and answer.
    override fun opens(moveId: String): Destination? = if (moveId == "docs") {
        drive.open()
        Destination.DocsHome()
    } else {
        null
    }

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        drive.attach(session)
        folder.attach(session)
        document.attach(session)
        editor.attach(session)
        trash.attach(session)
    }

    private fun parentTitle(stack: NavStack): String {
        val under = stack.entries.dropLast(1).lastOrNull()
        return when (under) {
            is Destination.DocsHome -> drive.host.state.value.chrome?.title
            is Destination.DocsFolder -> under.folderName
            is Destination.DocsDocument -> under.title.ifEmpty { document.host.state.value.data_?.row?.title.orEmpty() }
            else -> null
        }?.ifEmpty { null } ?: KitWords.BACK
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        val parent = parentTitle(nav.stack)
        when (destination) {
            is Destination.DocsHome -> {
                val state by drive.host.state.collectAsStateWithLifecycle()
                // THE ROUTE FOLLOWS THE MACHINE: a tab is a parameter swap on the top entry.
                LaunchedEffect(state.destination) {
                    val band = state.destination
                    val top = nav.stack.current
                    if (band != DocsDriveState.Destination.DESTINATION_UNSPECIFIED && top is Destination.DocsHome && top.destination != band) {
                        nav.go(nav.stack.withDocsDestination(band))
                    }
                }
                DriveRoute(drive, state, nav, folderPage = false, parent = parent)
            }
            is Destination.DocsFolder -> {
                LaunchedEffect(destination) {
                    folder.open(DocsDriveState.Destination.DESTINATION_FOLDERS, destination.folderId, destination.folderName)
                }
                val state by folder.host.state.collectAsStateWithLifecycle()
                DriveRoute(folder, state, nav, folderPage = true, parent = parent)
            }
            is Destination.DocsDocument -> {
                LaunchedEffect(destination) { document.open(destination.documentId, destination.title) }
                val state by document.host.state.collectAsStateWithLifecycle()
                DocsDocumentScreen(
                    state = state,
                    parentTitle = parent,
                    onEvent = document::forward,
                    onBack = nav::pop,
                    onFolder = { id, name ->
                        document.forward(DocsDocumentEvent(folder_picked = DocsDocumentEvent.FolderPicked(folder_id = id, name = name)))
                        toFolder(nav, id, name)
                    },
                    onEdit = { id, title -> nav.go(nav.stack.push(Destination.DocsEditor(id, title))) },
                )
            }
            is Destination.DocsEditor -> {
                LaunchedEffect(destination) { editor.open(destination.documentId, destination.title) }
                val state by editor.host.state.collectAsStateWithLifecycle()
                DocsEditorScreen(
                    state = state,
                    onEvent = editor::forward,
                    // CLOSE = DONE: the pop; the room's `onDeparted` is the save.
                    onClose = nav::pop,
                    onDeparted = { editor.departed() },
                )
            }
            Destination.DocsTrash -> {
                LaunchedEffect(destination) { trash.open() }
                val state by trash.host.state.collectAsStateWithLifecycle()
                TrashListScreen(state = state, onEvent = trash::forward, parentTitle = parent, onBack = nav::pop)
            }
            else -> Unit
        }
    }

    @Composable
    private fun DriveRoute(bridge: DocsDriveBridge, state: DocsDriveState, nav: RouteNav, folderPage: Boolean, parent: String) {
        val context = LocalContext.current
        // PERMISSION AS STATE (law 4): the shell reports what the OS lets it
        // offer, and the Add sheet's rows follow. The system file picker needs
        // no grant; the camera needs the device to have one.
        LaunchedEffect(Unit) {
            bridge.forward(
                DocsDriveEvent(
                    permission = DocsDriveEvent.PermissionChanged(
                        surface = DocsDriveEvent.PermissionChanged.Surface.SURFACE_FILES,
                        permission = DocsCapture.Permission.PERMISSION_GRANTED,
                    ),
                ),
            )
            val camera = when {
                !context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) -> DocsCapture.Permission.PERMISSION_UNAVAILABLE
                ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED ->
                    DocsCapture.Permission.PERMISSION_GRANTED
                else -> DocsCapture.Permission.PERMISSION_NOT_ASKED
            }
            bridge.forward(
                DocsDriveEvent(
                    permission = DocsDriveEvent.PermissionChanged(
                        surface = DocsDriveEvent.PermissionChanged.Surface.SURFACE_CAMERA,
                        permission = camera,
                    ),
                ),
            )
        }
        val upload = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            // TODO(intent): file the picked document. `Staging.stage` takes the
            // bytes and `core.add_document` names them, but no bridge exposes
            // that pair to a view yet; the picker is live and the file goes nowhere.
            @Suppress("UNUSED_VARIABLE")
            val picked = uri
        }
        DocsDriveScreen(
            state = state,
            folderPage = folderPage,
            parentTitle = parent,
            onBack = nav::pop,
            onHome = nav::home,
            onEvent = { event ->
                val sheet = state.sheet?.kind
                val key = event.action?.key
                when {
                    // The More sheet's Trash row is the shell's route.
                    sheet == DocsSheet.Kind.KIND_MORE && key == DocsWrites.KEY_TRASH_SHELF -> {
                        bridge.forward(DocsDriveEvent(trash_opened = DocsDriveEvent.TrashOpened()))
                        nav.go(nav.stack.push(Destination.DocsTrash))
                    }
                    // The Add sheet's capture rows are the shell's (`AddRequested`).
                    sheet == DocsSheet.Kind.KIND_ADD && key in CAPTURE -> {
                        val kind = when (key) {
                            DocsWrites.KEY_UPLOAD -> DocsDriveEvent.AddRequested.Kind.KIND_UPLOAD
                            DocsWrites.KEY_SCAN -> DocsDriveEvent.AddRequested.Kind.KIND_SCAN
                            else -> DocsDriveEvent.AddRequested.Kind.KIND_TEXT
                        }
                        bridge.forward(DocsDriveEvent(add_requested = DocsDriveEvent.AddRequested(kind = kind, folder_id = state.folder_id)))
                        when (kind) {
                            DocsDriveEvent.AddRequested.Kind.KIND_UPLOAD -> upload.launch(arrayOf("*/*"))
                            // TODO(intent): SCAN — a document-scanner capture (camera) filed as a PDF.
                            // TODO(intent): TEXT — a new blank text document; there is no create
                            // command a view can reach, so nothing opens the editor on it yet.
                            else -> Unit
                        }
                    }
                    else -> {
                        bridge.forward(event)
                        val folderPicked = event.folder_picked
                        val documentPicked = event.document_picked
                        when {
                            folderPicked != null -> toFolder(nav, folderPicked.folder_id, folderPicked.name)
                            documentPicked != null ->
                                nav.go(nav.stack.push(Destination.DocsDocument(documentPicked.document_id, documentPicked.title)))
                        }
                    }
                }
            },
        )
    }

    /** A folder is a pushed page; the top level (an empty id) is the Folders tab. */
    private fun toFolder(nav: RouteNav, id: String, name: String) {
        if (id.isEmpty()) {
            val entries = nav.stack.entries
            val root = entries.indexOfLast { it is Destination.DocsHome }
            if (root >= 0) {
                nav.go(NavStack(entries.take(root + 1)))
                drive.forward(DocsDriveEvent(band = DocsDriveEvent.BandPicked(key = "folders")))
            }
            return
        }
        nav.go(nav.stack.push(Destination.DocsFolder(id, name)))
    }

    private companion object {
        val CAPTURE: Set<String> = setOf(DocsWrites.KEY_UPLOAD, DocsWrites.KEY_SCAN, DocsWrites.KEY_TEXT)
    }
}
