//! One founded vault in a scratch directory, and the doors the registry's tests read it through.
//! Each integration test is its own binary and compiles this whole module, so a helper one of
//! them does not use is dead in that binary and live in another.
#![allow(dead_code)]

use std::sync::Arc;

use centraid_domain::read::Reader;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandOutcome, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

/// Named counts for the shared deterministic year-three read corpus. The total is deliberately
/// explicit so adding or removing a scaled row kind changes the fixture literal and its assertion.
#[derive(Debug, Clone, Copy)]
pub struct Year3Shape {
    pub people: usize,
    pub contact_points: usize,
    pub photos: usize,
    pub threads: usize,
    pub messages: usize,
    pub notes: usize,
    pub documents: usize,
    pub events: usize,
    pub tasks: usize,
    pub accounts: usize,
    pub transactions: usize,
    pub workouts: usize,
    pub measurements: usize,
    pub readings: usize,
    pub locker_items: usize,
    pub person_dates: usize,
}

impl Year3Shape {
    pub const YEAR_3: Self = Self {
        people: 5_000,
        contact_points: 4_635,
        photos: 10_000,
        threads: 200,
        messages: 2_400,
        notes: 1_000,
        documents: 365,
        events: 1_096,
        tasks: 1_096,
        accounts: 12,
        transactions: 365,
        workouts: 365,
        measurements: 365,
        readings: 365,
        locker_items: 12,
        person_dates: 324,
    };

    pub const fn rows(self) -> usize {
        self.people
            + self.contact_points
            + self.photos
            + self.threads
            + self.messages
            + self.notes
            + self.documents
            + self.events
            + self.tasks
            + self.accounts
            + self.transactions
            + self.workouts
            + self.measurements
            + self.readings
            + self.locker_items
            + self.person_dates
    }
}

#[derive(Debug)]
pub struct Year3Ids {
    pub first_person: String,
    pub reading_person: String,
    pub first_thread: String,
    pub reading_metric: String,
    pub measurement_metric: String,
    pub special_note: String,
}

pub struct World {
    dir: std::path::PathBuf,
    pub vault: Vault,
    pub registry: Registry,
    clock: Arc<FixedClock>,
}

