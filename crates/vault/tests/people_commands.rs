//! THE TWENTY-EIGHT `people.*` COMMANDS, THE FOUR `social.*` ONES, AND THE
//! ONTOLOGY PRIMITIVE BEHIND `merge-people` (#1020 wave 4 slot 4c).
//!
//! Four claims, each one a way the port could have been wrong:
//!
//! 1. **`core.merge_party` is exhaustive by construction** (D-1020-PE2). The
//!    sweep is generated from the live schema — every engine foreign key onto
//!    `core_party`, every composite `(type, id)` pointer into the entity
//!    supertype, plus the one hand-kept pointer the engine cannot see — and
//!    `the_merge_leaves_no_row_naming_the_folded_in_party` plants a reference in
//!    **every referencing column the sweep names** and asserts ZERO survivors.
//!    The planting is generated too: a fixture that typed its own rows would
//!    prove the sweep covers the columns whoever typed it remembered.
//! 2. **Every `once` command replays from the ledger** (D-1020-PE3). Fourteen
//!    of the twenty-eight are `once`, and a replayed `intent_id` must execute
//!    NOTHING a second time — not a second row, not a second invocation row.
//! 3. **A collision is answered per table, never deleted by default** (#916
//!    review 2.1): a share is a NUMBER and it adds, a primacy flag demotes, a
//!    row whose two ends became one party is dropped and COUNTED, and a foreign
//!    key refusal is re-thrown rather than becoming a silent delete.
//! 4. **A refusal is receipted, not thrown.** Every gate here is asserted
//!    through `Vault::execute`'s own answer, which is the shape a surface
//!    renders.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::commands::core::{NOT_A_PARTY_POINTER, merge_party_sweep};
use centraid_vault::{Command, CommandOutcome, CommandStatus, Vault};
use serde_json::{Value, json};

/// A founded vault with the registry installed, and its owner's principal.
struct Circle {
    scratch: common::Scratch,
    registry: Registry,
    principal: Principal,
}

impl Circle {
    fn open(seed: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry
            .install(&scratch.vault)
            .expect("the registry's record installs");
        Self {
            scratch,
            registry,
            principal: Principal::owner("phone"),
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    fn run(&self, command: &str, input: Value) -> Value {
        let outcome = self.try_run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "`{command}` refused: {:?} / {:?}",
            outcome.predicate,
            outcome.reason
        );
        outcome.output
    }

    fn try_run(&self, command: &str, input: Value) -> CommandOutcome {
        self.vault()
            .execute(
                &self.registry,
                &self.principal,
                &Command::new(command, input),
            )
            .unwrap_or_else(|error| panic!("`{command}` errored rather than answering: {error}"))
    }

    /// Run a command under a seat's intent id, which is what the ledger keys a
    /// replay on.
    fn run_with_intent(&self, command: &str, input: Value, intent_id: &str) -> CommandOutcome {
        self.vault()
            .execute(
                &self.registry,
                &self.principal,
                &Command::new(command, input).with_intent(intent_id, "phone"),
            )
            .unwrap_or_else(|error| panic!("`{command}` errored rather than answering: {error}"))
    }

    fn count(&self, sql: &str) -> i64 {
        self.vault()
            .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
            .expect("the count reads")
    }

    fn text(&self, sql: &str) -> Option<String> {
        self.vault()
            .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0)).ok()))
            .expect("the read runs")
    }

    fn owner_party_id(&self) -> String {
        self.text("SELECT self_party_id FROM core_vault LIMIT 1")
            .expect("a founded vault has an owner")
    }

    /// One person, by name, with a cadence.
    fn person(&self, name: &str, cadence: i64) -> String {
        self.run(
            "people.add_person",
            json!({ "display_name": name, "cadence_days": cadence }),
        )["party_id"]
            .as_str()
            .expect("a party id")
            .to_owned()
    }
}

// ---------------------------------------------------------------------------
// The person's own lifecycle.
// ---------------------------------------------------------------------------

#[test]
fn a_person_is_a_party_and_a_profile_and_the_party_survives_the_trash() {
    let circle = Circle::open("people-lifecycle");
    let maya = circle.person("Maya Alvarez", 30);
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM core_party WHERE party_id = '{maya}' AND kind = 'person'"
        )),
        1
    );
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM people_profile WHERE party_id = '{maya}'"
        )),
        1
    );

    let trashed = circle.run("people.trash_person", json!({ "party_id": maya }));
    // THE CANONICAL PARTY SURVIVES.
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM core_party WHERE party_id = '{maya}'"
        )),
        1,
        "trashing a person must not take their party with it"
    );
    assert!(
        circle
            .text(&format!(
                "SELECT purge_at FROM people_profile WHERE party_id = '{maya}'"
            ))
            .is_some(),
        "a trashed profile carries its purge date"
    );

    // A SECOND TRASH IS REFUSED: the person is no longer live.
    let again = circle.try_run("people.trash_person", json!({ "party_id": maya }));
    assert_eq!(again.status, CommandStatus::Failed);
    assert_eq!(again.predicate.as_deref(), Some("person_live"));

    // AND A FROZEN PERSON DOES NOT EDIT. Restore first.
    let frozen = circle.try_run(
        "people.edit_person",
        json!({ "party_id": maya, "role": "College friend" }),
    );
    assert_eq!(frozen.status, CommandStatus::Failed);
    assert_eq!(frozen.predicate.as_deref(), Some("person_exists"));

    circle.run("people.restore_person", json!({ "party_id": maya }));
    assert_eq!(
        circle.text(&format!(
            "SELECT deleted_at FROM people_profile WHERE party_id = '{maya}'"
        )),
        None
    );
    // The trash's revision is still the undo rail's, and it names an instant.
    assert!(trashed["undo_until"].as_str().is_some());
}

#[test]
fn a_restore_past_its_window_is_refused_rather_than_racing_the_sweep() {
    let circle = Circle::open("people-lapsed");
    let jake = circle.person("Jake Bennett", 45);
    circle.run("people.trash_person", json!({ "party_id": jake }));
    // Reach past the thirty-day window by hand: the condition compares
    // `purge_at` against the INVOCATION's instant, so moving the row is the
    // only way to age it without moving the clock the whole vault reads.
    circle
        .vault()
        .commit(|tx| {
            tx.set_producer("test.lapse");
            tx.connection().execute(
                "UPDATE people_profile SET purge_at = '1999-01-01T00:00:00.000Z'
                  WHERE party_id = ?1",
                [&jake],
            )?;
            Ok(())
        })
        .expect("the lapse lands");
    let refused = circle.try_run("people.restore_person", json!({ "party_id": jake }));
    assert_eq!(refused.status, CommandStatus::Failed);
    assert_eq!(refused.predicate.as_deref(), Some("person_trashed"));
    assert!(
        refused
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("restore window")),
        "the sentence has to say what happened: {:?}",
        refused.reason
    );
}

