//! THE CORE'S DOOR FOR THE NATIVE RUNTIME (#1088): it reads what the harness's
//! door reads, and a write is refused until parking lands.
//!
//! The harness opens a vault FILE; the core's door reaches the vault the core
//! already holds. Over the same scenario they must answer the same rows, or
//! the phone and the fine-tuning loop run one runtime over two worlds.

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
    let dir = centraid_ontology::scratch::scratch_dir();
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
    // On the core's clock: Money's lines are held for the months around "now" (R-1099-81), so
    // two doors on two clocks would hold two windows of the demo ledger.
    let harness = Harness::open(&pair.copy, SetClock::at(core.now_ms()), "door-test")
        .expect("the harness opens");

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
        ("entity", "id, title, kind, created_at", "created_at", "id"),
        ("container", "id, kind, parent_id", "id", "id"),
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
    for entity in ["person", "note", "task"] {
        assert_eq!(
            core.search(entity, &word, 50).expect("core searches"),
            harness.search(entity, &word, 50).expect("harness searches"),
            "{entity}"
        );
    }
    // A text with no searchable word is an answer, not an error, on both.
    assert!(core.search("person", "!!", 5).unwrap().is_empty());
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
    door.table_where(
        "entity",
        "id, title, created_at",
        "created_at",
        "id",
        "kind = ?",
        &["project".to_owned()],
    )
    .unwrap()
    .iter()
    .filter_map(|row| centraid_assist::native::door::text(row, "title"))
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
    let input = serde_json::json!({"kind": "project", "title": "Door test"});
    let _ = change_tables(&pair);

    // A BARE RUN IS REFUSED, as a value, and the vault is untouched: a card's confirm is the only
    // way the phone's chat writes.
    let ran = door.run("container.create", input.clone()).unwrap();
    assert!(!ran.ok);
    assert_eq!(ran.predicate.as_deref(), Some(WRITES_OFF_PREDICATE));
    assert_eq!(project_names(&door).len(), before);
    assert!(change_tables(&pair).is_empty());

    // A KEYED RUN goes through `api::invoke`: the row lands and the feed names its table.
    let ran = door
        .run_keyed("pending-1:0", "container.create", input.clone())
        .unwrap();
    assert!(ran.ok, "{:?}", ran.reason);
    assert_eq!(project_names(&door).len(), before + 1);
    assert!(
        change_tables(&pair)
            .iter()
            .any(|table| table == "container")
    );

    // THE SAME KEY AGAIN writes nothing and answers what it answered; a new key writes.
    let again = door
        .run_keyed("pending-1:0", "container.create", input.clone())
        .unwrap();
    assert!(again.ok);
    assert_eq!(again.output, ran.output);
    assert_eq!(project_names(&door).len(), before + 1);
    assert!(
        change_tables(&pair).is_empty(),
        "a replay announces nothing"
    );
    door.run_keyed("pending-1:1", "container.create", input)
        .unwrap();
    assert_eq!(project_names(&door).len(), before + 2);

    // A command the vault refuses is a value with its predicate, never an Err, and is not
    // remembered: the same key may be asked again.
    let bad = serde_json::json!({"nope": 1});
    let ran = door
        .run_keyed("pending-2:0", "container.create", bad.clone())
        .unwrap();
    assert!(!ran.ok);
    assert_eq!(ran.predicate.as_deref(), Some("schema"));
    assert!(
        !door
            .run_keyed("pending-2:0", "container.create", bad)
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
        "account.add",
        // The demo ledger (`example::seed_money`) already holds an "Everyday"; this account's
        // lines are told apart from its by the account's own name.
        serde_json::json!({"id": account, "title": "Door test", "type": "checking"}),
    );
    // a followed line, signed (money out is negative); `follow.statement` names each by the id
    // its source gave it
    let line = |external: &str, back: i64, minor: i64, name: &str| {
        serde_json::json!({
            "external_id": external,
            "fields": {
                "title": name, "posted_on": day(back), "amount_minor": minor,
                "category_id": "category:food.groceries",
                "line": {"description": name.to_uppercase()},
            },
        })
    };
    let externals: Vec<String> = (1..=3).map(|n| format!("csv:{n:064x}")).collect();
    run(
        "money-1:1",
        "follow.statement",
        serde_json::json!({
            "origin": {"ref": account, "label": "Door test", "fills": account},
            "records": [
                line(&externals[0], 2, -4_250, "Corner Market"),
                line(&externals[1], 3, 100_000, "Payroll"),
                // two years back: outside the three months the world holds
                line(&externals[2], 730, -999, "Ancient"),
            ],
        }),
    );
    let followed = |external: &String| -> String {
        door.table_where(
            "source",
            "external_id, entity_id",
            "external_id",
            "external_id",
            "external_id = ?",
            std::slice::from_ref(external),
        )
        .unwrap()
        .first()
        .and_then(|row| centraid_assist::native::door::text(row, "entity_id"))
        .expect("a followed line")
    };
    let (recent, income, old) = (
        followed(&externals[0]),
        followed(&externals[1]),
        followed(&externals[2]),
    );

    let world = World::load_in(&door, false, true, None).expect("a world loads");
    let held: Vec<(&str, String)> = world
        .of_kind(Kind::Transaction)
        .filter(|row| {
            row.field("account")
                == Some(&centraid_assist::native::world::Val::Text(
                    "Door test".to_owned(),
                ))
        })
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

