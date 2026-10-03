package dev.centraid.shared.custody

/**
 * PAIRING AND RESTORE: THEIR DOORS, THEIR ANSWERS AND THEIR COPY (#1029 W18-4).
 *
 * The two flows a phone has that are not about a vault it already holds:
 *
 * * **Pair** — scan the laptop's QR (or paste the same text), hand it to W15's
 *   `Pair` request, and show the laptop's endpoint id so the member can compare
 *   it with the one the laptop's terminal is printing. That comparison is the
 *   whole security property of the flow and it is the member's to make: nothing
 *   here decides that a pairing is genuine. Its screen is `PairLaptopFlow`
 *   (`pair.laptop`, #1047 E4).
 * * **Restore** — the 24 words typed, with an endpoint typed by hand when DNS
 *   cannot find the laptop. Its screen is `WordsEntryFlow` (#1047 E1); what is
 *   left here is its door and its answer.
 *
 * **Machines and not views.** `commonMain` holds what both shells do
 * identically — which state the flow is in, what may be tapped, and what
 * sentence is shown — and a SwiftUI or Compose view holds the pixels. Every
 * sentence a member reads is [CustodyCopy]'s for `DrainCopy`'s reason: a
 * sentence spelled in each shell is a sentence one shell gets wrong.
 *
 * **The doors are W15's request kinds**, the same seam shape
 * `dev.centraid.shared.sync.DrainDoor` uses and for the same reason: the
 * request contract is Rust's, the core-backed implementations are in
 * `dev.centraid.shared.sync.CoreDoors`, and everything that does not depend on
 * the wire is testable on the JVM without an FFI.
 *
 * The **`VAULT_MOVED` freeze on the old phone is NOT here**, and that is not an
 * omission: it already exists, drawn from the roster's own state
 * (`Shelf.Holding.frozenLine`, `VaultLockup.State.STATE_FROZEN`) with the count
 * of what that phone never uploaded, and a second spelling of it would be a
 * second answer to what a frozen vault says.
 */
/**
 * W15's `Pair` request. It answers [PairResult.Paired], or [PairResult.Refused]
 * with WHICH refusal — never a bare null (#1047 E5): a laptop that answered
 * and said no is not one that did not answer, and a member told to wake a
 * laptop that is awake has been sent the wrong way.
 */
public interface PairDoor {
    public suspend fun pair(payload: String): PairResult
}

/** What a pairing came back as. */
public sealed interface PairResult {
    public data class Paired(public val answer: PairAnswer) : PairResult

    public data class Refused(public val because: PairRefusal) : PairResult
}

/**
 * WHY A PAIRING DID NOT HAPPEN, by the core's code (`ErrorCode`) and never by
 * its logs-only detail (D-1025-S7-82).
 */
public enum class PairRefusal {
    /** `PEER_UNREACHABLE` and everything unrecognised: the laptop did not answer. */
    UNREACHABLE,

    /** `INVALID_REQUEST`: not a pairing code, a version this build cannot read, or expired. */
    NOT_A_CODE,

    /** `UNAUTHORIZED`: the laptop answered and did not take the code (spent, or never minted). */
    NOT_TAKEN,
}

/**
 * W15's `Restore` request. It answers [RestoreResult.Restored], or
 * [RestoreResult.Refused] with WHICH refusal — never a bare null (#1047 R3),
 * for [PairDoor]'s reason: a snapshot this phone refused to lay down is not
 * a laptop that did not answer, and "could not reach your laptop" sends a
 * member to wake a laptop that is awake.
 *
 * Driven by `WordsEntryFlow` (#1047 E1), which judges the words first and
 * stores what the answer carries; see [Enrollment.restore].
 */
public interface RestoreDoor {
    /**
     * Restore from the 24 words, from the gateway the pairing [payload] names
     * (`RestoreRequest.payload`, #1080 A1) — the text `centraid-gateway pair`
     * prints, scanned or pasted. Null when the member gave none.
     */
    public suspend fun restore(words: List<String>, payload: String?): RestoreResult

