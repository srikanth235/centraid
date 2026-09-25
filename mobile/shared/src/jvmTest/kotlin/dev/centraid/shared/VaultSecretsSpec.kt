package dev.centraid.shared

import dev.centraid.shared.custody.VaultSecrets
import dev.centraid.shared.platform.FakePlatformServices
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
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
        services to VaultSecrets(services.secureStore, services.syncedSecrets, services.secureRandom)

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

    "the device secret goes to the DEVICE store, is minted once, and is stable" {
        runTest {
            val (services, vault) = secrets()
            val first = vault.deviceSecret("vault-a")
            first.length shouldBe VaultSecrets.DEVICE_SECRET_HEX_LENGTH
            // MINTED ONCE. A fresh identity on every launch would silently
            // un-enrol this device from its own laptop.
            vault.deviceSecret("vault-a") shouldBe first
            services.syncedSecrets.seed().shouldBeNull()
        }
    }

    "a device secret is PER VAULT, so unpairing one does not un-enrol the other" {
        runTest {
            val (_, vault) = secrets()
            val a = vault.deviceSecret("vault-a")
            val b = vault.deviceSecret("vault-b")
            a shouldNotBe b
            vault.forgetDeviceSecret("vault-a")
            vault.deviceSecret("vault-b") shouldBe b
            vault.deviceSecret("vault-a") shouldNotBe a
        }
    }

    "a stored value that is not the right shape is treated as absent, never as a credential" {
        runTest {
            val (services, vault) = secrets()
            services.secureStore.write(VaultSecrets.DEVICE_SECRET_PREFIX + "vault-a", "not hex")
            // MINTED AFRESH rather than handed to the core, which would be a
            // BAD_ARGUMENT arriving as a crash on a path a member cannot fix.
            vault.deviceSecret("vault-a").length shouldBe VaultSecrets.DEVICE_SECRET_HEX_LENGTH
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

    "forgetting the seed is complete" {
        runTest {
            val (_, vault) = secrets()
            vault.rememberSeed("cd".repeat(64))
            vault.forgetSeed()
            vault.seed().shouldBeNull()
        }
    }
})
