package dev.centraid.android.session

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.provider.Settings
import androidx.core.content.ContextCompat
import centraid.core.v1.BackgroundStatus
import centraid.core.v1.CameraRead
import centraid.core.v1.CameraRoll
import centraid.core.v1.Effect
import centraid.core.v1.EffectDone
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectRequest
import centraid.core.v1.EffectResult
import centraid.core.v1.HomeStatus
import centraid.core.v1.ImportSource
import centraid.core.v1.ImportsCameraRollEvent
import centraid.core.v1.KeychainOp
import centraid.core.v1.KeychainValue
import centraid.core.v1.LibraryPermissionRead
import centraid.core.v1.LinkReading
import centraid.core.v1.PassNoted
import centraid.core.v1.PhoneChanged
import dev.centraid.android.backup.BackupNow
import dev.centraid.android.backup.LinkFacts
import dev.centraid.android.backup.PassWork
import dev.centraid.android.kit.ClipboardDeadline
import dev.centraid.android.kit.SecretStores
import dev.centraid.android.screens.PhotoHandOff
import dev.centraid.android.screens.agenda.readCalendarSnapshot
import dev.centraid.android.screens.docs.FolderReader
import dev.centraid.android.screens.people.readContactsSnapshot
import dev.centraid.android.screens.photos.PhotosEditRender
import dev.centraid.core.CentraidCore
import dev.centraid.core.Screens
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okio.ByteString.Companion.encodeUtf8

/**
 * WHAT THE ACTIVITY ALONE CAN DO: a prompt, a picker, a sheet, a haptic. Set by the composition
 * that hosts the screens (`kit/ScreenEffects.kt`) for as long as it lives; with none up (a window
 * WorkManager granted with the app closed) such an effect is answered `cancelled`.
 */
internal interface UiHost {
    /** Perform an effect only an activity can. Null: it answers itself later, through [answer]. */
    suspend fun perform(request: EffectRequest, answer: (EffectResult) -> Unit): EffectResult?

    /** Show the system's photo prompt and wait until it is answered. */
    suspend fun askMedia()

    /** Ask for one runtime permission; whether it was granted. */
    suspend fun ask(permission: String): Boolean

}

/**
 * THE PLATFORM WORK THE SCREEN RUNTIME ASKS FOR, PERFORMED ONCE (#1135).
 *
 * Every effect of the one runtime comes here: what needs only a context is performed here (the
 * secret stores, the keychain, the pass service's windows and long run, the phone imports' library,
 * folders and link, the stage door, the phone stores' reads and watches, the clipboard, a link
 * opened), and what needs the activity goes to [ui]. Each is answered under its `effect_id`.
 *
 * **IN THE ORDER ASKED, PER SCREEN.** A service tells its effects apart by what they answer (the
 * pass service attributes an answer to its oldest outstanding effect of that kind, the camera roll
 * keeps a cursor write apart from a wait), so one screen's effects are performed one after another
 * in the order it asked for them. Only an effect that answers more than once and for long (a model
 * download) runs beside them.
 */
