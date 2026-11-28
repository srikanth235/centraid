package dev.centraid.android.notify

import android.content.Context
import android.content.SharedPreferences
import centraid.core.v1.NotificationAnswered
import java.util.UUID

internal class NotifyOutbox(private val prefs: SharedPreferences) {
    constructor(context: Context) : this(context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE))

    data class Press(
        val pressId: String,
        val notificationId: String,
        val verb: Int,
        val entityId: String = "",
        val dateId: String = "",
        val fieldId: String = "",
        val atMs: Long = 0L,
    )

    @Synchronized
    fun add(
        notificationId: String,
        verb: Int,
        pressId: String = UUID.randomUUID().toString(),
        entityId: String = "",
        dateId: String = "",
        fieldId: String = "",
        atMs: Long = System.currentTimeMillis(),
    ): Press? {
        val press = Press(pressId, notificationId, verb, entityId, dateId, fieldId, atMs)
        return if (prefs.edit().putString(KEY + pressId, encode(press)).commit()) press else null
    }

    @Synchronized
    fun remove(pressId: String) {
        prefs.edit().remove(KEY + pressId).commit()
    }

    @Synchronized
    fun acknowledge(answer: NotificationAnswered) {
        val press = prefs.getString(KEY + answer.press_id, null)?.let(::decode) ?: return
        if (press.notificationId == answer.notification_id && press.verb == answer.verb.value) remove(press.pressId)
    }

    @Synchronized
    fun pending(): List<Press> =
        prefs.all.filterKeys { it.startsWith(KEY) }.values.mapNotNull { (it as? String)?.let(::decode) }

    private fun encode(press: Press): String = listOf(
        press.pressId,
        press.verb.toString(),
        press.notificationId,
        press.entityId,
        press.dateId,
        press.fieldId,
        press.atMs.toString(),
    ).joinToString("\n")

    private fun decode(text: String): Press? {
        val parts = text.split("\n")
        val verb = parts.getOrNull(1)?.toIntOrNull() ?: return null
        val notificationId = parts.getOrNull(2) ?: return null
        return Press(
            pressId = parts[0],
            notificationId = notificationId,
            verb = verb,
            entityId = parts.getOrNull(3).orEmpty(),
            dateId = parts.getOrNull(4).orEmpty(),
            fieldId = parts.getOrNull(5).orEmpty(),
            atMs = parts.getOrNull(6)?.toLongOrNull() ?: 0L,
        )
    }

    private companion object {
        const val FILE: String = "centraid.notify.outbox"
        const val KEY: String = "press."
    }
}
