use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_screens::room::snapshot;
use centraid_vault::clock::{FixedClock, SeededIds};
use serde_json::json;

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
const NOW: i64 = 1_795_687_200_000;

const CHECKING_ID: &str = "01900000-0000-7000-8000-000000000101";
const SAVINGS_ID: &str = "01900000-0000-7000-8000-000000000102";
const CAT_GROCERIES_ID: &str = "01900000-0000-7000-8000-000000000201";
const CAT_DINING_ID: &str = "01900000-0000-7000-8000-000000000202";
const CAT_DUP_ID: &str = "01900000-0000-7000-8000-000000000203";
const TXN_GROCERY_ID: &str = "01900000-0000-7000-8000-000000000301";
const TXN_SALARY_ID: &str = "01900000-0000-7000-8000-000000000302";
const TXN_SPLIT_ID: &str = "01900000-0000-7000-8000-000000000303";
const TXN_TR_OUT_ID: &str = "01900000-0000-7000-8000-000000000304";
const TXN_TR_IN_ID: &str = "01900000-0000-7000-8000-000000000305";
const RULE_ID: &str = "01900000-0000-7000-8000-000000000401";

fn phone(dir: &std::path::Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed();
    let handle = Core::open(
        CoreConfig::new(dir.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("money-rooms")),
            ),
    )
    .expect("the core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .expect("it founds");
    centraid_screens::attach(&handle);
    handle
}

fn room_call(handle: &Handle, kind: wire::room_request::Kind) -> Vec<wire::RoomShown> {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .expect("room call answers")
        .kind
        .expect("an answer");
    match answer {
        wire::response::Kind::Room(resp) => resp.shown,
        other => panic!("not a room response: {other:?}"),
    }
}

fn open(handle: &Handle, key: &str, tab: &str, root: bool) -> wire::RoomShown {
    room_call(
        handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: key.to_owned(),
            tab: tab.to_owned(),
            root,
            ..Default::default()
        }),
    )
    .remove(0)
}

fn send(handle: &Handle, instance: u64, kind: wire::room_event::Kind) -> Vec<wire::RoomShown> {
    room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance,
            event: Some(wire::RoomEvent { kind: Some(kind) }),
        }),
    )
}

fn tap(id: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Tap(wire::RoomTap {
        selector_id: id.to_owned(),
    })
}

fn text_change(id: &str, seq: u64, value: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Change(wire::RoomChange {
        selector_id: id.to_owned(),
        seq,
        value: Some(wire::room_change::Value::Text(value.to_owned())),
    })
}

fn int_change(id: &str, seq: u64, value: i64) -> wire::room_event::Kind {
    wire::room_event::Kind::Change(wire::RoomChange {
        selector_id: id.to_owned(),
        seq,
        value: Some(wire::room_change::Value::Integer(value)),
    })
}

fn option_change(id: &str, seq: u64, value: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Change(wire::RoomChange {
        selector_id: id.to_owned(),
        seq,
        value: Some(wire::room_change::Value::Option(value.to_owned())),
    })
}

fn chart_scrub(id: &str, point_id: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Canvas(wire::RoomCanvasEvent {
        selector_id: id.to_owned(),
        kind: Some(wire::room_canvas_event::Kind::ChartScrub(
            wire::RoomChartScrubbed {
                point_id: point_id.to_owned(),
            },
        )),
    })
}

