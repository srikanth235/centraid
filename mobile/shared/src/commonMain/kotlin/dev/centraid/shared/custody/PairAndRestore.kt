package dev.centraid.shared.custody

/**
 * PAIRING AND RESTORE, AS TWO MACHINES AND ONE PIECE OF COPY (#1029 W18-4).
 *
 * The two flows a phone has that are not about a vault it already holds:
 *
 * * **Pair** — scan the laptop's QR (or paste the same text), hand it to W15's
 *   `Pair` request, and show the laptop's **safety number** so the member can
 *   compare it with the one the laptop's terminal is printing. That comparison
 *   is the whole security property of the flow and it is the member's to make:
 *   nothing here decides that a pairing is genuine.
 * * **Restore** — 24 words typed, or the seed the platform synchronised, with
 *   an endpoint typed by hand when DNS cannot find the laptop; then `Restore`,
 *   then progress read from `BackupStatus`.
 *
 * **Machines and not views.** `commonMain` holds what both shells do
 * identically — which state the flow is in, what may be tapped, and what
 * sentence is shown — and a SwiftUI or Compose view holds the pixels. Every
 * sentence a member reads is [CustodyCopy]'s for `DrainCopy`'s reason: a
 * sentence spelled in each shell is a sentence one shell gets wrong.
 *
 * **The doors are W15's request kinds**, the same seam shape
 * `dev.centraid.shared.sync.DrainDoor` uses and for the same reason: the
 * request contract is Rust's and the core-backed implementations land with it,
 * while everything that does not depend on the wire is testable on the JVM.
 *
 * The **`VAULT_MOVED` freeze on the old phone is NOT here**, and that is not an
 * omission: it already exists, drawn from the roster's own state
 * (`Shelf.Holding.frozenLine`, `VaultLockup.State.STATE_FROZEN`) with the count
 * of what that phone never uploaded, and a second spelling of it would be a
 * second answer to what a frozen vault says.
 */
public class PairMachine(private val door: PairDoor) {

    private var state: State = State.Waiting

    /** Where the flow is. */
    public fun state(): State = state

    /**
     * A payload, scanned or pasted.
     *
     * **Trimmed once and otherwise untouched.** W17 owns the payload's shape —
     * `base64url(PairTicket)` — and a shell that validated it would be a second
     * parser for a format it does not own, disagreeing with the first one the
     * day either changed. An empty box is the one thing this can answer for
     * itself, because there is nothing to send.
     */
    public suspend fun offer(payload: String): State {
        val ticket = payload.trim()
        if (ticket.isEmpty()) {
            state = State.Refused(CustodyCopy.PAIR_EMPTY)
            return state
        }
        state = State.Pairing
        state = when (val answer = door.pair(ticket)) {
            null -> State.Refused(CustodyCopy.PAIR_UNREACHABLE)
            else -> if (answer.safetyNumber.isBlank()) {
                // A PAIRING WITH NO SAFETY NUMBER IS NOT A PAIRING A MEMBER CAN
                // CHECK. Refused rather than shown, because the alternative is a
                // screen that asks somebody to compare a blank.
                State.Refused(CustodyCopy.PAIR_NO_SAFETY_NUMBER)
            } else {
                State.Paired(answer)
            }
        }
        return state
    }

    public sealed interface State {
        /** Nothing scanned yet. */
        public data object Waiting : State

        /** The payload is with the core. */
        public data object Pairing : State

        /** Paired. [answer] carries the number the member must compare. */
        public data class Paired(public val answer: PairAnswer) : State

        /** [sentence] is what the member reads. */
        public data class Refused(public val sentence: String) : State
    }
}

/**
 * RESTORE FROM 24 WORDS (#1029 §5, W18-4).
 *
 * The phrase is the only credential. This machine holds the words the member
 * typed for exactly as long as it takes to hand them to the core, and holds no
 * derived key at any point: deriving is Rust's, behind the ABI, which is what
 * keeps a seed out of a crash report of a screen's state.
 */
