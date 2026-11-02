package dev.centraid.android.kit

import kotlinx.coroutines.CancellationException

/** A platform failure is an answer; cancelling the owning session must still stop its work. */
internal inline fun <T> effectAttempt(block: () -> T): Result<T> = try {
    Result.success(block())
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (failure: Exception) {
    Result.failure(failure)
}
