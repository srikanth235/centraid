package dev.centraid.core

import centraid.core.v1.ViewDelta
import centraid.core.v1.ViewState

/**
 * A STREAMING ANSWER'S NEXT WORDS APPLIED TO THE VIEW HELD (#1188 C14). The delta is dropped (null)
 * unless it was made against the revision this view holds and the message it grows is there; the
 * next full view repairs a dropped one. Rust's `chat::delta` and the iOS store do the same, over
 * the same cases (`mobile/fixtures/chat-deltas.txt`).
 */
internal fun ViewState.withDelta(delta: ViewDelta): ViewState? {
    val add = delta.chat_append ?: return null
    val chat = this.chat ?: return null
    if (revision != delta.base) return null
    val at = chat.messages.indexOfLast { it.id == add.message_id }
    if (at < 0) return null
    val grown = chat.messages.toMutableList().also { it[at] = it[at].copy(text = it[at].text + add.text) }
    return copy(chat = chat.copy(messages = grown, activity = add.activity), revision = delta.revision)
}
