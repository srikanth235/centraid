package dev.centraid.android.kit

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.view.HapticFeedbackConstants
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.health.connect.client.PermissionController
import androidx.core.content.FileProvider
import androidx.activity.result.IntentSenderRequest
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import centraid.core.v1.BytesPicked
import centraid.core.v1.CodeScanned
import centraid.core.v1.EffectDone
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectRequest
import centraid.core.v1.EffectResult
import centraid.core.v1.HapticKind
import centraid.core.v1.Route
import centraid.core.v1.ShellEffect
import centraid.core.v1.ShellEffectResult
import centraid.core.v1.ShellFailed
import centraid.core.v1.ShellDone
import centraid.core.v1.ShellPicked
import centraid.core.v1.ShellPickedItem
import centraid.core.v1.ShellPhotoDelete
import android.provider.MediaStore
import dev.centraid.android.backup.LibraryRefs
import centraid.core.v1.OwnerCheck
import centraid.core.v1.OwnerChecked
import dev.centraid.android.screens.mediaPermissions
import dev.centraid.android.screens.performExportOriginals
import dev.centraid.android.screens.words.CodeScanDoor
import dev.centraid.android.session.AppSession
import dev.centraid.android.session.Stage
import dev.centraid.android.session.UiHost
import java.io.File
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import okio.ByteString.Companion.toByteString

/**
 * THE ACTIVITY'S HALF OF THE PLATFORM WORK (#1135). The session performs every effect that needs
 * only a context (`session/ShellEffects.kt`); this composition hands it the ones that need the
 * activity — a haptic, a system prompt, a picker, the owner's check, a scan, a sheet, a page pushed —
 * for as long as it is composed, and nothing else. Nothing here names a screen or decides anything.
 *
 * [docs] performs Docs' `PickFile`, `FollowFolder` and `StopFollowing`; [health] answers `HealthRead`
 * with Health Connect's own permission sheet; [openRoute] is `OpenRoute`; [deleter] performs Free up
 * space's `LibraryDelete` behind the system's confirmation.
 */
