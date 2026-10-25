package dev.centraid.shared

import centraid.core.v1.AppQueryResponse
import centraid.core.v1.ErrorCode
import centraid.core.v1.PageCursor
import centraid.screen.v1.ReadFailureKind
import dev.centraid.core.CoreFailure
import dev.centraid.shared.apps.health.HealthHomeMachine
import dev.centraid.shared.apps.health.HealthHomeReads
import dev.centraid.shared.apps.health.HealthMetricMachine
import dev.centraid.shared.apps.health.HealthMetricReads
import dev.centraid.shared.apps.health.HealthWorkoutMachine
import dev.centraid.shared.apps.health.HealthWorkoutReads
import dev.centraid.shared.apps.people.PeopleEditorMachine
import dev.centraid.shared.apps.people.PeopleEditorReads
import dev.centraid.shared.apps.people.PeopleHomeMachine
import dev.centraid.shared.apps.people.PeopleHomeReads
import dev.centraid.shared.apps.people.PeoplePersonMachine
import dev.centraid.shared.apps.people.PeoplePersonReads
import dev.centraid.shared.apps.people.PeopleTrashMachine
import dev.centraid.shared.apps.people.PeopleTrashReads
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.kit.TrashReads
import dev.centraid.shared.shell.HomeMachine
import dev.centraid.shared.shell.HomeReads
import dev.centraid.shared.shell.HomeSearchMachine
import dev.centraid.shared.shell.HomeSearchReads
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenRuntime
import dev.centraid.shared.sync.fromCore
import dev.centraid.shared.sync.sentenceFor
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.ints.shouldBeGreaterThan
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import java.io.File

/**
 * THE THREE APP SCREENS' READS (#1025 S5, lane L5).
 *
 * Everything here runs on the JVM with no ABI, because everything here is the
 * part of a read that is DATA: the statement, the projection off a `Row`, and
 * the sentence a refusal becomes. What needs a real vault — that the door
 * answers this statement at all — is the device contract's job, and a test that
 * mocked a core to assert a mock's answer would prove only that the mock was
 * written to match.
 */
