//! What the follow engine owed after the rebuild ([#1146](https://github.com/srikanth235/centraid/issues/1146)):
//! the owner is never a phone's contact, one guard doubts a read that lost most of what the vault
//! follows, a returned record restores the row its absence trashed, a second phone re-finds a
//! first phone's rows and tombstones, a merge carries every reference and the phone link, a file
//! claims its bytes in the command, a followed series is never left with a day no occurrence will
//! read, and a statement is an account's, not a phone's.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("follow-gaps").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: Value) -> centraid_vault::CommandOutcome {
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

    fn refused(&self, name: &str, input: Value) -> String {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{name} was not refused"
        );
        outcome.reason.expect("a sentence")
    }

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    fn sql(&self, sql: &str, params: &[&str]) {
        self.scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.sql");
                tx.connection()
                    .execute(sql, rusqlite::params_from_iter(params))?;
                Ok(())
            })
            .expect("a write");
    }

    fn owner(&self) -> String {
        common::self_person(&self.scratch.vault).expect("an owner")
    }

    fn id_of(&self, title: &str) -> String {
        self.one("SELECT id FROM entity WHERE title = ?1", &[title])
    }

    fn trashed(&self, id: &str) -> bool {
        self.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[id])
            .is_some()
    }

    fn bytes(&self, seed: &str) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        hash
    }

    fn folder(&self, title: &str) -> String {
        self.ok(
            "container.create",
            json!({ "kind": "folder", "title": title }),
        )["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }
}

fn people(w: &World, device: Option<&str>, complete: bool, names: &[(&str, &str)]) -> Value {
    let records: Vec<Value> = names
        .iter()
        .map(|(id, name)| json!({ "external_id": id, "device_id": device, "fields": { "title": name } }))
        .collect();
    w.ok(
        "follow.contacts",
        json!({ "origin": { "ref": "phone", "label": "Phone", "device_id": device },
                 "complete": complete, "records": records }),
    )
}

fn event(i: usize) -> Value {
    json!({ "external_id": format!("uid:{i}"), "fields": {
        "title": format!("Event {i}"), "starts": format!("2026-03-{:02}T09:00:00", i + 1),
        "ends": format!("2026-03-{:02}T10:00:00", i + 1), "zone": "Europe/Paris" } })
}

fn calendar(w: &World, complete: bool, records: Vec<Value>) -> Value {
    w.ok(
        "follow.calendar",
        json!({ "origin": { "ref": "calendar:work", "label": "Work", "device_id": "phone-1" },
                 "complete": complete, "records": records }),
    )
}

// ---------------------------------------------------------------------------
// The owner
// ---------------------------------------------------------------------------

#[test]
fn a_contact_named_like_the_owner_is_added_beside_the_owner_never_matched_to_it() {
    let w = World::new();
    let owner = w.owner();
    let tally = people(&w, None, true, &[("c1", "Test Owner")]);
    assert_eq!(
        (tally["matched"].as_i64(), tally["added"].as_i64()),
        (Some(0), Some(1)),
        "the owner is not the phone's record: {tally}"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &[&owner]
        ),
        0,
        "the owner gains no source"
    );
}

#[test]
fn a_source_the_owner_somehow_holds_is_forgotten_and_the_owner_is_not_trashed() {
    let w = World::new();
    let owner = w.owner();
    people(&w, None, false, &[("c1", "Someone")]);
    // A file written before the rule: the owner followed by a phone record.
    w.sql(
        "UPDATE source SET entity_id = ?1, stated = '{\"title\":\"Test Owner\"}'
          WHERE external_id = 'c1'",
        &[&owner],
    );
    let tally = people(&w, None, true, &[]);
    assert!(!w.trashed(&owner), "the owner went to the trash: {tally}");
}

// ---------------------------------------------------------------------------
// One guard for every system
// ---------------------------------------------------------------------------

