package dev.centraid.android.kit

import android.system.ErrnoException
import android.system.OsConstants
import java.io.IOException

/**
 * WHY A WRITE FAILED, as a fact for the core to word: a full phone (`ENOSPC`, "No space left on
 * device", anywhere in the cause chain) is [EffectReason.STORAGE_FULL]; anything else is [otherwise].
 */
internal fun Throwable.writeFailureReason(otherwise: String): String {
    val full = generateSequence(this) { it.cause }.any {
        (it is ErrnoException && it.errno == OsConstants.ENOSPC) ||
            (it is IOException && it.message?.contains("No space left", ignoreCase = true) == true)
    }
    return if (full) EffectReason.STORAGE_FULL else otherwise
}
