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
 * on the same subject is the same key, so a double tap while the first write is
 * in flight is one write ([WriteLaw.submit]); a different intent — toggling
 * back, the next edit of an editor — is a new key, so its answer is told apart
 * from the last one's. The key is the shell's CORRELATION key and nothing the
 * core or the vault remembers (no replay ledger, #1029 §1, R-1088-12): the same
 * key sent again after the first settled runs the command again.
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
 *
 * NOTHING MORE: once a write has settled it is forgotten, here as in the core
 * (R-1088-12), so a screen that stays up after a COMMITTED create or save must
 * end that sitting itself — Save not armed, the form gone — or its next tap
 * files the same thing again (#1089). The keys differ per attempt in some
 * editors (`try=N`, a token), so no key comparison in this law could do it.
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

/**
 * A JSON string literal. `commonMain` carries no JSON library; inputs are small.
 *
 * It does NOT have to be canonical: the command door canonicalises the parsed
 * value before hashing, so a shell agreeing byte-for-byte with the vault's
 * canonicaliser would be a second implementation of it.
 */
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
