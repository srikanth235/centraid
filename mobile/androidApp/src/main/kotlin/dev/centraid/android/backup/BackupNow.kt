package dev.centraid.android.backup

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import dev.centraid.android.MainActivity
import dev.centraid.shared.sync.BackupClaim
import dev.centraid.shared.sync.DrainCopy
import dev.centraid.shared.sync.DrainPass
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * "BACK UP NOW", AND A BACKLOG, WITH THE PROCESS KEPT ALIVE (#1080, the shells).
 *
 * WorkManager gives a periodic worker about ten minutes and then stops caring;
 * the first backup of a camera roll, or a night's worth of video, does not fit
 * in that. Android's answer for a transfer the member asked for is a job they
 * can see:
 *
 * | API | What runs the pass | What the member sees |
 * |---|---|---|
 * | 34 and up | a user-initiated data transfer job (`setUserInitiated`, `RUN_USER_INITIATED_JOBS`) | the job's notification |
 * | below 34 | a `dataSync` foreground service | its ongoing notification |
 *
 * Both run the same body, [run]: the core's pass, in this process, under the
 * member's rule — the core decides per item what crosses which link, so the
 * job's own constraint is only "a network exists" — and both stop at
 * [BUDGET_MS]. What the pass does not finish, the periodic worker and the next
 * open carry on with: the spool never loses a sealed part.
 *
 * **Started and stopped by the member's run, from a visible app.**
 * `HomeSession.backUpNow` calls [start] as the run begins and [stop] however
 * it ends (seam contract A11's `SyncPass.installBacklog`, installed by
 * `CentraidApplication`); the Backup sheet only sends the event, once the
 * notification grant is answered. A user-initiated job may only be scheduled
 * while the app is visible and a foreground service may not be started from
 * the background on Android 12 and up; a refusal answers `false` and the
 * periodic worker remains the backstop. Starting twice is a no-op.
 */
public object BackupNow {
    /**
     * Thirty minutes per run. Long enough for a first backup to make real
     * progress with the member watching; short enough that a job nobody is
     * watching does not hold a radio for an evening.
     */
    public const val BUDGET_MS: Long = 30L * 60L * 1_000L

    /**
     * When another pass in this process already holds a vault's lock
     * ([DrainPass.Outcome.Busy] — the member's own run, which started this
     * job, typically), the job waits this long and asks again rather than
     * ending: the job is what keeps the process alive for that run to finish,
     * and [stop] ends it when the run does.
     */
    internal const val BUSY_RETRY_MS: Long = 5_000L

    /**
     * One id for the job and its notification: there is one "Back up now".
     *
     * NO CLASH WITH WORKMANAGER'S JOBS, though lint's
     * `SpecifyJobSchedulerIdRange` warns of one: from API 34, the only place
     * this job is scheduled, WorkManager (2.10 and up) schedules in its own
     * `JobScheduler` namespace (`androidx.work.systemjobscheduler`), so its
     * ids never meet this one.
     */
    internal const val JOB_ID: Int = 1080
    internal const val NOTIFICATION_ID: Int = 1080

    /** Start it. `false` when the platform refused; see the class comment. */
    public fun start(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startJob(context.applicationContext)
        } else {
            startService(context.applicationContext)
        }

    /** Stop it, wherever it is. A pass in flight stops at its next part. */
    public fun stop(context: Context) {
        val app = context.applicationContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            app.getSystemService(JobScheduler::class.java)?.cancel(JOB_ID)
        } else {
            app.stopService(Intent(app, BackupForegroundService::class.java))
        }
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun startJob(context: Context): Boolean {
        val scheduler = context.getSystemService(JobScheduler::class.java) ?: return false
        // IDEMPOTENT. Scheduling an id that is running STOPS the running job
        // and starts it again, which would cut a pass mid-part for a second tap.
        if (scheduler.getPendingJob(JOB_ID) != null) return true
        val job = JobInfo.Builder(JOB_ID, ComponentName(context, BackupJobService::class.java))
            .setUserInitiated(true)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            // NETWORK_BYTES_UNKNOWN is an Int constant, and Kotlin does not widen it.
            .setEstimatedNetworkBytes(JobInfo.NETWORK_BYTES_UNKNOWN.toLong(), JobInfo.NETWORK_BYTES_UNKNOWN.toLong())
            .build()
        return try {
            scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS
        } catch (refused: IllegalArgumentException) {
            false
        } catch (refused: IllegalStateException) {
            false
        } catch (refused: SecurityException) {
            false
        }
    }

    private fun startService(context: Context): Boolean = try {
        ContextCompat.startForegroundService(context, Intent(context, BackupForegroundService::class.java))
        true
    } catch (refused: IllegalStateException) {
        // `ForegroundServiceStartNotAllowedException` is one: started from the
        // background on Android 12 and up.
        false
    }

    /**
     * THE BODY BOTH RUN: passes over every held vault until the spool is empty
     * or [BUDGET_MS] is spent, holding the process's one session throughout.
     */
    internal suspend fun run(context: Context): Boolean {
        val until = System.currentTimeMillis() + BUDGET_MS
        return ProcessSession.use(context) { session ->
            var drained = false
            while (true) {
                val left = until - System.currentTimeMillis()
                if (left <= 0L) break
                val outcomes = session.drain.run(left)
                drained = ProcessSession.drained(outcomes)
                val busy = outcomes.any { it.outcome is DrainPass.Outcome.Busy }
                if (!busy) break
                delay(BUSY_RETRY_MS)
            }
            drained
        }
    }
}

/**
 * The user-initiated data transfer job (API 34 and up). See [BackupNow].
 *
 * NOT `@RequiresApi` ON THE CLASS: the manifest declares it for every API the
 * app installs on, and lint refuses a component the manifest names below its
 * floor (`NewApi`). Only [BackupNow.startJob] schedules it, from 34 up, so
 * the guards below never refuse a job the system really started.
 */
public class BackupJobService : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var running: Job? = null

    override fun onStartJob(params: JobParameters): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false
        // THE NOTIFICATION IS OWED AT ONCE: a user-initiated job that has not
        // posted one within seconds of starting is stopped by the system.
        setNotification(
            params,
            BackupNow.NOTIFICATION_ID,
            BackupNotices.progress(this),
            JobService.JOB_END_NOTIFICATION_POLICY_REMOVE,
        )
        running = scope.launch {
            runCatching { BackupNow.run(applicationContext) }
            jobFinished(params, false)
        }
        return true
    }

    /**
     * THE SYSTEM STOPPED IT — the network went, or the member stopped it from
     * the task manager. The pass stops at its next part; `true` asks for the
     * job again when its constraint holds, because the member asked for it.
     */
    override fun onStopJob(params: JobParameters): Boolean {
        running?.cancel()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false
        return params.stopReason != JobParameters.STOP_REASON_USER
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}