public class RestoreMachine(
    private val door: RestoreDoor,
    /**
     * The seed the platform synchronised to this phone, or null.
     *
     * iCloud Keychain hands one back on a new device; Android's Block Store
     * only does so inside the setup wizard, which is why the written phrase is
     * the common path on that platform and not the fallback
     * (`SyncedSecrets.ANDROID_SENTENCE`).
     */
    private val syncedSeed: suspend () -> String? = { null },
) {
    private var state: State = State.Asking

    public fun state(): State = state

    /** Whether a synchronised seed was found, which changes what is asked. */
    public suspend fun offerSynced(): Boolean = syncedSeed() != null

    /**
     * Restore, from [words] and optionally from an [endpoint] typed by hand.
     *
     * **The endpoint is optional and its absence is normal.** The phone finds
     * the laptop by resolving the identity record the phrase derives; a member
     * types one only when DNS cannot answer — on a network that blocks it, or
     * for a laptop that has never published.
     */
    public suspend fun restore(words: List<String>, endpoint: String? = null): State {
        val phrase = words.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        if (phrase.size != WORDS) {
            state = State.Refused(CustodyCopy.restoreWordCount(phrase.size))
            return state
        }
        state = State.Restoring(CustodyCopy.RESTORE_STARTED)
        state = when (val answer = door.restore(phrase, endpoint?.trim()?.ifEmpty { null })) {
            null -> State.Refused(CustodyCopy.RESTORE_UNREACHABLE)
            else -> if (answer.vaults <= 0) {
                // NOT A FAILURE OF THE PHRASE. A laptop that holds nothing for
                // this identity is the ordinary answer for a member who typed a
                // phrase belonging to a vault that was never backed up, and
                // telling them the words were wrong would be a lie.
                State.Refused(CustodyCopy.RESTORE_NOTHING_HELD)
            } else {
                State.Restored(answer)
            }
        }
        return state
    }

    public sealed interface State {
        /** Waiting for the words. */
        public data object Asking : State

        /** In flight. [sentence] is what a member reads meanwhile. */
        public data class Restoring(public val sentence: String) : State

        public data class Restored(public val answer: RestoreAnswer) : State

        public data class Refused(public val sentence: String) : State
    }

    public companion object {
        /** BIP-39's 256-bit phrase, which is what `identity::phrase` mints. */
        public const val WORDS: Int = 24
    }
}

/** W15's `Pair` request. Null when the laptop could not be reached. */
public interface PairDoor {
    public suspend fun pair(payload: String): PairAnswer?
}

/** W15's `Restore` request. Null when the laptop could not be reached. */
public interface RestoreDoor {
    public suspend fun restore(words: List<String>, endpoint: String?): RestoreAnswer?
}

/**
 * What a `Pair` answered.
 *
 * [safetyNumber] is `identity::safety_number` over the two identities, and it
 * is the only thing on the paired screen a member has to act on.
 */
public data class PairAnswer(
    public val safetyNumber: String,
    /** What the laptop calls itself, for the sentence. May be empty. */
    public val laptopName: String = "",
)

/** What a `Restore` answered: how much came back, and from where. */
public data class RestoreAnswer(
    /** How many vaults the laptop held for this identity. */
    public val vaults: Int,
    /** Bytes still to fetch, as `BackupStatus` reports them. */
    public val pendingBytes: Long = 0,
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
        "Run `centraid pair` on your laptop and scan the square it prints. " +
            "You can paste the text underneath it instead."

    public const val PAIR_EMPTY: String = "Scan the square your laptop printed, or paste its text."

    public const val PAIR_UNREACHABLE: String =
        "Your laptop did not answer. Check it is awake and on the same network, then try again."

    public const val PAIR_NO_SAFETY_NUMBER: String =
        "Centraid could not check who answered, so it did not pair. Try again."

    /**
     * **THE COMPARISON IS THE MEMBER'S** (#1029 §5).
     *
     * A safety number a member is shown but never asked to compare is
     * decoration. The sentence says what to do with it and what it means, and
     * it says the second half plainly: matching numbers mean nobody is in the
     * middle.
     */
    public fun pairedLine(answer: PairAnswer): String {
        val who = answer.laptopName.ifBlank { "your laptop" }
        return "Paired with $who. Check this number matches the one $who is showing: " +
            "${answer.safetyNumber}. If it does not match, unpair and try again on a network " +
            "you trust."
    }

    /** The restore screen's heading and its ask. */
    public const val RESTORE_TITLE: String = "Restore from your 24 words"

    public const val RESTORE_ASK: String =
        "Type the 24 words you wrote down. Centraid finds your laptop from them."

    /** The optional box, and why it is empty almost always. */
    public const val RESTORE_ENDPOINT_ASK: String =
        "If Centraid cannot find your laptop, type the address it printed."

    public const val RESTORE_STARTED: String = "Looking for your laptop…"

    public const val RESTORE_UNREACHABLE: String =
        "Centraid could not reach your laptop. Open Centraid on it, or type the address it " +
            "printed."

    public const val RESTORE_NOTHING_HELD: String =
        "That phrase is valid and your laptop is holding no backup for it. " +
            "Check you are restoring onto the right laptop."

    /**
     * The word-count sentence.
     *
     * It names the number typed as well as the number wanted, because "24
     * words" over a box holding 23 is a member counting them again by hand.
     */
    public fun restoreWordCount(typed: Int): String = when (typed) {
        1 -> "Centraid needs 24 words. There is 1 here."
        else -> "Centraid needs 24 words. There are $typed here."
    }

    /** The line while bytes are coming back, from `BackupStatus`. */
    public fun restoringLine(answer: RestoreAnswer): String = when {
        answer.pendingBytes > 0 ->
            "Restoring ${answer.vaults} vaults. Centraid keeps going in the background."
        answer.vaults == 1 -> "Restored 1 vault."
        else -> "Restored ${answer.vaults} vaults."
    }
}
