package dev.centraid.core

import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain

/**
 * WHAT `centraid_open` IS HANDED (#1029 W18, `crates/core-ffi/CONTRACT.md` §4b).
 *
 * The open config is a JSON string built in one place, and the two secrets it
 * may carry are the one part a shell could get subtly wrong: an absent key and
 * an empty-string key mean different things to the core (absent is "not
 * unlocked" and is fine; present and malformed is `BAD_ARGUMENT`). These cases
 * pin the shape, because the failure mode is a member believing they have
 * unlocked a core that cannot seal a byte.
 */
class ConfigurationJsonSpec : StringSpec({

    "a plain open carries neither secret, and absent is not an empty string" {
        val json = CoreConfiguration(databasePath = "/v/a.sqlite3").toJson("main")
        json shouldBe """{"path":"/v/a.sqlite3","create":true,"uiThreadName":"main"}"""
    }

    "the seed rides with its derivation index, because one without the other seals nothing" {
        val json = CoreConfiguration(
            databasePath = "/v/a.sqlite3",
            create = false,
            vaultSeedHex = "ab".repeat(64),
            vaultIndex = 3,
        ).toJson("main")
        json shouldContain """"vault":{"seed":"${"ab".repeat(64)}","index":3}"""
    }

    "the device secret is its own object and never inside the vault object" {
        // THEY ARE DIFFERENT SECRETS WITH OPPOSITE DURABILITY RULES. Nesting one
        // inside the other would be the first step towards storing them
        // together, which is the defect `VaultSecrets` exists to prevent.
        val json = CoreConfiguration(
            databasePath = "/v/a.sqlite3",
            vaultSeedHex = "ab".repeat(64),
            deviceSecretHex = "cd".repeat(32),
        ).toJson("main")
        json shouldContain """"device":{"secret":"${"cd".repeat(32)}"}"""
        json shouldContain """"vault":{"seed":"""
    }

    "a device secret with no seed is the ordinary locked phone, and is still sent" {
        // A CORE THAT CANNOT SEAL STILL HAS AN IDENTITY. Withholding the device
        // secret because the member has not unlocked would make every locked
        // launch mint a fresh one.
        val json = CoreConfiguration(
            databasePath = "/v/a.sqlite3",
            deviceSecretHex = "cd".repeat(32),
        ).toJson("main")
        json shouldContain """"device":{"secret":"""
        json.contains("\"vault\"") shouldBe false
    }
})
