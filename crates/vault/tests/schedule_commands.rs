//! THE SIXTEEN `schedule.*` COMMANDS, end to end (#1020, wave 4 lane
//! Schedule).
//!
//! Every command runs against a founded vault on a held clock: the happy path,
//! and the refusals that are the point of the command existing. What the suite
//! is built to catch:
//!
//! - a repeat rule outside the expander's subset **stored** rather than
//!   refused where the member wrote it (D-1020-S1);
//! - an occurrence exception keyed on the resolved instant rather than the
//!   series-local wall clock (#996 R21, ONT-25);
//! - a series edit that leaves its exceptions matching nothing;
//! - a completion that does not roll the series over, or rolls it over
//!   without the `about` link (ONT-27);
//! - a restore past the purge window (#916 review 1.5);
//! - the FOUR confirm-gated commands becoming three or five.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Vault};
use serde_json::{Value, json};

fn registry() -> Registry {
    Registry::with_system_commands().expect("the system registry builds")
}

struct Bench {
    scratch: common::Scratch,
    registry: Registry,
}

impl Bench {
    fn new(seed: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = registry();
        registry
            .install(&scratch.vault)
            .expect("the record installs");
        Self { scratch, registry }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    /// Run a command as the owner, expecting it to execute.
    fn run(&self, name: &str, input: Value) -> Value {
        let outcome = self
            .scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("{name} failed: {error}"));
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name} did not execute: {:?}",
            outcome.reason
        );
        outcome.output
    }

    /// Run a command expecting a REFUSAL, and answer with the sentence a
    /// member reads.
    ///
    /// **A refusal arrives two ways and both are refusals**: a PRECONDITION
    /// that does not hold settles as `Failed` carrying its sentence, and a
    /// HANDLER that refuses mid-flight returns the typed error so its whole
    /// transaction is rolled back. A test that accepted only the first would
    /// pass on a port that wrote half a row and then said no. (A CONSENT
    /// denial is a third thing, and it is a value in the app's payload, not
    /// either of these — census §A seam 6.)
    fn denied(&self, name: &str, input: Value) -> String {
        match self.scratch.vault.execute(
            &self.registry,
            &Principal::owner("phone"),
            &Command::new(name, input),
        ) {
            Ok(outcome) => {
                assert_eq!(
                    outcome.status,
                    CommandStatus::Failed,
                    "{name} executed and should not have"
                );
                outcome.reason.unwrap_or_default()
            }
            Err(error) => error.to_string(),
        }
    }

    fn text(&self, sql: &str, bind: &[&dyn rusqlite::ToSql]) -> Option<String> {
        self.vault()
            .read(|connection| Ok(connection.query_row(sql, bind, |row| row.get(0)).ok()))
            .expect("the read runs")
    }

    fn number(&self, sql: &str, bind: &[&dyn rusqlite::ToSql]) -> i64 {
        self.vault()
            .read(|connection| Ok(connection.query_row(sql, bind, |row| row.get(0))?))
            .expect("the read runs")
    }

    /// A calendar to propose against. `schedule_calendar` has no command of
    /// its own in v0 — it arrives with an import or a seed — so the fixture
    /// writes one.
    fn calendar(&self, name: &str, zone: &str) -> String {
        let calendar_id = self.vault().ids().next();
        let owner = common::owner_party(self.vault()).expect("an owner");
        let now = self.vault().clock().now_text();
        let id = calendar_id.clone();
        self.vault()
            .commit(|tx| {
                tx.set_producer("test.calendar");
                tx.connection().execute(
                    "INSERT INTO schedule_calendar
                       (calendar_id, owner_party_id, name, color, default_tz, visibility,
                        external_uri, created_at)
                     VALUES (?1, ?2, ?3, NULL, ?4, 'private', NULL, ?5)",
                    rusqlite::params![id, owner, name, zone, now],
                )?;
                Ok(())
            })
            .expect("the calendar is written");
        calendar_id
    }
}

fn owner_of(bench: &Bench) -> String {
    common::owner_party(bench.vault()).expect("an owner")
}

// ---------------------------------------------------------------------------
// Events.
// ---------------------------------------------------------------------------

