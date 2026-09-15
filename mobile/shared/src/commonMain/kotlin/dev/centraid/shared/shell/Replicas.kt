package dev.centraid.shared.shell

import okio.FileSystem
import okio.Path
import okio.Path.Companion.toPath

/**
 * THE DIRECTORY IS THE ROSTER (#1025 S5, D-1025-S5-2).
 *
 * Every replica this device holds is a file in one directory, named
 * `centraid-replica-<vaultId>.sqlite3` by [MountKey] — the spelling
 * `centraid_seat::identity` uses — with its content store beside it as
 * `centraid-replica-<vaultId>.bytes`, the layout `crates/seat-link` gives a seat and
 * the one a gateway uses for its own vault
 * ([D-1025-S3-1](../../../../../../../../docs/decisions.md)).
 *
 * There is no manifest beside them, for the reason [VaultRoster] gives: a
 * vault's name lives inside the vault, and an index would be a second place it
 * lives that nothing keeps true.
 *
 * ## The one file that is not named after a vault
 *
 * A device that has never paired has no vault id, so it has nothing to name a
 * file after — and a core has to be OPEN before it can pair, because pairing
 * rides `Request::Pair` through the handle
 * ([D-1025-S1-1]: open unpaired, pair, and the pairing takes the copy). So the
 * first open is at [PAIRING_FILE], and [settle] re-files it under the vault id
 * the gateway named the moment there is one.
 *
 * The alternative — leaving the replica under a provisional name for ever —
 * was rejected: a second pairing would then have to invent a second provisional
 * name, and the file a member's rows are in would be named after nothing.
 */
public object Replicas {
    /**
     * Where a device pairs from, before it knows what it is pairing with.
     *
     * Not a [MountKey] and it cannot be: `MountKey` refuses a blank id and
     * derives its own name, which is exactly the guard that stops a placeholder
     * becoming a file name. This is a different thing with a different name,
     * and [settle] is the only path from it to a mount.
     */
    public const val PAIRING_FILE: String = "centraid-pairing.sqlite3"

    /** What [MountKey.fileName] starts with, so a listing can recognise one. */
    private const val PREFIX: String = MountKey.PREFIX

    /** And what it ends with. */
    private const val SUFFIX: String = MountKey.SUFFIX

    private val fs: FileSystem get() = FileSystem.SYSTEM

    public fun pairingPath(directory: String): String =
        directory.toPath().resolve(PAIRING_FILE).toString()

    public fun pathOf(directory: String, key: MountKey): String =
        directory.toPath().resolve(key.fileName).toString()

    /**
     * Every replica in the directory, sorted by name.
     *
     * Sorted so the same device opens the same vault twice running rather than
     * whichever one the filesystem happened to enumerate first. `-wal` and
     * `-shm` are excluded by the suffix: they are SQLite's sidecars, not
     * vaults, and opening one as a vault fails at the door.
     *
     * [PAIRING_FILE] does not match, and that is deliberate rather than a
     * special case: it is not spelled like a replica because it is not one. A
     * half-paired file is not a vault the member can switch to — it has no id
     * to switch BY — and listing it would put a row in the switcher that names
     * nothing.
     */
    public fun list(directory: String): List<String> {
        val dir = directory.toPath()
        if (!fs.exists(dir)) return emptyList()
        return fs.list(dir)
            .filter { it.name.startsWith(PREFIX) && it.name.endsWith(SUFFIX) }
            .map { it.toString() }
            .sorted()
    }

    /**
     * THE VAULT A REPLICA PATH NAMES (#1025 S7-13).
     *
     * The file name IS the roster ([MountKey]), so the id can be read back off
     * it — which is what lets the shelf fetch a vault's enrolment record
     * BEFORE it opens the file, so the core comes up on the right endpoint
     * identity the first time rather than being reopened once it knows.
     *
     * Empty for anything that is not a replica, including [PAIRING_FILE]: that
     * one names no vault, which is the whole reason it exists.
     */
    public fun vaultIdOf(path: String): String {
        val name = path.toPath().name
        if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) return ""
        return name.substring(PREFIX.length, name.length - SUFFIX.length)
    }

    /**
     * Re-file a just-paired replica under the vault the gateway named.
     *
     * **The bytes move with it.** A replica without its `<stem>.bytes` store is
     * a library of rows pointing at nothing (D-1025-S3-1), and the store is
     * iroh's — a directory with an index in it — so it moves as a directory.
     *
     * Returns the settled path. A move that cannot happen leaves everything
     * where it is and answers null: the member is still paired, still holding
     * their rows, and the next open finds the pairing file and settles it then.
     * Losing the replica to tidy its name would be the worst possible trade.
     */
    public fun settle(directory: String, vaultId: String): String? {
        val from = directory.toPath().resolve(PAIRING_FILE)
        if (!fs.exists(from)) return null
        val key = MountKey(vaultId)
        val to = directory.toPath().resolve(key.fileName)
        // ALREADY SETTLED, OR A SECOND PAIRING WITH THE SAME VAULT. Taking the
        // new file over the old one would throw away the outbox the old one is
        // carrying, which is the member's unsent writes.
        if (fs.exists(to)) return to.toString()
        return try {
            moveWithBytes(from, to)
            to.toString()
        } catch (error: okio.IOException) {
            // Deliberately swallowed to a null, and the comment above says why.
            // There is nothing a member could do with an rename error, and the
            // remedy — try again next open — costs them nothing.
            null
        }
    }

    private fun moveWithBytes(from: Path, to: Path) {
        fs.atomicMove(from, to)
        val bytesFrom = from.parent!!.resolve(byteStoreName(from.name))
        if (fs.exists(bytesFrom)) {
            fs.atomicMove(bytesFrom, to.parent!!.resolve(byteStoreName(to.name)))
        }
        // SQLite's sidecars travel too, or they are stale sidecars for a file
        // that is no longer there — which the next open would read as
        // corruption rather than as absence.
        SIDECARS.forEach { suffix ->
            val sidecar = from.parent!!.resolve(from.name + suffix)
            if (fs.exists(sidecar)) {
                fs.atomicMove(sidecar, to.parent!!.resolve(to.name + suffix))
            }
        }
    }

    /**
     * `centraid-replica-<vaultId>.sqlite3` -> `centraid-replica-<vaultId>.bytes`.
     *
     * THE LAST EXTENSION IS REPLACED, NOT APPENDED, because that is what
     * `crates/seat-link`'s `SeatLink::start` does: `replica.with_extension("bytes")`.
     * This was `name + ".bytes"` for one simulator run, and the run is how it
     * was found — the pairing file's store stayed behind while the settled
     * replica opened a fresh, empty store beside itself. Every photograph the
     * bootstrap had just downloaded was orphaned, and nothing failed: a library
     * of rows pointing at nothing is exactly what D-1025-S3-1 says a replica
     * without its store is, and it renders as a grid of placeholders rather
     * than as an error.
     */
    private fun byteStoreName(fileName: String): String =
        fileName.substringBeforeLast('.', fileName) + ".bytes"

    private val SIDECARS = listOf("-wal", "-shm")
}
