package dev.centraid.shared.apps.tally

import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.screen.v1.Money
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.TallyListData
import centraid.screen.v1.TallyListEvent
import centraid.screen.v1.TallyListState
import centraid.screen.v1.TallyRow
import dev.centraid.shared.sync.ScreenReads

/**
 * WHAT THE TALLY LIST READS, AND WHAT IT MAKES OF THE ROWS (#1025 S5, lane L5).
 *
 * The statement is `crates/apps/tally`'s own — `tally.dashboard.expenses` in
 * `queries.rs`, which is `tally_expense` filtered to the live rows and ordered
 * `spent_on DESC, expense_id DESC`. It is FOLLOWED rather than re-derived: an
 * order invented here would put the phone's ledger in a different sequence from
 * the desktop's over the same rows, and the two would be reconciled by
 * whichever a member happened to look at second.
 *
 * The projection is narrower than the app's, and deliberately so: the app reads
 * twenty-one columns because its folds compute balances, and this list draws a
 * description, an amount and a date. Reading the rate columns to decorate a row
 * nobody is converting would be a wider read for no reader.
 */
public object TallyReads : ScreenReads<TallyListState, TallyListEvent> {
    override val screenId: String = TallyListMachine.SCREEN_ID

    /**
     * `tally_expense`, and the machine's `rowsChanged` names the same table for
     * the reason stated there: splits, payers and allocations hang off an
     * expense and move with it.
     */
    override val table: String = "tally_expense"

    /**
     * One screenful and a walk, not a ledger.
     *
     * v0 clamps a page at 500 (`window.ts:78`) and a list a thumb scrolls does
     * not need one: fifty rows is more than a screen holds, and the cursor in
     * `next_cursor` is what fetches the rest. A first page that read the whole
     * ledger would be a member waiting on rows they will never scroll to.
     */
    override val limit: Int = 50

    /**
     * THE SELECT CARRIES BOTH ORDER COLUMNS, which the door requires: there is
     * no `key_of` callback, so the cursor is read off the row by the two
     * columns the ORDER BY names (`statement.ts:43-48`).
     *
     * `deleted_at IS NULL` is the app's own filter and not a convenience: a
     * deleted expense stays on the table until the purge sweep takes it, so a
     * read without the predicate shows a member a row they deleted.
     *
     * **THE DESTINATION DOES NOT CHANGE THE TABLE.** `BALANCES` is a
     * projection the canonical engine derives and `GROUPS` is another table,
     * and either would break the pairing that keeps this screen moving on sync
     * — the machine declares ONE table in `rowsChanged`, and a query that
     * wandered off it would stop redrawing with nothing red anywhere. Both
     * destinations therefore still read the ledger, and serving them properly
     * is a projection this lane did not build.
     */
    override fun query(state: TallyListState, afterCursor: String?): PageQuery = PageQuery(
        name = "tally.list.expenses",
        select = listOf(
            "expense_id",
            "description",
            "amount_minor",
            "currency",
            "spent_on",
        ),
        from = table,
        where_ = "deleted_at IS NULL",
        order = PageOrder(
            sort_column = "spent_on",
            pk_column = "expense_id",
            descending = true,
        ),
    )

    override fun arrived(rows: List<Row>, nextCursor: String?): TallyListEvent = TallyListEvent(
        data_ = TallyListEvent.DataArrived(
            data_ = TallyListData(
                rows = rows.map(::rowOf),
                next_cursor = nextCursor,
                // THE NET BALANCE IS A FOLD, NOT A COLUMN. It is derived by the
                // canonical engine over splits, payers and settlements — three
                // tables this read does not join — and a figure summed off one
                // page would be the balance of a screenful rather than of a
                // destination. Absent, which the renderer draws as nothing,
                // rather than a number a member could quote back.
            ),
        ),
    )

    override fun refused(failure: ReadFailure): TallyListEvent =
        TallyListEvent(refused = TallyListEvent.ReadRefused(failure = failure))

    /**
     * One ledger line out of one row.
     *
     * `group_name` and `payer_name` are ABSENT rather than invented. They live
     * on `tally_group` and `core_party`, and the door pages one table at a time
     * — the proto says names ride along the row so an app bar need not wait a
     * second read, and this read is not the one that can put them there. The
     * renderer draws a line without them; it would draw an id as a person's
     * name if this filled them in from `paid_by`.
     */
    private fun rowOf(row: Row): TallyRow = TallyRow(
        expense_id = row.text(0),
        description = row.text(1),
        amount = moneyOf(row.integer(2), row.text(3)),
        occurred_at = row.text(4),
        // `settled` IS NOT A COLUMN ON THIS TABLE. Whether an expense is
        // settled is a fold over `tally_settlement`, so this stays false and
        // the row draws no settlement mark rather than claiming one either way.
    )

    /**
     * An amount, with its exponent LEFT UNSTATED.
     *
     * `Money.exponent` is the currency's minor-unit exponent and the proto says
     * where it comes from: "From the kit's table through the core, never
     * guessed and never assumed to be 2." That table is `crates/apps/kit`'s
     * `minor_units`, it is code and not a column, and no door on this seat
     * serves it — so this read cannot state it and does not pretend to. A 2
     * written here would be v0's own bug (`packages/design/src/format.ts:38`
     * divides by 100 for every currency) reintroduced on the phone, and it is
     * the bug D-1020-CL3 closed after it labelled a JPY expense in the vault's
     * base money on every ledger surface.
     *
     * The consequence is stated rather than hidden: a renderer reading
     * `exponent = 0` draws the minor amount. That is a visible, wrong-looking
     * number rather than a plausible, wrong one — and it is the hand-off this
     * lane leaves open, not a decision that it does not matter.
     */
    private fun moneyOf(minor: Long, currency: String): Money =
        Money(minor = minor, currency = currency)

    /**
     * The text of a row's column, or empty. Positional, as the door states.
     *
     * `Value` is a five-way oneof and only one arm is a string, so an INTEGER
     * column read through here comes back empty rather than as its digits —
     * which is why `amount_minor` goes through [integer] instead.
     */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    private fun Row.integer(index: Int): Long = values.getOrNull(index)?.integer ?: 0L
}
