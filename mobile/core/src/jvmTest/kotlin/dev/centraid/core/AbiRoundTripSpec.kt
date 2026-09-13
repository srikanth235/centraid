package dev.centraid.core

import centraid.core.v1.Command
import centraid.core.v1.Envelope
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.PageRequest
import centraid.core.v1.Principal
import centraid.core.v1.PrincipalKind
import centraid.core.v1.Request
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.longs.shouldBeGreaterThan
import io.kotest.matchers.longs.shouldBeLessThan
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.Dispatchers
import okio.ByteString.Companion.toByteString
import java.io.File
import kotlin.time.TimeSource

/**
 * A REAL ROUND TRIP, KOTLIN TO RUST AND BACK (#1020 wave 3 lane E exit item 2).
 *
 * `open → call → next_event → free → close` from Kotlin, over JNA, against the
 * `libcentraid_core_ffi.so` this repository's own `cargo build` produced, on a
 * vault `crates/core-ffi`'s `spike-fixture` binary founded. Nothing is faked
 * and nothing is skipped: if the library or the fixture is missing the spec
 * FAILS and names the command, because a binding test that skipped would read
 * green on a machine where the ABI does not work at all.
 *
 * It also measures. The numbers are `ci-linux-x64-4c` numbers and a **floor**,
 * not a device answer — `contracts/ledgers/gate-budgets.json#mobile-jvm` is
 * seeded from them at three times the measured p95, and the device half is an
 * owner hand-off (`mobile/README.md`).
 *
 * The three screens' read messages are the ones the state machines in `:shared`
 * actually send, so the budget is over the product's reads and not over a
 * synthetic one.
 */
