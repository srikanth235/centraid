package dev.centraid.android.kit

/**
 * WHY A WRITE FAILED, as a fact for the core to word: a full phone is [EffectReason.STORAGE_FULL];
 * anything else is [otherwise]. The platform names it in the message of the failure or of a cause
 * ("write failed: ENOSPC (No space left on device)"), which is how an `IOException` or an
 * `ErrnoException` carries it.
 */
internal fun Throwable.writeFailureReason(otherwise: String): String {
    val full = generateSequence(this) { it.cause }.any {
        it.message?.let { text -> text.contains("ENOSPC") || text.contains("No space left", ignoreCase = true) } == true
    }
    return if (full) EffectReason.STORAGE_FULL else otherwise
}
