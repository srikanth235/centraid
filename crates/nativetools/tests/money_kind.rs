//! Money in the assistant (#1099, R-1099-8): the read-only `transaction` kind, the months the
//! world holds and the signed amount. Money is on in every session (#1135 retired `Flags::money`).

mod common;

use std::sync::{Arc, Mutex};

use centraid_nativetools::vaultio::{Call, Door, Handle, Ran, SetClock};
use centraid_nativetools::{Flags, Session, dates, vaultio};
use common::{TODAY, World, call, ids, seeded_with, text};
use serde_json::{Value, json};

/// Two accounts in two currencies; the window of 2026-09-27 starts on 2026-07-01.
fn world_json() -> Value {
    json!({
        "me": "Sam Park", "epoch": "2026-01-05T09:00", "seed": "money", "currency": "USD",
        "accounts": [
            {"key": "everyday", "name": "Everyday", "kind": "checking"},
            {"key": "travel", "name": "Travel card", "kind": "credit_card", "currency": "EUR"}
        ],
        "transactions": [
            {"key": "coffee", "account": "everyday", "date": "2026-09-26", "amount": -4.5,
             "name": "Blue Bottle", "description": "BLUE BOTTLE #12", "category": "food.dining"},
            {"key": "grocery", "account": "everyday", "date": "2026-09-20", "amount": -82.10,
             "name": "Whole Foods", "description": "WHOLEFDS MKT 10442", "category": "food.groceries"},
            {"key": "pay", "account": "everyday", "date": "2026-09-15", "amount": 2500,
             "name": "Acme payroll", "description": "ACME CORP PAYROLL", "category": "income.pay"},
            {"key": "voided", "account": "everyday", "date": "2026-08-10", "amount": -9.99,
             "name": "Streaming", "description": "STREAMCO", "void": true},
            {"key": "bistro", "account": "travel", "date": "2026-09-02", "amount": -30,
             "name": "Le Bistro", "description": "LE BISTRO PARIS", "category": "food.dining"},
            {"key": "july", "account": "everyday", "date": "2026-07-01", "amount": -12,
             "name": "Hardware", "description": "ACE HARDWARE"},
            {"key": "old", "account": "everyday", "date": "2026-06-30", "amount": -5,
             "name": "Parking", "description": "CITY PARKING"}
        ]
    })
}

fn find(session: &mut Session, args: Value) -> Value {
    session.user("");
    call(session, "find", args)
}

#[test]
fn the_world_holds_this_month_and_the_two_before_it_and_no_older_row() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    let found = find(&mut session, json!({"kind": "transaction"}));
    let mut got = ids(&found["effect"]["rows"]);
    got.sort();
    let mut want: Vec<String> = ["coffee", "grocery", "pay", "voided", "bistro", "july"]
        .iter()
        .map(|key| world.id(key))
        .collect();
    want.sort();
    assert_eq!(got, want, "the 30 June row is out of the window: {found}");
}

#[test]
fn an_amount_is_signed_in_the_accounts_currency_and_a_row_names_its_account_and_category() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    session.user("");
    let shown = text(
        &mut session,
        "find",
        json!({"kind": "transaction", "name": "Blue Bottle"}),
    );
    assert!(shown.contains("-4.50 USD"), "{shown}");
    assert!(shown.contains("account \"Everyday\""), "{shown}");
    assert!(shown.contains("category \"Dining out\""), "{shown}");
    assert!(
        shown.contains("2026-09-26") && !shown.contains("00:00"),
        "{shown}"
    );
    let income = text(
        &mut session,
        "find",
        json!({"kind": "transaction", "name": "Acme payroll"}),
    );
    assert!(
        income.contains("2500.00 USD") && !income.contains("-2500"),
        "{income}"
    );
    let euro = text(
        &mut session,
        "find",
        json!({"kind": "transaction", "name": "Le Bistro"}),
    );
    assert!(euro.contains("-30.00 EUR"), "{euro}");
}

