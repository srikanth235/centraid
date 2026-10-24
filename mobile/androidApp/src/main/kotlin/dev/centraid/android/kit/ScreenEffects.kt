package dev.centraid.android.kit

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ClipDescription
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.content.ContextCompat
import centraid.core.v1.CameraRead
import centraid.core.v1.CameraRoll
import centraid.core.v1.Effect
import centraid.core.v1.EffectDone
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectResult
import centraid.core.v1.FreeUpFacts
import centraid.core.v1.FreeUpSpace
import centraid.core.v1.HapticKind
import centraid.core.v1.ImportSource
import centraid.core.v1.KeychainOp
import centraid.core.v1.KeychainValue
import centraid.core.v1.OriginalFetched
import centraid.core.v1.PhoneChanged
import dev.centraid.android.screens.PhotoHandOff
import dev.centraid.android.screens.agenda.readCalendarSnapshot
import dev.centraid.android.screens.mediaPermissions
import dev.centraid.android.screens.performExportOriginals
import dev.centraid.android.screens.photos.PhotosEditRender
import dev.centraid.core.CentraidCore
import dev.centraid.core.Screens
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.shell.PhotosDevice
import dev.centraid.shared.sync.phone.PhoneDevice
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okio.ByteString

/**
 * THE PLATFORM WORK THE SCREEN RUNTIME ASKS FOR (#1135): one performer for every
 * screen, naming none. Rust sends an [EffectRequest]; this does it and answers
 * with the same `effect_id` ([Screens.answer]). Only the effects this shell can
 * perform are here — clipboard, haptic, share, open URL, the keychain (the
 * secure store), the phone's calendars (`CalendarRead`) and the watch on a phone
 * store (`PhoneWatch`); anything else is answered `failed`, by value, so the
 * screen that asked is never left waiting.
 *
 * **The calendar permission is asked here, at the member's Import tap**
 * (`ask_permission`), through the activity's launcher; a following pass sets it
 * false and is answered `denied` when the OS has not already allowed it.
 *
 * [phone] is the activity's watcher of the phone's stores; a `PhoneWatch` with no
 * watcher is answered `failed`.
 */
@Composable
internal fun PerformScreenEffects(
    screens: Screens,
    phone: AndroidPhoneFollow?,
    /** Photos' device half: the camera roll, free up space and an original from the gateway. */
    photos: PhotosDevice? = null,
    /** This app's tab: when set, only its instances' effects are performed here (two apps share one core). */
    tab: String? = null,
) {
    val context = LocalContext.current
    val view = LocalView.current
    val asking = remember { CalendarPermission() }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        asking.answer(granted)
    }
    val mediaAsk = remember { MediaPermissionAsk() }
    val mediaLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        mediaAsk.answer()
    }
    LaunchedEffect(screens) {
        screens.effects.collect { request ->
            // TWO APPS' RUNTIMES SHARE ONE CORE, so each hears every push: an effect for
            // another app's screen is that app's performer's to answer.
            if (tab != null && screens.navigation.value?.tabs?.firstOrNull { it.tab == tab }
                    ?.entries?.none { it.instance == request.instance } != false
            ) {
                return@collect
            }
            // ONE COROUTINE PER EFFECT: a permission dialog waits for the member
            // without holding up the keychain read behind it.
            launch {
                val effect = request.effect
                val result = perform(
                    effect, context, view, asking, { launcher.launch(it) }, phone, screens.core, photos,
                    { mediaAsk.ask { mediaLauncher.launch(mediaPermissions()) } },
                ) { changed ->
                    launch { screens.answer(request, EffectResult(phone_changed = changed)) }
                }
                if (result != null) screens.answer(request, result)
            }
        }
    }
}

/** The one permission prompt that may be out, and its answer. */
private class CalendarPermission {
    private var waiting: CompletableDeferred<Boolean>? = null

    fun ask(launch: (String) -> Unit): CompletableDeferred<Boolean> {
        val answer = CompletableDeferred<Boolean>()
        waiting = answer
        launch(Manifest.permission.READ_CALENDAR)
        return answer
    }

    fun answer(granted: Boolean) {
        waiting?.complete(granted)
        waiting = null
    }
}

