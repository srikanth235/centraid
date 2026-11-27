package dev.centraid.android.session

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.provider.Settings
import androidx.core.content.FileProvider
import centraid.core.v1.BackgroundStatus
import centraid.core.v1.CameraRoll
import centraid.core.v1.EffectDone
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectRequest
import centraid.core.v1.EffectResult
import centraid.core.v1.DeviceDelete
import centraid.core.v1.DeviceGet
import centraid.core.v1.DevicePut
import centraid.core.v1.DeviceRequest
import centraid.core.v1.Envelope
import centraid.core.v1.HomeStatus
import centraid.core.v1.KeychainOp
import centraid.core.v1.KeychainValue
import centraid.core.v1.PassNoted
import centraid.core.v1.ShellEffect
import centraid.core.v1.ShellEffectResult
import centraid.core.v1.Request
import centraid.core.v1.ShellDone
import centraid.core.v1.ShellFailed
import centraid.core.v1.ShellGrant
import centraid.core.v1.FollowGrant
import centraid.core.v1.FollowRequest
import centraid.core.v1.FollowVerb
import dev.centraid.android.backup.BackupNow
import dev.centraid.android.backup.PassWork
import dev.centraid.android.kit.ClipboardDeadline
import dev.centraid.android.kit.EffectReason
import dev.centraid.android.kit.SecretStores
import dev.centraid.android.kit.ModelFileTransfer
import dev.centraid.android.kit.effectAttempt
import dev.centraid.android.notify.Notify
import dev.centraid.core.CentraidCore
import dev.centraid.core.Screens
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okio.ByteString.Companion.encodeUtf8

internal interface UiHost {
    suspend fun perform(request: EffectRequest, answer: (EffectResult) -> Unit): EffectResult?
    suspend fun performShell(effect: ShellEffect): ShellEffectResult
    suspend fun followCameraRoll(askPermission: Boolean): FollowGrant
    suspend fun pickFollowFolder(): FollowFolderPick
    suspend fun askHealthPermissions(permissions: Set<String>): Set<String>
    suspend fun askStorePermission(system: String, askPermission: Boolean): Boolean
    suspend fun askMedia()
    suspend fun ask(permission: String): Boolean
}

internal data class FollowFolderPick(val grant: FollowGrant, val uri: String = "")

internal suspend fun performUiEffect(
    host: UiHost?,
    request: EffectRequest,
    answer: (EffectResult) -> Unit,
): EffectResult? {
    if (host == null) return EffectResult(failed = EffectFailed(reason = EffectReason.NO_WINDOW, cancelled = true))
    return host.perform(request, answer)
}