@Composable
internal fun HostScreenEffects(
    session: AppSession.Open,
    openRoute: (Route) -> Unit,
) {
    val context = LocalContext.current
    val view = LocalView.current
    val asking = remember { Ask<Boolean>() }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { asking.answer(it) }
    val mediaAsk = remember { Ask<Unit>() }
    val mediaLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { mediaAsk.answer(Unit) }
    val picking = remember { Ask<android.net.Uri?>() }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { picking.answer(it) }
    val pickingMany = remember { Ask<List<android.net.Uri>>() }
    val manyPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { pickingMany.answer(it) }
    val photoPicking = remember { Ask<List<android.net.Uri>>() }
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(20)) { photoPicking.answer(it) }
    val photoPickingSingle = remember { Ask<android.net.Uri?>() }
    val photoPickerSingle = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { photoPickingSingle.answer(it) }
    val deleting = remember { Ask<Int>() }
    val deleteLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { deleting.answer(it.resultCode) }
    val pickingFolder = remember { Ask<android.net.Uri?>() }
    val folderPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { pickingFolder.answer(it) }
    val takingScan = remember { Ask<Boolean>() }
    val scanCamera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { takingScan.answer(it) }
    val askingHealth = remember { Ask<Set<String>>() }
    val healthPermissionLauncher = rememberLauncherForActivityResult(PermissionController.createRequestPermissionResultContract()) {
        askingHealth.answer(it)
    }
    val saving = SaveSheet.ask
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { saving.answer(it) }
    val scanDoor = remember { CodeScanDoor() }
    scanDoor.Host()

    val host = remember(session) {
        object : UiHost {
            private var shielded = false

        override suspend fun askMedia() {
            withContext(Dispatchers.Main) { mediaAsk.ask { mediaLauncher.launch(mediaPermissions()) } }
        }

        override suspend fun followCameraRoll(askPermission: Boolean): centraid.core.v1.FollowGrant {
            if (askPermission) askMedia()
            val imagePermission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
            val granted = context.checkSelfPermission(imagePermission) == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (granted) return centraid.core.v1.FollowGrant.FOLLOW_GRANT_GRANTED
            val selectedOnly = Build.VERSION.SDK_INT >= 34 &&
                context.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == android.content.pm.PackageManager.PERMISSION_GRANTED
            return if (selectedOnly) centraid.core.v1.FollowGrant.FOLLOW_GRANT_LIMITED else centraid.core.v1.FollowGrant.FOLLOW_GRANT_REFUSED
        }

        override suspend fun pickFollowFolder(): dev.centraid.android.session.FollowFolderPick {
            val tree = withContext(Dispatchers.Main) { pickingFolder.ask { folderPicker.launch(null) } }
                ?: return dev.centraid.android.session.FollowFolderPick(centraid.core.v1.FollowGrant.FOLLOW_GRANT_CANCELLED)
            return try {
                context.contentResolver.takePersistableUriPermission(
                    tree,
                    android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
                dev.centraid.android.session.FollowFolderPick(centraid.core.v1.FollowGrant.FOLLOW_GRANT_GRANTED, tree.toString())
            } catch (_: SecurityException) {
                dev.centraid.android.session.FollowFolderPick(centraid.core.v1.FollowGrant.FOLLOW_GRANT_UNAVAILABLE)
            }
        }

        override suspend fun askHealthPermissions(permissions: Set<String>): Set<String> = withContext(Dispatchers.Main) {
            askingHealth.ask { healthPermissionLauncher.launch(permissions) }
        }

        override suspend fun askStorePermission(system: String, askPermission: Boolean): Boolean {
            val permission = when (system) {
                "contacts" -> Manifest.permission.READ_CONTACTS
                "calendar" -> Manifest.permission.READ_CALENDAR
                else -> return false
            }
            if (context.checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED) return true
            return askPermission && ask(permission)
        }

        override suspend fun ask(permission: String): Boolean =
            withContext(Dispatchers.Main) { asking.ask { launcher.launch(permission) } }

        override suspend fun performShell(effect: ShellEffect): ShellEffectResult = withContext(Dispatchers.Main) {
            when {
                effect.owner_check != null -> {
                    val requested = effect.owner_check!!
                    val check = ownerCheckRequest(requested)
                    val checked = OwnerPrompt.check(context, check)
                    shellOwnerAnswer(requested.cancel, checked)
                }
                effect.save_file != null -> saveRoomFile(context, effect.save_file!!, saving.ask { saver.launch(effect.save_file!!.name) })
                effect.pick_file != null -> {
                    val pick = effect.pick_file!!
                    val result = if (pick.multiple) {
                        pickingMany.ask { manyPicker.launch(pickerTypes(pick.types)) }
                    } else {
                        listOfNotNull(picking.ask { picker.launch(pickerTypes(pick.types)) })
                    }
                    pickedItems(context, session.core, result)
                }
                effect.pick_photo != null -> {
                    val pick = effect.pick_photo!!
                    val media = when {
                        pick.video -> PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.VideoOnly)
                        else -> PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                    }
                    val result = if (pick.multiple) {
                        photoPicking.ask { photoPicker.launch(media) }
                    } else {
                        listOfNotNull(photoPickingSingle.ask { photoPickerSingle.launch(media) })
                    }
                    pickedItems(context, session.core, result)
                }
                effect.scan_document != null -> captureDocument(
                    context,
                    session.core,
                    { launch -> takingScan.ask(launch) },
                    scanCamera::launch,
                )
                effect.photo_delete != null -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    deletePhotos(context, effect.photo_delete!!, deleting, deleteLauncher::launch)
                } else {
                    ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNAVAILABLE))
                }
                else -> ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNAVAILABLE))
            }
        }

        override suspend fun perform(request: EffectRequest, answer: (EffectResult) -> Unit): EffectResult? =
            withContext(Dispatchers.Main) {
                val effect = request.effect ?: return@withContext failed(EffectReason.UNSUPPORTED)
                when {
                    effect.haptic != null -> {
                        view.performHapticFeedback(hapticOf(effect.haptic!!.kind))
                        EffectResult(done = EffectDone())
                    }
                    effect.screenshot_shield != null -> {
                        // COUNTED with the secure views' holds (`SecureHolds`): one shield is one hold.
                        context.activity()?.window?.let { window ->
                            val on = effect.screenshot_shield!!.on
                            if (on && !shielded) SecureHolds.take(window) else if (!on && shielded) SecureHolds.release(window)
                            shielded = on
                        }
                        EffectResult(done = EffectDone())
                    }
                    effect.owner_check != null -> OwnerPrompt.check(context, effect.owner_check!!)
                    effect.scan_code != null ->
                        scanDoor.scan(effect.scan_code!!.photo_label)?.let { EffectResult(code_scanned = CodeScanned(text = it)) }
                            ?: EffectResult(failed = EffectFailed(reason = EffectReason.CANCELLED, cancelled = true))
                    effect.model_download != null -> if (ModelFileTransfer.download(context, effect.model_download!!)) {
                        EffectResult(done = EffectDone())
                    } else {
                        failed(EffectReason.FAILED)
                    }
                    effect.delete_model_file != null -> ChatEffects.deleteModelFile(effect.delete_model_file!!)
                    effect.export_originals != null ->
                        effectAttempt { performExportOriginals(context, session.core, effect.export_originals!!) }
                            .getOrElse { failed(EffectReason.FAILED) }
                    effect.pick_bytes != null && effect.pick_bytes!!.folder ->
                        pickFolder(context, pickingFolder.ask { folderPicker.launch(null) }, effect.pick_bytes!!.accept, limitsOf(effect.pick_bytes!!))
                    effect.pick_bytes != null && effect.pick_bytes!!.multiple ->
                        pickMany(context, pickingMany.ask { manyPicker.launch(pickerTypes(effect.pick_bytes!!.accept)) }, limitsOf(effect.pick_bytes!!))
                    effect.pick_bytes != null ->
                        pickBytes(context, picking.ask { picker.launch(pickerTypes(effect.pick_bytes!!.accept)) }, limitsOf(effect.pick_bytes!!))
                    effect.save_file != null -> {
                        val file = effect.save_file!!
                        saveFile(context, file, saving.ask { saver.launch(file.name) })
                    }
                    effect.save_file_path != null -> {
                        val file = effect.save_file_path!!
                        try {
                            saveFilePath(file, saving.ask { saver.launch(file.name) }, context)
                        } finally {
                            withContext(NonCancellable + Dispatchers.IO) { File(file.path).delete() }
                        }
                    }
                    effect.open_route != null -> {
                        effect.open_route!!.route?.let(openRoute)
                        EffectResult(done = EffectDone())
                    }
                    effect.pick_file != null -> failed(EffectReason.UNSUPPORTED)
                    else -> failed(EffectReason.UNSUPPORTED)
                }
            }
        }
    }
    DisposableEffect(session, host) {
        session.effects.ui = host
        onDispose { if (session.effects.ui === host) session.effects.ui = null }
    }
}