class AppReadsSpec : StringSpec({

    /**
     * EVERY TABLE IN THE VAULT, from the DDL the vault is built from.
     *
     * The universe the app-query law below is asked over: a machine can only
     * be asked "is this yours" one table at a time, so "exactly these" means
     * asking it about every table there is.
     */
    val vaultTables: Set<String> by lazy {
        val root = File(System.getProperty("centraid.repositoryRoot") ?: error("unset"))
        Regex("""(?m)^CREATE TABLE (\w+) \(""")
            .findAll(root.resolve("contracts/schema/vault-ddl.sql").readText())
            .map { it.groupValues[1] }
            .toSet()
    }

    /** The tables [machine] re-reads on, asked of it over every vault table. */
    fun reactsTo(machine: ScreenMachine<*, *>): Set<String> =
        vaultTables.filter { machine.rowsChanged(it, listOf("k")) != null }.toSet()

    /**
     * THE APP-QUERY SCREENS (#1046), beside their machines. An app query names
     * no table the runtime can see, so each declares `tables` — and the law
     * is that the declaration and the machine agree EXACTLY.
     */
    val queryScreens: List<Triple<String, ScreenQueries<*, *>, ScreenMachine<*, *>>> = listOf(
        Triple("people.home", PeopleHomeReads, PeopleHomeMachine),
        Triple("people.person", PeoplePersonReads, PeoplePersonMachine),
        Triple("people.editor", PeopleEditorReads, PeopleEditorMachine),
        Triple("people.trash", PeopleTrashReads, PeopleTrashMachine),
        // HEALTH (#1129). Home reads the days, the workouts, their kinds and whether a
        // store is connected; a metric only the days; a workout its activity and kind.
        Triple("health.home", HealthHomeReads, HealthHomeMachine),
        Triple("health.metric", HealthMetricReads, HealthMetricMachine),
        Triple("health.workout", HealthWorkoutReads, HealthWorkoutMachine),
        // HOME'S SEARCH (R-CHROME-6). Like the powerbox it declares no table:
        // a transient screen over search results re-reads on a new term only.
        Triple("home.search", HomeSearchReads, HomeSearchMachine),
    )

    "an app-query screen's tables are exactly the tables its machine re-reads on" {
        // THE SAME PAIRING AS A PAGE READ'S, and a stricter one: a page read
        // has one table, an app query several, and a table read and not
        // re-read on is a screen that goes stale on sync with nothing red.
        vaultTables.size shouldBeGreaterThan 35
        withClue("home reads ${HomeReads.TABLES - vaultTables}") {
            vaultTables.containsAll(HomeReads.TABLES) shouldBe true
        }
        queryScreens.forEach { (name, queries, machine) ->
            withClue(name) {
                withClue("absent from the DDL: ${queries.tables - vaultTables}") {
                    vaultTables.containsAll(queries.tables) shouldBe true
                }
                reactsTo(machine) shouldBe queries.tables
            }
        }
        // HOME IS HELD TO IT TOO: its page reads' tables plus the ones
        // Agenda's tile query declares, and not one table more.
        reactsTo(HomeMachine) shouldBe HomeReads.TABLES
    }

    "the cursor pair survives the one string a screen carries" {
        // `PageCursor` IS A PAIR and `next_cursor` is one string, so the two
        // halves are spelled with a separator. A cursor that did not round-trip
        // would be a second page that silently repeats the first.
        //
        // The separator is `|`, the runtime's own spelling.
        val cursor = PageCursor(sort_key = "2026-02-03", pk = "exp-1")
        ScreenRuntime.encodeCursor(cursor) shouldBe "2026-02-03|exp-1"
        ScreenRuntime.decodeCursor(ScreenRuntime.encodeCursor(cursor)) shouldBe cursor
        // THE FIRST PAGE IS `null`, not "start from zero" — for a pruned feed
        // those are different requests.
        ScreenRuntime.decodeCursor(null) shouldBe null
        // A STRING THIS RUNTIME DID NOT WRITE IS NOT A CURSOR. Dropped rather
        // than split at a guess, which starts the walk again instead of paging
        // under a mangled key.
        ScreenRuntime.decodeCursor("not-a-cursor") shouldBe null
    }

    "every refusal reaches a member as a sentence and never as a detail" {
        // ONE MAPPING, SHARED. This is the function `HomeRuntime` uses and the
        // one `ScreenRuntime` uses; a second copy would answer "what does a
        // member read when a read is refused" differently depending on which
        // screen they were on, and nothing would fail.
        ErrorCode.values().forEach { code ->
            withClue(code.name) { sentenceFor(code).sentence.isNotEmpty() shouldBe true }
        }
        sentenceFor(ErrorCode.ERROR_CODE_UNAUTHORIZED).kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_REFUSED
        // AN UNREACHABLE GATEWAY IS UNAVAILABLE AND NOT REFUSED: one is waited
        // out and the other is not, and the remedy differs.
        sentenceFor(ErrorCode.ERROR_CODE_PEER_UNREACHABLE).kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_UNAVAILABLE
        sentenceFor(ErrorCode.ERROR_CODE_TIMEOUT).kind shouldBe
            ReadFailureKind.READ_FAILURE_KIND_UNAVAILABLE
        sentenceFor(ErrorCode.ERROR_CODE_VERSION_WINDOW).remedy shouldBe "Update Centraid."
    }

    "a closed core is a restart, and it keeps the words the core wrote" {
        // EVERY `CoreFailure` ALREADY CARRIES A SENTENCE, written for a member
        // by the layer that refused. This maps the KIND and keeps the words;
        // re-writing them would be a second vocabulary for one refusal.
        val closed = CoreFailure.Closed
        val mapped = fromCore(closed)
        mapped.kind shouldBe ReadFailureKind.READ_FAILURE_KIND_CORE_RESTARTED
        mapped.sentence shouldBe closed.sentence
    }
})