#[test]
fn proposing_an_event_writes_the_series_its_calendar_edge_and_its_guests() {
    let bench = Bench::new("propose");
    let calendar_id = bench.calendar("Work", "Asia/Kolkata");
    let owner = owner_of(&bench);
    let output = bench.run(
        "schedule.propose_event",
        json!({
            "summary": "Design review",
            "dtstart": "2026-03-02T03:30:00.000Z",
            "dtend": "2026-03-02T04:30:00.000Z",
            "start_tz": "Asia/Kolkata",
            "calendar_id": calendar_id,
            "attendee_party_ids": [owner],
            "rrule": "RRULE:FREQ=WEEKLY;BYDAY=MO",
            "conferencing_uri": "https://example.invalid/room",
            "reminders": [{ "minutes_before": 10 }],
        }),
    );
    let event_id = output["event_id"].as_str().expect("an event id").to_owned();
    assert_eq!(output["attendees"], json!(1));
    assert_eq!(
        bench.text(
            "SELECT status FROM core_event WHERE event_id = ?1",
            &[&event_id]
        ),
        Some("tentative".to_owned()),
        "a proposal is tentative, never confirmed"
    );
    assert_eq!(
        bench.text(
            "SELECT rrule FROM core_event WHERE event_id = ?1",
            &[&event_id]
        ),
        Some("FREQ=WEEKLY;BYDAY=MO".to_owned()),
        "the `RRULE:` prefix is canonicalised away, once"
    );
    assert_eq!(
        bench.text(
            "SELECT recurrence_semantics FROM core_event WHERE event_id = ?1",
            &[&event_id]
        ),
        Some("zoned".to_owned()),
        "a zone plus a `Z` instant is a zoned series"
    );
    // The ext row carries its OWN primary key, not the event's (#708).
    let ext_id = bench
        .text(
            "SELECT event_ext_id FROM schedule_event_ext WHERE event_id = ?1",
            &[&event_id],
        )
        .expect("an ext row");
    assert_ne!(ext_id, event_id);
    assert_eq!(
        bench.number(
            "SELECT COUNT(*) FROM schedule_attendee WHERE event_id = ?1 AND partstat = 'needs-action'",
            &[&event_id]
        ),
        1
    );
}

#[test]
fn an_event_with_no_zone_is_floating_rather_than_a_zoned_lie() {
    let bench = Bench::new("floating");
    let calendar_id = bench.calendar("Personal", "Etc/UTC");
    let output = bench.run(
        "schedule.propose_event",
        json!({
            "summary": "Yoga",
            "dtstart": "2026-03-02T09:00:00",
            "dtend": "2026-03-02T10:00:00",
            "calendar_id": calendar_id,
        }),
    );
    let event_id = output["event_id"].as_str().expect("an id").to_owned();
    assert_eq!(
        bench.text(
            "SELECT recurrence_semantics FROM core_event WHERE event_id = ?1",
            &[&event_id]
        ),
        Some("floating".to_owned()),
        "the caller who omits a zone is saying which of the two this is"
    );
}

#[test]
fn an_unsupported_repeat_rule_is_refused_where_the_member_wrote_it() {
    let bench = Bench::new("refuse-rrule");
    let calendar_id = bench.calendar("Work", "Etc/UTC");
    let message = bench.denied(
        "schedule.propose_event",
        json!({
            "summary": "Rent",
            "dtstart": "2026-03-31T09:00:00.000Z",
            "dtend": "2026-03-31T10:00:00.000Z",
            "start_tz": "Etc/UTC",
            "calendar_id": calendar_id,
            "rrule": "FREQ=MONTHLY;BYSETPOS=-1",
        }),
    );
    assert!(
        message.contains("BYSETPOS") && message.contains("emits every candidate"),
        "the refusal names the part and the reason: {message}"
    );
    assert_eq!(
        bench.number("SELECT COUNT(*) FROM core_event", &[]),
        0,
        "and nothing was stored"
    );
}

#[test]
fn a_busy_conflict_and_a_backwards_range_are_both_refused() {
    let bench = Bench::new("conflict");
    let calendar_id = bench.calendar("Work", "Etc/UTC");
    bench.run(
        "schedule.propose_event",
        json!({
            "summary": "Standup",
            "dtstart": "2026-03-02T09:00:00.000Z",
            "dtend": "2026-03-02T09:30:00.000Z",
            "start_tz": "Etc/UTC",
            "calendar_id": calendar_id,
        }),
    );
    let message = bench.denied(
        "schedule.propose_event",
        json!({
            "summary": "Overlap",
            "dtstart": "2026-03-02T09:15:00.000Z",
            "dtend": "2026-03-02T10:00:00.000Z",
            "start_tz": "Etc/UTC",
            "calendar_id": calendar_id,
        }),
    );
    assert!(message.contains("conflicts"), "{message}");
    let backwards = bench.denied(
        "schedule.propose_event",
        json!({
            "summary": "Backwards",
            "dtstart": "2026-03-03T10:00:00.000Z",
            "dtend": "2026-03-03T09:00:00.000Z",
            "start_tz": "Etc/UTC",
            "calendar_id": calendar_id,
        }),
    );
    assert!(backwards.contains("end after it starts"), "{backwards}");
}

