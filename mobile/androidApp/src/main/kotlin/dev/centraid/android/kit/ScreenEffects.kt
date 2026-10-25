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
import centraid.core.v1.BackgroundStatus
import centraid.core.v1.CameraRead
import centraid.core.v1.CodeScanned
import centraid.core.v1.CameraRoll
import centraid.core.v1.Effect
import centraid.core.v1.EffectDone
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectResult
import centraid.core.v1.FreeUpFacts
import centraid.core.v1.FreeUpSpace
import centraid.core.v1.BytesPicked
import centraid.core.v1.FilePicked
import centraid.core.v1.HapticKind
import centraid.core.v1.ImportSource
import centraid.core.v1.KeychainOp
import centraid.core.v1.KeychainValue
import centraid.core.v1.OriginalFetched
import centraid.core.v1.PhoneChanged
import centraid.core.v1.Route
import dev.centraid.android.screens.PhotoHandOff
import dev.centraid.android.screens.agenda.readCalendarSnapshot
import android.provider.OpenableColumns
import dev.centraid.android.screens.docs.DocsPickers
import dev.centraid.android.screens.mediaPermissions
import dev.centraid.android.screens.people.readContactsSnapshot
import dev.centraid.android.screens.words.CodeScanDoor
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
 * secure store), the phone's calendars (`CalendarRead`) and address book
 * (`ContactsRead`), a map (`OpenMap`) and the watch on a phone store
 * (`PhoneWatch`); anything else is answered `failed`, by value, so the
 * screen that asked is never left waiting.
 *
 * **The calendar's and the contacts' permission is asked here, at the member's
 * Import tap** (`ask_permission`), through the activity's launcher; a following
 * pass sets it false and is answered `denied` when the OS has not already
 * allowed it.
 *
 * [phone] is the activity's watcher of the phone's stores; a `PhoneWatch` with no
 * watcher is answered `failed`.
 *
 * [docs] performs Docs' `PickFile`, `FollowFolder` and `StopFollowing` (the pickers, the
 * camera, the follower's grant); [openRoute] is `OpenRoute`: a page Rust asked the shell to push.
 * [health] answers `HealthRead` (Health Connect, read only). Either is null where the host has none, and the effect is answered `failed`.
 */
@Composable
internal fun PerformScreenEffects(
    screens: Screens,
    phone: AndroidPhoneFollow?,
    /** Photos' device half: the camera roll, free up space and an original from the gateway. */
    photos: PhotosDevice? = null,
    /** This app's tab: when set, only its instances' effects are performed here (two apps share one core). */
    tab: String? = null,
    onAnnounce: (String) -> Unit = {},
    docs: DocsPickers? = null,
    health: AndroidHealth? = null,
    openRoute: ((Route) -> Unit)? = null,
    /** Whether the platform took a background window, as the session last registered it; null before it says. */
    backgroundRegistered: (() -> Boolean?)? = null,
) {
    val context = LocalContext.current
    val view = LocalView.current
    val asking = remember { PermissionAsk() }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        asking.answer(granted)
    }
    val mediaAsk = remember { MediaPermissionAsk() }
    val mediaLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        mediaAsk.answer()
    }
    // HEALTH CONNECT'S OWN PERMISSION SHEET, shown at the member's Connect tap only.
    val healthLauncher = health?.let { store ->
        rememberLauncherForActivityResult(store.contract()) { granted -> store.permissionsAnswered(granted) }
    }
    // THE FILE SHEETS (Locker's import and export): the system's pickers, one out at a time.
    val fileDoors = remember { FileDoors() }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> fileDoors.picked(uri) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri -> fileDoors.saved(uri) }
    // PAIRING'S SCAN (`ScanCode`): the camera, or the photo picker on a phone with none.
    val scanDoor = remember { CodeScanDoor() }
    scanDoor.Host()
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
                val doors = Doors(fileDoors, { picker.launch(arrayOf("*/*")) }, { saver.launch(it) }, onAnnounce)
                val answer: (EffectResult) -> Unit = { result -> launch { screens.answer(request, result) } }
                val result = if (effect?.background_probe != null) {
                    // THE PLATFORM'S LAST WORD on whether it will wake Centraid; nothing is registered by asking.
                    val registered = backgroundRegistered?.invoke()
                    if (registered == null) failed("not performed by this shell")
                    else EffectResult(background_status = BackgroundStatus(registered = registered))
                } else if (effect?.health_read != null) {
                    health?.snapshot(effect.health_read!!) { healthLauncher?.launch(it) }
                        ?: failed("not performed by this shell")
                } else if (effect?.scan_code != null) {
                    scanDoor.scan(effect.scan_code!!.photo_label)?.let { EffectResult(code_scanned = CodeScanned(text = it)) }
                        ?: EffectResult(failed = EffectFailed(reason = "scan closed", cancelled = true))
                } else if (effect?.pick_file != null || effect?.follow_folder != null || effect?.stop_following != null || effect?.open_route != null) {
                    files(effect, docs, openRoute, answer)
                } else {
                    perform(
                        effect, context, view, asking, { launcher.launch(it) }, phone, doors, screens.core, photos,
                        { mediaAsk.ask { mediaLauncher.launch(mediaPermissions()) } },
                    ) { changed ->
                        answer(EffectResult(phone_changed = changed))
                    }
                }
                if (result != null) screens.answer(request, result)
            }
        }
    }
}

