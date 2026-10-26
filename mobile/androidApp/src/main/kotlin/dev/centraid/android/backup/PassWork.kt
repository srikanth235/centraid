package dev.centraid.android.backup

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.BatteryManager
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import centraid.core.v1.LinkChanged
import centraid.core.v1.ShellFact
import centraid.core.v1.Window
import centraid.core.v1.WindowGranted
import centraid.core.v1.WindowLink
import centraid.core.v1.WindowsScheduled
import dev.centraid.android.session.AppSession
import dev.centraid.core.Screens
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * ANDROID'S BACKGROUND WINDOWS, AS THE PASS SCHEDULER ASKS FOR THEM (#1135; #1080, the shells).
 *
 * **NOT COMPILED IN CI TODAY**: there is no Android SDK on the machines that run
 * `cargo xtask gate`; the owner hand-off in `mobile/README.md` is what proves it.
 *
 * Which windows exist and under which constraints is Rust's (`crates/screens/src/passes/windows.rs`):
 * it sends [Window]s in a `ScheduleWindows` effect and this maps each onto WorkManager — `link`
 * onto `NetworkType`, `requires_charging` onto `setRequiresCharging`, a period onto periodic work
 * and a one-off onto an expedited one-time request. When a window opens, the worker reports it
 * (`ShellFact.window`) and answers WorkManager with what Rust says the pass came to
 * (`PassWindowDone`). Nothing here decides whether a pass runs, what it carries or when the next
 * window is wanted.
 */
internal object PassWork {
    /** The worker's input: the window's name, as Rust scheduled it. */
    const val WINDOW: String = "window"

    /**
     * WHAT A WORKER MAY SPEND: WorkManager's ~10 minutes before `onStopped`, minus a minute so
     * the part in flight finishes at a boundary. A pass that stops short resumes at the next
     * window; the spool loses nothing.
     */
    const val BUDGET_MS: Long = 9L * 60L * 1_000L

    /** The notification an EXPEDITED one-off shows below API 31, where it runs as a foreground service. */
    @Volatile var notice: ((Context) -> ForegroundInfo)? = null

    /** Whether the platform took a window, as it last answered; null before anything was asked. */
    @Volatile var registered: Boolean? = null
        private set

    /** Windows granted and not yet done, by name: [windowDone] resolves them. */
    private val waiting = ConcurrentHashMap<String, CompletableDeferred<Boolean>>()

    /** Keep these windows scheduled, and answer which WorkManager took. */
    fun schedule(context: Context, windows: List<Window>): WindowsScheduled {
        val taken = mutableListOf<String>()
        val refused = mutableListOf<String>()
        val refusals = mutableListOf<String>()
        val manager = try {
            WorkManager.getInstance(context)
        } catch (error: IllegalStateException) {
            return WindowsScheduled(
                refused = windows.map { it.name },
                refusal = error.message ?: "WorkManager refused",
            )
        }
        windows.forEach { window ->
            try {
                if (window.period_minutes == 0) {
                    enqueueOnce(manager, window)
                } else {
                    enqueuePeriodic(manager, window)
                }
                taken += window.name
            } catch (error: IllegalStateException) {
                // OBSERVABLE, NOT ASSUMED: a member reads that the phone will not wake it.
                refused += window.name
                refusals += "${window.name}: ${error.message ?: "refused"}"
            }
        }
        registered = taken.isNotEmpty()
        return WindowsScheduled(taken = taken, refused = refused, refusal = refusals.joinToString("; "))
    }

    private fun enqueuePeriodic(manager: WorkManager, window: Window) {
        manager.enqueueUniquePeriodicWork(
            window.name,
            // UPDATE, NEVER KEEP: KEEP would preserve whatever a shipped build enqueued under the
            // same name — once an unrunnable abstract `Worker` — and the constraints of a rule the
            // member has since changed. UPDATE replaces it in place.
            ExistingPeriodicWorkPolicy.UPDATE,
            PeriodicWorkRequestBuilder<CentraidSyncWorker>(window.period_minutes.toLong(), TimeUnit.MINUTES)
                .setConstraints(constraintsOf(window))
                .setInputData(inputOf(window))
                .build(),
        )
    }

    private fun enqueueOnce(manager: WorkManager, window: Window) {
        val request = OneTimeWorkRequestBuilder<CentraidSyncWorker>()
            .setConstraints(constraintsOf(window))
            .setInputData(inputOf(window))
            .apply {
                // EXPEDITED ONLY WITH A NOTICE TO SHOW: below API 31 an expedited job runs as a
                // foreground service, and a worker with no notification fails inside the framework.
                if (notice != null) setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            }
            .build()
        manager.enqueueUniqueWork(window.name, ExistingWorkPolicy.KEEP, request)
    }

