package dev.centraid.shared

import centraid.core.v1.Envelope
import centraid.core.v1.FoundResponse
import centraid.core.v1.Page
import centraid.core.v1.Response
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.LockerBiometry
import centraid.screen.v1.LockerLockEvent
import centraid.screen.v1.LockerLockState
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreConfiguration
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.apps.locker.GateEffect
import dev.centraid.shared.apps.locker.GateInput
import dev.centraid.shared.apps.locker.LockerDoor
import dev.centraid.shared.apps.locker.LockerDoorAnswer
import dev.centraid.shared.apps.locker.LockerGate
import dev.centraid.shared.apps.locker.LockerLockMachine
import dev.centraid.shared.custody.DevSeed
import dev.centraid.shared.custody.VaultSecrets
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.shell.Shelf
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import java.io.File
import kotlin.io.path.createTempDirectory

/**
 * EVERY OPEN IS KEYED WHEN IT CAN BE (#1047 W2, D-6).
 *
 * Locker's `K` is derived from the seed at `centraid_open`, so a core opened
 * without the seed and the vault's index refuses every unlock. These specs
 * stand a recording opener in for the ABI and read the configuration each of
 * the shelf's opens carries: launch, found, a woken holding and a switch. The
 * Rust half — a keyed core unlocks and reveals, an unkeyed one answers
 * `Unavailable` — is `crates/core/src/app_query/locker_tests.rs`.
 */