internal class ShellEffects(
    context: Context,
    private val core: CentraidCore,
    private val screens: Screens,
    private val scope: CoroutineScope,
) {
    private val context: Context = context.applicationContext

    @Volatile var ui: UiHost? = null
    private val watches = ConcurrentHashMap<String, List<android.database.ContentObserver>>()
    private val pendingWatchTriggers = ConcurrentHashMap.newKeySet<String>()
    private val roomShellEffectPerformer = RoomShellEffectPerformer(::performShellVariant)

    private val browsing = GatewayBrowsing(this.context, scope)
    private val queues = EffectRequestQueues(scope) { request -> run(request) }

    fun start() {
        scope.launch {
            screens.views.collect { browsing.retain(screens.views.value.keys) }
        }
        scope.launch {
            screens.effects.collect { request ->
                queues.submit(request)
            }
        }
    }

    suspend fun performShell(effect: ShellEffect): ShellEffectResult = roomShellEffectPerformer.perform(effect)

    suspend fun performFollow(effect: ShellEffect): FollowRequest {
        val read = requireNotNull(effect.store_read)
        var healthGranted: Set<String>? = null
        var healthRefused = emptyList<String>()
        var healthBackgroundRefused = false
        var folderRefs = read.folder_refs
        val pickedFolder = if (read.system == "files" && read.ask_permission) ui?.pickFollowFolder()
            ?: FollowFolderPick(FollowGrant.FOLLOW_GRANT_UNAVAILABLE) else null
        val grant = when (read.system) {
            "camera_roll" -> ui?.followCameraRoll(read.ask_permission) ?: FollowGrant.FOLLOW_GRANT_UNAVAILABLE
            "contacts" -> {
                val allowed = ui?.askStorePermission("contacts", read.ask_permission) ?: false
                if (!allowed) FollowGrant.FOLLOW_GRANT_REFUSED else FollowGrant.FOLLOW_GRANT_GRANTED
            }
            "calendar" -> {
                val allowed = ui?.askStorePermission("calendar", read.ask_permission) ?: false
                if (!allowed) FollowGrant.FOLLOW_GRANT_REFUSED else FollowGrant.FOLLOW_GRANT_GRANTED
            }
            "files" -> when {
                read.ask_permission && pickedFolder?.grant != FollowGrant.FOLLOW_GRANT_GRANTED ->
                    pickedFolder?.grant ?: FollowGrant.FOLLOW_GRANT_UNAVAILABLE
                read.ask_permission -> {
                    val pickedUri = pickedFolder!!.uri.takeIf(String::isNotBlank)?.let(Uri::parse)
                    val ref = pickedUri?.let { FollowFolderGrants.create(context, core, it) }
                    if (ref == null) FollowGrant.FOLLOW_GRANT_UNAVAILABLE else {
                        folderRefs = listOf(ref)
                        FollowGrant.FOLLOW_GRANT_GRANTED
                    }
                }
                else -> FollowGrant.FOLLOW_GRANT_GRANTED
            }
            "health" -> {
                if (!HealthFollowReader.available(context)) {
                    FollowGrant.FOLLOW_GRANT_UNAVAILABLE
                } else {
                    val requested = HealthFollowReader.permissions(read)
                    healthGranted = if (read.ask_permission) {
                        ui?.askHealthPermissions(requested)
                    } else {
                        HealthFollowReader.granted(context)
                    }
                    val permissionsGranted = healthGranted
                    if (permissionsGranted != null) {
                        healthRefused = HealthFollowReader.refusedTypes(read, permissionsGranted)
                        healthBackgroundRefused = HealthFollowReader.backgroundRefused(read, permissionsGranted)
                    }
                    when {
                        permissionsGranted == null -> FollowGrant.FOLLOW_GRANT_UNAVAILABLE
                        permissionsGranted.intersect(requested).none {
                            it != androidx.health.connect.client.permission.HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
                        } ->
                            FollowGrant.FOLLOW_GRANT_REFUSED
                        permissionsGranted.containsAll(requested) -> FollowGrant.FOLLOW_GRANT_GRANTED
                        else -> FollowGrant.FOLLOW_GRANT_LIMITED
                    }
                }
            }
            "reminders" -> FollowGrant.FOLLOW_GRANT_UNAVAILABLE
            else -> FollowGrant.FOLLOW_GRANT_UNAVAILABLE
        }
        var answerGrant = grant
        val snapshot = try {
            when {
                !grantAllowsSnapshot(read.system, grant) -> ""
                read.system == "contacts" -> withContext(Dispatchers.IO) { FollowReaders.contacts(context) }
                read.system == "calendar" -> withContext(Dispatchers.IO) {
                    FollowReaders.calendar(context, read, java.time.ZoneId.systemDefault())
                }
                read.system == "files" -> withContext(Dispatchers.IO) { FollowReaders.files(context, core, folderRefs) }
                read.system == "camera_roll" -> withContext(Dispatchers.IO) {
                    CameraRollFollowReader.read(context, core, read.cursor)
                }
                read.system == "health" -> withContext(Dispatchers.IO) {
                    HealthFollowReader.read(context, read, requireNotNull(healthGranted)).also { answerGrant = it.grant }.inputJson
                }
                else -> ""
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // A provider failure is not an empty snapshot. Tell core this pass
            // could not be read so it cannot retire rows based on missing data.
            answerGrant = FollowGrant.FOLLOW_GRANT_UNAVAILABLE
            ""
        }
        return dev.centraid.core.ShellEffectAnswers.coreAnswer(
            effect,
            FollowRequest(
                verb = FollowVerb.FOLLOW_VERB_PASS,
                system = read.system,
                ask_id = effect.effect_id,
                grant = answerGrant,
                input_json = snapshot,
                refused = healthRefused,
                background_refused = healthBackgroundRefused,
            ),
        )
    }

    private suspend fun performShellVariant(effect: ShellEffect): ShellEffectResult {
        val outcome = when {
            effect.open_settings != null -> {
                val system = effect.open_settings!!.system
                val intent = if (system == "notifications") {
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                } else {
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                }
                asShell(start(intent))
            }
            effect.clipboard_copy != null -> copyToClipboard(effect.clipboard_copy!!)
            effect.permission_status != null -> permissionStatus(effect.permission_status!!.kind)
            effect.phone_watch != null -> phoneWatch(
                effect.phone_watch!!.system,
                effect.phone_watch!!.on,
                effect.phone_watch!!.folder_refs,
            )
            effect.release_grant != null -> releaseGrant(effect.release_grant!!.ref)
            effect.share != null -> share(effect.share!!)
            effect.model_download != null -> {
                val transfer = effect.model_download!!.transfer
                if (transfer == null) {
                    ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNAVAILABLE))
                } else if (ModelFileTransfer.download(context, transfer)) {
                    ShellEffectResult(done = ShellDone())
                } else {
                    ShellEffectResult(failed = ShellFailed(reason = EffectReason.FAILED))
                }
            }
            else -> ui?.performShell(effect) ?: ShellEffectResult(failed = ShellFailed(reason = EffectReason.NO_WINDOW))
        }
        return outcome.copy(effect_id = effect.effect_id)
    }

    private fun asShell(result: EffectResult) = when {
        result.done != null -> ShellEffectResult(done = ShellDone())
        else -> ShellEffectResult(failed = ShellFailed(reason = result.failed?.reason ?: EffectReason.FAILED))
    }

    private suspend fun copyToClipboard(copy: centraid.core.v1.ShellClipboardCopy): ShellEffectResult {
        if (copy.clear_owned) {
            withContext(Dispatchers.Main) { ClipboardDeadline.clearOwned(context, copy.owner_vault_id) }
            return ShellEffectResult(done = ShellDone())
        }
        val manager = clipboard()
        val leaseId = ClipboardDeadline.newLeaseId(copy.owner_vault_id, copy.lease_s * 1000L)
        val clip = ClipData.newPlainText("", copy.text)
        ClipboardDeadline.markOwnedClip(clip, leaseId)
        if (copy.sealed_ && Build.VERSION.SDK_INT >= 33) {
            clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        }
        val issuedAt = try {
            withContext(Dispatchers.Main) {
                val now = System.currentTimeMillis()
                manager.setPrimaryClip(clip)
                now
            }
        } catch (cancelled: CancellationException) {
            if (leaseId.isNotBlank()) withContext(NonCancellable + Dispatchers.Main) {
                ClipboardDeadline.clearClipIfLeaseMatches(context, leaseId)
            }
            throw cancelled
        } catch (_: Exception) {
            return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNWRITABLE))
        }
        val persisted = try {
            withContext(Dispatchers.IO) {
                ClipboardDeadline.persist(
                    context,
                    copy.text,
                    copy.lease_s * 1000L,
                    copy.owner_vault_id,
                    leaseId,
                    issuedAt,
                )
            }
        } catch (cancelled: CancellationException) {
            if (leaseId.isNotBlank()) withContext(NonCancellable + Dispatchers.Main) {
                ClipboardDeadline.clearClipIfLeaseMatches(context, leaseId)
            }
            throw cancelled
        } catch (_: Exception) {
            false
        }
        if (!persisted) {
            if (leaseId.isNotBlank()) withContext(Dispatchers.Main) {
                ClipboardDeadline.clearClipIfLeaseMatches(context, leaseId)
            }
            return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNWRITABLE))
        }
        val activated = withContext(Dispatchers.Main) {
            if (leaseId.isBlank()) {
                ClipboardDeadline.activate(context)
                true
            } else {
                ClipboardDeadline.activate(context, copy.owner_vault_id, leaseId)
            }
        }
        if (!activated) {
            withContext(Dispatchers.Main) { ClipboardDeadline.clearClipIfLeaseMatches(context, leaseId) }
            return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNWRITABLE))
        }
        return ShellEffectResult(done = ShellDone())
    }

    private fun permissionStatus(kind: String): ShellEffectResult {
        val permission = when (kind) {
            "contacts" -> Manifest.permission.READ_CONTACTS
            "calendar" -> Manifest.permission.READ_CALENDAR
            "camera" -> Manifest.permission.CAMERA
            "photos", "camera_roll" -> if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
            "notifications" -> if (Build.VERSION.SDK_INT >= 33) Manifest.permission.POST_NOTIFICATIONS else null
            else -> null
        }
        val grant = when {
            kind == "reminders" || permission == null -> FollowGrant.FOLLOW_GRANT_UNAVAILABLE
            context.checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED -> FollowGrant.FOLLOW_GRANT_GRANTED
            (kind == "photos" || kind == "camera_roll") && Build.VERSION.SDK_INT >= 34 &&
                context.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == android.content.pm.PackageManager.PERMISSION_GRANTED ->
                FollowGrant.FOLLOW_GRANT_LIMITED
            else -> FollowGrant.FOLLOW_GRANT_REFUSED
        }
        return ShellEffectResult(grant = ShellGrant(grant = grant))
    }

    private suspend fun phoneWatch(system: String, on: Boolean, folderRefs: List<String>): ShellEffectResult {
        watches.remove(system).orEmpty().forEach(context.contentResolver::unregisterContentObserver)
        if (on) {
            val uris = when (system) {
                "contacts" -> listOf(android.provider.ContactsContract.Contacts.CONTENT_URI)
                "calendar" -> listOf(android.provider.CalendarContract.Events.CONTENT_URI)
                "camera_roll" -> listOf(
                    android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                )
                "files" -> folderRefs.map { ref ->
                    FollowFolderGrants.resolve(core, ref)
                        ?: return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNAVAILABLE))
                }
                // Health Connect 1.1 has no shell notification registration API; the core still
                // requests a fresh read whenever the app comes forward.
                else -> return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNAVAILABLE))
            }
            if (uris.isEmpty()) return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNAVAILABLE))
            val observers = uris.map { uri ->
                object : android.database.ContentObserver(null) {
                    override fun onChange(selfChange: Boolean) {
                        if (!pendingWatchTriggers.add(system)) return
                        scope.launch {
                            try {
                                core.call(
                                    centraid.core.v1.Envelope(
                                        request_id = 0,
                                        request = centraid.core.v1.Request(
                                            follow = centraid.core.v1.FollowRequest(
                                                verb = centraid.core.v1.FollowVerb.FOLLOW_VERB_TRIGGER,
                                                system = system,
                                            ),
                                        ),
                                    ),
                                )
                            } finally {
                                pendingWatchTriggers.remove(system)
                            }
                        }
                    }
                }
            }
            uris.zip(observers).forEach { (uri, observer) ->
                context.contentResolver.registerContentObserver(uri, true, observer)
            }
            watches[system] = observers
        }
        return ShellEffectResult(done = ShellDone())
    }

    private suspend fun releaseGrant(ref: String): ShellEffectResult = try {
        if (!FollowFolderGrants.release(context, core, ref)) return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNAVAILABLE))
        ShellEffectResult(done = ShellDone())
    } catch (_: Exception) {
        ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNAVAILABLE))
    }

    private suspend fun share(share: centraid.core.v1.ShellShare): ShellEffectResult {
        val text = share.items.map { it.text }.filter(String::isNotEmpty).joinToString("\n\n")
        val staged = try {
            withContext(Dispatchers.IO) {
                share.items.filter { it.path.isNotEmpty() }.map { item ->
                    val source = File(item.path)
                    if (!source.isFile) error("missing share file")
                    val directory = File(context.cacheDir, "shared-copies").apply { mkdirs() }
                    val name = File(item.name.ifBlank { source.name }).name
                    val target = File(directory, "${java.util.UUID.randomUUID()}-$name")
                    source.inputStream().use { input -> target.outputStream().use { output -> input.copyTo(output, 64 * 1024) } }
                    target
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNREADABLE))
        }
        if (text.isEmpty() && staged.isEmpty()) return ShellEffectResult(failed = ShellFailed(reason = EffectReason.UNAVAILABLE))
        val uris = ArrayList(staged.map { file ->
            FileProvider.getUriForFile(context, context.packageName + ".photocopies", file)
        })
        val types = share.items.filter { it.path.isNotEmpty() }.map { it.media_type }.distinct()
        val send = if (staged.size > 1) Intent(Intent.ACTION_SEND_MULTIPLE) else Intent(Intent.ACTION_SEND)
        send.type = when {
            staged.isEmpty() -> "text/plain"
            types.size == 1 -> types.single().ifEmpty { "*/*" }
            else -> "*/*"
        }
        if (text.isNotEmpty()) send.putExtra(Intent.EXTRA_TEXT, text)
        if (staged.isNotEmpty()) {
            if (staged.size == 1) send.putExtra(Intent.EXTRA_STREAM, uris.single())
            else send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        if (share.subject.isNotEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, share.subject)
        return asShell(start(Intent.createChooser(send, share.subject.ifEmpty { null })))
    }

    private suspend fun run(request: EffectRequest) {
        val answer: (EffectResult) -> Unit = { result -> scope.launch { screens.answer(request, result) } }
        val result = try {
            effectAttempt { perform(request, answer) }
                .getOrElse { failed(EffectReason.FAILED) }
        } catch (cancelled: CancellationException) {
            currentCoroutineContext().ensureActive()
            EffectResult(failed = EffectFailed(reason = EffectReason.CANCELLED, cancelled = true))
        }
        if (result != null) screens.answer(request, result)
    }

    private suspend fun perform(request: EffectRequest, answer: (EffectResult) -> Unit): EffectResult? {
        val effect = request.effect ?: return failed(EffectReason.UNSUPPORTED)
        val done = EffectResult(done = EffectDone())
        return when {
            effect.secrets != null -> EffectResult(secrets = withContext(Dispatchers.IO) { SecretStores.run(context, effect.secrets!!) })
            effect.synced_probe != null -> EffectResult(synced_status = SecretStores.probe(context))
            effect.keychain != null -> withContext(Dispatchers.IO) { keychain(effect.keychain!!) }
            effect.schedule_windows != null ->
                EffectResult(windows_scheduled = PassWork.schedule(context, effect.schedule_windows!!.windows))
            effect.pass_window_done != null -> {
                PassWork.windowDone(effect.pass_window_done!!.window, effect.pass_window_done!!.drained)
                EffectResult(pass_noted = PassNoted())
            }
            effect.schedule_notifications != null -> EffectResult(
                notifications_scheduled = withContext(Dispatchers.IO) {
                    Notify.schedule(context, effect.schedule_notifications!!) { ui?.ask(Manifest.permission.POST_NOTIFICATIONS) }
                },
            )
            effect.open_notification_settings != null -> start(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
            )
            effect.long_run != null -> {
                if (effect.long_run!!.start) BackupNow.start(context, effect.long_run!!.title, effect.long_run!!.channel_name) else BackupNow.stop(context)
                EffectResult(pass_noted = PassNoted())
            }
            effect.background_probe != null -> PassWork.registered?.let {
                EffectResult(background_status = BackgroundStatus(registered = it))
            } ?: failed(EffectReason.NO_WINDOW)
            effect.uploads != null -> failed(EffectReason.UNAVAILABLE)
            effect.camera_roll != null -> cameraRoll(effect.camera_roll!!)
            effect.roll_page != null -> {
                withContext(Dispatchers.IO) { LibraryRoll.page(context, effect.roll_page!!) }
                done
            }
            effect.library_stage != null -> {
                withContext(Dispatchers.IO) { LibraryRoll.stage(context, core, effect.library_stage!!) }
                done
            }
            effect.library_derivatives != null -> {
                withContext(Dispatchers.IO) { LibraryRoll.derivatives(context, core, effect.library_derivatives!!) }
                done
            }
            effect.browse_gateways != null ->
                if (request.instance !in screens.views.value) {
                    done
                } else {
                    browsing.perform(request.instance, effect.browse_gateways!!, answer)
                }
            effect.clipboard_set != null -> {
                val set = effect.clipboard_set!!
                val clip = ClipData.newPlainText("", set.text)
                val leaseId = ClipboardDeadline.newLeaseId(set.owner_vault_id, set.clear_after_ms)
                if (set.sensitive && Build.VERSION.SDK_INT >= 33) {
                    clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
                }
                ClipboardDeadline.markOwnedClip(clip, leaseId)
                val issuedAtMs = try {
                    withContext(Dispatchers.Main) {
                        val issuedAt = System.currentTimeMillis()
                        clipboard().setPrimaryClip(clip)
                        issuedAt
                    }
                } catch (cancelled: CancellationException) {
                    if (leaseId.isNotBlank()) {
                        withContext(NonCancellable + Dispatchers.Main) {
                            ClipboardDeadline.clearClipIfLeaseMatches(context, leaseId)
                            ClipboardDeadline.activate(context)
                        }
                    }
                    throw cancelled
                } catch (_: Exception) {
                    withContext(Dispatchers.Main) { ClipboardDeadline.clearClipIfLeaseMatches(context, leaseId) }
                    return failed(EffectReason.UNWRITABLE)
                }

                val persisted = try {
                    withContext(Dispatchers.IO) {
                        ClipboardDeadline.persist(
                            context,
                            set.text,
                            set.clear_after_ms,
                            set.owner_vault_id,
                            leaseId,
                            issuedAtMs,
                        )
                    }
                } catch (cancelled: CancellationException) {
                    if (leaseId.isNotBlank()) {
                        withContext(NonCancellable + Dispatchers.Main) {
                            ClipboardDeadline.clearClipIfLeaseMatches(context, leaseId)
                            ClipboardDeadline.activate(context)
                        }
                    }
                    throw cancelled
                } catch (_: Exception) {
                    if (leaseId.isNotBlank()) {
                        withContext(Dispatchers.Main) {
                            runCatching { ClipboardDeadline.clearClipIfLeaseMatches(context, leaseId) }
                            ClipboardDeadline.activate(context)
                        }
                    }
                    return failed(EffectReason.UNWRITABLE)
                }
                if (!persisted && leaseId.isNotBlank()) {
                    withContext(Dispatchers.Main) {
                        ClipboardDeadline.clearClipIfLeaseMatches(context, leaseId)
                        ClipboardDeadline.activate(context)
                    }
                    return failed(EffectReason.UNWRITABLE)
                }
                val activated = withContext(Dispatchers.Main) {
                    if (leaseId.isBlank()) {
                        ClipboardDeadline.activate(context)
                        true
                    } else {
                        ClipboardDeadline.activate(context, set.owner_vault_id, leaseId)
                    }
                }
                if (!activated) {
                    withContext(Dispatchers.Main) { ClipboardDeadline.clearClipIfLeaseMatches(context, leaseId) }
                    return failed(EffectReason.UNWRITABLE)
                }
                done
            }
            effect.clipboard_clear != null -> {
                withContext(Dispatchers.Main) {
                    ClipboardDeadline.clearIfMatches(context, effect.clipboard_clear!!.expected_text)
                }
                done
            }
            effect.clipboard_clear_owned != null -> {
                withContext(Dispatchers.Main) {
                    ClipboardDeadline.clearOwned(context, effect.clipboard_clear_owned!!.vault_id)
                }
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
            effect.announce != null -> done
            effect.select_tab != null -> done
            effect.vault_command?.open_ != null -> settingsDoor(effect.vault_command!!.open_!!)
            effect.vault_command != null -> failed(EffectReason.UNSUPPORTED)
            else -> performUiEffect(ui, request, answer)
        }
    }

    private suspend fun cameraRoll(roll: CameraRoll): EffectResult = when (roll.action) {
        CameraRoll.Action.ACTION_OPEN_SETTINGS -> start(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
        )
        CameraRoll.Action.ACTION_MANAGE_SELECTION -> {
            ui?.askMedia()
            EffectResult(done = EffectDone())
        }
        else -> failed(EffectReason.UNSUPPORTED)
    }

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
        else -> failed(EffectReason.UNSUPPORTED)
    }

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
        failed(EffectReason.UNAVAILABLE)
    }

    private fun clipboard(): ClipboardManager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    private fun failed(reason: String) = EffectResult(failed = EffectFailed(reason = reason))
}