#[test]
fn an_undo_applies_once_and_puts_the_old_name_back() {
    let circle = Circle::open("people-undo");
    let ray = circle.person("Grandpa Ray", 7);
    let edit = circle.run(
        "people.edit_person",
        json!({ "party_id": ray, "display_name": "Ray", "role": "Grandfather" }),
    );
    assert_eq!(
        circle.text(&format!(
            "SELECT display_name FROM core_party WHERE party_id = '{ray}'"
        )),
        Some("Ray".to_owned())
    );
    let revision_id = edit["revision_id"].as_str().expect("a revision id");
    circle.run(
        "people.undo_person",
        json!({ "party_id": ray, "revision_id": revision_id }),
    );
    assert_eq!(
        circle.text(&format!(
            "SELECT display_name FROM core_party WHERE party_id = '{ray}'"
        )),
        Some("Grandpa Ray".to_owned())
    );
    // A SNAPSHOT APPLIES ONCE.
    let twice = circle.try_run(
        "people.undo_person",
        json!({ "party_id": ray, "revision_id": revision_id }),
    );
    assert_eq!(twice.status, CommandStatus::Failed);
    assert!(
        twice
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("already been undone")
                || reason.contains("no longer undoable")),
        "{:?}",
        twice.reason
    );
}

#[test]
fn logging_a_touch_stamps_last_contacted_which_is_what_clears_overdue() {
    let circle = Circle::open("people-touch");
    let chris = circle.person("Chris Okafor", 60);
    assert_eq!(
        circle.text(&format!(
            "SELECT last_contacted_at FROM people_profile WHERE party_id = '{chris}'"
        )),
        None
    );
    let logged = circle.run(
        "people.log_interaction",
        json!({ "party_id": chris, "kind": "Met up", "text": "Coffee on the roof." }),
    );
    let interaction = logged["interaction_id"].as_str().expect("an activity id");
    assert!(
        circle
            .text(&format!(
                "SELECT last_contacted_at FROM people_profile WHERE party_id = '{chris}'"
            ))
            .is_some()
    );
    // The activity, the `about` link and the annotation are one gesture.
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM core_link WHERE from_type = 'core.activity'
              AND from_id = '{interaction}' AND to_type = 'core.party'
              AND to_id = '{chris}' AND valid_to IS NULL"
        )),
        1
    );
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM knowledge_annotation
              WHERE target_type = 'core.activity' AND target_id = '{interaction}'"
        )),
        1
    );
    // THE KIND IS A CONCEPT, SLUGGED: "Met up" is `met-up`.
    assert_eq!(
        circle.count(
            "SELECT COUNT(*) FROM core_concept c
               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE s.uri = 'urn:duaility:activity-kinds' AND c.notation = 'met-up'"
        ),
        1
    );
}

#[test]
fn a_list_files_exactly_one_tag_and_refuses_to_delete_while_it_holds_anyone() {
    let circle = Circle::open("people-lists");
    let maya = circle.person("Maya Alvarez", 30);
    let work = circle.run("people.create_list", json!({ "name": "Work" }))["list_id"]
        .as_str()
        .expect("a list id")
        .to_owned();
    let home = circle.run("people.create_list", json!({ "name": "Home" }))["list_id"]
        .as_str()
        .expect("a list id")
        .to_owned();
    // A SECOND "Work" IS A RECEIPTED REFUSAL, not two lists with one name.
    let duplicate = circle.try_run("people.create_list", json!({ "name": "Work" }));
    assert_eq!(duplicate.status, CommandStatus::Failed);
    assert_eq!(duplicate.predicate.as_deref(), Some("name_unused"));

    circle.run(
        "people.move_person",
        json!({ "party_id": maya, "list_id": work }),
    );
    // REFILING IS ONE TAG, never two.
    circle.run(
        "people.move_person",
        json!({ "party_id": maya, "list_id": home }),
    );
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM core_tag t
               JOIN core_concept c ON c.concept_id = t.concept_id
               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE t.target_type = 'core.party' AND t.target_id = '{maya}'
                AND s.uri = 'https://centraid.dev/schemes/lists'"
        )),
        1
    );
    // A LIST THAT STILL HOLDS SOMEBODY DOES NOT DELETE, and the sentence says
    // what to do instead.
    let held = circle.try_run("people.delete_list", json!({ "list_id": home }));
    assert_eq!(held.status, CommandStatus::Failed);
    assert_eq!(
        held.reason.as_deref(),
        Some("This list still has people in it — move them out first.")
    );
    // An omitted list un-lists.
    circle.run("people.move_person", json!({ "party_id": maya }));
    circle.run("people.delete_list", json!({ "list_id": home }));
    circle.run("people.delete_list", json!({ "list_id": work }));
}

#[test]
fn the_star_is_one_flags_scheme_tag_on_the_party_and_starring_twice_is_one_star() {
    let circle = Circle::open("people-star");
    let ray = circle.person("Grandpa Ray", 7);
    circle.run("people.star_person", json!({ "party_id": ray }));
    circle.run("people.star_person", json!({ "party_id": ray }));
    let starred = |circle: &Circle| {
        circle.count(&format!(
            "SELECT COUNT(*) FROM core_tag t
               JOIN core_concept c ON c.concept_id = t.concept_id
               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE t.target_type = 'core.party' AND t.target_id = '{ray}'
                AND s.uri = 'https://centraid.dev/schemes/flags'
                AND c.notation = 'starred'"
        ))
    };
    assert_eq!(starred(&circle), 1, "starring twice is one star");
    circle.run("people.unstar_person", json!({ "party_id": ray }));
    assert_eq!(starred(&circle), 0);
    // Unstarring twice is still unstarred.
    circle.run("people.unstar_person", json!({ "party_id": ray }));
    assert_eq!(starred(&circle), 0);
}

#[test]
fn a_birthday_auto_reminds_and_writes_through_to_the_party_spine() {
    let circle = Circle::open("people-birthday");
    let ray = circle.person("Grandpa Ray", 7);
    // A BIRTHDAY AUTO-CREATES ITS REMINDER even when the caller does not ask.
    let birthday = circle.run(
        "people.add_important_date",
        json!({ "party_id": ray, "label": "Birthday", "month_day": "08-14" }),
    );
    let date_id = birthday["date_id"].as_str().expect("a date id");
    assert_eq!(
        circle.count(&format!(
            "SELECT reminder_on FROM people_important_date WHERE date_id = '{date_id}'"
        )),
        1
    );
    // ONE LOGICAL FACT: the party's own birth date agrees, year-less.
    assert_eq!(
        circle.text(&format!(
            "SELECT birth_date FROM core_party WHERE party_id = '{ray}'"
        )),
        Some("--08-14".to_owned())
    );
    // Another date does NOT auto-remind.
    let anniversary = circle.run(
        "people.add_important_date",
        json!({ "party_id": ray, "label": "Anniversary", "month_day": "03-02" }),
    );
    let other = anniversary["date_id"].as_str().expect("a date id");
    assert_eq!(
        circle.count(&format!(
            "SELECT reminder_on FROM people_important_date WHERE date_id = '{other}'"
        )),
        0
    );
    // The toggle flips it, and back.
    circle.run("people.toggle_reminder", json!({ "date_id": other }));
    assert_eq!(
        circle.count(&format!(
            "SELECT reminder_on FROM people_important_date WHERE date_id = '{other}'"
        )),
        1
    );

    // FEBRUARY 31 IS REFUSED BY THE CONDITION, not by a private calendar.
    let unreal = circle.try_run(
        "people.add_important_date",
        json!({ "party_id": ray, "label": "Odd", "month_day": "02-31" }),
    );
    assert_eq!(unreal.status, CommandStatus::Failed);
    assert_eq!(unreal.predicate.as_deref(), Some("month_day_is_a_real_day"));
    // AND A LEAP DAY IS NOT: 29 February exists.
    circle.run(
        "people.add_important_date",
        json!({ "party_id": ray, "label": "Leap", "month_day": "02-29" }),
    );
}