impl World {
    pub fn new(seed: &str) -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let clock = Arc::new(FixedClock::frozen());
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new(seed)),
        )
        .expect("a vault");
        vault.found("Test", "Test Owner").expect("founded");
        Self {
            dir,
            vault,
            registry: Registry::with_system_commands().expect("a registry"),
            clock,
        }
    }

    /// A read-only door onto this vault's file.
    pub fn reader(&self) -> Reader {
        Reader::open(self.vault.path()).expect("a read door")
    }

    pub fn run(&self, name: &str, input: Value) -> CommandOutcome {
        self.clock.advance_ms(1_000);
        self.vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    pub fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    /// A new entity's id, from the command that made it.
    pub fn made(&self, name: &str, input: Value) -> String {
        let output = self.ok(name, input);
        output
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("`{name}` made no id: {output}"))
            .to_owned()
    }

    pub fn notebook(&self, title: &str) -> String {
        self.made(
            "container.create",
            json!({ "kind": "notebook", "title": title }),
        )
    }

    pub fn note(&self, title: &str, notebook: &str) -> String {
        self.made(
            "note.create",
            json!({ "title": title, "notebook_id": notebook }),
        )
    }

    /// Add the deterministic three-year data volume used by every app's hot-read exercise.
    /// Rows are written through SQLite with the founded schema's foreign keys, checks, and
    /// triggers enabled; only the test fixture bypasses the user-facing command layer.
    pub fn seed_year3(&self) -> Year3Ids {
        use rusqlite::{Connection, params};

        const AT: &str = "2026-03-10T12:00:00.000Z";
        let mut db = Connection::open(self.vault.path()).expect("open fixture writer");
        db.pragma_update(None, "foreign_keys", "ON")
            .expect("foreign keys enabled");
        let tx = db.transaction().expect("fixture transaction");
        let shape = Year3Shape::YEAR_3;
        assert_eq!(shape.rows(), 27_600);
        let lookup = |domain: &str| -> String {
            tx.query_row(
                "SELECT code FROM vocab WHERE domain = ?1 ORDER BY code LIMIT 1",
                [domain],
                |row| row.get(0),
            )
            .unwrap_or_else(|error| panic!("seeded {domain} lookup: {error}"))
        };
        let metric = tx
            .query_row(
                "SELECT code FROM health_metric WHERE cadence = 'reading' AND has_value2 = 0 ORDER BY code LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("a seeded single-value reading metric");
        let measurement_metric = tx
            .query_row(
                "SELECT code FROM health_metric WHERE cadence = 'total' ORDER BY code LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("a seeded total metric");
        let workout_kind = tx
            .query_row(
                "SELECT id FROM entity WHERE kind = 'workout_kind' ORDER BY id LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("a seeded workout kind");
        let photo_form = lookup("photo_form");
        let contact_kind = lookup("contact_point_kind");
        let account_type = lookup("account_type");
        let locker_type = lookup("locker_type");
        let date_kind = tx
            .query_row(
                "SELECT code FROM person_date_kind WHERE single = 1 ORDER BY code LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("a seeded singular person-date kind");
        let blob = "a".repeat(64);
        tx.execute("INSERT INTO blob(hash, size) VALUES (?1, 1)", [&blob])
            .expect("fixture blob");

        let make_entity = |n: usize,
                           kind: &str,
                           title: &str,
                           parent: Option<(&str, &str)>,
                           starred: bool,
                           pinned: bool| {
            let id = year3_id(n);
            tx.execute(
                "INSERT INTO entity(id, kind, title, parent_id, parent_kind, created_at, updated_at, starred_at, pinned_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)",
                params![
                    id,
                    kind,
                    title,
                    parent.map(|value| value.0),
                    parent.map(|value| value.1),
                    AT,
                    starred.then_some(AT),
                    pinned.then_some(AT),
                ],
            )
            .unwrap_or_else(|error| panic!("insert {kind} fixture entity: {error}"));
            id
        };

        // `found` contributes the owner's person. Count that live row in the named corpus rather
        // than adding an unaccounted 5,001st person to the fixture.
        let mut people = Vec::with_capacity(shape.people - 1);
        for offset in 0..(shape.people - 1) {
            let id = make_entity(
                10_000 + offset,
                "person",
                &format!("Person {offset:04}"),
                None,
                offset == 0,
                false,
            );
            tx.execute("INSERT INTO person(id) VALUES (?1)", [&id])
                .expect("person row");
            people.push(id);
        }
        for offset in 0..shape.contact_points {
            // A dense owner makes this child query prove its 50-row cap.
            let person = &people[0];
            let id = year3_id(20_000 + offset);
            let value = format!("+1555{offset:07}");
            tx.execute(
                "INSERT INTO contact_point(id, person_id, kind, value, normalized, position) VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                params![id, person, contact_kind, value, offset as f64],
            ).expect("contact point row");
        }

        for offset in 0..shape.photos {
            let id = make_entity(
                30_000 + offset,
                "photo",
                &format!("Photo {offset:05}"),
                None,
                false,
                false,
            );
            tx.execute(
                "INSERT INTO photo(id, blob, media_type, form, taken_at, width, height) VALUES (?1, ?2, 'image/jpeg', ?3, ?4, 1200, 800)",
                params![id, blob, photo_form, AT],
            ).expect("photo row");
        }
        for offset in 0..shape.threads {
            let id = make_entity(
                40_000 + offset,
                "thread",
                &format!("Conversation {offset:03}"),
                None,
                false,
                false,
            );
            tx.execute("INSERT INTO thread(id, scope) VALUES (?1, 'year3')", [&id])
                .expect("thread row");
            for ordinal in 0..(shape.messages / shape.threads) {
                let user = ordinal % 2 == 0;
                tx.execute(
                    "INSERT INTO message(thread_id, ordinal, role, text, outcome, created_at, updated_at) VALUES (?1, ?2, ?3, 'Fixture turn', ?4, ?5, ?5)",
                    params![id, ordinal as i64, if user { "user" } else { "assistant" }, if user { "sent" } else { "answered" }, AT],
                ).expect("message row");
            }
        }
        let special_note = make_entity(50_000, "note", "Year three pinned note", None, false, true);
        for offset in 0..shape.notes {
            let id = if offset == 0 {
                special_note.clone()
            } else {
                make_entity(
                    50_000 + offset,
                    "note",
                    &format!("Note {offset:04}"),
                    None,
                    false,
                    false,
                )
            };
            tx.execute(
                "INSERT INTO note(id, body) VALUES (?1, 'year-three note')",
                [&id],
            )
            .expect("note row");
        }

        for offset in 0..shape.documents {
            let id = make_entity(
                60_000 + offset,
                "document",
                &format!("Document {offset:04}"),
                None,
                false,
                false,
            );
            tx.execute(
                "INSERT INTO document(id, blob, media_type) VALUES (?1, ?2, 'application/pdf')",
                params![id, blob],
            )
            .expect("document row");
        }
        let calendar = "calendar:default";
        for offset in 0..shape.events {
            let id = make_entity(
                70_000 + offset,
                "event",
                &format!("Event {offset:04}"),
                Some((calendar, "calendar")),
                false,
                false,
            );
            tx.execute(
                "INSERT INTO event(id, starts, timing) VALUES (?1, '2025-06-01', 'all-day')",
                [&id],
            )
            .expect("event row");
        }
        for offset in 0..shape.tasks {
            let id = make_entity(
                80_000 + offset,
                "task",
                &format!("Task {offset:04}"),
                None,
                false,
                false,
            );
            tx.execute("INSERT INTO task(id) VALUES (?1)", [&id])
                .expect("task row");
        }
        let mut accounts = Vec::with_capacity(shape.accounts);
        for offset in 0..shape.accounts {
            let id = make_entity(
                90_000 + offset,
                "account",
                &format!("Account {offset:02}"),
                None,
                false,
                false,
            );
            tx.execute(
                "INSERT INTO account(id, type, currency) VALUES (?1, ?2, 'USD')",
                params![id, account_type],
            )
            .expect("account row");
            accounts.push(id);
        }
        for offset in 0..shape.transactions {
            let id = make_entity(
                100_000 + offset,
                "txn",
                &format!("Transaction {offset:04}"),
                None,
                false,
                false,
            );
            tx.execute(
                "INSERT INTO txn(id, account_id, posted_on, amount_minor, entered) VALUES (?1, ?2, '2026-03-01', -1000, 'statement')",
                params![id, accounts[offset % accounts.len()]],
            ).expect("transaction row");
        }
        for offset in 0..shape.workouts {
            let id = make_entity(
                110_000 + offset,
                "workout",
                &format!("Workout {offset:04}"),
                None,
                false,
                false,
            );
            tx.execute(
                "INSERT INTO workout(id, type_id, starts) VALUES (?1, ?2, ?3)",
                params![id, workout_kind, AT],
            )
            .expect("workout row");
        }
        for offset in 0..shape.measurements {
            tx.execute(
                "INSERT INTO measurement(person_id, day, metric, value) VALUES (?1, date('2025-01-01', '+' || ?2 || ' days'), ?3, ?4)",
                params![people[0], offset as i64, measurement_metric, offset as f64],
            )
            .expect("daily measurement row");
        }
        let reading_person = people[0].clone();
        for offset in 0..shape.readings {
            let id = make_entity(120_000 + offset, "reading", "", None, false, false);
            tx.execute(
                "INSERT INTO reading(id, person_id, metric, at, value) VALUES (?1, ?2, ?3, ?4, 70.0)",
                params![id, reading_person, metric, AT],
            ).expect("reading row");
        }
        for offset in 0..shape.locker_items {
            let id = make_entity(
                130_000 + offset,
                "locker_item",
                &format!("Vault item {offset:02}"),
                None,
                false,
                false,
            );
            tx.execute(
                "INSERT INTO locker_item(id, type) VALUES (?1, ?2)",
                params![id, locker_type],
            )
            .expect("Locker item row");
        }
        for (offset, person_id) in people.iter().take(shape.person_dates).enumerate() {
            let id = year3_id(140_000 + offset);
            tx.execute(
                "INSERT INTO person_date(id, person_id, kind, single, date) VALUES (?1, ?2, ?3, 1, '2000-01-01')",
                params![id, person_id.as_str(), date_kind],
            ).expect("person date row");
        }
        tx.commit().expect("commit year-three corpus");

        Year3Ids {
            first_person: people[0].clone(),
            reading_person,
            first_thread: year3_id(40_000),
            reading_metric: metric,
            measurement_metric,
            special_note,
        }
    }
}

fn year3_id(number: usize) -> String {
    format!("01900000-0000-7000-8000-{number:012x}")
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