/**
 * The `dataSync` foreground service (below API 34). See [BackupNow].
 */
public class BackupForegroundService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var running: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ServiceCompat.startForeground(
            this,
            BackupNow.NOTIFICATION_ID,
            BackupNotices.progress(this),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
        )
        // A SECOND START WHILE ONE RUNS IS THE SAME RUN.
        if (running?.isActive != true) {
            running = scope.launch {
                runCatching { BackupNow.run(applicationContext) }
                ServiceCompat.stopForeground(this@BackupForegroundService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        // NOT STICKY: a killed run is not restarted on its own; the periodic
        // worker is the backstop and the member can ask again.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}

/**
 * The one notification both carry: the product's own words, low importance,
 * silent, and a tap that opens the app.
 */
internal object BackupNotices {
    const val CHANNEL: String = "centraid.backup"

    fun progress(context: Context): Notification {
        val manager = NotificationManagerCompat.from(context)
        manager.createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_LOW)
                // THE SHELL'S OWN WORDS (`commonMain`), so the notification and
                // the screens cannot word one thing two ways.
                .setName(BackupClaim.TITLE)
                .build(),
        )
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(context, CHANNEL)
            // THE PLATFORM'S OWN UPLOAD GLYPH: a status-bar icon is a
            // monochrome resource the system tints, and the app ships no
            // drawable of its own.
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(DrainCopy.IN_FLIGHT_TITLE)
            .setProgress(0, 0, true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
            .build()
    }
}
