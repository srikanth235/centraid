package dev.centraid.android.screens.docs

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.activity.compose.ManagedActivityResultLauncher
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import centraid.core.v1.EffectDone
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectResult
import centraid.core.v1.FilePicked
import centraid.core.v1.FileProgress
import centraid.core.v1.FolderFollowed
import centraid.core.v1.PickFile
import dev.centraid.shared.apps.docs.DocsFollowBridge
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.StageFileBridge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okio.ByteString.Companion.EMPTY
import java.io.File

/**
 * WHAT DOCS' EFFECTS NEED FROM THE SESSION (#1135): the stage door that a picked file
 * streams through, and the vault's half of following a folder. Attached once, with the
 * session (`AgendaRoutes.attach`).
 */
internal class DocsFiles {
    val stage = StageFileBridge()
    val follow = DocsFollowBridge()

    fun attach(session: HomeSession) {
        stage.attach(session)
        follow.attach(session)
    }
}

/**
 * THE PLATFORM'S HALF OF `PickFile`, `FollowFolder` AND `StopFollowing` (#1047 R-1047-Q4,
 * #1127): the system file picker (`OpenDocument`), the system camera (`TakePicture`, written
 * out as a one-page PDF), the CAMERA grant and the folder picker (`OpenDocumentTree`). Rust
 * asks; this raises the right picker and answers with [EffectResult]s under the effect's one id —
 * progress while the bytes stream through the stage door, then `FilePicked`; `Done` for a
 * closed picker; `Failed` (`denied` for a refused grant, `unavailable` for a phone with
 * no picker) for a refusal. What is filed, and what the member reads, is Rust's.
 */
