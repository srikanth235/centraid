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
            scratch: common::Scratch::founded("stale_save").expect("a vault"),
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