#[test]
fn a_read_that_lost_most_of_what_the_vault_follows_trashes_nothing_for_every_system() {
    let w = World::new();
    let names: Vec<(String, String)> = (0..6).map(|i| (format!("c{i}"), format!("P{i}"))).collect();
    let all: Vec<(&str, &str)> = names
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    people(&w, None, false, &all);
    let tally = people(&w, None, true, &all[..1]);
    assert_eq!(
        (tally["trashed"].as_i64(), tally["doubted"].as_i64()),
        (Some(0), Some(5)),
        "contacts: {tally}"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE kind = 'person' AND deleted_at IS NOT NULL",
            &[]
        ),
        0
    );
    // Four of six is an ordinary removal.
    let tally = people(&w, None, true, &all[..2]);
    assert_eq!(tally["trashed"].as_i64(), Some(4), "{tally}");

    calendar(&w, false, (0..6).map(event).collect());
    let tally = calendar(&w, true, vec![event(0)]);
    assert_eq!(
        (tally["trashed"].as_i64(), tally["doubted"].as_i64()),
        (Some(0), Some(5)),
        "calendar: {tally}"
    );

    let folder = w.folder("Taxes");
    let file = |i: usize| {
        json!({ "external_id": format!("/{i}.pdf"), "fields": {
            "title": format!("{i}.pdf"), "blob": w.bytes(&format!("file {i}")),
            "media_type": "application/pdf" } })
    };
    let files = |complete: bool, records: Vec<Value>| {
        w.ok(
            "follow.files",
            json!({ "origin": { "ref": "/Taxes", "label": "Taxes", "fills": folder },
                     "complete": complete, "records": records }),
        )
    };
    files(false, (0..6).map(file).collect());
    let tally = files(true, vec![file(0)]);
    assert_eq!(
        (tally["trashed"].as_i64(), tally["doubted"].as_i64()),
        (Some(0), Some(5)),
        "files: {tally}"
    );
}

// ---------------------------------------------------------------------------
// A returned record
// ---------------------------------------------------------------------------

#[test]
fn a_record_that_returns_restores_the_row_its_absence_trashed_and_adds_nothing() {
    let w = World::new();
    people(&w, None, false, &[("a", "Ann"), ("b", "Ben")]);
    let (ann, ben) = (w.id_of("Ann"), w.id_of("Ben"));
    let gone = people(&w, None, true, &[("b", "Ben")]);
    assert_eq!(gone["trashed"].as_i64(), Some(1), "{gone}");
    assert!(w.trashed(&ann));
    let back = people(&w, None, true, &[("a", "Ann"), ("b", "Ben")]);
    assert!(!w.trashed(&ann), "Ann is still in the trash: {back}");
    assert_eq!(back["added"].as_i64(), Some(0), "{back}");
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE title = 'Ann'", &[]),
        1
    );
    // What the member trashed stays trashed whatever the phone says.
    w.ok("entity.trash", json!({ "id": ben }));
    people(&w, None, true, &[("a", "Ann"), ("b", "Ben")]);
    assert!(w.trashed(&ben));
}

// ---------------------------------------------------------------------------
// A second phone, and the tombstones
// ---------------------------------------------------------------------------

#[test]
fn another_phone_re_finds_a_purged_row_s_tombstone_and_never_revives_it() {
    let w = World::new();
    people(
        &w,
        Some("device-a"),
        false,
        &[("local:a1", "Ada"), ("local:a2", "Bo")],
    );
    let ada = w.id_of("Ada");
    w.ok("entity.trash", json!({ "id": ada }));
    w.ok("entity.purge", json!({ "id": ada }));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM source WHERE entity_id IS NULL", &[]),
        1,
        "the purge left a tombstone"
    );
    let tally = people(
        &w,
        Some("device-b"),
        true,
        &[("local:b1", "ada"), ("local:b2", "Bo")],
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE kind = 'person' AND lower(title) = 'ada'",
            &[]
        ),
        0,
        "Ada was added again: {tally}"
    );
    assert_eq!(
        tally["matched"].as_i64(),
        Some(1),
        "Bo is re-found: {tally}"
    );
    // The tombstone follows the phone that speaks for it now.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE entity_id IS NULL AND device_id = 'device-b'",
            &[]
        ),
        1
    );
}

#[test]
fn a_tombstone_whose_record_is_gone_from_a_complete_read_is_forgotten() {
    let w = World::new();
    people(&w, None, false, &[("a", "Ann"), ("b", "Ben")]);
    let ann = w.id_of("Ann");
    w.ok("entity.trash", json!({ "id": ann }));
    w.ok("entity.purge", json!({ "id": ann }));
    // Still on the phone: kept.
    people(&w, None, true, &[("a", "Ann"), ("b", "Ben")]);
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM source WHERE entity_id IS NULL", &[]),
        1
    );
    // Gone: forgotten.
    people(&w, None, true, &[("b", "Ben")]);
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM source WHERE entity_id IS NULL", &[]),
        0,
        "the tombstone table only grows"
    );
}