    /**
     * The same restore from the 64-byte seed (128 hex) in place of the words
     * (`RestoreRequest.seed`, Q-1047-18): what a phone the synchronised
     * keychain handed the seed and no words restores with.
     */
    public suspend fun restoreSeed(seedHex: String, payload: String?): RestoreResult

    /**
     * ONLY THE VAULTS THAT STAYED, from the seed this phone stored
     * (`RestoreRequest.indices`, R-1047-R6): the [indices] are what an earlier
     * answer named in [RestoreAnswer.unclaimed], never an index the shell
     * chose. The core leaves every vault this phone holds as it is.
     */
    public suspend fun restoreStayed(seedHex: String, payload: String?, indices: List<Int>): RestoreResult
}

/** What a restore came back as. */
public sealed interface RestoreResult {
    /** An answer: every vault the laptop held and this phone accepted — possibly none. */
    public class Restored(public val answer: RestoreAnswer) : RestoreResult {
        override fun toString(): String = "Restored($answer)"
    }

    public data class Refused(public val because: RestoreRefusal) : RestoreResult
}

/**
 * WHY A RESTORE BROUGHT NOTHING BACK, by the core's code (`ErrorCode`) and
 * never by its logs-only detail (D-1025-S7-82). "No vault for these words" is
 * not here: it is an answer, [RestoreAnswer.vaults] empty.
 */
public enum class RestoreRefusal {
    /** `PEER_UNREACHABLE`, no core, and everything unrecognised: the laptop did not answer. */
    UNREACHABLE,

    /** `UNAUTHORIZED`: the gateway answered and would not take this phone's claim on the vault. */
    NOT_TAKEN,

    /**
     * `INTERNAL`: what the gateway sent did not open, or failed `integrity_check`
     * or the census. Nothing was laid down and nothing was claimed — a restore
     * claims only after the snapshot passed its checks (#1080) — so the old
     * phone still backs up (#1047 R3).
     */
    DID_NOT_CHECK,
}

/**
 * What a `Pair` answered (`phone.proto`'s `PairResponse`, #1080).
 *
 * **The safety number is the core's** (#1080 A7, A17):
 * `centraid_identity::safety_number_of_bytes` over the vault's identity public
 * key and the gateway certificate's BLAKE3 fingerprint — the digits the gateway prints
 * when the pairing lands and beside it in `centraid-gateway pairings`. This
 * shell computes no number of its own: a second renderer would be a second
 * answer to "who did I pair with".
 */
public data class PairAnswer(
    /** The 60 digits in 12 groups of 5 to compare; empty when the core could not compute one. */
    public val safetyNumber: String = "",
    /** What the gateway calls itself; may be empty. */
    public val destinationLabel: String = "",
    /** Where it was reached, `host:port`; may be empty. */
    public val destinationAddress: String = "",
)

/**
 * What a `Restore` answered (`phone.proto`'s `RestoreResponse`). Its
 * `toString` carries counts only: a path or a safety number is not a log
 * line's to keep.
 */
public class RestoreAnswer(
    /** Every vault the laptop held for these words, laid down on this phone. */
    public val vaults: List<RestoredVaultAt>,
    /** How many derivation indices were tried past the last that answered. */
    public val gapScanned: Int = 0,
    /**
     * Every vault the restore checked and could not claim
     * (`RestoreResponse.unclaimed`, R-1047-R5): a claim failed after another
     * landed, so this vault's file was removed and its writer epoch is still
     * the old phone's. Empty is the ordinary answer; [vaults] is never empty beside
     * it, because a restore where no claim landed is refused instead.
     */
    public val unclaimed: List<UnclaimedVaultAt> = emptyList(),
) {
    /**
     * Rows the restored snapshots' censuses promised, summed — what makes
     * "your vault is back" a claim rather than a hope (#1029 §2).
     */
    public val rows: Long get() = vaults.sumOf { it.rows }

    override fun toString(): String =
        "RestoreAnswer(vaults=${vaults.size}, unclaimed=${unclaimed.size}, gapScanned=$gapScanned)"
}

