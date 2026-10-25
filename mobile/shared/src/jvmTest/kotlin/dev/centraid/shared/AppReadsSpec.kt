package dev.centraid.shared

import centraid.core.v1.AppQueryResponse
import centraid.core.v1.ErrorCode
import centraid.core.v1.PageCursor
import centraid.screen.v1.ReadFailureKind
import dev.centraid.core.CoreFailure
import dev.centraid.shared.sync.ScreenRuntime
import dev.centraid.shared.sync.fromCore
import dev.centraid.shared.sync.sentenceFor
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/**
 * THE KMP READ RUNTIME'S DATA: the cursor pair and the sentence a refusal becomes
 * (#1025 S5, lane L5; #1135). Which tables a screen re-reads on is no longer a
 * hand-written list: every `load` records the tables it read, and
 * `shell_home.rs`'s "reads again when a table a tile read moves" holds Home to it.
 *
 * The three app screens' reads (#1025 S5, lane L5).
 *
 * Everything here runs on the JVM with no ABI, because everything here is the
 * part of a read that is DATA: the statement, the projection off a `Row`, and
 * the sentence a refusal becomes. What needs a real vault — that the door
 * answers this statement at all — is the device contract's job, and a test that
 * mocked a core to assert a mock's answer would prove only that the mock was
 * written to match.
 */
class AppReadsSpec : StringSpec({

    "the cursor pair survives the one string a screen carries" {
        // `PageCursor` IS A PAIR and `next_cursor` is one string, so the two
        // halves are spelled with a separator. A cursor that did not round-trip
        // would be a second page that silently repeats the first.
        //
        // The separator is `|`, the runtime's own spelling.
        val cursor = PageCursor(sort_key = "2026-02-03", pk = "exp-1")
        ScreenRuntime.encodeCursor(cursor) shouldBe "2026-02-03|exp-1"
        ScreenRuntime.decodeCursor(ScreenRuntime.encodeCursor(cursor)) shouldBe cursor
        // THE FIRST PAGE IS `null`, not "start from zero" — for a pruned feed
        // those are different requests.
        ScreenRuntime.decodeCursor(null) shouldBe null
        // A STRING THIS RUNTIME DID NOT WRITE IS NOT A CURSOR. Dropped rather
        // than split at a guess, which starts the walk again instead of paging
        // under a mangled key.
        ScreenRuntime.decodeCursor("not-a-cursor") shouldBe null
    }

    "every refusal reaches a member as a sentence and never as a detail" {
        // ONE MAPPING, SHARED. This is the function `ScreenRuntime` uses; a second copy would answer "what does a
        // member read when a read is refused" differently depending on which
        // screen they were on, and nothing would fail.
        ErrorCode.values().forEach { code ->
            withClue(code.name) { sentenceFor(code).sentence.isNotEmpty() shouldBe true }
        }
        sentenceFor(ErrorCode.ERROR_CODE_UNAUTHORIZED).kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_REFUSED
        // AN UNREACHABLE GATEWAY IS UNAVAILABLE AND NOT REFUSED: one is waited
        // out and the other is not, and the remedy differs.
        sentenceFor(ErrorCode.ERROR_CODE_PEER_UNREACHABLE).kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_UNAVAILABLE
        sentenceFor(ErrorCode.ERROR_CODE_TIMEOUT).kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_UNAVAILABLE
        sentenceFor(ErrorCode.ERROR_CODE_VERSION_WINDOW).remedy shouldBe "Update Centraid."
    }

    "a closed core is a restart, and it keeps the words the core wrote" {
        // EVERY `CoreFailure` ALREADY CARRIES A SENTENCE, written for a member
        // by the layer that refused. This maps the KIND and keeps the words;
        // re-writing them would be a second vocabulary for one refusal.
        val closed = CoreFailure.Closed
        val mapped = fromCore(closed)
        mapped.kind shouldBe ReadFailureKind.READ_FAILURE_KIND_CORE_RESTARTED
        mapped.sentence shouldBe closed.sentence
    }
})
