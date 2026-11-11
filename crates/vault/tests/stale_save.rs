//! A save that names the revision it replaces (#1185): `expected_rev` on the edit of each record an
//! editor saves. The same four facts for each: a stale revision is refused as `stale_revision` and
//! writes nothing, a fresh one is accepted and answers the revision the next save names, a record
//! in the trash is refused as `stale_trashed` whether or not the revision matches, and a save that
//! names none is accepted as it always was. (`notes.rs` holds the note's, with the edge cases of
//! the number itself.)

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
            scratch: common::Scratch::founded_with_blobs("stale_save").expect("a vault"),
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

    fn count(&self, sql: &str, id: &str) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, [id], |r| r.get(0))?))
            .expect("a count")
    }

    fn versions(&self, id: &str) -> i64 {
        self.count("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", id)
    }

    /// The four facts, for one edit command over one record: `edit` builds the command's input
    /// from a revision (or none) and a distinct value, `trash` puts the record in the trash.
    fn the_four_facts(
        &self,
        command: &str,
        id: &str,
        edit: impl Fn(Option<i64>, &str) -> Value,
        trash: impl Fn(),
    ) {
        // Another surface edits it: the record is at revision 1.
        self.ok(command, edit(None, "elsewhere"));
        assert_eq!(self.versions(id), 1);
        // A save from revision 0 is refused and writes nothing.
        let stale = self.run(command, edit(Some(0), "mine"));
        assert_eq!(stale.status, CommandStatus::Failed, "{command}");
        assert_eq!(stale.predicate.as_deref(), Some("stale_revision"));
        assert!(stale.tables.is_empty());
        assert_eq!(self.versions(id), 1);
        // From revision 1 it lands, and answers the revision the next save names.
        let fresh = self.ok(command, edit(Some(1), "mine"));
        assert_eq!(fresh["rev"], 2, "{command}");
        assert_eq!(self.versions(id), 2);
        // A save naming none is accepted and answers none.
        let plain = self.ok(command, edit(None, "again"));
        assert!(plain.get("rev").is_none());
        // In the trash it is refused as trashed, matching revision or not.
        trash();
        for rev in [3, 99] {
            let trashed = self.run(command, edit(Some(rev), "late"));
            assert_eq!(trashed.status, CommandStatus::Failed);
            assert_eq!(trashed.predicate.as_deref(), Some("stale_trashed"));
        }
    }
}

