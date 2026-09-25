package dev.centraid.shared

import centraid.core.v1.Error
import centraid.core.v1.ErrorCode
import centraid.core.v1.VaultMoved
import centraid.screen.v1.VaultLockup
import dev.centraid.core.CentraidCore
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.sync.movedFrom
import dev.centraid.shared.sync.rfc3339FromEpochMillis
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.Dispatchers

/**
 * THE FREEZE HAS A PRODUCER NOW (#1029 W5, hand-offs 2 and 3).
 *
 * `VaultMovedSpec` pins what the freeze DOES. This pins the two things that
 * were missing on either side of it:
 *
 * 1. **The code that starts it.** `Shelf.freeze` had no caller that could
 *    exist: `error.proto` carried no `ERROR_CODE_VAULT_MOVED`, and the mobile
 *    lane refused to invent a number rather than mint a second mechanism. The
 *    code is minted with the lease it belongs to, `lease.proto`'s `VaultMoved`
 *    rides on the refusal, and `movedFrom` is the ONE reader.
 * 2. **The slot that shows it.** `VaultLockup` had three pass-shaped states and
 *    no case for a frozen vault, so the switcher's row said "synced" over a
 *    vault refusing every write — which is the umbrella's UI invariant broken
 *    in the smallest possible way.
 */
class VaultMovedProducerSpec : StringSpec({

    // 2026-03-14T09:31:00Z, the instant `VaultMovedSpec` already uses.
    val movedAtMs = 1_773_480_660_000L

    fun refusal(
        code: ErrorCode = ErrorCode.ERROR_CODE_VAULT_MOVED,
        moved: VaultMoved? = VaultMoved(current_epoch = 7, moved_at_ms = movedAtMs),
    ) = Error(code = code, detail = "gateway: vault moved", moved = moved)

    "a VAULT_MOVED refusal becomes the two terms the freeze takes" {
        val moved = movedFrom(refusal(), unacked = 12).shouldNotBeNull()
        moved.atIso shouldBe "2026-03-14T09:31:00Z"
        moved.unacked shouldBe 12
        // AND THE LINE THE MEMBER READS FALLS OUT OF IT, unchanged: the freeze
        // takes an RFC 3339 instant and `Holding.frozenLine` takes its date
        // part, so the conversion above is the whole contract between them.
        Shelf.Holding(
            vaultId = "v1",
            path = "/vaults/v.sqlite3",
            name = "Tahoe",
            core = CentraidCore.answering(Dispatchers.Unconfined) { it },
            moved = Shelf.Moved(atIso = moved.atIso, unacked = moved.unacked),
        ).frozenLine shouldBe "12 changes since 2026-03-14"
    }

    "every other refusal is not a move" {
        // The reason this is safe to call on every failure a request produces.
        // `UNAUTHORIZED` is the near miss and the one that matters: "whoever
        // you are, not here" and "you held this vault and a higher epoch took
        // it" are different facts with different answers, and a client that
        // froze on the first would freeze a vault over a bad signature.
        movedFrom(refusal(code = ErrorCode.ERROR_CODE_UNAUTHORIZED), unacked = 3).shouldBeNull()
        movedFrom(
            refusal(code = ErrorCode.ERROR_CODE_GATEWAY_LEASE_STALE),
            unacked = 3,
        ).shouldBeNull()
    }

    "a move with no companion message is still a move" {
        // THE CODE IS THE FACT; the message is the detail. A server that sent
        // one and not the other must not be answered by a phone that goes on
        // writing — that is the single outcome this path exists to prevent.
        val moved = movedFrom(refusal(moved = null), unacked = 1).shouldNotBeNull()
        moved.atIso shouldBe "1970-01-01T00:00:00Z"
        moved.unacked shouldBe 1
    }

    "the count comes from this phone's spool and never from the refusal" {
        // The gateway cannot know what this phone has not sent it. The number
        // on the line is what this device is still holding, and a server-side
        // count would be somebody else making a claim about the member's own
        // device — which is also why `movedFrom` takes it as an argument
        // instead of reading it off `Error`.
        movedFrom(refusal(), unacked = 0).shouldNotBeNull().unacked shouldBe 0
        movedFrom(refusal(), unacked = 99).shouldNotBeNull().unacked shouldBe 99
    }

    "a frozen holding publishes the frozen state and its line, not 'synced'" {
        val core = CentraidCore.answering(Dispatchers.Unconfined) { it }
        fun holding(moved: Shelf.Moved?) = Shelf.Holding(
            vaultId = "v1",
            path = "/vaults/v.sqlite3",
            name = "Tahoe",
            core = core,
            moved = moved,
        )
        holding(null).lockup().state shouldBe VaultLockup.State.STATE_ONLINE
        holding(null).lockup().frozen_line shouldBe ""

        val frozen = holding(Shelf.Moved(atIso = "2026-03-14T09:31:00Z", unacked = 12)).lockup()
        frozen.state shouldBe VaultLockup.State.STATE_FROZEN
        frozen.frozen_line shouldBe "12 changes since 2026-03-14"
    }

    "the trimmed enum has no case for a pass that no longer happens" {
        // `STATE_SYNCING` and `STATE_OFFLINE` were both facts about a PASS, and
        // #1029 §1 deletes the pass. They are reserved by number AND by name in
        // `screen.proto`, so nothing comes back wearing either spelling; this
        // asserts what a shell can actually see.
        VaultLockup.State.entries.map { it.value }.toSet() shouldBe setOf(0, 2, 4)
        VaultLockup.State.fromValue(1).shouldBeNull()
        VaultLockup.State.fromValue(3).shouldBeNull()
    }

    "an instant is written down the same way every layer already writes one" {
        rfc3339FromEpochMillis(0) shouldBe "1970-01-01T00:00:00Z"
        // A LEAP DAY, which is the off-by-one a hand-rolled calendar produces.
        rfc3339FromEpochMillis(1_709_164_800_000) shouldBe "2024-02-29T00:00:00Z"
        // AND THE DAY AFTER IT.
        rfc3339FromEpochMillis(1_709_251_199_000) shouldBe "2024-02-29T23:59:59Z"
        // 2000 IS A LEAP YEAR and 1900 is not: the two the century rule gets
        // wrong in opposite directions.
        rfc3339FromEpochMillis(951_782_400_000) shouldBe "2000-02-29T00:00:00Z"
        rfc3339FromEpochMillis(-2_203_977_600_000) shouldBe "1900-02-28T00:00:00Z"
        rfc3339FromEpochMillis(-2_203_891_200_000) shouldBe "1900-03-01T00:00:00Z"
        // BEFORE THE EPOCH IS HANDLED RATHER THAN CLAMPED: a badly wrong clock
        // is exactly what produces one, and answering 1970-01-01 for every
        // negative instant would make a broken clock look like a missing value.
        rfc3339FromEpochMillis(-1) shouldBe "1969-12-31T23:59:59Z"
    }
})
