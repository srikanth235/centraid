package dev.centraid.shared.platform

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.os.BatteryManager
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.centraid.shared.sync.BackgroundWindows
import dev.centraid.shared.sync.TransferRule
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * ANDROID'S BACKGROUND WINDOWS (#1080, the shells).
 *
 * **NOT COMPILED IN CI TODAY**: there is no Android SDK on the machines that run
 * `cargo xtask gate`; the owner hand-off in `mobile/README.md` is what proves
 * it. Which windows exist and under which constraints is
 * [BackgroundWindows]' — platform-free, so `BackgroundSchedulingSpec` proves it
 * on the JVM — and this file only maps those onto WorkManager.
 *
 * What a window RUNS is installed, never hard-coded ([SyncPass]): the app's
 * `Application` installs the bodies, so a worker the OS starts with no Activity
 * still has a pass to run, and the sync policy stays where a JVM test reaches it.
 */
public class AndroidBackgroundTasks(
    private val context: Context,
    /** Where the member's rule lives: the constraints are derived from it. */
    private val store: SecureStore,
) : BackgroundTasks {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override suspend fun register(): BackgroundTasks.Registration = try {
        enqueuePeriodic(TransferRule.read(store))
        BackgroundTasks.Registration(
            registered = true,
            sentence = "Centraid catches up in the background.",
        )
    } catch (error: IllegalStateException) {
        // OBSERVABLE, NOT ASSUMED: a member reads that the phone will not wake it.
        BackgroundTasks.Registration(
            registered = false,
            sentence = "Centraid cannot catch up in the background on this device.",
            refusal = error.message ?: "WorkManager refused",
        )
    }

    /** Re-enqueued under the rule the member holds NOW: a changed rule changes the constraints. */
    override fun resubmit() {
        scope.launch { runCatching { enqueuePeriodic(TransferRule.read(store)) } }
    }

    override fun nudge() {
        scope.launch {
            runCatching {
                val window = BackgroundWindows.nudge(TransferRule.read(store))
                val request = OneTimeWorkRequestBuilder<CentraidSyncWorker>()
                    .setConstraints(constraintsOf(window))
                    .apply {
                        // EXPEDITED ONLY WITH A NOTICE TO SHOW: below API 31 an
                        // expedited job runs as a foreground service, and a
                        // worker with no notification fails inside the framework.
                        if (SyncPass.notice != null) setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                    }
                    .build()
                WorkManager.getInstance(context).enqueueUniqueWork(window.name, ExistingWorkPolicy.KEEP, request)
            }
        }
    }

    /**
     * "Back up now" and backlogs: a long-running job that holds a foreground
     * notification while [SyncPass.installBacklog]'s body runs, so the member
     * can leave the app. KEEP, because a second start while one runs is the
     * same backup.
     */
    override fun backlog(start: Boolean) {
        runCatching {
            val manager = WorkManager.getInstance(context)
            if (start) {
                val request = OneTimeWorkRequestBuilder<CentraidBacklogWorker>()
                    .setConstraints(constraintsOf(BackgroundWindows.BACKLOG))
                    .build()
                manager.enqueueUniqueWork(BackgroundWindows.BACKLOG.name, ExistingWorkPolicy.KEEP, request)
            } else {
                manager.cancelUniqueWork(BackgroundWindows.BACKLOG.name)
            }
        }
    }

    private fun enqueuePeriodic(rule: TransferRule) {
        val manager = WorkManager.getInstance(context)
        listOf(BackgroundWindows.periodic(rule), BackgroundWindows.NIGHT_SHIFT).forEach { window ->
            manager.enqueueUniquePeriodicWork(
                window.name,
                // UPDATE, NEVER KEEP: KEEP would preserve whatever a shipped
                // build enqueued under the same name — once an unrunnable
                // abstract `Worker` — and the constraints of a rule the member
                // has since changed. UPDATE replaces it in place.
                ExistingPeriodicWorkPolicy.UPDATE,
                PeriodicWorkRequestBuilder<CentraidSyncWorker>(window.periodMinutes, TimeUnit.MINUTES)
                    .setConstraints(constraintsOf(window))
                    .build(),
            )
        }
    }

    private fun constraintsOf(window: BackgroundWindows.Window): Constraints = Constraints.Builder()
        .setRequiredNetworkType(
            when (window.link) {
                BackgroundWindows.Link.CONNECTED -> NetworkType.CONNECTED
                BackgroundWindows.Link.UNMETERED -> NetworkType.UNMETERED
            },
        )
        .setRequiresCharging(window.requiresCharging)
        .build()
}