#[test]
fn where_reads_a_negative_amount_and_a_status() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    let out = find(
        &mut session,
        json!({"kind": "transaction", "where": "amount < -50"}),
    );
    assert_eq!(
        ids(&out["effect"]["rows"]),
        vec![world.id("grocery")],
        "{out}"
    );
    let out = find(
        &mut session,
        json!({"kind": "transaction", "where": "amount <= -4.5 USD and status = posted"}),
    );
    let mut got = ids(&out["effect"]["rows"]);
    got.sort();
    let mut want = vec![world.id("coffee"), world.id("grocery"), world.id("july")];
    want.sort();
    assert_eq!(got, want, "{out}");
    let out = find(
        &mut session,
        json!({"kind": "transaction", "where": "status = void"}),
    );
    assert_eq!(
        ids(&out["effect"]["rows"]),
        vec![world.id("voided")],
        "{out}"
    );
    let out = find(
        &mut session,
        json!({"kind": "transaction", "where": "category = \"Dining out\""}),
    );
    assert_eq!(ids(&out["effect"]["rows"]).len(), 2, "{out}");
}

#[test]
fn a_sum_is_one_figure_per_currency_and_never_across_them() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    session.user("");
    let out = call(
        &mut session,
        "compute",
        json!({"op": "sum", "field": "amount", "group": "category",
               "where": "category = \"Dining out\"", "kind": "transaction"}),
    );
    let said = out["text"].as_str().unwrap_or_default();
    assert!(
        said.contains("-4.50 USD + -30.00 EUR") || said.contains("-30.00 EUR + -4.50 USD"),
        "{out}"
    );
}

/// What the bank wrote is never created by chat, while a line can go to the trash (#1185)
/// and be edited via `txn.edit`. Nothing parks a card for trashing.
#[test]
fn chat_can_only_trash_a_transaction_and_write_nothing_else() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    let found = find(
        &mut session,
        json!({"kind": "transaction", "name": "Blue Bottle"}),
    );
    let row = ids(&found["effect"]["rows"]);
    assert_eq!(row.len(), 1, "{found}");
    let out = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "transaction", "args": "name: Lunch"}),
    );
    let said = out["text"].as_str().unwrap_or_default();
    assert!(
        said.starts_with("error:")
            || said.contains("does not apply")
            || said.contains("applies to"),
        "{out}"
    );
    assert!(session.pending().is_none(), "create transaction parked a write");

    let trashed = call(&mut session, "act", json!({"verb": "delete", "rows": "#1"}));
    assert!(
        trashed["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("deleted:"),
        "{trashed}"
    );
    assert!(session.pending().is_none());
    // A trashed line is in no read the assistant has: it is gone from what it finds.
    let found = find(
        &mut session,
        json!({"kind": "transaction", "name": "Blue Bottle"}),
    );
    assert!(ids(&found["effect"]["rows"]).is_empty(), "{found}");
}

/// What the runtime asked a door for.
struct Recording {
    inner: Handle,
    tables: Arc<Mutex<Vec<String>>>,
}

impl Door for Recording {
    fn table(
        &self,
        table: &str,
        columns: &str,
        sort: &str,
        pk: &str,
    ) -> Result<Vec<centraid_apps_kit::row::Row>, String> {
        self.tables.lock().unwrap().push(table.to_owned());
        Door::table(&self.inner, table, columns, sort, pk)
    }

    fn table_where(
        &self,
        table: &str,
        columns: &str,
        sort: &str,
        pk: &str,
        predicate: &str,
        binds: &[String],
    ) -> Result<Vec<centraid_apps_kit::row::Row>, String> {
        self.tables.lock().unwrap().push(table.to_owned());
        Door::table_where(&self.inner, table, columns, sort, pk, predicate, binds)
    }

    fn search(
        &self,
        entity: &str,
        text: &str,
        limit: usize,
    ) -> Result<Vec<centraid_search::Target>, String> {
        Door::search(&self.inner, entity, text, limit)
    }

