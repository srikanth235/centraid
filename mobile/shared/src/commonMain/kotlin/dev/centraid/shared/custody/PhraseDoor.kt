package dev.centraid.shared.custody

import centraid.core.v1.Envelope
import centraid.core.v1.PhraseCheck as WirePhraseCheck
import centraid.core.v1.PhraseChecked
import centraid.core.v1.PhraseMint
import centraid.core.v1.PhraseRequest
import centraid.core.v1.PhraseSeed
import centraid.core.v1.Request
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome

/**
 * THE 24 WORDS ARE RUST'S (#1047 E1, `phone.proto`'s `PhraseRequest`).
 *
 * This shell has no BIP39 — no word list, no checksum, no PBKDF2 — and must
 * not grow one: a second implementation is a second opinion about which words
 * are a member's vaults. So minting, judging and seeding are one request kind
 * on the core, and this door is the whole of what crosses.
 *
 * **Null is "the core could not be asked"**, never a verdict: a missing core,
 * a refused mint (no entropy) or a refused seed (not a phrase). The words and
 * the seed are never put in a log line, an exception message or a `toString`.
 */
public interface PhraseDoor {
    /** 24 words from the core's CSPRNG, or null. */
    public suspend fun mint(): List<String>?

    /** Each cell and the phrase judged, or null. */
    public suspend fun check(words: List<String>): PhraseVerdict?

    /** The 64-byte seed as 128 lowercase hex, or null when the words are not a phrase. */
    public suspend fun seed(words: List<String>): String?
}

/** What `check` answered. Carries the member's own typing back, so it is redacted. */
public data class PhraseVerdict(
    public val cells: List<Cell>,
    public val verdict: Verdict,
    /** 1-based; 0 for none. */
    public val firstUnknown: Int,
) {
    public data class Cell(
        public val position: Int,
        public val empty: Boolean,
        public val known: Boolean,
        public val suggestions: List<String>,
    ) {
        override fun toString(): String = "Cell($position, empty=$empty, known=$known, <redacted>)"
    }

    public enum class Verdict { INCOMPLETE, UNKNOWN_WORD, BAD_CHECKSUM, VALID, TOO_MANY }

    override fun toString(): String = "PhraseVerdict($verdict, firstUnknown=$firstUnknown)"
}

/** [PhraseDoor] over a core — any core; the requests need no vault. */
public class CorePhraseDoor(private val core: suspend () -> CentraidCore?) : PhraseDoor {

    override suspend fun mint(): List<String>? =
        ask(PhraseRequest(mint = PhraseMint()))?.minted?.words?.takeIf { it.size == WORDS }

    override suspend fun check(words: List<String>): PhraseVerdict? {
        val checked = ask(PhraseRequest(check = WirePhraseCheck(words = words)))?.checked ?: return null
        return PhraseVerdict(
            cells = checked.words.map {
                PhraseVerdict.Cell(it.position, it.empty, it.known, it.suggestions)
            },
            verdict = when (checked.verdict) {
                PhraseChecked.Verdict.VERDICT_VALID -> PhraseVerdict.Verdict.VALID
                PhraseChecked.Verdict.VERDICT_UNKNOWN_WORD -> PhraseVerdict.Verdict.UNKNOWN_WORD
                PhraseChecked.Verdict.VERDICT_BAD_CHECKSUM -> PhraseVerdict.Verdict.BAD_CHECKSUM
                PhraseChecked.Verdict.VERDICT_TOO_MANY -> PhraseVerdict.Verdict.TOO_MANY
                // UNSPECIFIED IS READ AS INCOMPLETE: a verdict this build has no
                // name for never opens the Restore button.
                else -> PhraseVerdict.Verdict.INCOMPLETE
            },
            firstUnknown = checked.first_unknown,
        )
    }

    override suspend fun seed(words: List<String>): String? =
        ask(PhraseRequest(seed = PhraseSeed(words = words)))?.seeded?.seed
            ?.takeIf { it.size == VaultSecrets.SEED_HEX_LENGTH / 2 }
            ?.hex()

    private suspend fun ask(request: PhraseRequest) =
        when (val answer = core()?.call(Envelope(request_id = 0, request = Request(phrase = request)))) {
            is CoreOutcome.Answered -> answer.value.response?.phrase
            else -> null
        }

    private companion object {
        const val WORDS: Int = 24
    }
}
