package dev.centraid.shared.shell

import centraid.core.v1.FoundContent
import centraid.screen.v1.VaultLockup
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreConfiguration
import okio.FileSystem
import okio.Path.Companion.toPath

/**
 * "SEE AN EXAMPLE": A FULL APP, READ-ONLY, THAT LEAVES NOTHING BEHIND
 * (docs/decisions.md, "Onboarding without sample data").
 *
 * An app with nothing in it teaches nobody what it is for, so every app's
 * day-one empty state offers a look at a full one. What the member looks at is
 * an **ephemeral core** over a directory of its own under the OS's temporary
 * directory, opened as an example (`CoreConfiguration.example`) and filled by
 * the core with the example scenario (`FOUND_CONTENT_EXAMPLE`).
 *
 * ## WHAT KEEPS IT OUT OF THE MEMBER'S DATA
 *
 * - **Never on the shelf.** Its directory is under [root], never the vault
 *   directory, so [Shelf.load] cannot list it and it is never a [Shelf.Holding]:
 *   not on the roster, not in a pass ([dev.centraid.shared.sync.ShelfDrain]
 *   walks holdings), not in the backup line.
 * - **Never keyed.** No seed is read for it and the core refuses an example
 *   open that carries one, so nothing is sealed under the member's keys and no
 *   derivation index is spent.
 * - **Never written.** The core answers its one found and reads, and refuses
 *   every write, Locker, backup door and chat request; the screens say so
 *   first ([Shelf.readOnlySentence]).
 * - **Never kept.** [close] deletes the directory whole, and [sweep] deletes
 *   whatever a process killed mid-preview left, at the next launch. The OS's
 *   temporary directory is outside the platform's own backups on both shells.
 *
 * Not thread-safe on its own: [Shelf] calls it under its structural gate.
 */
public class ExamplePreview(
    /** Where every example directory lives: `<tmp>/centraid-example`. */
    private val root: String,
    /** A fresh, unguessable directory name. */
    private val freshName: () -> String,
    /** How a core is opened; [Shelf]'s own opener. Null is a refusal. */
    private val opener: suspend (CoreConfiguration) -> CentraidCore?,
) {
    private class Open(val core: CentraidCore, val directory: String, val lockup: VaultLockup)

    private var open: Open? = null

    private val fs: FileSystem get() = FileSystem.SYSTEM

    /** The example core while a preview is open, else null. */
    public val core: CentraidCore? get() = open?.core

    /** The example's lockup while a preview is open: its name, and `example`. */
    public val lockup: VaultLockup? get() = open?.lockup

    /**
     * OPEN A PREVIEW: a fresh directory, an example core over it, the example
     * found. A preview already open is answered as it is. Null when any step
     * is refused — and then nothing is left on disk.
     */
    public suspend fun open(): CentraidCore? {
        open?.let { return it.core }
        // A FRESH DIRECTORY EVERY TIME, after sweeping the last one: a preview
        // is never resumed, so nothing of an earlier one is ever read again.
        sweep()
        val directory = root.toPath().resolve(freshName())
        if (runCatching { fs.createDirectories(directory) }.isFailure) return null
        val path = directory.resolve(Shelf.VAULT_FILE).toString()
        val core = opener(CoreConfiguration(databasePath = path, create = true, example = true))
        if (core == null) {
            delete(directory.toString())
            return null
        }
        val founded = VaultRoster.found(
            core,
            displayName = EXAMPLE_VAULT_NAME,
            ownerName = Shelf.DEFAULT_OWNER_NAME,
            content = FoundContent.FOUND_CONTENT_EXAMPLE,
        )
        val named = if (founded) VaultRoster.identify(core) else null
        if (named == null || named.vault_id.isEmpty()) {
            core.close()
            delete(directory.toString())
            return null
        }
        val lockup = named.copy(state = VaultLockup.State.STATE_ONLINE, example = true)
        open = Open(core, directory.toString(), lockup)
        return core
    }

    /** CLOSE THE PREVIEW: the core, then its directory, whole. Idempotent. */
    public fun close() {
        val going = open ?: return
        open = null
        going.core.close()
        delete(going.directory)
    }

    /**
     * DELETE EVERY EXAMPLE DIRECTORY — what a process killed mid-preview left.
     * Called at launch and before every [open]; never while one is open.
     */
    public fun sweep() {
        if (open != null) return
        runCatching { fs.deleteRecursively(root.toPath(), mustExist = false) }
    }

    private fun delete(directory: String) {
        runCatching { fs.deleteRecursively(directory.toPath(), mustExist = false) }
    }

    public companion object {
        /**
         * WHAT THE EXAMPLE IS CALLED, on its lockup. Written to its own
         * `core_vault.display_name` and read back like any vault's name.
         */
        public const val EXAMPLE_VAULT_NAME: String = dev.centraid.design.copy.SharedCopy.EXAMPLE_NAME

        /** The directory under the OS's temporary directory every preview lives in. */
        public const val ROOT_NAME: String = "centraid-example"

        /** `<the OS's temporary directory>/centraid-example`. */
        public fun defaultRoot(): String =
            FileSystem.SYSTEM_TEMPORARY_DIRECTORY.resolve(ROOT_NAME).toString()
    }
}