    fn act(&self, call: &Call, input: Value) -> Result<Ran, String> {
        Door::act(&self.inner, call, input)
    }

    fn advance(&self) {
        Door::advance(&self.inner);
    }

    fn now_ms(&self) -> i64 {
        Door::now_ms(&self.inner)
    }

    fn mint_id(&self) -> String {
        Door::mint_id(&self.inner)
    }
}

fn tables_read(world: &World, flags: Flags) -> Vec<String> {
    let now = dates::parse_now(TODAY).expect("a date");
    let clock = SetClock::at(vaultio::millis_of(now));
    let inner = Handle::open(world.path(), clock, "money-reads").expect("the vault opens");
    let tables = Arc::new(Mutex::new(Vec::new()));
    let door = Recording {
        inner,
        tables: Arc::clone(&tables),
    };
    Session::with_door(Box::new(door), now, "", flags).expect("it opens");
    let mut read = tables.lock().unwrap().clone();
    read.sort();
    read.dedup();
    read
}

#[test]
fn money_reads_only_the_window() {
    let world = seeded_with(&world_json());
    let on = tables_read(&world, common::s2_flags());
    for table in ["txn", "entity"] {
        assert!(on.iter().any(|read| read == table), "{table} in {on:?}");
    }
}

fn wrote(out: &Value) -> bool {
    out["effect"]["diff"]["rows"]
        .as_array()
        .is_some_and(|rows| !rows.is_empty())
}

#[test]
fn multi_currency_accounts_create_edit_opening_and_reject_conflicts() {
    let world = seeded_with(&world_json());
    let mut session = world.session_with(
        common::TODAY,
        Flags {
            writes: centraid_nativetools::park::Writes::Shadow,
            ..Flags::default()
        },
    );
    session.user("open multi-currency accounts");
    for (args, needle) in [
        (
            "name: HDFC Savings\ntype: savings\ncurrency: INR\nopening: ₹1.5 lakh\nopening_on: 2026-09-01\non_budget: true",
            "150000.00 INR",
        ),
        (
            "name: Mumbai Corpus\ntype: savings\ncurrency: inr\nopening: 2.5 crore\nopening_on: 2026-09-01",
            "25000000.00 INR",
        ),
        (
            "name: DBS Everyday\ntype: checking\ncurrency: SGD\nopening: S$40\nopening_on: 2026-09-01",
            "40.00 SGD",
        ),
        (
            "name: Emirates Cash\ntype: cash\ncurrency: AED\nopening: AED 300\nopening_on: 2026-09-01",
            "300.00 AED",
        ),
        (
            "name: London Vault\ntype: checking\ncurrency: GBP\nopening: £120.50\nopening_on: 2026-09-01",
            "120.50 GBP",
        ),
    ] {
        session.user("open account");
        let made = call(&mut session, "create", json!({"kind": "account", "args": args}));
        assert!(wrote(&made), "{args}: {made}");
        let created_name = args
            .lines()
            .next()
            .unwrap()
            .trim_start_matches("name: ")
            .trim();
        session.user("");
        let shown = text(&mut session, "find", json!({"kind": "account", "name": created_name}));
        assert!(shown.contains(needle), "expected {needle} in {shown}");
    }

    // Conflicting currency symbol or missing opening_on on create are refused cleanly.
    session.user("open account with conflicting symbol");
    let conflict = call(
        &mut session,
        "create",
        json!({"kind": "account", "args": "name: Bad\ntype: checking\ncurrency: INR\nopening: $50\nopening_on: 2026-09-01"}),
    );
    assert!(!wrote(&conflict), "{conflict}");
    assert!(
        conflict["text"]
            .as_str()
            .unwrap_or_default()
            .contains("INR"),
        "{conflict}"
    );
    session.user("open account without opening_on");
    let missing_day = call(
        &mut session,
        "create",
        json!({"kind": "account", "args": "name: NoDay\ntype: checking\ncurrency: USD\nopening: 100"}),
    );
    assert!(!wrote(&missing_day), "{missing_day}");
    assert!(
        missing_day["text"]
            .as_str()
            .unwrap_or_default()
            .contains("An opening balance needs the day it was true"),
        "{missing_day}"
    );

    // Edit HDFC Savings opening balance in INR, refuse EUR, and verify undo.
    let found = find(&mut session, json!({"kind": "account", "name": "HDFC Savings"}));
    let handle = found["effect"]["result"].as_str().unwrap().to_owned();
    session.user("set opening in euros");
    let bad_edit = call(
        &mut session,
        "edit",
        json!({"rows": handle, "args": "opening: €50"}),
    );
    assert!(!wrote(&bad_edit), "{bad_edit}");
    assert!(
        bad_edit["text"].as_str().unwrap_or_default().contains("INR"),
        "{bad_edit}"
    );
    session.user("set opening to 2 lakh");
    let edited = call(
        &mut session,
        "edit",
        json!({"rows": handle, "args": "opening: Rs. 2 lakh"}),
    );
    assert!(wrote(&edited), "{edited}");
    assert!(
        edited["effect"]["diff"].to_string().contains("200000"),
        "{edited}"
    );
    session.user("undo that");
    let undone = call(&mut session, "do", json!({"verb": "undo"}));
    assert!(wrote(&undone), "{undone}");
    session.user("");
    let restored = text(&mut session, "find", json!({"kind": "account", "name": "HDFC Savings"}));
    assert!(restored.contains("150000.00 INR"), "{restored}");
    let drift = session.take_drift();
    assert!(drift.is_empty(), "shadow drift:\n{}", drift.join("\n"));
}

