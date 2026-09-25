package dev.centraid.core

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.core.v1.TallyDashboard
import centraid.core.v1.TallyDashboardRequest
import centraid.core.v1.TallyExpenseRequest
import centraid.core.v1.TallyExportRequest
import centraid.core.v1.TallyFriendRequest
import centraid.core.v1.TallyGroupRequest
import centraid.core.v1.TallyRole
import centraid.core.v1.TallySearchRequest
import centraid.core.v1.TallySettleUpRequest
import centraid.core.v1.TallySpendingRequest
import centraid.core.v1.TallyTrashRequest
import dev.centraid.core.AbiRoundTripSpec.Companion.openRealCore
import dev.centraid.core.AbiRoundTripSpec.Companion.shouldBeAnsweredWith
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.types.shouldBeInstanceOf
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID
import okio.ByteString.Companion.encodeUtf8

/**
 * TALLY'S QUERIES, KOTLIN TO RUST AND BACK (#1046).
 *
 * The phone's Tally read one table through a page and had no balances, no
 * names and `Money.exponent = 0` for every currency. `app_query`'s Tally arms
 * (50–59) run `crates/apps/tally`'s fold — the ledger read once, every figure
 * through the one balance engine — and answer typed messages whose every money
 * carries the exponent the kit states. Nothing here adds, attributes or
 * divides: that is the point.
 *
 * Over JNA, against the real `libcentraid_core_ffi` and the vault
 * `spike-fixture` founded — nothing faked. The fixture is shared by every spec
 * in the run, so each run names its own friends and groups and asks about
 * those.
 */