#[test]
fn rescheduling_and_cancelling_revise_one_identity_rather_than_writing_a_row() {
    let bench = Bench::new("revise");
    let calendar_id = bench.calendar("Work", "Etc/UTC");
    let event_id = bench.run(
        "schedule.propose_event",
        json!({
            "summary": "Review",
            "dtstart": "2026-03-02T09:00:00.000Z",
            "dtend": "2026-03-02T10:00:00.000Z",
            "start_tz": "Etc/UTC",
            "calendar_id": calendar_id,
        }),
    )["event_id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let moved = bench.run(
        "schedule.reschedule_event",
        json!({
            "event_id": event_id,
            "dtstart": "2026-03-03T09:00:00.000Z",
            "dtend": "2026-03-03T10:00:00.000Z",
        }),
    );
    assert_eq!(moved["sequence"], json!(1));
    let cancelled = bench.run("schedule.cancel_event", json!({ "event_id": event_id }));
    assert_eq!(cancelled["sequence"], json!(2), "SEQUENCE, never a new row");
    assert_eq!(
        bench.number("SELECT COUNT(*) FROM core_event", &[]),
        1,
        "one identity throughout"
    );
    // A cancelled event cannot be cancelled again, or rescheduled.
    let again = bench.denied("schedule.cancel_event", json!({ "event_id": event_id }));
    assert!(again.contains("not here to change"), "{again}");
}