internal class ShellEffects(
    context: Context,
    private val core: CentraidCore,
    private val screens: Screens,
    private val scope: CoroutineScope,
) {
    private val context: Context = context.applicationContext

    /** The activity's half, while one is up. */
    @Volatile var ui: UiHost? = null

    /** The phone imports' relays; set once by the session. */
    lateinit var imports: ImportsRelay

    val watchers = PhoneWatchers(context)

    private val queues = ConcurrentHashMap<Long, Channel<EffectRequest>>()

    fun start() {
        scope.launch {
            screens.effects.collect { request ->
                if (request.effect?.model_download != null) {
                    scope.launch { run(request) }
                } else {
                    queueOf(request.instance).send(request)
                }
            }
        }
    }

    private fun queueOf(instance: Long): Channel<EffectRequest> = queues.getOrPut(instance) {
        Channel<EffectRequest>(Channel.UNLIMITED).also { queue ->
            scope.launch { for (request in queue) run(request) }
        }
    }

    private suspend fun run(request: EffectRequest) {
        val answer: (EffectResult) -> Unit = { result -> scope.launch { screens.answer(request, result) } }
        val result = try {
            perform(request, answer)
        } catch (error: Exception) {
            failed(error.message ?: "the effect failed")
        }
        if (result != null) screens.answer(request, result)
    }

    /** The answer to [request], or null when it answers itself later through [answer]. */
    private suspend fun perform(request: EffectRequest, answer: (EffectResult) -> Unit): EffectResult? {
        val effect = request.effect ?: return failed("no effect")
        val done = EffectResult(done = EffectDone())
        return when {
            // ---- the vault's secrets (lane H2) -------------------------------------------------
            effect.secrets != null -> EffectResult(secrets = withContext(Dispatchers.IO) { SecretStores.run(context, effect.secrets!!) })
            effect.synced_probe != null -> EffectResult(synced_status = SecretStores.probe(context))
            effect.keychain != null -> withContext(Dispatchers.IO) { keychain(effect.keychain!!) }
            // ---- the pass service (`crates/screens/src/passes`) --------------------------------
            effect.schedule_windows != null ->
                EffectResult(windows_scheduled = PassWork.schedule(context, effect.schedule_windows!!.windows))
            effect.pass_window_done != null -> {
                PassWork.windowDone(effect.pass_window_done!!.window, effect.pass_window_done!!.drained)
                EffectResult(pass_noted = PassNoted())
            }
            effect.long_run != null -> {
                if (effect.long_run!!.start) BackupNow.start(context, effect.long_run!!.title, effect.long_run!!.channel_name) else BackupNow.stop(context)
                EffectResult(pass_noted = PassNoted())
            }
            effect.background_probe != null -> PassWork.registered?.let {
                EffectResult(background_status = BackgroundStatus(registered = it))
            } ?: failed("no window was asked for yet")
            // Android moves a pass's parts inside the pass; only iOS's session carries them suspended.
            effect.uploads != null -> failed("the OS carries no uploads on this platform")
            // ---- the phone imports (`crates/screens/src/imports`) ------------------------------
            effect.camera_roll != null -> cameraRoll(request, effect.camera_roll!!)
            effect.library_permission != null -> {
                if (effect.library_permission!!.ask) ui?.askMedia()
                EffectResult(library_permission_read = LibraryPermissionRead(permission = LibraryRoll.permission(context)))
            }
            effect.roll_page != null -> withContext(Dispatchers.IO) {
                EffectResult(roll_paged = LibraryRoll.page(context, effect.roll_page!!.cursor, effect.roll_page!!.limit))
            }
            effect.link_read != null -> EffectResult(link_reading = linkReading())
            effect.library_stage != null ->
                EffectResult(library_staged = withContext(Dispatchers.IO) { LibraryRoll.stage(context, core, effect.library_stage!!) })
            effect.library_derivatives != null -> {
                withContext(Dispatchers.IO) { LibraryRoll.derivatives(context, core, effect.library_derivatives!!) }
                done
            }
            effect.folders_read != null -> withContext(Dispatchers.IO) {
                EffectResult(folders_listing = FolderReader.list(context, effect.folders_read!!.origins, InstallId.of(context)))
            }
            effect.stage_folder_file != null -> withContext(Dispatchers.IO) {
                val stage = effect.stage_folder_file!!
                EffectResult(folder_file_staged = FolderReader.stage(context, core, stage.origin, stage.path, stage.media_type))
            }
            // Android has no system reminders: a made vault never asks (`Made{reminders: false}`).
            effect.reminders_read != null -> failed("this platform has no reminders")
            // ---- the phone's stores ------------------------------------------------------------
            effect.calendar_read != null -> {
                val read = effect.calendar_read!!
                if (!allowed(Manifest.permission.READ_CALENDAR, read.ask_permission)) {
                    EffectResult(failed = EffectFailed(reason = "calendar access is off", denied = true))
                } else {
                    runCatching {
                        withContext(Dispatchers.IO) { readCalendarSnapshot(context, read.days_back, read.days_on, InstallId.of(context)) }
                    }.fold({ EffectResult(calendar = it) }, { failed("the calendar could not be read") })
                }
            }
            effect.contacts_read != null -> {
                val read = effect.contacts_read!!
                if (!allowed(Manifest.permission.READ_CONTACTS, read.ask_permission)) {
                    EffectResult(failed = EffectFailed(reason = "contacts access is off", denied = true))
                } else {
                    runCatching {
                        withContext(Dispatchers.IO) { readContactsSnapshot(context, InstallId.of(context)) }
                    }.fold({ EffectResult(contacts = it) }, { failed("the address book could not be read") })
                }
            }
            effect.phone_watch != null -> {
                val watch = effect.phone_watch!!
                when {
                    !watchers.watches(watch.source) -> failed("this phone store is not watched by this shell")
                    watch.on -> {
                        // ANSWERED EACH TIME THE STORE CHANGES, under this one effect id.
                        watchers.watch(watch.source) { answer(EffectResult(phone_changed = PhoneChanged(source = watch.source))) }
                        null
                    }
                    else -> {
                        watchers.stop(watch.source)
                        done
                    }
                }
            }
            // ---- photos' device doors ------------------------------------------------------------
            effect.read_camera != null -> {
                val camera = withContext(Dispatchers.IO) { PhotoHandOff.cameraOf(effect.read_camera!!.path) }
                EffectResult(camera_read = CameraRead(camera = camera.orEmpty()))
            }
            effect.render_edit != null -> PhotosEditRender.perform(context.cacheDir, core, effect.render_edit!!)
            // ---- generic platform work -----------------------------------------------------------
            effect.clipboard_set != null -> {
                val set = effect.clipboard_set!!
                val clip = ClipData.newPlainText("", set.text)
                if (set.sensitive && Build.VERSION.SDK_INT >= 33) {
                    clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
                }
                withContext(Dispatchers.Main) { clipboard().setPrimaryClip(clip) }
                // THE DEADLINE OUTLIVES THE PROCESS: kept beside the clip, swept on the next launch.
                ClipboardDeadline.armed(context, set.text, set.clear_after_ms)
                done
            }
            effect.clipboard_clear != null -> {
                withContext(Dispatchers.Main) {
                    // Only what the core put there: never clear something copied since.
                    val held = clipboard().primaryClip?.getItemAt(0)?.text?.toString()
                    if (held == effect.clipboard_clear!!.expected_text) clipboard().setPrimaryClip(ClipData.newPlainText("", ""))
                }
                ClipboardDeadline.spent(context)
                done
            }
            effect.open_url != null -> start(Intent(Intent.ACTION_VIEW, Uri.parse(effect.open_url!!.url)))
            effect.open_map != null ->
                start(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(effect.open_map!!.query))))
            effect.share != null -> {
                val share = effect.share!!
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, listOf(share.text, share.url).filter { it.isNotEmpty() }.joinToString("\n"))
                    if (share.subject.isNotEmpty()) putExtra(Intent.EXTRA_SUBJECT, share.subject)
                }
                start(Intent.createChooser(send, share.subject.ifEmpty { null }))
            }
            // An announce's shell half is nothing on Android: `custody.filing` files the key in Rust.
            effect.announce != null -> done
            // The runtime moves its own selection; nothing is performed on the platform.
            effect.select_tab != null -> done
            effect.vault_command?.open_ != null -> settingsDoor(effect.vault_command!!.open_!!)
            effect.vault_command != null -> failed("the shelf performs this command")
            else -> ui?.perform(request, answer) ?: EffectResult(failed = EffectFailed(reason = "no screen is up", cancelled = true))
        }
    }

    /**
     * THE CAMERA ROLL'S REMEDIES (D-1025-S7-75), which one and its words being Rust's. Photos' ask
     * and import go to the camera-roll service as `Requested`, which reads the grant and prompts
     * itself; the made vault's ask shows the prompt here and then lets the roll walk; settings is
     * this app's own page there.
     */
    private suspend fun cameraRoll(request: EffectRequest, roll: CameraRoll): EffectResult {
        val requested = { action: ImportsCameraRollEvent.Requested.Action ->
            imports.roll(ImportsCameraRollEvent(requested = ImportsCameraRollEvent.Requested(action = action)))
        }
        when (roll.action) {
            CameraRoll.Action.ACTION_ASK_PERMISSION, CameraRoll.Action.ACTION_MANAGE_SELECTION ->
                if (imports.isMade(request.instance)) {
                    ui?.askMedia()
                    imports.roll(ImportsCameraRollEvent(walk = ImportsCameraRollEvent.Walk()))
                } else {
                    requested(ImportsCameraRollEvent.Requested.Action.ACTION_ASK_PERMISSION)
                }
            CameraRoll.Action.ACTION_IMPORT_NOW -> requested(ImportsCameraRollEvent.Requested.Action.ACTION_IMPORT_NOW)
            CameraRoll.Action.ACTION_OPEN_SETTINGS -> return start(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
            )
            CameraRoll.Action.ACTION_UNSPECIFIED -> return failed("no camera roll action")
        }
        return EffectResult(done = EffectDone())
    }

    /** The link as the platform gives it now, and the member's rule as the device store holds it. */
    private fun linkReading(): LinkReading {
        val link = LinkFacts.read(context)
        val rule = when (SecretStores.read(context, RULE_KEY)) {
            "wifi-and-cellular-photos" -> LinkReading.Rule.RULE_WIFI_AND_CELLULAR_PHOTOS
            "manual" -> LinkReading.Rule.RULE_MANUAL
            "wifi-only" -> LinkReading.Rule.RULE_WIFI_ONLY
            else -> LinkReading.Rule.RULE_UNSPECIFIED
        }
        return LinkReading(online = link.online, metered = link.metered, platform_refused = !link.metered_known, rule = rule)
    }

    /** THE KEYCHAIN IS THE DEVICE STORE. A value is UTF-8 text; an empty set, like a delete, removes it. */
    private fun keychain(op: KeychainOp): EffectResult = when (op.op) {
        KeychainOp.Op.OP_GET -> {
            val value = SecretStores.read(context, op.key)
            EffectResult(keychain = KeychainValue(found = value != null, value_ = (value ?: "").encodeUtf8()))
        }
        KeychainOp.Op.OP_SET -> {
            SecretStores.write(context, op.key, op.value_.utf8())
            EffectResult(done = EffectDone())
        }
        KeychainOp.Op.OP_DELETE -> {
            SecretStores.write(context, op.key, "")
            EffectResult(done = EffectDone())
        }
        else -> failed("unknown keychain operation")
    }

    /** Granted now, or asked at the member's own tap when [ask] and an activity is up. */
    private suspend fun allowed(permission: String, ask: Boolean): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED ||
            (ask && ui?.ask(permission) == true)

    /** The ribbon's doors into the system's settings (the backup's is a tab Rust selects itself). */
    private fun settingsDoor(door: HomeStatus.Destination): EffectResult = when (door) {
        HomeStatus.Destination.DESTINATION_NOTIFICATIONS -> start(
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
        )
        HomeStatus.Destination.DESTINATION_PHONE -> start(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
        )
        else -> EffectResult(done = EffectDone())
    }

    private fun start(intent: Intent): EffectResult = try {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        EffectResult(done = EffectDone())
    } catch (_: ActivityNotFoundException) {
        failed("no app on this phone answers")
    }

    private fun clipboard(): ClipboardManager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    private fun failed(reason: String) = EffectResult(failed = EffectFailed(reason = reason))

    private companion object {
        /** The member's transfer rule in the device store (`passes::rule::KEY`). */
        const val RULE_KEY = "transfer-rule"
    }
}
