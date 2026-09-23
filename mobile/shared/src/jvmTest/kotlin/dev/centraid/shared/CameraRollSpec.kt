package dev.centraid.shared

import centraid.screen.v1.BackupState
import centraid.screen.v1.MediaPermission
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.platform.MediaLibrary
import dev.centraid.shared.platform.NetworkStatus
import dev.centraid.shared.shell.CameraRoll
import dev.centraid.shared.sync.TransferRule
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import kotlinx.coroutines.test.runTest

/**
 * THE DECISIONS A CAMERA-ROLL PASS MAKES (#1025 S6, D-1025-S7-73).
 *
 * **What this file can prove, and what it deliberately does not.**
 * `CentraidCore` is a final class over a C ABI, so the staging half of a pass —
 * `Staging.stage`, the intent, the gateway's pull — cannot be driven from a JVM
 * test without a real core. It does not need to be: that path is proved end to
 * end in Rust by `crates/centraid/tests/bytes_upward.rs`, which mints a
 * photograph on a seat and asserts the gateway holds the bytes BEFORE the
 * content row lands. Mocking it here would prove the mock.
 *
 * What is proved here is everything the pass DECIDES, which is where the
 * product-level mistakes live: who may enumerate, when an original may move,
 * what the gateway is told about the asset, and what a member is told when the
 * answer is no. Each of those was a sentence or a rule somebody could get wrong
 * without any compiler noticing.
 */
