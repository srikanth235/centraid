package dev.centraid.shared

import centraid.core.v1.AgendaEvent
import centraid.core.v1.AgendaUpcoming
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandOutcome
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Page
import centraid.core.v1.Response
import centraid.core.v1.Row
import centraid.core.v1.Value
import dev.centraid.core.CentraidCore
import kotlinx.coroutines.Dispatchers
import okio.ByteString.Companion.encodeUtf8

/**
 * A CORE THAT ANSWERS WHAT A SPEC SCRIPTS: the page reads a store makes (by their `name`, with the
 * bound values), the agenda's upcoming read, and every command (recorded, executed unless
 * [refuses] says otherwise). The stores' own logic is then run for real, over a scripted vault.
 */
internal class ScriptedCore {
    /** Every command run, in order: its name and its input JSON. */
    val commands = mutableListOf<Pair<String, String>>()

    /** The rows a page read named `name` answers, given the text values bound to it. */
    var pages: (name: String, bound: List<String>) -> List<List<String>> = { _, _ -> emptyList() }

    /** The events `agenda_upcoming` answers, or null for a read that fails. */
    var upcoming: List<AgendaEvent>? = emptyList()

    /** Commands to refuse, by name. */
    var refuses: (String) -> Boolean = { false }

    fun core(): CentraidCore = CentraidCore.answering(Dispatchers.Unconfined) { envelope ->
        val request = envelope.request!!
        val response = when {
            request.page != null -> {
                val query = request.page!!.query!!
                val rows = pages(query.name, query.bind.map { it.text.orEmpty() })
                Response(page = Page(rows = rows.map { row -> Row(values = row.map { Value(text = it) }) }))
            }
            request.command != null -> {
                val command = request.command!!
                commands += command.name to command.input.utf8()
                val status = if (refuses(command.name)) CommandStatus.COMMAND_STATUS_FAILED else CommandStatus.COMMAND_STATUS_EXECUTED
                Response(command = CommandOutcome(status = status, output = "{\"event_id\":\"e\"}".encodeUtf8()))
            }
            request.app_query?.agenda_upcoming != null ->
                upcoming?.let { Response(app_query = AppQueryResponse(agenda_upcoming = AgendaUpcoming(events = it))) } ?: Response()
            else -> Response()
        }
        Envelope(request_id = 0, response = response)
    }
}
