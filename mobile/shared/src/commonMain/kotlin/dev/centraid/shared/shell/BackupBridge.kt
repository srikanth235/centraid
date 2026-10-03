package dev.centraid.shared.shell

import centraid.screen.v1.BackupLine
import centraid.screen.v1.BackupScreenEvent
import centraid.screen.v1.BackupScreenState
import dev.centraid.shared.custody.PairDoor
import dev.centraid.shared.custody.VaultSecrets
import dev.centraid.shared.platform.BackgroundTasks
import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.sync.BackupReading
import dev.centraid.shared.sync.CorePairDoor
import dev.centraid.shared.sync.TransferRule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * `backup.home` AND HOME'S BACKUP LINE, AS BOTH SHELLS HOLD THEM (#1080, the
 * shells). Swift holds bytes, Compose the `StateFlow`s.
 *
 * A shell:
 *
 * 1. calls [attach] with the session once it exists; Home draws [line] (or
 *    [observeLine]'s bytes) under the vault lockup from then on — the empty
 *    line, before then, draws nothing;
 * 2. opens the screen with [open] when the line is tapped, and draws every
 *    [states] value: the line at the top, `destinations` with their forget
 *    control, `rule_choices` as a picker, the include-videos switch, and the
 *    back-up-now button by `back_up_now_label`/`back_up_now_enabled`;
 * 3. forwards the member's acts — `SetRule(choice.stored)`,
 *    `SetIncludeVideos`, `BackUpNow`, `AddDestination(scanned or pasted
 *    text)`, `ForgetDestination(row.destination_id)` then `ForgetConfirmed` or
 *    `ForgetCancelled` from the `confirm` sheet — and `Dismissed` on close.
 */
public class BackupBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null
    private var onState: ((ByteArray) -> Unit)? = null
    private var onLine: ((ByteArray) -> Unit)? = null
    private val lineFlow = MutableStateFlow(BackupLine())

    private val flow by lazy {
        BackupScreenFlow(
            doors = SessionBackupDoors({ session }, platformServices()),
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        )
    }

    public fun attach(session: HomeSession) {
        this.session = session
        // STARTED HERE AND NOT AT CONSTRUCTION: a view may observe before the
        // session exists, and the run it follows is the session's.
        flow.start()
        scope.launch { flow.state.collect { onState?.invoke(it.encode()) } }
        scope.launch {
            session.backupStatus.line.collect { line ->
                lineFlow.value = line
                onLine?.invoke(line.encode())
            }
        }
    }

    /** Home's line. Empty until the session has read the foreground vault. */
    public val line: StateFlow<BackupLine> get() = lineFlow.asStateFlow()

    public val states: StateFlow<BackupScreenState> get() = flow.state

    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(flow.state.value.encode())
    }

    public fun observeLine(onLine: (ByteArray) -> Unit) {
        this.onLine = onLine
        onLine(lineFlow.value.encode())
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

    public fun currentLine(): ByteArray = lineFlow.value.encode()
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

    override suspend fun writeRule(rule: TransferRule) {
        TransferRule.write(services.secureStore, rule)
        session()?.ruleChanged()
    }

    override suspend fun writeIncludeVideos(include: Boolean) {
        TransferRule.writeIncludeVideos(services.secureStore, include)
    }

    override fun registration(): BackgroundTasks.Registration? = session()?.backgroundRegistration?.value

    override suspend fun backUpNow() {
        session()?.backUpNow()
    }

    override val backingUp: StateFlow<Boolean>
        get() = session()?.drain?.backingUp ?: MutableStateFlow(false)

    override fun pairDoor(): PairDoor? {
        val open = session() ?: return null
        val vaultId = open.shelf.foregroundHolding()?.vaultId ?: return null
        val secrets = VaultSecrets(services.secureStore, services.syncedSecrets)
        return CorePairDoor({ open.shelf.core() }) { secret -> secrets.rememberDeviceSecret(vaultId, secret) }
    }

    override suspend fun forget(destinationId: String): Boolean? = session()?.forgetDestination(destinationId)

    override fun nowMs(): Long = services.clock.read().epochMillis
}