#[test]
fn a_second_birthday_row_is_kept_in_step_so_no_two_surfaces_disagree() {
    let circle = Circle::open("people-birthday-single");
    let ray = circle.person("Grandpa Ray", 7);
    let first = circle.run(
        "people.add_important_date",
        json!({ "party_id": ray, "label": "Birthday", "month_day": "08-14" }),
    )["date_id"]
        .as_str()
        .expect("a date id")
        .to_owned();
    circle.run(
        "people.add_important_date",
        json!({ "party_id": ray, "label": "His birthday", "month_day": "09-01" }),
    );
    // BOTH ROWS NOW SAY 09-01, and so does the party.
    assert_eq!(
        circle.text(&format!(
            "SELECT month_day FROM people_important_date WHERE date_id = '{first}'"
        )),
        Some("09-01".to_owned())
    );
    assert_eq!(
        circle.text(&format!(
            "SELECT birth_date FROM core_party WHERE party_id = '{ray}'"
        )),
        Some("--09-01".to_owned())
    );
}

#[test]
fn a_gift_is_a_task_under_the_gift_for_relation_and_a_task_is_not() {
    let circle = Circle::open("people-gifts");
    let ray = circle.person("Grandpa Ray", 7);
    let gift = circle.run(
        "people.add_gift",
        json!({ "party_id": ray, "text": "Large-print Lonesome Dove" }),
    )["gift_id"]
        .as_str()
        .expect("a gift id")
        .to_owned();
    let task = circle.run(
        "people.add_task",
        json!({ "party_id": ray, "text": "Call about the cribbage board" }),
    )["task_id"]
        .as_str()
        .expect("a task id")
        .to_owned();
    let relation_of = |id: &str| {
        circle.text(&format!(
            "SELECT c.notation FROM core_link l
               JOIN core_concept c ON c.concept_id = l.relation_concept_id
              WHERE l.from_type = 'schedule.task' AND l.from_id = '{id}'"
        ))
    };
    assert_eq!(relation_of(&gift), Some("gift-for".to_owned()));
    assert_eq!(relation_of(&task), Some("about".to_owned()));
    // The gift toggles; the TASK is not a gift and `toggle_gift` refuses it.
    circle.run("people.toggle_gift", json!({ "gift_id": gift }));
    assert_eq!(
        circle.text(&format!(
            "SELECT status FROM schedule_task WHERE task_id = '{gift}'"
        )),
        Some("completed".to_owned())
    );
    let not_a_gift = circle.try_run("people.toggle_gift", json!({ "gift_id": task }));
    assert_eq!(not_a_gift.status, CommandStatus::Failed);
    assert_eq!(not_a_gift.predicate.as_deref(), Some("gift_exists"));

    // Completing and reopening the task is the lifecycle, and completing twice
    // keeps the first stamp.
    circle.run("people.complete_task", json!({ "task_id": task }));
    let stamp = circle.text(&format!(
        "SELECT completed_at FROM schedule_task WHERE task_id = '{task}'"
    ));
    circle.run("people.complete_task", json!({ "task_id": task }));
    assert_eq!(
        circle.text(&format!(
            "SELECT completed_at FROM schedule_task WHERE task_id = '{task}'"
        )),
        stamp,
        "a second completion is not a second stamp"
    );
    circle.run("people.reopen_task", json!({ "task_id": task }));
    assert_eq!(
        circle.text(&format!(
            "SELECT completed_at FROM schedule_task WHERE task_id = '{task}'"
        )),
        None
    );
}

/// D-1020-PE9: the recurrence rollover is `schedule`'s, and the refusal says so
/// rather than dropping the successor silently — which is the ONT-27 bug People's
/// own `toggle_task` had.
#[test]
fn the_recurring_rollover_is_the_schedule_slots_and_the_refusal_names_it() {
    let circle = Circle::open("people-series");
    let ray = circle.person("Grandpa Ray", 7);
    let task = circle.run(
        "people.add_task",
        json!({ "party_id": ray, "text": "Ring Grandpa" }),
    )["task_id"]
        .as_str()
        .expect("a task id")
        .to_owned();
    circle
        .vault()
        .commit(|tx| {
            tx.set_producer("test.recurring");
            tx.connection().execute(
                "UPDATE schedule_task SET rrule = 'FREQ=WEEKLY', due_at = '2099-06-01T09:00:00.000Z'
                  WHERE task_id = ?1",
                [&task],
            )?;
            Ok(())
        })
        .expect("the rrule lands");
    let refused = circle.try_run("people.complete_task", json!({ "task_id": task }));
    assert_eq!(refused.status, CommandStatus::Failed);
    assert_eq!(refused.predicate.as_deref(), Some("task_is_not_a_series"));
    assert!(
        refused
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("schedule.organize_task")),
        "the refusal has to name the way through: {:?}",
        refused.reason
    );
    // AND THE TASK IS UNTOUCHED. A refusal that half-completed would be worse
    // than the bug it replaces.
    assert_eq!(
        circle.text(&format!(
            "SELECT status FROM schedule_task WHERE task_id = '{task}'"
        )),
        Some("needs-action".to_owned())
    );
}

#[test]
fn a_debt_makes_a_tally_friend_and_settling_closes_rather_than_deletes() {
    let circle = Circle::open("people-debt");
    let jake = circle.person("Jake Bennett", 45);
    let owner = circle.owner_party_id();
    let debt = circle.run(
        "people.add_debt",
        json!({
            "party_id": jake,
            "direction": "owe",
            "amount_minor": 15_000,
            "reason": "His half of the cabin deposit"
        }),
    )["debt_id"]
        .as_str()
        .expect("a debt id")
        .to_owned();
    // THE DIRECTION IS THE OWNER'S OWN SIDE.
    assert_eq!(
        circle.text(&format!(
            "SELECT from_party FROM tally_obligation WHERE obligation_id = '{debt}'"
        )),
        Some(owner.clone())
    );
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM tally_friend WHERE party_id = '{jake}'"
        )),
        1,
        "a debt makes them a Tally friend, once"
    );
    circle.run(
        "people.add_debt",
        json!({ "party_id": jake, "direction": "owed", "amount_minor": 500 }),
    );
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM tally_friend WHERE party_id = '{jake}'"
        )),
        1,
        "and the friend row is unique per party"
    );
    circle.run("people.settle_debt", json!({ "debt_id": debt }));
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM tally_obligation WHERE obligation_id = '{debt}'"
        )),
        1,
        "closed, not deleted: a settled debt stays as history"
    );
    // Settling twice is refused, because the debt is no longer open.
    let again = circle.try_run("people.settle_debt", json!({ "debt_id": debt }));
    assert_eq!(again.status, CommandStatus::Failed);
    assert_eq!(again.predicate.as_deref(), Some("debt_open"));
    // AND THE OWNER CANNOT OWE THEMSELVES.
    let self_debt = circle.try_run(
        "people.add_debt",
        json!({ "party_id": owner, "direction": "owe", "amount_minor": 100 }),
    );
    assert_eq!(self_debt.status, CommandStatus::Failed);
}