// ---------------------------------------------------------------------------
// person.merge
// ---------------------------------------------------------------------------

#[test]
fn a_merge_is_confirmed_like_every_destructive_command() {
    let definitions = centraid_vault::commands::person::definitions();
    let merge = definitions
        .iter()
        .find(|definition| definition.name == "person.merge")
        .expect("a merge");
    assert!(
        merge.confirm,
        "person.merge purges a person and is not confirmed"
    );
}

#[test]
fn a_merge_carries_the_phone_link_to_the_survivor() {
    let w = World::new();
    people(&w, None, false, &[("a", "Ann")]);
    let ann = w.id_of("Ann");
    let bea = w.ok("person.add", json!({ "title": "Bea" }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.ok("person.merge", json!({ "from": ann, "into": bea }));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM source WHERE entity_id = ?1", &[&bea]),
        1,
        "the phone still follows the survivor"
    );
    let again = people(&w, None, true, &[("a", "Ann")]);
    assert_eq!(
        (again["added"].as_i64(), again["matched"].as_i64()),
        (Some(0), Some(0)),
        "{again}"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE kind = 'person' AND deleted_at IS NULL",
            &[]
        ),
        2,
        "the owner and Bea"
    );
}

#[test]
fn a_merge_re_points_every_foreign_key_into_an_entity_not_a_hand_list() {
    let w = World::new();
    let ann = w.ok("person.add", json!({ "title": "Ann" }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let bea = w.ok("person.add", json!({ "title": "Bea" }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    // A chat message that attached Ann: a reference no person table holds.
    let now = w.scratch.vault.clock().now_text();
    w.scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.attach");
            tx.insert_entity("thread-1", centraid_vault::model::Kind::Thread, "Chat", &now)?;
            let c = tx.connection();
            c.execute("INSERT INTO thread (id) VALUES ('thread-1')", [])?;
            c.execute(
                "INSERT INTO message (thread_id, ordinal, role, text, outcome, created_at, updated_at)
                 VALUES ('thread-1', 0, 'user', 'who is this', 'sent', ?1, ?1)",
                [&now],
            )?;
            c.execute(
                "INSERT INTO message_attachment (thread_id, ordinal, position, form, label, entity_id)
                 VALUES ('thread-1', 0, 0, 'document', 'Ann', ?1)",
                [&ann],
            )?;
            Ok(())
        })
        .expect("a chat");
    w.ok("person.merge", json!({ "from": ann, "into": bea }));
    assert_eq!(
        w.one::<Option<String>>("SELECT entity_id FROM message_attachment", &[]),
        Some(bea),
        "the attachment names the survivor, not nothing"
    );
}

// ---------------------------------------------------------------------------
// Bytes, in the command
// ---------------------------------------------------------------------------

#[test]
fn a_followed_file_claims_its_bytes_in_the_command_that_names_them() {
    let w = World::new();
    let folder = w.folder("Taxes");
    let hash = centraid_vault::blob::content_digest(b"never staged by a command");
    let origin = json!({ "ref": "/Taxes", "label": "Taxes", "fills": folder });
    let record = |size: Option<i64>| {
        let mut record = json!({ "external_id": "/a.pdf", "fields": {
            "title": "a.pdf", "blob": hash, "media_type": "application/pdf" } });
        if let Some(size) = size {
            record["size"] = json!(size);
        }
        record
    };
    let sentence = w.refused(
        "follow.files",
        json!({ "origin": origin, "records": [record(None)], "complete": true }),
    );
    assert!(sentence.contains("how large"), "{sentence}");
    let told = w.ok(
        "follow.files",
        json!({ "origin": origin, "records": [record(Some(25))], "complete": true }),
    );
    assert_eq!(told["added"].as_i64(), Some(1), "{told}");
    assert_eq!(
        w.one::<i64>("SELECT size FROM blob WHERE hash = ?1", &[&hash]),
        25
    );
}

// ---------------------------------------------------------------------------
// A series' days
// ---------------------------------------------------------------------------

fn series(starts: &str, rule: &str) -> Value {
    json!({ "external_id": "uid:standup", "fields": {
        "title": "Standup", "starts": starts, "zone": "Europe/Paris", "rule": rule } })
}

fn days(w: &World, id: &str) -> Vec<(String, i64)> {
    w.scratch
        .vault
        .read(|c| {
            let mut statement = c.prepare(
                "SELECT original_start, cancelled FROM occurrence WHERE series_id = ?1 ORDER BY 1",
            )?;
            let rows = statement
                .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .expect("days")
}

#[test]
fn a_series_that_moves_in_the_day_takes_its_overrides_with_it() {
    let w = World::new();
    calendar(&w, true, vec![series("2026-03-02T09:00:00", "FREQ=WEEKLY")]);
    let id = w.one::<String>("SELECT entity_id FROM source", &[]);
    w.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-09T09:00:00", "scope": "occurrence", "action": "skip" }),
    );
    calendar(&w, true, vec![series("2026-03-02T10:00:00", "FREQ=WEEKLY")]);
    assert_eq!(
        days(&w, &id),
        [("2026-03-09T10:00:00".to_owned(), 1)],
        "the skipped week is still skipped, at the hour the series keeps now"
    );
}

#[test]
fn a_series_that_no_longer_lands_on_an_override_s_day_drops_it() {
    let w = World::new();
    calendar(&w, true, vec![series("2026-03-02T09:00:00", "FREQ=WEEKLY")]);
    let id = w.one::<String>("SELECT entity_id FROM source", &[]);
    w.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-09T09:00:00", "scope": "occurrence", "action": "skip" }),
    );
    calendar(
        &w,
        true,
        vec![series("2026-03-02T09:00:00", "FREQ=MONTHLY")],
    );
    assert_eq!(
        days(&w, &id),
        Vec::<(String, i64)>::new(),
        "a day nothing will read is not kept"
    );
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

fn account(w: &World) -> String {
    w.ok(
        "account.add",
        json!({ "title": "Everyday", "type": "checking", "currency": "USD" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

fn statement(
    w: &World,
    account: &str,
    reference: &str,
    device: Option<&str>,
    title: &str,
) -> Value {
    w.ok(
        "follow.statement",
        json!({
            "origin": { "ref": reference, "label": "Everyday", "fills": account, "device_id": device },
            "records": [{ "external_id": "ofx:1", "device_id": device, "fields": {
                "title": title, "posted_on": "2026-03-02", "amount_minor": -450 } }],
        }),
    )
}

#[test]
fn an_account_has_one_statement_origin_whatever_ref_an_import_names() {
    let w = World::new();
    let account = account(&w);
    statement(&w, &account, "9999-bank-number", None, "COFFEE");
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM origin WHERE system = 'statement' AND fills = ?1",
            &[&account]
        ),
        1
    );
    let again = statement(&w, &account, "another-ref", None, "COFFEE");
    assert_eq!(again["added"].as_i64(), Some(0), "{again}");
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM txn", &[]),
        1,
        "the same line twice is one line"
    );
}

#[test]
fn a_statement_line_names_no_device_and_a_statement_is_never_stopped() {
    let w = World::new();
    let account = account(&w);
    statement(&w, &account, "ref", Some("phone-1"), "COFFEE");
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE device_id IS NOT NULL",
            &[]
        ),
        0,
        "a statement is not a phone store"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM origin WHERE device_id IS NOT NULL",
            &[]
        ),
        0
    );
    let reference = w.one::<String>("SELECT ref FROM origin WHERE system = 'statement'", &[]);
    let sentence = w.refused(
        "follow.stop",
        json!({ "system": "statement", "ref": reference }),
    );
    assert!(sentence.contains("statement"), "{sentence}");
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM source", &[]), 1);
}

#[test]
fn the_banks_words_stay_in_the_statement_whatever_the_line_is_called_now() {
    let w = World::new();
    let account = account(&w);
    statement(&w, &account, "ref", None, "AMZN MKTP US*2K4");
    let line = w.one::<String>("SELECT entity_id FROM source", &[]);
    w.ok("entity.retitle", json!({ "id": line, "title": "Amazon" }));
    // A re-import whose words a rule has already rewritten.
    statement(&w, &account, "ref", None, "Amazon Marketplace");
    assert_eq!(
        w.one::<String>("SELECT json_extract(stated, '$.title') FROM source", &[]),
        "AMZN MKTP US*2K4"
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&line]),
        "Amazon"
    );
}
