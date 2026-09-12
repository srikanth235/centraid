package dev.centraid.core

/**
 * Every way a call across the ABI can fail to produce an answer, as a value.
 *
 * A SEALED HIERARCHY AND NOT AN EXCEPTION, because the three-state read law
 * (census §E seam 3) needs a refusal to be a value a screen can render. An
 * exception that crossed into a state machine would be caught by whoever
 * happened to be on the stack, and "the read failed" would arrive at the screen
 * as `null` — which is the same value as "no rows", which is the bug the law
 * exists to prevent.
 *
 * A DISCRIMINATED UNION AND NOT A BAG OF OPTIONALS, the same rule v0's
 * navigation params follow (`apps/mobile/src/navigation.ts:43`): a
 * `CoreFailure(code, message?, diagnosticId?, expected?, actual?)` would make
 * every reader ask which fields its case populated.
 */
public sealed interface CoreFailure {
    /** A sentence for a member. Never a predicate and never a pointer. */
    public val sentence: String

    /** The handle was closed on purpose. `CONTRACT.md` clause 8. */
    public data object Closed : CoreFailure {
        override val sentence: String = "Centraid stopped. Reopen the app."
    }

    /**
     * A panic was caught inside the core and the handle is poisoned.
     * `CONTRACT.md` clause 9 — the shell restarts the core deliberately rather
     * than carrying on over state nobody can vouch for.
     */
    public data class Poisoned(val diagnosticId: String) : CoreFailure {
        override val sentence: String = "Centraid hit a problem and restarted."
    }

    /** The binding handed the ABI something impossible. Always a shell bug. */
    public data class BadArgument(val detail: String) : CoreFailure {
        override val sentence: String = "Centraid could not read its own request."
    }

    /** The bytes were not a decodable envelope, in either direction. */
    public data class Malformed(val detail: String) : CoreFailure {
        override val sentence: String = "Centraid could not read the answer."
    }

    /** The core answered with an `Error` body. `detail` is the core's own. */
    public data class Refused(
        val code: Int,
        val detail: String,
        val diagnosticId: String,
        override val sentence: String,
    ) : CoreFailure

    /**
     * The core reports an artifact identity the shell was not built against.
     * See [ArtifactIdentity] for why this is a refusal and not a warning.
     */
    public data class StaleArtifact(
        val expectedDigest: String,
        val reportedDigest: String,
        val detail: String,
    ) : CoreFailure {
        override val sentence: String = "This copy of Centraid is out of step with itself."
    }

    /**
     * The native library is not on this machine. A DISTINCT case, because the
     * remedy is a build command and not a restart, and a shell that reported it
     * as "the core is closed" would send a developer looking at lifecycles.
     */
    public data class LibraryMissing(val detail: String) : CoreFailure {
        override val sentence: String = "Centraid's engine is missing from this build."
    }

    /** A status code this build does not define. See [CoreStatus.of]. */
    public data class UnknownStatus(val code: Int) : CoreFailure {
        override val sentence: String = "Centraid answered in a way this version does not know."
    }
}

/** An answer, or a refusal. Never `null` for either. */
public sealed interface CoreOutcome<out T> {
    public data class Answered<T>(val value: T) : CoreOutcome<T>

    public data class Failed(val failure: CoreFailure) : CoreOutcome<Nothing>
}

/**
 * Thrown only by the threading assertion, and only in debug builds.
 *
 * The one failure that is an exception rather than a value: a `call` on the UI
 * thread is not a condition to render, it is a line of code to delete
 * (census §E seam 10). A value here would be a value someone handles.
 */
public class UiThreadCallError(threadName: String) : IllegalStateException(
    "centraid_call was invoked on the UI thread ($threadName). `call` is synchronous and " +
        "holds a SQLite read transaction; on a device this is the freeze. Move it to " +
        "Dispatchers.IO or the core dispatcher (#1020 Execution model).",
)
