//! The bytes under the trash and the plane that rents them (#1146 wave 3, rewritten on the v0
//! tables for #1214, K10): who rents a blob is the schema's answer and the collector and the backup
//! agree on it; an earlier version keeps its bytes while its entity lives; collecting never fails a
//! commit by taking a blob its own revision is about to name; every command that can drop the last
//! reference to a blob returns `released` and the store loses the file; files with no row are swept;
//! and a backup does not carry what is past its purge date. (The trash's own half, the overdue pass
//! and what a purge lets go of, is `tests/trash_and_bytes.rs`.)
//!
//! Entities of kinds whose lane is not plugged in yet are made the way their commands will make them
//! (the entity row, then the kind row, through the commit guard), so each rule is proved against the
//! tables. Asserted: rows, hashes and files, never time.

mod common;

use std::collections::BTreeSet;

use centraid_vault::backup::files::{RENTERS, content_files, renting_columns};
use centraid_vault::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, Registry,
};
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, CommitTx, Principal};
use serde_json::{Value, json};

const DAY_MS: i64 = 86_400_000;
const AT: &str = "2026-03-01T09:00:00.000Z";

/// A command a lane will write: replace a document's bytes and, in the same commit, collect what
/// nothing names. The history writes the replaced version when the commit settles.
fn replace_and_collect(ctx: &CommandCtx<'_, '_>) -> centraid_vault::Result<Value> {
    let id = ctx.required_str("id")?.to_owned();
    let blob = ctx.required_str("blob")?.to_owned();
    ctx.connection()
        .execute("UPDATE document SET blob = ?2 WHERE id = ?1", [&id, &blob])?;
    ctx.touch(&id)?;
    let released = centraid_vault::blob::collect(ctx.connection())?;
    Ok(json!({ "released": released }))
}

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        let mut registry = Registry::with_system_commands().expect("a registry");
        registry
            .register(CommandDefinition::plain(
                "probe.replace_and_collect",
                "probe",
                r#"{"type":"object","additionalProperties":true}"#,
                Idempotency::Idempotent,
                &[] as &[CommandCondition],
                replace_and_collect,
            ))
            .expect("a probe");
        Self {
            scratch: common::Scratch::founded_with_blobs("trash-bytes").expect("a vault"),
            registry,
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
        self.sql_as_entity(Kind::Note, "in use", |id| {
            format!("INSERT INTO note (id, body) VALUES ('{id}', 'x')")
        });
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

    fn commit(&self, body: impl FnOnce(&CommitTx<'_>) -> centraid_vault::Result<()>) {
        self.scratch.clock.advance_ms(1_000);
        self.scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                body(tx)
            })
            .expect("commits");
    }

    fn sql(&self, statements: &str) {
        self.commit(|tx| {
            tx.connection().execute_batch(statements)?;
            Ok(())
        });
    }

    fn exec(&self, sql: &'static str) {
        self.sql(sql);
    }

    /// An entity of `kind` with its kind row (`row` is given the new id), in one commit.
    fn sql_as_entity(&self, kind: Kind, title: &str, row: impl FnOnce(&str) -> String) -> String {
        let id = self.scratch.vault.ids().next();
        let row = row(&id);
        self.commit(|tx| {
            tx.insert_entity(&id, kind, title, AT)?;
            tx.connection().execute_batch(&row)?;
            Ok(())
        });
        id
    }

    /// Bytes put into the store with no claim on them yet (a file with no row).
    fn store(&self, seed: &str) -> String {
        self.scratch
            .vault
            .blobs()
            .expect("a store")
            .put(seed.as_bytes())
            .expect("stored")
    }

    /// Bytes put into the store the way the stage door does, and claimed.
    fn put(&self, seed: &str) -> String {
        let hash = self.store(seed);
        self.sql(&format!(
            "INSERT INTO blob (hash, size) VALUES ('{hash}', {}) ON CONFLICT (hash) DO NOTHING",
            seed.len()
        ));
        hash
    }

    fn on_disk(&self, hash: &str) -> bool {
        self.scratch
            .vault
            .blobs()
            .expect("a store")
            .has(hash)
            .expect("asks")
    }

    fn has_row(&self, hash: &str) -> bool {
        self.one::<i64>("SELECT COUNT(*) FROM blob WHERE hash = ?1", &[hash]) == 1
    }

    fn document(&self, title: &str, seed: &str) -> (String, String) {
        let blob = self.put(seed);
        let id = self.sql_as_entity(Kind::Document, title, |id| {
            format!(
                "INSERT INTO document (id, blob, media_type) VALUES ('{id}', '{blob}', 'application/pdf')"
            )
        });
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

    fn listed(&self) -> Vec<String> {
        content_files(&self.scratch.vault)
            .expect("lists")
            .into_iter()
            .map(|file| file.h.to_hex())
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Row 1: who rents a blob
// ---------------------------------------------------------------------------

/// The columns that name a blob, as the brief and the baseline say them. A new one added here is
/// a deliberate act.
const RENTING: &[(&str, &str)] = &[
    ("container", "cover"),
    ("derivative", "out"),
    ("document", "blob"),
    ("locker_item_field", "value_blob"),
    ("message_attachment", "thumb"),
    ("note_asset", "blob"),
    ("person", "avatar"),
    ("photo", "blob"),
    ("photo", "motion_blob"),
    ("revision_blob", "blob"),
];

/// The collector asks the schema (`PRAGMA foreign_key_list`); the backup asks the schema for the
/// columns and its own list only for whose a row is. Walk the file: the three agree, and none is a
/// column somebody forgot.
#[test]
fn the_collector_and_the_backup_agree_on_every_column_that_rents_a_blob() {
    let w = World::new();
    let from_schema: BTreeSet<(String, String)> =
        w.scratch.vault.read(renting_columns).expect("reads");
    let named: BTreeSet<(String, String)> = RENTING
        .iter()
        .map(|(table, column)| ((*table).to_owned(), (*column).to_owned()))
        .collect();
    assert_eq!(
        from_schema, named,
        "a column that references blob(hash) is not one this test, the backup and the collector know"
    );
    // The backup's own list of whose a row is: every renter but a derivative's file (which is
    // its original's), and nothing the schema does not have.
    let owners: BTreeSet<(String, String)> = RENTERS
        .iter()
        .map(|(table, column, _)| ((*table).to_owned(), (*column).to_owned()))
        .collect();
    let mut without_derivative = from_schema.clone();
    without_derivative.remove(&("derivative".to_owned(), "out".to_owned()));
    assert_eq!(owners, without_derivative);
    // The collector's own: every reference that keeps a blob alive.
    let collector: BTreeSet<(String, String)> = w
        .scratch
        .vault
        .read(|c| {
            Ok(centraid_vault::blob::references(c)?
                .into_iter()
                .filter(|reference| reference.keeps_alive)
                .map(|reference| (reference.table, reference.column))
                .collect())
        })
        .expect("reads");
    assert_eq!(collector, from_schema);
    // A derivative does not keep its original alive: that reference cascades.
    let cascading: Vec<(String, String)> = w
        .scratch
        .vault
        .read(|c| {
            Ok(centraid_vault::blob::references(c)?
                .into_iter()
                .filter(|reference| !reference.keeps_alive)
                .map(|reference| (reference.table, reference.column))
                .collect())
        })
        .expect("reads");
    assert_eq!(
        cascading,
        [("derivative".to_owned(), "blob".to_owned())],
        "the one reference into blob that does not rent"
    );
}

/// A column added to the schema that references `blob(hash)` and that the backup has no owner for
/// stops the backup naming which blobs lapsed, with a sentence naming the column: it fails the
/// moment it exists, in the vault, and does not wait for a member's data to hit it.
#[test]
fn a_new_column_that_references_blob_is_refused_until_the_backup_says_whose_it_is() {
    let w = World::new();
    let aside = w.scratch.join("aside.db");
    std::fs::copy(w.scratch.vault.path(), &aside).expect("copies");
    let connection = rusqlite::Connection::open(&aside).expect("opens");
    connection
        .execute_batch(
            "ALTER TABLE document ADD COLUMN extra TEXT REFERENCES blob(hash) ON DELETE NO ACTION",
        )
        .expect("a new renter");
    let error =
        centraid_vault::backup::files::content_files_on(&connection, "2026-03-01T09:00:00.000Z", 0)
            .expect_err("refused");
    assert!(
        error.to_string().contains("document.extra"),
        "the sentence names the column: {error}"
    );
}

// ---------------------------------------------------------------------------
// Rows 2 and 3: earlier bytes are kept; collecting after settle
// ---------------------------------------------------------------------------

/// One entity of each kind that names a blob in a slot: made with `one`, then (in a commit of its
/// own) given `two` instead.
struct Slot {
    name: &'static str,
    /// Makes the entity with `one`; returns its id.
    make: fn(&World, &str) -> String,
    /// The statement that gives it `two`.
    replace: fn(&str, &str) -> String,
}

fn slots() -> Vec<Slot> {
    vec![
        Slot {
            name: "a document's bytes",
            make: |w, one| {
                w.sql_as_entity(Kind::Document, "Doc", |id| {
                    format!("INSERT INTO document (id, blob, media_type) VALUES ('{id}', '{one}', 'text/plain')")
                })
            },
            replace: |id, two| format!("UPDATE document SET blob = '{two}' WHERE id = '{id}'"),
        },
        Slot {
            name: "an avatar",
            make: |w, one| {
                w.sql_as_entity(Kind::Person, "Alex", |id| {
                    format!("INSERT INTO person (id, avatar) VALUES ('{id}', '{one}')")
                })
            },
            replace: |id, two| format!("UPDATE person SET avatar = '{two}' WHERE id = '{id}'"),
        },
        Slot {
            name: "a cover",
            make: |w, one| {
                let id = w.ok(
                    "container.create",
                    json!({"kind": "album", "title": "Trip"}),
                )["id"]
                    .as_str()
                    .expect("an id")
                    .to_owned();
                w.sql(&format!(
                    "UPDATE container SET cover = '{one}' WHERE id = '{id}'"
                ));
                id
            },
            replace: |id, two| format!("UPDATE container SET cover = '{two}' WHERE id = '{id}'"),
        },
        Slot {
            name: "a note asset",
            make: |w, one| {
                let note = w.sql_as_entity(Kind::Note, "Trip", |id| {
                    format!("INSERT INTO note (id, body) VALUES ('{id}', 'a map')")
                });
                w.sql(&format!(
                    "INSERT INTO note_asset (id, note_id, blob, name, media_type, position)
                     VALUES ('as-1', '{note}', '{one}', 'map.png', 'image/png', 1)"
                ));
                note
            },
            replace: |_, two| format!("UPDATE note_asset SET blob = '{two}' WHERE id = 'as-1'"),
        },
        Slot {
            name: "a sealed file",
            make: |w, one| {
                w.sql(&format!(
                    "INSERT INTO locker_key (id, key_id, created_at) VALUES (1, 'k1', '{AT}')"
                ));
                let id = w.sql_as_entity(Kind::LockerItem, "Passport scan", |id| {
                    format!("INSERT INTO locker_item (id, type) VALUES ('{id}', 'document')")
                });
                w.sql(&format!(
                    "INSERT INTO locker_item_field (id, item_id, label, kind, value_sealed, value_blob,
                                                   key_id, value_set_at, created_at, updated_at)
                     VALUES ('f-file', '{id}', 'Scan', 'file', 'lk1:AAAA', '{one}', 'k1', '{AT}', '{AT}', '{AT}')"
                ));
                id
            },
            replace: |_, two| {
                format!(
                    "UPDATE locker_item_field SET value_blob = '{two}', value_sealed = 'lk1:BBBB',
                            updated_at = '{AT}' WHERE id = 'f-file'"
                )
            },
        },
    ]
}

/// Replacing a blob keeps the earlier bytes while the entity lives (a version names them), however
/// often the collector runs; purging the entity frees them. Each of the slots a version keeps.
#[test]
fn earlier_bytes_are_kept_while_the_entity_lives_and_a_purge_frees_them() {
    for slot in slots() {
        let w = World::new();
        let (one, two) = (w.put("first bytes"), w.put("second bytes"));
        let id = (slot.make)(&w, &one);
        w.sql(&(slot.replace)(&id, &two));
        // A version of the entity names `one`; the live row names `two`.
        assert_eq!(
            w.one::<i64>(
                "SELECT COUNT(*) FROM revision_blob WHERE blob = ?1",
                &[&one]
            ),
            1,
            "{}: the earlier version names the earlier bytes",
            slot.name
        );
        assert!(
            w.scratch
                .vault
                .collect_blobs()
                .expect("collects")
                .is_empty(),
            "{}: nothing is collected while the entity lives",
            slot.name
        );
        assert!(w.has_row(&one) && w.has_row(&two), "{}", slot.name);
        assert!(w.on_disk(&one) && w.on_disk(&two), "{}", slot.name);
        // Still named after the clock moves and the collector runs again.
        w.later(60);
        assert!(
            w.scratch
                .vault
                .collect_blobs()
                .expect("collects")
                .is_empty()
        );
        assert!(w.has_row(&one), "{}", slot.name);

        // The purge takes the entity, its versions and so every name for both blobs.
        w.sql(&format!("DELETE FROM entity WHERE id = '{id}'"));
        let released = w.scratch.vault.collect_blobs().expect("collects");
        let released: BTreeSet<String> = released.into_iter().collect();
        assert_eq!(
            released,
            BTreeSet::from([one.clone(), two.clone()]),
            "{}: a purge frees the earlier bytes and the current",
            slot.name
        );
        assert!(!w.has_row(&one) && !w.has_row(&two), "{}", slot.name);
    }
}

/// A command that replaces a blob and collects what nothing names, in one commit, does not fail
/// the commit: the earlier bytes are the version being written now, and stay.
#[test]
fn a_command_that_replaces_a_blob_and_collects_in_the_same_commit_keeps_the_earlier_bytes() {
    let w = World::new();
    let (id, one) = w.document("Lease", "lease v1");
    let two = w.put("lease v2");
    let out = w.ok(
        "probe.replace_and_collect",
        json!({ "id": id, "blob": two }),
    );
    assert!(
        !World::hashes(&out["released"]).contains(&one),
        "the bytes the new version names were not released"
    );
    assert!(w.on_disk(&one), "and their file stayed");
    assert_eq!(
        w.one::<String>("SELECT blob FROM document WHERE id = ?1", &[&id]),
        two
    );
    assert_eq!(
        w.one::<String>(
            "SELECT blob FROM revision_blob WHERE entity_id = ?1 AND slot = 'blob'",
            &[&id]
        ),
        one,
        "the version names them"
    );
    // The control: a blob nothing will name is still released by the same call.
    let orphan = w.put("orphan");
    let out = w.ok(
        "probe.replace_and_collect",
        json!({ "id": id, "blob": two }),
    );
    assert_eq!(World::hashes(&out["released"]), vec![orphan.clone()]);
    assert!(!w.on_disk(&orphan));
}

/// The same in one raw commit that made the entity too: nothing to fail, and a purge in a commit
/// that collects still frees what it purged.
#[test]
fn collecting_inside_a_commit_still_frees_what_a_purge_in_that_commit_released() {
    let w = World::new();
    let (id, one) = w.document("Gone", "gone");
    let two = w.put("kept");
    w.sql(&format!(
        "UPDATE document SET blob = '{two}' WHERE id = '{id}'"
    ));
    let mut released = Vec::new();
    w.commit(|tx| {
        tx.connection()
            .execute("DELETE FROM entity WHERE id = ?1", [&id])?;
        released = centraid_vault::blob::collect(tx.connection())?;
        Ok(())
    });
    released.sort();
    let mut expected = vec![one, two];
    expected.sort();
    assert_eq!(
        released, expected,
        "a purged entity leaves no version to name them"
    );
}

// ---------------------------------------------------------------------------
// Row 7: derivatives
// ---------------------------------------------------------------------------

/// Whether a variant is a file is its lookup row's attribute (`derivative_variant.has_out`, a
/// table only a migration writes): no list of variants is kept in Rust. A picture variant needs its
/// bytes, a value variant refuses them, an unknown variant is a sentence, and the shell's staging
/// door accepts exactly the picture variants.
#[test]
fn a_variants_shape_is_the_lookup_rows_has_out() {
    let w = World::new();
    let (_, original) = w.document("Scan", "scan");
    let lookup: Vec<(String, i64)> = w
        .scratch
        .vault
        .read(|c| {
            Ok(
                c.prepare("SELECT code, has_out FROM derivative_variant ORDER BY code")?
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()?,
            )
        })
        .expect("reads");
    assert!(lookup.len() >= 4);
    for (code, has_out) in lookup {
        let file = w.put(&format!("a {code} picture"));
        let size = i64::try_from(format!("a {code} picture").len()).expect("small");
        let as_file = w.run(
            "derivative.write",
            json!({ "blob": original, "variant": code, "out": file, "out_size": size, "media_type": "image/png" }),
        );
        let as_value = w.run(
            "derivative.write",
            json!({ "blob": original, "variant": code, "text": "words" }),
        );
        let (file_status, value_status) = if has_out == 1 {
            (CommandStatus::Executed, CommandStatus::Failed)
        } else {
            (CommandStatus::Failed, CommandStatus::Executed)
        };
        assert_eq!(as_file.status, file_status, "{code} as a file");
        assert_eq!(as_value.status, value_status, "{code} as a value");
        // The shell's door takes the same table's word for it.
        let staged = centraid_vault::blob::StagedDerivative {
            hash: file,
            byte_size: size,
            media_type: "image/png".to_owned(),
            variant: code.clone(),
            variant_of: original.clone(),
        };
        assert_eq!(
            w.scratch.vault.stage_derivative(&staged).is_ok(),
            has_out == 1,
            "{code} through the staging door"
        );
    }
    // A variant the lookup does not know is a sentence, to write and to drop.
    for (name, input) in [
        (
            "derivative.drop",
            json!({ "blob": original, "variant": "nope" }),
        ),
        (
            "derivative.write",
            json!({ "blob": original, "variant": "nope", "text": "x" }),
        ),
    ] {
        let unknown = w.run(name, input);
        assert_eq!(unknown.status, CommandStatus::Failed, "{name}");
        assert!(
            unknown
                .reason
                .expect("a sentence")
                .contains("not a kind of derivative"),
            "{name}"
        );
    }
    w.ok(
        "derivative.drop",
        json!({ "blob": original, "variant": "text" }),
    );
}

/// A derivative's file is a rented blob: the backup lists it, it follows its original (it lapses
/// with it and is kept with it), and replacing it releases the earlier file.
#[test]
fn a_derivatives_file_is_a_rented_blob_that_follows_its_original() {
    let w = World::new();
    let (doc, original) = w.document("Scan", "scan");
    let thumb = w.put("a thumbnail");
    w.ok(
        "derivative.write",
        json!({ "blob": original, "variant": "thumb", "out": thumb, "out_size": 11, "media_type": "image/jpeg" }),
    );
    let listed = w.listed();
    assert!(listed.contains(&original) && listed.contains(&thumb));
    let files = content_files(&w.scratch.vault).expect("lists");
    let file = files
        .iter()
        .find(|f| f.h.to_hex() == thumb)
        .expect("listed");
    assert_eq!(file.variant.as_deref(), Some("thumb"));
    assert!(!file.sealed);
    assert!(
        w.scratch
            .vault
            .collect_blobs()
            .expect("collects")
            .is_empty(),
        "a derivative's file is named by its row"
    );
    // The original lapses, and its derivative lapses with it.
    w.ok("entity.trash", json!({ "id": doc }));
    w.later(31);
    let listed = w.listed();
    assert!(!listed.contains(&original) && !listed.contains(&thumb));
}

// ---------------------------------------------------------------------------
// the rest of the plane, as before
// ---------------------------------------------------------------------------

/// A clock far from the vault's last write lapses nothing for the backup either: the bytes of a
/// trashed item that is still restorable are listed, however far the clock says its purge date
/// is behind it (#1191, V19).
#[test]
fn a_clock_far_ahead_leaves_every_trashed_blob_in_the_backup() {
    let w = World::new();
    let (trashed, blob) = w.document("Trashed", "trashed bytes");
    w.ok("entity.trash", json!({ "id": trashed }));
    // One day ahead: inside the window and inside the bound.
    w.scratch.clock.advance_ms(DAY_MS);
    assert!(w.listed().contains(&blob));
    // A year ahead: the row reads as long lapsed, but the clock is not believed.
    w.scratch.clock.advance_ms(365 * DAY_MS);
    assert!(
        w.listed().contains(&blob),
        "a clock a year ahead lapsed a trashed blob out of the backup"
    );
    // Restoring is allowed under that clock.
    w.ok("entity.restore", json!({ "id": trashed }));
}

/// V7: a derivative is written by an upsert (the second write of a variant replaces the first, one
/// row, no delete-and-insert), and `derivative` and `revision` are ordinary rowid tables.
#[test]
fn a_derivative_written_twice_is_one_row_and_both_tables_have_rowids() {
    let w = World::new();
    let (_, blob) = w.document("Lease", "lease");
    let first = w.put("first thumb");
    let second = w.put("second thumb");
    for (out, size) in [(&first, 11), (&second, 12)] {
        w.ok(
            "derivative.write",
            json!({ "blob": blob, "variant": "thumb", "out": out, "out_size": size, "media_type": "image/jpeg" }),
        );
    }
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM derivative WHERE blob = ?1 AND variant = 'thumb'",
            &[&blob]
        ),
        1,
        "the second write replaced the first"
    );
    assert_eq!(
        w.one::<String>(
            "SELECT out FROM derivative WHERE blob = ?1 AND variant = 'thumb'",
            &[&blob]
        ),
        second
    );
    // A rowid table answers `rowid`; a WITHOUT ROWID one refuses the column.
    for table in ["derivative", "revision"] {
        w.scratch
            .vault
            .read(|c| {
                Ok(
                    c.query_row(&format!("SELECT COUNT(rowid) FROM {table}"), [], |r| {
                        r.get::<_, i64>(0)
                    })?,
                )
            })
            .unwrap_or_else(|error| panic!("{table} is not a rowid table: {error}"));
    }
}

