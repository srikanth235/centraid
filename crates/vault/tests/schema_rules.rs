//! The rules a command enforces are also in the database (#1191, V2 to V5, V9): each test writes
//! the bad row with raw SQL on a founded vault and the database itself refuses it, and where a
//! command states the same rule, the command still refuses with its sentence.
//!
//! One test per shape of time column (V3): an instant, a date, a floating wall clock, an all-day
//! date and a zoned time, each refused when malformed by raw SQL.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

const AT: &str = "2026-03-01T09:00:00.000Z";

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("schema_rules").expect("a vault"),
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

    fn id(&self, name: &str, input: Value) -> String {
        self.ok(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
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

    /// Raw SQL in a commit: `Ok` when the database took it.
    fn raw(&self, sql: &str) -> Result<(), String> {
        self.scratch
            .vault
            .commit(|tx| {
                tx.connection().execute(sql, [])?;
                Ok(())
            })
            .map_err(|error| error.to_string())
            .map(|_| ())
    }

    /// The database refuses this statement; the message is returned.
    /// The database refuses `sql` for a rule it holds: a CHECK, a UNIQUE or a trigger's sentence.
    /// A statement that fails for another reason (a typo, a missing column) is a broken test, not a held rule, and fails here.
    fn db_refuses(&self, sql: &str) -> String {
        match self.raw(sql) {
            Ok(()) => panic!("the database took what it should refuse: {sql}"),
            Err(why) => {
                for not_a_rule in [
                    "no such",
                    "syntax error",
                    "has no column",
                    "datatype mismatch",
                    "NOT NULL constraint failed",
                ] {
                    assert!(
                        !why.contains(not_a_rule),
                        "`{sql}` failed for a reason that is not a held rule ({not_a_rule}): {why}"
                    );
                }
                why
            }
        }
    }

    /// As [`Self::db_refuses`], and the refusal names `fragment` (the constraint or the trigger's
    /// sentence).
    fn db_refuses_with(&self, sql: &str, fragment: &str) {
        let why = self.db_refuses(sql);
        assert!(
            why.contains(fragment),
            "`{sql}` was refused, but not by the rule named `{fragment}`: {why}"
        );
    }

    fn count(&self, sql: &str) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, [], |r| r.get(0))?))
            .expect("a count")
    }

    fn text(&self, sql: &str) -> Option<String> {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, [], |r| r.get(0))?))
            .expect("a value")
    }

    fn entity(&self, id: &str, kind: Kind) {
        self.scratch
            .vault
            .commit(|tx| tx.insert_entity(id, kind, id, AT).map(|_| ()))
            .expect("an entity");
    }
}

// ---------------------------------------------------------------------------------------------
// V2: rules into the database
// ---------------------------------------------------------------------------------------------

#[test]
fn a_container_never_nests_in_a_loop() {
    let w = World::new();
    let a = w.id(
        "container.create",
        json!({ "kind": "folder", "title": "A" }),
    );
    let b = w.id(
        "container.create",
        json!({ "kind": "folder", "title": "B", "parent": a }),
    );
    let c = w.id(
        "container.create",
        json!({ "kind": "folder", "title": "C", "parent": b }),
    );
    // The command refuses with its sentence.
    assert!(
        w.refused("container.move", json!({ "id": a, "parent": c }))
            .contains("cannot go inside itself")
    );
    // The database refuses the same move, and a container as its own parent.
    w.db_refuses(&format!(
        "UPDATE container SET parent_id = '{c}' WHERE id = '{a}'"
    ));
    w.db_refuses(&format!(
        "UPDATE container SET parent_id = '{a}' WHERE id = '{a}'"
    ));
    assert_eq!(
        w.text(&format!("SELECT parent_id FROM container WHERE id = '{a}'")),
        None
    );
}

#[test]
fn a_concept_never_nests_in_a_loop_or_under_another_kind() {
    let w = World::new();
    // Seeded categories: `category:food` is the parent of `category:food.dining`.
    w.db_refuses(
        "UPDATE concept SET parent_id = 'category:food.dining' WHERE id = 'category:food'",
    );
    w.db_refuses("UPDATE concept SET parent_id = id WHERE id = 'category:food'");
    // A concept's parent is of its own kind.
    w.db_refuses_with(
        "UPDATE concept SET parent_id = 'workout_kind:run' WHERE id = 'category:fees'",
        "of its own kind",
    );
    w.db_refuses_with(
        "INSERT INTO concept (id, kind, key, parent_id) VALUES ('x', 'tag', 'x', 'flag:starred')",
        "of its own kind",
    );
    // Changing a kind keeps it too, as a child (its parent stays) and as a parent (its children
    // stay): the trigger's sentence, not the entity key that would refuse it afterwards.
    w.db_refuses_with(
        "UPDATE concept SET kind = 'flag' WHERE id = 'category:food.dining'",
        "of its own kind",
    );
    w.db_refuses_with(
        "UPDATE concept SET kind = 'flag' WHERE id = 'category:food'",
        "of its own kind",
    );
}

