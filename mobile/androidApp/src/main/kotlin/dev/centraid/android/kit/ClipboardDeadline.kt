package dev.centraid.android.kit

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import java.security.MessageDigest

/**
 * A SECRET ON THE CLIPBOARD HAS A DEADLINE THAT OUTLIVES THE PROCESS (#1135).
 *
 * Rust's timer clears a copied secret, but a timer dies with its screen and with the
 * process: a revealed password stayed on the clipboard when the app was killed before it
 * fired. `ClipboardSet.clear_after_ms` makes the deadline part of the effect, so this keeps
 * it: [armed] writes the deadline and a digest of the text (never the text) beside the clip
 * and schedules the clear while the process lives, and [sweep] — run on every launch — clears
 * a clip whose deadline passed while we were not running. Only the clip we put there is
 * cleared: a later copy of anything else has a different digest.
 */
internal object ClipboardDeadline {
    private const val PREFS = "centraid.clipboard"
    private const val DEADLINE = "deadline_ms"
    private const val DIGEST = "digest"

    private val main = Handler(Looper.getMainLooper())

    /** The shell set a sensitive clip that must be gone in [afterMs] (0 keeps it). */
    fun armed(context: Context, text: String, afterMs: Long) {
        if (afterMs <= 0L) return
        val deadline = System.currentTimeMillis() + afterMs
        prefs(context).edit().putLong(DEADLINE, deadline).putString(DIGEST, digest(text)).apply()
        main.removeCallbacksAndMessages(TOKEN)
        main.postAtTime({ sweep(context) }, TOKEN, android.os.SystemClock.uptimeMillis() + afterMs)
    }

    /** The clip was cleared by the Rust timer (or replaced): the deadline is spent. */
    fun spent(context: Context) {
        prefs(context).edit().clear().apply()
        main.removeCallbacksAndMessages(TOKEN)
    }

    /** Clear a stale clip: the deadline passed and the clipboard still holds what we put there. */
    fun sweep(context: Context) {
        val saved = prefs(context)
        val deadline = saved.getLong(DEADLINE, 0L)
        val digest = saved.getString(DIGEST, null)
        if (deadline == 0L || digest == null) return
        if (System.currentTimeMillis() < deadline) {
            val left = deadline - System.currentTimeMillis()
            main.removeCallbacksAndMessages(TOKEN)
            main.postAtTime({ sweep(context) }, TOKEN, android.os.SystemClock.uptimeMillis() + left)
            return
        }
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val held = manager.primaryClip?.getItemAt(0)?.text?.toString()
        if (held != null && digest(held) == digest) {
            manager.setPrimaryClip(ClipData.newPlainText("", ""))
        }
        spent(context)
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun digest(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

    private val TOKEN = Any()
}