/** The one permission prompt that may be out, and its answer. */
private class PermissionAsk {
    private var waiting: CompletableDeferred<Boolean>? = null

    fun ask(permission: String, launch: (String) -> Unit): CompletableDeferred<Boolean> {
        val answer = CompletableDeferred<Boolean>()
        waiting = answer
        launch(permission)
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
    asking: PermissionAsk,
    launchPermission: (String) -> Unit,
    phone: AndroidPhoneFollow?,
    doors: Doors,
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
            // THE DEADLINE OUTLIVES THE PROCESS: kept beside the clip, swept on the next launch.
            ClipboardDeadline.armed(context, set.text, set.clear_after_ms.toLong())
            done
        }
        effect.clipboard_clear != null -> {
            // Only what the core put there: never clear something copied since.
            val held = clipboard(context).primaryClip?.getItemAt(0)?.text?.toString()
            if (held == effect.clipboard_clear!!.expected_text) {
                clipboard(context).setPrimaryClip(ClipData.newPlainText("", ""))
            }
            ClipboardDeadline.spent(context)
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
        effect.owner_check != null -> OwnerPrompt.check(context, effect.owner_check!!)
        effect.pick_bytes != null -> doors.files.pick(context, doors.launchPicker)
        effect.save_file != null -> doors.files.save(context, effect.save_file!!, doors.launchSaver)
        effect.announce != null -> {
            doors.announce(effect.announce!!.topic)
            done
        }
        effect.calendar_read != null -> {
            val read = effect.calendar_read!!
            val allowed = granted(context, Manifest.permission.READ_CALENDAR) ||
                (read.ask_permission && asking.ask(Manifest.permission.READ_CALENDAR, launchPermission).await())
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
        effect.contacts_read != null -> {
            val read = effect.contacts_read!!
            val allowed = granted(context, Manifest.permission.READ_CONTACTS) ||
                (read.ask_permission && asking.ask(Manifest.permission.READ_CONTACTS, launchPermission).await())
            if (!allowed) {
                EffectResult(failed = EffectFailed(reason = "contacts access is off", denied = true))
            } else {
                runCatching {
                    withContext(Dispatchers.IO) { readContactsSnapshot(context, PhoneDevice.id()) }
                }.fold(
                    onSuccess = { EffectResult(contacts = it) },
                    onFailure = { failed("the address book could not be read") },
                )
            }
        }
        effect.open_map != null ->
            start(context, Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(effect.open_map!!.query))), done)
        effect.phone_watch != null -> {
            val watch = effect.phone_watch!!
            val watched: ((() -> Unit)?) -> Unit = when {
                phone == null -> { _ -> }
                watch.source == ImportSource.IMPORT_SOURCE_CALENDAR -> phone::watchCalendar
                watch.source == ImportSource.IMPORT_SOURCE_CONTACTS -> phone::watchContacts
                else -> { _ -> }
            }
            when {
                phone == null || (watch.source != ImportSource.IMPORT_SOURCE_CALENDAR && watch.source != ImportSource.IMPORT_SOURCE_CONTACTS) ->
                    failed("this phone store is not watched by this shell")
                watch.on -> {
                    // ANSWERED EACH TIME THE STORE CHANGES, under this one effect id.
                    watched { report(PhoneChanged(source = watch.source)) }
                    null
                }
                else -> {
                    watched(null)
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

/**
 * DOCS' EFFECTS AND `OpenRoute`: the pickers answer under the effect's one id (progress, then
 * the file), so this returns null when the picker will, and a result only for a refusal.
 */
private fun files(
    effect: Effect,
    docs: DocsPickers?,
    openRoute: ((Route) -> Unit)?,
    answer: (EffectResult) -> Unit,
): EffectResult? = when {
    effect.open_route != null -> openRoute?.let { open ->
        open(effect.open_route!!.route!!)
        EffectResult(done = EffectDone())
    } ?: failed("no page to open")
    docs == null -> failed("not performed by this shell")
    effect.pick_file != null -> {
        docs.pick(effect.pick_file!!.kind, answer)
        null
    }
    effect.follow_folder != null -> {
        docs.follow(answer)
        null
    }
    else -> {
        docs.stop(effect.stop_following!!.origin, answer)
        null
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

private fun granted(context: Context, permission: String): Boolean =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

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

/** The platform hands one effect may need, so [perform] keeps one parameter for them. */
private class Doors(
    val files: FileDoors,
    val launchPicker: () -> Unit,
    val launchSaver: (String) -> Unit,
    val announce: (String) -> Unit,
)

/**
 * THE SYSTEM'S FILE SHEETS, ONE OUT AT A TIME (#1135): `PickBytes` reads the
 * chosen document into bytes handed to Rust and kept nowhere here; `SaveFile`
 * writes Rust's bytes to the document the member named and nowhere else. A
 * dismissed sheet is a cancel, by value, never a failure the screen draws.
 */
private class FileDoors {
    private var picking: CompletableDeferred<android.net.Uri?>? = null
    private var saving: CompletableDeferred<android.net.Uri?>? = null

    fun picked(uri: android.net.Uri?) {
        picking?.complete(uri)
        picking = null
    }

    fun saved(uri: android.net.Uri?) {
        saving?.complete(uri)
        saving = null
    }

    suspend fun pick(context: Context, launch: () -> Unit): EffectResult {
        val answer = CompletableDeferred<android.net.Uri?>()
        picking = answer
        launch()
        val uri = answer.await() ?: return EffectResult(bytes_picked = BytesPicked(cancelled = true))
        return withContext(Dispatchers.IO) {
            runCatching {
                val resolver = context.contentResolver
                val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0) else null
                }.orEmpty()
                val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("unreadable")
                EffectResult(
                    bytes_picked = BytesPicked(
                        name = name,
                        media_type = resolver.getType(uri).orEmpty(),
                        content = ByteString.of(*bytes),
                    ),
                )
            }.getOrElse { failed("the file could not be read") }
        }
    }

    suspend fun save(context: Context, file: centraid.core.v1.SaveFile, launch: (String) -> Unit): EffectResult {
        val answer = CompletableDeferred<android.net.Uri?>()
        saving = answer
        launch(file.name)
        val uri = answer.await()
            ?: return EffectResult(failed = EffectFailed(reason = "the save was cancelled", cancelled = true))
        return withContext(Dispatchers.IO) {
            runCatching {
                context.contentResolver.openOutputStream(uri)?.use { it.write(file.content.toByteArray()) } ?: error("unwritable")
                EffectResult(done = EffectDone())
            }.getOrElse { failed("the file could not be written") }
        }
    }
}
