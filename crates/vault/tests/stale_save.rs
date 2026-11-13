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

#[test]
fn the_times_alerts_and_guests_of_a_refused_event_save_are_kept_and_restore_puts_them_back() {
    let w = World::new();
    let ben = w.ok("person.add", json!({ "title": "Ben" }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let id = w.ok(
        "event.propose",
        json!({ "title": "Lunch", "starts": "2026-03-02T12:00", "ends": "2026-03-02T13:00",
                "zone": "Europe/Paris" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    // What the member typed: a wall clock and its zone, alerts as numbers, a guest to invite.
    let kept = w.ok(
        "history.keep_version",
        json!({ "id": id, "fields": {
            "event.starts": "2026-03-03T10:00:00", "event.ends": "2026-03-03T11:30:00",
            "event.timing": "zoned", "event.zone": "Asia/Tokyo",
            "event.reminders": [30, 60], "attendee": [ben] } }),
    );
    assert_eq!(kept["kept"], true);
    assert_eq!(w.versions(&id), 1);
    // The event itself is as it was.
    let held = |sql: &str| -> Option<String> {
        w.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, [&id], |row| row.get(0))?))
            .expect("a row")
    };
    assert_eq!(
        held("SELECT zone FROM event WHERE id = ?1").as_deref(),
        Some("Europe/Paris")
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'attendee'",
            &id
        ),
        0
    );
    // Restoring it brings every field back, the instants resolved in the zone typed.
    w.ok("history.restore_version", json!({ "id": id, "seq": 1 }));
    assert_eq!(
        held("SELECT starts FROM event WHERE id = ?1").as_deref(),
        Some("2026-03-03T01:00:00.000Z")
    );
    assert_eq!(
        held("SELECT ends FROM event WHERE id = ?1").as_deref(),
        Some("2026-03-03T02:30:00.000Z")
    );
    assert_eq!(
        held("SELECT zone FROM event WHERE id = ?1").as_deref(),
        Some("Asia/Tokyo")
    );
    assert_eq!(
        held("SELECT reminders FROM event WHERE id = ?1").as_deref(),
        Some("[30,60]")
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'attendee'",
            &id
        ),
        1
    );
    // A time that is no time is refused, and nothing is kept.
    let bad = w.run(
        "history.keep_version",
        json!({ "id": id, "fields": { "event.starts": "2026-03-03T12:00:00",
            "event.ends": "2026-03-03T11:00:00", "event.timing": "zoned", "event.zone": "Asia/Tokyo" } }),
    );
    assert_eq!(bad.status, CommandStatus::Failed);
}