/**
 * One vault a restore checked and could not claim (`UnclaimedVault`).
 *
 * **The core's `reason` is not carried**: it is a support-log string, and a
 * member's sentence is never built from logs-only detail (D-1025-S7-82).
 */
public data class UnclaimedVaultAt(
    /** The derivation index it was found at; recorded, never chosen. */
    public val index: Int,
    /** The vault's identity public key, hex. */
    public val vaultId: String = "",
)

/** One vault a restore laid down (`RestoredVault`). */
public data class RestoredVaultAt(
    /** Where the file landed, under the vault directory. */
    public val path: String,
    /** The derivation index it was found at; recorded, never chosen. */
    public val index: Int,
    public val rows: Long = 0,
    /** Grouped digits to compare with the laptop's; empty when not computed. */
    public val safetyNumber: String = "",
)

/**
 * THE COPY FOR BOTH FLOWS, IN ONE PLACE (#1029 W18-4).
 *
 * `DrainCopy`'s rule, applied to the two screens a member only ever sees when
 * something has gone wrong or is being set up — which is exactly when a
 * sentence one shell got wrong costs the most.
 */
public object CustodyCopy {

    /** The pairing screen's heading, and what it asks for. */
    public const val PAIR_TITLE: String = "Pair with your laptop"

    public const val PAIR_ASK: String =
        "Run “centraid-gateway pair” on your laptop and scan the square it prints. " +
            "You can paste the text underneath it instead."

    public const val PAIR_EMPTY: String = "Scan the square your laptop printed, or paste its text."

    public const val PAIR_PASTE_LABEL: String = "Pairing code"

    public const val PAIR_SCAN: String = "Scan the square"

    public const val PAIR_PRIMARY: String = "Pair"

    public const val PAIRING: String = "Pairing with your laptop…"

    public const val PAIRED_TITLE: String = "Check it's your laptop"

    public const val PAIR_FAILED_TITLE: String = "Not paired"

    public const val PAIR_NEEDS_WORDS_TITLE: String = "Your words come first"

    /** A vault opened without its words has no identity to pair with. */
    public const val PAIR_NEEDS_WORDS: String =
        "This vault is open without your 24 words, so it cannot prove to your laptop whose it is. " +
            "Enter your words first, then pair."

    public const val PAIR_NO_VAULT: String = "Make a vault on this phone first, then pair it with your laptop."

    public const val DONE: String = "Done"

    public const val CANCEL: String = "Cancel"

    public const val TRY_AGAIN: String = "Try again"

    public const val PAIR_UNREACHABLE: String =
        "Your laptop did not answer. Check it is awake and on the same network, then try again."

    public const val PAIR_NOTHING_TO_COMPARE: String =
        "Centraid could not check who answered, so it did not pair. Try again."

    /**
     * **THE COMPARISON IS THE MEMBER'S** (#1029 §5, #1080 A7).
     *
     * A safety number a member is shown but never asked to compare is
     * decoration. The sentence says what to do with it and what it means, and
     * it says the second half plainly: matching numbers mean nobody is in the
     * middle.
     */
    public fun pairedLine(answer: PairAnswer): String {
        val who = answer.destinationLabel.ifBlank { "your laptop" }
        val where = if (answer.destinationAddress.isBlank()) "" else " at ${answer.destinationAddress}"
        return "Paired with $who$where. Check every group of the number below matches the safety number " +
            "centraid-gateway printed on $who. If it does not match, do not carry on — " +
            "pair again on a network you trust."
    }

    /** Thousands separated, so a six-figure row count is readable at a glance. */
    public fun grouped(value: Long): String = value.toString()
        .reversed()
        .chunked(3)
        .joinToString(",")
        .reversed()
}
