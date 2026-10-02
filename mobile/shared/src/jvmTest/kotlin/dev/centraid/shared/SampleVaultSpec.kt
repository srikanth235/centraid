package dev.centraid.shared

import centraid.core.v1.Envelope
import centraid.core.v1.Error
import centraid.core.v1.ErrorCode
import centraid.core.v1.FoundContent
import centraid.core.v1.FoundResponse
import centraid.core.v1.Page
import centraid.core.v1.Response
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.PairLaptopEvent
import centraid.screen.v1.PairLaptopState
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreConfiguration
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.custody.CustodyCopy
import dev.centraid.shared.custody.DevSeed
import dev.centraid.shared.custody.PairInput
import dev.centraid.shared.custody.PairLaptopMachine
import dev.centraid.shared.custody.Readiness
import dev.centraid.shared.custody.VaultSecrets
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.shell.VaultRoster
import dev.centraid.shared.sync.DrainAnswer
import dev.centraid.shared.sync.DrainDoor
import dev.centraid.shared.sync.ShelfDrain
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import java.io.File
import kotlin.io.path.createTempDirectory

/**
 * THE SAMPLE VAULT ON THE SHELF.
 *
 * A phone that makes its first vault also founds a second, separate vault —
 * the SAMPLE — filled with the Tahoe scenario. What the shelf owes it, and what
 * these cases hold:
 *
 * - founding it never takes the front from the member's own vault;
 * - it opens KEYED under the member's own seed at a derivation index of its
 *   own — spent before the open, given back on a refusal, recorded against its
 *   id, forgotten with it, never reused — and unkeyed (no index spent) when the
 *   phone holds no seed or one that is not settled; never under a dev seed's
 *   index;
 * - a sample that did not seed whole — refused, or a process killed mid-seed —
 *   is never a holding, and its directory is gone;
 * - removing it is [Shelf.forget], which leaves the member's vault in front and
 *   the shelf whole;
 * - [Shelf.hasSample] and the lockup's `sample` say so, and the drain and the
 *   pairing screen leave it alone.
 *
 * The Rust half — the scenario lands across seven apps and, on a keyed core,
 * five Locker items sealed under the member's keys (and none unkeyed), the mark
 * is written last, and the core refuses to pair or drain a sample — is
 * `crates/core/tests/sample_vault.rs`. The JVM cannot load the real core here
 * (see `FoundDoorSpec`), so this drives a fake that answers the found and the
 * identify read the way the core does.
 */