// ---------------------------------------------------------------------------
// THE ASSISTANT NEVER REACHES LOCKER (R-1088-3, the Locker lane's L4 and L5).
//
// A Locker item is an entity, so the rows the door reads and the verbs it runs
// are the same ones that serve every other kind. These hold the refusals at
// the door the phone actually uses: no row, no title, no edge, no tag on an
// item; no Locker table; and no command that names an item, through any verb.
// ---------------------------------------------------------------------------

/// A Locker item tagged, starred and linked by a note, through the owner's own door.
fn with_a_locker_item(pair: &Pair) -> (String, String) {
    let owner = pair.core.owner();
    let run = |name: &str, input: serde_json::Value| {
        pair.core
            .with_vault(|vault| {
                vault
                    .execute(
                        pair.core.registry(),
                        &owner,
                        &centraid_vault::commands::Command::new(name, input),
                    )
                    .map_err(centraid_core::CoreError::from)
            })
            .expect("the owner's command answers")
    };
    let added = run(
        "locker.add_item",
        serde_json::json!({
            "item_id": "lk-bank", "type": "login", "title": "Hidden Vaultbank login",
            "username": "plainname"
        }),
    );
    assert_eq!(
        added.status,
        centraid_vault::CommandStatus::Executed,
        "{:?}",
        added.reason
    );
    for (name, input) in [
        (
            "tag.add",
            serde_json::json!({"id": "lk-bank", "label": "vaultonly"}),
        ),
        (
            "flag.set",
            serde_json::json!({"id": "lk-bank", "flag": "starred"}),
        ),
    ] {
        let ran = run(name, input);
        assert_eq!(
            ran.status,
            centraid_vault::CommandStatus::Executed,
            "{name}: {:?}",
            ran.reason
        );
    }
    let note = run(
        "note.create",
        serde_json::json!({"title": "Links the bank", "body": "see the login"}),
    );
    let note_id = note.output["id"].as_str().expect("a note id").to_owned();
    let linked = run(
        "edge.add",
        serde_json::json!({"from": note_id, "rel": "links", "to": "lk-bank"}),
    );
    assert_eq!(
        linked.status,
        centraid_vault::CommandStatus::Executed,
        "{:?}",
        linked.reason
    );
    ("lk-bank".to_owned(), note_id)
}

#[test]
fn the_core_door_serves_no_row_title_edge_or_tag_of_a_locker_item() {
    let pair = pair();
    let (item, note) = with_a_locker_item(&pair);
    let door = pair.core.assist_door();

    // Rows and titles: the entity table has the note and not the item.
    let entities = door
        .table("entity", "id, title, kind", "id", "id")
        .expect("the door reads entity");
    let seen = format!("{entities:?}");
    assert!(seen.contains(&note), "the door reads the other kinds");
    assert!(
        !seen.contains(&item)
            && !seen.contains("Hidden Vaultbank")
            && !seen.contains("locker_item"),
        "the door served a Locker item: {seen}"
    );
    let by_kind = door
        .table_where(
            "entity",
            "id, title",
            "id",
            "id",
            "kind = ?",
            &["locker_item".to_owned()],
        )
        .expect("the door answers");
    assert!(by_kind.is_empty(), "{by_kind:?}");

    // Edges and tags: nothing that touches the item, the note's link and the item's tag and star
    // included. The tag's own word is the vault's (L6), and no edge says which item carries it.
    let edges = door
        .table("edge", "from_id, rel, to_id", "from_id", "to_id")
        .expect("the door reads edge");
    let seen = format!("{edges:?}");
    assert!(
        !seen.contains(&item),
        "the door served an edge of a Locker item: {seen}"
    );
    let tagged = door
        .table_where(
            "edge",
            "from_id, to_id",
            "from_id",
            "to_id",
            "rel = ?",
            &["tagged".to_owned()],
        )
        .expect("the door answers");
    assert!(!format!("{tagged:?}").contains(&item), "{tagged:?}");

    // Locker's own tables are not read at all, by any name.
    for table in [
        "locker_item",
        "locker_item_field",
        "locker_item_passkey",
        "locker_item_alias",
    ] {
        let sort = if table == "locker_item" {
            "id"
        } else {
            "item_id"
        };
        assert!(
            door.table(table, sort, sort, sort).is_err(),
            "the door read {table}"
        );
    }

    // And the world the runtime builds, Locker off, holds none of it.
    let world = world_of(&door);
    assert!(
        !world.contains("Hidden Vaultbank")
            && !world.contains("lk-bank")
            && !world.contains("plainname"),
        "the world holds a Locker item"
    );
    // The search index has none either: Locker is not indexed.
    assert!(
        door.search("note", "Vaultbank", 20)
            .expect("a search")
            .is_empty()
    );
}

