package dev.centraid.shared

import centraid.screen.v1.PhotosGridEvent
import dev.centraid.core.PairingRecord
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.shell.Enrolments
import dev.centraid.shared.shell.StageReport
import dev.centraid.shared.shell.SyncOutcome
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.test.runTest

/**
 * THE THREE JOINS #1025 S7 ADDS TO THIS SHELL, each one a half that had no
 * other.
 *
 * 1. **A pairing survives a first copy that did not land.** Before the copy
 *    there is no replica to write the record into, so the shell keeps it, and a
 *    shell that did not would leave a burned ticket and a member minting
 *    another for no reason.
 * 2. **Files landing move the grid.** Nineteen photographs arrived on a device
 *    and nothing on the screen moved: no ROW changed, so no change event fired,
 *    and the member read "not on this device yet" over a device that had them.
 * 3. **"Paired, no file yet" is a sentence.** It used to read "Synced: 0
 *    changes, 0 files", which is the sentence that makes a working device look
 *    broken.
 */
class PendingWriteSpec : StringSpec({

    "an enrolment is kept before there is a replica to write it into" {
        runTest {
            val services = FakePlatformServices()
            // THE IDENTITY IS MINTED FIRST, under the pairing name, because
            // until the answer comes back this device does not know what vault
            // it is pairing with. Its relay url is NULL and not empty: "not
            // told" leaves relay mode on, where "" would state a LAN-only
            // deployment and turn it off before this device knows which it is.
            val minted = Enrolments.minted(services)
            minted.secret.length shouldBe Enrolments.SECRET_BYTES * 2
            minted.relayUrl.shouldBeNull()
            // MINTING IS IDEMPOTENT. A second call that minted again would
            // enrol this device under a key it no longer has.
            Enrolments.minted(services).secret shouldBe minted.secret

            val answered = PairingRecord(
                gatewayAddress = "ab".repeat(32),
                vaultId = "vault-1",
                vaultName = "Tahoe",
                relayUrl = "",
                directAddrs = listOf("192.168.1.8:41234"),
                enrolledPublicKey = "ef".repeat(32),
            )
            // ONE RENAME. The secret comes across with the address, the relay
            // statement and the key the gateway said it enrolled — it was three
            // entries settled one at a time, and three renames is three chances
            // to settle by halves.
            Enrolments.settle(services, "vault-1", answered)
            val settled = Enrolments.of(services, "vault-1").shouldNotBeNull()
            settled.secret shouldBe minted.secret
            settled.gatewayAddress shouldBe answered.gatewayAddress
            settled.enrolledPublicKey shouldBe answered.enrolledPublicKey
            settled.relayUrl shouldBe ""
            settled.directAddrs shouldBe listOf("192.168.1.8:41234")
            Enrolments.of(services, Enrolments.PAIRING).shouldBeNull()
        }
    }

    "the destination is overwritten, because the gateway enrolled the new key" {
        runTest {
            // The predecessor refused to overwrite, reasoning that re-pairing
            // must not replace the key a device is already enrolled under. By
            // the time settle runs the ticket is burned and the gateway has
            // enrolled the NEW key: keeping the old one files a credential the
            // gateway no longer knows and throws away the one it does.
            val services = FakePlatformServices()
            Enrolments.keep(
                services,
                "vault-1",
                PairingRecord(secret = "00".repeat(32), gatewayAddress = "ab".repeat(32), vaultId = "vault-1", vaultName = "Old"),
            )
            val minted = Enrolments.minted(services)
            Enrolments.settle(
                services,
                "vault-1",
                PairingRecord(gatewayAddress = "cd".repeat(32), vaultId = "vault-1", vaultName = "New"),
            )
            Enrolments.of(services, "vault-1").shouldNotBeNull().secret shouldBe minted.secret
        }
    }

    "a record with neither an identity nor a gateway is no record" {
        runTest {
            val services = FakePlatformServices()
            val field = "\u001f"
            services.secureStore.write(
                "enrolment.vault-1",
                listOf("", "", "vault-1", "Tahoe", "", "", "").joinToString(field),
            )
            Enrolments.of(services, "vault-1").shouldBeNull()
        }
    }

    "a hint list survives the round trip, including an empty one" {
        runTest {
            val services = FakePlatformServices()
            val lanOnly = PairingRecord(
                secret = "aa".repeat(32),
                gatewayAddress = "cd".repeat(32),
                vaultId = "vault-2",
                vaultName = "Family",
                relayUrl = "",
            )
            Enrolments.keep(services, "vault-2", lanOnly)
            Enrolments.of(services, "vault-2") shouldBe lanOnly
        }
    }

    "\"not told\" and \"no relay\" are different states" {
        runTest {
            // Two states in one string field, and collapsing them is wrong in
            // both directions: "empty means LAN-only" turns every pre-pairing
            // endpoint into one that cannot reach a relay; "empty means
            // unknown" leaves a phone on a LAN-only gateway waiting on a relay
            // probe before every dial.
            val services = FakePlatformServices()
            val untold = PairingRecord(secret = "bb".repeat(32), gatewayAddress = "", vaultId = "", vaultName = "")
            Enrolments.keep(services, "a", untold)
            Enrolments.of(services, "a").shouldNotBeNull().relayUrl.shouldBeNull()

            val stated = untold.copy(gatewayAddress = "cd".repeat(32), relayUrl = "")
            Enrolments.keep(services, "b", stated)
            Enrolments.of(services, "b").shouldNotBeNull().relayUrl shouldBe ""
        }
    }

    "files landing are a row change on the assets that own them" {
        // A LANDED BYTE IS A ROW (D-1025-S7-20). The core names `media_asset`
        // and carries ASSET ids, because the seat does the join from hash back
        // to row — so this is the grid's ordinary `RowsChanged` and there is no
        // second event kind. It used to name `core_content_item` and carry
        // content ids, which matched nothing the grid was showing; the only
        // honest reduction was "re-read everything", and that is what the
        // deleted `BytesArrived` case was.
        val event: PhotosGridEvent? = PhotosGridMachine.rowsChanged(
            table = "media_asset",
            keys = listOf("a-1", "a-2"),
            commitSeq = 0uL,
        )
        event.shouldNotBeNull()
        event.rows_changed.shouldNotBeNull()
        event.rows_changed!!.asset_ids shouldBe listOf("a-1", "a-2")
        // AND A TABLE THIS SCREEN DOES NOT READ IS NOT ITS EVENT — including
        // the one the byte plane used to name.
        PhotosGridMachine.rowsChanged("core_content_item", listOf("c-1"), 0uL).shouldBeNull()
        PhotosGridMachine.rowsChanged("knowledge_note", listOf("n-1"), 0uL).shouldBeNull()
    }

    "a pass that is still copying the vault says so" {
        // Not "Synced: 0 changes, 0 files". A device that has no vault yet has
        // nothing else to report, and narrating the zero is what made a working
        // first run look like a broken one.
        val copying = SyncOutcome(
            bootstrap = StageReport(state = "cut"),
            copyFetched = 1_200_000,
            copyTotal = 4_800_000,
        )
        copying.copying.shouldNotBeNull()
        copying.copying!! shouldContain "25%"

        // AND A PASS THAT DID NOT BOOTSTRAP SAYS NOTHING. `already-held` is the
        // ordinary answer on every pass but the first, and a status line that
        // narrated health is noise a member learns to ignore.
        SyncOutcome(bootstrap = StageReport(state = "skipped", reason = "already-held"))
            .copying
            .shouldBeNull()
    }
})
