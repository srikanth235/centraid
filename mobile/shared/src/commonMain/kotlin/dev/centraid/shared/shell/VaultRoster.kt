package dev.centraid.shared.shell

import centraid.core.v1.Envelope
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.PageRequest
import centraid.core.v1.Request
import centraid.screen.v1.VaultLockup
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome

/**
 * WHAT A VAULT IS CALLED, ASKED OF THE VAULT (#1020, wave A; #1025 S7-9).
 *
 * A vault's name lives INSIDE the vault — `core_vault.display_name` — and
 * nowhere else. There is no index beside the files and this deliberately does
 * not write one: a manifest listing names would be a second place a vault's
 * name lives, and the moment a member renamed one from another device the two
 * would disagree with no way to tell which was right. So a name is got by
 * asking the file what it is called.
 *
 * ## The SURVEY is gone; [Shelf] holds the set
 *
 * This used to also own `survey`, which opened every replica in turn at launch,
 * read one row from each and answered a list. That list was taken ONCE and
 * never again, so a vault admitted afterwards was invisible until the app was
 * relaunched, and each row's second line was a GUESS — "paired" if a pairing
 * record existed, "unpaired" otherwise — about a pass the survey had not run.
 *
 * [Shelf] does the reading now, publishes a roster that changes when the
 * holdings change, and derives each row's state from what a pass actually did.
 * What is left here is the ONE STATEMENT that names a vault and the decoding of
 * its row, shared by the shelf's launch probe and by every later re-read, so
 * the two cannot come to name the same vault differently.
 */
public object VaultRoster {
    /**
     * The one statement that names a vault, shared by the shelf's launch probe
     * and by the lockup read on whichever core is open.
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

    /**
     * Ask ONE open core what vault it is holding.
     *
     * IDENTITY ONLY, and [VaultLockup.state] is left at
     * [VaultLockup.State.STATE_UNSPECIFIED] for [Shelf] to derive (#1025 S7-9).
     * The state is not knowable from the row this reads: it is a function of
     * what the last PASS did, and this function runs no pass. A default of
     * "online" would be this function guessing, which is exactly how the field
     * it replaced came to say "not connected to a gateway" over a synced device
     * for two waves.
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
}