#[test]
fn a_task_is_never_its_own_series() {
    let w = World::new();
    let task = w.id("task.add", json!({ "title": "Water the plants" }));
    w.db_refuses(&format!(
        "UPDATE task SET series_id = id WHERE id = '{task}'"
    ));
    // The command still names the series by the head's id, which only the successor carries.
    let repeating = w.id(
        "task.add",
        json!({ "title": "Weekly", "due": "2026-03-02", "rule": "FREQ=WEEKLY" }),
    );
    let done = w.ok("task.complete", json!({ "id": repeating }));
    assert_eq!(done["series_id"], repeating.as_str());
    assert_eq!(
        w.text(&format!(
            "SELECT series_id FROM task WHERE id = '{repeating}'"
        )),
        None
    );
}

#[test]
fn a_budget_currency_is_three_capital_letters() {
    let w = World::new();
    for bad in ["usd", "US", "USDD", "U1D"] {
        w.db_refuses(&format!(
            "INSERT INTO budget (category_id, month, amount_minor, currency)
             VALUES ('category:food', '2026-03', 100, '{bad}')"
        ));
    }
    w.raw(
        "INSERT INTO budget (category_id, month, amount_minor, currency)
         VALUES ('category:food', '2026-03', 100, 'USD')",
    )
    .expect("a real currency");
}

#[test]
fn a_follow_fills_a_home_of_its_systems_kind() {
    let w = World::new();
    w.entity("folder-home", Kind::Folder);
    w.raw("INSERT INTO container (id, kind) VALUES ('folder-home', 'folder')")
        .expect("a folder");
    // A calendar follow fills a calendar, not a folder; a contacts follow fills nothing.
    w.db_refuses(
        "INSERT INTO origin (id, system, ref, label, fills, created_at)
         VALUES ('o1', 'calendar', 'c', 'c', 'folder-home', '2026-03-01T09:00:00.000Z')",
    );
    w.db_refuses(
        "INSERT INTO origin (id, system, ref, label, fills, created_at)
         VALUES ('o2', 'contacts', 'c', 'c', 'folder-home', '2026-03-01T09:00:00.000Z')",
    );
    w.raw(
        "INSERT INTO origin (id, system, ref, label, fills, created_at)
         VALUES ('o3', 'files', 'c', 'c', 'folder-home', '2026-03-01T09:00:00.000Z')",
    )
    .expect("a folder is what a files follow fills");
}

#[test]
fn a_workout_is_the_measures_of_a_workout_kind_activity_only() {
    let w = World::new();
    w.entity("act", Kind::Activity);
    w.raw(
        "INSERT INTO activity (id, type_id, type_kind, starts)
         VALUES ('act', 'activity_kind:call', 'activity_kind', '2026-03-01T07:00:00.000Z')",
    )
    .expect("a call");
    w.db_refuses("INSERT INTO workout (id, moving_s) VALUES ('act', 60)");
    w.entity("run", Kind::Activity);
    w.raw(
        "INSERT INTO activity (id, type_id, type_kind, starts)
         VALUES ('run', 'workout_kind:run', 'workout_kind', '2026-03-01T07:00:00.000Z')",
    )
    .expect("a run");
    w.raw("INSERT INTO workout (id, moving_s) VALUES ('run', 60)")
        .expect("a workout of a workout kind");
    // An activity that has a workout cannot stop being of a workout kind.
    w.db_refuses(
        "UPDATE activity SET type_id = 'activity_kind:call', type_kind = 'activity_kind' WHERE id = 'run'",
    );
}

