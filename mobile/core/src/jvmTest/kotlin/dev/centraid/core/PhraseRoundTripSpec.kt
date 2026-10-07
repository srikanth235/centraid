package dev.centraid.core

import centraid.core.v1.Envelope
import centraid.core.v1.ErrorCode
import centraid.core.v1.PhraseCheck
import centraid.core.v1.PhraseChecked
import centraid.core.v1.PhraseMint
import centraid.core.v1.PhraseRequest
import centraid.core.v1.PhraseSeed
import centraid.core.v1.Request
import dev.centraid.core.AbiRoundTripSpec.Companion.openRealCore
import dev.centraid.core.AbiRoundTripSpec.Companion.shouldBeAnsweredWith
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf

/**
 * THE 24 WORDS, KOTLIN TO RUST AND BACK (#1047 E1).
 *
 * Over JNA, against the real `libcentraid_core_ffi` — the shell has no BIP39,
 * so what it relies on is that the core mints, judges and seeds, and that a
 * refused seed reaches this binding as a REFUSAL with its code rather than as
 * the "impossible argument" line `BAD_ARGUMENT` used to be read as.
 */
class PhraseRoundTripSpec : StringSpec({

    fun phrase(request: PhraseRequest) = Envelope(request_id = 0, request = Request(phrase = request))

    "minted words check valid and seed to the 64 bytes the synchronised store keeps" {
        val core = openRealCore()
        try {
            var words = emptyList<String>()
            core.call(phrase(PhraseRequest(mint = PhraseMint()))).shouldBeAnsweredWith {
                words = it.response!!.phrase!!.minted!!.words
            }
            words.size shouldBe 24
            core.call(phrase(PhraseRequest(check = PhraseCheck(words = words)))).shouldBeAnsweredWith {
                it.response!!.phrase!!.checked!!.verdict shouldBe PhraseChecked.Verdict.VERDICT_VALID
            }
            core.call(phrase(PhraseRequest(seed = PhraseSeed(words = words)))).shouldBeAnsweredWith {
                it.response!!.phrase!!.seeded!!.seed.size shouldBe 64
            }
        } finally {
            core.close()
        }
    }

    "a phrase that is not one is a REFUSAL with its code, decoded off BAD_ARGUMENT, naming no word" {
        val core = openRealCore()
        try {
            val swapped = List(23) { "abandon" } + "zoo"
            val outcome = core.call(phrase(PhraseRequest(seed = PhraseSeed(words = swapped))))
            outcome.shouldBeInstanceOf<CoreOutcome.Failed>()
            val refused = outcome.failure.shouldBeInstanceOf<CoreFailure.Refused>()
            refused.code shouldBe ErrorCode.ERROR_CODE_INVALID_REQUEST.value
            refused.detail shouldNotContain "abandon"
            refused.detail shouldNotContain "zoo"
        } finally {
            core.close()
        }
    }
})