class KeyedOpenSpec : StringSpec({

    /** The public BIP-39 all-`abandon` seed, the demo's. Never anybody's. */
    val seed = "408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf70" +
        "5489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840"

    /**
     * A directory of vaults, one directory each (`<stem>/vault.db`,
     * Q-1047-17), and a fake core per file that names its vault.
     */
    class Phone(vararg vaults: Pair<String, String>) {
        val dir: File = createTempDirectory("keyed-open").toFile()
        val services = FakePlatformServices()
        val secrets = VaultSecrets(services.secureStore, services.syncedSecrets)
        val opens = mutableListOf<CoreConfiguration>()
        val ids = mutableMapOf<String, String>()
        var refuseFound = false

        fun fileOf(name: String): File = File(File(dir, name.removeSuffix(".sqlite3")), Shelf.VAULT_FILE)

        init {
            vaults.forEach { (file, vaultId) ->
                val path = fileOf(file).also { it.parentFile.mkdirs(); it.writeText("") }.path
                ids[path] = vaultId
            }
        }

        val shelf = Shelf(
            vaultDir = dir.path,
            services = services,
            dispatcher = Dispatchers.Unconfined,
            uiThreadName = "",
            opener = { configuration ->
                opens += configuration
                val path = configuration.databasePath
                // THE CORE MAKES THE FILE when asked to create it, as the real one does.
                if (configuration.create) File(path).also { it.parentFile.mkdirs(); it.writeText("") }
                CentraidCore.answering(Dispatchers.Unconfined) { asked ->
                    val request = asked.request
                    when {
                        request?.found != null && refuseFound -> Envelope(response = Response())
                        request?.found != null -> {
                            ids[path] = "v-founded"
                            Envelope(response = Response(found = FoundResponse(vault_id = "v-founded")))
                        }
                        request?.page != null -> Envelope(
                            response = Response(
                                page = Page(
                                    rows = ids[path]?.let { id ->
                                        listOf(Row(values = listOf(Value(text = id), Value(text = "Vault $id"))))
                                    }.orEmpty(),
                                ),
                            ),
                        )
                        else -> Envelope(response = Response())
                    }
                }
            },
        )

        fun opensOf(file: String): List<CoreConfiguration> =
            opens.filter { it.databasePath == fileOf(file).path }
    }

    // --- the open ------------------------------------------------------------

    "a vault with the seed and a recorded index opens KEYED, at its own index" {
        runTest {
            val phone = Phone("a.sqlite3" to "v-a")
            phone.secrets.rememberSeed(seed)
            phone.secrets.rememberVaultIndex("v-a", 2)
            phone.shelf.load()

            // THE PROBE ASKS WHICH VAULT THE FILE IS, unkeyed; the keyed open
            // follows once the id names an index.
            val opens = phone.opensOf("a.sqlite3")
            opens shouldHaveSize 2
            opens.first().vaultSeedHex.shouldBeNull()
            opens.last().vaultSeedHex shouldBe seed
            opens.last().vaultIndex shouldBe 2
            opens.last().create.shouldBeFalse()
            phone.shelf.foregroundHolding().shouldNotBeNull().keyed.shouldBeTrue()
        }
    }

    "no seed on this phone: the vault opens once, unkeyed, and still reads" {
        runTest {
            val phone = Phone("a.sqlite3" to "v-a")
            phone.secrets.rememberVaultIndex("v-a", 0)
            phone.shelf.load()

            phone.opens shouldHaveSize 1
            phone.opens.single().vaultSeedHex.shouldBeNull()
            val held = phone.shelf.foregroundHolding().shouldNotBeNull()
            held.keyed.shouldBeFalse()
            held.core.shouldNotBeNull()
        }
    }

    "a seed but no index is unkeyed, never a guess at index 0" {
        runTest {
            val phone = Phone("a.sqlite3" to "v-a")
            phone.secrets.rememberSeed(seed)
            phone.shelf.load()

            // TWO VAULTS AT ONE INDEX ARE ONE IDENTITY AND ONE `K`.
            phone.opens.none { it.vaultSeedHex != null }.shouldBeTrue()
            phone.shelf.foregroundHolding().shouldNotBeNull().keyed.shouldBeFalse()
        }
    }

    "a switch to a rested vault reopens it keyed, at its own index" {
        runTest {
            val phone = Phone("a.sqlite3" to "v-a", "b.sqlite3" to "v-b")
            phone.secrets.rememberSeed(seed)
            phone.secrets.rememberVaultIndex("v-a", 0)
            phone.secrets.rememberVaultIndex("v-b", 1)
            phone.shelf.load()
            phone.shelf.foreground shouldBe "v-a"

            phone.shelf.rest()
            phone.shelf.all().single { it.vaultId == "v-b" }.resting.shouldBeTrue()
            phone.opens.clear()
            phone.shelf.bringToFront("v-b").shouldNotBeNull()

            val woken = phone.opens.single()
            woken.vaultSeedHex shouldBe seed
            woken.vaultIndex shouldBe 1
            phone.shelf.foregroundHolding().shouldNotBeNull().keyed.shouldBeTrue()
        }
    }

    "making a vault with the seed takes the index past every one this phone recorded" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seed)
            phone.secrets.rememberVaultIndex("v-gone", 3)
            // FORGETTING A VAULT DOES NOT LOWER THE MARK: index 3 sealed
            // something once, and a new vault re-derived there would be it.
            phone.secrets.forgetVaultIndex("v-gone")
            phone.secrets.vaultIndex("v-gone").shouldBeNull()

            val outcome = phone.shelf.found()
            (outcome is Shelf.FoundOutcome.Founded).shouldBeTrue()

            val founding = phone.opens.single()
            founding.create.shouldBeTrue()
            founding.vaultSeedHex shouldBe seed
            founding.vaultIndex shouldBe 4
            phone.secrets.vaultIndex("v-founded") shouldBe 4
            phone.shelf.foregroundHolding().shouldNotBeNull().keyed.shouldBeTrue()
        }
    }

    "making a vault with no seed is unkeyed and spends no index" {
        runTest {
            val phone = Phone()
            phone.shelf.found()
            phone.opens.single().vaultSeedHex.shouldBeNull()
            phone.secrets.vaultIndex("v-founded").shouldBeNull()
            phone.secrets.nextVaultIndex() shouldBe 0
            phone.shelf.foregroundHolding().shouldNotBeNull().keyed.shouldBeFalse()
        }
    }

    "forgetting a vault drops its index" {
        runTest {
            val phone = Phone("a.sqlite3" to "v-a")
            phone.secrets.rememberSeed(seed)
            phone.secrets.rememberVaultIndex("v-a", 0)
            phone.shelf.load()
            phone.shelf.forget("v-a")
            phone.secrets.vaultIndex("v-a").shouldBeNull()
            phone.secrets.nextVaultIndex() shouldBe 1
        }
    }

    // --- one directory per vault (#1047, Q-1047-17) ---------------------------

    "a vault is founded in a directory of its own, and forgetting it deletes the directory whole" {
        runTest {
            val phone = Phone()
            val founded = (phone.shelf.found() as Shelf.FoundOutcome.Founded).holding
            val file = File(founded.path)
            file.name shouldBe Shelf.VAULT_FILE
            file.parentFile.parentFile shouldBe phone.dir
            // The backup home the core keeps beside the file is this vault's alone.
            File(file.parentFile, "backup").mkdirs()

            phone.shelf.forget(founded.vaultId)
            file.parentFile.exists().shouldBeFalse()
            phone.dir.exists().shouldBeTrue()
        }
    }

    "a loose .sqlite3 in the vault directory is not a holding" {
        runTest {
            val phone = Phone()
            File(phone.dir, "loose.sqlite3").writeText("")
            phone.ids[File(phone.dir, "loose.sqlite3").path] = "v-loose"
            phone.shelf.load()
            phone.shelf.all().shouldBeEmpty()
        }
    }

    // --- the found's crash window (#1047 E4) ---------------------------------

    "the index is spent before the found, against its path, and recorded after" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seed)
            phone.shelf.found()
            phone.secrets.vaultIndex("v-founded") shouldBe 0
            phone.secrets.pendingFound().shouldBeNull()
            phone.secrets.nextVaultIndex() shouldBe 1
        }
    }

    "a found the process did not live to record is finished by the next launch, keyed" {
        runTest {
            // THE KILL: the core founded `v-x` at index 2, and the shelf died
            // before it recorded the index under the id.
            val phone = Phone("x" to "v-x")
            phone.secrets.rememberSeed(seed)
            phone.secrets.rememberVaultIndex("v-old", 1)
            phone.secrets.reserveVaultIndex(phone.fileOf("x").path) shouldBe 2

            phone.shelf.load()
            phone.secrets.vaultIndex("v-x") shouldBe 2
            phone.secrets.pendingFound().shouldBeNull()
            phone.opensOf("x").last().vaultIndex shouldBe 2
            phone.shelf.foregroundHolding().shouldNotBeNull().keyed.shouldBeTrue()
            // AND THE NEXT FOUND DOES NOT TAKE INDEX 2 AGAIN.
            phone.secrets.nextVaultIndex() shouldBe 3
        }
    }

    "killed before the core made the file: the empty directory and the index are given back" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seed)
            val home = File(phone.dir, "centraid-vault-dead").also { it.mkdirs() }
            phone.secrets.reserveVaultIndex(File(home, Shelf.VAULT_FILE).path) shouldBe 0

            phone.shelf.load()
            home.exists().shouldBeFalse()
            phone.secrets.pendingFound().shouldBeNull()
            phone.secrets.nextVaultIndex() shouldBe 0
        }
    }

    "a refused found deletes its directory and gives its index back" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seed)
            phone.secrets.rememberVaultIndex("v-a", 0)
            phone.refuseFound = true
            (phone.shelf.found() is Shelf.FoundOutcome.Refused).shouldBeTrue()
            phone.dir.listFiles().orEmpty().filter { it.isDirectory }.shouldBeEmpty()
            phone.secrets.pendingFound().shouldBeNull()
            phone.secrets.nextVaultIndex() shouldBe 1
        }
    }

    // --- the demo's dev seed ---------------------------------------------------

    "a dev seed is stored where a real one lives and keys the demo vaults at 0" {
        runTest {
            val phone = Phone("demo-vault.sqlite3" to "v-demo")
            phone.shelf.load(DevSeed(seed))

            phone.secrets.seed() shouldBe seed
            phone.secrets.vaultIndex("v-demo") shouldBe DevSeed.DEMO_INDEX
            val keyed = phone.opensOf("demo-vault.sqlite3").last()
            keyed.vaultSeedHex shouldBe seed
            keyed.vaultIndex shouldBe 0
            phone.shelf.foregroundHolding().shouldNotBeNull().keyed.shouldBeTrue()
        }
    }

    "a dev seed never overrides an index already recorded" {
        runTest {
            val phone = Phone("a.sqlite3" to "v-a")
            phone.secrets.rememberVaultIndex("v-a", 5)
            phone.shelf.load(DevSeed(seed))
            phone.opensOf("a.sqlite3").last().vaultIndex shouldBe 5
        }
    }

    "a launch value that is not a seed is no seed, and a seed never prints" {
        DevSeed.parse(null).shouldBeNull()
        DevSeed.parse("abc").shouldBeNull()
        DevSeed.parse("zz".repeat(64)).shouldBeNull()
        // Trimmed and lower-cased: a value pasted into a launch command.
        DevSeed.parse(" ${seed.uppercase()} \n").shouldNotBeNull().seedHex shouldBe seed

        DevSeed(seed).toString() shouldNotContain seed
        val configuration = CoreConfiguration(databasePath = "/v.sqlite3", vaultSeedHex = seed, vaultIndex = 3)
        configuration.toString() shouldNotContain seed
        configuration.toString() shouldContain "vaultIndex=3"
    }

    // --- the Locker wall on an unkeyed core ------------------------------------

    val attached = GateInput.View(
        LockerLockEvent(attached = LockerLockEvent.Attached(available = true, biometry = LockerBiometry.LOCKER_BIOMETRY_FACE)),
    )
    val tap = GateInput.View(LockerLockEvent(unlock = LockerLockEvent.UnlockTapped()))

    "an unkeyed core draws the words' wall and never raises a prompt" {
        var gate = LockerLockMachine.initial()
        val effects = mutableListOf<GateEffect>()
        listOf(GateInput.Keys(keyed = false), attached, tap).forEach {
            val step = LockerLockMachine.reduce(gate, it)
            gate = step.gate
            effects += step.effects
        }
        gate.state.phase shouldBe LockerLockState.Phase.PHASE_UNAVAILABLE
        gate.state.title shouldBe LockerCopy.LOCK_NO_WORDS_TITLE
        gate.state.body shouldBe LockerCopy.LOCK_NO_WORDS_BODY
        gate.state.notice shouldBe LockerCopy.LOCK_NO_WORDS_NOTICE
        gate.state.cover.shouldBeTrue()
        // NO FACE ID FOR A DOOR THAT CANNOT OPEN: the prompt would succeed and
        // the core would then refuse with a sentence about a gateway.
        gate.state.prompt.shouldBeNull()
        effects.shouldBeEmpty()

        // AND A KEYED CORE (a switch to a vault with its words) is the ordinary lock.
        val back = LockerLockMachine.reduce(gate, GateInput.Keys(keyed = true)).gate
        back.state.phase shouldBe LockerLockState.Phase.PHASE_LOCKED
        back.state.title shouldBe LockerCopy.LOCK_TITLE
    }

    "no passcode on a keyed core still says passcode, not words" {
        val noPasscode = GateInput.View(
            LockerLockEvent(attached = LockerLockEvent.Attached(available = false)),
        )
        val gate = LockerLockMachine.reduce(LockerLockMachine.initial(), noPasscode).gate
        gate.state.title shouldBe LockerCopy.LOCK_UNAVAILABLE_TITLE
    }

    "an open Locker whose core turns out unkeyed is relocked" {
        var gate = LockerLockMachine.initial()
        gate = LockerLockMachine.reduce(gate, attached).gate
        gate = LockerLockMachine.reduce(gate, tap).gate
        val token = gate.state.prompt.shouldNotBeNull().token
        gate = LockerLockMachine.reduce(
            gate,
            GateInput.View(
                LockerLockEvent(
                    answered = LockerLockEvent.PromptAnswered(
                        token = token,
                        outcome = LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED,
                    ),
                ),
            ),
        ).gate
        gate = LockerLockMachine.reduce(gate, GateInput.Core(open = true)).gate
        gate.open.shouldBeTrue()

        val step = LockerLockMachine.reduce(gate, GateInput.Keys(keyed = false))
        step.gate.state.phase shouldBe LockerLockState.Phase.PHASE_UNAVAILABLE
        step.effects shouldBe listOf(GateEffect.Relock)
    }

    "the running gate reads keyed before every view event, and asks the core nothing" {
        runTest {
            val asked = mutableListOf<String>()
            val door = object : LockerDoor {
                override suspend fun state(): LockerDoorAnswer = LockerDoorAnswer.Session(open = false).also { asked += "state" }
                override suspend fun unlock(): LockerDoorAnswer = LockerDoorAnswer.Session(open = true).also { asked += "unlock" }
                override suspend fun relock(): LockerDoorAnswer = LockerDoorAnswer.Session(open = false).also { asked += "relock" }
                override suspend fun reveal(itemId: String, column: String): LockerDoorAnswer =
                    LockerDoorAnswer.Session(open = false).also { asked += "reveal" }
            }
            var keyed = false
            val gate = LockerGate(door, CoroutineScope(Dispatchers.Unconfined), keyed = { keyed })
            gate.reduce(attached)
            gate.reduce(tap)
            gate.state.value.title shouldBe LockerCopy.LOCK_NO_WORDS_TITLE
            asked.shouldBeEmpty()

            keyed = true
            gate.reduce(attached)
            gate.state.value.phase shouldBe LockerLockState.Phase.PHASE_LOCKED
        }
    }
})
