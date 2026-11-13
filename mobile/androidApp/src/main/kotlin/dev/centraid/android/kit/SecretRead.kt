package dev.centraid.android.kit

import centraid.core.v1.SecretAnswer
import java.util.concurrent.CancellationException
import okio.ByteString.Companion.encodeUtf8

/** A missing device value is an answer; a refused or damaged read is not absence. */
internal fun deviceSecretAnswer(read: () -> String?): SecretAnswer = try {
    val value = read()
    SecretAnswer(ok = true, found = value != null, value_ = value.orEmpty().encodeUtf8())
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    SecretAnswer(ok = false)
}