#[test]
fn a_container_colour_is_a_palette_key_or_a_wheel_hue_and_a_command_keeps_each_to_its_kind() {
    let w = World::new();
    w.entity("list-1", Kind::List);
    for bad in ["chartreuse", "#ff0000", "var(--c-puce)", ""] {
        w.db_refuses(&format!(
            "INSERT INTO container (id, kind, color) VALUES ('list-1', 'list', '{bad}')"
        ));
    }
    w.raw("INSERT INTO container (id, kind, color) VALUES ('list-1', 'list', 'petrol')")
        .expect("a palette key");
    w.raw("UPDATE container SET color = 'var(--c-teal)' WHERE id = 'list-1'")
        .expect("a wheel hue, the shell's naming of a phone calendar's colour");
    // The command refuses what a list may not wear, with its sentence.
    for bad in ["chartreuse", "var(--c-rose)"] {
        assert!(
            w.refused(
                "container.create",
                json!({ "kind": "list", "title": "L", "color": bad })
            )
            .contains("not one of the list colours")
        );
    }
}

// ---------------------------------------------------------------------------------------------
// V3: one checked format per time column
// ---------------------------------------------------------------------------------------------

#[test]
fn an_instant_is_the_clocks_one_form() {
    let w = World::new();
    for bad in [
        "2026-03-01T09:00:00Z",
        "2026-03-01 09:00:00.000Z",
        "2026-03-01T09:00:00.000",
        "2026-03-01",
        "2026-02-30T09:00:00.000Z",
        "yesterday",
    ] {
        w.db_refuses(&format!(
            "INSERT INTO entity (id, kind, title, created_at, updated_at)
             VALUES ('bad', 'note', 'x', '{bad}', '{AT}')"
        ));
    }
    w.db_refuses(&format!(
        "INSERT INTO entity (id, kind, title, created_at, updated_at, deleted_at, purge_at)
         VALUES ('bad', 'note', 'x', '{AT}', '{AT}', '2026-03-01T09:00:00Z', '{AT}')"
    ));
    // The columns of the other tables that hold an instant say the same.
    w.db_refuses("UPDATE vault SET written_at = '2026-03-01T09:00:00Z'");
    w.db_refuses("INSERT INTO action_key (key, asked, at) VALUES ('k', 'a', '2026-03-01')");
    w.db_refuses(
        "INSERT INTO origin (id, system, ref, label, created_at)
         VALUES ('o', 'files', 'r', 'r', '2026-03-01 09:00:00')",
    );
}

#[test]
fn a_task_due_is_a_date_a_wall_clock_or_an_instant_and_never_a_space() {
    let w = World::new();
    let task = w.id("task.add", json!({ "title": "T", "due": "2026-03-02" }));
    for bad in [
        "2026-03-02 09:00",
        "2026-03-02T09",
        "2026-03-02T09:00:00+01:00",
        "soon",
    ] {
        w.db_refuses(&format!(
            "UPDATE task SET due = '{bad}' WHERE id = '{task}'"
        ));
    }
    for good in [
        "2026-03-02",
        "2026-03-02T09:00",
        "2026-03-02T09:00:00",
        "2026-03-02T09:00:00.000Z",
    ] {
        w.raw(&format!(
            "UPDATE task SET due = '{good}' WHERE id = '{task}'"
        ))
        .unwrap_or_else(|why| panic!("{good} is a due: {why}"));
    }
    // A command takes an instant in any spelling and holds it in the clock's one form.
    let other = w.id(
        "task.add",
        json!({ "title": "U", "due": "2026-03-02T09:00:00Z" }),
    );
    assert_eq!(
        w.text(&format!("SELECT due FROM task WHERE id = '{other}'"))
            .as_deref(),
        Some("2026-03-02T09:00:00.000Z")
    );
}

#[test]
fn an_event_time_reads_under_its_timing() {
    let w = World::new();
    w.entity("ev", Kind::Event);
    let insert = |timing: &str, zone: &str, starts: &str, ends: &str| {
        format!(
            "INSERT INTO event (id, starts, ends, timing, zone, calendar_id)
             VALUES ('ev', '{starts}', {ends}, '{timing}', {zone}, 'calendar:default')"
        )
    };
    // Zoned: an instant, and a zone.
    w.db_refuses(&insert(
        "zoned",
        "'Europe/Paris'",
        "2026-03-02T10:00:00",
        "NULL",
    ));
    w.db_refuses(&insert("zoned", "'Europe/Paris'", "2026-03-02", "NULL"));
    w.db_refuses(&insert("zoned", "NULL", "2026-03-02T10:00:00.000Z", "NULL"));
    // All-day: a date.
    w.db_refuses(&insert("all-day", "NULL", "2026-03-02T10:00", "NULL"));
    w.db_refuses(&insert(
        "all-day",
        "NULL",
        "2026-03-02",
        "'2026-03-03T10:00'",
    ));
    // Floating: a wall clock, no zone designator.
    w.db_refuses(&insert(
        "floating",
        "NULL",
        "2026-03-02T10:00:00.000Z",
        "NULL",
    ));
    w.db_refuses(&insert("floating", "NULL", "2026-03-02", "NULL"));
    w.db_refuses(&insert("floating", "NULL", "2026-03-02 10:00", "NULL"));
    // And each is taken in its own shape.
    w.raw(&insert(
        "floating",
        "NULL",
        "2026-03-02T10:00",
        "'2026-03-02T11:00:00'",
    ))
    .expect("floating");
    w.raw("DELETE FROM event WHERE id = 'ev'").expect("clears");
    w.raw(&insert("all-day", "NULL", "2026-03-02", "'2026-03-03'"))
        .expect("all-day");
    w.raw("DELETE FROM event WHERE id = 'ev'").expect("clears");
    w.raw(&insert(
        "zoned",
        "'Europe/Paris'",
        "2026-03-02T09:00:00.000Z",
        "'2026-03-02T10:00:00.000Z'",
    ))
    .expect("zoned");
}