#[test]
fn deleting_an_event_is_reversible_until_the_window_lapses() {
    let bench = Bench::new("event-trash");
    let calendar_id = bench.calendar("Work", "Etc/UTC");
    let event_id = bench.run(
        "schedule.propose_event",
        json!({
            "summary": "Dentist",
            "dtstart": "2026-03-02T09:00:00.000Z",
            "dtend": "2026-03-02T10:00:00.000Z",
            "start_tz": "Etc/UTC",
            "calendar_id": calendar_id,
        }),
    )["event_id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let trashed = bench.run("schedule.delete_event", json!({ "event_id": event_id }));
    let purge_at = trashed["purge_at"]
        .as_str()
        .expect("a purge date")
        .to_owned();
    assert!(
        purge_at > bench.vault().clock().now_text(),
        "thirty days out"
    );
    bench.run("schedule.restore_event", json!({ "event_id": event_id }));
    assert_eq!(
        bench.number(
            "SELECT COUNT(*) FROM core_event WHERE event_id = ?1 AND deleted_at IS NULL",
            &[&event_id]
        ),
        1
    );
    // …and past the window it is refused, rather than resurrecting what the
    // member was told had been deleted (#916 review 1.5).
    bench.run("schedule.delete_event", json!({ "event_id": event_id }));
    bench.scratch.clock.advance_days(31);
    let lapsed = bench.denied("schedule.restore_event", json!({ "event_id": event_id }));
    assert!(lapsed.contains("not in the trash any more"), "{lapsed}");
}

#[test]
fn an_rsvp_is_recorded_against_the_attendee_row_and_stamped() {
    let bench = Bench::new("rsvp");
    let calendar_id = bench.calendar("Work", "Etc/UTC");
    let owner = owner_of(&bench);
    let event_id = bench.run(
        "schedule.propose_event",
        json!({
            "summary": "Kickoff",
            "dtstart": "2026-03-02T09:00:00.000Z",
            "dtend": "2026-03-02T10:00:00.000Z",
            "start_tz": "Etc/UTC",
            "calendar_id": calendar_id,
            "attendee_party_ids": [owner],
        }),
    )["event_id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let output = bench.run(
        "schedule.respond_rsvp",
        json!({ "event_id": event_id, "party_id": owner, "partstat": "accepted" }),
    );
    assert_eq!(output["partstat"], json!("accepted"));
    assert_eq!(
        bench.number(
            "SELECT COUNT(*) FROM schedule_attendee
              WHERE event_id = ?1 AND partstat = 'accepted' AND responded_at IS NOT NULL",
            &[&event_id]
        ),
        1
    );
    // An uninvited party is refused rather than silently enrolled.
    let stranger = bench.vault().ids().next();
    let message = bench.denied(
        "schedule.respond_rsvp",
        json!({ "event_id": event_id, "party_id": stranger, "partstat": "declined" }),
    );
    assert!(message.contains("not invited"), "{message}");
}

// ---------------------------------------------------------------------------
// Occurrences — the ONT-25 seam.
// ---------------------------------------------------------------------------

fn recurring_series(bench: &Bench) -> String {
    let calendar_id = bench.calendar("Work", "Asia/Kolkata");
    bench.run(
        "schedule.propose_event",
        json!({
            // 09:00 IST, every day.
            "summary": "Standup",
            "dtstart": "2026-03-02T03:30:00.000Z",
            "dtend": "2026-03-02T04:00:00.000Z",
            "start_tz": "Asia/Kolkata",
            "calendar_id": calendar_id,
            "rrule": "FREQ=DAILY",
        }),
    )["event_id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

#[test]
fn an_occurrence_exception_is_keyed_on_the_series_local_wall_clock() {
    let bench = Bench::new("occurrence");
    let event_id = recurring_series(&bench);
    bench.run(
        "schedule.edit_event_occurrence",
        json!({
            "event_id": event_id,
            "original_start_local": "2026-03-05T09:00:00",
            "scope": "occurrence",
            "action": "skip",
        }),
    );
    assert_eq!(
        bench.text(
            "SELECT original_start_local FROM schedule_recurrence_exception WHERE target_id = ?1",
            &[&event_id]
        ),
        Some("2026-03-05T09:00:00".to_owned()),
        "the WALL CLOCK, never the resolved instant (#996 R21, ONT-25)"
    );
    assert_eq!(
        bench.text(
            "SELECT recurrence_semantics FROM schedule_recurrence_exception WHERE target_id = ?1",
            &[&event_id]
        ),
        Some("zoned".to_owned())
    );
}

#[test]
fn a_key_that_is_not_an_occurrence_is_refused_rather_than_stored() {
    let bench = Bench::new("not-an-occurrence");
    let event_id = recurring_series(&bench);
    // The instant, offered where the wall clock belongs — the exact mistake
    // ONT-25 is. It is not an occurrence of this series and is refused.
    let message = bench.denied(
        "schedule.edit_event_occurrence",
        json!({
            "event_id": event_id,
            "original_start_local": "2026-03-05T03:30:00.000Z",
            "scope": "occurrence",
            "action": "skip",
        }),
    );
    assert!(message.contains("not an occurrence"), "{message}");
    // And so is a date the series never lands on at all (v0 stored
    // `1999-01-01` happily, and it matched nothing for ever).
    let ancient = bench.denied(
        "schedule.edit_event_occurrence",
        json!({
            "event_id": event_id,
            "original_start_local": "1999-01-01T09:00:00",
            "scope": "occurrence",
            "action": "skip",
        }),
    );
    assert!(ancient.contains("not an occurrence"), "{ancient}");
    assert_eq!(
        bench.number("SELECT COUNT(*) FROM schedule_recurrence_exception", &[]),
        0
    );
}

#[test]
fn an_override_carries_its_payload_and_a_repeat_updates_rather_than_duplicating() {
    let bench = Bench::new("override");
    let event_id = recurring_series(&bench);
    for summary in ["Moved", "Moved again"] {
        bench.run(
            "schedule.edit_event_occurrence",
            json!({
                "event_id": event_id,
                "original_start_local": "2026-03-05T09:00:00",
                "scope": "occurrence",
                "action": "override",
                "summary": summary,
                "dtstart": "2026-03-05T05:30:00.000Z",
            }),
        );
    }
    assert_eq!(
        bench.number("SELECT COUNT(*) FROM schedule_recurrence_exception", &[]),
        1,
        "the unique key is (type, id, wall clock, scope)"
    );
    let stored = bench
        .text(
            "SELECT override_json FROM schedule_recurrence_exception WHERE target_id = ?1",
            &[&event_id],
        )
        .expect("an override");
    let parsed: Value = serde_json::from_str(&stored).expect("the override is JSON");
    assert_eq!(parsed["summary"], json!("Moved again"));
    assert_eq!(parsed["start"], json!("2026-03-05T05:30:00.000Z"));
    assert_eq!(parsed["scope"], json!("occurrence"));
}

#[test]
fn a_series_skip_cancels_the_series_and_is_idempotent() {
    let bench = Bench::new("series-skip");
    let event_id = recurring_series(&bench);
    let first = bench.run(
        "schedule.edit_event_occurrence",
        json!({
            "event_id": event_id,
            "original_start_local": "2026-03-05T09:00:00",
            "scope": "series",
            "action": "skip",
        }),
    );
    assert_eq!(first["sequence"], json!(1));
    let second = bench.run(
        "schedule.edit_event_occurrence",
        json!({
            "event_id": event_id,
            "original_start_local": "2026-03-05T09:00:00",
            "scope": "series",
            "action": "skip",
        }),
    );
    assert!(
        second.get("sequence").is_none(),
        "an already-cancelled series is not revised twice"
    );
}

#[test]
fn a_series_edit_that_would_strand_its_exceptions_is_refused() {
    let bench = Bench::new("stranded");
    let event_id = recurring_series(&bench);
    bench.run(
        "schedule.edit_event_occurrence",
        json!({
            "event_id": event_id,
            "original_start_local": "2026-03-05T09:00:00",
            "scope": "occurrence",
            "action": "skip",
        }),
    );
    // Re-anchoring the series to a Monday-only rule leaves the Thursday skip
    // matching nothing.
    let message = bench.denied(
        "schedule.edit_event",
        json!({ "event_id": event_id, "rrule": "FREQ=WEEKLY;BYDAY=MO" }),
    );
    assert!(
        message.contains("matching nothing"),
        "the refusal says what is stranded: {message}"
    );
    // And dropping the rule outright is refused while any exception stands.
    let dropped = bench.denied(
        "schedule.edit_event",
        json!({ "event_id": event_id, "clear_rrule": true }),
    );
    assert!(dropped.contains("occurrence exception"), "{dropped}");
}

#[test]
fn editing_an_event_advances_its_revision_and_replaces_its_guest_list() {
    let bench = Bench::new("edit-event");
    let calendar_id = bench.calendar("Work", "Etc/UTC");
    let owner = owner_of(&bench);
    let event_id = bench.run(
        "schedule.propose_event",
        json!({
            "summary": "Retro",
            "dtstart": "2026-03-02T09:00:00.000Z",
            "dtend": "2026-03-02T10:00:00.000Z",
            "start_tz": "Etc/UTC",
            "calendar_id": calendar_id,
            "attendee_party_ids": [owner],
            "conferencing_uri": "https://example.invalid/old",
        }),
    )["event_id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let output = bench.run(
        "schedule.edit_event",
        json!({
            "event_id": event_id,
            "summary": "Retro, longer",
            "dtend": "2026-03-02T11:00:00.000Z",
            "clear_conferencing": true,
            "attendee_party_ids": [],
            "reminders": [{ "minutes_before": 5 }],
        }),
    );
    assert_eq!(output["sequence"], json!(1));
    assert_eq!(
        bench.text(
            "SELECT summary FROM core_event WHERE event_id = ?1",
            &[&event_id]
        ),
        Some("Retro, longer".to_owned())
    );
    assert_eq!(
        bench.number(
            "SELECT COUNT(*) FROM schedule_attendee WHERE event_id = ?1",
            &[&event_id]
        ),
        0,
        "an empty guest list is an empty guest list"
    );
    assert_eq!(
        bench.text(
            "SELECT conferencing_uri FROM schedule_event_ext WHERE event_id = ?1",
            &[&event_id]
        ),
        None
    );
    assert_eq!(
        bench.text(
            "SELECT reminders_json FROM schedule_event_ext WHERE event_id = ?1",
            &[&event_id]
        ),
        Some(r#"[{"minutes_before":5}]"#.to_owned())
    );
}

// ---------------------------------------------------------------------------
// Projects, sections and tasks.
// ---------------------------------------------------------------------------

#[test]
fn a_save_is_an_upsert_and_a_second_save_renames_rather_than_refusing() {
    let bench = Bench::new("save");
    let project_id = bench.run("schedule.save_project", json!({ "name": "House" }))["project_id"]
        .as_str()
        .expect("a project id")
        .to_owned();
    bench.run(
        "schedule.save_project",
        json!({ "project_id": project_id, "name": "Home", "sort_order": 3 }),
    );
    assert_eq!(
        bench.number("SELECT COUNT(*) FROM schedule_project", &[]),
        1,
        "a rename is not a second project (#922 G2)"
    );
    assert_eq!(
        bench.text(
            "SELECT name FROM schedule_project WHERE project_id = ?1",
            &[&project_id]
        ),
        Some("Home".to_owned())
    );
    let section_id = bench.run(
        "schedule.save_section",
        json!({ "project_id": project_id, "name": "Kitchen" }),
    )["section_id"]
        .as_str()
        .expect("a section id")
        .to_owned();
    bench.run(
        "schedule.save_section",
        json!({ "section_id": section_id, "project_id": project_id, "name": "Garden" }),
    );
    assert_eq!(
        bench.number("SELECT COUNT(*) FROM schedule_section", &[]),
        1
    );
}

#[test]
fn a_task_in_a_section_of_another_project_is_refused_by_the_model() {
    let bench = Bench::new("filing");
    let house = bench.run("schedule.save_project", json!({ "name": "House" }))["project_id"]
        .as_str()
        .expect("a project")
        .to_owned();
    let work = bench.run("schedule.save_project", json!({ "name": "Work" }))["project_id"]
        .as_str()
        .expect("a project")
        .to_owned();
    let kitchen = bench.run(
        "schedule.save_section",
        json!({ "project_id": house, "name": "Kitchen" }),
    )["section_id"]
        .as_str()
        .expect("a section")
        .to_owned();
    let task_id = bench.run("schedule.add_task", json!({ "title": "Fix the tap" }))["task_id"]
        .as_str()
        .expect("a task")
        .to_owned();
    let message = bench.denied(
        "schedule.organize_task",
        json!({
            "task_id": task_id,
            "project_id": work,
            "section_id": kitchen,
            "sort_order": 0,
        }),
    );
    assert!(
        message.contains("belongs to a different project"),
        "the MODEL's sentence, not the command's: {message}"
    );
    // The right filing lands, and `clear_project` unfiles both columns.
    bench.run(
        "schedule.organize_task",
        json!({
            "task_id": task_id,
            "project_id": house,
            "section_id": kitchen,
            "sort_order": 2,
            "recurrence_anchor": "completion",
            "tz": "Asia/Kolkata",
        }),
    );
    assert_eq!(
        bench.text(
            "SELECT tz FROM schedule_task WHERE task_id = ?1",
            &[&task_id]
        ),
        Some("Asia/Kolkata".to_owned())
    );
    bench.run(
        "schedule.organize_task",
        json!({ "task_id": task_id, "clear_project": true, "sort_order": 0 }),
    );
    assert_eq!(
        bench.number(
            "SELECT COUNT(*) FROM schedule_task
              WHERE task_id = ?1 AND project_id IS NULL AND section_id IS NULL",
            &[&task_id]
        ),
        1,
        "clearing the project clears the section it contained"
    );
    assert_eq!(
        bench.text(
            "SELECT tz FROM schedule_task WHERE task_id = ?1",
            &[&task_id]
        ),
        Some("Asia/Kolkata".to_owned()),
        "unfiling does not retune recurrence"
    );
}

#[test]
fn a_task_cannot_be_its_own_parent_and_an_unreadable_due_date_is_refused() {
    let bench = Bench::new("model");
    let task_id = bench.vault().ids().next();
    let cyclic = bench.denied(
        "schedule.add_task",
        json!({ "task_id": task_id, "title": "Loop", "parent_task_id": task_id }),
    );
    assert!(cyclic.contains("cannot be its own parent"), "{cyclic}");
    let banana = bench.denied(
        "schedule.add_task",
        json!({ "title": "When", "due_at": "banana" }),
    );
    assert!(
        banana.contains("not a time this vault can read"),
        "ONT-31's sentence, not \"invalid date\": {banana}"
    );
    let unsupported = bench.denied(
        "schedule.add_task",
        json!({ "title": "Rent", "due_at": "2026-03-01", "rrule": "FREQ=MONTHLY;BYMONTHDAY=1" }),
    );
    assert!(unsupported.contains("BYMONTHDAY"), "{unsupported}");
    let ruleless = bench.denied(
        "schedule.add_task",
        json!({ "title": "Rent", "rrule": "FREQ=MONTHLY" }),
    );
    assert!(
        ruleless.contains("needs a due date"),
        "a rule with nothing to advance never recurs: {ruleless}"
    );
    assert_eq!(bench.number("SELECT COUNT(*) FROM schedule_task", &[]), 0);
}

#[test]
fn only_an_open_top_level_task_may_take_a_subtask() {
    let bench = Bench::new("nesting");
    let parent = bench.run("schedule.add_task", json!({ "title": "Move house" }))["task_id"]
        .as_str()
        .expect("a task")
        .to_owned();
    let child = bench.run(
        "schedule.add_task",
        json!({ "title": "Pack books", "parent_task_id": parent }),
    )["task_id"]
        .as_str()
        .expect("a task")
        .to_owned();
    let message = bench.denied(
        "schedule.add_task",
        json!({ "title": "Grandchild", "parent_task_id": child }),
    );
    assert!(
        message.contains("open, top-level"),
        "one level only: {message}"
    );
}

#[test]
fn completing_a_repeating_task_rolls_the_series_over_and_keeps_its_links() {
    let bench = Bench::new("rollover");
    let task_id = bench.run(
        "schedule.add_task",
        json!({
            "title": "Call Mum",
            "due_at": "2026-03-01T09:00:00Z",
            "rrule": "FREQ=WEEKLY",
        }),
    )["task_id"]
        .as_str()
        .expect("a task")
        .to_owned();
    // The `about` edge ONT-27 lost: a live link from the occurrence.
    let owner = owner_of(&bench);
    let concept_id = bench.vault().ids().next();
    let scheme_id = bench.vault().ids().next();
    let link_id = bench.vault().ids().next();
    let now = bench.vault().clock().now_text();
    let task = task_id.clone();
    bench
        .vault()
        .commit(|tx| {
            tx.set_producer("test.link");
            tx.connection().execute(
                "INSERT INTO core_concept_scheme
                   (scheme_id, uri, title, publisher, version, created_at)
                 VALUES (?1, 'centraid:relations:v1', 'Relations', NULL, '1', ?2)",
                rusqlite::params![scheme_id, now],
            )?;
            tx.connection().execute(
                "INSERT INTO core_concept
                   (concept_id, scheme_id, pref_label, notation, broader_concept_id,
                    created_at, updated_at)
                 VALUES (?1, ?2, 'about', 'about', NULL, ?3, ?3)",
                rusqlite::params![concept_id, scheme_id, now],
            )?;
            tx.connection().execute(
                "INSERT INTO core_link
                   (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
                    valid_from, valid_to, asserted_by, provenance_id)
                 VALUES (?1, 'schedule.task', ?2, 'core.party', ?3, ?4, ?5, NULL, 'owner', NULL)",
                rusqlite::params![link_id, task, owner, concept_id, now],
            )?;
            Ok(())
        })
        .expect("the link is written");

    let output = bench.run(
        "schedule.set_task_status",
        json!({ "task_id": task_id, "status": "completed" }),
    );
    let next_task_id = output["next_task_id"]
        .as_str()
        .expect("a successor was spawned")
        .to_owned();
    assert_eq!(output["next_due_at"], json!("2026-03-08T09:00:00.000Z"));
    assert_eq!(
        output["series_id"].as_str(),
        Some(task_id.as_str()),
        "the first occurrence is the head of its own series"
    );
    assert_eq!(
        bench.text(
            "SELECT series_id FROM schedule_task WHERE task_id = ?1",
            &[&next_task_id]
        ),
        Some(task_id.clone()),
        "and the successor belongs to it"
    );
    assert_eq!(
        bench.number(
            "SELECT COUNT(*) FROM core_link
              WHERE from_type = 'schedule.task' AND from_id = ?1 AND valid_to IS NULL",
            &[&next_task_id]
        ),
        1,
        "the successor of a recurring \"call Mum\" is still about Mum (ONT-27)"
    );
    // IDEMPOTENT: completing it again never spawns a second successor.
    let again = bench.run(
        "schedule.set_task_status",
        json!({ "task_id": task_id, "status": "completed" }),
    );
    assert!(again.get("next_task_id").is_none());
    assert_eq!(bench.number("SELECT COUNT(*) FROM schedule_task", &[]), 2);
}

#[test]
fn the_rollover_reads_the_tasks_own_zone_not_the_hosts() {
    let bench = Bench::new("rollover-zone");
    let task_id = bench.run(
        "schedule.add_task",
        json!({
            // 09:00 New York on the day before the spring transition.
            "title": "Water the plants",
            "due_at": "2026-03-07T14:00:00Z",
            "rrule": "FREQ=DAILY",
        }),
    )["task_id"]
        .as_str()
        .expect("a task")
        .to_owned();
    bench.run(
        "schedule.organize_task",
        json!({ "task_id": task_id, "sort_order": 0, "tz": "America/New_York" }),
    );
    let output = bench.run(
        "schedule.set_task_status",
        json!({ "task_id": task_id, "status": "completed" }),
    );
    assert_eq!(
        output["next_due_at"],
        json!("2026-03-08T13:00:00.000Z"),
        "09:00 local on both days — the wall clock survives the offset change"
    );
}

#[test]
fn reopening_and_cancelling_are_named_operations_never_a_toggle() {
    let bench = Bench::new("lifecycle");
    let task_id = bench.run(
        "schedule.add_task",
        json!({ "title": "Renew passport", "due_at": "2026-03-01T09:00:00Z" }),
    )["task_id"]
        .as_str()
        .expect("a task")
        .to_owned();
    bench.run(
        "schedule.set_task_status",
        json!({ "task_id": task_id, "status": "completed" }),
    );
    bench.run(
        "schedule.set_task_status",
        json!({ "task_id": task_id, "status": "needs-action" }),
    );
    assert_eq!(
        bench.number(
            "SELECT COUNT(*) FROM schedule_task
              WHERE task_id = ?1 AND status = 'needs-action' AND completed_at IS NULL",
            &[&task_id]
        ),
        1,
        "reopening clears the stamp"
    );
    bench.run(
        "schedule.set_task_status",
        json!({ "task_id": task_id, "status": "cancelled" }),
    );
    assert_eq!(
        bench.text(
            "SELECT status FROM schedule_task WHERE task_id = ?1",
            &[&task_id]
        ),
        Some("cancelled".to_owned())
    );
}

#[test]
fn editing_a_task_takes_a_set_or_a_clear_and_never_both() {
    let bench = Bench::new("edit-task");
    let task_id = bench.run(
        "schedule.add_task",
        json!({
            "title": "Book flights",
            "due_at": "2026-03-01T09:00:00Z",
            "description": "before the price rises",
            "remind_before_min": 60,
        }),
    )["task_id"]
        .as_str()
        .expect("a task")
        .to_owned();
    let both = bench.denied(
        "schedule.edit_task",
        json!({ "task_id": task_id, "due_at": "2026-04-01T09:00:00Z", "clear_due": true }),
    );
    assert!(both.contains("not both"), "{both}");
    bench.run(
        "schedule.edit_task",
        json!({
            "task_id": task_id,
            "title": "Book flights to Lisbon",
            "priority": 3,
            "clear_description": true,
            "clear_remind": true,
        }),
    );
    assert_eq!(
        bench.number(
            "SELECT COUNT(*) FROM schedule_task
              WHERE task_id = ?1 AND priority = 3 AND description IS NULL
                AND remind_before_min IS NULL",
            &[&task_id]
        ),
        1
    );
    // Clearing the due date while a rule stands would leave a series with
    // nothing to advance.
    bench.run(
        "schedule.edit_task",
        json!({ "task_id": task_id, "rrule": "FREQ=MONTHLY" }),
    );
    let stranded = bench.denied(
        "schedule.edit_task",
        json!({ "task_id": task_id, "clear_due": true }),
    );
    assert!(stranded.contains("needs a due date"), "{stranded}");
}

#[test]
fn deleting_a_task_takes_its_subtasks_and_restore_brings_them_back() {
    let bench = Bench::new("task-trash");
    let parent = bench.run("schedule.add_task", json!({ "title": "Tax return" }))["task_id"]
        .as_str()
        .expect("a task")
        .to_owned();
    bench.run(
        "schedule.add_task",
        json!({ "title": "Find receipts", "parent_task_id": parent }),
    );
    let output = bench.run("schedule.delete_task", json!({ "task_id": parent }));
    assert_eq!(output["removed"], json!(2), "the parent and its subtask");
    assert_eq!(
        bench.number(
            "SELECT COUNT(*) FROM schedule_task WHERE deleted_at IS NOT NULL",
            &[]
        ),
        2
    );
    let restored = bench.run("schedule.restore_task", json!({ "task_id": parent }));
    assert_eq!(restored["restored"], json!(2));
    // Past the window, the restore is refused.
    bench.run("schedule.delete_task", json!({ "task_id": parent }));
    bench.scratch.clock.advance_days(31);
    let lapsed = bench.denied("schedule.restore_task", json!({ "task_id": parent }));
    assert!(lapsed.contains("not in the trash any more"), "{lapsed}");
}

// ---------------------------------------------------------------------------
// The schema's own shape.
// ---------------------------------------------------------------------------

#[test]
fn the_schema_declares_sixteen_commands_and_four_confirm_gates() {
    let registry = registry();
    let names: Vec<&str> = registry
        .names()
        .into_iter()
        .filter(|name| name.starts_with("schedule."))
        .collect();
    assert_eq!(names.len(), 16);
    let confirming: Vec<&str> = names
        .iter()
        .copied()
        .filter(|name| registry.get(name).expect("registered").definition.confirm)
        .collect();
    // FOUR, not three. Each restates a commitment other people may hold (#306
    // decision 1), and the census' count of three is the finding, not a
    // difference (D-1020-S6).
    assert_eq!(
        confirming,
        [
            "schedule.cancel_event",
            "schedule.edit_event",
            "schedule.edit_event_occurrence",
            "schedule.reschedule_event",
        ]
    );
    // NONE is online-only: `ONLINE_ONLY_ACTIONS` is Locker's alone, and a
    // task filed in a tunnel is the point of filing it there.
    assert!(names.iter().all(|name| {
        !registry
            .get(name)
            .expect("registered")
            .definition
            .online_only
    }));
}