internal fun ownerCheckRequest(effect: centraid.core.v1.ShellOwnerCheck): OwnerCheck = OwnerCheck(
    ask = !effect.cancel,
    cancel = effect.cancel,
    reason = effect.reason,
    title = effect.reason,
)

internal fun shellOwnerAnswer(cancelRequested: Boolean, checked: EffectResult): ShellEffectResult {
    if (cancelRequested) return ShellEffectResult(done = ShellDone())
    val answer = checked.owner_checked ?: return ShellEffectResult(failed = ShellFailed(reason = EffectReason.FAILED))
    if (!answer.available || answer.outcome == OwnerChecked.Outcome.OUTCOME_UNAVAILABLE) {
        return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNAVAILABLE))
    }
    if (answer.outcome == OwnerChecked.Outcome.OUTCOME_FAILED || answer.outcome == OwnerChecked.Outcome.OUTCOME_LOCKED_OUT) {
        return ShellEffectResult(failed = ShellFailed(reason = EffectReason.FAILED))
    }
    return ShellEffectResult(
        owner = centraid.core.v1.ShellOwner(
            passed = answer.outcome == OwnerChecked.Outcome.OUTCOME_SUCCEEDED,
            cancelled = answer.outcome == OwnerChecked.Outcome.OUTCOME_CANCELLED,
        ),
    )
}

