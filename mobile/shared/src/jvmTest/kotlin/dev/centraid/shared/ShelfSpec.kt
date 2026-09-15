package dev.centraid.shared

import centraid.screen.v1.VaultLockup
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.shell.StageReport
import dev.centraid.shared.shell.SyncOutcome
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/**
 * A VAULT'S STATE IS DERIVED, NEVER STORED (#1025 S7-9).
 *
 * The enum this replaced had five cases and was a FIELD on [dev.centraid.shared.shell.HomeSession],
 * moved by hand in two places. It went wrong the way a stored derivation always
 * does: `VaultRoster.survey` set it from the pairing store at launch, `syncNow`
 * set it from a pass afterwards, and the two could not agree — a vault that had
 * synced and then been listed again read "paired", a vault admitted after
 * launch was never listed at all, and a vault nobody had run a pass against
 * claimed whatever the survey guessed.
 *
 * [Shelf.Holding.state] is a function of the last [SyncOutcome] and whether a
 * pass is in flight, and there is nowhere else for it to come from. These are
 * the cases, one assertion each, because the ORDER of the three branches is the
 * whole definition and a table read in a different order answers differently.
 *
 * **This spec did not run on the machine that wrote it.** `:shared:jvmTest`
 * needs JDK 21 and that host had only 17; CI's lane is the gate. It is here
 * rather than absent because a derivation with no table is a derivation nobody
 * can check.
 */
class ShelfSpec : StringSpec({

    fun holding(
        outcome: SyncOutcome? = null,
        passInFlight: Boolean = false,
        tailing: Boolean = false,
    ) = Shelf.Holding(
        vaultId = "v1",
        path = "/replicas/centraid-replica-v1.sqlite3",
        name = "Tahoe Demo",
        outcome = outcome,
        passInFlight = passInFlight,
        tailing = tailing,
    )

    "a holding no pass has ever reported on is SYNCING, not online" {
        // The honest answer over a vault nothing has asked about is that
        // Centraid is working on it. Claiming "synced" here is exactly the
        // guess that put "not connected to a gateway" over a synced device for
        // two waves — a default standing in for a measurement.
        holding().state shouldBe VaultLockup.State.STATE_SYNCING
    }

    "a pass IN FLIGHT is SYNCING, whatever the last one said" {
        // First branch, and first for a reason: a vault that went offline an
        // hour ago and is being retried right now is syncing. A member watching
        // the header while they tap `Sync now` must see it move.
        holding(
            outcome = SyncOutcome(unreachable = true),
            passInFlight = true,
        ).state shouldBe VaultLockup.State.STATE_SYNCING
    }

    "a copy that has not fully landed is SYNCING, which is what `paired` used to mean" {
        // "PAIRED, NO FILE YET" IS THIS (D-1025-S7-6). A gateway is reachable
        // long enough to redeem a ticket and not long enough to move a 300 MB
        // artifact, which is most of a first run on a phone that walks out of
        // the room. The pass REACHED the gateway — `unreachable` is false — and
        // the vault is still not readable, so "online" would be true about the
        // network and wrong about the product.
        holding(
            outcome = SyncOutcome(
                unreachable = false,
                bootstrap = StageReport(state = "moved"),
                copyFetched = 40,
                copyTotal = 100,
            ),
        ).state shouldBe VaultLockup.State.STATE_SYNCING
    }

    "a copy that DID fully land is ONLINE" {
        holding(
            outcome = SyncOutcome(
                unreachable = false,
                bootstrap = StageReport(state = "moved"),
                copyFetched = 100,
                copyTotal = 100,
            ),
        ).state shouldBe VaultLockup.State.STATE_ONLINE
    }

    "a pass that did not reach the gateway is OFFLINE" {
        // A phone in a lift is not a broken phone: the copy still reads, writes
        // still queue, and the next window continues from here.
        holding(outcome = SyncOutcome(unreachable = true)).state shouldBe
            VaultLockup.State.STATE_OFFLINE
    }

    "a just-recorded unreachable outranks a marked-but-not-receiving tail" {
        // R-SHELL-1 / trap unreachable-vault (#1025 live-shell). openTail marks
        // `tailing` true when the stream is ASKED FOR, before any byte arrives.
        // That mark must not promote a holding whose last pass (or dead tail)
        // already said unreachable into STATE_ONLINE — the header would keep
        // reading "synced" over a gateway that is down.
        holding(
            outcome = SyncOutcome(unreachable = true),
            tailing = true,
        ).state shouldBe VaultLockup.State.STATE_OFFLINE
    }

    "a live tail over a reachable last pass is ONLINE" {
        // The healthy foreground case: catch-up reported, then the stream is
        // held open. Quiet vaults move nothing for hours and are not offline.
        holding(
            outcome = SyncOutcome(unreachable = false, rowsApplied = 3),
            tailing = true,
        ).state shouldBe VaultLockup.State.STATE_ONLINE
    }

    "an ordinary pass on a vault already holding its copy is ONLINE" {
        // The bootstrap stage does not RUN on any pass but the first — the core
        // answers `already-held` — so the copy counts are zero and must not be
        // read as "0 of 0 fetched, therefore still copying". `bootstrap.ran` is
        // the guard, and this is the case that would break if it were dropped.
        holding(
            outcome = SyncOutcome(unreachable = false, rowsApplied = 12),
        ).state shouldBe VaultLockup.State.STATE_ONLINE
    }

    "behind N is a MODIFIER and not a fourth state" {
        // A vault that reached its gateway and has entries still to apply is
        // online and busy. The `Link` enum had no way to say that and the
        // temptation was a sixth case; what a member needs is the number,
        // beside a state that is already true.
        holding(
            outcome = SyncOutcome(unreachable = false, behind = 42),
        ).state shouldBe VaultLockup.State.STATE_ONLINE
    }

    "the lockup carries the vault's OWN name, and the derived state with it" {
        // One value rendered twice: the switcher's row and the header's second
        // line are the same `VaultLockup`, which is what stops them disagreeing.
        // The name is the replica's `core_vault.display_name` and never the
        // ticket's — a gateway mints its ticket with its `--vault-name` flag,
        // which said "Centraid" over a vault called "Tahoe Demo".
        val lockup = holding(outcome = SyncOutcome(unreachable = true)).lockup()
        lockup.vault_id shouldBe "v1"
        lockup.vault_name shouldBe "Tahoe Demo"
        lockup.state shouldBe VaultLockup.State.STATE_OFFLINE
    }

    "a holding whose core is closed is RESTING, and that is a per-vault state" {
        // THERE IS NO CAP ON OPEN CORES ANY MORE (#1025 S7-13, ruling F).
        // `Shelf.OPEN_CORES = 1` cited R-1020-24, and the citation was the
        // whole argument: R-1020-24 is that app extensions never open the
        // vault, whose hazard is two handles on ONE FILE. Two handles on two
        // vaults share no file, no outbox and no endpoint.
        //
        // What bounds the open cores is not a number but an event — the OS
        // asking for memory back, `Shelf.rest` — and the state it produces is
        // per holding. A number would make "is this vault open" depend on how
        // recently some OTHER vault was touched.
        holding().resting shouldBe true
    }
})
