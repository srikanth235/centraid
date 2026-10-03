package dev.centraid.shared

import centraid.core.v1.Envelope
import centraid.core.v1.ErrorCode
import centraid.core.v1.Page
import centraid.core.v1.PhraseMinted
import centraid.core.v1.PhraseResponse
import centraid.core.v1.RestoreRequest
import centraid.core.v1.RestoreResponse
import centraid.core.v1.RestoredVault
import centraid.core.v1.Response
import centraid.core.v1.Row
import centraid.core.v1.UnclaimedVault
import centraid.core.v1.Value
import centraid.screen.v1.LockerBiometry
import centraid.screen.v1.LockerLockEvent
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreConfiguration
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.apps.locker.GateInput
import dev.centraid.shared.apps.locker.LockerLockMachine
import dev.centraid.shared.custody.CorePhraseDoor
import dev.centraid.shared.custody.PairRefusal
import dev.centraid.shared.custody.PairResult
import dev.centraid.shared.custody.RestoreRefusal
import dev.centraid.shared.custody.RestoreResult
import dev.centraid.shared.custody.UnclaimedVaultAt
import dev.centraid.shared.custody.VaultSecrets
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.sync.CorePairDoor
import dev.centraid.shared.sync.CoreRestoreDoor
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import okio.ByteString.Companion.toByteString
import java.io.File
import kotlin.io.path.createTempDirectory

/**
 * THE SHELF'S HALF OF THE 24 WORDS (#1047 E1, R-1047-E3…E5).
 *
 * The device secret rides every keyed open and no other; a restored vault's
 * own directory is a holding, keyed at the index the restore found and with the
 * secret it minted; handing the words back reopens what can be keyed and
 * guesses nothing; the doors carry what crosses and keep the secret the core
 * hands over once. A recording opener stands in for the ABI.
 */