/** The save sheet's answer, held for the life of the process (see [HostScreenEffects]). */
private object SaveSheet {
    val ask = Ask<android.net.Uri?>()
}

/** One system prompt or sheet out at a time, and its answer. */
private class Ask<T> {
    private var waiting: CompletableDeferred<T>? = null

    suspend fun ask(launch: () -> Unit): T {
        val answer = CompletableDeferred<T>()
        waiting?.cancel()
        waiting = answer
        launch()
        return answer.await()
    }

    fun answer(value: T) {
        waiting?.complete(value)
        waiting = null
    }
}

private fun limitsOf(pick: centraid.core.v1.PickBytes) = PickLimits(perFile = pick.max_bytes, total = pick.max_total_bytes)

private suspend fun saveRoomFile(context: Context, file: centraid.core.v1.ShellSaveFile, uri: android.net.Uri?): ShellEffectResult {
    uri ?: return ShellEffectResult(failed = ShellFailed(reason = EffectReason.CANCELLED, cancelled = true))
    return withContext(Dispatchers.IO) {
        try {
            File(file.path).inputStream().use { input ->
                context.contentResolver.openOutputStream(uri)?.use { output -> input.copyTo(output) } ?: error("unwritable")
            }
            ShellEffectResult(done = ShellDone())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNWRITABLE))
        }
    }
}

private suspend fun pickedItems(context: Context, core: dev.centraid.core.CentraidCore, uris: List<android.net.Uri>): ShellEffectResult {
    if (uris.isEmpty()) return ShellEffectResult(failed = ShellFailed(reason = EffectReason.CANCELLED, cancelled = true))
    return withContext(Dispatchers.IO) {
        try {
            val items = uris.map { uri ->
                val resolver = context.contentResolver
                val displayName = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0) else null
                } ?: "Picked file"
                val mediaType = resolver.getType(uri).orEmpty().ifBlank { "application/octet-stream" }
                val handle = resolver.openInputStream(uri)?.use { input ->
                    when (val result = Stage.stage(core, mediaType, 0L, read = Stage.slices(input))) {
                        is Stage.Outcome.Staged -> result.handle
                        is Stage.Outcome.Refused -> error("staging the selected bytes failed")
                    }
                } ?: error("unreadable")
                ShellPickedItem(
                    stage_handle = handle,
                    name = displayName,
                    media_type = mediaType,
                    size = handle.byte_size,
                )
            }
            ShellEffectResult(picked = ShellPicked(items = items))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNREADABLE))
        }
    }
}

@androidx.annotation.RequiresApi(android.os.Build.VERSION_CODES.R)
private suspend fun deletePhotos(
    context: Context,
    request: ShellPhotoDelete,
    asking: Ask<Int>,
    launch: (IntentSenderRequest) -> Unit,
): ShellEffectResult {
    if (request.ids.isEmpty()) return ShellEffectResult(done = ShellDone())
    val uris = request.ids.map { ref ->
        val row = LibraryRefs.row(ref) ?: return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNREADABLE))
        val collection = if (row.video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        android.content.ContentUris.withAppendedId(collection, row.id)
    }
    val pending = try {
        MediaStore.createDeleteRequest(context.contentResolver, uris)
    } catch (_: Exception) {
        return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNWRITABLE))
    }
    val result = asking.ask { launch(IntentSenderRequest.Builder(pending.intentSender).build()) }
    return if (result == android.app.Activity.RESULT_OK) {
        ShellEffectResult(done = ShellDone())
    } else {
        ShellEffectResult(failed = ShellFailed(reason = EffectReason.CANCELLED, cancelled = true))
    }
}