class CameraRollSpec : StringSpec({

    fun rollOf(services: FakePlatformServices) = CameraRoll(services, core = { null })

    "a limited selection is a library, not a denial" {
        val services = FakePlatformServices()
        val roll = rollOf(services)
        // LIMITED COUNTS. A backup that treated iOS's limited selection as a
        // denial would back up nothing while the member watched their own
        // chosen photographs sit there.
        roll.canEnumerate(MediaPermission.MEDIA_PERMISSION_LIMITED) shouldBe true
        roll.canEnumerate(MediaPermission.MEDIA_PERMISSION_GRANTED) shouldBe true
        roll.canEnumerate(MediaPermission.MEDIA_PERMISSION_DENIED) shouldBe false
        roll.canEnumerate(MediaPermission.MEDIA_PERMISSION_RESTRICTED) shouldBe false
        roll.canEnumerate(MediaPermission.MEDIA_PERMISSION_NOT_ASKED) shouldBe false
    }

    "the pass words a grant exactly as the reducer does" {
        // TWO PLACES WORD THE SAME FOUR SENTENCES and they must not drift: a
        // screen whose banner and whose backup disagree about why nothing is
        // happening is worse than either sentence alone.
        //
        // **This asserts the literals rather than reading
        // `PhotosGridMachine`'s copy**, because that reducer's sentences are
        // `private` and the file is another slice's this wave. Folding both
        // into `dev.centraid.design.Copy` is the right end state and is filed
        // in this umbrella's receipt as the follow-up; until then this test is
        // the thing that fails when one of the two is reworded alone.
        val roll = rollOf(FakePlatformServices())
        roll.permissionSentence(MediaPermission.MEDIA_PERMISSION_GRANTED) shouldBe ""
        roll.permissionSentence(MediaPermission.MEDIA_PERMISSION_LIMITED) shouldBe
            "Centraid imports the photos you selected."
        roll.permissionSentence(MediaPermission.MEDIA_PERMISSION_NOT_ASKED) shouldBe
            "Centraid needs access to your photos to back them up."
        roll.permissionSentence(MediaPermission.MEDIA_PERMISSION_DENIED) shouldBe
            "Photo access is off. Turn it on in Settings to import your camera roll."
        roll.permissionSentence(MediaPermission.MEDIA_PERMISSION_RESTRICTED) shouldBe
            "This device does not allow photo access."
    }

    "no sentence about a permission blames the member" {
        val roll = rollOf(FakePlatformServices())
        MediaPermission.entries.forEach { permission ->
            val sentence = roll.permissionSentence(permission).lowercase()
            // "You denied", "you only picked" — every one of these says what
            // CENTRAID does and what would change it, and none of them says the
            // member did something wrong.
            sentence shouldNotContain "you denied"
            sentence shouldNotContain "you refused"
            sentence shouldNotContain "you did not"
        }
    }

    "wifi-only is the default and an original waits for a link nobody pays for" {
        runTest {
            val roll = rollOf(FakePlatformServices())
            // THE DEFAULT IS READ, NOT ASSUMED: nothing has been written to the
            // store, so this is `TransferRule.of(null)`.
            roll.mayMove(
                NetworkStatus.Reading(online = true, metered = true, charging = false),
            ) shouldBe BackupState.Phase.PHASE_WAITING_FOR_UNMETERED
            roll.mayMove(
                NetworkStatus.Reading(online = true, metered = false, charging = false),
            ).shouldBeNull()
        }
    }

    "a platform that would not say counts as expensive" {
        runTest {
            // The deleted window policy's own asymmetry, kept here: a guess wrong
            // towards cheap spends a member's data plan, a guess wrong towards
            // expensive delays a photograph by one pass.
            rollOf(FakePlatformServices()).mayMove(
                NetworkStatus.Reading(
                    online = true,
                    metered = false,
                    charging = false,
                    platformRefused = true,
                ),
            ) shouldBe BackupState.Phase.PHASE_WAITING_FOR_UNMETERED
        }
    }

    "never is a floor that an unmetered radio does not lift" {
        runTest {
            val services = FakePlatformServices()
            TransferRule.write(services.secureStore, TransferRule.MANUAL)
            rollOf(services).mayMove(
                NetworkStatus.Reading(online = true, metered = false, charging = true),
            ) shouldBe BackupState.Phase.PHASE_WAITING_FOR_UNMETERED
        }
    }

    "allow-metered moves an original on a metered link, which is what it means" {
        runTest {
            val services = FakePlatformServices()
            TransferRule.write(services.secureStore, TransferRule.WIFI_AND_CELLULAR_PHOTOS)
            rollOf(services).mayMove(
                NetworkStatus.Reading(online = true, metered = true, charging = false),
            ).shouldBeNull()
        }
    }

    "there is no second switch for photographs" {
        runTest {
            // The member's ONE setting governs originals. If a SECOND key
            // appeared here, this test is the thing that says the setting
            // stopped meaning what it says.
            val services = FakePlatformServices()
            TransferRule.write(services.secureStore, TransferRule.WIFI_AND_CELLULAR_PHOTOS)
            services.secureStore.keys
                .map { it.removePrefix("centraid.v1.") }
                .toSet() shouldBe setOf(TransferRule.KEY)
        }
    }

    "the write names the staged bytes and never the phone's own id for them" {
        val roll = rollOf(FakePlatformServices())
        val asset = MediaLibrary.Asset(
            localId = "9F1B2C3D-0000/L0/001",
            bytes = 12,
            capturedAtIso = "2026-02-03T10:11:12Z",
            capturedUtcOffsetMinutes = 0,
            kind = MediaLibrary.Kind.PHOTO,
        )
        val input = roll.inputFor(asset, "ab".repeat(32))
        input shouldContain "\"staged_sha\":\"${"ab".repeat(32)}\""
        input shouldContain "\"kind\":\"photo\""
        input shouldContain "\"captured_at\":\"2026-02-03T10:11:12Z\""
        // `source_asset_id` IS EDIT LINEAGE (#711) — an FK to
        // `media_asset(asset_id)` — and a `PHAsset` identifier there would be a
        // dangling foreign key wearing a field's name. There is no column
        // anywhere for a device's own id, which is exactly why the cursor and
        // the content-hash intent id live on the phone.
        input shouldNotContain "source_asset_id"
        input shouldNotContain asset.localId
        // NO `phash` EITHER: the gateway derives one at commit from bytes it
        // holds, and a phone computing one would decode every original to
        // produce a second opinion about a value that never merges anything.
        input shouldNotContain "phash"
    }

    "a live photo's two halves carry one capture group" {
        val roll = rollOf(FakePlatformServices())
        val still = MediaLibrary.Asset(
            localId = "L/L0/001",
            bytes = 1,
            capturedAtIso = "2026-02-03T10:11:12Z",
            capturedUtcOffsetMinutes = 0,
            kind = MediaLibrary.Kind.PHOTO,
            captureGroupId = "L/L0/001",
        )
        val movie = still.copy(
            localId = "L/L0/001#pairedVideo",
            kind = MediaLibrary.Kind.VIDEO,
        )
        // ONE THING TO A GRID, TWO THINGS TO AN UPLOADER. Both writes name the
        // same group and different kinds.
        roll.inputFor(still, "aa".repeat(32)) shouldContain "\"capture_group_id\":\"L/L0/001\""
        roll.inputFor(movie, "bb".repeat(32)) shouldContain "\"capture_group_id\":\"L/L0/001\""
        roll.inputFor(movie, "bb".repeat(32)) shouldContain "\"kind\":\"video\""
    }

    "a burst member gets no invented grouping" {
        val roll = rollOf(FakePlatformServices())
        val burst = MediaLibrary.Asset(
            localId = "B/L0/001",
            bytes = 1,
            capturedAtIso = "2026-02-03T10:11:12Z",
            capturedUtcOffsetMinutes = 0,
            captureGroupId = null,
        )
        // A guess here would invent a relationship the owner never made
        // (`NATIVE_V0.md:11-19`).
        roll.inputFor(burst, "cc".repeat(32)) shouldNotContain "capture_group_id"
    }

    "a denied grant leaves the backup idle and says why, and never touches the grid" {
        runTest {
            val services = FakePlatformServices()
            services.mediaLibrary.grant = MediaPermission.MEDIA_PERMISSION_DENIED
            val report = CameraRoll(services, core = { null }).pass("vault-1")
            report.state.phase shouldBe BackupState.Phase.PHASE_IDLE
            report.state.paused_reason shouldContain "Settings"
            report.queued shouldBe 0
            // NOT ENUMERATED AT ALL: a pass that walked a roll it may not read
            // would be asking the platform a question it has already answered.
            services.mediaLibrary.opened.size shouldBe 0
        }
    }

    "the cursor is per vault, so one roll offered to two vaults is two walks" {
        // A photograph offered to two vaults is two uploads and two rows
        // (`docs/mobile-offline.md:175`), so each vault has its own place in
        // the roll and neither can advance the other's.
        CameraRoll.cursorKey("vault-a") shouldContain "vault-a"
        (CameraRoll.cursorKey("vault-a") == CameraRoll.cursorKey("vault-b")) shouldBe false
    }
})