    private fun inputOf(window: Window): Data = Data.Builder().putString(WINDOW, window.name).build()

    private fun constraintsOf(window: Window): Constraints = Constraints.Builder()
        .setRequiredNetworkType(
            when (window.link) {
                WindowLink.WINDOW_LINK_UNMETERED -> NetworkType.UNMETERED
                else -> NetworkType.CONNECTED
            },
        )
        .setRequiresCharging(window.requires_charging)
        .build()

    /** A window opened: report it and wait for Rust to say the pass it ran ended. */
    suspend fun granted(screens: Screens, window: String, budgetMs: Long): Boolean {
        val done = CompletableDeferred<Boolean>()
        waiting.put(window, done)?.complete(false)
        screens.shellFact(ShellFact(window = WindowGranted(window = window, deadline_ms = budgetMs)))
        return try {
            withTimeoutOrNull(budgetMs + GRACE_MS) { done.await() } ?: false
        } finally {
            waiting.remove(window, done)
        }
    }

    /** Rust says the pass a window started has ended (`PassWindowDone`). */
    fun windowDone(window: String, drained: Boolean) {
        waiting.remove(window)?.complete(drained)
    }

    private const val GRACE_MS: Long = 15_000L
}

/**
 * **THE PASS THE OS RUNS, AND IT IS A CONCRETE CLASS.** WorkManager instantiates a worker
 * reflectively, so `androidx.work.Worker` — the abstract base — would be accepted, reported
 * enqueued, and fail every run.
 *
 * It reports the window to the pass scheduler ([PassHost]) and returns what Rust says the pass
 * came to. A pass that stopped short is a retry, not a failure: `Result.failure()` takes the work
 * out of the queue, and a phone that lost its network mid-pass would never back up again until the
 * app was opened.
 */
public class CentraidSyncWorker(
    context: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(context, parameters) {

    override suspend fun doWork(): Result {
        val window = inputData.getString(PassWork.WINDOW) ?: "centraid-sync-pass"
        return try {
            if (PassHost.run(applicationContext, window, PassWork.BUDGET_MS)) Result.success() else Result.retry()
        } catch (error: Exception) {
            Result.retry()
        }
    }

    override suspend fun getForegroundInfo(): ForegroundInfo =
        PassWork.notice?.invoke(applicationContext)
            ?: error("PassWork.notice was never installed; an expedited pass needs a notification")
}

/**
 * WHERE A GRANTED WINDOW FINDS THE RUNTIME: the process's one session ([AppSession]), the activity's
 * if it is up, else opened here for the window with no activity at all. Its performer answers every
 * effect a pass asks for either way, so nothing here depends on a screen being drawn.
 */
internal object PassHost {
    suspend fun run(context: Context, window: String, budgetMs: Long): Boolean =
        AppSession.use(context) { open ->
            open.screens.shellFact(ShellFact(link = LinkFacts.read(context)))
            PassWork.granted(open.screens, window, budgetMs)
        } ?: false
}

/**
 * THE LINK AND THE CHARGER, REPORTED (`ShellFact.link`): what `ConnectivityManager` and the sticky
 * battery broadcast say, at launch and on every change. A reading the platform would not give is
 * sent as unknown, and Rust reads it as the expensive answer (metered, not charging).
 */
internal object LinkFacts {
    private var started = false

    /** One reading, as the platform gives it right now. */
    fun read(context: Context): LinkChanged {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val network: Network? = manager?.activeNetwork
        val online = network != null && manager.getNetworkCapabilities(network)
            ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        val metered = if (network == null) null else manager.isActiveNetworkMetered
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) ?: -1
        return LinkChanged(
            online = online,
            metered = metered ?: false,
            charging = plugged > 0,
            metered_known = metered != null,
            charging_known = plugged >= 0,
        )
    }

    /** The runtime the network callback reports to; the session's, while one is open. */
    @Volatile private var reportTo: Screens? = null

    /** Report to [screens] now and on every change of the default network; the callback is registered once per process. */
    @Synchronized
    fun start(context: Context, screens: Screens) {
        reportTo = screens
        val app = context.applicationContext
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope.launch { screens.shellFact(ShellFact(link = read(app))) }
        if (started) return
        val manager = app.getSystemService(ConnectivityManager::class.java) ?: return
        started = true
        manager.registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = report()

                override fun onLost(network: Network) = report()

                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = report()

                private fun report() {
                    val live = reportTo ?: return
                    scope.launch { live.shellFact(ShellFact(link = read(app))) }
                }
            },
        )
    }
}
