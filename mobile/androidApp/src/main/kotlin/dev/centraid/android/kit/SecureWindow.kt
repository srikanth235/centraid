package dev.centraid.android.kit

import android.view.Window
import android.view.WindowManager
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect

/**
 * THE ACTIVITY'S WINDOW SHIELDED WHILE A VIEW SAYS `secure` (#1047 E3): screenshots, screen
 * recording and the recents thumbnail are blank while [secure] holds, and the flag is cleared as
 * soon as it does not. Whether a view is secure is Rust's (the words, an unlocked Locker).
 */
@Composable
internal fun SecureWindow(secure: Boolean) {
    val activity = LocalActivity.current ?: return
    DisposableEffect(activity, secure) {
        if (secure) SecureHolds.take(activity.window)
        onDispose {
            if (secure) SecureHolds.release(activity.window)
        }
    }
}

/**
 * Who holds `FLAG_SECURE` on which window, COUNTED, because two holders may hold it at once (an
 * unlocked Locker under the words, a `ScreenshotShield` effect): the flag is cleared only when the
 * last one lets go. Main thread only.
 */
internal object SecureHolds {
    private val holds = java.util.WeakHashMap<Window, Int>()

    fun take(window: Window) {
        val count = holds[window] ?: 0
        holds[window] = count + 1
        if (count == 0) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    fun release(window: Window) {
        val count = (holds[window] ?: 1) - 1
        if (count <= 0) {
            holds.remove(window)
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            holds[window] = count
        }
    }
}