class SampleVaultSpec : StringSpec({

    /** The public BIP-39 all-`abandon` seed, the demo's. Never anybody's. */
    val seed = "408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf70" +
        "5489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840"

    // HOW THE FAKE CORE ANSWERS A SAMPLE FOUND ([Phone.sampleAnswer]): the
    // whole scenario; a found the core refused; or an answer over a vault whose
    // mark still says `seeding`.
    val ready = "ready"
    val refused = "refused"
    val unfinished = "unfinished"

    /**
     * A directory of vaults, one directory each, and a fake core per file that
     * names its vault and its sample mark. A file's id and mark are what the
     * core would read out of it: `marks[path]` is `null`, `"seeding"` or
     * `"ready"`.
     */
    /** What every fake vault says `core_vault.created_at` is. */
    val foundedAt = "2026-10-01T17:04:09.123Z"

    class Phone(vararg vaults: Triple<String, String, String?>) {

        val dir: File = createTempDirectory("sample-vault").toFile()
        val services = FakePlatformServices()
        val secrets = VaultSecrets(services.secureStore, services.syncedSecrets)
        val opens = mutableListOf<CoreConfiguration>()
        val founds = mutableListOf<FoundContent>()
        val ids = mutableMapOf<String, String>()
        val names = mutableMapOf<String, String>()
        val marks = mutableMapOf<String, String?>()
        var sampleAnswer = "ready"
        private var minted = 0

        fun fileOf(stem: String): File = File(File(dir, stem), Shelf.VAULT_FILE)

        init {
            vaults.forEach { (stem, vaultId, mark) ->
                val path = fileOf(stem).also { it.parentFile.mkdirs(); it.writeText("") }.path
                ids[path] = vaultId
                names[path] = "Vault $vaultId"
                marks[path] = mark
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
                if (configuration.create) File(path).also { it.parentFile.mkdirs(); it.writeText("") }
                CentraidCore.answering(Dispatchers.Unconfined) { asked ->
                    val request = asked.request
                    val found = request?.found
                    when {
                        found != null -> {
                            founds += found.content
                            val sample = found.content == FoundContent.FOUND_CONTENT_SAMPLE
                            if (sample && sampleAnswer == "refused") {
                                Envelope(error = Error(code = ErrorCode.ERROR_CODE_INTERNAL, sentence = "no"))
                            } else {
                                minted += 1
                                val id = if (sample) "v-sample-$minted" else "v-own-$minted"
                                ids[path] = id
                                names[path] = found.display_name
                                marks[path] = when {
                                    !sample -> null
                                    sampleAnswer == "unfinished" -> VaultRoster.SAMPLE_SEEDING
                                    else -> VaultRoster.SAMPLE_READY
                                }
                                Envelope(response = Response(found = FoundResponse(vault_id = id)))
                            }
                        }
                        request?.page != null -> Envelope(
                            response = Response(
                                page = Page(
                                    rows = ids[path]?.let { id ->
                                        listOf(
                                            Row(
                                                values = listOf(
                                                    Value(text = id),
                                                    Value(text = names[path].orEmpty()),
                                                    marks[path]?.let { Value(text = it) } ?: Value(),
                                                    Value(text = foundedAt),
                                                ),
                                            ),
                                        )
                                    }.orEmpty(),
                                ),
                            ),
                        )
                        else -> Envelope(response = Response())
                    }
                }
            },
        )

        /** Every vault directory on disk, by name. */
        fun directories(): List<String> =
            dir.listFiles().orEmpty().filter { it.isDirectory }.map { it.name }.sorted()
    }

    // --- founding -------------------------------------------------------------

    "the sample is founded beside the member's first vault, and the member's vault stays in front" {
        runTest {
            val phone = Phone()
            phone.shelf.load()
            val own = (phone.shelf.found(starters = true) as Shelf.FoundOutcome.Founded).holding
            val sample = phone.shelf.foundSample().shouldBeInstanceOf<Shelf.FoundOutcome.Founded>().holding

            // THE FRONT DID NOT MOVE: the member made their vault and is in it.
            phone.shelf.foreground shouldBe own.vaultId
            phone.shelf.all().map { it.vaultId } shouldBe listOf(own.vaultId, sample.vaultId)
            // WHAT EACH FOUND ASKED THE CORE FOR.
            phone.founds shouldBe listOf(FoundContent.FOUND_CONTENT_STARTERS, FoundContent.FOUND_CONTENT_SAMPLE)
            // THE NAME CAME OUT OF THE VAULT, and is the copy table's.
            sample.name shouldBe SharedCopy.SAMPLE_VAULT_NAME
            sample.sample.shouldBeTrue()
            own.sample.shouldBeFalse()
            phone.shelf.hasSample.value.shouldBeTrue()
            phone.shelf.holdsNoVault.value shouldBe false
            // THE ROSTER SAYS SO, foreground first.
            phone.shelf.roster.value.map { it.sample } shouldBe listOf(false, true)
            phone.shelf.sampleHolding().shouldNotBeNull().vaultId shouldBe sample.vaultId
            phone.directories() shouldHaveSize 2
        }
    }

    "the roster lists the sample last, whichever vault is in front" {
        runTest {
            val phone = Phone()
            phone.shelf.load()
            val own = (phone.shelf.found(starters = true) as Shelf.FoundOutcome.Founded).holding
            val sample = (phone.shelf.foundSample() as Shelf.FoundOutcome.Founded).holding
            phone.shelf.roster.value.map { it.vault_id } shouldBe listOf(own.vaultId, sample.vaultId)

            // STEPPING INTO THE SAMPLE does not move it above the member's own.
            phone.shelf.bringToFront(sample.vaultId).shouldNotBeNull()
            phone.shelf.foreground shouldBe sample.vaultId
            phone.shelf.roster.value.map { it.vault_id } shouldBe listOf(own.vaultId, sample.vaultId)

            // AND A SECOND VAULT OF THE MEMBER'S sorts in front of it too.
            val second = (phone.shelf.found() as Shelf.FoundOutcome.Founded).holding
            phone.shelf.roster.value.map { it.sample } shouldBe listOf(false, false, true)
            phone.shelf.roster.value.last().vault_id shouldBe sample.vaultId
            phone.shelf.roster.value.map { it.vault_id }.toSet() shouldBe
                setOf(own.vaultId, second.vaultId, sample.vaultId)
        }
    }

    "a holding and its lockup carry the vault's founding time, read out of the vault" {
        runTest {
            val phone = Phone()
            phone.shelf.load()
            val own = (phone.shelf.found(starters = true) as Shelf.FoundOutcome.Founded).holding
            own.foundedAt shouldBe foundedAt
            own.lockup().founded_at shouldBe foundedAt
            phone.shelf.roster.value.single().founded_at shouldBe foundedAt
        }
    }

    "the sample opens keyed under the member's seed at an index of its own, recorded against its id" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seed)
            phone.secrets.settleSeed()
            phone.shelf.load()
            val own = (phone.shelf.found() as Shelf.FoundOutcome.Founded).holding
            phone.secrets.vaultIndex(own.vaultId) shouldBe 0
            val before = phone.opens.size
            val sample = (phone.shelf.foundSample() as Shelf.FoundOutcome.Founded).holding

            // ONE OPEN, KEYED AT THE NEXT INDEX, with the member's seed.
            val sampleOpens = phone.opens.drop(before)
            sampleOpens shouldHaveSize 1
            sampleOpens.single().create.shouldBeTrue()
            sampleOpens.single().vaultSeedHex shouldBe seed
            sampleOpens.single().vaultIndex shouldBe 1
            sample.keyed.shouldBeTrue()
            // RECORDED AGAINST THE VAULT'S ID, the pending mark cleared, and the
            // member's own index untouched.
            phone.secrets.vaultIndex(sample.vaultId) shouldBe 1
            phone.secrets.vaultIndex(own.vaultId) shouldBe 0
            phone.secrets.pendingFound().shouldBeNull()
            phone.secrets.nextVaultIndex() shouldBe 2
            // AND THE SAMPLE IS STILL THE SAMPLE: it does not take the front.
            phone.shelf.foreground shouldBe own.vaultId
        }
    }

    "a phone with no seed founds the sample unkeyed and spends no index" {
        runTest {
            val phone = Phone()
            phone.shelf.load()
            phone.shelf.found()
            val before = phone.opens.size
            val sample = (phone.shelf.foundSample() as Shelf.FoundOutcome.Founded).holding

            phone.opens.drop(before).single().vaultSeedHex.shouldBeNull()
            sample.keyed.shouldBeFalse()
            phone.secrets.vaultIndex(sample.vaultId).shouldBeNull()
            phone.secrets.pendingFound().shouldBeNull()
            phone.secrets.nextVaultIndex() shouldBe 0
        }
    }

    "a seed that arrived by sync and is not settled founds the sample unkeyed: its next index would be a guess" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seed)
            phone.secrets.seedSettled().shouldBeFalse()
            phone.shelf.load()
            val before = phone.opens.size

            val sample = (phone.shelf.foundSample() as Shelf.FoundOutcome.Founded).holding

            phone.opens.drop(before).single().vaultSeedHex.shouldBeNull()
            sample.keyed.shouldBeFalse()
            // NOTHING SPENT: the high-water mark is still unset, so the seed is
            // still unsettled and the restore-first path still guards it.
            phone.secrets.anyVaultIndex().shouldBeFalse()
            phone.secrets.seedSettled().shouldBeFalse()
            phone.secrets.pendingFound().shouldBeNull()
        }
    }

    "a refused sample gives its index back, and the next found takes it again" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seed)
            phone.secrets.settleSeed()
            phone.shelf.load()
            val own = (phone.shelf.found() as Shelf.FoundOutcome.Founded).holding
            phone.secrets.nextVaultIndex() shouldBe 1

            // REFUSED BY THE CORE, then answered over a mark still at `seeding`.
            for (answer in listOf(refused, unfinished)) {
                phone.sampleAnswer = answer
                phone.shelf.foundSample().shouldBeInstanceOf<Shelf.FoundOutcome.Refused>()
                phone.secrets.pendingFound().shouldBeNull()
                phone.secrets.nextVaultIndex() shouldBe 1
                phone.directories() shouldBe listOf(File(own.path).parentFile.name)
            }
            phone.sampleAnswer = ready
            val sample = (phone.shelf.foundSample() as Shelf.FoundOutcome.Founded).holding
            phone.secrets.vaultIndex(sample.vaultId) shouldBe 1
        }
    }

    "removing the sample forgets its index, and the high-water mark stays so it is never reused" {
        runTest {
            val phone = Phone()
            phone.secrets.rememberSeed(seed)
            phone.secrets.settleSeed()
            phone.shelf.load()
            phone.shelf.found()
            val sample = (phone.shelf.foundSample() as Shelf.FoundOutcome.Founded).holding
            phone.secrets.vaultIndex(sample.vaultId) shouldBe 1

            phone.shelf.forget(sample.vaultId)

            phone.secrets.vaultIndex(sample.vaultId).shouldBeNull()
            phone.secrets.nextVaultIndex() shouldBe 2
            // "ADD SAMPLE" AGAIN takes a NEW index: whatever the first one
            // sealed is gone with its directory, and it is not derived twice.
            val again = (phone.shelf.foundSample() as Shelf.FoundOutcome.Founded).holding
            phone.secrets.vaultIndex(again.vaultId) shouldBe 2
            phone.secrets.nextVaultIndex() shouldBe 3
        }
    }

    "one sample per device: a second is refused before any file is made" {
        runTest {
            val phone = Phone()
            phone.shelf.load()
            phone.shelf.found()
            phone.shelf.foundSample()
            val directories = phone.directories()

            val again = phone.shelf.foundSample().shouldBeInstanceOf<Shelf.FoundOutcome.Refused>()
            again.because shouldBe Shelf.FoundRefusal.ALREADY_HELD
            phone.directories() shouldBe directories
        }
    }

    "a shelf holding nothing puts the sample in front, and it is still not a vault of the member's own" {
        runTest {
            val phone = Phone()
            phone.shelf.load()
            val sample = (phone.shelf.foundSample() as Shelf.FoundOutcome.Founded).holding
            // A SHELF WITH HOLDINGS ALWAYS HAS A FOREGROUND.
            phone.shelf.foreground shouldBe sample.vaultId
            // AND THE FIRST-LAUNCH GATE STILL OFFERS TO MAKE OR RESTORE ONE.
            phone.shelf.holdsNoVault.value shouldBe true
        }
    }

    // --- a sample that did not seed whole --------------------------------------

    "a sample the core refused leaves no directory, and the member's vault exactly as it was" {
        runTest {
            val phone = Phone()
            phone.shelf.load()
            val own = (phone.shelf.found() as Shelf.FoundOutcome.Founded).holding
            phone.sampleAnswer = refused

            val outcome = phone.shelf.foundSample().shouldBeInstanceOf<Shelf.FoundOutcome.Refused>()
            outcome.because shouldBe Shelf.FoundRefusal.NOT_FOUNDED
            phone.directories() shouldBe listOf(File(own.path).parentFile.name)
            phone.shelf.all().map { it.vaultId } shouldBe listOf(own.vaultId)
            phone.shelf.foreground shouldBe own.vaultId
            phone.shelf.hasSample.value.shouldBeFalse()
        }
    }

    "a sample whose mark still says seeding is not a holding, even when the found answered" {
        runTest {
            val phone = Phone()
            phone.shelf.load()
            val own = (phone.shelf.found() as Shelf.FoundOutcome.Founded).holding
            phone.sampleAnswer = unfinished

            phone.shelf.foundSample().shouldBeInstanceOf<Shelf.FoundOutcome.Refused>()
            phone.directories() shouldBe listOf(File(own.path).parentFile.name)
            phone.shelf.hasSample.value.shouldBeFalse()
        }
    }

    "a process killed mid-seed: the next launch deletes the half-seeded sample and holds the rest" {
        runTest {
            // ON DISK AFTER THE KILL: the member's vault, and a sample whose
            // found's own commit landed (the mark at `seeding`) and whose
            // scenario did not.
            val phone = Phone(
                Triple("centraid-vault-aa", "v-own", null),
                Triple("centraid-vault-bb", "v-half", VaultRoster.SAMPLE_SEEDING),
            )
            phone.shelf.load()

            phone.shelf.all().map { it.vaultId } shouldBe listOf("v-own")
            phone.shelf.foreground shouldBe "v-own"
            phone.shelf.hasSample.value.shouldBeFalse()
            phone.directories() shouldBe listOf("centraid-vault-aa")
            // AND A FRESH ONE CAN BE ADDED.
            phone.shelf.foundSample().shouldBeInstanceOf<Shelf.FoundOutcome.Founded>()
            phone.shelf.hasSample.value.shouldBeTrue()
        }
    }

    "a keyed sample killed mid-seed: the next launch deletes it and gives its spent index back" {
        runTest {
            // ON DISK AFTER THE KILL: the member's vault (index 0, recorded), a
            // sample whose mark still says `seeding`, and the pending mark the
            // found left against the sample's path when it spent index 1.
            val phone = Phone(
                Triple("centraid-vault-aa", "v-own", null),
                Triple("centraid-vault-bb", "v-half", VaultRoster.SAMPLE_SEEDING),
            )
            phone.secrets.rememberSeed(seed)
            phone.secrets.settleSeed()
            phone.secrets.rememberVaultIndex("v-own", 0)
            phone.secrets.reserveVaultIndex(phone.fileOf("centraid-vault-bb").path) shouldBe 1

            phone.shelf.load()

            phone.shelf.all().map { it.vaultId } shouldBe listOf("v-own")
            phone.shelf.hasSample.value.shouldBeFalse()
            phone.directories() shouldBe listOf("centraid-vault-aa")
            // THE INDEX IS BACK, the record never existed, and nothing is pending.
            phone.secrets.pendingFound().shouldBeNull()
            phone.secrets.vaultIndex("v-half").shouldBeNull()
            phone.secrets.nextVaultIndex() shouldBe 1
            // A FRESH SAMPLE takes it.
            val fresh = (phone.shelf.foundSample() as Shelf.FoundOutcome.Founded).holding
            phone.secrets.vaultIndex(fresh.vaultId) shouldBe 1
        }
    }

    "a keyed sample that finished and was killed before its index was recorded is recorded and opened keyed" {
        runTest {
            val phone = Phone(
                Triple("centraid-vault-aa", "v-own", null),
                Triple("centraid-vault-bb", "v-sample", VaultRoster.SAMPLE_READY),
            )
            phone.secrets.rememberSeed(seed)
            phone.secrets.settleSeed()
            phone.secrets.rememberVaultIndex("v-own", 0)
            phone.secrets.reserveVaultIndex(phone.fileOf("centraid-vault-bb").path) shouldBe 1

            phone.shelf.load()

            val sample = phone.shelf.sampleHolding().shouldNotBeNull()
            sample.vaultId shouldBe "v-sample"
            sample.keyed.shouldBeTrue()
            phone.secrets.vaultIndex("v-sample") shouldBe 1
            phone.secrets.pendingFound().shouldBeNull()
            phone.opens.last().vaultIndex shouldBe 1
        }
    }

    "a sample killed before its file existed gives its index back too" {
        runTest {
            val phone = Phone(Triple("centraid-vault-aa", "v-own", null))
            phone.secrets.rememberSeed(seed)
            phone.secrets.settleSeed()
            phone.secrets.rememberVaultIndex("v-own", 0)
            phone.secrets.reserveVaultIndex(File(File(phone.dir, "centraid-vault-zz"), Shelf.VAULT_FILE).path)

            phone.shelf.load()

            phone.secrets.pendingFound().shouldBeNull()
            phone.secrets.nextVaultIndex() shouldBe 1
            phone.shelf.all().map { it.vaultId } shouldBe listOf("v-own")
        }
    }

    "a launch holds a finished sample, keeps the member's vault in front, and never keys the sample under a dev seed" {
        runTest {
            // The sample's directory sorts FIRST, so "the first holding" would
            // have been the sample.
            val phone = Phone(
                Triple("centraid-vault-00", "v-sample", VaultRoster.SAMPLE_READY),
                Triple("centraid-vault-ff", "v-own", null),
            )
            phone.shelf.load(dev = DevSeed(seed))

            phone.shelf.foreground shouldBe "v-own"
            phone.shelf.sampleHolding().shouldNotBeNull().vaultId shouldBe "v-sample"
            phone.secrets.vaultIndex("v-sample").shouldBeNull()
            phone.shelf.sampleHolding().shouldNotBeNull().keyed.shouldBeFalse()
            phone.secrets.vaultIndex("v-own") shouldBe DevSeed.DEMO_INDEX
        }
    }

    // --- removal ---------------------------------------------------------------

    "removing the sample leaves the member's vault in front and the shelf whole" {
        runTest {
            val phone = Phone()
            phone.shelf.load()
            val own = (phone.shelf.found() as Shelf.FoundOutcome.Founded).holding
            val sample = (phone.shelf.foundSample() as Shelf.FoundOutcome.Founded).holding
            // EVEN FROM THE FRONT: the member went to look at the sample.
            phone.shelf.bringToFront(sample.vaultId).shouldNotBeNull()
            phone.shelf.foreground shouldBe sample.vaultId

            phone.shelf.forget(sample.vaultId)

            phone.shelf.foreground shouldBe own.vaultId
            phone.shelf.core().shouldNotBeNull()
            phone.shelf.all().map { it.vaultId } shouldBe listOf(own.vaultId)
            phone.shelf.roster.value.map { it.vault_id } shouldBe listOf(own.vaultId)
            phone.shelf.hasSample.value.shouldBeFalse()
            phone.shelf.holdsNoVault.value shouldBe false
            phone.directories() shouldBe listOf(File(own.path).parentFile.name)
        }
    }

    // --- what reads the mark ---------------------------------------------------

    "the identify read asks the vault for its mark, and only a finished sample is drawn as one" {
        runTest {
            VaultRoster.QUERY.select shouldBe listOf(
                "vault_id",
                "display_name",
                "json_extract(settings_json, '$.sample') AS sample",
                // WHEN IT WAS FOUNDED, for Home's notice slot (R-SAMPLE-8).
                "created_at",
            )
            fun core(mark: String?) = CentraidCore.answering(Dispatchers.Unconfined) {
                Envelope(
                    response = Response(
                        page = Page(
                            rows = listOf(
                                Row(values = listOf(Value(text = "v"), Value(text = "Sample"), mark?.let { Value(text = it) } ?: Value())),
                            ),
                        ),
                    ),
                )
            }
            VaultRoster.name(core(VaultRoster.SAMPLE_READY)).shouldNotBeNull().let {
                it.lockup.sample.shouldBeTrue()
                it.unfinishedSample.shouldBeFalse()
            }
            VaultRoster.name(core(VaultRoster.SAMPLE_SEEDING)).shouldNotBeNull().let {
                it.lockup.sample.shouldBeFalse()
                it.unfinishedSample.shouldBeTrue()
            }
            VaultRoster.name(core(null)).shouldNotBeNull().let {
                it.lockup.sample.shouldBeFalse()
                it.unfinishedSample.shouldBeFalse()
            }
        }
    }

    "the drain walks every vault but the sample" {
        runTest {
            fun holding(id: String, sample: Boolean) = Shelf.Holding(
                vaultId = id,
                path = "/v/$id/vault.db",
                name = id,
                core = CentraidCore.answering(Dispatchers.Unconfined) { Envelope(request_id = 0) },
                sample = sample,
            )
            val built = mutableListOf<Int>()
            val drain = ShelfDrain(
                holdings = { listOf(holding("own", sample = false), holding("sample", sample = true)) },
                doorFor = {
                    built += 1
                    object : DrainDoor {
                        override suspend fun drain(deadlineMs: Long): DrainAnswer? =
                            DrainAnswer(1, 0, DrainAnswer.Stopped.EMPTY, lastAckedAtMs = 1)
                    }
                },
                nowMs = { 0 },
            )
            drain.run(60_000).map { it.vaultId } shouldBe listOf("own")
            built shouldHaveSize 1
        }
    }

    "the pairing screen over the sample says where pairing is, and takes no code" {
        val open = PairLaptopMachine.reduce(
            PairLaptopMachine.initial(),
            PairInput.View(PairLaptopEvent(opened = PairLaptopEvent.Opened(camera = true))),
        ).model
        val state = PairLaptopMachine.reduce(open, PairInput.Readiness(Readiness.SAMPLE)).model.state
        state.phase shouldBe PairLaptopState.Phase.PHASE_NEEDS_WORDS
        state.notice shouldBe CustodyCopy.PAIR_SAMPLE
        state.notice shouldBe SharedCopy.SAMPLE_NO_PAIR
    }

    "the sample's words are signage: a name, one sentence, and two verbs" {
        Shelf.SAMPLE_VAULT_NAME shouldBe "Sample"
        SharedCopy.SAMPLE_LINE shouldBe "A sample vault is here to look around in. Remove it when you are done."
        SharedCopy.SAMPLE_REMOVE shouldBe "Remove sample"
        SharedCopy.SAMPLE_ADD shouldBe "Add sample"
        SharedCopy.SAMPLE_ADDING shouldBe "Adding sample"
        listOf(SharedCopy.SAMPLE_REMOVE, SharedCopy.SAMPLE_ADD, SharedCopy.SAMPLE_ADDING).forEach { label ->
            label.split(' ').size shouldBe 2
        }
    }

    "nothing here is left over after a refused sample's directory goes" {
        runTest {
            val phone = Phone()
            phone.shelf.load()
            phone.sampleAnswer = refused
            phone.shelf.foundSample()
            phone.directories().shouldBeEmpty()
            phone.shelf.holdsNoVault.value shouldBe true
            phone.shelf.foreground.shouldBeNull()
            phone.sampleAnswer = ready
        }
    }
})
