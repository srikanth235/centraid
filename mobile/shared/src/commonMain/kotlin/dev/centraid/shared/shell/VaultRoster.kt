package dev.centraid.shared.shell

import centraid.core.v1.Envelope
import centraid.core.v1.FoundContent
import centraid.core.v1.FoundRequest
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
        select = listOf(
            "vault_id",
            "display_name",
            // THE SAMPLE MARK, read by the vault rather than parsed here:
            // `commonMain` carries no JSON dependency, and `settings_json` is
            // `json_valid` by its own CHECK. `seeding`, `ready`, or null for a
            // vault that is not a sample (`crates/vault`'s `SampleMark`).
            "json_extract(settings_json, '$.sample') AS sample",
            // WHEN THE VAULT WAS FOUNDED, for Home's notice slot (R-SAMPLE-8):
            // `created_at`, as the core wrote it. Last, so the positions above
            // do not move.
            "created_at",
        ),
        from = "core_vault",
        order = PageOrder(sort_column = "vault_id", pk_column = "vault_id"),
    )

    /** The sample mark's two words, as `crates/vault`'s `SampleMark::word` spells them. */
    public const val SAMPLE_SEEDING: String = "seeding"
    public const val SAMPLE_READY: String = "ready"

    /**
     * WHAT A FILE SAYS IT IS: its lockup, and whether it is a sample vault
     * whose scenario never finished.
     *
     * An UNFINISHED sample is a sample vault whose mark still says `seeding` —
     * the found's own commit landed and the process went before the scenario
     * did. It is not a holding: [Shelf] deletes its directory rather than
     * holding half a scenario as if it were whole.
     */
    public data class Named(
        public val lockup: VaultLockup,
        public val unfinishedSample: Boolean,
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
    public suspend fun identify(core: CentraidCore): VaultLockup? = name(core)?.lockup

    /**
     * [identify], and whether the file is a sample vault that never finished
     * ([Named.unfinishedSample]). [VaultLockup.sample] is true only for a
     * FINISHED sample: half a scenario is never drawn as one.
     */
    public suspend fun name(core: CentraidCore): Named? {
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
        val mark = row.values.getOrNull(2)?.text
        val foundedAt = row.values.getOrNull(3)?.text.orEmpty()
        return Named(
            lockup = VaultLockup(
                vault_id = id,
                vault_name = name,
                sample = mark == SAMPLE_READY,
                founded_at = foundedAt,
            ),
            unfinishedSample = mark == SAMPLE_SEEDING,
        )
    }

    /**
     * FOUND A VAULT IN AN OPEN, EMPTY FILE (#1029 W5, hand-off 1).
     *
     * The write half of [identify], and it is here beside it for the reason
     * [identify] is here at all: these are the two statements about a vault's
     * OWN IDENTITY, and one file writing the row and another reading it is how
     * two layers come to disagree about what a vault is called.
     *
     * `Core::open` with `create` lays the migrations down and stops. This is
     * the door that writes `core_vault` and the owner's `core_party` — one
     * commit, `crates/core`'s `api::found` — and until it existed a phone could
     * make a file that could never say which vault it was.
     *
     * **Nothing is read back here.** The response carries the id, and the shelf
     * still calls [identify] afterwards: the NAME a member sees has to come out
     * of the vault rather than out of the string the shell happened to send,
     * which is the rule [identify]'s header states and the one the old pairing
     * path broke by printing a gateway's CLI flag.
     *
     * Answers false for every refusal — a core that would not take the write,
     * a file that already holds a vault ([`ERROR_CODE_VAULT_ALREADY_HELD`]).
     * The caller deletes the file it made; see [Shelf.found].
     */
    public suspend fun found(
        core: CentraidCore,
        displayName: String,
        ownerName: String,
        /**
         * What the core fills the new vault with (`vault.proto`'s
         * `FoundContent`): nothing, two starter rows in a member's first vault,
         * or the sample scenario — which makes this file THE SAMPLE VAULT.
         */
        content: FoundContent = FoundContent.FOUND_CONTENT_EMPTY,
    ): Boolean {
        val envelope = Envelope(
            request_id = 0,
            request = Request(
                found = FoundRequest(display_name = displayName, owner_name = ownerName, content = content),
            ),
        )
        return when (val outcome = core.call(envelope)) {
            is CoreOutcome.Failed -> false
            is CoreOutcome.Answered ->
                outcome.value.response?.found?.vault_id?.isNotEmpty() == true
        }
    }
}
