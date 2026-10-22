package dev.centraid.shared.shell

import centraid.core.v1.Envelope
import centraid.core.v1.Request
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * THE SCREEN RUNTIME'S DOOR FOR A SHELL THAT CANNOT OPEN A CORE OF ITS OWN
 * (#1135): SwiftUI.
 *
 * A vault file takes one handle (R-1020-24, `SingleHandleGuard`), and this
 * session already holds it, so Swift reaches Rust's screens through the same
 * [CentraidCore]. The door carries bytes and nothing else: a `centraid.core.v1
 * .Request` in, its `Response` out, and every `ScreenUpdate` the core pushes.
 * Swift decodes them with its own generated types; no screen is named here.
 *
 * The core is a supplier, read at each call, so a vault switch is picked up by
 * the next call. [observe] follows the foreground core as it stands when it is
 * called; a shell that rebinds calls it again.
 */
public class ScreenTransport internal constructor(
    private val core: () -> CentraidCore?,
    private val scope: CoroutineScope,
) {
    /**
     * Send one encoded `Request`; [done] gets the encoded `Response`, or null
     * when the core refused, is closed, or there is no core. It is called once.
     */
    public fun call(request: ByteArray, done: (ByteArray?) -> Unit) {
        scope.launch {
            val answer = core()?.let { open ->
                val decoded = runCatching { Request.ADAPTER.decode(request) }.getOrNull()
                    ?: return@let null
                (open.call(Envelope(request_id = 0, request = decoded)) as? CoreOutcome.Answered)
                    ?.value?.response?.encode()
            }
            done(answer)
        }
    }

    /** Each `ScreenUpdate` the core pushes, encoded, until the session ends. */
    public fun observe(onUpdate: (ByteArray) -> Unit): Job = scope.launch {
        core()?.events?.collect { event -> event.screen?.let { onUpdate(it.encode()) } }
    }
}
