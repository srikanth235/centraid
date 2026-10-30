//! The trash and the bytes under it ([#1146](https://github.com/srikanth235/centraid/issues/1146),
//! wave 3): an overdue row is restorable until a pass empties it, a purge clears
//! what an origin fills, moving a section moves its tasks, every command that can
//! drop the last reference to a blob returns `released` and the store loses the
//! file, files with no row are swept, and a backup does not carry what is past
//! its purge date.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

const DAY_MS: i64 = 86_400_000;

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

    fn exec(&self, sql: &'static str) {
        self.scratch
            .vault
            .commit(|tx| {
                tx.connection().execute(sql, [])?;
                Ok(())
            })
            .expect("commits");
    }

    /// Bytes put into the store the way the stage door does, and claimed by the
    /// command that names them.
    fn put(&self, seed: &str) -> String {
        self.scratch
            .vault
            .blobs()
            .expect("a store")
            .put(seed.as_bytes())
            .expect("stored")
    }

    fn on_disk(&self, hash: &str) -> bool {
        self.scratch
            .vault
            .blobs()
            .expect("a store")
            .has(hash)
            .expect("asks")
    }

    fn document(&self, title: &str, seed: &str) -> (String, String) {
        let blob = self.put(seed);
        let id = self.ok(
            "document.add",
            json!({ "title": title, "blob": blob, "size": seed.len(), "media_type": "application/pdf" }),
        )["id"]
            .as_str()
            .expect("an id")
            .to_owned();
        (id, blob)
    }

    fn hashes(value: &Value) -> Vec<String> {
        value
            .as_array()
            .unwrap_or_else(|| panic!("`released` is a list of hashes, not {value}"))
            .iter()
            .map(|hash| hash.as_str().expect("a hash").to_owned())
            .collect()
    }
}

// ---------------------------------------------------------------------------
// T: an overdue row is restorable until a pass empties it
// ---------------------------------------------------------------------------

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
    w.scratch.clock.advance_ms(45 * DAY_MS);
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
    w.scratch.clock.advance_ms(31 * DAY_MS);
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
    w.scratch.clock.advance_ms(29 * DAY_MS);
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

// ---------------------------------------------------------------------------
// origin.fills, for every kind an origin can fill
// ---------------------------------------------------------------------------

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
    for (system, holder) in [("calendar", &calendar), ("files", &folder)] {
        w.scratch
            .vault
            .commit(|tx| {
                tx.connection().execute(
                    "INSERT INTO origin (id, system, ref, label, fills, created_at)
                     VALUES (?1, ?2, ?1, 'Followed', ?3, '2026-03-01T09:00:00.000Z')",
                    rusqlite::params![format!("origin-{system}"), system, holder],
                )?;
                Ok(())
            })
            .expect("an origin");
        // A calendar is deleted, not moved to the trash; a folder is trashed first.
        if system == "files" {
            w.ok("entity.trash", json!({ "id": holder }));
        }
        w.ok("entity.purge", json!({ "id": holder }));
        assert_eq!(
            w.one::<i64>("SELECT COUNT(*) FROM origin WHERE fills IS NOT NULL", &[]),
            0,
            "the {system} origin follows nothing once its target is gone"
        );
    }
}

// ---------------------------------------------------------------------------
// container.move of a section re-files its tasks
// ---------------------------------------------------------------------------