#[test]
fn a_refused_change_to_one_day_is_kept_as_the_days_override_and_restore_puts_it_back() {
    let w = World::new();
    let id = w.ok(
        "event.propose",
        json!({ "title": "Stand-up", "starts": "2026-03-02T10:00", "ends": "2026-03-02T10:30",
                "zone": "Europe/Paris", "rule": "FREQ=DAILY" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let day = |sql: &str| -> Vec<(Option<String>, Option<String>, Option<String>)> {
        w.scratch
            .vault
            .read(|c| {
                let mut statement = c.prepare(sql)?;
                let rows = statement
                    .query_map([&id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                Ok(rows)
            })
            .expect("rows")
    };
    let rows = "SELECT starts, ends, title FROM occurrence WHERE series_id = ?1";
    let kept = w.ok(
        "history.keep_version",
        json!({ "id": id, "fields": { "occurrence": {
            "original_start": "2026-03-04T10:00:00", "scope": "occurrence",
            "starts": "2026-03-04T15:00:00", "ends": "2026-03-04T16:00:00",
            "zone": "Europe/Paris", "title": "Late sync" } } }),
    );
    assert_eq!(kept["kept"], true);
    assert_eq!(w.versions(&id), 1);
    // The day has no override yet: the event and its days are as they were.
    assert!(day(rows).is_empty());
    let title: String = w
        .scratch
        .vault
        .read(|c| {
            Ok(
                c.query_row("SELECT title FROM entity WHERE id = ?1", [&id], |r| {
                    r.get(0)
                })?,
            )
        })
        .expect("a title");
    assert_eq!(title, "Stand-up");
    // Restoring brings the day's override back, resolved as `edit-occurrence` would have.
    w.ok("history.restore_version", json!({ "id": id, "seq": 1 }));
    assert_eq!(
        day(rows),
        [(
            Some("2026-03-04T14:00:00.000Z".to_owned()),
            Some("2026-03-04T15:00:00.000Z".to_owned()),
            Some("Late sync".to_owned())
        )]
    );
    // The same day stated again replaces the row it has, and restore goes back to the first.
    w.ok(
        "history.keep_version",
        json!({ "id": id, "fields": { "occurrence": {
            "original_start": "2026-03-04T10:00:00", "scope": "occurrence", "title": "Cancelled-ish" } } }),
    );
    let newest = w.versions(&id);
    w.ok(
        "history.restore_version",
        json!({ "id": id, "seq": newest }),
    );
    assert_eq!(day(rows), [(None, None, Some("Cancelled-ish".to_owned()))]);
    // A day that is no day, a scope that is none, and an event that does not repeat are refused.
    for bad in [
        json!({ "original_start": "2026-03-04T10:00:00", "scope": "series", "title": "x" }),
        json!({ "scope": "occurrence", "title": "x" }),
        json!({ "original_start": "2026-03-04T10:00:00", "scope": "occurrence",
                "starts": "2026-03-04T15:00:00", "ends": "2026-03-04T14:00:00", "zone": "Europe/Paris" }),
    ] {
        let refused = w.run(
            "history.keep_version",
            json!({ "id": id, "fields": { "occurrence": bad } }),
        );
        assert_eq!(refused.status, CommandStatus::Failed, "{bad}");
    }
    let once = w.ok(
        "event.propose",
        json!({ "title": "Once", "starts": "2026-03-02T12:00", "ends": "2026-03-02T13:00",
                "zone": "Europe/Paris" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let refused = w.run(
        "history.keep_version",
        json!({ "id": once, "fields": { "occurrence": {
            "original_start": "2026-03-02T12:00:00", "scope": "occurrence", "title": "x" } } }),
    );
    assert_eq!(refused.status, CommandStatus::Failed);
    assert_eq!(w.versions(&once), 0);
}

/// **A SAVE AFTER AN AUTOSAVE IS NOT STALE** (#1191, V13). An editor's autosaves are quiet: the
/// first of a session keeps a version, and the ones that follow fold into it and keep none. Each
/// save names the revision the one before answered, so what a save answers must be the revision
/// the history holds once it settles, folded or not. The test saves quietly, over and over, each
/// naming the revision the last answered, and then saves with the revision the history reports.
#[test]
fn a_save_that_names_the_revision_an_autosave_answered_is_not_stale() {
    let w = World::new();
    let id = w.ok("note.create", json!({ "title": "Plan", "body": "zero" }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let mut named: i64 = 0;
    for round in 1..=4 {
        let outcome = w
            .scratch
            .vault
            .execute(
                &w.registry,
                &Principal::owner("phone"),
                &Command::new(
                    "note.edit",
                    json!({ "id": id, "body": format!("words {round}"), "expected_rev": named }),
                )
                .quiet(),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "autosave {round} naming revision {named}: {:?}",
            outcome.reason
        );
        named = outcome.output["rev"]
            .as_i64()
            .expect("a revision is answered");
        // The revision it answered is the one the history now holds.
        assert_eq!(
            named,
            w.count(
                "SELECT COALESCE(MAX(seq), 0) FROM revision WHERE entity_id = ?1",
                &id
            ),
            "after autosave {round} the answered revision is the head"
        );
    }
    // Only the first of the session kept a version; the later ones folded into it.
    assert_eq!(
        w.versions(&id),
        1,
        "the quiet saves folded into one version"
    );
    // A deliberate save naming the last answer lands too, and keeps its own version.
    let deliberate = w.ok(
        "note.edit",
        json!({ "id": id, "body": "final words", "expected_rev": named }),
    );
    assert_eq!(deliberate["rev"], named + 1);
}
