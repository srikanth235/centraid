package dev.centraid.core

import centraid.core.v1.ChatAppend
import centraid.core.v1.ChatMessage
import centraid.core.v1.ChatState
import centraid.core.v1.ViewDelta
import centraid.core.v1.ViewState
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * EVERY STORE APPLIES A STREAMING ANSWER'S DELTAS THE SAME WAY (#1188 C14): the cases are the
 * shared fixture Rust's `chat::delta` and the iOS store read too.
 */
class ViewDeltaSpec : StringSpec({
    "the shared fixture's deltas, applied in order, reproduce the state" {
        val text = File("../fixtures/chat-deltas.txt").readText().lines().filterNot { it.startsWith("# ") }.joinToString("\n")
        val cases = text.split("\n====\n")
        (cases.size >= 4) shouldBe true
        fun field(case: String, key: String) = case.lines().firstOrNull { it.startsWith(key) }?.removePrefix(key)?.trim().orEmpty()
        for (case in cases) {
            val name = field(case, "name:")
            val messages = field(case, "messages:").split(";").filter { it.isNotEmpty() }.map {
                ChatMessage(id = it.substringBefore("=").toLong(), text = it.substringAfter("="))
            }
            var view = ViewState(
                instance = 1,
                revision = field(case, "revision:").toLong(),
                chat = ChatState(messages = messages, activity = field(case, "activity:")),
            )
            val deltas = case.substringAfter("--- deltas\n").substringBefore("\n--- expect")
            for (line in deltas.lines()) {
                val parts = line.split("|", limit = 5)
                val delta = ViewDelta(
                    instance = 1,
                    base = parts[0].toLong(),
                    revision = parts[1].toLong(),
                    chat_append = ChatAppend(message_id = parts[2].toLong(), activity = parts[3], text = parts[4]),
                )
                view = view.withDelta(delta) ?: view
            }
            val expect = case.substringAfter("--- expect\n")
            field(expect, "revision:") shouldBe view.revision.toString()
            field(expect, "activity:") shouldBe view.chat!!.activity
            field(expect, "messages:") shouldBe view.chat!!.messages.joinToString(";") { "${it.id}=${it.text}" }
        }
    }
})
