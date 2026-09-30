package dev.centraid.shared.shell

/**
 * WHAT CAME OF MAKING A VAULT ON THIS PHONE (#1029 §1).
 *
 * The replacement for `PairOutcome`, which had three shapes because pairing
 * did: paired and the copy landed, paired and the copy is still coming, or
 * refused. There is no copy and no gateway to take one from — a vault is
 * founded here, in one act — so there are two.
 *
 * A plain sealed interface in `commonMain` because it crosses to Swift as well
 * as being read by Compose, which is the same reason `HomeBridge` exists at
 * all.
 */
public sealed interface FoundResult {
    /**
     * The vault exists and is in front.
     *
     * [vaultName] comes OUT OF THE VAULT and never off anything the shell
     * supplied (#1025 S7-9): `VaultRoster.identify` reads `core_vault`'s own
     * `display_name` from the file that was just founded. The old pairing path
     * printed the gateway's `--vault-name` CLI flag here and named the wrong
     * thing at the one moment a member was checking.
     */
    public data class Made(public val vaultName: String) : FoundResult

    /** Not made, with the sentence a member reads. The code stays on the shelf. */
    public data class Refused(public val sentence: String) : FoundResult

    /**
     * There is no session yet, so nothing was attempted.
     *
     * A state of the app and not an error: [HomeBridge.open] is asynchronous
     * and a button tapped in the moment before it finishes has nothing to act
     * on.
     */
    public data object NoSession : FoundResult
}