fn cmd(handle: &Handle, name: &str, input: serde_json::Value, key: &str) {
    let outcome = handle.command(name, &input, key).expect("command runs");
    assert_eq!(
        outcome.status,
        centraid_vault::CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
}

fn seed_money(handle: &Handle) {
    cmd(
        handle,
        "account.add",
        json!({
            "id": CHECKING_ID,
            "title": "Checking",
            "type": "checking",
            "currency": "USD",
            "opening_minor": 250_000,
            "opening_on": "2026-01-01"
        }),
        "seed-checking",
    );
    cmd(
        handle,
        "account.add",
        json!({
            "id": SAVINGS_ID,
            "title": "Savings",
            "type": "savings",
            "currency": "USD",
            "opening_minor": 500_000,
            "opening_on": "2026-01-01"
        }),
        "seed-savings",
    );
    cmd(
        handle,
        "category.add",
        json!({ "id": CAT_GROCERIES_ID, "title": "Groceries" }),
        "seed-cat-groc",
    );
    cmd(
        handle,
        "category.add",
        json!({ "id": CAT_DINING_ID, "title": "Dining" }),
        "seed-cat-dine",
    );
    cmd(
        handle,
        "category.add",
        json!({ "id": CAT_DUP_ID, "title": "Food & Drink" }),
        "seed-cat-dup",
    );
    cmd(
        handle,
        "txn.add",
        json!({
            "id": TXN_GROCERY_ID,
            "account_id": CHECKING_ID,
            "posted_on": "2026-11-24",
            "amount_minor": -8450,
            "title": "Market Fresh",
            "category_id": CAT_GROCERIES_ID,
            "memo": "Weekly produce"
        }),
        "seed-txn-groc",
    );
    cmd(
        handle,
        "txn.add",
        json!({
            "id": TXN_SALARY_ID,
            "account_id": CHECKING_ID,
            "posted_on": "2026-11-15",
            "amount_minor": 420_000,
            "title": "Payroll"
        }),
        "seed-txn-sal",
    );
    cmd(
        handle,
        "txn.add",
        json!({
            "id": TXN_SPLIT_ID,
            "account_id": CHECKING_ID,
            "posted_on": "2026-11-20",
            "amount_minor": -6000,
            "title": "Corner Co-op",
            "splits": [
                { "category_id": CAT_GROCERIES_ID, "amount_minor": -4000 },
                { "category_id": CAT_DINING_ID, "amount_minor": -2000 }
            ]
        }),
        "seed-txn-split",
    );
    cmd(
        handle,
        "budget.set",
        json!({
            "category_id": CAT_GROCERIES_ID,
            "month": "2026-11",
            "amount_minor": 40_000,
            "carry": true
        }),
        "seed-budget-groc",
    );
    cmd(
        handle,
        "rule.add",
        json!({
            "id": RULE_ID,
            "match": "contains",
            "text": "MKT FRESH",
            "display_name": "Market Fresh",
            "category_id": CAT_GROCERIES_ID
        }),
        "seed-rule",
    );
}

#[test]
fn home_tile_opens_money_activity_and_list_flows_work() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_money(&handle);

    let home = open(&handle, "home", "home", true);
    let activity = send(&handle, home.instance, tap("tile/money")).remove(0);
    let room = activity.room.as_ref().unwrap();
    assert_eq!(room.key, "money");
    snapshot::assert_room("money_activity", room);

    // Search filters in place; Back from detail keeps search term.
    send(&handle, activity.instance, tap("band/search"));
    let searched = send(
        &handle,
        activity.instance,
        text_change("search", 1, "Market"),
    )
    .remove(0);
    let text = snapshot::render(searched.room.as_ref().unwrap());
    assert!(text.contains("Market Fresh"));
    assert!(!text.contains("Payroll"));

    let detail = send(
        &handle,
        activity.instance,
        tap(&format!("row/{TXN_GROCERY_ID}")),
    )
    .remove(0);
    assert_eq!(
        detail.room.as_ref().unwrap().key,
        format!("money/txn/{TXN_GROCERY_ID}")
    );
    let back = send(&handle, detail.instance, tap("back")).remove(0);
    assert_eq!(
        back.room.as_ref().unwrap().search.as_ref().unwrap().term,
        "Market"
    );
    send(&handle, activity.instance, tap("search/close"));

    // Swipe to trash + Undo restores.
    let trashed = send(
        &handle,
        activity.instance,
        tap(&format!("row/{TXN_SALARY_ID}/trash")),
    )
    .remove(0);
    assert_eq!(
        trashed
            .room
            .as_ref()
            .unwrap()
            .status_line
            .as_ref()
            .unwrap()
            .action_label,
        "Undo"
    );
    assert!(!snapshot::render(trashed.room.as_ref().unwrap()).contains("Payroll"));
    let undone = send(&handle, activity.instance, tap("status/undo")).remove(0);
    assert!(snapshot::render(undone.room.as_ref().unwrap()).contains("Payroll"));

    // Select mode: bulk categorize in one commit.
    let selecting = send(
        &handle,
        activity.instance,
        tap(&format!("row/{TXN_SALARY_ID}/menu/select")),
    )
    .remove(0);
    assert!(selecting.room.as_ref().unwrap().band.is_none());
    send(
        &handle,
        activity.instance,
        tap(&format!("row/{TXN_SALARY_ID}")),
    );
    let bulk = send(&handle, activity.instance, tap("selection/categorize")).remove(0);
    assert!(
        !bulk
            .room
            .as_ref()
            .unwrap()
            .selection
            .as_ref()
            .is_some_and(|s| s.on)
    );
}

