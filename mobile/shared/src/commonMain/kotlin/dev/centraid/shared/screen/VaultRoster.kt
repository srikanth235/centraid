package dev.centraid.shared.screen

import centraid.core.v1.Envelope
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.PageRequest
import centraid.core.v1.Request
import centraid.screen.v1.VaultLockup
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreConfiguration
import dev.centraid.core.CoreOutcome
import dev.centraid.core.CoreRole
import kotlinx.coroutines.CoroutineDispatcher

/**
 * WHICH VAULTS THIS DEVICE HOLDS, AND WHAT EACH ONE IS CALLED (#1020, wave A).
 *
 * A vault's name lives INSIDE the vault — `core_vault.display_name` — and
 * nowhere else. There is no index beside the files and this deliberately does
 * not write one: a manifest listing names would be a second place a vault's
 * name lives, and the moment a member renamed one from another device the two
 * would disagree with no way to tell which was right. So a roster is built by
 * asking each file what it is called.
 *
 * ## Why the survey runs BEFORE the active core opens
 *
 * **One core per device process** (R-1020-24, enforced by `SingleHandleGuard`):
 * a second `CentraidCore.open` while one is live is refused, by design, because
 * app extensions must never hold the vault open behind the app. So the survey
 * opens each file IN TURN and closes it before the next — never two at once —
 * and it must finish before the session opens the vault it is going to keep
 * open. A roster read afterwards would be refused on every file including the
 * one already open.
 *
 * That ordering is the cost of the law and it is a small one: the survey reads
 * one row per file.
 *
 * ## A file that will not open is not an error
 *
 * It is simply not in the roster. A vault whose bytes are corrupt, mid-copy, or
 * written by a newer build cannot be switched to, and listing it as a row that
 * fails on tap would offer the member a door that does not open.
 */
public object VaultRoster {
    /**
     * The one statement that names a vault, shared by the survey and by the
     * lockup read on the open core.
     *
     * `core_vault` holds exactly one row — a vault file is a vault — so the
     * order is there to satisfy the door's keyset cursor, not to choose between
     * candidates.
     */
    public val QUERY: PageQuery = PageQuery(
        name = "home.vault",
        select = listOf("vault_id", "display_name"),
        from = "core_vault",
        order = PageOrder(sort_column = "vault_id", pk_column = "vault_id"),
    )

    /** The roster, and where each of its vaults actually lives. */
    public data class Survey(
        public val vaults: List<VaultLockup>,
        /**
         * `vault_id` to the path that holds it.
         *
         * The map stays HERE and never crosses into a screen state: a switch
         * names an id, and resolving it to a file is the session's business.
         */
        public val pathsById: Map<String, String>,
    )

    /**
     * Ask ONE open core what vault it is holding.
     *
     * The gateway name is deliberately absent: this core has no endpoint —
     * `Handle::start_endpoint` is a stub — so an empty gateway line is what
     * says "not connected to a gateway", which is the truth. `offline` stays
     * false because a core that has never been anywhere is not offline.
     */
    public suspend fun identify(core: CentraidCore): VaultLockup? {
        val envelope = Envelope(
            request_id = 0,
            request = Request(page = PageRequest(query = QUERY, limit = 1)),
        )
        val row = when (val outcome = core.call(envelope)) {
            is CoreOutcome.Failed -> null
            is CoreOutcome.Answered -> outcome.value.response?.page?.rows?.firstOrNull()
        } ?: return null
        val id = row.values.getOrNull(0)?.text.orEmpty()
        val name = row.values.getOrNull(1)?.text.orEmpty()
        // AN UNNAMED, UNIDENTIFIED ROW IS NOT A VAULT. A file that answered the
        // read with neither is one whose `core_vault` has not been founded, and
        // a roster row for it would be a blank the member could tap.
        if (id.isEmpty() && name.isEmpty()) return null
        return VaultLockup(vault_id = id, vault_name = name)
    }

    /**
     * Open each path in turn, ask it its name, close it.
     *
     * `create = false` throughout: a survey that founded a vault where it found
     * no file would mint an empty vault as a side effect of listing them.
     */
    public suspend fun survey(
        vaultPaths: List<String>,
        dispatcher: CoroutineDispatcher,
        uiThreadName: String,
    ): Survey {
        val vaults = mutableListOf<VaultLockup>()
        val paths = mutableMapOf<String, String>()
        for (path in vaultPaths) {
            val core = when (
                val outcome = CentraidCore.open(
                    CoreConfiguration(
                        databasePath = path,
                        role = CoreRole.GATEWAY,
                        create = false,
                    ),
                    dispatcher,
                    uiThreadName,
                )
            ) {
                is CoreOutcome.Answered -> outcome.value
                is CoreOutcome.Failed -> null
            } ?: continue
            val lockup = try {
                identify(core)
            } finally {
                // CLOSED BEFORE THE NEXT OPEN, on every path out of this block.
                // The guard is process-wide; a probe that returned without
                // closing would refuse every core the app opened afterwards,
                // including the one it means to keep.
                core.close()
            }
            if (lockup == null || lockup.vault_id.isEmpty()) continue
            vaults += lockup
            paths[lockup.vault_id] = path
        }
        return Survey(vaults = vaults, pathsById = paths)
    }
}
