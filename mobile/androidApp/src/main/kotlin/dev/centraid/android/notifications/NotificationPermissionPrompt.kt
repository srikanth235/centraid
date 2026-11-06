package dev.centraid.android.notifications

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** A device-local record of the automatic notification permission request. */
internal class NotificationPermissionPrompt(
    private val requested: File,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val request = Mutex()

    suspend fun requestIfNeeded(
        needed: Boolean,
        granted: Boolean,
        prompt: (suspend () -> Boolean)?,
    ) {
        if (!needed || granted || prompt == null) return
        request.withLock {
            if (withContext(io) { requested.isFile }) return@withLock

            // A missing UI or cancelled launcher must not consume the first ask.
            // Either actual system answer (including denial) leaves Settings as
            // the remedy on subsequent launches.
            prompt()
            // The system already answered. Closing the runtime now must not
            // lose that fact and cause another automatic request next launch.
            withContext(NonCancellable + io) {
                if (!requested.createNewFile() && !requested.isFile) {
                    throw IOException("The notification permission request could not be saved.")
                }
            }
        }
    }
}
