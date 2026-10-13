package dev.centraid.shared.kit

import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.design.copy.TasksCopy
import okio.ByteString.Companion.encodeUtf8
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * WHAT EVERY ONE-TAP IMPORT SHARES (docs/decisions.md, "Onboarding without
 * sample data", R-ONBOARD-4): one command through the command plane, and the
 * JSON string a hand-built input needs. An import writes the member's own rows
 * the way a screen does, so a row it makes is a row like any other.
 *
 * The apps' importers — Contacts → People, Calendar → Agenda, Reminders →
 * Tasks — each live in their app and call these.
 */
public object PhoneImport {
    /** What one import did: rows written, and sources the core refused. */
    public data class Outcome(
        public val added: Int,
        public val refused: Int,
    )

    /**
     * RUN ONE COMMAND, and answer whether the core executed it. **Every
     * command carries an `invoke_key`**: the core refuses one with none
     * (`api::invoke`), so the key is minted per write, here.
     */
    public suspend fun write(core: CentraidCore, command: String, input: String): Boolean =
        executed(core, command, input) != null

    /**
     * [write], answering the command's OUTPUT when the core executed it and
     * null when it did not — an import that must name the row it just made
     * (a series' `event_id`, for its exceptions) reads it here.
     */
    @OptIn(ExperimentalUuidApi::class)
    public suspend fun executed(core: CentraidCore, command: String, input: String): String? {
        val answer = core.call(
            Envelope(
                request_id = 0,
                request = Request(
                    command = Command(
                        name = command,
                        invoke_key = "import:${Uuid.random()}",
                        input = input.encodeUtf8(),
                    ),
                ),
            ),
        )
        val outcome = (answer as? CoreOutcome.Answered)?.value?.response?.command ?: return null
        return outcome.output.utf8().takeIf { outcome.status == CommandStatus.COMMAND_STATUS_EXECUTED }
    }

    /**
     * WHAT A MADE VAULT'S IMPORTS SAY, AS ONE LINE (R-ONBOARD-8): making a
     * vault brings in the photos, the contacts, the calendar and the reminders
     * one after another, and the banner says what came in — "6 people
     * imported, 12 events imported". An import with nothing to bring
     * ([quiet], the apps' `…_NONE` lines) says nothing, and a shell passes no
     * refusal at all: the member just said no, and a Settings line would
     * argue with them. Empty when nothing came in.
     */
    public fun madeSummary(outcomes: List<String>): String = outcomes
        .filter { it.isNotBlank() && it !in quiet }
        .joinToString(", ") { it.trimEnd('.') }

    private val quiet: Set<String> = setOf(
        PeopleCopy.IMPORT_CONTACTS_NONE,
        AgendaCopy.IMPORT_CALENDAR_NONE,
        TasksCopy.IMPORT_REMINDERS_NONE,
    )

    /** A JSON string literal. `commonMain` carries no JSON dependency. */
    public fun quote(value: String): String = buildString {
        append('"')
        for (character in value) {
            when {
                character == '"' -> append("\\\"")
                character == '\\' -> append("\\\\")
                character == '\n' -> append("\\n")
                character == '\r' -> append("\\r")
                character == '\t' -> append("\\t")
                character < ' ' -> append("\\u").append(character.code.toString(HEX).padStart(UNICODE_DIGITS, '0'))
                else -> append(character)
            }
        }
        append('"')
    }

    private const val HEX: Int = 16
    private const val UNICODE_DIGITS: Int = 4
}
