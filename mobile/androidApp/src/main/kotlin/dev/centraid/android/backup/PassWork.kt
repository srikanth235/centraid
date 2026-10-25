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
import centraid.core.v1.EffectDone
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectRequest
import centraid.core.v1.EffectResult
import centraid.core.v1.LinkChanged
import centraid.core.v1.PassNoted
import centraid.core.v1.ShellFact
import centraid.core.v1.Window
import centraid.core.v1.WindowGranted
import centraid.core.v1.WindowLink
import centraid.core.v1.WindowsScheduled
import dev.centraid.core.Screens
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
 * WHERE A GRANTED WINDOW FINDS THE RUNTIME. With the app on screen it is that runtime's `Screens`
 * ([live], set by the hosting route); with the app closed the worker opens the process's session
 * and runs a headless one, performing only the effects a pass asks for (no screen is drawn).
 */
internal object PassHost {
    /** The foreground runtime's shell side, when the UI holds one. */
    @Volatile var live: Screens? = null
        set(value) {
            field = value
            if (value != null) LinkFacts.start(value)
        }

    suspend fun run(context: Context, window: String, budgetMs: Long): Boolean {
        live?.let { screens ->
            screens.shellFact(ShellFact(link = LinkFacts.read(context)))
            return PassWork.granted(screens, window, budgetMs)
        }
        return ProcessSession.use(context) { session ->
            // NO CORE HELD IS NOTHING TO BACK UP, which is a window that drained.
            val core = session.shelf.core() ?: return@use true
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val screens = Screens(core, scope)
            val attached = screens.attach()
            try {
                val performer = scope.launch {
                    screens.effects.collect { request -> scope.launch { performHeadless(context, screens, request) } }
                }
                screens.environment(Locale.getDefault().toLanguageTag(), TimeZone.getDefault().id)
                screens.start()
                screens.shellFact(ShellFact(link = LinkFacts.read(context)))
                val drained = PassWork.granted(screens, window, budgetMs)
                performer.cancel()
                drained
            } finally {
                attached.cancel()
                scope.cancel()
            }
        }
    }

    /**
     * THE EFFECTS A PASS ASKS FOR, with no UI: the windows, the long run, the camera roll's walk
     * (a window has no time for one) and the core's own doors. Anything else is answered
     * `failed`, by value, so the service that asked is never left waiting.
     */
    private suspend fun performHeadless(context: Context, screens: Screens, request: EffectRequest) {
        val effect = request.effect
        val result = when {
            effect?.schedule_windows != null ->
                EffectResult(windows_scheduled = PassWork.schedule(context, effect.schedule_windows!!.windows))
            effect?.pass_window_done != null -> {
                PassWork.windowDone(effect.pass_window_done!!.window, effect.pass_window_done!!.drained)
                EffectResult(pass_noted = PassNoted())
            }
            effect?.long_run != null -> {
                if (effect.long_run!!.start) BackupNow.start(context) else BackupNow.stop(context)
                EffectResult(pass_noted = PassNoted())
            }
            effect?.camera_roll != null -> EffectResult(done = EffectDone())
            effect?.core_call != null -> dev.centraid.android.kit.coreCallFor(screens.core, effect.core_call!!)
            else -> EffectResult(failed = EffectFailed(reason = "not performed by this shell"))
        }
        screens.answer(request, result)
    }
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

    /** Report to [screens] now and on every change of the default network, once. */
    @Synchronized
    fun start(screens: Screens) {
        val context = screensContext ?: return
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope.launch { screens.shellFact(ShellFact(link = read(context))) }
        if (started) return
        started = true
        manager.registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = report()

                override fun onLost(network: Network) = report()

                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = report()

                private fun report() {
                    val live = PassHost.live ?: return
                    scope.launch { live.shellFact(ShellFact(link = read(context))) }
                }
            },
        )
    }

    /** The application context, set once by the `Application`. */
    @Volatile var screensContext: Context? = null
}