class WordsShelfSpec : StringSpec({

    val seed = "408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf70" +
        "5489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840"
    val secret = "cd".repeat(32)

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

    "the device secret the core handed back rides a KEYED open of its vault, and no other open" {
        runTest {
            val phone = Phone()
            val path = phone.file("a.sqlite3", "v-a")
            phone.secrets.rememberSeed(seed)
            phone.secrets.rememberVaultIndex("v-a", 0)
            phone.secrets.rememberDeviceSecret("v-a", secret)
            phone.shelf.load()

            val opens = phone.opens.filter { it.databasePath == path }
            opens.first().deviceSecretHex.shouldBeNull() // the probe asks which vault it is
            opens.last().deviceSecretHex shouldBe secret
            opens.last().toString() shouldNotContain secret
        }
    }

    "no secret before a pair or a restore: a keyed open carries none, and nothing mints one" {
        runTest {
            val phone = Phone()
            phone.file("a.sqlite3", "v-a")
            phone.secrets.rememberSeed(seed)
            phone.secrets.rememberVaultIndex("v-a", 0)
            phone.shelf.load()
            phone.opens.last().vaultSeedHex shouldBe seed
            phone.opens.last().deviceSecretHex.shouldBeNull()
            phone.secrets.deviceSecret("v-a").shouldBeNull()
        }
    }

    "a restored vault's own directory is a holding: keyed at the restore's index, with its secret" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seed)
            val restored = phone.file("0a1b2c3d4e5f6071/vault.db", "v-restored")
            val added = phone.shelf.adoptRestored(listOf(Shelf.Restored(restored, 3)), secret)
            added shouldBe 1

            phone.secrets.vaultIndex("v-restored") shouldBe 3
            phone.secrets.deviceSecret("v-restored") shouldBe secret
            val keyed = phone.opens.last()
            keyed.databasePath shouldBe restored
            keyed.vaultIndex shouldBe 3
            keyed.deviceSecretHex shouldBe secret
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

    "the phrase door returns the core's words and nothing it cannot vouch for" {
        runTest {
            val words = List(24) { "abandon" }
            val door = CorePhraseDoor {
                CentraidCore.answering(Dispatchers.Unconfined) {
                    Envelope(response = Response(phrase = PhraseResponse(minted = PhraseMinted(words = words))))
                }
            }
            door.mint() shouldBe words
            val short = CorePhraseDoor {
                CentraidCore.answering(Dispatchers.Unconfined) {
                    Envelope(response = Response(phrase = PhraseResponse(minted = PhraseMinted(words = words.take(12)))))
                }
            }
            short.mint().shouldBeNull()
            CorePhraseDoor { null }.seed(words).shouldBeNull()
        }
    }

    "the restore door carries every vault's path and index, and the secret, redacted" {
        runTest {
            val door = CoreRestoreDoor {
                CentraidCore.answering(Dispatchers.Unconfined) {
                    Envelope(
                        response = Response(
                            restore = RestoreResponse(
                                vaults = listOf(RestoredVault(vault_id = "id", index = 2, path = "/v/x/vault.db", rows = 7, safety_number = "1 2")),
                                gap_scanned = 20,
                                device_secret = ByteArray(32) { 0xcd.toByte() }.toByteString(),
                                unclaimed = listOf(UnclaimedVault(index = 3, vault_id = "ef".repeat(32), reason = "logs only")),
                            ),
                        ),
                    )
                }
            }
            val answer = door.restore(List(24) { "abandon" }, null).shouldBeInstanceOf<RestoreResult.Restored>().answer
            answer.vaults.single().index shouldBe 2
            // A VAULT THAT STAYED WITH THE OLD PHONE (R-1047-R5) is carried by
            // index and id; the core's reason is a support log and is not.
            answer.unclaimed shouldBe listOf(UnclaimedVaultAt(index = 3, vaultId = "ef".repeat(32)))
            answer.toString() shouldNotContain "logs only"
            answer.vaults.single().path shouldBe "/v/x/vault.db"
            answer.deviceSecretHex shouldBe secret
            answer.toString() shouldNotContain secret
        }
    }

    "the seed doors ask the core with all 64 bytes, and the retry with the named indices" {
        runTest {
            var asked: RestoreRequest? = null
            val door = CoreRestoreDoor {
                CentraidCore.answering(Dispatchers.Unconfined) { envelope ->
                    asked = envelope.request?.restore
                    Envelope(response = Response(restore = RestoreResponse(vaults = listOf(RestoredVault(index = 1, path = "/v/y/vault.db")))))
                }
            }
            val code = """{"v":2,"gw":"gw-1"}"""
            val answer = door.restoreStayed("cd".repeat(64), code, listOf(1, 3))
                .shouldBeInstanceOf<RestoreResult.Restored>().answer
            answer.vaults.single().index shouldBe 1
            asked?.indices shouldBe listOf(1, 3)
            asked?.phrase shouldBe ""
            asked?.seed?.size shouldBe 64
            // THE PAIRING CODE CROSSES AS THE TEXT IT IS (#1080 A1); the
            // iroh endpoint the cut-over removes is never set.
            asked?.payload shouldBe code
            asked?.endpoint shouldBe null
            // THE HELD-SEED RESTORE rides the same 64 bytes, and reached the core
            // too: a seed read as a 32-byte endpoint id never did.
            door.restoreSeed("cd".repeat(64), null).shouldBeInstanceOf<RestoreResult.Restored>()
            asked?.seed?.size shouldBe 64
            asked?.indices shouldBe emptyList()
            CoreRestoreDoor { null }.restoreStayed("not hex", null, listOf(1)) shouldBe
                RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
        }
    }

    "the restore door says which refusal by the core's code, never a bare silence" {
        runTest {
            fun refusing(code: ErrorCode?) = CoreRestoreDoor {
                CentraidCore.answering(Dispatchers.Unconfined) {
                    Envelope(error = code?.let { centraid.core.v1.Error(code = it, detail = "logs only") })
                }
            }
            val words = List(24) { "abandon" }
            // A GENERATION THIS PHONE REFUSED is not a laptop that did not answer
            // (#1047 R3): the census refusal arrives as INTERNAL.
            refusing(ErrorCode.ERROR_CODE_INTERNAL).restore(words, null) shouldBe
                RestoreResult.Refused(RestoreRefusal.DID_NOT_CHECK)
            refusing(ErrorCode.ERROR_CODE_UNAUTHORIZED).restore(words, null) shouldBe
                RestoreResult.Refused(RestoreRefusal.NOT_TAKEN)
            refusing(ErrorCode.ERROR_CODE_PEER_UNREACHABLE).restore(words, null) shouldBe
                RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
            // AN ANSWER WITH NO RESTORE ON IT, and no core, are read as silence.
            refusing(null).restore(words, null) shouldBe RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
            CoreRestoreDoor { null }.restore(words, null) shouldBe RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
            CoreRestoreDoor { null }.restoreSeed("not hex", null) shouldBe
                RestoreResult.Refused(RestoreRefusal.UNREACHABLE)
        }
    }

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
                                    // THE FIELDS THAT LEAVE AT THE CUT-OVER ARE NOT READ:
                                    // a device secret here is ignored, never stored.
                                    device_secret = ByteArray(32) { 0xcd.toByte() }.toByteString(),
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
            // AN ANSWER WITH NO PAIR ON IT is read as silence, never as a pairing.
            refusing(null).pair("t") shouldBe PairResult.Refused(PairRefusal.UNREACHABLE)
            CorePairDoor({ null }).pair("t") shouldBe PairResult.Refused(PairRefusal.UNREACHABLE)
        }
    }

    // --- Locker's wall -----------------------------------------------------------

    "the no-words wall offers the words; the passcode wall and the ordinary lock do not" {
        val attached = GateInput.View(
            LockerLockEvent(attached = LockerLockEvent.Attached(available = true, biometry = LockerBiometry.LOCKER_BIOMETRY_FACE)),
        )
        var gate = LockerLockMachine.reduce(LockerLockMachine.initial(), GateInput.Keys(keyed = false)).gate
        gate = LockerLockMachine.reduce(gate, attached).gate
        gate.state.words_label shouldBe LockerCopy.LOCK_NO_WORDS_ACTION
        // THE INTENT CHANGES NOTHING in the gate: the shell routes it.
        val tapped = LockerLockMachine.reduce(gate, GateInput.View(LockerLockEvent(words = LockerLockEvent.WordsTapped())))
        tapped.gate shouldBe gate
        tapped.effects shouldBe emptyList()

        val keyed = LockerLockMachine.reduce(gate, GateInput.Keys(keyed = true)).gate
        keyed.state.words_label shouldBe ""
        val noPasscode = LockerLockMachine.reduce(
            LockerLockMachine.initial(),
            GateInput.View(LockerLockEvent(attached = LockerLockEvent.Attached(available = false))),
        ).gate
        noPasscode.state.words_label shouldBe ""
    }
})
