package dev.centraid.shared.shell

import dev.centraid.shared.custody.DevSeed
import dev.centraid.shared.platform.PlatformServices
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * THE ONE SESSION OF THIS PROCESS, OPENED BY WHOEVER ASKS FIRST (#1080, the
 * shells; R-1020-24).
 *
 * A background window can start the process with no screen at all — a
 * WorkManager worker, a `BGTask`, iOS relaunching the app to deliver its
 * background `URLSession`'s events — and its pass needs the vaults open. The
 * screen needs them too. Two openers would be two handles on one vault file,
 * which `SingleHandleGuard` refuses, so both go through here: the first call
 * opens, every later one is handed the same [HomeSession].
 *
 * **Nothing opens until something asks.** An `Application.onCreate` installs
 * bodies that call [open]; it never calls it itself, so a process that only
 * hosts an extension never opens a vault.
 */
public object ShellProcess {
    private val gate = Mutex()
    private var opened: HomeSession? = null

    /** The session, if this process has opened one. */
    public val session: HomeSession? get() = opened

    /** The session, opened on first use. See [HomeSession.open] for the arguments. */
    public suspend fun open(
        vaultDir: String,
        services: PlatformServices,
        dispatcher: CoroutineDispatcher,
        uiThreadName: String,
        devSeed: DevSeed? = null,
    ): HomeSession = gate.withLock {
        opened ?: HomeSession.open(vaultDir, services, dispatcher, uiThreadName, devSeed).also { opened = it }
    }

    /** [HomeSession.close] calls this: a closed session is not handed out again. */
    internal suspend fun closed(session: HomeSession) {
        gate.withLock { if (opened === session) opened = null }
    }
}
