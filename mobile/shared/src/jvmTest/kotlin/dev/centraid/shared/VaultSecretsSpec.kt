package dev.centraid.shared

import dev.centraid.shared.custody.VaultSecrets
import dev.centraid.shared.platform.FakePlatformServices
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.test.runTest

/**
 * THE SEED, AND THE RULE THAT IT AND THIS PHONE'S FACTS LIVE IN DIFFERENT
 * PLACES (#1029 W18, `CONTRACT.md` §4b).
 *
 * The seed is SYNCHRONISED — it is the 24 words, and iCloud Keychain carrying it
 * to the member's next phone is the point. The words this phone was given and
 * each vault's index are **this device only**. There is no device secret
 * (#1080 A21): a gateway knows the phone by a token in the core's ledger.
 */
class VaultSecretsSpec : StringSpec({

    fun secrets(services: FakePlatformServices = FakePlatformServices()) =
        services to VaultSecrets(services.secureStore, services.syncedSecrets)

    "the seed goes to the SYNCHRONISED store and nowhere else" {
        runTest {
            val (services, vault) = secrets()
            val seed = "ab".repeat(64)
            vault.rememberSeed(seed) shouldBe true
            vault.seed() shouldBe seed
            // NOT IN THE DEVICE STORE. A seed pinned to this device is a member
            // whose next phone cannot be restored by the thing that followed
            // their Apple ID.
            services.secureStore.keys.none { it.contains("seed") } shouldBe true
        }
    }

    "a seed is SETTLED only when this phone minted, restored or re-keyed it, or spent an index" {
        runTest {
            val (_, vault) = secrets()
            vault.rememberSeed("ab".repeat(64))
            // A SEED THAT ARRIVED BY SYNC is not settled: its indices are on
            // another phone, and index 0 is a vault that already exists.
            vault.seedSettled() shouldBe false
            vault.settleSeed()
            vault.seedSettled() shouldBe true

            val (_, other) = secrets()
            other.rememberVaultIndex("v", 0)
            other.seedSettled() shouldBe true
        }
    }

    "writing a malformed secret is refused at the call, not at the ABI" {
        runTest {
            val (_, vault) = secrets()
            shouldThrow<IllegalArgumentException> { vault.rememberSeed("abc") }
            shouldThrow<IllegalArgumentException> { vault.rememberSeed("AB".repeat(64)) }
        }
    }

    "a platform that will not synchronise still leaves the seed on THIS phone, and only here" {
        runTest {
            val services = FakePlatformServices(
                syncedSecrets = dev.centraid.shared.platform.FakeSyncedSecrets(
                    availability = dev.centraid.shared.platform.SyncedSecrets.Availability(
                        synchronizing = false,
                        sentence = dev.centraid.shared.platform.SyncedSecrets.ANDROID_SENTENCE,
                        restoresAfterSetup = false,
                    ),
                ),
            )
            val vault = VaultSecrets(services.secureStore, services.syncedSecrets)
            val seed = "ef".repeat(64)
            // SAID PLAINLY: not synchronised. And yet a phone that stored it
            // nowhere could never open a vault keyed (#1047 E1, R-1047-E6).
            vault.rememberSeed(seed) shouldBe false
            vault.seed() shouldBe seed
            services.syncedSecrets.seed().shouldBeNull()
            vault.forgetSeed()
            vault.seed().shouldBeNull()
        }
    }

    "forgetting the seed is complete" {
        runTest {
            val (_, vault) = secrets()
            vault.rememberSeed("cd".repeat(64))
            vault.forgetSeed()
            vault.seed().shouldBeNull()
        }
    }
})