#[test]
fn a_person_edit_checks_the_revision_it_replaces() {
    let w = World::new();
    let id = w.ok("person.add", json!({ "title": "Dana" }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.the_four_facts(
        "person.edit",
        &id,
        |rev, role| {
            let mut input = json!({ "id": id, "role": role });
            if let Some(rev) = rev {
                input["expected_rev"] = rev.into();
            }
            input
        },
        || {
            w.ok("entity.trash", json!({ "id": id }));
        },
    );
}

#[test]
fn a_task_edit_checks_the_revision_it_replaces() {
    let w = World::new();
    let id = w.ok("task.add", json!({ "title": "Rent" }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.the_four_facts(
        "task.edit",
        &id,
        |rev, title| {
            let mut input = json!({ "id": id, "title": title });
            if let Some(rev) = rev {
                input["expected_rev"] = rev.into();
            }
            input
        },
        || {
            w.ok("entity.trash", json!({ "id": id }));
        },
    );
}

#[test]
fn a_document_edit_checks_the_revision_it_replaces() {
    let w = World::new();
    let id = w.ok(
        "document.create_text",
        json!({ "title": "Notes.txt", "body_text": "first", "media_type": "text/plain" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.the_four_facts(
        "document.edit",
        &id,
        |rev, words| {
            let mut input = json!({ "id": id, "body_text": words });
            if let Some(rev) = rev {
                input["expected_rev"] = rev.into();
            }
            input
        },
        || {
            w.ok("entity.trash", json!({ "id": id }));
        },
    );
}

#[test]
fn a_retitle_checks_the_revision_it_replaces() {
    let w = World::new();
    let id = w.ok(
        "document.create_text",
        json!({ "title": "Notes.txt", "body_text": "first", "media_type": "text/plain" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.the_four_facts(
        "entity.retitle",
        &id,
        |rev, title| {
            let mut input = json!({ "id": id, "title": title });
            if let Some(rev) = rev {
                input["expected_rev"] = rev.into();
            }
            input
        },
        || {
            w.ok("entity.trash", json!({ "id": id }));
        },
    );
}

#[test]
fn the_words_of_a_refused_document_save_are_kept_as_a_version_the_document_can_return_to() {
    let w = World::new();
    let id = w.ok(
        "document.create_text",
        json!({ "title": "Notes.txt", "body_text": "first", "media_type": "text/plain" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.ok(
        "document.edit",
        json!({ "id": id, "body_text": "elsewhere" }),
    );
    let kept = w.ok(
        "history.keep_version",
        json!({ "id": id, "fields": { "document.text": "my unsaved words" } }),
    );
    assert_eq!(kept["kept"], true);
    assert_eq!(w.versions(&id), 2);
    // The document is as the other surface left it; restoring the kept version brings the words back.
    w.ok(
        "history.restore_version",
        json!({ "id": id, "seq": kept["seq"] }),
    );
    let (held, kept_blob): (String, String) = w
        .scratch
        .vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT d.blob, (SELECT r.blob FROM revision r WHERE r.entity_id = d.id AND r.seq = ?2)
                   FROM document d WHERE d.id = ?1",
                rusqlite::params![&id, kept["seq"].as_i64()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .expect("a hash");
    assert_eq!(held, kept_blob);
}

#[test]
fn an_event_edit_checks_the_revision_it_replaces() {
    let w = World::new();
    let id = w.ok(
        "event.propose",
        json!({ "title": "Standup", "starts": "2026-03-02T09:00", "ends": "2026-03-02T09:30",
                "zone": "Europe/Paris" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.the_four_facts(
        "event.edit",
        &id,
        |rev, title| {
            let mut input = json!({ "id": id, "title": title });
            if let Some(rev) = rev {
                input["expected_rev"] = rev.into();
            }
            input
        },
        || {
            w.ok("entity.trash", json!({ "id": id }));
        },
    );
}

#[test]
fn an_account_edit_checks_the_revision_it_replaces() {
    let w = World::new();
    let id = w.ok(
        "account.add",
        json!({ "title": "Current", "type": "checking", "currency": "USD" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.the_four_facts(
        "account.edit",
        &id,
        |rev, title| {
            let mut input = json!({ "id": id, "title": title });
            if let Some(rev) = rev {
                input["expected_rev"] = rev.into();
            }
            input
        },
        || {
            w.ok("entity.trash", json!({ "id": id }));
        },
    );
}

#[test]
fn a_locker_item_edit_checks_the_revision_it_replaces() {
    let w = World::new();
    let id = w.ok(
        "locker.add_item",
        json!({ "item_id": "locker-item-1", "title": "Mail", "type": "login", "username": "a" }),
    )["item_id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.the_four_facts(
        "locker.edit_item",
        &id,
        |rev, username| {
            let mut input = json!({ "item_id": id, "username": username });
            if let Some(rev) = rev {
                input["expected_rev"] = rev.into();
            }
            input
        },
        || {
            w.ok("entity.trash", json!({ "id": id }));
        },
    );
}

#[test]
fn a_change_to_one_day_of_a_series_checks_the_revision_it_replaces() {
    let w = World::new();
    let id = w.ok(
        "event.propose",
        json!({ "title": "Standup", "starts": "2026-03-02T09:00", "ends": "2026-03-02T09:30",
                "zone": "Europe/Paris", "rule": "FREQ=WEEKLY" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.the_four_facts(
        "event.edit_occurrence",
        &id,
        |rev, title| {
            let mut input = json!({ "id": id, "original_start": "2026-03-09T09:00:00",
                "scope": "occurrence", "action": "override", "title": title });
            if let Some(rev) = rev {
                input["expected_rev"] = rev.into();
            }
            input
        },
        || {
            w.ok("entity.trash", json!({ "id": id }));
        },
    );
}

#[test]
fn filing_one_line_checks_the_revision_it_replaces_and_filing_several_names_none() {
    let w = World::new();
    let account = w.ok(
        "account.add",
        json!({ "title": "Everyday", "type": "checking", "currency": "USD" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.ok(
        "follow.statement",
        json!({ "origin": { "ref": account, "label": "Everyday", "fills": account },
                "records": [
                    { "external_id": "csv:1", "fields": { "title": "GROCER", "posted_on": "2026-03-01",
                                                         "amount_minor": -1250 } },
                    { "external_id": "csv:2", "fields": { "title": "CAFE", "posted_on": "2026-03-02",
                                                         "amount_minor": -450 } },
                    { "external_id": "csv:3", "fields": { "title": "BAKERY", "posted_on": "2026-03-03",
                                                         "amount_minor": -300 } }] }),
    );
    let lines: Vec<String> = w
        .scratch
        .vault
        .read(|c| {
            let mut statement = c.prepare("SELECT id FROM txn ORDER BY id")?;
            let rows = statement.query_map([], |row| row.get(0))?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
        .expect("the lines");
    let categories: Vec<String> = ["Zebra a", "Zebra b", "Zebra c"]
        .iter()
        .map(|title| {
            w.ok("category.add", json!({ "title": title }))["id"]
                .as_str()
                .expect("an id")
                .to_owned()
        })
        .collect();
    let pick = |value: &str| match value {
        "mine" => categories[1].clone(),
        "again" => categories[2].clone(),
        _ => categories[0].clone(),
    };
    let id = lines[0].clone();
    w.the_four_facts(
        "txn.categorize",
        &id,
        |rev, value| {
            let mut input = json!({ "ids": [id], "category_id": pick(value) });
            if let Some(rev) = rev {
                input["expected_rev"] = rev.into();
            }
            input
        },
        || {
            w.ok("entity.trash", json!({ "id": id }));
        },
    );
    // Several lines are no one record: a revision named with them holds none of them to it.
    let several = w.ok(
        "txn.categorize",
        json!({ "ids": [lines[1], lines[2]], "category_id": categories[1], "expected_rev": 99 }),
    );
    assert!(several.get("rev").is_none());
}
