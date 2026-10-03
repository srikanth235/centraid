package dev.centraid.core

import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain

/**
 * WHAT `centraid_open` IS HANDED (#1029 W18, `crates/core-ffi/CONTRACT.md` §4b).
 *
 * The open config is a JSON string built in one place, and the seed it may
 * carry is the one part a shell could get subtly wrong: an absent key and an
 * empty-string key mean different things to the core (absent is "not
 * unlocked" and is fine; present and malformed is `BAD_ARGUMENT`). These cases
 * pin the shape, because the failure mode is a member believing they have
 * unlocked a core that cannot seal a byte.
 */
class ConfigurationJsonSpec : StringSpec({

    "a plain open carries no seed, and absent is not an empty string" {
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

    "no open carries a device secret: a gateway knows the phone by its token (#1080 A21)" {
        // THE CORE MINTS NO DEVICE KEY AND READS NONE. A `device` object on the
        // config would be a secret handed to a core that ignores it, and a
        // shell that still kept one would be keeping a credential for nothing.
        val keyed = CoreConfiguration(
            databasePath = "/v/a.sqlite3",
            vaultSeedHex = "ab".repeat(64),
            vaultIndex = 1,
        )
        keyed.toJson("main").contains("\"device\"") shouldBe false
        keyed.toString() shouldBe "CoreConfiguration(databasePath=/v/a.sqlite3, create=true, " +
            "expectedDigest=${ArtifactIdentity.DEV}, vaultSeedHex=<redacted>, vaultIndex=1)"
    }
})