#[test]
fn a_journal_entry_is_a_marked_note_with_its_own_day() {
    let circle = Circle::open("people-journal");
    let entry = circle.run(
        "people.add_journal_entry",
        json!({ "mood": "Quiet", "text": "Long walk, nobody to call.", "entry_date": "2099-05-04" }),
    )["entry_id"]
        .as_str()
        .expect("an entry id")
        .to_owned();
    assert_eq!(
        circle.text(&format!(
            "SELECT title FROM knowledge_note WHERE note_id = '{entry}'"
        )),
        Some("People journal · Quiet".to_owned())
    );
    // THE ENTRY'S OWN DAY, at noon, so it sorts where the member put it.
    assert_eq!(
        circle.text(&format!(
            "SELECT created_at FROM knowledge_note WHERE note_id = '{entry}'"
        )),
        Some("2099-05-04T12:00:00.000Z".to_owned())
    );
    // THE MARKER IS WHAT MAKES IT A JOURNAL ENTRY.
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM core_tag t
               JOIN core_concept c ON c.concept_id = t.concept_id
               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE t.target_id = '{entry}' AND t.target_type = 'knowledge.note'
                AND s.uri = 'https://centraid.dev/schemes/people-journal'
                AND c.notation = 'entry'"
        )),
        1
    );
    // And the body is readable text, which is what the FTS row is taken from.
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM core_content_text ct
               JOIN knowledge_note n ON n.body_content_id = ct.content_id
              WHERE n.note_id = '{entry}' AND ct.body_text LIKE 'Long walk%'"
        )),
        1
    );
}

#[test]
fn a_contact_channel_normalises_once_and_a_duplicate_value_is_reported_not_merged() {
    let circle = Circle::open("people-channels");
    let maya = circle.person("Maya Alvarez", 30);
    let jake = circle.person("Jake Bennett", 45);
    let saved = circle.run(
        "people.save_contact_channel",
        json!({
            "party_id": maya,
            "kind": "phone",
            "value": "+1 (415) 555-0100",
            "label": "mobile",
            "preferred": true
        }),
    );
    assert_eq!(saved["normalized_value"], json!("+14155550100"));
    assert_eq!(saved["duplicate_party_ids"], json!([]));
    let channel = saved["channel_id"]
        .as_str()
        .expect("a channel id")
        .to_owned();

    // THE SAME NUMBER ON SOMEBODY ELSE IS REPORTED, NEVER MERGED. A merge is
    // `core.merge_party`'s and nothing else's.
    let collided = circle.run(
        "people.save_contact_channel",
        json!({ "party_id": jake, "kind": "phone", "value": "+1 415 555 0100" }),
    );
    assert_eq!(collided["duplicate_party_ids"], json!([maya.clone()]));

    // THE SAME NUMBER TWICE ON ONE PERSON IS A REFUSAL.
    let twice = circle.try_run(
        "people.save_contact_channel",
        json!({ "party_id": maya, "kind": "phone", "value": "+14155550100" }),
    );
    assert_eq!(twice.status, CommandStatus::Failed);
    assert_eq!(
        twice.reason.as_deref(),
        Some("this contact channel is already saved")
    );

    // A MALFORMED NUMBER IS A SENTENCE, not a constraint message.
    let short = circle.try_run(
        "people.save_contact_channel",
        json!({ "party_id": maya, "kind": "phone", "value": "12345" }),
    );
    assert_eq!(short.status, CommandStatus::Failed);
    assert!(
        short
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("7 to 15 digits")),
        "{:?}",
        short.reason
    );

    // DELETE THEN UNDO restores the row, once.
    let deleted = circle.run(
        "people.delete_contact_channel",
        json!({ "channel_id": channel }),
    );
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM social_contact_channel WHERE channel_id = '{channel}'"
        )),
        0
    );
    circle.run(
        "people.undo_contact_channel",
        json!({ "channel_id": channel, "revision_id": deleted["revision_id"] }),
    );
    assert_eq!(
        circle.text(&format!(
            "SELECT value FROM social_contact_channel WHERE channel_id = '{channel}'"
        )),
        Some("+1 (415) 555-0100".to_owned()),
        "the undo puts the member's own spelling back, not the normalised key"
    );
}

#[test]
fn a_relationship_reuses_a_party_of_that_name_and_a_pet_is_an_animal() {
    let circle = Circle::open("people-relations");
    let ray = circle.person("Grandpa Ray", 7);
    circle.run(
        "people.add_relationship",
        json!({ "party_id": ray, "name": "Edith", "kind": "Wife" }),
    );
    // A SECOND RELATION TO THE SAME NAME REUSES THE PARTY.
    circle.run(
        "people.add_relationship",
        json!({ "party_id": ray, "name": "edith", "kind": "Partner" }),
    );
    assert_eq!(
        circle.count("SELECT COUNT(*) FROM core_party WHERE display_name = 'Edith'"),
        1,
        "two 'Edith's is how a vault grows a duplicate nobody meant"
    );
    circle.run(
        "people.add_relationship",
        json!({ "party_id": ray, "name": "Biscuit", "kind": "Pet", "pet": "Dog" }),
    );
    assert_eq!(
        circle.text("SELECT kind FROM core_party WHERE display_name = 'Biscuit'"),
        Some("animal".to_owned())
    );
    assert_eq!(
        circle.count(
            "SELECT COUNT(*) FROM core_concept c
               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE s.uri = 'urn:duaility:relations' AND c.notation = 'people-pet-dog'"
        ),
        1
    );
}

// ---------------------------------------------------------------------------
// D-1020-PE3 — the fourteen `once` commands, replayed.
// ---------------------------------------------------------------------------

/// EVERY `once` COMMAND REPLAYS FROM THE LEDGER, and a replay executes nothing.
///
/// The check is per command rather than one sample, because "once" is a
/// property of the definition and a port can get it right for the one command
/// somebody tested. The state the replay must not change is measured as the row
/// count of every table People writes, before and after.
#[test]
fn a_replayed_once_command_executes_nothing_a_second_time() {
    let circle = Circle::open("people-replay");
    let maya = circle.person("Maya Alvarez", 30);
    let ray = circle.person("Grandpa Ray", 7);
    let list = circle.run("people.create_list", json!({ "name": "Family" }))["list_id"]
        .as_str()
        .expect("a list id")
        .to_owned();
    let channel = circle.run(
        "people.save_contact_channel",
        json!({ "party_id": maya, "kind": "email", "value": "maya@example.com" }),
    )["channel_id"]
        .as_str()
        .expect("a channel id")
        .to_owned();
    let edit = circle.run(
        "people.edit_person",
        json!({ "party_id": ray, "role": "Grandfather" }),
    );

    // THE FOURTEEN, each with an input that executes cleanly the first time.
    let cases: Vec<(&str, Value)> = vec![
        (
            "people.add_person",
            json!({ "display_name": "Replay Once", "cadence_days": 14 }),
        ),
        ("people.trash_person", json!({ "party_id": maya })),
        (
            "people.undo_person",
            json!({ "party_id": ray, "revision_id": edit["revision_id"] }),
        ),
        (
            "people.log_interaction",
            json!({ "party_id": ray, "kind": "Call", "text": "Sunday" }),
        ),
        (
            "people.add_note",
            json!({ "party_id": ray, "text": "Beat me at cribbage twice." }),
        ),
        (
            "people.add_task",
            json!({ "party_id": ray, "text": "Post the photographs" }),
        ),
        (
            "people.add_important_date",
            json!({ "party_id": ray, "label": "Birthday", "month_day": "08-14" }),
        ),
        (
            "people.add_relationship",
            json!({ "party_id": ray, "name": "Edith", "kind": "Wife" }),
        ),
        (
            "people.add_gift",
            json!({ "party_id": ray, "text": "Fountain pen ink" }),
        ),
        (
            "people.add_debt",
            json!({ "party_id": ray, "direction": "owed", "amount_minor": 1_250 }),
        ),
        ("people.create_list", json!({ "name": "Replay List" })),
        (
            "people.add_journal_entry",
            json!({ "mood": "Tired", "text": "Nothing happened." }),
        ),
        (
            "people.delete_contact_channel",
            json!({ "channel_id": channel }),
        ),
        (
            "people.undo_contact_channel",
            json!({ "channel_id": channel }),
        ),
    ];
    // The list exists so `move_person` below has somewhere to file to; it is
    // `idempotent`, not `once`, and is deliberately not in the table.
    drop(list);

    let once: Vec<&str> = cases.iter().map(|(name, _)| *name).collect();
    assert_eq!(
        once.len(),
        14,
        "the census's split is 14 idempotent / 14 once; every `once` command is replayed here"
    );

    for (command, input) in cases {
        let intent = format!("replay:{command}");
        let first = circle.run_with_intent(command, input.clone(), &intent);
        assert_eq!(
            first.status,
            CommandStatus::Executed,
            "`{command}` refused: {:?} / {:?}",
            first.predicate,
            first.reason
        );
        assert!(!first.replayed);
        let before = circle.count("SELECT COUNT(*) FROM agent_command_invocation");
        let rows = circle.count("SELECT COUNT(*) FROM core_entity");
        let second = circle.run_with_intent(command, input, &intent);
        // ANSWERED FROM THE LEDGER: the handler did not run again.
        assert!(
            second.replayed,
            "`{command}` ran a second time under one intent id"
        );
        assert_eq!(
            circle.count("SELECT COUNT(*) FROM agent_command_invocation"),
            before,
            "`{command}`'s replay wrote a second invocation row"
        );
        assert_eq!(
            circle.count("SELECT COUNT(*) FROM core_entity"),
            rows,
            "`{command}`'s replay minted a second entity"
        );
    }
}

