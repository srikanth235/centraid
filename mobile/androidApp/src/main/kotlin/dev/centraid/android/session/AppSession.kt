package dev.centraid.android.session

import android.content.Context
import android.os.Build
import android.os.Looper
import android.text.format.DateFormat
import android.util.Log
import dev.centraid.android.backup.LinkFacts
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreConfiguration
import dev.centraid.core.CoreFailure
import dev.centraid.core.CoreOutcome
import dev.centraid.core.Screens
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * THE PROCESS'S ONE CORE AND ITS SCREEN RUNTIME, WHOEVER ARRIVES FIRST (#1080; #1135).
 *
 * The shell opens ONE core over a directory, `filesDir` (`{"shelf": dir}`, `CoreConfig::fronting`):
 * the front holds no vault, and the Rust shelf (`crates/screens/src/vault`) opens every vault
 * under it, keys each from the phone's secrets, rests, wakes, founds and forgets them, and sends
 * every request about a vault to the vault in front. There is one [Screens] over it, so every
 * effect is performed exactly once, by [ShellEffects], whether an activity is up or a WorkManager
 * window woke the process with none ([dev.centraid.android.backup.PassHost]).
 *
 * ## Counted, and ordered
 *
 * [acquire] and [release] pair: the activity holds the session for its life and a background pass
 * for one run. Both run on one thread, in the order asked, under one lock, so a rotation's release
 * lands before the new activity's acquire and the last holder's close finishes before anybody
 * opens again. Two sessions would be two openers of the directory, and the second is refused.
 *
 * `CentraidApplication` opens nothing: a Share, Autofill or Widget process that shares the
 * application class is never an opener.
 */
internal object AppSession {
    /** One open session: the front core, the runtime over it and the shell's performers. */
    class Open(
        val core: CentraidCore,
        val screens: Screens,
        val scope: CoroutineScope,
        val effects: ShellEffects,
        val imports: ImportsRelay,
        private val context: Context,
    ) {
        /**
         * The app came forward or left (the activity's start and stop). The runtime tells every open
         * screen and service (the Locker relocks on leaving; the pass service decides whether coming
         * back is worth a pass, the follow coordinator that every phone store may have changed);
         * coming forward also reports the locale, zone and 12 or 24 hour clock again, and MediaStore
         * is watched while the app is in view.
         */
        suspend fun foreground(on: Boolean) {
            if (on) AppSession.environment(context, screens)
            screens.lifecycle(foreground = on)
            imports.foreground(on)
        }
    }

    private val serial = Executors.newSingleThreadExecutor { work ->
        Thread(work, "centraid-session").apply { isDaemon = true }
    }.asCoroutineDispatcher()
    private val serialScope = CoroutineScope(SupervisorJob() + serial)
    private val lock = Mutex()
    private var holders = 0

    private val state = MutableStateFlow<Open?>(null)

    /** The open session, or null: what composition draws from. Never opens. */
    val current: StateFlow<Open?> = state.asStateFlow()

    private val damagedFlag = MutableStateFlow(false)

    /**
     * The vault file is damaged (`CENTRAID_VAULT_DAMAGED` at open): no core exists, so composition
     * draws `VaultDamagedScreen` in place of bare paper. Set by the open that failed; a later
     * successful open clears it.
     */
    val damaged: StateFlow<Boolean> = damagedFlag.asStateFlow()

    private val reopenCount = MutableStateFlow(0)

    /** Bumped by [reopenForRestore]; the activity opens again each time it moves. */
    val reopens: StateFlow<Int> = reopenCount.asStateFlow()

    @Volatile private var restoreDamagedNext = false

    private val restoreAskedFlag = MutableStateFlow(false)

    /** A restore reopen succeeded and Home has yet to be told to enter the restore entry. */
    val restoreAsked: StateFlow<Boolean> = restoreAskedFlag.asStateFlow()

    /** Home was told; the ask is spent. */
    fun restoreAskTold() {
        restoreAskedFlag.value = false
    }

    /**
     * REOPEN FOR RESTORE: the single place the core's `restoreDamaged` key is sent. The damaged
     * screen's button calls it; the activity opens again over the same path with the key, and on
     * success Home enters the Rust restore entry. If the open fails again the damaged screen stays.
     */
    fun reopenForRestore() {
        restoreDamagedNext = true
        reopenCount.value += 1
    }

    /**
     * The session, opened on first use; null when the core would not open (said in the log, and
     * the screen stays on its ground). [devSeedHex] is a debug build's demo seed, read only by the
     * open that actually happens.
     */
    suspend fun acquire(context: Context, devSeedHex: String? = null): Open? = withContext(serial) {
        lock.withLock {
            val open = state.value ?: open(context.applicationContext, devSeedHex)?.also { state.value = it }
            if (open != null) holders += 1
            open
        }
    }

    /** Let go; queued behind everything asked before it. The last holder closes the core. */
    fun release() {
        serialScope.launch {
            lock.withLock {
                holders = (holders - 1).coerceAtLeast(0)
                if (holders == 0) {
                    val going = state.value
                    state.value = null
                    going?.let {
                        it.scope.cancel()
                        it.core.close()
                    }
                }
            }
        }
    }

    /** Hold the session for [block], and let go on every path. Null when no core opens. */
    suspend fun <T> use(context: Context, block: suspend (Open) -> T): T? {
        val open = acquire(context) ?: return null
        try {
            return block(open)
        } finally {
            release()
        }
    }

    /**
     * The locale, the zone and the platform, whether MediaStore deletes behind the system's own
     * confirmation (`createDeleteRequest`, API 30 and up): Rust offers Free up space only then; and
     * the phone's 12 or 24 hour setting, which Rust words every time by.
     */
    suspend fun environment(context: Context, screens: Screens) {
        screens.environment(
            Locale.getDefault().toLanguageTag(),
            TimeZone.getDefault().id,
            libraryDeletes = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R,
            hourCycle12 = !DateFormat.is24HourFormat(context),
        )
    }

    private suspend fun open(context: Context, devSeedHex: String?): Open? {
        val restoring = restoreDamagedNext
        restoreDamagedNext = false
        val configuration = CoreConfiguration.shelf(
            context.filesDir.absolutePath,
            devSeedHex,
            restoreDamaged = restoring,
        )
        val core = when (
            val opened = CentraidCore.open(
                configuration,
                Dispatchers.IO,
                // THE UI THREAD'S NAME, NOT THE CALLER'S: `centraid_open` asserts it is not on it.
                Looper.getMainLooper().thread.name,
            )
        ) {
            is CoreOutcome.Answered -> opened.value
            is CoreOutcome.Failed -> {
                Log.w("Centraid", "the core did not open: ${opened.failure}")
                damagedFlag.value = opened.failure is CoreFailure.VaultDamaged
                return null
            }
        }
        damagedFlag.value = false
        if (restoring) restoreAskedFlag.value = true
        core.startReader()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val screens = Screens(core, scope)
        screens.attach()
        val effects = ShellEffects(context, core, screens, scope)
        val imports = ImportsRelay(context, screens, scope)
        val open = Open(core, screens, scope, effects, imports, context.applicationContext)
        // THE PERFORMER FIRST: the roots' first effects (the secrets the shelf reads at launch)
        // must find it collecting.
        effects.start()
        imports.start()
        environment(context, screens)
        screens.start()
        LinkFacts.start(context, screens)
        return open
    }
}