/**
 * **THE PASS THE OS RUNS, AND IT IS A CONCRETE CLASS.** WorkManager
 * instantiates a worker reflectively, so `androidx.work.Worker` — the abstract
 * base — would be accepted, reported enqueued, and fail every run.
 * `BackgroundPassLawSpec` keeps it concrete.
 *
 * A pass with nothing installed is `Result.success()`, not a failure: an app
 * that has not finished launching has nothing to catch up on, and a failure
 * would make WorkManager back the schedule off for a reason that is not real.
 */
public class CentraidSyncWorker(
    context: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(context, parameters) {

    override suspend fun doWork(): Result {
        val pass = SyncPass.installed ?: return Result.success()
        return try {
            if (pass()) Result.success() else Result.retry()
        } catch (error: Exception) {
            // RETRY, NOT FAILURE: `Result.failure()` takes the work out of the
            // queue, and a phone that lost its network mid-pass would never
            // back up again until the app was opened.
            Result.retry()
        }
    }

    override suspend fun getForegroundInfo(): ForegroundInfo =
        SyncPass.notice?.invoke(applicationContext, SyncPass.Notice.NUDGE)
            ?: error("SyncPass.installNotice was never called; an expedited pass needs a notification")
}

/** The long run: [SyncPass.installBacklog]'s body under a foreground notification. */
public class CentraidBacklogWorker(
    context: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(context, parameters) {

    override suspend fun doWork(): Result {
        val body = SyncPass.backlog ?: return Result.success()
        SyncPass.notice?.let { notice ->
            // A REFUSED FOREGROUND START IS NOT A REFUSED BACKUP: the run goes on
            // as ordinary work, and only leaving the app can now stop it.
            runCatching { setForeground(notice(applicationContext, SyncPass.Notice.BACKLOG)) }
        }
        return try {
            body()
            Result.success()
        } catch (error: Exception) {
            Result.retry()
        }
    }

    override suspend fun getForegroundInfo(): ForegroundInfo =
        SyncPass.notice?.invoke(applicationContext, SyncPass.Notice.BACKLOG)
            ?: error("SyncPass.installNotice was never called; a backlog needs a notification")
}

/**
 * THE BODIES THE WORKERS RUN, installed by the app's `Application` at
 * `onCreate` so a worker the OS starts before (or without) an Activity has
 * one. Each body reaches the one session through `ShellProcess`, which opens
 * the vaults on first use — `Application.onCreate` itself opens nothing.
 */
public object SyncPass {

    /**
     * WHAT A WORKER MAY SPEND: WorkManager's ~10 minutes before `onStopped`,
     * minus a minute so the part in flight finishes at a boundary. A pass that
     * stops short resumes at the next window; the spool loses nothing.
     */
    public const val WORK_MANAGER_BUDGET_MS: Long = 9L * 60L * 1_000L

    internal var installed: (suspend () -> Boolean)? = null
        private set
    internal var backlog: (suspend () -> Unit)? = null
        private set
    internal var notice: ((Context, Notice) -> ForegroundInfo)? = null
        private set

    /** The periodic and expedited windows' body: true when every spool emptied. */
    public fun install(pass: suspend () -> Boolean) {
        installed = pass
    }

    /** "Back up now": runs until the shelf is backed up or nothing more can move. */
    public fun installBacklog(body: suspend () -> Unit) {
        backlog = body
    }

    /**
     * The notification a foreground run shows. The app's: its channel, its
     * icon and its words live in the app module, and a `dataSync` foreground
     * service needs the manifest's `FOREGROUND_SERVICE_DATA_SYNC` beside it.
     */
    public fun installNotice(notice: (Context, Notice) -> ForegroundInfo) {
        this.notice = notice
    }

    /** Which run is asking for its notification. */
    public enum class Notice { NUDGE, BACKLOG }
}

/**
 * The link and the charger, synchronously (#1080, `DrainRequest`). Null when
 * Android has no active network or no sticky battery broadcast to read: the
 * pass reads null as metered and not charging.
 */
public class AndroidPowerAndLink(private val context: Context) : PowerAndLink {
    override fun metered(): Boolean? {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return null
        if (manager.activeNetwork == null) return null
        return manager.isActiveNetworkMetered
    }

    /** External power, from the sticky `ACTION_BATTERY_CHANGED`: plugged counts, full or not. */
    override fun charging(): Boolean? {
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null
        val plugged = battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)
        return if (plugged < 0) null else plugged != 0
    }
}
