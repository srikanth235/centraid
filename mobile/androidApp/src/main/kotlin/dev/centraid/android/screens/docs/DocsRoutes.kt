package dev.centraid.android.screens.docs

import android.content.ActivityNotFoundException
import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.DocsCapture
import centraid.screen.v1.DocsDocumentEvent
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsDriveState
import centraid.screen.v1.DocsSheet
import dev.centraid.android.kit.TrashListScreen
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.apps.docs.DocsDocumentBridge
import dev.centraid.shared.apps.docs.DocsDriveBridge
import dev.centraid.shared.apps.docs.DocsDriveMachine
import dev.centraid.shared.apps.docs.DocsEditorBridge
import dev.centraid.shared.apps.docs.DocsIngestBridge
import dev.centraid.shared.apps.docs.DocsRouting
import dev.centraid.shared.apps.docs.DocsTrashBridge
import dev.centraid.shared.apps.docs.DocsWrites
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

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
 *
 * ADDING A DOCUMENT is [DocsIngestBridge]'s: the Add sheet's Upload, Scan and
 * Text rows start it, this file answers its `onPick` with the OS's own picker
 * (the Storage Access Framework's `OpenDocument`) or the system camera
 * (`TakePicture`, written out as a one-page PDF — no scanner library), draws
 * its status line on whichever drive page is up, and pushes the filed
 * document once per request from [Global] — wherever the member is then.
 */
public class DocsRoutes : AppRoutes {
    private val drive = DocsDriveBridge()
    private val folder = DocsDriveBridge()
    private val document = DocsDocumentBridge()
    private val editor = DocsEditorBridge()
    private val trash = DocsTrashBridge()
    private val ingest = DocsIngestBridge()

    override fun handles(destination: Destination): Boolean = when (destination) {
        is Destination.DocsHome, is Destination.DocsFolder, is Destination.DocsDocument, is Destination.DocsEditor,
        Destination.DocsTrash,
        -> true
        else -> false
    }

    // `open()` ON THE PUSH: coming back from a document keeps the drive's tab,
    // filters and answer.
    override fun opens(moveId: String): Destination? = if (moveId == AppIds.DOCS) {
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
        ingest.attach(session)
    }

    /**
     * FILED, WHEREVER THE MEMBER IS (#1047): push the new document once per
     * request — Text opens its editor, anything else its page, whose back
     * word is the state's `parent` — then tell the bridge. At the root, so a
     * member who left the drive while a file uploaded is still taken to it.
     */
    @Composable
    override fun Global(nav: RouteNav) {
        val adding by ingest.host.state.collectAsStateWithLifecycle()
        LaunchedEffect(adding.request_seq, adding.phase, adding.routed) {
            DocsRouting.filed(adding)?.let { filed ->
                nav.push(filed)
                ingest.routed(adding.request_seq)
            }
        }
    }

    // THE BACK CONTROL IS THE MACHINE'S (#1047): a pushed page draws its
    // state's back words, and a push hands it the PUSHING page's own title as
    // its `parent`.

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
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
                DriveRoute(drive, state, nav, folderPage = false)
            }
            is Destination.DocsFolder -> {
                LaunchedEffect(destination) {
                    folder.open(DocsDriveState.Destination.DESTINATION_FOLDERS, destination.folderId, destination.folderName, destination.parent)
                }
                val state by folder.host.state.collectAsStateWithLifecycle()
                DriveRoute(folder, state, nav, folderPage = true)
            }
            is Destination.DocsDocument -> {
                LaunchedEffect(destination) { document.open(destination.documentId, destination.title, destination.parent) }
                val state by document.host.state.collectAsStateWithLifecycle()
                // DELETED FOREVER here: the machine says the page is done.
                LaunchedEffect(state.dismissed) { if (state.dismissed) nav.pop() }
                DocsDocumentScreen(
                    state = state,
                    onEvent = document::forward,
                    onBack = nav::pop,
                    onFolder = { id, name ->
                        val picked = DocsDocumentEvent(folder_picked = DocsDocumentEvent.FolderPicked(folder_id = id, name = name))
                        document.forward(picked)
                        if (id.isEmpty()) toFoldersTab(nav) else nav.push(DocsRouting.document(picked, state))
                    },
                    // The screen forwarded `EditRequested` first; where it goes is the routing's.
                    onEdit = { id, title ->
                        nav.push(
                            DocsRouting.document(
                                DocsDocumentEvent(edit_requested = DocsDocumentEvent.EditRequested(document_id = id, title = title)),
                                state,
                            ),
                        )
                    },
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
                // `TrashListState.back_label` is the machine's back word.
                TrashListScreen(state = state, onEvent = trash::forward, onBack = nav::pop)
            }
            else -> Unit
        }
    }

    @Composable
    private fun DriveRoute(bridge: DocsDriveBridge, state: DocsDriveState, nav: RouteNav, folderPage: Boolean) {
        val context = LocalContext.current
        val adding by ingest.host.state.collectAsStateWithLifecycle()
        // PERMISSION AS STATE (law 4): the shell reports what the OS lets it
        // offer, and the Add sheet's rows follow. The system file picker needs
        // no grant. Scan goes through the system camera app's capture intent,
        // which needs the CAMERA grant because the manifest declares CAMERA
        // (pairing's scan, #1047 E6): it is asked for at Scan, and a refusal
        // is the machine's DENIED — so a device with a camera offers the
        // row, and one without hides it.
        LaunchedEffect(Unit) {
            bridge.forward(
                DocsDriveEvent(
                    permission = DocsDriveEvent.PermissionChanged(
                        surface = DocsDriveEvent.PermissionChanged.Surface.SURFACE_FILES,
                        permission = DocsCapture.Permission.PERMISSION_GRANTED,
                    ),
                ),
            )
            val camera = if (context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
                DocsCapture.Permission.PERMISSION_GRANTED
            } else {
                DocsCapture.Permission.PERMISSION_UNAVAILABLE
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
        // UPLOAD: the picked stream is copied into the cache (off the main
        // thread, on the root scope so leaving the page does not strand the
        // bridge in PICKING) and handed over as a file the bridge owns.
        val upload = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri == null) {
                ingest.pickCancelled()
            } else {
                nav.scope.launch {
                    val copied = withContext(Dispatchers.IO) { DocsIngestFiles.copy(context.applicationContext, uri) }
                    if (copied == null) {
                        ingest.pickRefused(DocsCopy.INGEST_NO_FILE)
                    } else {
                        ingest.picked(copied.path, copied.name, copied.mediaType, owned = true)
                    }
                }
            }
        }
        // SCAN: the camera writes a photograph into `docs-scans/`; it is filed
        // as a one-page PDF with no name, so the machine titles it. The target
        // survives the activity being recreated behind the camera.
        var scanTarget by rememberSaveable { mutableStateOf("") }
        val scan = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
            val photo = scanTarget.takeIf { it.isNotEmpty() }?.let(::File)
            scanTarget = ""
            if (!taken || photo == null) {
                photo?.let(DocsIngestFiles::discard)
                ingest.pickCancelled()
            } else {
                nav.scope.launch {
                    val pdf = withContext(Dispatchers.IO) { DocsIngestFiles.scanToPdf(context.applicationContext, photo) }
                    if (pdf == null) {
                        ingest.pickRefused(DocsCopy.INGEST_NO_FILE)
                    } else {
                        ingest.picked(pdf.absolutePath, name = "", mediaType = PDF, owned = true)
                    }
                }
            }
        }
        // THE CAMERA GRANT, ASKED FOR AT SCAN (#1047 E6): with CAMERA
        // declared, `TakePicture` throws without it. Granted → the capture;
        // refused → the machine's sentence for a denied grant.
        val launchScan = {
            val (file, uri) = DocsIngestFiles.scanTarget(context)
            scanTarget = file.absolutePath
            scan.launch(uri)
        }
        val cameraGrant = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) {
                ingest.scanRefused(DocsCapture.Permission.PERMISSION_DENIED.value)
            } else {
                try {
                    launchScan()
                } catch (why: ActivityNotFoundException) {
                    scanTarget = ""
                    ingest.pickRefused("")
                } catch (why: SecurityException) {
                    scanTarget = ""
                    ingest.scanRefused(DocsCapture.Permission.PERMISSION_DENIED.value)
                }
            }
        }
        // THE BRIDGE'S PICKER SEAM, while this page is up: asked with the
        // kind, present the OS's sheet; its callback above answers exactly once.
        DisposableEffect(Unit) {
            val pick: (DocsDriveEvent.AddRequested.Kind) -> Unit = { kind ->
                try {
                    when (kind) {
                        DocsDriveEvent.AddRequested.Kind.KIND_UPLOAD -> upload.launch(arrayOf("*/*"))
                        DocsDriveEvent.AddRequested.Kind.KIND_SCAN -> {
                            // THE CAMERA OFF BY POLICY (MDM, a work profile):
                            // refused as RESTRICTED, in the machine's words.
                            val policy = context.getSystemService(android.app.admin.DevicePolicyManager::class.java)
                            if (policy?.getCameraDisabled(null) == true) {
                                ingest.scanRefused(DocsCapture.Permission.PERMISSION_RESTRICTED.value)
                            } else if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                                PackageManager.PERMISSION_GRANTED
                            ) {
                                launchScan()
                            } else {
                                cameraGrant.launch(Manifest.permission.CAMERA)
                            }
                        }
                        else -> ingest.pickCancelled()
                    }
                } catch (why: ActivityNotFoundException) {
                    // No app on this phone takes the intent: the machine's words.
                    ingest.pickRefused("")
                } catch (why: SecurityException) {
                    // THE CAMERA GRANT REFUSED. A declared-and-denied CAMERA
                    // makes `TakePicture` throw this (the grant can be
                    // revoked between the check and the launch), and the
                    // member hears the machine's sentence for a denied grant
                    // rather than a crash.
                    scanTarget = ""
                    ingest.scanRefused(DocsCapture.Permission.PERMISSION_DENIED.value)
                }
            }
            ingest.onPick = pick
            onDispose { if (ingest.onPick === pick) ingest.onPick = null }
        }
        DocsDriveScreen(
            state = state,
            folderPage = folderPage,
            onBack = nav::pop,
            onHome = nav::home,
            ingest = adding,
            onIngestRetry = ingest::retry,
            onIngestDismiss = ingest::dismiss,
            onOpenContainer = { card -> nav.open(card, parent = state.chrome?.title.orEmpty()) },
            onEvent = { event ->
                val sheet = state.sheet?.kind
                val key = event.action?.key
                when {
                    // The More sheet's Trash row is the shell's route.
                    sheet == DocsSheet.Kind.KIND_MORE && key == DocsWrites.KEY_TRASH_SHELF -> {
                        val opened = DocsDriveEvent(trash_opened = DocsDriveEvent.TrashOpened())
                        bridge.forward(opened)
                        nav.push(DocsRouting.drive(opened, state))
                    }
                    // The Add sheet's capture rows are the ingest's: the drive
                    // puts its sheet away (`AddRequested`), the bridge does the rest.
                    sheet == DocsSheet.Kind.KIND_ADD && key != null && key in CAPTURE -> {
                        val kind = when (key) {
                            DocsWrites.KEY_UPLOAD -> DocsDriveEvent.AddRequested.Kind.KIND_UPLOAD
                            DocsWrites.KEY_SCAN -> DocsDriveEvent.AddRequested.Kind.KIND_SCAN
                            else -> DocsDriveEvent.AddRequested.Kind.KIND_TEXT
                        }
                        bridge.forward(DocsDriveEvent(add_requested = DocsDriveEvent.AddRequested(kind = kind, folder_id = state.folder_id)))
                        ingest.requestFor(key, state.folder_id, state.chrome?.title.orEmpty())
                    }
                    else -> {
                        bridge.forward(event)
                        // A folder or a document, pushed with this page's title as its
                        // parent (`DocsRouting`); a folder with no id is the Folders tab.
                        if (event.folder_picked?.folder_id?.isEmpty() == true) toFoldersTab(nav) else nav.push(DocsRouting.drive(event, state))
                    }
                }
            },
        )
    }

    /**
     * THE FOLDERS TAB'S TOP LEVEL (a crumb with no id): back to the drive, on
     * Folders. Not a page, so not `DocsRouting`'s; iOS draws that crumb disabled.
     */
    private fun toFoldersTab(nav: RouteNav) {
        val entries = nav.stack.entries
        val root = entries.indexOfLast { it is Destination.DocsHome }
        if (root >= 0) {
            nav.go(NavStack(entries.take(root + 1)))
            drive.forward(DocsDriveEvent(band = DocsDriveEvent.BandPicked(key = DocsDriveMachine.BAND_FOLDERS)))
        }
    }

    private companion object {
        val CAPTURE: Set<String> = setOf(DocsWrites.KEY_UPLOAD, DocsWrites.KEY_SCAN, DocsWrites.KEY_TEXT)

        /** A scan is filed as a PDF (`DocsIngestFiles.scanToPdf`). */
        const val PDF: String = "application/pdf"
    }
}