#[test]
fn an_occurrence_time_reads_under_its_own_timing_or_the_series() {
    let w = World::new();
    w.entity("ev", Kind::Event);
    w.raw(
        "INSERT INTO event (id, starts, timing, rule, calendar_id)
         VALUES ('ev', '2026-03-02', 'all-day', 'FREQ=WEEKLY', 'calendar:default')",
    )
    .expect("a series");
    let occurrence = |original: &str, starts: &str, timing: &str| {
        format!(
            "INSERT INTO occurrence (series_id, original_start, starts, timing)
             VALUES ('ev', '{original}', '{starts}', {timing})"
        )
    };
    w.db_refuses(&occurrence("2026-03-09", "2026-03-09T10:00", "'all-day'"));
    w.db_refuses(&occurrence("2026-03-09", "2026-03-09", "'floating'"));
    w.db_refuses(&occurrence("garbage", "2026-03-09", "NULL"));
    w.raw(&occurrence("2026-03-09", "2026-03-10", "NULL"))
        .expect("a moved day");
}

#[test]
fn an_activity_a_photo_and_a_message_hold_instants() {
    let w = World::new();
    w.entity("act", Kind::Activity);
    w.db_refuses(
        "INSERT INTO activity (id, type_id, type_kind, starts)
         VALUES ('act', 'workout_kind:run', 'workout_kind', '2026-03-01T07:00:00Z')",
    );
    w.db_refuses(
        "INSERT INTO activity (id, type_id, type_kind, starts, ends)
         VALUES ('act', 'workout_kind:run', 'workout_kind', '2026-03-01T07:00:00.000Z', '2026-03-01')",
    );
    w.raw("INSERT INTO blob (hash, size) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1)")
        .expect("a blob");
    w.entity("ph", Kind::Photo);
    w.db_refuses(
        "INSERT INTO photo (id, blob, media_type, form, taken_at)
         VALUES ('ph', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'image/jpeg', 'photo', '2026-03-01 10:00:00')",
    );
    w.entity("th", Kind::Thread);
    w.raw("INSERT INTO thread (id) VALUES ('th')")
        .expect("a thread");
    w.db_refuses(
        "INSERT INTO message (thread_id, ordinal, role, text, outcome, created_at, updated_at)
         VALUES ('th', 0, 'user', 'hi', 'sent', '2026-03-01T09:00:00.000Z', 'later')",
    );
}

// ---------------------------------------------------------------------------------------------
// V4: a section and its tasks
// ---------------------------------------------------------------------------------------------

#[test]
fn a_task_in_a_section_can_be_reordered_after_its_section_moved() {
    let w = World::new();
    let one = w.id(
        "container.create",
        json!({ "kind": "project", "title": "One" }),
    );
    let two = w.id(
        "container.create",
        json!({ "kind": "project", "title": "Two" }),
    );
    let section = w.id(
        "container.create",
        json!({ "kind": "section", "title": "S", "parent": one }),
    );
    let first = w.id(
        "task.add",
        json!({ "title": "a", "project_id": one, "section_id": section }),
    );
    let second = w.id(
        "task.add",
        json!({ "title": "b", "project_id": one, "section_id": section }),
    );
    // Any writer that moves the section takes its tasks with it (the database does, so a move that
    // is not the command's leaves no task pointing at the old project).
    w.raw(&format!(
        "UPDATE container SET parent_id = '{two}' WHERE id = '{section}'"
    ))
    .expect("the section moves");
    assert_eq!(
        w.count(&format!(
            "SELECT COUNT(*) FROM task WHERE section_id = '{section}' AND project_id = '{two}'"
        )),
        2,
        "every task of the section followed it"
    );
    // The failing case: a reorder (a write that touches neither column) of a task in the section.
    w.ok("task.organize", json!({ "id": first, "position": 7.5 }));
    w.ok("task.organize", json!({ "id": second, "position": 1.5 }));
    // And the command's own move still names its tasks to the history.
    let back = w.ok("container.move", json!({ "id": section, "parent": one }));
    assert_eq!(back["id"], section.as_str());
    assert_eq!(
        w.count(&format!(
            "SELECT COUNT(*) FROM task WHERE section_id = '{section}' AND project_id = '{one}'"
        )),
        2
    );
}

