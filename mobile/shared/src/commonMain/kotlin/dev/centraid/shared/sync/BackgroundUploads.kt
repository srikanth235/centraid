package dev.centraid.shared.sync

import centraid.core.v1.HandoffPart
import centraid.core.v1.Settled
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * THE OS MOVES BYTES WHILE THE APP IS SUSPENDED (#1080 rulings 2 and 7; seam
 * contract §2, A6, A10, A11).
 *
 * iOS continues one kind of transfer for a suspended app: a file upload handed
 * to a background `URLSession`. So the core prepares sealed parts while the app
 * is alive, the shell hands them to that session ([BackgroundUploads], Swift's),
 * and every finished task comes back through [UploadEvents] (this file's
 * [UploadLoop]) to be settled in the core's ledger. Android and the JVM install
 * no [BackgroundUploads]: their passes move bytes in-process.
 *
 * The order after every iOS pass, and again whenever the session drains, is
 * the contract's: `reconcile` once — the gateway is PROBED, because a session
 * whose tasks keep failing is throttled by iOS — then `handoff`, then
 * [BackgroundUploads.enqueue]. An unreachable gateway enqueues nothing and asks
 * for the next window instead.
 */
public interface BackgroundUploads {
    /**
     * File uploads the OS runs while the app is suspended. Each part's request
     * is whole — URL, method, headers and the sealed file at `path` — and
     * `allows_cellular` (A10) says whether the member's rule lets it cross
     * cellular. The shell decides nothing about a part.
     */
    public fun enqueue(batch: List<HandoffPart>)

    /** Tasks handed to the OS and not yet finished. */
    public fun pending(): Int

    /** Cancel every task; the core requeues what it never saw settled. */
    public fun cancelAll()
}

/** What the OS reports, called by the iOS shell (`UploadSettlement`). */
public interface UploadEvents {
    /**
     * One task finished. [httpStatus] is 0 when no response arrived; [error]
     * is null when the gateway stored the part. [vaultId] routes the settle to
     * that vault's core, which ignores a name its ledger does not hold (A6).
     */
    public suspend fun settled(name: String, httpStatus: Int, error: String?, gatewayId: String, vaultId: String)

    /**
     * The OS delivered every event for the session (`urlSessionDidFinishEvents`):
     * hand the next batch off before iOS suspends the app again.
     */
    public suspend fun sessionDrained()
}

/** A paired gateway's certificate, for the shell's own TLS pinning by DER equality. */
public class UploadPin(
    public val gateway: String,
    public val certDer: ByteArray,
    public val addrs: List<String>,
) {
    override fun equals(other: Any?): Boolean = other is UploadPin &&
        other.gateway == gateway && other.certDer.contentEquals(certDer) && other.addrs == addrs

    override fun hashCode(): Int = gateway.hashCode() * 31 + certDer.contentHashCode()

    override fun toString(): String = "UploadPin($gateway, ${certDer.size} bytes, $addrs)"
}

/** The core doors one vault's uploads need; `CoreBackupDoors` in production. */
public interface UploadDoors {
    public suspend fun reconcile(): LedgerChange?

    public suspend fun handoff(maxBytes: Long, maxParts: Int): List<HandoffPart>?

    public suspend fun settle(settled: List<Settled>): LedgerChange?
}

/** What a `settle` or a `reconcile` changed in the ledger. */
public data class LedgerChange(
    public val confirmed: Int,
    public val requeued: Int,
    /** `reconcile` only: whether a gateway answered `exists`. */
    public val reachable: Boolean = true,
)

/**
 * THE KOTLIN HALF OF THE MOVER: settles what the OS reports and hands the next
 * batch off (#1080, seam contract §2).
 *
 * Built when the shell installs its [BackgroundUploads] — at launch, before any
 * vault is open, because iOS may relaunch the app just to deliver finished
 * tasks — and [attach]ed once the session exists. An event that arrives first
 * waits for the attach, up to [ATTACH_WAIT_MS].
 */
public class UploadLoop(private val uploads: BackgroundUploads) : UploadEvents {

    /** What the loop reads off the session. */
    public class Binding(
        /** The vaults whose spools may hand off: held, open and not frozen. */
        public val vaults: () -> List<String>,
        /** The doors for one vault, or null when it is not held or not open. */
        public val doorsFor: (vaultId: String) -> UploadDoors?,
        /** Ask the platform for the next window. */
        public val resubmit: () -> Unit,
    )

    private val bound = CompletableDeferred<Binding>()

    public fun attach(binding: Binding) {
        bound.complete(binding)
    }

    private suspend fun binding(): Binding? = withTimeoutOrNull(ATTACH_WAIT_MS) { bound.await() }

    override suspend fun settled(name: String, httpStatus: Int, error: String?, gatewayId: String, vaultId: String) {
        val doors = binding()?.doorsFor(vaultId) ?: return
        // A VAULT THIS PHONE NO LONGER HOLDS settles nowhere: nothing is
        // waiting on it, and `reconcile` squares any ledger from the gateway.
        doors.settle(
            listOf(
                Settled(
                    name = name,
                    http_status = httpStatus,
                    error = error.orEmpty(),
                    gateway_id = gatewayId,
                    vault_id = vaultId,
                ),
            ),
        )
    }

    override suspend fun sessionDrained() {
        val binding = binding() ?: return
        binding.vaults().forEach { handOff(binding, it) }
    }

    /** A pass on [vaultId] ended: probe, hand off, enqueue. Answers the parts enqueued. */
    public suspend fun afterPass(vaultId: String): Int {
        val binding = binding() ?: return 0
        return handOff(binding, vaultId)
    }

    private suspend fun handOff(binding: Binding, vaultId: String): Int {
        val doors = binding.doorsFor(vaultId) ?: return 0
        // NO CORE, OR AN ARM NOT YET AVAILABLE, IS NOTHING TO DO — never a
        // reason to enqueue what nobody vouched for.
        val probe = doors.reconcile() ?: return 0
        if (!probe.reachable) {
            binding.resubmit()
            return 0
        }
        val room = MAX_IN_FLIGHT - uploads.pending()
        if (room <= 0) return 0
        val batch = doors.handoff(BATCH_BYTES, minOf(room, BATCH_PARTS)).orEmpty()
        if (batch.isNotEmpty()) uploads.enqueue(batch)
        return batch.size
    }

    public companion object {
        /**
         * MODEST BATCHES, because iOS throttles a session whose tasks fail and
         * a batch is only as good as the probe before it: 16 parts, at most
         * 512 MiB, and never more than 32 tasks in the OS's hands at once.
         */
        public const val BATCH_PARTS: Int = 16
        public const val BATCH_BYTES: Long = 512L * 1024L * 1024L
        public const val MAX_IN_FLIGHT: Int = 32

        /** How long an event waits for the session, inside a relaunch's ~30 seconds. */
        public const val ATTACH_WAIT_MS: Long = 15_000
    }
}