#[test]
fn a_command_that_names_a_locker_item_is_refused_under_the_assistants_principal_through_any_verb() {
    let pair = pair();
    let (item, note) = with_a_locker_item(&pair);
    let door = pair.core.assist_door();
    for (key, command, input) in [
        (
            "l1:0",
            "entity.retitle",
            serde_json::json!({"id": item, "title": "renamed"}),
        ),
        ("l2:0", "entity.trash", serde_json::json!({"id": item})),
        ("l3:0", "entity.restore", serde_json::json!({"id": item})),
        ("l4:0", "entity.purge", serde_json::json!({"id": item})),
        (
            "l5:0",
            "entity.empty_trash",
            serde_json::json!({"kind": "locker_item"}),
        ),
        (
            "l6:0",
            "tag.add",
            serde_json::json!({"id": item, "label": "spy"}),
        ),
        (
            "l7:0",
            "tag.remove",
            serde_json::json!({"id": item, "label": "vaultonly"}),
        ),
        (
            "l8:0",
            "flag.clear",
            serde_json::json!({"id": item, "flag": "starred"}),
        ),
        (
            "l9:0",
            "flag.set",
            serde_json::json!({"id": item, "flag": "archived"}),
        ),
        (
            "l10:0",
            "edge.add",
            serde_json::json!({"from": note, "rel": "about", "to": item}),
        ),
        (
            "l11:0",
            "edge.remove",
            serde_json::json!({"from": note, "rel": "links", "to": item}),
        ),
        ("l12:0", "locker.counts", serde_json::json!({})),
        (
            "l13:0",
            "locker.edit_item",
            serde_json::json!({"item_id": item, "title": "x"}),
        ),
        (
            "l14:0",
            "locker.export",
            serde_json::json!({"confirm": true}),
        ),
    ] {
        let ran = door
            .run_keyed(key, command, input)
            .expect("the door answers");
        assert!(!ran.ok, "{command} reached Locker: {:?}", ran.output);
        assert_eq!(
            ran.predicate.as_deref(),
            Some(centraid_vault::commands::ASSISTANT_CLOSED_OUT),
            "{command}: {:?}",
            ran.reason
        );
        let said = ran.reason.unwrap_or_default();
        assert!(
            !said.contains("Hidden Vaultbank") && !said.contains("lk-bank"),
            "{said}"
        );
    }
    // Nothing moved: the owner still sees the item whole, live, titled, tagged and linked.
    let page = |from: &str, select: &[&str], sort: &str, predicate: &str, binds: usize| {
        pair.core
            .with_vault(|vault| {
                vault
                    .keyset_page(&centraid_vault::page::KeysetPage {
                        // Locker's own read, so the vault serves an item's row and edges to it.
                        name: "locker.check".to_owned(),
                        select: select.iter().map(|column| (*column).to_owned()).collect(),
                        from: from.to_owned(),
                        predicate: Some(predicate.to_owned()),
                        binds: vec![centraid_vault::value::Value::Text(item.clone()); binds],
                        sort_column: sort.to_owned(),
                        pk_column: sort.to_owned(),
                        descending: false,
                        limit: 50,
                        after: None,
                        held_thumbnail: false,
                        document_size: false,
                    })
                    .map_err(centraid_core::CoreError::from)
            })
            .expect("the owner reads")
            .rows
    };
    let rows = page("entity", &["id", "title", "deleted_at"], "id", "id = ?", 1);
    let [row] = rows.as_slice() else {
        panic!("the item is gone: {rows:?}");
    };
    assert_eq!(
        format!("{:?}", row.get("title")),
        format!(
            "{:?}",
            Some(centraid_vault::value::Value::Text(
                "Hidden Vaultbank login".to_owned()
            ))
        )
    );
    assert_eq!(
        row.get("deleted_at"),
        Some(&centraid_vault::value::Value::Null)
    );
    let edges = page(
        "edge",
        &["from_id", "to_id"],
        "from_id",
        "from_id = ? OR to_id = ?",
        2,
    );
    assert_eq!(edges.len(), 3, "the item's star, tag and link: {edges:?}");

    // The assistant keeps every other kind: the same verb on the note runs.
    let ran = door
        .run_keyed(
            "n1:0",
            "entity.retitle",
            serde_json::json!({"id": note, "title": "Renamed note"}),
        )
        .expect("the door answers");
    assert!(ran.ok, "{:?}", ran.reason);
}