#[test]
fn moving_a_section_to_another_project_takes_its_tasks_with_it() {
    let w = World::new();
    let make = |kind: &str, title: &str, parent: Option<&str>| {
        w.ok(
            "container.create",
            json!({ "kind": kind, "title": title, "parent": parent }),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let from = make("project", "Old", None);
    let to = make("project", "New", None);
    let section = make("section", "Packing", Some(&from));
    for id in ["t1", "t2"] {
        w.scratch
            .vault
            .commit(|tx| {
                tx.insert_entity(
                    id,
                    centraid_vault::model::Kind::Task,
                    id,
                    "2026-03-01T09:00:00.000Z",
                )?;
                tx.connection().execute(
                    "INSERT INTO task (id, project_id, section_id) VALUES (?1, ?2, ?3)",
                    rusqlite::params![id, from, section],
                )?;
                Ok(())
            })
            .expect("a task");
    }
    // One of them is in the trash: it moves too, so a restore finds it whole.
    w.ok("entity.trash", json!({ "id": "t2" }));
    w.ok("container.move", json!({ "id": section, "parent": to }));
    for id in ["t1", "t2"] {
        assert_eq!(
            w.one::<String>("SELECT project_id FROM task WHERE id = ?1", &[id]),
            to,
            "{id} follows its section"
        );
    }
    w.ok("entity.restore", json!({ "id": "t2" }));
    assert_eq!(
        w.one::<String>("SELECT section_id FROM task WHERE id = 't2'", &[]),
        section
    );
}

// ---------------------------------------------------------------------------
// every command that can drop the last reference to a blob says `released`
// ---------------------------------------------------------------------------

#[test]
fn derivative_drop_and_write_release_the_bytes_they_stop_naming() {
    let w = World::new();
    let (_, original) = w.document("Scan", "scan");
    let first = w.put("first thumb");
    let second = w.put("second thumb");
    w.ok(
        "derivative.write",
        json!({ "blob": original, "variant": "thumb", "out": first, "out_size": 11, "media_type": "image/jpeg" }),
    );
    // The variant's earlier file is replaced: nothing names it any more.
    let replaced = w.ok(
        "derivative.write",
        json!({ "blob": original, "variant": "thumb", "out": second, "out_size": 12, "media_type": "image/jpeg" }),
    );
    assert_eq!(World::hashes(&replaced["released"]), vec![first.clone()]);
    assert!(!w.on_disk(&first), "the replaced thumbnail's file went");
    let dropped = w.ok(
        "derivative.drop",
        json!({ "blob": original, "variant": "thumb" }),
    );
    assert_eq!(World::hashes(&dropped["released"]), vec![second.clone()]);
    assert!(!w.on_disk(&second), "the dropped thumbnail's file went");
    assert!(w.on_disk(&original), "the document still holds its bytes");
}

const PIXEL_A: &str = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const PIXEL_B: &str = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEB";

fn turn_with(thumb: &str) -> Value {
    json!({ "turn": { "question": { "text": "q", "attachments": [
        { "form": "image", "label": "pic", "thumbnail_data_uri": thumb }] },
        "answer": { "outcome": "answered", "text": "a", "cards": [] } } })
}

#[test]
fn a_regenerated_turn_releases_the_thumbnail_it_replaced_as_hashes() {
    let w = World::new();
    let saved = w.ok("thread.save_turn", turn_with(PIXEL_A));
    let thread = saved["thread_id"].as_str().unwrap().to_owned();
    let old: String = w.one("SELECT thumb FROM message_attachment", &[]);
    let mut again = turn_with(PIXEL_B);
    again["thread_id"] = json!(thread);
    again["replace_last"] = json!(true);
    let saved = w.ok("thread.save_turn", again);
    assert_eq!(World::hashes(&saved["released"]), vec![old.clone()]);
    assert!(!w.on_disk(&old), "the replaced turn's thumbnail file went");
}

#[test]
fn thread_clear_releases_every_thumbnail_it_drops() {
    let w = World::new();
    w.ok("thread.save_turn", turn_with(PIXEL_A));
    let thumb: String = w.one("SELECT thumb FROM message_attachment", &[]);
    let cleared = w.ok("thread.clear", json!({}));
    assert_eq!(World::hashes(&cleared["released"]), vec![thumb.clone()]);
    assert!(!w.on_disk(&thumb));
}

#[test]
fn blob_collect_releases_the_files_it_collects() {
    let w = World::new();
    let orphan = w.put("orphan");
    w.ok("blob.stage", json!({ "hash": orphan, "size": 6 }));
    let collected = w.ok("blob.collect", json!({}));
    assert_eq!(World::hashes(&collected["released"]), vec![orphan.clone()]);
    assert!(!w.on_disk(&orphan), "a collected blob's file goes with it");
}

// ---------------------------------------------------------------------------
// files with no row
// ---------------------------------------------------------------------------

/// Mark a file in the store as written at `at`.
fn written_at(w: &World, hash: &str, at: std::time::SystemTime) {
    let path = w
        .scratch
        .vault
        .blobs()
        .expect("a store")
        .path_of(hash)
        .expect("asks")
        .expect("a file");
    std::fs::File::options()
        .write(true)
        .open(path)
        .expect("opens")
        .set_modified(at)
        .expect("sets the time");
}

#[test]
fn a_file_with_no_row_is_swept_and_a_file_with_one_is_not() {
    use std::time::{Duration, SystemTime};
    let w = World::new();
    let launch = SystemTime::now();
    let (_, held) = w.document("Kept", "kept");
    let stray = w.put("stray");
    let staged_since = w.put("staged since launch");
    written_at(&w, &held, launch - Duration::from_secs(3600));
    written_at(&w, &stray, launch - Duration::from_secs(3600));
    // A staging that ended after the launch owns its file until a command names it.
    written_at(&w, &staged_since, launch + Duration::from_secs(3600));
    let swept = w
        .scratch
        .vault
        .sweep_unclaimed_files(launch, "", 1_000)
        .expect("sweeps");
    assert_eq!(swept.removed, vec![stray.clone()]);
    assert!(!w.on_disk(&stray));
    assert!(w.on_disk(&held), "a file a row names stays");
    assert!(w.on_disk(&staged_since), "a file staged since launch stays");
}

#[test]
fn the_file_sweep_looks_at_a_bounded_batch_and_resumes() {
    use std::time::{Duration, SystemTime};
    let w = World::new();
    let launch = SystemTime::now();
    for n in 0..5 {
        let stray = w.put(&format!("stray {n}"));
        written_at(&w, &stray, launch - Duration::from_secs(60));
    }
    // Two files looked at per batch: five strays take three batches, and the
    // batches together look at every file once.
    let mut removed = 0;
    let mut batches = 0;
    let mut after = String::new();
    loop {
        let batch = w
            .scratch
            .vault
            .sweep_unclaimed_files(launch, &after, 2)
            .unwrap();
        assert!(batch.removed.len() <= 2, "a batch looks at two files");
        removed += batch.removed.len();
        batches += 1;
        match batch.next {
            Some(next) => after = next,
            None => break,
        }
    }
    assert_eq!((removed, batches), (5, 3));
}

// ---------------------------------------------------------------------------
// the backup skips what is past its purge date
// ---------------------------------------------------------------------------

#[test]
fn the_backup_lists_no_blob_only_a_lapsed_entity_names() {
    let w = World::new();
    let (lapsing, lapsing_blob) = w.document("Lapsing", "lapsing");
    let (kept, kept_blob) = w.document("Kept", "kept");
    let (trashed, trashed_blob) = w.document("Trashed", "trashed");
    // A thumbnail follows its original.
    let thumb = w.put("lapsing thumb");
    w.ok(
        "derivative.write",
        json!({ "blob": lapsing_blob, "variant": "thumb", "out": thumb, "out_size": 13, "media_type": "image/jpeg" }),
    );
    w.ok("entity.trash", json!({ "id": lapsing }));
    w.scratch.clock.advance_ms(20 * DAY_MS);
    w.ok("entity.trash", json!({ "id": trashed }));
    w.scratch.clock.advance_ms(15 * DAY_MS);
    // `lapsing` is 35 days in the trash, `trashed` 15, `kept` live.
    let listed: Vec<String> = centraid_vault::backup::files::content_files(&w.scratch.vault)
        .expect("lists")
        .into_iter()
        .map(|file| file.h.to_hex())
        .collect();
    assert!(!listed.contains(&lapsing_blob), "past its purge date");
    assert!(!listed.contains(&thumb), "its thumbnail follows it");
    assert!(listed.contains(&kept_blob));
    assert!(
        listed.contains(&trashed_blob),
        "inside its window, still held"
    );
    let _ = (kept, trashed);

    // A blob a lapsed entity AND a live one name is still held.
    let (twin, twin_blob) = w.document("Twin", "kept");
    assert_eq!(twin_blob, kept_blob);
    let _ = twin;
    w.exec("UPDATE entity SET purge_at = '2000-01-01T00:00:00.000Z' WHERE deleted_at IS NOT NULL");
    let listed: Vec<String> = centraid_vault::backup::files::content_files(&w.scratch.vault)
        .expect("lists")
        .into_iter()
        .map(|file| file.h.to_hex())
        .collect();
    assert!(listed.contains(&kept_blob));
    assert!(!listed.contains(&trashed_blob));
}
