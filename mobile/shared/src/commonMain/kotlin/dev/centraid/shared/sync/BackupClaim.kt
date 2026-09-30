package dev.centraid.shared.sync

/**
 * WHAT THE HEADER IS ALLOWED TO SAY ABOUT BACKUP (#1029 §3, W5B-2).
 *
 * The umbrella's UI invariant, in the one place a shell could break it:
 * **the phone never claims backup or sync the gateway has not acknowledged.**
 *
 * ## Why this is a formatter and not a rule
 *
 * The rule lives in Rust, in `centraid_gateway_client::spool::BackupState`,
 * whose only "backed up" constructor takes a gateway's own `committed_at_ms`
 * out of a `CommitAck`. This object does no deciding: it is handed the two
 * numbers that acknowledgement produced and turns them into a sentence. A
 * Kotlin copy of the rule would be a second answer to "is this backed up",
 * and the two would disagree the first time either was touched — with the
 * wrong half being the one a member reads on the day their other phone is
 * gone.
 *
 * So there is no constructor here that takes "true". Everything comes from
 * [lastAckedAtMs] being null or not.
 *
 * ## The four sentences, and the one that is missing
 *
 * There is deliberately **no "Backing up…"** that outlives a pass. A phone
 * with unsent changes says how many, not that it is busy: "busy" is a promise
 * about the future and this product does not make one. A pass in flight is
 * drawn by the header's own activity, not by a claim.
 */
public object BackupClaim {

    /** The heading a vault's backup row draws. */
    public const val TITLE: String = "Backup"

    /**
     * Nothing has reached the gateway yet. **Not a failure** — a vault founded
     * five minutes ago is here, and so is one whose first pass has not run.
     */
    public const val NEVER: String = "Not backed up yet."

    /**
     * The line for a vault whose newest change the gateway has, drawn over a
     * [lastAckedAtMs] that came from an acknowledgement.
     */
    public fun upToDate(relative: String): String = "Records backed up $relative."

    /**
     * The line for a vault with an acknowledgement AND changes behind it.
     *
     * It leads with what is NOT backed up, because that is the part a member
     * would be wrong about: a row reading "Backed up 2 minutes ago" over three
     * unsent changes is the claim this whole object exists to prevent.
     */
    public fun behind(unacked: Int, relative: String): String = when (unacked) {
        1 -> "1 change not backed up. Records last backed up $relative."
        else -> "$unacked changes not backed up. Records last backed up $relative."
    }

    /**
     * The sentence for a vault that has moved to another phone (F1).
     *
     * `Shelf.Holding.frozenLine` is the one that draws it; this is the same
     * sentence for the backup row, so a member reading two places is not told
     * two things.
     */
    public fun frozen(unacked: Int, since: String): String = when (unacked) {
        0 -> "This vault moved to another phone. Nothing is waiting here."
        1 -> "This vault moved to another phone. 1 change since $since is only here."
        else -> "This vault moved to another phone. $unacked changes since $since are only here."
    }

    /**
     * The whole line, from the only two facts a gateway produced.
     *
     * @param lastAckedAtMs the gateway's own `committed_at_ms`, or null when it
     *   has never acknowledged a commit for this vault. **Never this phone's
     *   clock**: a shell that filled this in locally would be a shell that says
     *   "backed up" about bytes nobody received.
     * @param unacked how many of this phone's changes are still in the spool.
     * @param relative how long ago [lastAckedAtMs] was, already worded — the
     *   wording is `Instants`' and is not restated here.
     */
    public fun line(lastAckedAtMs: Long?, unacked: Int, relative: String): String = when {
        lastAckedAtMs == null -> NEVER
        unacked <= 0 -> upToDate(relative)
        else -> behind(unacked, relative)
    }

    /**
     * Whether a shell may use the word "backed up" about this vault without a
     * qualifier.
     *
     * True only over an acknowledgement with an empty spool. It is here so a
     * screen can ask rather than infer, and so the assertion has one name in
     * both the Kotlin and the Rust halves.
     */
    public fun isBackedUp(lastAckedAtMs: Long?, unacked: Int): Boolean =
        lastAckedAtMs != null && unacked <= 0
}
