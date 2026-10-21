//! Money in the assistant (#1099, R-1099-8): the read-only `transaction` kind, the months the
//! world holds, the signed amount, and `Flags::money` off, where the world holds no transaction,
//! reads no Money table and the kind card is the one the shipped model was trained on.

mod common;

use std::sync::{Arc, Mutex};

use centraid_nativetools::vaultio::{Door, Handle, Ran, SetClock};
use centraid_nativetools::{Flags, Session, dates, prompt, vaultio};
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

fn money_off() -> Flags {
    Flags {
        money: false,
        ..Flags::default()
    }
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

#[test]
fn nothing_can_write_a_transaction() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    let found = find(
        &mut session,
        json!({"kind": "transaction", "name": "Blue Bottle"}),
    );
    let row = ids(&found["effect"]["rows"]);
    assert_eq!(row.len(), 1, "{found}");
    for args in [
        json!({"verb": "edit", "rows": "#1", "args": "category: Groceries"}),
        json!({"verb": "delete", "rows": "#1"}),
        json!({"verb": "create", "kind": "transaction", "args": "name: Lunch"}),
    ] {
        let out = call(&mut session, "act", args.clone());
        let said = out["text"].as_str().unwrap_or_default();
        assert!(
            said.starts_with("error:")
                || said.contains("does not apply")
                || said.contains("applies to"),
            "{args}: {out}"
        );
        assert!(session.pending().is_none(), "{args} parked a write");
    }
}

#[test]
fn with_money_off_the_world_holds_no_transaction_and_the_card_is_the_trained_one() {
    let world = seeded_with(&world_json());
    let mut off = world.session_with(TODAY, money_off());
    let out = find(&mut off, json!({"kind": "transaction"}));
    assert!(ids(&out["effect"]["rows"]).is_empty(), "{out}");
    let card = prompt::kind_card_in("USD", false);
    assert_eq!(card.len(), 11);
    assert!(card.iter().all(|line| !line.starts_with("transaction:")));
    let system = off.prompt()["system"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert!(!system.contains("transaction:"), "{system}");
    let on = world.session().prompt()["system"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert!(
        on.contains("transaction: name, date (posted), amount (USD), account, category, status (posted|void)"),
        "{on}"
    );
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

    fn run(&self, command: &str, input: Value) -> Result<Ran, String> {
        Door::run(&self.inner, command, input)
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

    fn seal(&self, item_id: &str, value: &str) -> Result<(String, String), String> {
        Door::seal(&self.inner, item_id, value)
    }

    fn unseal(&self, key_id: &str, item_id: &str, sealed: &str) -> Result<String, String> {
        Door::unseal(&self.inner, key_id, item_id, sealed)
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
fn money_off_reads_no_money_table_and_money_on_reads_only_the_window() {
    let world = seeded_with(&world_json());
    let off = tables_read(&world, money_off());
    assert!(
        off.iter().all(|table| table != "txn" && table != "account"),
        "{off:?}"
    );
    let on = tables_read(&world, Flags::default());
    for table in ["txn", "entity"] {
        assert!(on.iter().any(|read| read == table), "{table} in {on:?}");
    }
}