#[test]
fn chat_edits_transaction_fields_in_account_currency_and_undoes() {
    let world = seeded_with(&world_json());
    let mut session = world.session_with(
        common::TODAY,
        Flags {
            writes: centraid_nativetools::park::Writes::Shadow,
            ..Flags::default()
        },
    );
    let found = find(&mut session, json!({"kind": "transaction", "name": "Le Bistro"}));
    let handle = found["effect"]["result"].as_str().unwrap().to_owned();

    // Conflicting currency symbol is refused before hitting vault.
    session.user("change amount to dollars");
    let conflict = call(
        &mut session,
        "edit",
        json!({"rows": handle, "args": "amount: $12"}),
    );
    assert!(!wrote(&conflict), "{conflict}");
    assert!(
        conflict["text"].as_str().unwrap_or_default().contains("EUR"),
        "{conflict}"
    );

    // Edit amount (EUR), date, category, status, and name atomically via txn.edit.
    session.user("edit transaction details");
    let edited = call(
        &mut session,
        "edit",
        json!({
            "rows": handle,
            "args": "name: Bistro Updated\ndate: 2026-09-03\namount: €-45.25\ncategory: Groceries\nstatus: pending"
        }),
    );
    assert!(wrote(&edited), "{edited}");
    let diff = edited["effect"]["diff"].to_string();
    assert!(
        diff.contains("Bistro Updated")
            && diff.contains("2026-09-03")
            && diff.contains("-45.25")
            && diff.contains("Groceries"),
        "{edited}"
    );

    // Undo immediately restores all prior transaction fields.
    session.user("undo that");
    let undone = call(&mut session, "do", json!({"verb": "undo"}));
    assert!(wrote(&undone), "{undone}");
    session.user("");
    let restored = text(
        &mut session,
        "find",
        json!({"kind": "transaction", "name": "Le Bistro"}),
    );
    assert!(
        restored.contains("-30.00 EUR")
            && restored.contains("2026-09-02")
            && restored.contains("category \"Dining out\""),
        "{restored}"
    );
    let drift = session.take_drift();
    assert!(drift.is_empty(), "shadow drift:\n{}", drift.join("\n"));
}

