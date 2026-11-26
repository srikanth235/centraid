//! The trash and what it empties ([#1146](https://github.com/srikanth235/centraid/issues/1146),
//! wave 3, and #1214 K4): an overdue row is restorable until a pass empties it, the pass is
//! bounded and a clock far from the last write empties nothing, a purge clears what an origin
//! fills. (The bytes under the trash, `released` and the
//! file sweep, are K10's: `tests/blob_release.rs`.)

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

const DAY_MS: i64 = 86_400_000;
const AT: &str = "2026-03-01T09:00:00.000Z";

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded_with_blobs("trash-bytes").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: Value) -> centraid_vault::CommandOutcome {
        self.scratch.clock.advance_ms(1_000);
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    /// `days` go by, the member opening and writing on the day before the next launch: the
    /// launch pass trusts the clock only within a week of the vault's last write (V19).
    fn later(&self, days: i64) {
        self.scratch.clock.advance_ms((days - 1) * DAY_MS);
        common::insert_note_with(&self.scratch.vault, "in use", "x").expect("a note");
        self.scratch.clock.advance_ms(DAY_MS);
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    fn on_disk(&self, hash: &str) -> bool {
        self.scratch
            .vault
            .blobs()
            .expect("a store")
            .has(hash)
            .expect("asks")
    }

    /// A document, written the way its command will write it: bytes in the store, the claim, the
    /// entity and its row.
    fn document(&self, title: &str, seed: &str) -> (String, String) {
        let blob = self
            .scratch
            .vault
            .blobs()
            .expect("a store")
            .put(seed.as_bytes())
            .expect("stored");
        let id = self.scratch.vault.ids().next();
        self.scratch
            .vault
            .commit(|tx| {
                centraid_vault::blob::stage(tx.connection(), &blob, seed.len() as i64)?;
                tx.insert_entity(&id, Kind::Document, title, AT)?;
                tx.connection().execute(
                    "INSERT INTO document (id, blob, media_type) VALUES (?1, ?2, 'application/pdf')",
                    rusqlite::params![id, blob],
                )?;
                Ok(())
            })
            .expect("a document");
        (id, blob)
    }
}

#[test]
fn an_overdue_row_is_restorable_until_the_pass_runs_and_gone_after_it() {
    let w = World::new();
    let (id, blob) = w.document("Old lease", "old lease");
    w.ok("entity.trash", json!({ "id": id }));
    w.scratch.clock.advance_ms(45 * DAY_MS);
    // Overdue and still a row: nothing hides it, and a restore is not refused.
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[&id]),
        1
    );
    w.ok("entity.restore", json!({ "id": id }));
    assert_eq!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&id]),
        None
    );

    // Trashed again and left past its date, the launch pass empties it.
    w.ok("entity.trash", json!({ "id": id }));
    w.later(45);
    let emptied = w
        .scratch
        .vault
        .empty_overdue_trash(&w.registry, 100)
        .expect("one pass");
    assert_eq!(emptied.purged, 1);
    assert!(!emptied.more);
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[&id]),
        0
    );
    assert!(!w.on_disk(&blob), "the purged document's bytes went too");
}

#[test]
fn the_launch_pass_is_bounded_and_says_when_more_is_overdue() {
    let w = World::new();
    for n in 0..5 {
        let (id, _) = w.document(&format!("Doc {n}"), &format!("doc {n}"));
        w.ok("entity.trash", json!({ "id": id }));
    }
    w.later(31);
    let first = w.scratch.vault.empty_overdue_trash(&w.registry, 2).unwrap();
    assert_eq!((first.purged, first.more), (2, true));
    let second = w.scratch.vault.empty_overdue_trash(&w.registry, 2).unwrap();
    assert_eq!((second.purged, second.more), (2, true));
    let third = w.scratch.vault.empty_overdue_trash(&w.registry, 2).unwrap();
    assert_eq!((third.purged, third.more), (1, false));
}

#[test]
fn a_row_still_inside_its_window_is_not_taken_by_the_pass() {
    let w = World::new();
    let (id, _) = w.document("Recent", "recent");
    w.ok("entity.trash", json!({ "id": id }));
    w.later(29);
    let emptied = w
        .scratch
        .vault
        .empty_overdue_trash(&w.registry, 100)
        .unwrap();
    assert_eq!(emptied.purged, 0);
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[&id]),
        1
    );
}

#[test]
fn purging_a_calendar_or_a_folder_an_origin_fills_clears_the_origin() {
    let w = World::new();
    let calendar = w.ok(
        "container.create",
        json!({ "kind": "calendar", "title": "Work" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let folder = w.ok(
        "container.create",
        json!({ "kind": "folder", "title": "Inbox" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (system, kind, holder) in [
        ("calendar", "calendar", &calendar),
        ("files", "folder", &folder),
    ] {
        w.scratch
            .vault
            .commit(|tx| {
                tx.connection().execute(
                    "INSERT INTO origin (id, system, ref, label, fills, fills_kind, created_at)
                     VALUES (?1, ?2, ?1, 'Followed', ?3, ?4, '2026-03-01T09:00:00.000Z')",
                    rusqlite::params![format!("origin-{system}"), system, holder, kind],
                )?;
                Ok(())
            })
            .expect("an origin");
        // A calendar and a folder are each trashed first.
        w.ok("entity.trash", json!({ "id": holder }));
        w.ok("entity.purge", json!({ "id": holder }));
        assert_eq!(
            w.one::<i64>("SELECT COUNT(*) FROM origin WHERE fills IS NOT NULL", &[]),
            0,
            "the {system} origin follows nothing once its target is gone"
        );
    }
}

/// V19 (named as the plan lists it): one year ahead, nothing is purged and no action key is
/// dropped; one day ahead, what is due is purged. Counts only.
#[test]
fn a_clock_far_ahead_purges_nothing() {
    let w = World::new();
    let (trashed, _) = w.document("Old lease", "old lease");
    w.ok("entity.trash", json!({ "id": trashed }));
    let held = |w: &World| -> i64 {
        w.scratch
            .vault
            .read(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM entity WHERE deleted_at IS NOT NULL",
                    [],
                    |r| r.get(0),
                )?)
            })
            .expect("counts")
    };
    let keys = |w: &World| -> i64 {
        w.scratch
            .vault
            .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM action_key", [], |r| r.get(0))?))
            .expect("counts")
    };
    let keys_before = keys(&w);
    // A year ahead: the row reads as long overdue; nothing is purged, no key is dropped.
    w.scratch.clock.advance_ms(365 * DAY_MS);
    let step = w
        .scratch
        .vault
        .empty_overdue_trash_step(&w.registry, 50, false)
        .expect("the pass runs");
    assert_eq!(step.purged, 0);
    assert_eq!(held(&w), 1);
    assert_eq!(keys(&w), keys_before);
}
