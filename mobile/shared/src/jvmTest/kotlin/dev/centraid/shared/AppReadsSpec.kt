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
import dev.centraid.shared.apps.locker.LOCKER_TRASH
import dev.centraid.shared.apps.locker.LockerAccessMachine
import dev.centraid.shared.apps.locker.LockerAccessReads
import dev.centraid.shared.apps.locker.LockerEditorMachine
import dev.centraid.shared.apps.locker.LockerEditorReads
import dev.centraid.shared.apps.locker.LockerExportMachine
import dev.centraid.shared.apps.locker.LockerExportReads
import dev.centraid.shared.apps.locker.LockerGeneratorMachine
import dev.centraid.shared.apps.locker.LockerGeneratorReads
import dev.centraid.shared.apps.locker.LockerHomeMachine
import dev.centraid.shared.apps.locker.LockerHomeReads
import dev.centraid.shared.apps.locker.LockerImportMachine
import dev.centraid.shared.apps.locker.LockerImportReads
import dev.centraid.shared.apps.locker.LockerItemMachine
import dev.centraid.shared.apps.locker.LockerItemReads
import dev.centraid.shared.apps.locker.LockerTrashMachine
import dev.centraid.shared.apps.money.MoneyAccountsMachine
import dev.centraid.shared.apps.money.MoneyAccountsReads
import dev.centraid.shared.apps.money.MoneyCategoriesMachine
import dev.centraid.shared.apps.money.MoneyCategoriesReads
import dev.centraid.shared.apps.money.MoneyHomeMachine
import dev.centraid.shared.apps.money.MoneyHomeReads
import dev.centraid.shared.apps.money.MoneyImportMachine
import dev.centraid.shared.apps.money.MoneyImportReads
import dev.centraid.shared.apps.money.MoneyRecurringMachine
import dev.centraid.shared.apps.money.MoneyRecurringReads
import dev.centraid.shared.apps.money.MoneyRulesMachine
import dev.centraid.shared.apps.money.MoneyRulesReads
import dev.centraid.shared.apps.money.MoneySearchMachine
import dev.centraid.shared.apps.money.MoneySearchReads
import dev.centraid.shared.apps.money.MoneyTargetMachine
import dev.centraid.shared.apps.money.MoneyTargetReads
import dev.centraid.shared.apps.money.MoneyTransactionMachine
import dev.centraid.shared.apps.money.MoneyTransactionReads
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
     * Every screen's reads beside the machine that emits its effects.
     *
     * A list and not three copies of one test: the properties below are laws
     * for every app screen, and a fourth app that got its own hand-written test
     * would be a fourth chance to leave one out.
     */
    val screens: List<Triple<String, ScreenReads<*, *>, ScreenMachine<*, *>>> = listOf(
        // LOCKER (#1047): the kit's trash over `entity`, kind `locker_item` (#1135). The statement is
        // the kit's own; `LockerTrashReads` adds only the gate in front of it
        // (`LockerSpec`).
        Triple("locker.trash", TrashReads(LOCKER_TRASH), LockerTrashMachine),
    )

    /** The statement each screen makes when it is holding a state that can read. */
    fun statementOf(name: String) = when (name) {
        // A PARAMETERISED SCREEN IS ASKED IN THE STATE IT WOULD REALLY READ IN.
        // `query` returns null when a screen cannot yet say what to read, so a
        // shelf asked with no shelf, a lightbox with no asset or a review with
        // no cluster would answer null and this whole spec would pass over an
        // empty statement — proving nothing about the screens most likely to
        // get their projection wrong. Each is driven through its own `Opened`,
        // which is how the parameter reaches the state in the product.
        "locker.trash" -> TrashReads(LOCKER_TRASH).query(LockerTrashMachine.initial(), null)
        else -> error("no statement for $name")
    }

    "every screen's select carries both order columns" {
        // THE DOOR HAS NO `key_of` CALLBACK, so the cursor is read off the row
        // by the two columns the ORDER BY names (`statement.ts:43-48`). A
        // statement that orders by a column it did not project produces a walk
        // that is not a walk: the second page starts from an empty key and
        // repeats the first.
        screens.forEach { (name, _, _) ->
            val query = statementOf(name).shouldNotBeNull()
            val order = query.order.shouldNotBeNull()
            withClue("$name selects ${query.select}") {
                query.select.contains(order.sort_column) shouldBe true
                query.select.contains(order.pk_column) shouldBe true
            }
        }
    }

    "every screen reads the table its machine says it re-reads on" {
        // THE PAIRING, ASSERTED MECHANICALLY. `rowsChanged` is what makes a
        // screen move when a row arrives from sync, and it is the machine's own
        // declaration of a table name; the query is where the rows actually
        // come from. When the two part company nothing fails — the screen
        // simply stops redrawing on sync, and the symptom is a list that is
        // right only after a relaunch. So the machine is asked, rather than the
        // table being re-listed here: a query that moves to another table
        // without updating `rowsChanged` makes this RED.
        screens.forEach { (name, reads, machine) ->
            val query = statementOf(name).shouldNotBeNull()
            withClue("$name reads ${query.from}") {
                query.from shouldBe reads.table
                // The machine answers an event for its own table and null for
                // any other, which is the only way to ask it what its table is
                // without it declaring it twice.
                machine.rowsChanged(reads.table, listOf("k")).shouldNotBeNull()
                machine.rowsChanged(reads.table + "_other", listOf("k")) shouldBe null
            }
        }
    }

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
        // LOCKER (#1047). Every read screen shares one table set — the item,
        // its sidecars and its tags; the generator reads none.
        Triple("locker.home", LockerHomeReads, LockerHomeMachine),
        Triple("locker.item", LockerItemReads, LockerItemMachine),
        Triple("locker.editor", LockerEditorReads, LockerEditorMachine),
        Triple("locker.generator", LockerGeneratorReads, LockerGeneratorMachine),
        // #1047 T2: the item page reads its access history (`receipt`);
        // export and import read the shelf's counts.
        Triple("locker.export", LockerExportReads, LockerExportMachine),
        Triple("locker.import", LockerImportReads, LockerImportMachine),
        // Q-1047-21: the whole Locker's access history reads the receipts and
        // the two tables a receipt's item and field are named from.
        Triple("locker.access", LockerAccessReads, LockerAccessMachine),
        // MONEY (#1099). Every screen reads the same table set: one app query folds
        // accounts, lines, targets, rules, checkpoints, categories and transfer links.
        Triple("money.home", MoneyHomeReads, MoneyHomeMachine),
        Triple("money.transaction", MoneyTransactionReads, MoneyTransactionMachine),
        Triple("money.target", MoneyTargetReads, MoneyTargetMachine),
        Triple("money.recurring", MoneyRecurringReads, MoneyRecurringMachine),
        Triple("money.import", MoneyImportReads, MoneyImportMachine),
        Triple("money.accounts", MoneyAccountsReads, MoneyAccountsMachine),
        Triple("money.rules", MoneyRulesReads, MoneyRulesMachine),
        Triple("money.categories", MoneyCategoriesReads, MoneyCategoriesMachine),
        Triple("money.search", MoneySearchReads, MoneySearchMachine),
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