/// AND THE FOURTEEN `idempotent` ONES ARE SAFE TO RUN TWICE WITHOUT AN INTENT
/// ID, which is the other half of the split: no ledger, same state.
#[test]
fn an_idempotent_command_run_twice_lands_the_same_state() {
    let circle = Circle::open("people-idempotent");
    let ray = circle.person("Grandpa Ray", 7);
    let list = circle.run("people.create_list", json!({ "name": "Family" }))["list_id"]
        .as_str()
        .expect("a list id")
        .to_owned();
    let cases: Vec<(&str, Value)> = vec![
        (
            "people.edit_person",
            json!({ "party_id": ray, "role": "Grandfather" }),
        ),
        (
            "people.set_cadence",
            json!({ "party_id": ray, "cadence_days": 14 }),
        ),
        ("people.star_person", json!({ "party_id": ray })),
        ("people.unstar_person", json!({ "party_id": ray })),
        (
            "people.move_person",
            json!({ "party_id": ray, "list_id": list }),
        ),
        (
            "people.rename_list",
            json!({ "list_id": list, "name": "Kin" }),
        ),
    ];
    for (command, input) in cases {
        circle.run(command, input.clone());
        let tags = circle.count(&format!(
            "SELECT COUNT(*) FROM core_tag WHERE target_id = '{ray}'"
        ));
        circle.run(command, input);
        assert_eq!(
            circle.count(&format!(
                "SELECT COUNT(*) FROM core_tag WHERE target_id = '{ray}'"
            )),
            tags,
            "`{command}` run twice changed the tag count"
        );
    }
}

// ---------------------------------------------------------------------------
// D-1020-PE2 — the merge, and the generated FK sweep.
// ---------------------------------------------------------------------------

/// THE SWEEP, MEASURED. The number is asserted so a migration that adds a
/// column referencing `core_party` shows up here as a failing count rather than
/// as a merge that quietly misses it.
#[test]
fn the_sweep_is_generated_from_the_live_schema_and_covers_three_kinds_of_pointer() {
    let circle = Circle::open("sweep-shape");
    let sweep = circle
        .vault()
        .read(merge_party_sweep)
        .expect("the sweep reads the schema");

    let engine = sweep
        .iter()
        .filter(|reference| reference.type_column.is_none() && reference.predicate.is_none())
        .count();
    let polymorphic = sweep
        .iter()
        .filter(|reference| reference.type_column.is_some())
        .count();
    let hand_kept = sweep
        .iter()
        .filter(|reference| reference.predicate.is_some())
        .count();

    // Forty-four engine foreign keys onto `core_party` in the committed DDL
    // (`grep -c 'REFERENCES core_party' contracts/migrations/001_baseline.sql`).
    assert_eq!(engine, 44, "the engine FK walk found a different set");
    // FIFTEEN `(type, id)` pairs over fourteen tables — `core_link` carries
    // two, its from- and to- endpoints.
    //
    // **v0's registry lists fourteen pairs over thirteen tables and omits
    // `core_content_representation.(owner_type, owner_id)`** (finding PE-F5):
    // `schema/entity-refs.ts`'s `ENTITY_POINTERS` predates #996 R20(b)'s
    // representation table, and v0's merge walks that list. The column carries
    // `ON DELETE CASCADE`, so in v0 a merge DELETES a party's representation
    // instead of re-pointing it. This sweep reads the schema, so it finds it.
    assert_eq!(polymorphic, 15, "the polymorphic pointer set moved");
    // ONE pointer the engine cannot see: `share_authority.principal_id`.
    assert_eq!(hand_kept, 1);
    assert_eq!(sweep.len(), 60);
    assert!(
        sweep
            .iter()
            .any(|reference| reference.table == "core_content_representation"
                && reference.column == "owner_id"),
        "the pointer v0's registry omits has to be in the generated sweep"
    );

    // The composite key is read WHOLE (#916 review 2.1): `tally_expense_split`
    // is keyed on two columns and a one-column key there is how a merge
    // rewrote every split of an expense.
    let split = sweep
        .iter()
        .find(|reference| {
            reference.table == "tally_expense_split" && reference.column == "party_id"
        })
        .expect("the split's party column is in the sweep");
    assert_eq!(
        split.key,
        vec!["expense_id".to_owned(), "party_id".to_owned()]
    );
}