/** The answer to [request], or null when the effect answers itself later (`PhoneWatch` on). */
private suspend fun perform(
    effect: Effect?,
    context: Context,
    view: View,
    asking: CalendarPermission,
    launchPermission: (String) -> Unit,
    phone: AndroidPhoneFollow?,
    core: CentraidCore,
    photos: PhotosDevice?,
    askMedia: suspend () -> Unit,
    report: (PhoneChanged) -> Unit,
): EffectResult? {
    val done = EffectResult(done = EffectDone())
    return when {
        effect == null -> failed("no effect")
        effect.clipboard_set != null -> {
            val set = effect.clipboard_set!!
            val clip = ClipData.newPlainText("", set.text)
            if (set.sensitive && Build.VERSION.SDK_INT >= 33) {
                clip.description.extras = PersistableBundle().apply {
                    putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
                }
            }
            clipboard(context).setPrimaryClip(clip)
            done
        }
        effect.clipboard_clear != null -> {
            // Only what the core put there: never clear something copied since.
            val held = clipboard(context).primaryClip?.getItemAt(0)?.text?.toString()
            if (held == effect.clipboard_clear!!.expected_text) {
                clipboard(context).setPrimaryClip(ClipData.newPlainText("", ""))
            }
            done
        }
        effect.haptic != null -> {
            view.performHapticFeedback(hapticOf(effect.haptic!!.kind))
            done
        }
        effect.share != null -> {
            val share = effect.share!!
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, listOf(share.text, share.url).filter { it.isNotEmpty() }.joinToString("\n"))
                if (share.subject.isNotEmpty()) putExtra(Intent.EXTRA_SUBJECT, share.subject)
            }
            start(context, Intent.createChooser(send, share.subject.ifEmpty { null }), done)
        }
        effect.open_url != null ->
            start(context, Intent(Intent.ACTION_VIEW, Uri.parse(effect.open_url!!.url)), done)
        effect.keychain != null -> keychain(effect.keychain!!)
        // THE ORIGINALS OF A PICK, to the share sheet or this phone's photos.
        effect.export_originals != null ->
            runCatching { performExportOriginals(context, core, effect.export_originals!!) }
                .getOrElse { failed("the originals could not be handed off") }
        // THE PHOTOS DEVICE HALF (#1135): the roll, the free-up flow and an original
        // back from the gateway. The roll itself is the shell's; Rust only asks.
        effect.camera_roll != null -> cameraRoll(context, photos, effect.camera_roll!!, askMedia)
        effect.free_up_space != null -> {
            val device = photos ?: return failed("this shell has no photos device")
            val free = effect.free_up_space!!.action == FreeUpSpace.Action.ACTION_FREE
            val answer = CompletableDeferred<ByteArray>()
            device.freeUp(free) { answer.complete(it) }
            EffectResult(free_up_facts = FreeUpFacts.ADAPTER.decode(answer.await()))
        }
        effect.fetch_original != null -> {
            val device = photos ?: return failed("this shell has no photos device")
            val answer = CompletableDeferred<ByteArray>()
            device.fetchOriginal(effect.fetch_original!!.content_hash) { answer.complete(it) }
            EffectResult(original_fetched = OriginalFetched.ADAPTER.decode(answer.await()))
        }
        effect.calendar_read != null -> {
            val read = effect.calendar_read!!
            val allowed = granted(context) ||
                (read.ask_permission && asking.ask(launchPermission).await())
            if (!allowed) {
                EffectResult(failed = EffectFailed(reason = "calendar access is off", denied = true))
            } else {
                runCatching {
                    withContext(Dispatchers.IO) {
                        readCalendarSnapshot(context, read.days_back, read.days_on, PhoneDevice.id())
                    }
                }.fold(
                    onSuccess = { EffectResult(calendar = it) },
                    onFailure = { failed("the calendar could not be read") },
                )
            }
        }
        effect.phone_watch != null -> {
            val watch = effect.phone_watch!!
            when {
                phone == null || watch.source != ImportSource.IMPORT_SOURCE_CALENDAR ->
                    failed("this phone store is not watched by this shell")
                watch.on -> {
                    // ANSWERED EACH TIME THE STORE CHANGES, under this one effect id.
                    phone.watchCalendar { report(PhoneChanged(source = watch.source)) }
                    null
                }
                else -> {
                    phone.watchCalendar(null)
                    done
                }
            }
        }
        // PHOTOS' ONE-PHOTOGRAPH PAGES (#1135): the camera the original's header
        // names, and the editor's pixel work.
        effect.read_camera != null -> {
            val camera = withContext(Dispatchers.IO) { PhotoHandOff.cameraOf(effect.read_camera!!.path) }
            EffectResult(camera_read = CameraRead(camera = camera.orEmpty()))
        }
        effect.render_edit != null ->
            PhotosEditRender.perform(context.cacheDir, core, effect.render_edit!!)
        // Platform work this build does not perform yet: say so, by value.
        else -> failed("not performed by this shell")
    }
}