/// V20: a stored file that rotted on disk is replaced when the same bytes are added again, so the
/// file under its name is right again.
#[test]
fn re_adding_a_rotted_blob_replaces_the_bad_file() {
    let w = World::new();
    let hash = w.put("the original bytes");
    let path = w
        .scratch
        .vault
        .blobs()
        .expect("a store")
        .path_of(&hash)
        .expect("asks")
        .expect("a file");
    let mut rotted = std::fs::read(&path).expect("reads");
    rotted[0] ^= 0xFF;
    std::fs::write(&path, &rotted).expect("rots");
    let again = w.put("the original bytes");
    assert_eq!(again, hash);
    assert_eq!(
        std::fs::read(&path).expect("reads"),
        b"the original bytes".to_vec(),
        "the file under the name holds the right bytes again"
    );
}

/// The pass lets go of the bytes once, at its end, and in pieces: a batch that collected paid a
/// walk of every blob in the library for a handful of rows, and one collect at the end held the
/// vault for every byte released at once (#1146, wave 8).
#[test]
fn the_pass_collects_what_it_released_after_its_last_batch_in_pieces() {
    let w = World::new();
    let mut blobs = Vec::new();
    for n in 0..3 {
        let (id, blob) = w.document(&format!("Doc {n}"), &format!("doc {n}"));
        w.ok("entity.trash", json!({ "id": id }));
        blobs.push(blob);
    }
    w.later(31);
    let vault = &w.scratch.vault;
    // Batches of two purge and keep the bytes (the third is still to come) ...
    let first = vault
        .empty_overdue_trash_step(&w.registry, 2, false)
        .unwrap();
    assert_eq!(
        (first.purged, first.more, first.collecting),
        (2, true, false)
    );
    assert!(
        blobs.iter().all(|blob| w.on_disk(blob)),
        "a batch that is not the last holds the bytes for the end"
    );
    // ... the last purges its own and turns to collecting, a piece at a time.
    let last = vault
        .empty_overdue_trash_step(&w.registry, 2, false)
        .unwrap();
    assert_eq!(last.purged, 1);
    assert!(!last.more && !last.collecting, "{last:?}");
    assert!(
        blobs.iter().all(|blob| !w.on_disk(blob)),
        "the pass's bytes went with its end"
    );
}

#[test]
fn collecting_with_a_limit_takes_a_piece_and_says_when_more_is_left() {
    let w = World::new();
    for n in 0..5 {
        w.ok(
            "blob.stage",
            json!({ "hash": format!("{n:0>64}"), "size": 1 }),
        );
    }
    let piece = w.ok("blob.collect", json!({ "limit": 2 }));
    assert_eq!(World::hashes(&piece["released"]).len(), 2);
    assert_eq!(piece["more"], json!(true));
    let piece = w.ok("blob.collect", json!({ "limit": 2 }));
    assert_eq!(World::hashes(&piece["released"]).len(), 2);
    let last = w.ok("blob.collect", json!({ "limit": 2 }));
    assert_eq!(World::hashes(&last["released"]).len(), 1);
    assert_eq!(last["more"], json!(false));
}

// ---------------------------------------------------------------------------
// origin.fills, for every kind an origin can fill
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// container.move of a section re-files its tasks
// ---------------------------------------------------------------------------

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
    let stray = w.store("stray");
    let staged_since = w.store("staged since launch");
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
        let stray = w.store(&format!("stray {n}"));
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
    w.later(15);
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
