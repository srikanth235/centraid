package dev.centraid.android.kit

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.provider.OpenableColumns
import android.view.HapticFeedbackConstants
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
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
import dev.centraid.android.backup.MediaStoreDeleter
import dev.centraid.android.screens.docs.DocsPickers
import dev.centraid.android.screens.mediaPermissions
import dev.centraid.android.screens.performExportOriginals
import dev.centraid.android.screens.words.CodeScanDoor
import dev.centraid.android.session.AppSession
import dev.centraid.android.session.UiHost
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
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
    docs: DocsPickers,
    health: AndroidHealth,
    deleter: MediaStoreDeleter,
    openRoute: (Route) -> Unit,
) {
    val context = LocalContext.current
    val view = LocalView.current
    val asking = remember { Ask<Boolean>() }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { asking.answer(it) }
    val mediaAsk = remember { Ask<Unit>() }
    val mediaLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { mediaAsk.answer(Unit) }
    // HEALTH CONNECT'S OWN PERMISSION SHEET, shown at the member's Connect tap only.
    val healthLauncher = rememberLauncherForActivityResult(health.contract()) { granted -> health.permissionsAnswered(granted) }
    // THE FILE SHEETS (Locker's import and export): the system's pickers, one out at a time.
    val picking = remember { Ask<android.net.Uri?>() }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { picking.answer(it) }
    val saving = remember { Ask<android.net.Uri?>() }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { saving.answer(it) }
    // PAIRING'S SCAN (`ScanCode`): the camera, or the photo picker on a phone with none.
    val scanDoor = remember { CodeScanDoor() }
    scanDoor.Host()
    // THE CHAT'S PHOTO LIBRARY: the system photo picker, one image.
    val photoDoor = remember { ChatEffects.PhotoDoor() }
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { photoDoor.picked(it) }

    val host = remember(session, docs, health, deleter) {
        object : UiHost {
            private var shielded = false

        override suspend fun askMedia() {
            withContext(Dispatchers.Main) { mediaAsk.ask { mediaLauncher.launch(mediaPermissions()) } }
        }

        override suspend fun ask(permission: String): Boolean =
            withContext(Dispatchers.Main) { asking.ask { launcher.launch(permission) } }

        override suspend fun perform(request: EffectRequest, answer: (EffectResult) -> Unit): EffectResult? =
            withContext(Dispatchers.Main) {
                val effect = request.effect ?: return@withContext failed("no effect")
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
                    effect.health_read != null -> health.snapshot(effect.health_read!!) { healthLauncher.launch(it) }
                    effect.scan_code != null ->
                        scanDoor.scan(effect.scan_code!!.photo_label)?.let { EffectResult(code_scanned = CodeScanned(text = it)) }
                            ?: EffectResult(failed = EffectFailed(reason = "scan closed", cancelled = true))
                    effect.model_download != null -> ChatEffects.download(session.screens, request, effect.model_download!!)
                    effect.pick_library_photo != null -> ChatEffects.pickLibraryPhoto(context, photoDoor) {
                        photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    }
                    effect.export_originals != null ->
                        runCatching { performExportOriginals(context, session.core, effect.export_originals!!) }
                            .getOrElse { failed("the originals could not be handed off") }
                    effect.pick_bytes != null -> pickBytes(context, picking.ask { picker.launch(pickerTypes(effect.pick_bytes!!.accept)) })
                    effect.save_file != null -> {
                        val file = effect.save_file!!
                        saveFile(context, file, saving.ask { saver.launch(file.name) })
                    }
                    // FREE UP SPACE: the system's own confirmation, then the hashes whose asset went.
                    effect.library_delete != null -> {
                        val done = CompletableDeferred<centraid.core.v1.LibraryDeleted>()
                        deleter.delete(effect.library_delete!!.items) { done.complete(it) }
                        EffectResult(library_deleted = done.await())
                    }
                    effect.open_route != null -> {
                        effect.open_route!!.route?.let(openRoute)
                        EffectResult(done = EffectDone())
                    }
                    effect.pick_file != null -> {
                        docs.pick(effect.pick_file!!.kind, answer)
                        null
                    }
                    effect.follow_folder != null -> {
                        docs.follow(answer)
                        null
                    }
                    effect.stop_following != null -> {
                        docs.stop(effect.stop_following!!.origin, answer)
                        null
                    }
                    // Platform work this build does not perform: said by value, so nothing waits.
                    else -> failed("not performed by this shell")
                }
            }
        }
    }
    DisposableEffect(session, host) {
        session.effects.ui = host
        onDispose { if (session.effects.ui === host) session.effects.ui = null }
    }
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

/** `PickBytes`: the chosen document's bytes, handed to Rust and kept nowhere here; a dismissal is a cancel. */
private suspend fun pickBytes(context: Context, uri: android.net.Uri?): EffectResult {
    uri ?: return EffectResult(bytes_picked = BytesPicked(cancelled = true))
    return withContext(Dispatchers.IO) {
        runCatching {
            val resolver = context.contentResolver
            val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }.orEmpty()
            val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("unreadable")
            EffectResult(bytes_picked = BytesPicked(name = name, media_type = resolver.getType(uri).orEmpty(), content = bytes.toByteString()))
        }.getOrElse { failed("the file could not be read") }
    }
}

/** `SaveFile`: Rust's bytes to the document the member named and nowhere else; a dismissal is a cancel. */
private suspend fun saveFile(context: Context, file: centraid.core.v1.SaveFile, uri: android.net.Uri?): EffectResult {
    uri ?: return EffectResult(failed = EffectFailed(reason = "the save was cancelled", cancelled = true))
    return withContext(Dispatchers.IO) {
        runCatching {
            context.contentResolver.openOutputStream(uri)?.use { it.write(file.content.toByteArray()) } ?: error("unwritable")
            EffectResult(done = EffectDone())
        }.getOrElse { failed("the file could not be written") }
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