private fun failed(reason: String) = EffectResult(failed = EffectFailed(reason = reason))

/** The one media-permission prompt that may be out, and its answer. */
private class MediaPermissionAsk {
    private var waiting: CompletableDeferred<Unit>? = null

    suspend fun ask(launch: () -> Unit) {
        val answer = CompletableDeferred<Unit>()
        waiting = answer
        launch()
        answer.await()
    }

    fun answer() {
        waiting?.complete(Unit)
        waiting = null
    }
}

/**
 * THE CAMERA ROLL'S REMEDIES (D-1025-S7-75). Which one, and its words, are Rust's;
 * this launches what the platform needs for it.
 *
 * * ask: the system's own prompt, then the roll reads the grant fresh and walks
 *   on a grant. The prompt belongs to the activity (`MediaLibrary.requestPermission`
 *   on Android reads the grant and cannot ask).
 * * settings: this app's own page there, the one place a member can change an
 *   answer Android has stopped asking about.
 * * manage selection: Android 14's selected-photos grant, edited by asking again.
 * * import now: a pass of the roll.
 */
private suspend fun cameraRoll(
    context: Context,
    photos: PhotosDevice?,
    roll: CameraRoll,
    askMedia: suspend () -> Unit,
): EffectResult {
    val done = EffectResult(done = EffectDone())
    return when (roll.action) {
        CameraRoll.Action.ACTION_ASK_PERMISSION, CameraRoll.Action.ACTION_MANAGE_SELECTION -> {
            askMedia()
            photos?.perform(PhotosDevice.ACTION_ASK_PERMISSION)
            done
        }
        CameraRoll.Action.ACTION_OPEN_SETTINGS -> start(
            context,
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", context.packageName, null),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            done,
        )
        CameraRoll.Action.ACTION_IMPORT_NOW -> {
            photos?.perform(PhotosDevice.ACTION_IMPORT_NOW)
            done
        }
        CameraRoll.Action.ACTION_UNSPECIFIED -> failed("no camera roll action")
    }
}

private fun clipboard(context: Context): ClipboardManager =
    context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

private fun start(context: Context, intent: Intent, done: EffectResult): EffectResult = try {
    context.startActivity(intent)
    done
} catch (_: ActivityNotFoundException) {
    failed("no app on this phone answers")
}

private fun granted(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED

private fun hapticOf(kind: HapticKind): Int = when (kind) {
    HapticKind.HAPTIC_KIND_SELECTION -> HapticFeedbackConstants.CLOCK_TICK
    HapticKind.HAPTIC_KIND_SUCCESS ->
        if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.LONG_PRESS
    HapticKind.HAPTIC_KIND_ERROR ->
        if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
    else -> HapticFeedbackConstants.LONG_PRESS
}

/**
 * THE KEYCHAIN IS THE SECURE STORE (Keystore-sealed, off Auto Backup). A value
 * is the UTF-8 text of its bytes; setting an empty value, like a delete, removes
 * the item.
 */
private suspend fun keychain(op: KeychainOp): EffectResult {
    val store = platformServices().secureStore
    return when (op.op) {
        KeychainOp.Op.OP_GET -> {
            val value = store.read(op.key)
            EffectResult(
                keychain = KeychainValue(
                    found = value != null,
                    value_ = value?.let { ByteString.of(*it.toByteArray(Charsets.UTF_8)) } ?: ByteString.EMPTY,
                ),
            )
        }
        KeychainOp.Op.OP_SET -> {
            store.write(op.key, op.value_.utf8())
            EffectResult(done = EffectDone())
        }
        KeychainOp.Op.OP_DELETE -> {
            store.write(op.key, "")
            EffectResult(done = EffectDone())
        }
        else -> failed("unknown keychain operation")
    }
}
