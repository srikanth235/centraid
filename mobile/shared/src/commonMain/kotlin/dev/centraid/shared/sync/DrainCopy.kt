package dev.centraid.shared.sync

/**
 * THE FOLD FROM A PASS'S ANSWER INTO THE BACKUP CLAIM (#1029 W18-2).
 *
 * The UI invariant — **the phone never claims backup the gateway has not
 * acknowledged** — is [BackupClaim]'s, and this is the only place a pass
 * reaches it. Every value handed over came out of the gateway's own
 * acknowledgement, and there is deliberately no constructor here that takes
 * "true".
 */
public object DrainClaim {

    /** The backup row's line, from what the pass was told. */
    public fun line(answer: DrainAnswer, unacked: Int, relative: String): String =
        BackupClaim.line(answer.ackedAtMs, unacked, relative)

    /**
     * Whether a shell may use the word "backed up" without a qualifier.
     *
     * **Pending bytes disqualify it**, and so does a pass that stopped on a
     * deadline or an unreachable gateway: those are behind by construction.
     */
    public fun isBackedUp(answer: DrainAnswer): Boolean = BackupClaim.isBackedUp(
        lastAckedAtMs = answer.ackedAtMs,
        unacked = if (answer.pendingBytes > 0L) 1 else 0,
    )
}

/**
 * WHAT A MEMBER IS TOLD ABOUT A PASS, IN ONE PLACE (#1029 W18-2, W18-3).
 *
 * A sentence spelled in each shell is a sentence one shell gets wrong. Nothing
 * here says "backed up" about a pass that was not acknowledged: that word is
 * [BackupClaim]'s.
 */
public object DrainCopy {

    /**
     * **THE POSTURE.** Centraid drains from inside this process, in the
     * foreground and in the background window the OS grants.
     */
    public const val POSTURE_SENTENCE: String =
        "Centraid backs up while it is open and in the background windows your phone gives it, " +
            "the same way iCloud Backup works. It does not upload while the app is closed."

    /** iOS: force-quitting stops background passes until the next launch. */
    public const val FORCE_QUIT_SENTENCE: String =
        "If you swipe Centraid away from the app switcher, backing up stops until you open it " +
            "again. Your phone stops giving Centraid background time until then."

    /** Android's floor, before the member's own rule is applied. */
    public const val ANDROID_UNMETERED_SENTENCE: String =
        "Centraid uploads in the background when this phone has a network. " +
            "Your Downloads setting still decides what crosses cellular."

    /** What a member reads while a pass is running. */
    public const val IN_FLIGHT_TITLE: String = "Backing up"

    /**
     * One sentence per `stopped` reason.
     *
     * **`DEADLINE` is not an error and does not say so.** A window that ran out
     * with bytes left is the ordinary case for a first backup of a camera roll.
     */
    public fun stoppedSentence(answer: DrainAnswer): String = when (answer.stopped) {
        DrainAnswer.Stopped.EMPTY -> "Backed up. Your laptop holds this vault's records; photos and files stay only on this phone."
        DrainAnswer.Stopped.DEADLINE ->
            "Still backing up — ${bytes(answer.pendingBytes)} to go. It will finish on its own."
        DrainAnswer.Stopped.UNREACHABLE ->
            "Your laptop didn't answer. Nothing was lost; we'll pick up where we left off."
        DrainAnswer.Stopped.MOVED ->
            "This vault moved to another phone. This phone keeps what it has, read-only."
    }

    /**
     * Bytes in a member's units: decimal, because a phone's own storage
     * screen is decimal, and whole units, because "3.27183 MB" is a number
     * nobody can use.
     */
    public fun bytes(count: Long): String = when {
        count < 1_000L -> "$count bytes"
        count < 1_000_000L -> "${count / 1_000} KB"
        count < 1_000_000_000L -> "${count / 1_000_000} MB"
        else -> "${count / 1_000_000_000} GB"
    }
}