/// THE MECHANICAL SWEEP (AGENTS.md): no column in the file whose NAME reads as
/// a party pointer is outside the generated set.
///
/// This is the test that would have caught `share_authority.principal_id` before
/// somebody remembered it, and it is what makes the hand-kept list auditable
/// rather than trusted.
#[test]
fn no_column_that_names_a_party_is_outside_the_sweep() {
    let circle = Circle::open("sweep-audit");
    let (sweep, candidates) = circle
        .vault()
        .read(|connection| {
            let sweep = merge_party_sweep(connection)?;
            let mut candidates: Vec<(String, String)> = Vec::new();
            let mut tables = connection.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table'
                   AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
                   AND name NOT LIKE 'fts_%' ORDER BY name",
            )?;
            let names: Vec<String> = tables
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<String>, _>>()?;
            drop(tables);
            for table in names {
                if table == "core_party" {
                    continue;
                }
                let mut columns = connection.prepare("SELECT name FROM pragma_table_info(?1)")?;
                let found: Vec<String> = columns
                    .query_map([&table], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<String>, _>>()?;
                for column in found {
                    let looks_like_a_party = column == "party_id"
                        || column.ends_with("_party_id")
                        || column.ends_with("_party")
                        || column == "principal_id";
                    if looks_like_a_party {
                        candidates.push((table.clone(), column));
                    }
                }
            }
            Ok((sweep, candidates))
        })
        .expect("the audit reads the schema");

    let missing: Vec<String> = candidates
        .iter()
        .filter(|(table, column)| {
            !sweep
                .iter()
                .any(|reference| &reference.table == table && &reference.column == column)
                && !NOT_A_PARTY_POINTER
                    .iter()
                    .any(|(known, held)| known == table && held == column)
        })
        .map(|(table, column)| format!("{table}.{column}"))
        .collect();
    assert!(
        missing.is_empty(),
        "these columns name a party and no walk re-points them: {missing:?}"
    );
    // A floor, so a scan that suddenly matches nothing fails rather than
    // passing vacuously. It is BELOW the sweep's 44 engine columns on purpose:
    // the audit matches on NAME and four of those columns are called `paid_by`,
    // `granted_by`, `from_party` and `to_party` — which is itself the reason a
    // name-shaped audit cannot be the only check, and why the sweep is
    // generated from foreign keys rather than from names.
    assert!(
        candidates.len() >= 40,
        "the audit found only {} candidate columns",
        candidates.len()
    );
}

/// THE FK SWEEP, PROVEN: a reference in EVERY referencing column the sweep
/// names, and **zero survivors** after the merge.
///
/// The planting is generated from the sweep itself rather than typed, which is
/// the whole point — a typed fixture proves the sweep covers the columns whoever
/// typed it remembered. Where a column cannot be planted because its table's
/// other constraints refuse a fabricated row, the test records it and asserts
/// the SET of unplantable columns rather than skipping quietly.
#[test]
fn the_merge_leaves_no_row_naming_the_folded_in_party() {
    let circle = Circle::open("merge-sweep");
    let survivor = circle.person("Grandpa Ray", 7);
    let merged = circle.person("Ray Grandpa", 30);

    // A CORPUS THROUGH THE REAL COMMANDS, so the rows are the ones a member's
    // vault actually holds: notes, a task, a gift, a birthday, an interaction,
    // two debts, a list, a star and two channels on each side.
    for party in [&survivor, &merged] {
        circle.run(
            "people.log_interaction",
            json!({ "party_id": party, "kind": "Call", "text": "Chat" }),
        );
        circle.run(
            "people.add_note",
            json!({ "party_id": party, "text": "A note" }),
        );
        circle.run(
            "people.add_task",
            json!({ "party_id": party, "text": "A task" }),
        );
        circle.run(
            "people.add_gift",
            json!({ "party_id": party, "text": "A gift" }),
        );
        circle.run(
            "people.add_important_date",
            json!({ "party_id": party, "label": "Birthday", "month_day": "08-14" }),
        );
        circle.run(
            "people.add_debt",
            json!({ "party_id": party, "direction": "owe", "amount_minor": 900 }),
        );
        circle.run("people.star_person", json!({ "party_id": party }));
        circle.run(
            "people.save_contact_channel",
            json!({ "party_id": party, "kind": "email", "value": format!("{party}@example.com") }),
        );
    }
    // THE COLLIDING CASE: both sides hold the SAME phone number, so the
    // re-point hits `UNIQUE (party_id, kind, normalized_value)` and the demote
    // policy is what answers it.
    for party in [&survivor, &merged] {
        circle.run(
            "people.save_contact_channel",
            json!({ "party_id": party, "kind": "phone", "value": "+14155550100", "preferred": true }),
        );
    }

    // NOW PLANT A REFERENCE IN EVERY REMAINING REFERENCING COLUMN, GENERATED
    // FROM THE SWEEP.
    //
    // A corpus written through the real commands reaches fifteen of the sixty
    // columns, which is what a member's vault actually holds — and fifteen of
    // sixty is a fixture that proves the sweep covers the columns somebody
    // remembered. So the rest are planted by a row builder that reads each
    // table's own columns and fills them: the party column with the merged id,
    // a polymorphic type column with `core.party`, and every remaining NOT NULL
    // column with a value of its declared type.
    //
    // **The plant runs with `foreign_keys` and CHECK enforcement OFF, and the
    // MERGE runs with both back on.** A fabricated row exists to prove the
    // sweep's REACH, and it cannot satisfy an enum CHECK or a parent row it has
    // no business inventing; the behaviour under real enforcement is what
    // `folding_two_sharers_of_one_expense_adds_their_shares_rather_than_dropping_one`
    // and `folding_both_ends_of_a_debt_drops_it_as_degenerate_rather_than_failing`
    // prove, on rows the schema accepted.
    let sweep = circle
        .vault()
        .read(merge_party_sweep)
        .expect("the sweep reads the schema");
    let mut planted: Vec<String> = Vec::new();
    let mut unplantable: Vec<String> = Vec::new();
    let mut refused_by_the_merge: Vec<String> = Vec::new();
    for reference in &sweep {
        let table = reference.table.clone();
        let column = reference.column.clone();
        // ONE COLUMN CANNOT BE PLANTED AND STILL LEAVE A LEGAL MERGE:
        // `core_vault.self_party_id` is what makes a party THE OWNER, and the
        // owner is not mergeable away. Planting it is a different test — the
        // refusal — and it has one:
        // `the_owner_cannot_be_merged_away_and_nobody_merges_into_themselves`.
        if table == "core_vault" && column == "self_party_id" {
            refused_by_the_merge.push(format!("{table}.{column}"));
            continue;
        }
        let type_column = reference.type_column.clone();
        let predicate = reference.predicate.clone();
        let merged_id = merged.clone();
        let held = circle.count(&format!(
            "SELECT COUNT(*) FROM \"{table}\" WHERE \"{column}\" = '{merged_id}'"
        ));
        if held > 0 {
            planted.push(format!("{table}.{column}"));
            continue;
        }
        // THE PLANT RUNS ON ITS OWN CONNECTION, OUTSIDE THE VAULT'S GUARD.
        // `PRAGMA foreign_keys` is a **no-op inside a transaction**, and
        // `Vault::commit` opens one — so a fabricated row written through the
        // vault would be refused by a parent it has no business inventing. The
        // rows are written straight to the file instead, which is where the
        // merge reads them from; they are deliberately NOT in the commit log,
        // because a fixture proving a sweep's reach is not a member's write.
        let outcome = (|| -> rusqlite::Result<()> {
            let connection = rusqlite::Connection::open(circle.scratch.join("vault.db"))?;
            connection.execute_batch(
                "PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;",
            )?;
            let fields: Vec<(String, String, i64, Option<String>, i64)> = {
                // `table_info`, not `table_xinfo`: a generated column is not a
                // column an INSERT may name.
                let mut columns = connection.prepare(
                    "SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?1)",
                )?;
                let rows = columns.query_map([&table], |row| {
                    Ok((
                        row.get(0)?,
                        row.get::<_, String>(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let mut names: Vec<String> = Vec::new();
            let mut values: Vec<String> = Vec::new();
            for (name, declared, not_null, default, pk) in fields {
                let value = if name == column {
                    format!("'{merged_id}'")
                } else if Some(&name) == type_column.as_ref() {
                    "'core.party'".to_owned()
                } else if pk > 0 || (not_null == 1 && default.is_none()) {
                    match declared.to_uppercase().as_str() {
                        "INTEGER" | "INT" => "1".to_owned(),
                        "REAL" => "1.0".to_owned(),
                        "BLOB" => "x''".to_owned(),
                        // A TEXT value distinct per (table, filled column,
                        // PLANTED column), so two plants into one table — and
                        // there are five such tables, `core_account` and
                        // `tally_settlement` among them — cannot collide on a
                        // primary key or on a UNIQUE.
                        _ => format!("'plant-{table}-{name}-{column}'"),
                    }
                } else {
                    continue;
                };
                names.push(format!("\"{name}\""));
                values.push(value);
            }
            // A hand-kept pointer's predicate has to hold, or the sweep's own
            // `WHERE` would not see the row it just planted.
            if let Some(scope) = predicate.as_deref()
                && let Some((left, right)) = scope.split_once('=')
            {
                let field = format!("\"{}\"", left.trim());
                let literal = right.trim().to_owned();
                if let Some(at) = names.iter().position(|name| name == &field) {
                    values[at] = literal;
                } else {
                    names.push(field);
                    values.push(literal);
                }
            }
            connection.execute(
                &format!(
                    "INSERT INTO \"{table}\" ({}) VALUES ({})",
                    names.join(", "),
                    values.join(", ")
                ),
                [],
            )?;
            Ok(())
        })();
        let now = circle.count(&format!(
            "SELECT COUNT(*) FROM \"{table}\" WHERE \"{column}\" = '{merged_id}'"
        ));
        if outcome.is_ok() && now > 0 {
            planted.push(format!("{table}.{column}"));
        } else {
            unplantable.push(format!("{table}.{column}"));
        }
    }

    // EVERY REFERENCING COLUMN THE SWEEP NAMES NOW HOLDS A REFERENCE. The
    // number is asserted rather than described, so a column the builder stops
    // reaching is a failure and not a quieter fixture.
    assert!(
        unplantable.is_empty(),
        "these referencing columns could not be planted, so the sweep is unproven over them: {unplantable:?}"
    );
    assert_eq!(
        refused_by_the_merge,
        ["core_vault.self_party_id"],
        "exactly one referencing column is excluded, and the reason is in the loop"
    );
    assert_eq!(planted.len() + refused_by_the_merge.len(), sweep.len());
    assert_eq!(planted.len(), 59);

    // THE MERGE.
    let output = circle.run(
        "core.merge_party",
        json!({ "survivor_party_id": survivor, "merged_party_id": merged }),
    );
    assert!(output["repointed"].as_u64().unwrap_or_default() > 0);

    // ZERO SURVIVORS, over every column the sweep names.
    let mut left_behind: Vec<String> = Vec::new();
    for reference in &sweep {
        let mut predicate = format!("\"{}\" = '{merged}'", reference.column);
        if let Some(type_column) = reference.type_column.as_deref() {
            predicate.push_str(&format!(" AND \"{type_column}\" = 'core.party'"));
        }
        let remaining = circle.count(&format!(
            "SELECT COUNT(*) FROM \"{}\" WHERE {predicate}",
            reference.table
        ));
        if remaining > 0 {
            left_behind.push(format!(
                "{}.{} ({remaining} row(s))",
                reference.table, reference.column
            ));
        }
    }
    assert!(
        left_behind.is_empty(),
        "these columns still name the folded-in party: {left_behind:?}"
    );
    // AND THE MERGED PARTY IS GONE.
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM core_party WHERE party_id = '{merged}'"
        )),
        0
    );
    // The survivor keeps ONE profile, and the fold took the better cadence.
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM people_profile WHERE party_id = '{survivor}'"
        )),
        1
    );
    // ONE PREFERRED PHONE, not two: the colliding channel demoted rather than
    // being deleted, or was dropped as a genuine duplicate — either way the
    // survivor holds exactly one row for that number.
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM social_contact_channel
              WHERE party_id = '{survivor}' AND kind = 'phone'
                AND normalized_value = '+14155550100'"
        )),
        1
    );
}

