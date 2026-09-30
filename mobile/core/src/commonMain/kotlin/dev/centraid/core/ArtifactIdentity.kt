package dev.centraid.core

/**
 * The three facts a prebuilt core carries, and the refusal that reads them
 * (#1020 Artifacts, D-1020-G2; `crates/centraid/src/identity.rs`).
 *
 * The mobile shell links an AAR or an XCFramework and compiles no Rust, so it
 * cannot tell by construction that the core it loaded is the one its own build
 * expects. A stale core is the worst failure shape in the design: it starts, it
 * answers, and it answers from a schema the shell stopped speaking.
 *
 * The field names are `gitSha`, `digest`, `schemaVersion` — the same three
 * `centraid --version --json` prints, which is the contract lane G's module
 * header names for exactly this reader.
 */
public data class ArtifactIdentity(
    /** The commit. For a human reading a crash report. */
    public val gitSha: String,
    /** `cargo xtask artifact-key`'s output. This is the field the machine compares. */
    public val digest: String,
    /** The vault `user_version` this build writes. */
    public val schemaVersion: Long,
) {
    public companion object {
        /**
         * The marker a build with no release stamp carries. Not empty and not a
         * plausible hash: an empty field reads as "not checked" and a plausible
         * hash reads as a release.
         */
        public const val DEV: String = "dev"

        /** A development shell's expectation: check nothing, and say so. */
        public val development: ArtifactIdentity = ArtifactIdentity(DEV, DEV, 0)
    }

    public val isDev: Boolean get() = digest == DEV || gitSha == DEV
}

/** What [requireDigest] decided, and what it wants said out loud. */
public sealed interface IdentityVerdict {
    /** The digests matched. Nothing to say. */
    public data object Matched : IdentityVerdict

    /**
     * The check did not run because one side is a development build. **The
     * allowance is never silent**: `warning` is logged by the caller.
     */
    public data class NotChecked(val warning: String) : IdentityVerdict

    /** Refused. The shell must fail; it never warns and continues. */
    public data class Stale(val failure: CoreFailure.StaleArtifact) : IdentityVerdict
}

/**
 * The stale-artifact refusal, ported clause for clause from
 * `crates/centraid/src/identity.rs`'s `require_digest`.
 *
 * A PORT AND NOT A CALL: this runs before the first `call` completes — on iOS
 * before the framework has said anything — so it cannot be a round trip to the
 * thing it is deciding whether to trust. `RequireDigestMatchesRustSpec` in
 * `jvmTest` walks the same four cases the Rust unit tests walk, and the two
 * bodies are compared by a reader rather than by a machine, which the receipt
 * records as a risk.
 */
public fun requireDigest(expected: String, reported: ArtifactIdentity): IdentityVerdict = when {
    expected.isBlank() -> IdentityVerdict.Stale(
        CoreFailure.StaleArtifact(
            expectedDigest = "",
            reportedDigest = reported.digest,
            detail = "the shell passed no expected digest. An empty expectation is not a " +
                "match — it is a build that forgot to record which core it was built " +
                "against (#1020 Artifacts).",
        ),
    )

    expected == ArtifactIdentity.DEV || reported.isDev -> IdentityVerdict.NotChecked(
        "artifact identity NOT CHECKED: ${
            if (reported.isDev) "this core" else "the shell"
        } is a development build (expected $expected, got ${reported.digest}). A released " +
            "shell never reaches this branch.",
    )

    expected == reported.digest -> IdentityVerdict.Matched

    else -> IdentityVerdict.Stale(
        CoreFailure.StaleArtifact(
            expectedDigest = expected,
            reportedDigest = reported.digest,
            detail = "STALE CORE REFUSED: this shell was built against core digest " +
                "$expected, and the core it loaded reports ${reported.digest} " +
                "(git ${reported.gitSha}, schema ${reported.schemaVersion}). Refusing to " +
                "answer a single call: a core from another tree starts, answers, and " +
                "answers from the wrong schema (#1020 Artifacts).",
        ),
    )
}
