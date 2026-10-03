package dev.centraid.android.backup

import android.content.Context
import android.os.Looper
import dev.centraid.shared.custody.DevSeed
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.DrainPass
import dev.centraid.shared.sync.ShelfDrain
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * ONE SESSION PER PROCESS, WHOEVER ARRIVES FIRST (#1080, the shells; R-1020-24).
 *
 * The core is one handle per vault FILE per process, and a `HomeSession` is
 * what holds those handles. Until #1080 only `MainActivity` opened one, so the
 * background pass had nothing to run with the app closed: `SyncPass.install`
 * was called from the activity, and a worker that woke without one answered
 * `Result.success()` over nothing. The pass now runs from WorkManager, from a
 * user-initiated job and from a foreground service as well as from the
 * activity — so the session is the PROCESS's, opened by the first of them to
 * ask and closed when the last of them lets go. Two sessions would be two
 * openers of every file, and the second is refused every file the first holds,
 * which a member would see as an empty shelf.
 *
 * ## Counted, and ordered
 *
 * [acquire] and [release] pair: the activity holds the session for its life
 * and a pass holds it for one run. Both run on ONE thread, in the order they
 * were asked, under one lock — so a rotation's release (from the old
 * activity's `onDestroy`) always lands before the new activity's acquire, the
 * last holder's close finishes before anybody opens again, and a rotation with
 * no pass running reopens a fresh session exactly as the activity always did.
 *
 * **The one cost, stated.** A rotation that lands while a background pass
 * holds the session gives the new activity the session that is already open,
 * and the old activity's screens stay routed onto its change stream until it
 * closes — `ChangeStream.route` has no removal. Their effect runners died with
 * the old composition, so what they cost is a reduce per change, bounded by
 * the visit. Tearing the pass down mid-part to avoid it would cost more.
 *
 * Nothing here opens a core in a process that never asks: `CentraidApplication`
 * only INSTALLS the bodies that call [use], so a Share, Autofill or Widget
 * process that shares the application class is never an opener.
 */
public object ProcessSession {
    /** One thread, so the order things were asked in is the order they run. */
    private val serial = Executors.newSingleThreadExecutor { work ->
        Thread(work, "centraid-session").apply { isDaemon = true }
    }.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + serial)
    private val lock = Mutex()

    @Volatile private var open: HomeSession? = null
    private var holders = 0

    /**
     * The session, opened on first use. [devSeed] is a debug build's demo seed
     * and is read only by the open that actually happens — see `DevSeed`.
     */
    public suspend fun acquire(context: Context, devSeed: DevSeed? = null): HomeSession =
        withContext(serial) {
            lock.withLock {
                val session = open ?: HomeSession.open(
                    vaultDir = context.applicationContext.filesDir.absolutePath,
                    services = platformServices(),
                    dispatcher = Dispatchers.IO,
                    // THE UI THREAD'S NAME, NOT THE CALLER'S. A worker or a job
                    // asks from a pool thread; `centraid_open` asserts against
                    // the UI thread, so it is told the one thread it must never
                    // run on.
                    uiThreadName = Looper.getMainLooper().thread.name,
                    devSeed = devSeed,
                ).also { open = it }
                holders += 1
                session
            }
        }

    /**
     * Let go. Not suspending, so `onDestroy` can call it; it is queued behind
     * everything asked before it. The last holder closes the session and every
     * core it holds, off the UI thread.
     */
    public fun release() {
        scope.launch {
            lock.withLock {
                holders = (holders - 1).coerceAtLeast(0)
                if (holders == 0) {
                    val going = open
                    open = null
                    going?.close()
                }
            }
        }
    }

    /** The open session, if one is open. Never opens. */
    public val current: HomeSession? get() = open

    /** Hold the session for [block], and let go on every path. */
    public suspend fun <T> use(context: Context, block: suspend (HomeSession) -> T): T {
        val session = acquire(context)
        try {
            return block(session)
        } finally {
            release()
        }
    }

    /**
     * Every held vault's spool empty after a pass. A vault whose pass was
     * refused as busy is NOT drained — another pass is still working — and a
     * device holding nothing is, which is true.
     */
    public fun drained(outcomes: List<ShelfDrain.Outcome>): Boolean = outcomes.all {
        val outcome = it.outcome
        outcome is DrainPass.Outcome.Ran && outcome.answer.drained
    }
}