/// A SHARE IS A NUMBER AND IT ADDS (#916, review 2.1). This is the case that
/// used to destroy money: two people on one bill, folded together.
#[test]
fn folding_two_sharers_of_one_expense_adds_their_shares_rather_than_dropping_one() {
    let circle = Circle::open("merge-money");
    let survivor = circle.person("Maya Alvarez", 30);
    let merged = circle.person("M. Alvarez", 30);
    let owner = circle.owner_party_id();

    // One expense, three splits: the owner's and both sides' — written directly
    // because `tally.*` is another lane's command surface and this test is
    // about the FOLD, not about how the expense got there.
    circle
        .vault()
        .commit(|tx| {
            tx.set_producer("test.expense");
            let connection = tx.connection();
            connection.execute(
                "INSERT INTO social_circle (circle_id, owner_party_id, name, kind, created_at)
                 VALUES ('c1', ?1, 'Trip', 'friends', '2099-01-01T00:00:00.000Z')",
                [&owner],
            )?;
            connection.execute(
                "INSERT INTO tally_group (group_id, circle_id, icon, color, currency, created_at)
                 VALUES ('g1', 'c1', '🏔', 'violet', 'GBP', '2099-01-01T00:00:00.000Z')",
                [],
            )?;
            connection.execute(
                "INSERT INTO tally_expense (expense_id, group_id, description, amount_minor,
                   currency, paid_by, split_method, spent_on, category, created_at)
                 VALUES ('e1', 'g1', 'Cabin', 90000, 'GBP', ?1, 'equally', '2099-01-02',
                         'travel', '2099-01-02T00:00:00.000Z')",
                [&owner],
            )?;
            for (party, share) in [(&owner, 30000), (&survivor, 30000), (&merged, 30000)] {
                connection.execute(
                    "INSERT INTO tally_expense_split (expense_id, party_id, share_minor)
                     VALUES ('e1', ?1, ?2)",
                    rusqlite::params![party, share],
                )?;
            }
            Ok(())
        })
        .expect("the expense lands");

    let total_before: i64 = circle.count("SELECT SUM(share_minor) FROM tally_expense_split");
    assert_eq!(total_before, 90_000);

    let output = circle.run(
        "core.merge_party",
        json!({ "survivor_party_id": survivor, "merged_party_id": merged }),
    );
    assert_eq!(
        output["summed"].as_u64().unwrap_or_default(),
        1,
        "the colliding split had to be SUMMED, not dropped"
    );
    // THE TOTAL STILL RECONCILES, which is the whole claim.
    assert_eq!(
        circle.count("SELECT SUM(share_minor) FROM tally_expense_split"),
        90_000
    );
    assert_eq!(
        circle.count(&format!(
            "SELECT share_minor FROM tally_expense_split
              WHERE expense_id = 'e1' AND party_id = '{survivor}'"
        )),
        60_000
    );
    assert_eq!(
        circle.count("SELECT COUNT(*) FROM tally_expense_split WHERE expense_id = 'e1'"),
        2
    );
}