internal fun grantAllowsSnapshot(system: String, grant: FollowGrant): Boolean =
    grant == FollowGrant.FOLLOW_GRANT_GRANTED ||
        ((system == "health" || system == "camera_roll") && grant == FollowGrant.FOLLOW_GRANT_LIMITED)

internal class EffectRequestQueues(
    private val scope: CoroutineScope,
    private val perform: suspend (EffectRequest) -> Unit,
) {
    private val perInstance = ConcurrentHashMap<Long, Channel<EffectRequest>>()
    private val clipboard = Channel<EffectRequest>(Channel.UNLIMITED)

    init {
        scope.launch { for (request in clipboard) perform(request) }
    }

    suspend fun submit(request: EffectRequest) {
        val effect = request.effect
        if (effect?.model_download != null || effect?.owner_check?.cancel == true) {
            scope.launch { perform(request) }
        } else if (
            effect?.clipboard_set != null ||
            effect?.clipboard_clear != null ||
            effect?.clipboard_clear_owned != null
        ) {
            clipboard.send(request)
        } else {
            queueOf(request.instance).send(request)
        }
    }

    private fun queueOf(instance: Long): Channel<EffectRequest> = perInstance.getOrPut(instance) {
        Channel<EffectRequest>(Channel.UNLIMITED).also { queue ->
            scope.launch { for (request in queue) perform(request) }
        }
    }
}
