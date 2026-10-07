//! THE CORE'S DOOR FOR THE NATIVE RUNTIME (#1088): it reads what the harness's
//! door reads, and a write is refused until parking lands.
//!
//! The harness opens a vault FILE; the core's door reaches the vault the core
//! already holds. Over the same sample vault they must answer the same rows, or
//! the phone and the fine-tuning loop run one runtime over two worlds.

use std::path::Path;

use centraid_assist::native::world::World;
use centraid_assist::native::{Door, meta::Kind};
use centraid_core::api_proto as wire;
use centraid_core::assist::door::WRITES_OFF_PREDICATE;
use centraid_core::{Core, CoreConfig};
use centraid_nativetools::vaultio::{Handle as Harness, SetClock};

/// The sample vault, closed to its file, copied, and the original reopened by a
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
    // Found the sample into `dir` the way the shared helper does, then end the
    // file so the log is in it (`docs/traps/wal-checkpoint.md`) and copy it.
    let core = Core::open(CoreConfig::new(&path)).expect("a core opens");
    core.open_own_bytes(path.with_extension("bytes"))
        .expect("the byte store opens");
    core.call(&wire::Request {
        kind: Some(wire::request::Kind::Found(wire::FoundRequest {
            display_name: "Sample".to_owned(),
            owner_name: "Me".to_owned(),
            content: wire::FoundContent::Sample as i32,
        })),
    })
    .expect("the sample vault founds");
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
        "the sample vault is not empty: {} bytes",
        from_core.len()
    );
    assert_eq!(from_core, from_harness);

    // A table straight, in the kit's paged shape, and the ledger.
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
        assert!(!a.is_empty(), "{table} holds rows in the sample");
        assert_eq!(a, b, "{table}");
    }
    assert_eq!(
        format!("{:?}", core.tally().expect("core ledger")),
        format!("{:?}", harness.tally().expect("harness ledger"))
    );

    // A search: a person's own name, over the entities the runtime searches.
    let world = World::load_with(&core, false).unwrap();
    let person = world
        .rows
        .values()
        .find(|row| row.kind == Kind::Person && row.name != world.me)
        .expect("the sample holds a person");
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

#[test]
fn the_door_refuses_a_write_until_writes_are_allowed_and_then_writes_through_the_change_feed() {
    let pair = pair();
    let door = pair.core.assist_door();
    let before = door
        .table(
            "schedule_project",
            "project_id, name",
            "project_id",
            "project_id",
        )
        .unwrap()
        .len();
    let input = serde_json::json!({"name": "Door test"});

    // REFUSED, as a value, and the vault untouched.
    let ran = door.run("schedule.save_project", input.clone()).unwrap();
    assert!(!ran.ok);
    assert_eq!(ran.predicate.as_deref(), Some(WRITES_OFF_PREDICATE));
    assert_eq!(
        door.table(
            "schedule_project",
            "project_id, name",
            "project_id",
            "project_id"
        )
        .unwrap()
        .len(),
        before
    );
    let mut changes = 0;
    while let Ok(Some(event)) = pair.core.next_event(std::time::Duration::from_millis(1)) {
        if matches!(event.kind, Some(wire::event::Kind::Change(_))) {
            changes += 1;
        }
    }
    let quiet = changes;

    // ALLOWED: through `api::invoke`, so the feed fires and a screen would refresh.
    door.allow_writes(true);
    let ran = door.run("schedule.save_project", input).unwrap();
    assert!(ran.ok, "{:?}", ran.reason);
    assert_eq!(
        door.table(
            "schedule_project",
            "project_id, name",
            "project_id",
            "project_id"
        )
        .unwrap()
        .len(),
        before + 1
    );
    let mut tables = Vec::new();
    while let Ok(Some(event)) = pair.core.next_event(std::time::Duration::from_millis(1)) {
        if let Some(wire::event::Kind::Change(change)) = event.kind {
            tables.push(change.table);
        }
    }
    assert!(
        tables.iter().any(|table| table == "schedule_project"),
        "the write announced its table: {tables:?} (before: {quiet})"
    );

    // A command the vault refuses is a value with its predicate, never an Err.
    let ran = door
        .run("schedule.save_project", serde_json::json!({"nope": 1}))
        .unwrap();
    assert!(!ran.ok);
    assert_eq!(ran.predicate.as_deref(), Some("schema"));
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