internal class DocsPickers(
    private val context: Context,
    private val files: DocsFiles,
    private val scope: CoroutineScope,
    private val onFollowed: () -> Unit,
) {
    private var answer: ((EffectResult) -> Unit)? = null
    internal var upload: ManagedActivityResultLauncher<Array<String>, Uri?>? = null
    internal var scan: ManagedActivityResultLauncher<Uri, Boolean>? = null
    internal var cameraGrant: ManagedActivityResultLauncher<String, Boolean>? = null
    internal var folders: ManagedActivityResultLauncher<Uri?, Uri?>? = null
    internal var scanTarget: String = ""
    internal var setScanTarget: (String) -> Unit = {}

    /** Rust asked for a file. */
    fun pick(kind: PickFile.Kind, answer: (EffectResult) -> Unit) {
        this.answer = answer
        try {
            when (kind) {
                PickFile.Kind.KIND_SCAN -> scan()
                else -> upload?.launch(arrayOf("*/*")) ?: fail(UNAVAILABLE)
            }
        } catch (why: ActivityNotFoundException) {
            // No app on this phone takes the intent.
            fail(UNAVAILABLE)
        } catch (why: SecurityException) {
            // A declared-and-denied CAMERA makes `TakePicture` throw; the grant can be
            // revoked between the check and the launch.
            setScanTarget("")
            fail("camera", denied = true)
        }
    }

    private fun scan() {
        // THE CAMERA OFF BY POLICY (MDM, a work profile): refused as denied.
        val policy = context.getSystemService(android.app.admin.DevicePolicyManager::class.java)
        when {
            !context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) -> fail(UNAVAILABLE)
            policy?.getCameraDisabled(null) == true -> fail("camera", denied = true)
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED -> launchScan()
            else -> cameraGrant?.launch(Manifest.permission.CAMERA) ?: fail(UNAVAILABLE)
        }
    }

    private fun launchScan() {
        val (file, uri) = DocsIngestFiles.scanTarget(context)
        scanTarget = file.absolutePath
        setScanTarget(scanTarget)
        scan?.launch(uri) ?: fail(UNAVAILABLE)
    }

    /** The camera grant was answered. */
    fun cameraAnswered(granted: Boolean) {
        if (!granted) return fail("camera", denied = true)
        try {
            launchScan()
        } catch (why: ActivityNotFoundException) {
            setScanTarget("")
            fail(UNAVAILABLE)
        } catch (why: SecurityException) {
            setScanTarget("")
            fail("camera", denied = true)
        }
    }

    /** The picker returned [uri]: the stream is copied into the cache off the main thread, then staged. */
    fun uploaded(uri: Uri?) {
        if (uri == null) return done()
        scope.launch {
            val copied = withContext(Dispatchers.IO) { DocsIngestFiles.copy(context, uri) }
            if (copied == null) fail("the file cannot be read") else stage(copied.path, copied.name, mediaTypeOf(copied.name, copied.mediaType))
        }
    }

    /** The camera returned: the photograph becomes a one-page PDF, which is staged. */
    fun scanned(taken: Boolean, saved: String) {
        val photo = saved.takeIf { it.isNotEmpty() }?.let(::File)
        setScanTarget("")
        if (!taken || photo == null) {
            photo?.let(DocsIngestFiles::discard)
            return done()
        }
        scope.launch {
            val pdf = withContext(Dispatchers.IO) { DocsIngestFiles.scanToPdf(context, photo) }
            if (pdf == null) fail("the scan cannot be read") else stage(pdf.absolutePath, "", PDF)
        }
    }

    private fun stage(path: String, name: String, mediaType: String) {
        val answer = answer
        files.stage.stage(
            path = path,
            mediaType = mediaType,
            progress = { sent, total ->
                answer?.invoke(EffectResult(file_progress = FileProgress(staged_bytes = sent, total_bytes = total, name = name)))
            },
            staged = { blob, size ->
                DocsIngestFiles.discard(File(path))
                answer?.invoke(EffectResult(file_picked = FilePicked(blob = blob, byte_size = size, name = name, media_type = mediaType)))
            },
            refused = { reason ->
                DocsIngestFiles.discard(File(path))
                answer?.invoke(EffectResult(failed = EffectFailed(reason = reason)))
            },
        )
        this.answer = null
    }

    // FOLLOW A FOLDER (#1127, R-1127-7): the system's folder picker, raised only by the member's
    // own tap. The grant is kept (`FolderAccess`), the vault told, and the follower asked for a
    // pass; a pick of a folder already followed is a pass and no more.

    fun follow(answer: (EffectResult) -> Unit) {
        this.answer = answer
        try {
            folders?.launch(null) ?: fail(UNAVAILABLE)
        } catch (why: ActivityNotFoundException) {
            fail(UNAVAILABLE)
        }
    }

    /** The folder picker returned [tree]. */
    fun treePicked(tree: Uri?) {
        if (tree == null) return done()
        if (FolderAccess.following(context, tree) != null) {
            onFollowed()
            return done()
        }
        val origin = files.follow.mintOrigin()
        if (!FolderAccess.remember(context, origin, tree)) return fail("the folder could not be followed")
        val name = FolderAccess.name(context, tree).ifEmpty { tree.lastPathSegment.orEmpty() }
        files.follow.follow(origin, name) { followed ->
            if (followed) {
                onFollowed()
                answer?.invoke(EffectResult(folder_followed = FolderFollowed(origin = origin, name = name)))
                answer = null
            } else {
                FolderAccess.forget(context, origin)
                fail("the folder could not be followed")
            }
        }
    }

    /** "Stop following": the vault forgets the links (every document stays), then the grant goes. */
    fun stop(origin: String, answer: (EffectResult) -> Unit) {
        files.follow.stop(origin) { stopped ->
            if (stopped) FolderAccess.forget(context, origin)
            answer(EffectResult(done = EffectDone()))
        }
    }

    private fun done() {
        answer?.invoke(EffectResult(done = EffectDone()))
        answer = null
    }

    private fun fail(reason: String, denied: Boolean = false) {
        answer?.invoke(EffectResult(failed = EffectFailed(reason = reason, denied = denied)))
        answer = null
    }

    private companion object {
        /** The reason a phone with no picker or scanner answers (`PickFile`'s contract). */
        const val UNAVAILABLE: String = "unavailable"
        const val PDF: String = "application/pdf"
        const val OCTET_STREAM: String = "application/octet-stream"

        /** The provider's type, else the extension's, else bytes nothing will draw. */
        fun mediaTypeOf(name: String, stated: String): String {
            if (stated.isNotBlank()) return stated.trim()
            val extension = name.substringAfterLast('.', "").lowercase()
            return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: OCTET_STREAM
        }
    }
}

/** The launchers the pickers use, registered with the composition that performs the effects. */
@Composable
internal fun rememberDocsPickers(files: DocsFiles, onFollowed: () -> Unit): DocsPickers {
    val context = LocalContext.current.applicationContext
    val scope = rememberCoroutineScope()
    val pickers = remember(files) { DocsPickers(context, files, scope, onFollowed) }
    // The camera's target survives the activity being recreated behind it.
    var target by rememberSaveable { mutableStateOf("") }
    pickers.setScanTarget = { target = it }
    pickers.scanTarget = target
    pickers.upload = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { pickers.uploaded(it) }
    pickers.scan = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { pickers.scanned(it, target) }
    pickers.cameraGrant = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { pickers.cameraAnswered(it) }
    pickers.folders = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { pickers.treePicked(it) }
    return pickers
}
