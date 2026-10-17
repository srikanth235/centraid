package dev.centraid.core

import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.types.shouldBeInstanceOf
import java.io.File

/**
 * `requireDigest` IS A PORT OF `require_digest`, AND THIS IS WHAT HOLDS THEM TOGETHER.
 *
 * `ArtifactIdentity.kt` says the Kotlin body is a port rather than a call,
 * because it runs before the first `call` completes and cannot be a round trip
 * to the thing it is deciding whether to trust. A port is a second copy of a
 * decision, and two copies drift: the Rust side could stop refusing an empty
 * expectation and this one would go on doing it, or the reverse, with nothing
 * red either way.
 *
 * Two halves. The Kotlin half walks the same four cases `crates/core/src/
 * identity.rs`'s unit tests walk. The tie reads that Rust SOURCE and asserts it
 * still says what the port says — the `dev` marker and the three sentences a
 * member or a log reader sees — so a change to either body that is not made to
 * the other fails here, in whichever language moved.
 */
class RequireDigestMatchesRustSpec : StringSpec({

    val rust = File(
        System.getProperty("centraid.core.identitySource")
            ?: error("centraid.core.identitySource is unset; see mobile/core/build.gradle.kts"),
    ).also { withClue("crates/core/src/identity.rs") { it.isFile.shouldBeTrue() } }.readText()

    fun released(digest: String): ArtifactIdentity =
        ArtifactIdentity(gitSha = "a1b2c3d4", digest = digest, schemaVersion = 11)

    "a mismatched digest is refused, and both digests are named" {
        val verdict = requireDigest("bbbb2222", released("aaaa1111")).shouldBeInstanceOf<IdentityVerdict.Stale>()
        verdict.failure.detail shouldContain "STALE CORE REFUSED"
        verdict.failure.detail shouldContain "aaaa1111"
        verdict.failure.detail shouldContain "bbbb2222"
    }

    "a matching digest passes quietly" {
        requireDigest("aaaa1111", released("aaaa1111")) shouldBe IdentityVerdict.Matched
    }

    "an empty expectation is refused rather than treated as a match" {
        listOf("", "   ").forEach { empty ->
            val verdict = requireDigest(empty, released("aaaa1111")).shouldBeInstanceOf<IdentityVerdict.Stale>()
            verdict.failure.detail shouldContain "no expected digest"
        }
    }

    "a development build on either side is allowed, loudly" {
        requireDigest("aaaa1111", released(ArtifactIdentity.DEV))
            .shouldBeInstanceOf<IdentityVerdict.NotChecked>().warning shouldContain "NOT CHECKED"
        requireDigest(ArtifactIdentity.DEV, released("aaaa1111"))
            .shouldBeInstanceOf<IdentityVerdict.NotChecked>().warning shouldContain "NOT CHECKED"
    }

    "the Rust body still says what this port says" {
        // The marker, spelled the same.
        rust shouldContain "pub const DEV: &str = \"${ArtifactIdentity.DEV}\";"
        // The sentences, each of which a reader of a crash report greps for. The
        // Rust strings are wrapped across lines with a trailing backslash, so
        // each is checked by a fragment that sits on one line.
        listOf(
            "no expected digest",
            "NOT CHECKED",
            "STALE CORE REFUSED",
            "A released shell never reaches this branch.",
        ).forEach { sentence ->
            withClue("crates/core/src/identity.rs no longer says \"$sentence\"") { rust shouldContain sentence }
        }
        // And the decision is still three-way, in the order the port takes it:
        // empty, then dev, then equal.
        val body = rust.substringAfter("pub fn require_digest(")
        val order = listOf("expected.trim().is_empty()", "expected == DEV || identity.is_dev()", "expected == identity.digest")
        order.map { body.indexOf(it) }.let { indices ->
            withClue("require_digest's checks, in order: $order") {
                indices.all { it >= 0 }.shouldBeTrue()
                indices shouldBe indices.sorted()
            }
        }
    }
})
