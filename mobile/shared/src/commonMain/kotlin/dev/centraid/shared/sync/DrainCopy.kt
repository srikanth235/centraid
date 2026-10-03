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
     * **THE POSTURE** (#1080 ruling 2). A pass seals and moves bytes while the
     * app runs; on iOS what it leaves sealed is handed to the operating
     * system, whose uploads go on while the app is suspended.
     */
    public const val POSTURE_SENTENCE: String =
        "Centraid backs up while it is open, and your phone goes on uploading what was ready " +
            "after you leave it."

    /**
     * iOS: a force-quit cancels the uploads handed to the system until the
     * next launch, and Low Power Mode pauses them.
     */
    public const val FORCE_QUIT_SENTENCE: String =
        "If you swipe Centraid away from the app switcher, your phone cancels those uploads until " +
            "you open it again. Low Power Mode pauses them."

    /** Android's floor: the periodic window's network follows the member's rule ([BackgroundWindows]). */
    public const val ANDROID_UNMETERED_SENTENCE: String =
        "Centraid backs up in the background on Wi-Fi, and on cellular too when your setting lets " +
            "full-size photos cross it."

    /** What a member reads while a pass is running. */
    public const val IN_FLIGHT_TITLE: String = "Backing up"

    /**
     * One sentence per `stopped` reason.
     *
     * **`DEADLINE` is not an error and does not say so.** A window that ran out
     * with bytes left is the ordinary case for a first backup of a camera roll.
     */
    public fun stoppedSentence(answer: DrainAnswer): String = when (answer.stopped) {
        // EMPTY IS THE SPOOL'S, NOT THE LIBRARY'S: an item still waiting for
        // Wi-Fi or a charger was never sealed, so "everything" would be a claim.
        DrainAnswer.Stopped.EMPTY -> "Your laptop has everything this phone had ready to send."
        DrainAnswer.Stopped.DEADLINE ->
            "Still backing up — ${bytes(answer.pendingBytes)} to go. It will finish on its own."
        DrainAnswer.Stopped.UNREACHABLE ->
            "Your laptop didn't answer. Nothing was lost; we'll pick up where we left off."
        DrainAnswer.Stopped.UNTRUSTED ->
            "The machine that answered is not your laptop, so this phone sent it nothing. Nothing was lost."
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
