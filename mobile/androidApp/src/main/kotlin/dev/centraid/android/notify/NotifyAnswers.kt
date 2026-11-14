package dev.centraid.android.notify

import centraid.core.v1.NotificationAnswered
import centraid.core.v1.NotificationVerb
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred

/** Receiver lifetime bookkeeping only; the durable outbox remains authoritative after expiry. */
internal class NotifyAnswers {
    data class Key(val id: String, val verb: NotificationVerb, val pressId: String)
    data class Held(val key: Key, val done: CompletableDeferred<Unit>, val owner: Boolean)
    private val pending = ConcurrentHashMap<Key, CompletableDeferred<Unit>>()

    fun hold(answer: NotificationAnswered): Held {
        val key = Key(answer.notification_id, answer.verb, answer.press_id)
        val created = CompletableDeferred<Unit>()
        val before = pending.putIfAbsent(key, created)
        return Held(key, before ?: created, before == null)
    }

    fun complete(answer: NotificationAnswered) {
        pending.remove(Key(answer.notification_id, answer.verb, answer.press_id))?.complete(Unit)
    }

    fun release(held: Held) {
        if (held.owner) pending.remove(held.key, held.done)
    }
}
