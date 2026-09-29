package dev.centraid.shared

import dev.centraid.shared.custody.VaultSecrets
import dev.centraid.shared.platform.FakePlatformServices
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.test.runTest

/**
 * THE TWO SECRETS, AND THE RULE THAT THEY LIVE IN DIFFERENT PLACES
 * (#1029 W18, `CONTRACT.md` §4b).
 *
 * The seed is SYNCHRONISED — it is the 24 words, and iCloud Keychain carrying it
 * to the member's next phone is the point. The device secret is **this device
 * only**: a copy on a second phone would enrol both as the same device, which
 * is the distinction F1's `VAULT_MOVED` freeze is keyed on. They are two hex
 * strings that look alike, which is exactly why the store each goes to is
 * asserted rather than remembered.
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

    "the device secret is the CORE's, kept in the DEVICE store and never minted here" {
        runTest {
            val (services, vault) = secrets()
            // NOTHING BEFORE A PAIR OR A RESTORE HANDS ONE BACK (#1047 E1,
            // R-1047-E4): a secret this class minted would be a key no
            // certificate names, and every drain would be refused.
            vault.deviceSecret("vault-a").shouldBeNull()
            val minted = "cd".repeat(32)
            vault.rememberDeviceSecret("vault-a", minted)
            vault.deviceSecret("vault-a") shouldBe minted
            services.secureStore.keys.any { it.endsWith(VaultSecrets.DEVICE_SECRET_PREFIX + "vault-a") } shouldBe true
            services.syncedSecrets.seed().shouldBeNull()
        }
    }

    "a device secret is PER VAULT, so unpairing one does not un-enrol the other" {
        runTest {
            val (_, vault) = secrets()
            vault.rememberDeviceSecret("vault-a", "aa".repeat(32))
            vault.rememberDeviceSecret("vault-b", "bb".repeat(32))
            vault.forgetDeviceSecret("vault-a")
            vault.deviceSecret("vault-b") shouldBe "bb".repeat(32)
            vault.deviceSecret("vault-a").shouldBeNull()
        }
    }

    "a stored value that is not the right shape is treated as absent, never as a credential" {
        runTest {
            val (services, vault) = secrets()
            services.secureStore.write(VaultSecrets.DEVICE_SECRET_PREFIX + "vault-a", "not hex")
            // ABSENT rather than handed to the core, which would be a
            // BAD_ARGUMENT arriving as a refused open on a path a member
            // cannot fix.
            vault.deviceSecret("vault-a").shouldBeNull()
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
            shouldThrow<IllegalArgumentException> {
                vault.rememberDeviceSecret("vault-a", "AB".repeat(32))
            }
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
