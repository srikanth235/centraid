package dev.centraid.android.notify

import android.content.Context
import android.content.SharedPreferences
import centraid.core.v1.NotificationAnswered
import java.util.UUID

/**
 * THE PRESSES NOT YET KNOWN TO BE APPLIED (#1188, A6): a small queue for the phone's own writer, not a
 * replica log, and nothing in it waits for a gateway.
 *
 * A button on a notification must not be lost because the core could not start in the seconds a receiver
 * is given. The press is written here BEFORE the banner is dismissed and BEFORE the session is asked for;
 * it leaves only when its exact terminal answer has been performed, and whatever remains is sent again at
 * the next start ([Notify.drain]). Each press has an id of its own that travels to Rust
 * (`NotificationAnswered.press_id`), which runs the write under a key made from it, so a press sent twice
 * is applied once. A dedicated preferences file, kept out of every backup like the notification record.
 */
internal class NotifyOutbox(private val prefs: SharedPreferences) {
    constructor(context: Context) : this(context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE))

    /** One press: the notification's id, the verb as the number it arrived as, and the press's own id. */
    data class Press(val pressId: String, val notificationId: String, val verb: Int)

    /** Write a press down, and give it its id. */
    @Synchronized
    fun add(notificationId: String, verb: Int, pressId: String = UUID.randomUUID().toString()): Press? {
        val press = Press(pressId, notificationId, verb)
        return if (prefs.edit().putString(KEY + pressId, encode(press)).commit()) press else null
    }

    /** The core has it: the press leaves. */
    @Synchronized
    private fun remove(pressId: String) {
        prefs.edit().remove(KEY + pressId).commit()
    }

    /** Only an exact terminal acknowledgement may retire a durable press. */
    @Synchronized
    fun acknowledge(answer: NotificationAnswered) {
        val press = prefs.getString(KEY + answer.press_id, null)?.let(::decode) ?: return
        if (press.notificationId == answer.notification_id && press.verb == answer.verb.value) remove(press.pressId)
    }

    /** Every press not yet known to be applied, oldest written first is not promised; ids are unique. */
    @Synchronized
    fun pending(): List<Press> =
        prefs.all.filterKeys { it.startsWith(KEY) }.values.mapNotNull { (it as? String)?.let(::decode) }

    private fun encode(press: Press): String = listOf(press.pressId, press.verb.toString(), press.notificationId).joinToString("\n")

    private fun decode(text: String): Press? {
        val parts = text.split("\n", limit = 3)
        val verb = parts.getOrNull(1)?.toIntOrNull() ?: return null
        return Press(parts[0], parts.getOrNull(2) ?: return null, verb)
    }

    private companion object {
        const val FILE: String = "centraid.notify.outbox"
        const val KEY: String = "press."
    }
}
