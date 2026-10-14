//! THE CORE'S DOOR FOR THE NATIVE RUNTIME (#1088): it reads what the harness's
//! door reads, and a write is refused until parking lands.
//!
//! The harness opens a vault FILE; the core's door reaches the vault the core
//! already holds. Over the same scenario they must answer the same rows, or
//! the phone and the fine-tuning loop run one runtime over two worlds.

use std::path::Path;

use centraid_assist::native::world::World;
use centraid_assist::native::{Door, meta::Kind};
use centraid_core::api_proto as wire;
use centraid_core::assist::door::WRITES_OFF_PREDICATE;
use centraid_core::{Core, CoreConfig};
use centraid_nativetools::vaultio::{Handle as Harness, SetClock};

/// A vault holding the scenario, closed to its file, copied, and the original reopened by a
/// fresh core. The copy is what the harness opens.
struct Pair {
    dir: std::path::PathBuf,
    core: centraid_core::Handle,
    copy: std::path::PathBuf,
}

impl Drop for Pair {
    fn drop(&mut self) {
        self.core.close();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn pair() -> Pair {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("vault.db");
    let copy = dir.join("harness.db");
    // Found a vault into `dir` and seed the scenario the way the shared helper
    // does, then end the file so the log is in it
    // (`docs/traps/wal-checkpoint.md`) and copy it.
    let core = Core::open(CoreConfig::new(&path)).expect("a core opens");
    core.open_own_bytes(path.with_extension("bytes"))
        .expect("the byte store opens");
    let answer = core
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Found(wire::FoundRequest {
                display_name: "Sample".to_owned(),
                owner_name: "Me".to_owned(),
                content: wire::FoundContent::Unspecified as i32,
                tz: String::new(),
            })),
        })
        .expect("the vault founds");
    let Some(wire::response::Kind::Found(_)) = answer.kind else {
        panic!("a found answered {:?}", answer.kind);
    };
    let report = core
        .with_vault(|vault| {
            centraid_core::example::seed(
                vault,
                core.registry(),
                &core.owner(),
                &|_| true,
                centraid_core::example::now_ms(),
            )
        })
        .expect("the scenario seeds");
    assert!(report.is_whole(), "the scenario seeds whole: {report:?}");
    core.close_file().expect("the file ends");
    std::fs::copy(&path, &copy).expect("the copy is made");
    drop(core);
    let core = Core::open(CoreConfig::new(&path)).expect("the core reopens");
    Pair { dir, core, copy }
}

fn harness(copy: &Path) -> Harness {
    Harness::open(copy, SetClock::at(1_800_000_000_000), "door-test").expect("the harness opens")
}

/// The world each door loads, rendered whole: rows, edges, ledger, everything.
fn world_of(door: &dyn Door) -> String {
    format!(
        "{:?}",
        World::load_with(door, false).expect("a world loads")
    )
}

#[test]
fn a_read_through_the_core_door_returns_the_rows_the_harness_door_returns() {
    let pair = pair();
    let core = pair.core.assist_door();
    let harness = harness(&pair.copy);

    // THE WHOLE WORLD, Locker off as on the phone: the 25 table reads the runtime makes at open.
    let from_core = world_of(&core);
    let from_harness = world_of(&harness);
    assert!(
        from_core.len() > 2_000,
        "the scenario is not empty: {} bytes",
        from_core.len()
    );
    assert_eq!(from_core, from_harness);

    // A table straight, in the kit's paged shape.
    for (table, columns, sort, pk) in [
        (
            "core_party",
            "party_id, display_name, kind",
            "party_id",
            "party_id",
        ),
        (
            "schedule_project",
            "project_id, name, area",
            "project_id",
            "project_id",
        ),
    ] {
        let a = core.table(table, columns, sort, pk).expect("core reads");
        let b = harness
            .table(table, columns, sort, pk)
            .expect("harness reads");
        assert!(!a.is_empty(), "{table} holds rows in the scenario");
        assert_eq!(a, b, "{table}");
    }

    // A search: a person's own name, over the entities the runtime searches.
    let world = World::load_with(&core, false).unwrap();
    let person = world
        .rows
        .values()
        .find(|row| row.kind == Kind::Person && row.name != world.me)
        .expect("the scenario holds a person");
    let word = person
        .name
        .split_whitespace()
        .next()
        .expect("a name has a word")
        .to_owned();
    for entity in ["core.party", "knowledge.note", "schedule.task"] {
        assert_eq!(
            core.search(entity, &word, 50).expect("core searches"),
            harness.search(entity, &word, 50).expect("harness searches"),
            "{entity}"
        );
    }
    // A text with no searchable word is an answer, not an error, on both.
    assert!(core.search("core.party", "!!", 5).unwrap().is_empty());
}