class AbiRoundTripSpec : StringSpec({

    "open, call, next_event, free and close, against the real library" {
        val core = openRealCore()
        try {
            // --- the handshake already happened inside `open` ---------------
            //
            // `Hello` is the one request a thin seat answers locally, so it is
            // the only one safe to make before the shell knows what it is
            // talking to. `open` refuses if it does not come back.
            core.reportedIdentity.schemaVersion shouldBeGreaterThan 0L
            // A development core: the identity check did NOT run, and says so.
            core.identityWarning shouldNotBe null
            core.identityWarning!! shouldContain "NOT CHECKED"

            // --- the seeded read -------------------------------------------
            val parties = core.call(pageRequest(SEEDED_QUERY, limit = 100))
            parties.shouldBeAnsweredWith { envelope ->
                val page = envelope.response?.page ?: error("a Page response")
                page.rows.size shouldBe 100
                // A keyset cursor, never an offset; absent only when the rows
                // ended, and 200 were seeded.
                page.next shouldNotBe null
                page.rows.first().values.size shouldBe 2
            }

            // --- a write, through the real command plane -------------------
            val outcome = core.call(
                Envelope(
                    request_id = 7,
                    request = Request(
                        command = Command(
                            name = "core.add_party",
                            input = """{"display_name":"Kotlin $runTag","kind":"person"}"""
                                .encodeToByteArray()
                                .toByteString(),
                            invoke_key = "mobile-abi-round-trip-$runTag",
                            principal = Principal(
                                kind = PrincipalKind.PRINCIPAL_KIND_OWNER_DEVICE,
                                caller_id = "mobile-round-trip-device",
                            ),
                        ),
                    ),
                ),
            )
            // WHATEVER THE ANSWER IS, IT IS TYPED — and there are exactly two
            // answers this may be, both asserted.
            //
            // FINDING, REPRODUCED HERE (`contracts/handoff/E/findings.md`):
            // `Vault::open` defaults to `SeededIds::new("v1")`
            // (`crates/vault/src/file.rs:97`), whose counter starts at zero on
            // every open, so the FIRST WRITE AFTER A REOPEN mints an id the
            // previous session already used. The fixture vault was founded and
            // seeded by `spike-fixture` in one session; this is a second, and
            // the write is refused with `ERROR_CODE_INTERNAL` and a raw
            // predicate as its owner-facing sentence.
            //
            // The assertion admits both outcomes on purpose: it must not go
            // green on any OTHER failure, and it must not have to be edited
            // when the id default is fixed.
            when (outcome) {
                is CoreOutcome.Answered -> {
                    val command = outcome.value.response?.command
                        ?: error("a CommandOutcome")
                    println(
                        """{"marker":"abi-command","status":"${command.status}"}""",
                    )
                }
                is CoreOutcome.Failed -> {
                    val failure = outcome.failure
                    (failure is CoreFailure.Refused).shouldBeTrue()
                    failure as CoreFailure.Refused
                    println(
                        """{"marker":"abi-command","refused":"${failure.detail}"}""",
                    )
                    failure.detail shouldContain "entity id is already held"
                }
            }

            // --- the event path --------------------------------------------
            //
            // Zero events is the expected answer on a quiet core, and what the
            // drain proves is clause 6: the timeout path allocates nothing, so
            // the buffer accounting does not move.
            val beforeDrain = core.buffersHandedOver
            val reader = core.startReader(timeoutMs = 25)
            Thread.sleep(150)
            core.buffersHandedOver shouldBe beforeDrain

            // --- clause 1, over the whole session --------------------------
            core.buffersFreed shouldBe core.buffersHandedOver
            core.bytesCopied shouldBeGreaterThan 0L

            core.close()
            reader.join()
            core.lifecycle.value shouldBe CoreLifecycle.Closed

            // --- clause 8 --------------------------------------------------
            core.call(pageRequest(SEEDED_QUERY, limit = 1)) shouldBe
                CoreOutcome.Failed(CoreFailure.Closed)
        } finally {
            core.close()
        }

        // --- one core per device process (R-1020-24) ------------------------
        //
        // In v0 this was a `<seat>.lease.json` sidecar PLUS
        // `useNewConnection: true`, and both halves were needed and neither was
        // enough (census §E seam 1). With the core owning the file the two
        // collapse into one rule — and the rule has to be enforced where a
        // second opener would ask, including an app extension sharing the
        // process.
        //
        // IN THE SAME TEST BLOCK as the round trip, deliberately: a
        // process-wide guard cannot be asserted from two test bodies that
        // Kotest may interleave, and a test that passed or failed on the
        // scheduler is not a test of the guard.
        val first = openRealCore()
        try {
            CentraidCore.open(
                configuration(),
                Dispatchers.IO,
                AbiContractSpec.UI_THREAD,
            ) shouldBe CoreOutcome.Failed(
                CoreFailure.BadArgument(
                    "a core is already open in this process. ONE CORE PER DEVICE PROCESS " +
                        "(R-1020-24): app extensions never open the vault.",
                ),
            )
        } finally {
            first.close()
        }

        // --- the artifact-identity verdict ---------------------------------
        //
        // `Hello` carries no digest today (see `CentraidCore.identityOf`), so
        // the core reports `dev` and `requireDigest` takes the NOT-CHECKED
        // branch — the same branch `crates/centraid/src/identity.rs` takes, and
        // the allowance is NEVER SILENT: the warning names both sides. What it
        // does not do is what a released shell needs, which is why the wire
        // field is a finding with a patch rather than a note.
        val released = CentraidCore.open(
            configuration().copy(expectedDigest = "b8b1e0f2c3d4e5f6"),
            Dispatchers.IO,
            AbiContractSpec.UI_THREAD,
        )
        val opened = (released as CoreOutcome.Answered).value
        try {
            opened.identityWarning!! shouldContain "NOT CHECKED"
            opened.identityWarning!! shouldContain "this core is a development build"
            opened.identityWarning!! shouldContain "b8b1e0f2c3d4e5f6"
        } finally {
            opened.close()
        }
    }

    "the five calls' latencies, and the call budget for the three screens' reads" {
        val core = openRealCore()
        try {
            val report = StringBuilder("{\"marker\":\"mobile-jvm-abi\",\"reads\":{")
            SCREEN_READS.entries.forEachIndexed { index, (screen, query) ->
                val samples = LongArray(SAMPLES)
                // Warm up unmeasured: the first calls pay for JNA's
                // method-handle setup and the JIT's first look at the loop.
                repeat(WARMUP) { core.call(pageRequest(query, limit = query.limit)) }
                for (sample in 0 until SAMPLES) {
                    val started = TimeSource.Monotonic.markNow()
                    val answer = core.call(pageRequest(query, limit = query.limit))
                    samples[sample] = started.elapsedNow().inWholeMicroseconds
                    (answer is CoreOutcome.Answered).shouldBeTrue()
                }
                samples.sort()
                val p50 = samples[SAMPLES / 2]
                val p95 = samples[(SAMPLES * 95) / 100]
                if (index > 0) report.append(',')
                report.append("\"$screen\":{\"p50Us\":$p50,\"p95Us\":$p95}")
                // THE BUDGET IS A CEILING AND NOT A MEASUREMENT. It exists so a
                // request that got an order of magnitude slower reds the gate;
                // the number that goes in the ledger is three times the
                // measured p95, which lane G writes with `measure --write`.
                p95 shouldBeLessThan CALL_CEILING_US
            }
            report.append("},\"samplesPerRead\":$SAMPLES,\"ceilingUs\":$CALL_CEILING_US}")
            println(report)
            File(System.getProperty("centraid.core.fixtureDir"), "mobile-jvm-abi.json")
                .writeText(report.toString())
        } finally {
            core.close()
        }
    }
    "the other four symbols, timed" {
        // `free` HAS NO NUMBER OF ITS OWN and cannot have one: the contract
        // requires it inside the same harvest as the call that allocated, so
        // its cost is already inside the `call` figures above. A separate
        // `free` measurement would mean a binding that held a buffer across
        // two calls, which is the shape clause 1 exists to forbid.
        val openStarted = TimeSource.Monotonic.markNow()
        val core = openRealCore()
        val openUs = openStarted.elapsedNow().inWholeMicroseconds
        val drains = 100
        val drainStarted = TimeSource.Monotonic.markNow()
        repeat(drains) { core.drainOnce(timeoutMs = 0) }
        val nextEventUs = drainStarted.elapsedNow().inWholeMicroseconds / drains
        val closeStarted = TimeSource.Monotonic.markNow()
        core.close()
        val closeUs = closeStarted.elapsedNow().inWholeMicroseconds
        println(
            """{"marker":"mobile-jvm-symbols","openUs":$openUs,""" +
                """"nextEventTimeoutUs":$nextEventUs,"closeUs":$closeUs,""" +
                """"freeUs":"inside call, by contract"}""",
        )
        // `open` founds nothing here and the file exists, so this is the cost
        // of a SQLite open plus the handshake round trip.
        (openUs > 0L).shouldBeTrue()
    }
}) {
    companion object {
        /**
         * One tag per JVM, so the write below is a NEW party on every run even
         * if a fixture vault outlives one. The fixture task rebuilds the vault
         * unconditionally, and this is the belt to that brace: a gateway core
         * with an injected clock mints deterministic ids, so a second identical
         * `core.add_party` collides (see the receipt's findings).
         */
        private val runTag: String = java.lang.Long.toHexString(System.nanoTime())

        private const val SAMPLES = 200
        private const val WARMUP = 50

        /**
         * 50 ms, the same ceiling `crates/xtask`'s `call-budget` step holds the
         * Rust side to. A JVM binding that needed a looser one would be a
         * binding the product could not ship, so the ceiling is shared rather
         * than relaxed per language.
         */
        private const val CALL_CEILING_US = 50_000L

        /** The 200 parties `spike-fixture` seeds. */
        private val SEEDED_QUERY = ScreenRead(
            name = "abi.round-trip",
            select = listOf("party_id", "created_at"),
            from = "core_party",
            sortColumn = "created_at",
            pkColumn = "party_id",
            limit = 100,
        )

        /**
         * THE THREE SCREENS' READS, over the real tables
         * (`contracts/schema/vault-ddl.sql`): `tally_expense`, `media_asset`,
         * `knowledge_note`. The fixture vault has rows in `core_party` and none
         * in these three, so these numbers are a **bounded read's floor** — the
         * SQL plan, the protobuf round trip and the JNA marshalling are real and
         * the row copy is not. The device measurement at 50k assets is the
         * owner's, and `docs/mobile-offline.md` says which number decides what.
         */
        private val SCREEN_READS = mapOf(
            "tally.list" to ScreenRead(
                name = "tally.list",
                select = listOf("expense_id", "description", "amount_minor", "currency"),
                from = "tally_expense",
                sortColumn = "created_at",
                pkColumn = "expense_id",
                limit = 50,
            ),
            "photos.grid" to ScreenRead(
                name = "photos.grid",
                select = listOf("asset_id", "kind", "captured_at"),
                from = "media_asset",
                sortColumn = "captured_at",
                pkColumn = "asset_id",
                limit = 120,
            ),
            "notes.editor" to ScreenRead(
                name = "notes.editor",
                select = listOf("note_id", "title", "format", "pinned"),
                from = "knowledge_note",
                sortColumn = "created_at",
                pkColumn = "note_id",
                limit = 30,
            ),
        )

        data class ScreenRead(
            val name: String,
            val select: List<String>,
            val from: String,
            val sortColumn: String,
            val pkColumn: String,
            val limit: Int,
        )

        fun pageRequest(read: ScreenRead, limit: Int): Envelope = Envelope(
            request_id = 1,
            request = Request(
                page = PageRequest(
                    query = PageQuery(
                        name = read.name,
                        // The projection must carry BOTH order columns: there
                        // is no `key_of` callback, so the cursor is read off
                        // the row by the columns the ORDER BY names.
                        select = (read.select + read.sortColumn + read.pkColumn).distinct(),
                        from = read.from,
                        order = PageOrder(
                            sort_column = read.sortColumn,
                            pk_column = read.pkColumn,
                            descending = false,
                        ),
                    ),
                    // REQUIRED with no default: "a default is how an unbounded
                    // read gets written by accident".
                    limit = limit,
                ),
            ),
        )

        fun configuration(): CoreConfiguration {
            val fixtureDir = System.getProperty("centraid.core.fixtureDir")
                ?: error("centraid.core.fixtureDir is unset; see mobile/core/build.gradle.kts")
            val vault = File(fixtureDir, "spike-vault.db")
            check(vault.exists()) {
                "the ABI fixture vault is missing. Build it with:\n" +
                    "  cargo run -p centraid-core-ffi --bin spike-fixture -- $fixtureDir\n" +
                    "Gradle's :core:abiFixture task does this; a missing fixture is a red " +
                    "and never a skip (#1020 wave 3 lane E)."
            }
            val libraryDir = System.getProperty("centraid.core.libDir")
            check(
                File(libraryDir, "libcentraid_core_ffi.so").exists() ||
                    File(libraryDir, "libcentraid_core_ffi.dylib").exists(),
            ) {
                "libcentraid_core_ffi is not in $libraryDir. Build it with:\n" +
                    "  cargo build -p centraid-core-ffi\n" +
                    "or point the build at another directory with " +
                    "-Pcentraid.coreLibDir=<dir>. A missing library is a red and never a skip."
            }
            return CoreConfiguration(
                databasePath = vault.path,
                role = CoreRole.GATEWAY,
                create = false,
                expectedDigest = ArtifactIdentity.DEV,
            )
        }

        suspend fun openRealCore(): CentraidCore {
            val outcome = CentraidCore.open(
                configuration(),
                Dispatchers.IO,
                AbiContractSpec.UI_THREAD,
            )
            return when (outcome) {
                is CoreOutcome.Answered -> outcome.value
                is CoreOutcome.Failed -> error("the real core did not open: ${outcome.failure}")
            }
        }

        inline fun CoreOutcome<Envelope>.shouldBeAnsweredWith(block: (Envelope) -> Unit) {
            when (this) {
                is CoreOutcome.Answered -> block(value)
                is CoreOutcome.Failed -> error("refused: $failure")
            }
        }
    }
}
