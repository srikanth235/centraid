package dev.centraid.shared.sync

import centraid.screen.v1.BackupLine
import dev.centraid.core.CentraidCore
import dev.centraid.shared.shell.Shelf
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * WHAT THE CORE SAYS ABOUT ONE VAULT'S BACKUP (`backup_status`, seam contract
 * §1).
 *
 * The core's own ledger, read without dialling anyone: drawing a line must not
 * depend on somebody else's network. **Every time is the GATEWAY's clock**
 * ([lastAckMs], [DestinationReading.lastAckMs]), because "backed up" is an
 * acknowledgement and this phone's clock acknowledges nothing (#1080 ruling 7).
 */
public data class BackupReading(
    public val destinations: List<DestinationReading>,
    /** When the latest snapshot was taken, phone clock; null before the first. */
    public val lastSnapshotMs: Long?,
    /** When a gateway last acknowledged the head, gateway clock; null when never. */
    public val lastAckMs: Long?,
    /** Content hashes the vault knows, originals and derivatives. */
    public val contentTotal: Long,
    public val contentConfirmed: Long,
    /** Sealed bytes waiting to move. */
    public val pendingBytes: Long,
    /** What the spool holds on this phone right now. */
    public val spoolBytes: Long,
    /** Why the unconfirmed wait, as counts; a reason with no items is absent. */
    public val waiting: Map<WaitReason, Long>,
    /** The vault moved to another phone; this one is read-only. */
    public val frozen: Boolean,
) {
    /** Items no gateway has acknowledged yet. */
    public val unconfirmed: Long get() = (contentTotal - contentConfirmed).coerceAtLeast(0)
}

/** One paired gateway, as the ledger remembers it. */
public data class DestinationReading(
    public val gatewayId: String,
    public val label: String,
    public val addrs: List<String>,
    /** When it last answered, gateway clock; null when never. */
    public val lastSeenMs: Long?,
    /** When it last acknowledged anything, gateway clock; null when never. */
    public val lastAckMs: Long?,
)

/** Why an item waits (`WaitReason`, seam contract §1). */
public enum class WaitReason {
    WIFI,
    CHARGER,
    GATEWAY,
    ICLOUD,
    BYTES,
    WINDOW,
}

/** The `backup_status` door, as a seam. Null when there is no core to ask. */
public fun interface BackupStatusDoor {
    public suspend fun read(): BackupReading?
}

/**
 * EVERY VAULT'S LAST READING, AND THE FOREGROUND VAULT'S LINE (#1080, the
 * shells).
 *
 * Re-read after every pass (`HomeSession` refreshes the vault whose pass just
 * ended), when the foreground moves, and when the Backup screen opens. The
 * [line] is recomputed from the reading each time — never stored as words —
 * so "2 minutes ago" is as fresh as the last event that touched it.
 */
public class BackupStatusStore(
    private val holdings: () -> List<Shelf.Holding>,
    private val foreground: () -> String?,
    private val doorFor: (() -> CentraidCore?) -> BackupStatusDoor,
    /** This phone's wall clock, for the line's wording only. */
    private val nowMs: () -> Long,
) {
    private val gate = Mutex()
    private val readings = mutableMapOf<String, BackupReading>()
    private val published = MutableStateFlow(BackupLines.line(reading = null, frozen = false, nowMs = 0))

    /** The line Home draws and the Backup screen tops itself with. */
    public val line: StateFlow<BackupLine> get() = published.asStateFlow()

    /** The last reading for [vaultId], or null when it was never read. */
    public suspend fun reading(vaultId: String): BackupReading? = gate.withLock { readings[vaultId] }

    /** Ask [vaultId]'s core again; answers what it said, or null for no core. */
    public suspend fun refresh(vaultId: String): BackupReading? {
        val read = doorFor { holdings().firstOrNull { it.vaultId == vaultId }?.core }.read()
        gate.withLock {
            if (read != null) readings[vaultId] = read
        }
        if (vaultId == foreground()) publish()
        return read
    }

    /** The foreground moved, or the screen asked: re-read it and redraw. */
    public suspend fun refreshForeground(): BackupReading? {
        val vaultId = foreground() ?: return null.also { publish() }
        return refresh(vaultId)
    }

    /** Redraw from what is held: the shelf's freeze, or the clock, moved. */
    public suspend fun publish() {
        val vaultId = foreground()
        val holding = holdings().firstOrNull { it.vaultId == vaultId }
        val reading = gate.withLock { vaultId?.let { readings[it] } }
        published.value = BackupLines.line(
            reading = reading,
            frozen = holding?.moved != null || reading?.frozen == true,
            nowMs = nowMs(),
        )
    }
}