/// `YYYY-MM-DD` of a day count since 1970-01-01 (Hinnant's civil-from-days).
fn ymd(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn project_names(door: &dyn Door) -> Vec<String> {
    door.table(
        "schedule_project",
        "project_id, name",
        "project_id",
        "project_id",
    )
    .unwrap()
    .iter()
    .filter_map(|row| centraid_assist::native::door::text(row, "name"))
    .collect()
}

fn change_tables(pair: &Pair) -> Vec<String> {
    let mut tables = Vec::new();
    while let Ok(Some(event)) = pair.core.next_event(std::time::Duration::from_millis(1)) {
        if let Some(wire::event::Kind::Change(change)) = event.kind {
            tables.push(change.table);
        }
    }
    tables
}

#[test]
fn a_bare_run_is_refused_and_a_keyed_run_writes_once_through_the_change_feed() {
    let pair = pair();
    let door = pair.core.assist_door();
    let before = project_names(&door).len();
    let input = serde_json::json!({"name": "Door test"});
    let _ = change_tables(&pair);

    // A BARE RUN IS REFUSED, as a value, and the vault is untouched: a card's confirm is the only
    // way the phone's chat writes.
    let ran = door.run("schedule.save_project", input.clone()).unwrap();
    assert!(!ran.ok);
    assert_eq!(ran.predicate.as_deref(), Some(WRITES_OFF_PREDICATE));
    assert_eq!(project_names(&door).len(), before);
    assert!(change_tables(&pair).is_empty());

    // A KEYED RUN goes through `api::invoke`: the row lands and the feed names its table.
    let ran = door
        .run_keyed("pending-1:0", "schedule.save_project", input.clone())
        .unwrap();
    assert!(ran.ok, "{:?}", ran.reason);
    assert_eq!(project_names(&door).len(), before + 1);
    assert!(
        change_tables(&pair)
            .iter()
            .any(|table| table == "schedule_project")
    );

    // THE SAME KEY AGAIN writes nothing and answers what it answered; a new key writes.
    let again = door
        .run_keyed("pending-1:0", "schedule.save_project", input.clone())
        .unwrap();
    assert!(again.ok);
    assert_eq!(again.output, ran.output);
    assert_eq!(project_names(&door).len(), before + 1);
    assert!(
        change_tables(&pair).is_empty(),
        "a replay announces nothing"
    );
    door.run_keyed("pending-1:1", "schedule.save_project", input)
        .unwrap();
    assert_eq!(project_names(&door).len(), before + 2);

    // A command the vault refuses is a value with its predicate, never an Err, and is not
    // remembered: the same key may be asked again.
    let bad = serde_json::json!({"nope": 1});
    let ran = door
        .run_keyed("pending-2:0", "schedule.save_project", bad.clone())
        .unwrap();
    assert!(!ran.ok);
    assert_eq!(ran.predicate.as_deref(), Some("schema"));
    assert!(
        !door
            .run_keyed("pending-2:0", "schedule.save_project", bad)
            .unwrap()
            .ok
    );
}

#[test]
fn events_on_the_core_door_are_the_ones_the_harness_door_reads_in_every_zone() {
    let pair = pair();
    let core = pair.core.assist_door();
    let now = core.now_ms();
    let harness = Harness::open(&pair.copy, SetClock::at(now), "door-test").unwrap();
    let today = now.div_euclid(86_400_000);
    // the window the runtime reads: 31 days back, 120 ahead
    let (from, to) = (ymd(today - 31), ymd(today + 120));
    for tz in ["Etc/UTC", "America/Los_Angeles", "Pacific/Auckland"] {
        let a = core
            .events(&from, &to, tz)
            .unwrap_or_else(|e| panic!("{tz}: {e}"));
        let b = harness.events(&from, &to, tz).unwrap();
        assert!(
            !a.is_empty(),
            "{tz}: the scenario holds events in the window"
        );
        assert_eq!(format!("{a:?}"), format!("{b:?}"), "{tz}");
    }
    assert!(
        core.events("2026-10-01", "2026-10-02", "Not/AZone")
            .is_err()
    );
}

#[test]
fn ids_and_the_clock_are_the_vaults_and_the_locker_is_not_there() {
    let pair = pair();
    let door = pair.core.assist_door();
    let (a, b) = (door.mint_id(), door.mint_id());
    assert!(!a.is_empty() && a != b);
    assert!(door.now_ms() > 1_700_000_000_000);
    assert!(door.seal("item", "secret").is_err());
    assert!(door.unseal("key", "item", "sealed").is_err());
}

#[test]
fn money_reaches_the_world_through_the_core_door_as_signed_rows_inside_the_window() {
    // #1099, R-1099-8: the phone's door answers `table_where` through the same paged read a
    // screen uses, and the runtime's world holds the recent months of an account's lines.
    let pair = pair();
    let door = pair.core.assist_door();
    let today = door.now_ms().div_euclid(86_400_000);
    let day = |back: i64| ymd(today - back);
    let account = door.mint_id();
    let run = |key: &str, command: &str, input: serde_json::Value| {
        let ran = door.run_keyed(key, command, input).unwrap();
        assert!(ran.ok, "{command}: {:?}", ran.reason);
    };
    run(
        "money-1:0",
        "money.add_account",
        serde_json::json!({"account_id": account, "name": "Everyday", "kind": "checking"}),
    );
    let line = |id: String, external: &str, back: i64, minor: i64, direction: &str, name: &str| {
        serde_json::json!({
            "txn_id": id, "external_id": external, "posted_on": day(back),
            "amount_minor": minor, "direction": direction, "description": name.to_uppercase(),
            "display_name": name,
            "category_concept_id": "money:cat:food.groceries",
        })
    };
    let (recent, income, old) = (door.mint_id(), door.mint_id(), door.mint_id());
    run(
        "money-1:1",
        "money.import_transactions",
        serde_json::json!({
            "account_id": account, "source": "csv",
            "rows": [
                line(recent.clone(), &format!("csv:{:064x}", 1), 2, 4_250, "debit", "Corner Market"),
                line(income.clone(), &format!("csv:{:064x}", 2), 3, 100_000, "credit", "Payroll"),
                // two years back: outside the three months the world holds
                line(old.clone(), &format!("csv:{:064x}", 3), 730, 999, "debit", "Ancient"),
            ],
        }),
    );

    let world = World::load_in(&door, false, true, None).expect("a world loads");
    let held: Vec<(&str, String)> = world
        .of_kind(Kind::Transaction)
        .map(|row| {
            (
                row.name.as_str(),
                format!("{:?}", row.field("amount").unwrap()),
            )
        })
        .collect();
    assert_eq!(held.len(), 2, "{held:?}");
    assert!(
        world
            .rows
            .contains_key(&(Kind::Transaction, recent.clone()))
    );
    assert!(!world.rows.contains_key(&(Kind::Transaction, old)));
    let amount = |id: &String| {
        world
            .row(&(Kind::Transaction, id.clone()))
            .unwrap()
            .field("amount")
            .cloned()
    };
    assert_eq!(
        amount(&recent),
        Some(centraid_assist::native::world::Val::Money(
            -4_250,
            "USD".to_owned()
        ))
    );
    assert_eq!(
        amount(&income),
        Some(centraid_assist::native::world::Val::Money(
            100_000,
            "USD".to_owned()
        ))
    );
    let row = world.row(&(Kind::Transaction, recent)).unwrap();
    assert_eq!(row.name, "Corner Market");
    assert_eq!(
        row.field("category"),
        Some(&centraid_assist::native::world::Val::Text(
            "Groceries".to_owned()
        ))
    );

    // Money off reads none of it
    let without = World::load_in(&door, false, false, None).expect("a world loads");
    assert_eq!(without.of_kind(Kind::Transaction).count(), 0);
}