// ---------------------------------------------------------------------------------------------
// V9: a transfer is one row
// ---------------------------------------------------------------------------------------------

#[test]
fn a_line_is_in_one_transfer_and_never_paired_with_itself() {
    let w = World::new();
    for (id, account) in [
        ("a0", "acct1"),
        ("a1", "acct1"),
        ("a2", "acct2"),
        ("a3", "acct1"),
        ("a4", "acct2"),
    ] {
        if w.count(&format!(
            "SELECT COUNT(*) FROM account WHERE id = '{account}'"
        )) == 0
        {
            w.entity(account, Kind::Account);
            w.raw(&format!(
                "INSERT INTO account (id, type, currency) VALUES ('{account}', 'checking', 'USD')"
            ))
            .expect("an account");
        }
        w.entity(id, Kind::Txn);
        w.raw(&format!(
            "INSERT INTO txn (id, account_id, currency, posted_on, amount_minor)
             VALUES ('{id}', '{account}', 'USD', '2026-03-01', {})",
            if id == "a2" { 500 } else { -500 }
        ))
        .expect("a line");
    }
    // A line is never paired with itself, and the lower id is `a`.
    w.db_refuses_with(
        "INSERT INTO transfer (a, b) VALUES ('a1', 'a1')",
        "CHECK constraint failed",
    );
    w.db_refuses_with(
        "INSERT INTO transfer (a, b) VALUES ('a2', 'a1')",
        "CHECK constraint failed",
    );
    w.raw("INSERT INTO transfer (a, b) VALUES ('a1', 'a2')")
        .expect("a pair");
    // Neither half joins another pair on the same side: the keys refuse it.
    w.db_refuses_with(
        "INSERT INTO transfer (a, b) VALUES ('a1', 'a3')",
        "UNIQUE constraint failed",
    );
    w.db_refuses_with(
        "INSERT INTO transfer (a, b) VALUES ('a0', 'a2')",
        "UNIQUE constraint failed",
    );
    // Nor on the other side (an existing `a` as a new `b`, an existing `b` as a new `a`): the
    // trigger's sentence, with every line above existing and unpaired, so the foreign key is not
    // what refuses.
    w.db_refuses_with(
        "INSERT INTO transfer (a, b) VALUES ('a0', 'a1')",
        "at most one transfer",
    );
    w.db_refuses_with(
        "INSERT INTO transfer (a, b) VALUES ('a2', 'a3')",
        "at most one transfer",
    );
    // The same four on an UPDATE of a second pair.
    w.raw("INSERT INTO transfer (a, b) VALUES ('a3', 'a4')")
        .expect("a second pair");
    w.db_refuses_with(
        "UPDATE transfer SET a = 'a0', b = 'a1' WHERE a = 'a3'",
        "at most one transfer",
    );
    w.db_refuses_with(
        "UPDATE transfer SET a = 'a2' WHERE a = 'a3'",
        "at most one transfer",
    );
    w.db_refuses_with(
        "UPDATE transfer SET b = 'a4' WHERE a = 'a1'",
        "UNIQUE constraint failed",
    );
    w.db_refuses_with(
        "UPDATE transfer SET b = 'a3' WHERE a = 'a3'",
        "CHECK constraint failed",
    );
    w.raw("UPDATE transfer SET b = 'a4' WHERE a = 'a3'")
        .expect("a change that keeps the pair is fine");
    w.raw("DELETE FROM transfer WHERE a = 'a3'")
        .expect("unpairs");
    assert_eq!(w.count("SELECT COUNT(*) FROM transfer"), 1);
    // The command still says why.
    assert!(
        w.refused("txn.link_transfer", json!({ "id": "a3", "other_id": "a2" }))
            .contains("another transfer")
    );
}