/// A ROW WHOSE TWO ENDS BECAME ONE PARTY IS DROPPED AND COUNTED. A debt to
/// oneself is not a debt.
#[test]
fn folding_both_ends_of_a_debt_drops_it_as_degenerate_rather_than_failing() {
    let circle = Circle::open("merge-degenerate");
    let survivor = circle.person("Jake Bennett", 45);
    let merged = circle.person("J. Bennett", 45);
    circle
        .vault()
        .commit(|tx| {
            tx.set_producer("test.debt");
            tx.connection().execute(
                "INSERT INTO tally_obligation (obligation_id, from_party, to_party, amount_minor,
                   currency, reason, incurred_on, settled_at, created_at, updated_at)
                 VALUES ('o1', ?1, ?2, 5000, 'GBP', 'the cabin', '2099-01-02', NULL,
                         '2099-01-02T00:00:00.000Z', '2099-01-02T00:00:00.000Z')",
                rusqlite::params![survivor, merged],
            )?;
            Ok(())
        })
        .expect("the obligation lands");

    let output = circle.run(
        "core.merge_party",
        json!({ "survivor_party_id": survivor, "merged_party_id": merged }),
    );
    assert_eq!(
        output["degenerate"].as_u64().unwrap_or_default(),
        1,
        "the CHECK failure has one honest reading and the fold has to count it"
    );
    assert_eq!(
        circle.count("SELECT COUNT(*) FROM tally_obligation WHERE obligation_id = 'o1'"),
        0
    );
}

/// A STANDING ANSWER IS DATED SHUT AND KEPT, never silently deleted — and the
/// pointer the engine cannot see is the one this proves.
#[test]
fn folding_a_party_with_a_standing_answer_revokes_the_duplicate_rather_than_dropping_it() {
    let circle = Circle::open("merge-authority");
    let survivor = circle.person("Maya Alvarez", 30);
    let merged = circle.person("M. Alvarez", 30);
    circle
        .vault()
        .commit(|tx| {
            tx.set_producer("test.authority");
            let connection = tx.connection();
            for (authority_id, principal) in [("a1", &survivor), ("a2", &merged)] {
                connection.execute(
                    "INSERT INTO share_authority (authority_id, principal_kind, principal_id,
                       subject_type, subject_id, verb, duration, expires_at, decision,
                       granted_by, granted_at, revoked_at)
                     VALUES (?1, 'person', ?2, 'core.document', 'd1', 'view', 'standing', NULL,
                             'granted', ?3, '2099-01-02T00:00:00.000Z', NULL)",
                    rusqlite::params![authority_id, principal, circle.owner_party_id()],
                )?;
            }
            Ok(())
        })
        .expect("the answers land");

    circle.run(
        "core.merge_party",
        json!({ "survivor_party_id": survivor, "merged_party_id": merged }),
    );
    // BOTH ROWS SURVIVE and both now name the survivor. One of them is dated
    // shut, because two live answers to one question is what the constraint
    // refuses.
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM share_authority WHERE principal_id = '{survivor}'"
        )),
        2,
        "an answer is history and is meant to outlive the row it names"
    );
}

#[test]
fn the_owner_cannot_be_merged_away_and_nobody_merges_into_themselves() {
    let circle = Circle::open("merge-refusals");
    let maya = circle.person("Maya Alvarez", 30);
    let owner = circle.owner_party_id();

    let self_merge = circle.try_run(
        "core.merge_party",
        json!({ "survivor_party_id": maya, "merged_party_id": maya }),
    );
    assert_eq!(self_merge.status, CommandStatus::Failed);
    assert_eq!(
        self_merge.predicate.as_deref(),
        Some("two_distinct_live_people")
    );

    let owner_merge = circle.try_run(
        "core.merge_party",
        json!({ "survivor_party_id": maya, "merged_party_id": owner }),
    );
    assert_eq!(owner_merge.status, CommandStatus::Failed);
    assert_eq!(
        owner_merge.predicate.as_deref(),
        Some("merged_is_not_the_owner")
    );
    assert_eq!(
        owner_merge.reason.as_deref(),
        Some("that is you; you cannot be merged away")
    );

    let absent = circle.try_run(
        "core.merge_party",
        json!({ "survivor_party_id": maya, "merged_party_id": "no-such-party" }),
    );
    assert_eq!(absent.status, CommandStatus::Failed);
}

// ---------------------------------------------------------------------------
// The `social` schema.
// ---------------------------------------------------------------------------

#[test]
fn a_reach_scheme_binds_as_a_channel_and_a_handle_binds_in_the_register() {
    let circle = Circle::open("social-identity");
    let maya = circle.person("Maya Alvarez", 30);
    circle.run(
        "social.resolve_identity",
        json!({ "party_id": maya, "scheme": "email", "value": "maya@example.com" }),
    );
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM social_contact_channel
              WHERE party_id = '{maya}' AND kind = 'email'"
        )),
        1
    );
    // AND NOT IN THE REGISTER, whose own CHECK could not hold it anyway.
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM core_party_identifier WHERE party_id = '{maya}'"
        )),
        0
    );
    circle.run(
        "social.resolve_identity",
        json!({ "party_id": maya, "scheme": "handle", "value": "@maya" }),
    );
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM core_party_identifier
              WHERE party_id = '{maya}' AND scheme = 'handle' AND is_primary = 1"
        )),
        1
    );

    // A VALUE ALREADY CLAIMED BY SOMEBODY ELSE IS AN IDENTITY FORK, refused.
    let jake = circle.person("Jake Bennett", 45);
    let forked = circle.try_run(
        "social.resolve_identity",
        json!({ "party_id": jake, "scheme": "email", "value": "maya@example.com" }),
    );
    assert_eq!(forked.status, CommandStatus::Failed);
    assert_eq!(
        forked.predicate.as_deref(),
        Some("handle_not_claimed_elsewhere")
    );
}

#[test]
fn only_a_draft_sends_and_sending_is_the_one_command_that_parks_a_non_owner() {
    let circle = Circle::open("social-send");
    let maya = circle.person("Maya Alvarez", 30);
    let drafted = circle.run(
        "social.draft_message",
        json!({ "body_text": "Are you free on Sunday?", "recipient_party_id": maya }),
    );
    let message = drafted["message_id"]
        .as_str()
        .expect("a message id")
        .to_owned();
    assert_eq!(
        circle.text(&format!(
            "SELECT delivery FROM social_message WHERE message_id = '{message}'"
        )),
        Some("draft".to_owned())
    );
    // TWO PARTICIPANTS, not a self-thread.
    assert_eq!(
        circle.count(&format!(
            "SELECT COUNT(*) FROM social_thread_participant WHERE thread_id = '{}'",
            drafted["thread_id"].as_str().unwrap_or_default()
        )),
        2
    );

    circle.run("social.send_message", json!({ "message_id": message }));
    assert_eq!(
        circle.text(&format!(
            "SELECT delivery FROM social_message WHERE message_id = '{message}'"
        )),
        Some("sent".to_owned())
    );
    // A SENT MESSAGE IS NOT A THING TO SEND AGAIN.
    let again = circle.try_run("social.send_message", json!({ "message_id": message }));
    assert_eq!(again.status, CommandStatus::Failed);
    assert_eq!(again.predicate.as_deref(), Some("message_is_draft"));

    // AND THE READ CURSOR JOINS THE OWNER AS A SILENT PARTICIPANT WHERE NEEDED.
    circle.run(
        "social.mark_thread_read",
        json!({
            "thread_id": drafted["thread_id"],
            "read_at": "2099-06-01T10:00:00.000Z"
        }),
    );
    assert_eq!(
        circle.text(&format!(
            "SELECT last_read_at FROM social_thread_participant
              WHERE thread_id = '{}' AND party_id = '{}'",
            drafted["thread_id"].as_str().unwrap_or_default(),
            circle.owner_party_id()
        )),
        Some("2099-06-01T10:00:00.000Z".to_owned())
    );
}