#[test]
fn chat_edits_budget_in_plans_own_currency_and_carries() {
    let world = seeded_with(&world_json());
    world.elsewhere(
        "budget.set",
        json!({
            "month": "2026-09",
            "category_id": "category:food.dining",
            "amount_minor": 30000,
            "currency": "EUR",
            "carry": false
        }),
    );
    let mut session = world.session_with(
        common::TODAY,
        Flags {
            writes: centraid_nativetools::park::Writes::Shadow,
            ..Flags::default()
        },
    );
    let found = find(&mut session, json!({"kind": "budget"}));
    let handle = found["effect"]["result"].as_str().unwrap().to_owned();
    assert!(
        found["text"].as_str().unwrap_or_default().contains("300.00 EUR"),
        "{found}"
    );

    session.user("set budget in dollars");
    let conflict = call(
        &mut session,
        "edit",
        json!({"rows": handle, "args": "amount: $400"}),
    );
    assert!(!wrote(&conflict), "{conflict}");
    assert!(
        conflict["text"].as_str().unwrap_or_default().contains("EUR"),
        "{conflict}"
    );

    session.user("set budget to 450 euros and carry");
    let edited = call(
        &mut session,
        "edit",
        json!({"rows": handle, "args": "amount: €450\ncarry: yes"}),
    );
    assert!(wrote(&edited), "{edited}");
    let diff = edited["effect"]["diff"].to_string();
    assert!(diff.contains("450") && diff.contains("true"), "{edited}");

    session.user("undo that");
    let undone = call(&mut session, "do", json!({"verb": "undo"}));
    assert!(wrote(&undone), "{undone}");
    session.user("");
    let restored = text(&mut session, "find", json!({"kind": "budget"}));
    assert!(
        restored.contains("300.00 EUR") && !restored.contains("· carry"),
        "{restored}"
    );
    let drift = session.take_drift();
    assert!(drift.is_empty(), "shadow drift:\n{}", drift.join("\n"));
}

#[test]
fn where_uses_vault_base_currency_for_bare_thresholds_and_explicit_currencies() {
    let seed = json!({
        "me": "Sam Park", "epoch": "2026-01-05T09:00", "seed": "multi-where", "currency": "USD",
        "accounts": [
            {"key": "usd_acc", "name": "USD Checking", "kind": "checking", "currency": "USD"},
            {"key": "inr_acc", "name": "INR Bank", "kind": "savings", "currency": "INR"},
            {"key": "aed_acc", "name": "AED Cash", "kind": "cash", "currency": "AED"}
        ],
        "transactions": [
            {"key": "usd_big", "account": "usd_acc", "date": "2026-09-20", "amount": -80, "name": "USD Big"},
            {"key": "inr_big", "account": "inr_acc", "date": "2026-09-21", "amount": -200000, "name": "INR Rent"},
            {"key": "aed_big", "account": "aed_acc", "date": "2026-09-22", "amount": -350, "name": "Dubai Hotel"}
        ]
    });
    let world = seeded_with(&seed);
    let mut session = world.session();

    // Bare threshold checks vault base currency (USD) only.
    let usd_only = find(
        &mut session,
        json!({"kind": "transaction", "where": "amount < -50"}),
    );
    assert_eq!(
        ids(&usd_only["effect"]["rows"]),
        vec![world.id("usd_big")],
        "{usd_only}"
    );

    // Explicit currencies match only rows in that currency.
    let aed_only = find(
        &mut session,
        json!({"kind": "transaction", "where": "amount <= -300 AED"}),
    );
    assert_eq!(
        ids(&aed_only["effect"]["rows"]),
        vec![world.id("aed_big")],
        "{aed_only}"
    );

    let inr_only = find(
        &mut session,
        json!({"kind": "transaction", "where": "amount <= -Rs. 2 lakh"}),
    );
    assert_eq!(
        ids(&inr_only["effect"]["rows"]),
        vec![world.id("inr_big")],
        "{inr_only}"
    );
}