/**
 * `PickBytes`: the chosen document's bytes, handed to Rust and kept nowhere here; a dismissal is a cancel.
 * A file over the importer's ceiling is not read: it answers `too_large`.
 */
private suspend fun pickBytes(context: Context, uri: android.net.Uri?, limits: PickLimits): EffectResult {
    uri ?: return EffectResult(bytes_picked = BytesPicked(cancelled = true))
    return withContext(Dispatchers.IO) {
        runCatching {
            val resolver = context.contentResolver
            val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }.orEmpty()
            when (val read = limits.read(context, uri)) {
                is PickLimits.Read.Bytes ->
                    EffectResult(bytes_picked = BytesPicked(name = name, media_type = resolver.getType(uri).orEmpty(), content = read.bytes.toByteString()))
                PickLimits.Read.TooLarge -> failed(EffectReason.TOO_LARGE)
                PickLimits.Read.Unreadable -> failed(EffectReason.UNREADABLE)
            }
        }.getOrElse { failed(EffectReason.UNREADABLE) }
    }
}

/** `SaveFile`: Rust's bytes to the document the member named and nowhere else; a dismissal is a cancel. */
private suspend fun saveFile(context: Context, file: centraid.core.v1.SaveFile, uri: android.net.Uri?): EffectResult {
    uri ?: return EffectResult(failed = EffectFailed(reason = EffectReason.CANCELLED, cancelled = true))
    return withContext(Dispatchers.IO) {
        try {
            context.contentResolver.openOutputStream(uri)?.use { it.write(file.content.toByteArray()) } ?: error("unwritable")
            EffectResult(done = EffectDone())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            Log.w("Centraid", "the saved file was not written: $error")
            failed(error.writeFailureReason(EffectReason.UNWRITABLE))
        }
    }
}

/**
 * `SaveFilePath`: the staged file (a streamed export, too large to hold in memory) copied to the
 * document the member named, in 64 KiB pieces from an input stream to the resolver's output
 * stream; a dismissal is a cancel. The caller deletes the staged file.
 */
private suspend fun saveFilePath(file: centraid.core.v1.SaveFilePath, uri: android.net.Uri?, context: Context): EffectResult {
    uri ?: return EffectResult(failed = EffectFailed(reason = EffectReason.CANCELLED, cancelled = true))
    return withContext(Dispatchers.IO) {
        try {
            File(file.path).inputStream().use { input ->
                context.contentResolver.openOutputStream(uri)?.use { output -> input.copyTo(output, 64 * 1024) } ?: error("unwritable")
            }
            EffectResult(done = EffectDone())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            // LOGGED, NOT SWALLOWED: a save that leaves 0 bytes must say why.
            Log.w("Centraid", "the export was not written: $error")
            failed(error.writeFailureReason(EffectReason.UNWRITABLE))
        }
    }
}

private fun failed(reason: String) = EffectResult(failed = EffectFailed(reason = reason))

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

private fun hapticOf(kind: HapticKind): Int = when (kind) {
    HapticKind.HAPTIC_KIND_SELECTION -> HapticFeedbackConstants.CLOCK_TICK
    HapticKind.HAPTIC_KIND_SUCCESS ->
        if (android.os.Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.LONG_PRESS
    HapticKind.HAPTIC_KIND_ERROR ->
        if (android.os.Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
    else -> HapticFeedbackConstants.LONG_PRESS
}
