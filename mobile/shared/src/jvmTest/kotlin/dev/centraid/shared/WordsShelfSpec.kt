package dev.centraid.shared

import centraid.core.v1.Envelope
import centraid.core.v1.ErrorCode
import centraid.core.v1.Page
import centraid.core.v1.Response
import centraid.core.v1.Row
import centraid.core.v1.Value
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreConfiguration
import dev.centraid.shared.custody.PairRefusal
import dev.centraid.shared.custody.PairResult
import dev.centraid.shared.custody.VaultSecrets
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.sync.CorePairDoor
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import java.io.File
import kotlin.io.path.createTempDirectory

/**
 * THE SHELF'S HALF OF THE 24 WORDS (#1047 E1, R-1047-E3…E5).
 *
 * A keyed open carries the seed at the vault's index and no device secret
 * (#1080 A21); a restored vault's own directory is a holding, keyed at the
 * index the restore found; handing the words back reopens what can be keyed
 * and guesses nothing; the doors carry what crosses. A recording opener stands
 * in for the ABI.
 */
class WordsShelfSpec : StringSpec({

    val seed = "408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf70" +
        "5489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840"

    class Phone {
        val dir: File = createTempDirectory("words-shelf").toFile()
        val services = FakePlatformServices()
        val secrets = VaultSecrets(services.secureStore, services.syncedSecrets)
        val opens = mutableListOf<CoreConfiguration>()
        val ids = mutableMapOf<String, String>()

        /** `a.sqlite3` is `<dir>/a/vault.db`: one directory per vault (Q-1047-17). */
        fun file(name: String, vaultId: String): String {
            val relative = if (name.endsWith(".sqlite3")) name.removeSuffix(".sqlite3") + "/" + Shelf.VAULT_FILE else name
            val file = File(dir, relative).also { it.parentFile.mkdirs(); it.writeText("") }
            ids[file.path] = vaultId
            return file.path
        }

        val shelf = Shelf(
            vaultDir = dir.path,
            services = services,
            dispatcher = Dispatchers.Unconfined,
            uiThreadName = "",
            opener = { configuration ->
                opens += configuration
                val path = configuration.databasePath
                CentraidCore.answering(Dispatchers.Unconfined) { asked ->
                    if (asked.request?.page != null) {
                        Envelope(
                            response = Response(
                                page = Page(
                                    rows = ids[path]?.let { id ->
                                        listOf(Row(values = listOf(Value(text = id), Value(text = "Vault $id"))))
                                    }.orEmpty(),
                                ),
                            ),
                        )
                    } else {
                        Envelope(response = Response())
                    }
                }
            },
        )
    }

    "a keyed open carries the seed at its vault's index; the probe carries none" {
        runTest {
            val phone = Phone()
            val path = phone.file("a.sqlite3", "v-a")
            phone.secrets.rememberSeed(seed)
            phone.secrets.rememberVaultIndex("v-a", 0)
            phone.shelf.load()

            val opens = phone.opens.filter { it.databasePath == path }
            opens.first().vaultSeedHex.shouldBeNull() // the probe asks which vault it is
            opens.last().vaultSeedHex shouldBe seed
            opens.last().vaultIndex shouldBe 0
            opens.last().toString() shouldNotContain seed
        }
    }

    "a restored vault's own directory is a holding, keyed at the restore's index, and no device key is kept" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seed)
            val restored = phone.file("0a1b2c3d4e5f6071/vault.db", "v-restored")
            val added = phone.shelf.adoptRestored(listOf(Shelf.Restored(restored, 3)))
            added shouldBe 1

            phone.secrets.vaultIndex("v-restored") shouldBe 3
            val keyed = phone.opens.last()
            keyed.databasePath shouldBe restored
            keyed.vaultIndex shouldBe 3
            keyed.vaultSeedHex shouldBe seed
            // NO DEVICE KEY IS KEPT (#1080 A21): a gateway knows this phone by
            // a token in the core's ledger, so the device store names none.
            phone.services.secureStore.keys.none { it.startsWith("device-secret.") } shouldBe true
            phone.shelf.foregroundHolding().shouldNotBeNull().keyed shouldBe true

            // AND A RELAUNCH FINDS IT THERE, beside the vaults this phone founded.
            val relaunched = Phone().also { again ->
                File(restored).copyTo(File(again.dir, "0a1b2c3d4e5f6071/vault.db"))
                again.ids[File(again.dir, "0a1b2c3d4e5f6071/vault.db").path] = "v-restored"
                again.file("b.sqlite3", "v-b")
            }
            relaunched.shelf.load()
            relaunched.shelf.all().map { it.vaultId }.toSet() shouldBe setOf("v-restored", "v-b")
        }
    }

    "handing the words back reopens what has an index, keyed, and guesses no index for the rest" {
        runTest {
            val phone = Phone()
            phone.file("a.sqlite3", "v-a")
            phone.file("b.sqlite3", "v-b")
            phone.secrets.rememberVaultIndex("v-a", 0)
            phone.shelf.load()
            phone.shelf.all().none { it.keyed } shouldBe true
            phone.shelf.indexedHoldings() shouldBe 1

            phone.secrets.rememberSeed(seed)
            phone.opens.clear()
            phone.shelf.rekey() shouldBe 1
            phone.opens shouldHaveSize 1
            phone.opens.single().vaultIndex shouldBe 0
            phone.shelf.all().single { it.vaultId == "v-a" }.keyed shouldBe true
            phone.shelf.all().single { it.vaultId == "v-b" }.keyed shouldBe false
        }
    }

    "the custody core holds no vault: create is false and no seed rides it" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seed)
            val core = phone.shelf.custodyCore().shouldNotBeNull()
            phone.shelf.custodyCore() shouldBe core
            val open = phone.opens.single()
            open.create shouldBe false
            open.vaultSeedHex.shouldBeNull()
            open.databasePath shouldBe File(phone.dir, Shelf.CUSTODY_FILE).path
            File(open.databasePath).exists() shouldBe false
        }
    }

    // --- the doors -------------------------------------------------------------

    "the pair door answers the safety number and the destination, and nothing secret" {
        runTest {
            val door = CorePairDoor(
                core = {
                    CentraidCore.answering(Dispatchers.Unconfined) {
                        Envelope(
                            response = Response(
                                pair_phone = centraid.core.v1.PairResponse(
                                    safety_number = "12345 67890",
                                    destination = centraid.core.v1.Destination(
                                        label = "Home laptop",
                                        addrs = listOf("192.168.1.20:7443", "10.0.0.2:7443"),
                                    ),
                                ),
                            ),
                        )
                    }
                },
            )
            val answer = door.pair("ticket").shouldBeInstanceOf<PairResult.Paired>().answer
            answer.safetyNumber shouldBe "12345 67890"
            answer.destinationLabel shouldBe "Home laptop"
            answer.destinationAddress shouldBe "192.168.1.20:7443"
        }
    }

    "the pair door says which refusal by the core's code, and keeps nothing on one" {
        runTest {
            fun refusing(code: ErrorCode?) = CorePairDoor(
                core = {
                    CentraidCore.answering(Dispatchers.Unconfined) {
                        Envelope(error = code?.let { centraid.core.v1.Error(code = it, detail = "logs only") })
                    }
                },
            )
            refusing(ErrorCode.ERROR_CODE_UNAUTHORIZED).pair("t") shouldBe PairResult.Refused(PairRefusal.NOT_TAKEN)
            refusing(ErrorCode.ERROR_CODE_INVALID_REQUEST).pair("t") shouldBe PairResult.Refused(PairRefusal.NOT_A_CODE)
            refusing(ErrorCode.ERROR_CODE_PEER_UNREACHABLE).pair("t") shouldBe PairResult.Refused(PairRefusal.UNREACHABLE)
            // A SUPERSEDED PHONE IS NOT ONE WHOSE LAPTOP DID NOT ANSWER (#1080, the
            // simulator edge cases): "did not answer" sent the member to retry a
            // pairing the core will always refuse.
            refusing(ErrorCode.ERROR_CODE_VAULT_MOVED).pair("t") shouldBe PairResult.Refused(PairRefusal.MOVED)
            // AN ANSWER WITH NO PAIR ON IT is read as silence, never as a pairing.
            refusing(null).pair("t") shouldBe PairResult.Refused(PairRefusal.UNREACHABLE)
            CorePairDoor({ null }).pair("t") shouldBe PairResult.Refused(PairRefusal.UNREACHABLE)
        }
    }
})
