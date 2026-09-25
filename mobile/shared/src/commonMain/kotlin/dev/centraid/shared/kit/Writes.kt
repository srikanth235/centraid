package dev.centraid.shared.kit

import centraid.core.v1.CommandStatus
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step

/**
 * INVOKE KEYS, BUILT ONE WAY (was ~20 string concatenations).
 *
 * `command:subject:intent…`. CONTENT-DERIVED, never ordinal: the same intent
 * on the same subject is the same key, so a double tap dedups in the core;
 * a different intent — toggling back, the next edit of an editor — is a new
 * key, so it is a new command and not a replay of the last one.
 */
public object InvokeKeys {
    public fun of(command: String, subject: String, vararg intent: String): String =
        (listOf(command, subject) + intent).joinToString(SEPARATOR)

    private const val SEPARATOR: String = ":"
}

/** Where a detail screen keeps its [WriteState]. */
public interface WriteLens<S> {
    public fun write(state: S): WriteState

    public fun with(state: S, write: WriteState): S
}

/**
 * ONE WRITE IN FLIGHT, and a refused one keeps the content (the read law and
 * the write law are different laws: a failed write never replaces what the
 * member was looking at).
 */
public object WriteLaw {
    /** Submit. The same key already in flight is the same write, and nothing. */
    public fun <S> submit(l: WriteLens<S>, s: S, command: String, input: String, key: String): Step<S> {
        val write = l.write(s)
        if (write.phase == WriteState.Phase.PHASE_IN_FLIGHT && write.invoke_key == key) return Step(s)
        return Step(
            l.with(s, WriteState(phase = WriteState.Phase.PHASE_IN_FLIGHT, invoke_key = key)),
            listOf(ScreenEffect.SubmitWrite(command = command, inputJson = input, invokeKey = key)),
        )
    }

    /** An answer. One for another key is someone else's, and ignored. */
    public fun <S> settled(l: WriteLens<S>, s: S, settled: WriteSettled): Step<S> {
        val write = l.write(s)
        if (settled.invoke_key != write.invoke_key) return Step(s)
        return Step(
            l.with(
                s,
                write.copy(
                    phase = if (settled.committed) {
                        WriteState.Phase.PHASE_COMMITTED
                    } else {
                        WriteState.Phase.PHASE_REFUSED
                    },
                    failure = if (settled.committed) null else settled.failure,
                ),
            ),
        )
    }

    /**
     * The core's answer as the kit's settle. Only `EXECUTED` is committed —
     * the phone is the vault, so a write commits here or it does not. The
     * sentence is the CORE's; silence carries none (a shell never composes
     * one out of an error).
     */
    public fun settledOf(status: CommandStatus, sentence: String, invokeKey: String): WriteSettled {
        val committed = status == CommandStatus.COMMAND_STATUS_EXECUTED
        return WriteSettled(
            invoke_key = invokeKey,
            committed = committed,
            failure = if (committed) null else failureOf(sentence),
        )
    }

    private fun failureOf(sentence: String): ReadFailure? =
        sentence.takeIf { it.isNotEmpty() }?.let { Reads.refused(it) }
}

/** A JSON string literal. `commonMain` carries no JSON library; inputs are small. */
public fun jsonString(value: String): String = buildString {
    append('"')
    for (character in value) {
        when (character) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else ->
                if (character < ' ') {
                    append("\\u").append(character.code.toString(16).padStart(4, '0'))
                } else {
                    append(character)
                }
        }
    }
    append('"')
}