class TallyQueryRoundTripSpec : StringSpec({

    "the dashboard, a group, a friend and settle-up answer through the one engine" {
        val core = openRealCore()
        try {
            val run = UUID.randomUUID().toString().take(8)
            val me = core.dashboard().me ?: error("founding names the owner")
            val ana = core.write("tally.add_friend", """{"name":"Ana $run"}""", "party_id")
            val bo = core.write("tally.add_friend", """{"name":"Bo $run"}""", "party_id")
            val tokyo = core.write(
                "tally.create_group",
                """{"name":"Tokyo $run","icon":"🏠","currency":"JPY","member_ids":["$ana"]}""",
                "group_id",
            )
            val manama = core.write(
                "tally.create_group",
                """{"name":"Manama $run","icon":"🏠","currency":"BHD","member_ids":["$bo"]}""",
                "group_id",
            )
            val today = core.dashboard().today
            val ramen = core.write(
                "tally.add_expense",
                """{"group_id":"$tokyo","description":"Ramen $run","amount_minor":4200,""" +
                    """"paid_by":"$me","category":"food","spent_on":"$today",""" +
                    """"split_method":"equally","splits":[""" +
                    """{"party_id":"$me","share_minor":2100},""" +
                    """{"party_id":"$ana","share_minor":2100}]}""",
                "expense_id",
            )
            core.write(
                "tally.add_expense",
                """{"group_id":"$manama","description":"Souq $run","amount_minor":10500,""" +
                    """"paid_by":"$bo","category":"food","spent_on":"$today",""" +
                    """"splits":[{"party_id":"$me","share_minor":5250},""" +
                    """{"party_id":"$bo","share_minor":5250}]}""",
                "expense_id",
            )

            // --- tally.dashboard: Balances, Groups, Activity -----------------
            val dashboard = core.dashboard()
            // TODAY IS THE DEVICE'S, read by the core in the zone we state.
            val zone = ZoneId.of(TZ)
            listOf(LocalDate.now(zone).minusDays(1), LocalDate.now(zone))
                .map { it.toString() } shouldContain dashboard.today
            LocalDate.parse(dashboard.yesterday) shouldBe
                LocalDate.parse(dashboard.today).minusDays(1)
            // EVERY MONEY CARRIES ITS OWN EXPONENT: JPY 0, BHD 3.
            val anaBalance = dashboard.friends.single { it.person?.party_id == ana }.balances
            anaBalance shouldHaveSize 1
            anaBalance.single().let {
                it.currency shouldBe "JPY"
                it.minor shouldBe 2100L
                it.exponent shouldBe 0
            }
            dashboard.friends.single { it.person?.party_id == bo }.balances.single().let {
                it.currency shouldBe "BHD"
                it.minor shouldBe -5250L
                it.exponent shouldBe 3
            }
            dashboard.friends.single { it.person?.party_id == ana }.person?.name shouldBe
                "Ana $run"
            val tokyoCard = dashboard.groups.single { it.group_id == tokyo }
            tokyoCard.your_net?.minor shouldBe 2100L
            tokyoCard.your_net?.exponent shouldBe 0
            val ramenRow = dashboard.activity.mapNotNull { it.expense }
                .single { it.expense_id == ramen }
            ramenRow.your_role shouldBe TallyRole.TALLY_ROLE_LENT
            ramenRow.group_name shouldBe "Tokyo $run"

            // --- tally.group ------------------------------------------------
            core.appQuery(AppQueryRequest(tally_group = TallyGroupRequest(group_id = tokyo)))
                .shouldBeAnsweredWith { envelope ->
                    val group = envelope.appQuery().tally_group ?: error("a group answer")
                    group.group?.currency shouldBe "JPY"
                    group.members.single { it.person?.party_id == ana }.net?.minor shouldBe -2100L
                    val row = group.ledger.single()
                    row.split_method shouldBe "equally"
                    row.splits.sumOf { it.amount?.minor ?: 0L } shouldBe row.amount?.minor
                }

            // --- tally.friend -----------------------------------------------
            core.appQuery(AppQueryRequest(tally_friend = TallyFriendRequest(party_id = bo)))
                .shouldBeAnsweredWith { envelope ->
                    val friend = envelope.appQuery().tally_friend ?: error("a friend answer")
                    friend.friend?.party_id shouldBe bo
                    friend.parts.single().group_id shouldBe manama
                    friend.parts.single().net?.exponent shouldBe 3
                }

            // --- tally.settle-up --------------------------------------------
            core.appQuery(
                AppQueryRequest(tally_settle_up = TallySettleUpRequest(group_id = manama)),
            ).shouldBeAnsweredWith { envelope ->
                val suggestion = envelope.appQuery().tally_settle_up?.suggestions?.single()
                    ?: error("one suggestion")
                suggestion.from?.party_id shouldBe me
                suggestion.to?.party_id shouldBe bo
                suggestion.amount?.minor shouldBe 5250L
                suggestion.amount?.exponent shouldBe 3
            }

            // --- tally.spending, per currency ------------------------------
            core.appQuery(
                AppQueryRequest(tally_spending = TallySpendingRequest(tz = TZ)),
            ).shouldBeAnsweredWith { envelope ->
                val spending = envelope.appQuery().tally_spending ?: error("a spending answer")
                spending.month shouldBe dashboard.today.take(7)
                spending.month_total.map { it.currency } shouldContain "JPY"
                spending.month_total.map { it.currency } shouldContain "BHD"
            }

            // --- tally.export -----------------------------------------------
            core.appQuery(
                AppQueryRequest(tally_export = TallyExportRequest(group_id = tokyo)),
            ).shouldBeAnsweredWith { envelope ->
                val export = envelope.appQuery().tally_export ?: error("an export answer")
                export.expenses.single().expense_id shouldBe ramen
                export.truncated shouldBe false
                export.limit shouldBe 500
            }
        } finally {
            core.close()
        }
    }

    "a trashed expense leaves the balances and lands in the trash, still openable" {
        val core = openRealCore()
        try {
            val run = UUID.randomUUID().toString().take(8)
            val me = core.dashboard().me ?: error("founding names the owner")
            val cleo = core.write("tally.add_friend", """{"name":"Cleo $run"}""", "party_id")
            val today = core.dashboard().today
            val order = core.write(
                "tally.add_expense",
                """{"description":"Order $run","amount_minor":1500,"paid_by":"$me",""" +
                    """"category":"food","spent_on":"$today","splits":[""" +
                    """{"party_id":"$me","share_minor":750},""" +
                    """{"party_id":"$cleo","share_minor":750}]}""",
                "expense_id",
            )
            core.dashboard().friends.single { it.person?.party_id == cleo }
                .balances.single().minor shouldBe 750L
            core.write("tally.delete_expense", """{"expense_id":"$order"}""", "expense_id")

            val after = core.dashboard()
            after.friends.single { it.person?.party_id == cleo }.balances shouldHaveSize 0
            after.activity.mapNotNull { it.expense?.expense_id } shouldNotContain order

            core.appQuery(AppQueryRequest(tally_trash = TallyTrashRequest(tz = TZ)))
                .shouldBeAnsweredWith { envelope ->
                    val row = envelope.appQuery().tally_trash?.rows?.single { it.expense_id == order }
                        ?: error("the trashed expense")
                    row.purge_on_local shouldNotBe null
                    row.amount?.exponent shouldBe 2
                }
            core.appQuery(
                AppQueryRequest(tally_expense = TallyExpenseRequest(expense_id = order, tz = TZ)),
            ).shouldBeAnsweredWith { envelope ->
                val detail = envelope.appQuery().tally_expense ?: error("an expense answer")
                detail.expense?.description shouldBe "Order $run"
                detail.deleted_at shouldNotBe null
                detail.revisions.single { it.operation == "trash" }.undoable shouldBe true
            }
            core.appQuery(
                AppQueryRequest(tally_search = TallySearchRequest(term = "Order $run", limit = 10)),
            ).shouldBeAnsweredWith { envelope ->
                envelope.appQuery().tally_search?.results?.size shouldBe 0
            }
            // A ZERO LIMIT IS REFUSED, NOT DEFAULTED.
            core.appQuery(
                AppQueryRequest(tally_search = TallySearchRequest(term = "Order", limit = 0)),
            ).shouldBeInstanceOf<CoreOutcome.Failed>()
        } finally {
            core.close()
        }
    }
}) {
    companion object {
        /** The device's zone, as a shell reads it off the platform and states it. */
        private const val TZ = "America/New_York"

        suspend fun CentraidCore.appQuery(query: AppQueryRequest): CoreOutcome<Envelope> =
            call(Envelope(request_id = 1, request = Request(app_query = query)))

        fun Envelope.appQuery() =
            response?.app_query ?: error("an AppQueryResponse, got $this")

        suspend fun CentraidCore.dashboard(): TallyDashboard {
            var answer: TallyDashboard? = null
            appQuery(AppQueryRequest(tally_dashboard = TallyDashboardRequest(tz = TZ)))
                .shouldBeAnsweredWith { envelope ->
                    answer = envelope.appQuery().tally_dashboard
                        ?: error("a dashboard answer, got ${envelope.appQuery()}")
                }
            return answer!!
        }

        /** One command through the command plane; answers the output's [field]. */
        suspend fun CentraidCore.write(name: String, input: String, field: String): String {
            var value = ""
            call(
                Envelope(
                    request_id = 1,
                    request = Request(
                        command = Command(
                            name = name,
                            input = input.encodeUtf8(),
                            invoke_key = "tally-round-trip-${UUID.randomUUID()}",
                        ),
                    ),
                ),
            ).shouldBeAnsweredWith { envelope ->
                val outcome = envelope.response?.command ?: error("a CommandOutcome")
                outcome.status shouldBe CommandStatus.COMMAND_STATUS_EXECUTED
                value = Regex("\"$field\":\"([^\"]+)\"")
                    .find(outcome.output.utf8())
                    ?.groupValues
                    ?.get(1)
                    ?: error("no $field in ${outcome.output.utf8()}")
            }
            return value
        }
    }
}
