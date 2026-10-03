package dev.centraid.shared.sync

import centraid.screen.v1.BackupLine
import centraid.screen.v1.BackupScreenEvent
import centraid.screen.v1.BackupScreenState
import dev.centraid.shared.platform.BackgroundTasks
import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * `backup.home`'s BRIDGE — Swift holds bytes, Compose the `StateFlow` (#1080,
 * seam contract A11).
 *
 * A shell:
 *
 * 1. calls [attach] with the session once it exists (Home's own line is
 *    `HomeState.backup_line`, not this bridge's);
 * 2. calls [open] when the line is tapped, and draws every state: the line's
 *    `sentence` and each waiting row's `sentence`, the `destinations` with
 *    `forget_label`, the rule's choices from `HomeBridge.transferRuleChoices`
 *    under `rule_label`, the include-videos switch, and the back-up-now button
 *    by its label — or `progress` while `backing_up_now`;
 * 3. forwards `BackUpNow`, `SetIncludeVideos`, `ForgetDestination(row's
 *    gateway_id)` and `Dismissed` on close; "add a gateway" opens `pair.laptop`.
 */
public class BackupBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null
    private var onState: ((ByteArray) -> Unit)? = null
    private var started = false

    private val flow by lazy {
        BackupScreenFlow(
            doors = SessionBackupDoors({ session }, platformServices()),
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        )
    }

    public fun attach(session: HomeSession) {
        this.session = session
        // STARTED HERE AND NOT AT CONSTRUCTION: a view may observe before the
        // session exists, and the runs it follows are the session's.
        if (!started) {
            started = true
            flow.start()
            scope.launch { flow.state.collect { onState?.invoke(it.encode()) } }
        }
    }

    public val states: StateFlow<BackupScreenState> get() = flow.state

    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(flow.state.value.encode())
    }

    public fun open() {
        forward(BackupScreenEvent(opened = BackupScreenEvent.Opened()))
    }

    public fun send(event: ByteArray) {
        forward(BackupScreenEvent.ADAPTER.decode(event))
    }

    public fun forward(event: BackupScreenEvent) {
        flow.send(event)
    }

    public fun current(): ByteArray = flow.state.value.encode()

    /** Release the bridge's scope; the session and its runs carry on. */
    public fun close() {
        scope.cancel()
    }
}

/** The flow's doors over the live session, read at each use so a vault switch is followed. */
internal class SessionBackupDoors(
    private val session: () -> HomeSession?,
    private val services: PlatformServices,
) : BackupScreenDoors {
    override suspend fun read(): BackupReading? = session()?.backupStatus?.refreshForeground()

    override fun line(): BackupLine = session()?.backupStatus?.line?.value ?: BackupLine()

    override suspend fun rule(): TransferRule = TransferRule.read(services.secureStore)

    override suspend fun includeVideos(): Boolean = TransferRule.includeVideos(services.secureStore)

    override suspend fun writeIncludeVideos(include: Boolean) {
        TransferRule.writeIncludeVideos(services.secureStore, include)
    }

    override fun registration(): BackgroundTasks.Registration? = session()?.backgroundRegistration?.value

    override suspend fun backUpNow() {
        session()?.backUpNow()
    }

    override val backingUp: StateFlow<Boolean>
        get() = session()?.drain?.backingUp ?: MutableStateFlow(false)

    override suspend fun forget(gatewayId: String): ForgetAnswer? = session()?.forgetDestination(gatewayId)

    override fun nowMs(): Long = services.clock.read().epochMillis
}