#[test]
fn spending_and_cashflow_emit_charts_and_handle_scrub() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_money(&handle);

    let spending = open(&handle, "money/spending", "home", true);
    let spending_text = snapshot::render(spending.room.as_ref().unwrap());
    assert!(spending_text.contains("chart #chart/spending"));
    assert!(spending_text.contains("series bar"));
    assert!(spending_text.contains("$124.50"));
    snapshot::assert_room("money_spending", spending.room.as_ref().unwrap());

    // Scrubbing updates readout_point_id and renders the readout figure.
    let scrubbed = send(
        &handle,
        spending.instance,
        chart_scrub("chart/spending", &format!("cat:{CAT_GROCERIES_ID}")),
    )
    .remove(0);
    assert!(
        snapshot::render(scrubbed.room.as_ref().unwrap())
            .contains(&format!("readout=\"cat:{CAT_GROCERIES_ID}\""))
    );

    let cashflow = open(&handle, "money/cashflow", "home", true);
    let cf_text = snapshot::render(cashflow.room.as_ref().unwrap());
    assert!(cf_text.contains("chart #chart/cashflow"));
    assert!(cf_text.contains("series bar \"Income\""));
    assert!(cf_text.contains("series line \"Net\""));
    snapshot::assert_room("money_cashflow", cashflow.room.as_ref().unwrap());
}

#[test]
fn txn_detail_shows_splits_statement_says_and_footers() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_money(&handle);

    // Import a statement line through follow.statement, then edit it and split it so "Statement says" appears.
    cmd(
        &handle,
        "follow.statement",
        json!({
            "origin": { "ref": CHECKING_ID, "label": "Checking CSV", "fills": CHECKING_ID },
            "records": [{
                "external_id": "csv:stmt-1",
                "fields": {
                    "title": "CORNER COOP #44",
                    "posted_on": "2026-11-19",
                    "amount_minor": -6200,
                    "line": { "memo": "bank memo", "imported_from": "csv" }
                }
            }]
        }),
        "seed-stmt",
    );
    let activity = open(&handle, "money", "home", true);
    let stmt_id = snapshot::render(activity.room.as_ref().unwrap())
        .lines()
        .find(|l| l.contains("CORNER COOP #44"))
        .and_then(|l| l.split("#row/").nth(1))
        .and_then(|s| s.split_whitespace().next())
        .expect("statement row id")
        .to_owned();
    cmd(
        &handle,
        "entity.retitle",
        json!({ "id": stmt_id, "title": "Corner Co-op" }),
        "edit-stmt-title",
    );
    cmd(
        &handle,
        "txn.edit",
        json!({ "id": stmt_id, "amount_minor": -6000, "posted_on": "2026-11-20" }),
        "edit-stmt-amt",
    );
    cmd(
        &handle,
        "txn.split",
        json!({
            "id": stmt_id,
            "parts": [
                { "category_id": CAT_GROCERIES_ID, "amount_minor": -4000 },
                { "category_id": CAT_DINING_ID, "amount_minor": -2000 }
            ]
        }),
        "split-stmt",
    );

    let detail = open(&handle, &format!("money/txn/{stmt_id}"), "home", true);
    let text = snapshot::render(detail.room.as_ref().unwrap());
    assert!(text.contains("Corner Co-op"));
    assert!(text.contains("Statement says"));
    assert!(text.contains("CORNER COOP #44"));
    assert!(text.contains("Groceries"));
    assert!(text.contains("Dining"));
    snapshot::assert_room("money_txn_detail", detail.room.as_ref().unwrap());
}

