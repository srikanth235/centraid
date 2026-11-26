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
import centraid.core.v1.BackgroundStatus
import centraid.core.v1.CameraRoll
import centraid.core.v1.EffectDone
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectRequest
import centraid.core.v1.EffectResult
import centraid.core.v1.HomeStatus
import centraid.core.v1.KeychainOp
import centraid.core.v1.KeychainValue
import centraid.core.v1.PassNoted
import dev.centraid.android.backup.BackupNow
import dev.centraid.android.backup.PassWork
import dev.centraid.android.kit.ClipboardDeadline
import dev.centraid.android.kit.EffectReason
import dev.centraid.android.kit.SecretStores
import dev.centraid.android.kit.effectAttempt
import dev.centraid.android.notify.Notify
import dev.centraid.core.CentraidCore
import dev.centraid.core.Screens
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
    suspend fun askMedia()
    suspend fun ask(permission: String): Boolean
}

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