#[test]
fn new_txn_form_uses_d3_last_account_and_d1_draft() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_money(&handle);

    let new_form = open(&handle, "money/new", "home", true);
    snapshot::assert_room("money_new_txn", new_form.room.as_ref().unwrap());

    // Enter amount and payee: D1 draft persists.
    send(
        &handle,
        new_form.instance,
        int_change("field/amount", 1, 1550),
    );
    send(
        &handle,
        new_form.instance,
        text_change("field/title", 1, "Coffee"),
    );
    send(
        &handle,
        new_form.instance,
        option_change("field/account/choice", 1, SAVINGS_ID),
    );

    let reopened = open(&handle, "money/new", "home", true);
    let reopened_text = snapshot::render(reopened.room.as_ref().unwrap());
    assert!(reopened_text.contains("Coffee"));
    assert!(reopened_text.contains("-$15.50"));
    assert!(reopened_text.contains("drafted"));

    // Save writes transaction, clears draft, and remembers D3 last-used account (Savings).
    send(&handle, reopened.instance, tap("form/save"));

    let next_new = open(&handle, "money/new", "home", true);
    let next_text = snapshot::render(next_new.room.as_ref().unwrap());
    assert!(!next_text.contains("Coffee"));
    assert!(next_text.contains("option \"Savings\" selected"));
}

#[test]
fn csv_import_maps_columns_previews_three_rows_and_imports() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_money(&handle);

    let csv = open(&handle, "money/import-csv", "home", true);
    send(
        &handle,
        csv.instance,
        text_change(
            "field/csv",
            1,
            "Date,Description,Amount\n2026-11-01,Bakery,-12.50\n2026-11-02,Refund,5.00\n2026-11-03,Transit,-3.25",
        ),
    );
    send(
        &handle,
        csv.instance,
        option_change("csv/date_col", 1, "Date"),
    );
    send(
        &handle,
        csv.instance,
        option_change("csv/desc_col", 1, "Description"),
    );
    let mapped = send(
        &handle,
        csv.instance,
        option_change("csv/amount_col", 1, "Amount"),
    )
    .remove(0);
    let mapped_text = snapshot::render(mapped.room.as_ref().unwrap());
    assert!(mapped_text.contains("Bakery"));
    assert!(mapped_text.contains("-$12.50"));
    assert!(mapped_text.contains("+$5.00"));
    snapshot::assert_room("money_import_csv", mapped.room.as_ref().unwrap());

    send(&handle, csv.instance, tap("form/save"));
    let activity = open(&handle, "money", "home", true);
    assert!(snapshot::render(activity.room.as_ref().unwrap()).contains("Bakery"));
}

#[test]
fn accounts_currency_confirm_budgets_rules_categories_and_trash_work() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_money(&handle);

    // Link a transfer pair so Transfers room has data.
    cmd(
        &handle,
        "txn.add",
        json!({
            "id": TXN_TR_OUT_ID,
            "account_id": CHECKING_ID,
            "posted_on": "2026-11-10",
            "amount_minor": -50_000,
            "title": "Transfer to Savings"
        }),
        "seed-tr-out",
    );
    cmd(
        &handle,
        "txn.add",
        json!({
            "id": TXN_TR_IN_ID,
            "account_id": SAVINGS_ID,
            "posted_on": "2026-11-10",
            "amount_minor": 50_000,
            "title": "Transfer from Checking"
        }),
        "seed-tr-in",
    );
    cmd(
        &handle,
        "txn.link_transfer",
        json!({ "id": TXN_TR_OUT_ID, "other_id": TXN_TR_IN_ID }),
        "seed-tr-link",
    );

    let accounts = open(&handle, "money/accounts", "home", true);
    snapshot::assert_room("money_accounts", accounts.room.as_ref().unwrap());

    let currency = open(
        &handle,
        &format!("money/account/{SAVINGS_ID}/currency"),
        "home",
        true,
    );
    send(
        &handle,
        currency.instance,
        text_change("field/currency", 1, "EUR"),
    );
    let confirm = send(&handle, currency.instance, tap("form/save")).remove(0);
    snapshot::assert_room("money_currency_confirm", confirm.room.as_ref().unwrap());

    let budgets = open(&handle, "money/budgets", "home", true);
    snapshot::assert_room("money_budgets", budgets.room.as_ref().unwrap());

    let rules = open(&handle, "money/rules", "home", true);
    snapshot::assert_room("money_rules", rules.room.as_ref().unwrap());

    let categories = open(&handle, "money/categories", "home", true);
    snapshot::assert_room("money_categories", categories.room.as_ref().unwrap());

    // Trash a transaction and inspect Money Trash.
    cmd(
        &handle,
        "entity.trash",
        json!({ "ids": [TXN_GROCERY_ID] }),
        "trash-groc",
    );
    let trash = open(&handle, "money/trash", "home", true);
    snapshot::assert_room("money_trash", trash.room.as_ref().unwrap());
}
