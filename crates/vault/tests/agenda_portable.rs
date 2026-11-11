//! Calendar and Reminders as calendar files (#1185): `event.export_ics` and `task.export_ics`
//! write RFC 5545 text a calendar app reads back (unfolded, split into lines, unescaped), name the
//! file for what it holds, leave the trash out and write nothing.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::json;

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("ics").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self
            .scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn id(&self, name: &str, input: serde_json::Value) -> String {
        self.ok(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn file(&self, name: &str, input: serde_json::Value) -> (serde_json::Value, String) {
        let out = self.ok(name, input);
        let text = String::from_utf8(
            base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                out["content"].as_str().expect("content"),
            )
            .expect("base64"),
        )
        .expect("utf-8");
        (out, text)
    }

    fn writes(&self) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row("SELECT writes FROM vault", [], |r| r.get(0))?))
            .expect("a row")
    }
}

/// The lines of a file the way a calendar app reads it: folds undone, CRLF endings required.
fn lines(text: &str) -> Vec<String> {
    assert!(text.ends_with("\r\n") && !text.replace("\r\n", "").contains('\n'));
    let mut out: Vec<String> = Vec::new();
    for raw in text.split("\r\n").filter(|l| !l.is_empty()) {
        assert!(raw.len() <= 75, "a line over 75 octets: {raw}");
        match raw.strip_prefix(' ') {
            Some(rest) => out.last_mut().expect("a line before").push_str(rest),
            None => out.push(raw.to_owned()),
        }
    }
    out
}

fn has(lines: &[String], line: &str) -> bool {
    lines.iter().any(|l| l == line)
}

#[test]
fn an_event_is_written_with_escaping_folding_and_its_own_zone() {
    let w = World::new();
    let title = format!("Plan, review; \"launch\" {}", "é".repeat(60));
    w.ok(
        "event.propose",
        json!({ "title": title, "starts": "2026-03-02T09:00", "ends": "2026-03-02T10:00",
                "zone": "Europe/Paris", "description": "line one\nline two, with a comma",
                "reminders": [15, 0], "url": "https://example.com/launch" }),
    );
    let (out, text) = w.file("event.export_ics", json!({}));
    assert_eq!(out["media_type"], "text/calendar");
    assert_eq!(out["name"], "Calendar.ics");
    assert_eq!(out["count"], 1);
    let l = lines(&text);
    assert_eq!(l[0], "BEGIN:VCALENDAR");
    assert_eq!(l.last().map(String::as_str), Some("END:VCALENDAR"));
    assert!(has(&l, "VERSION:2.0"));
    assert!(
        l.iter()
            .any(|x| x.starts_with("UID:") && x.ends_with("@centraid"))
    );
    assert!(
        l.iter()
            .any(|x| x.starts_with("DTSTAMP:") && x.ends_with('Z'))
    );
    assert!(has(&l, "DTSTART;TZID=Europe/Paris:20260302T090000"));
    assert!(has(&l, "DTEND;TZID=Europe/Paris:20260302T100000"));
    assert!(has(
        &l,
        &format!("SUMMARY:Plan\\, review\\; \"launch\" {}", "é".repeat(60))
    ));
    assert!(has(&l, "DESCRIPTION:line one\\nline two\\, with a comma"));
    assert!(has(&l, "URL:https://example.com/launch"));
    assert!(has(&l, "TRIGGER:-PT15M") && has(&l, "TRIGGER:PT0S"));
    assert!(text.lines().count() > l.len(), "the long title was folded");
}

#[test]
fn all_day_and_floating_events_keep_their_reading() {
    let w = World::new();
    w.ok(
        "event.propose",
        json!({ "title": "Holiday", "starts": "2026-03-05", "ends": "2026-03-06", "busy": false }),
    );
    w.ok(
        "event.propose",
        json!({ "title": "Lunch", "starts": "2026-03-04T12:30", "ends": "2026-03-04T13:00" }),
    );
    let (_, text) = w.file("event.export_ics", json!({}));
    let l = lines(&text);
    // The model keeps the last day; the file keeps the day after it.
    assert!(has(&l, "DTSTART;VALUE=DATE:20260305"));
    assert!(has(&l, "DTEND;VALUE=DATE:20260307"));
    assert!(has(&l, "TRANSP:TRANSPARENT"));
    assert!(has(&l, "DTSTART:20260304T123000"));
    assert!(has(&l, "DTEND:20260304T130000"));
}

#[test]
fn a_series_carries_its_rule_its_skipped_day_and_its_moved_day() {
    let w = World::new();
    let id = w.id(
        "event.propose",
        json!({ "title": "Standup", "starts": "2026-03-02T09:00", "ends": "2026-03-02T09:30",
                "zone": "Europe/Paris", "rule": "FREQ=WEEKLY" }),
    );
    w.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-09T09:00:00", "scope": "occurrence",
                "action": "skip" }),
    );
    w.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-16T09:00:00", "scope": "occurrence",
                "action": "override", "starts": "2026-03-16T11:00", "ends": "2026-03-16T11:30",
                "title": "Late standup" }),
    );
    let (_, text) = w.file("event.export_ics", json!({ "event_id": id }));
    let l = lines(&text);
    assert!(has(&l, "RRULE:FREQ=WEEKLY"));
    assert!(has(&l, "EXDATE;TZID=Europe/Paris:20260309T090000"));
    assert!(has(&l, "RECURRENCE-ID;TZID=Europe/Paris:20260316T090000"));
    assert!(has(&l, "SUMMARY:Late standup"));
    assert!(has(&l, "DTSTART;TZID=Europe/Paris:20260316T110000"));
    assert_eq!(text.matches("BEGIN:VEVENT").count(), 2);
    let uids: Vec<_> = l.iter().filter(|x| x.starts_with("UID:")).collect();
    assert_eq!(uids.len(), 2);
    assert_eq!(uids[0], uids[1], "the moved day is the same event");
}

#[test]
fn a_calendar_is_its_own_file_one_event_is_named_for_it_and_the_trash_is_left_out() {
    let w = World::new();
    let work = w.id(
        "container.create",
        json!({ "kind": "calendar", "title": "Work" }),
    );
    let kept = w.id(
        "event.propose",
        json!({ "title": "Review", "starts": "2026-03-03T10:00", "calendar_id": work }),
    );
    let gone = w.id(
        "event.propose",
        json!({ "title": "Cancelled plans", "starts": "2026-03-03T14:00", "calendar_id": work }),
    );
    w.ok(
        "event.propose",
        json!({ "title": "Elsewhere", "starts": "2026-03-04T10:00" }),
    );
    w.ok("entity.trash", json!({ "id": gone }));
    let before = w.writes();

    let (all, text) = w.file("event.export_ics", json!({}));
    assert_eq!(all["count"], 2);
    assert!(!text.contains("Cancelled plans"));

    let (scoped, text) = w.file("event.export_ics", json!({ "calendar_id": work }));
    assert_eq!(scoped["name"], "Work.ics");
    assert_eq!(scoped["count"], 1);
    assert!(text.contains("SUMMARY:Review") && !text.contains("Elsewhere"));

    let (one, text) = w.file("event.export_ics", json!({ "event_id": kept }));
    assert_eq!(one["name"], "Review.ics");
    assert_eq!(text.matches("BEGIN:VEVENT").count(), 1);

    let (none, _) = w.file("event.export_ics", json!({ "event_id": "nobody" }));
    assert_eq!(none["count"], 0);
    assert_eq!(w.writes(), before, "an export writes nothing");
}

#[test]
fn a_reminder_is_a_todo_with_its_due_status_priority_and_rule() {
    let w = World::new();
    let errands = w.id(
        "container.create",
        json!({ "kind": "project", "title": "Errands" }),
    );
    let milk = w.id(
        "task.add",
        json!({ "title": "Buy milk, eggs", "due": "2026-03-05", "priority": 3,
                "description": "semi; skimmed", "project_id": errands,
                "rule": "FREQ=WEEKLY", "url": "https://example.com/list" }),
    );
    let done = w.id(
        "task.add",
        json!({ "title": "Post letter", "due": "2026-03-01T09:30" }),
    );
    w.ok("task.complete", json!({ "id": done }));
    let trashed = w.id("task.add", json!({ "title": "Old chore" }));
    w.ok("entity.trash", json!({ "id": trashed }));
    w.id("task.add", json!({ "title": "No date" }));
    let before = w.writes();

    let (all, text) = w.file("task.export_ics", json!({}));
    assert_eq!(all["name"], "Reminders.ics");
    assert_eq!(all["count"], 3);
    assert!(!text.contains("Old chore"));
    let l = lines(&text);
    assert!(has(&l, "SUMMARY:Buy milk\\, eggs"));
    assert!(has(&l, "DUE;VALUE=DATE:20260305"));
    assert!(has(&l, "DESCRIPTION:semi\\; skimmed"));
    assert!(has(&l, "RRULE:FREQ=WEEKLY"));
    assert!(has(&l, "PRIORITY:1"));
    assert!(has(&l, "STATUS:NEEDS-ACTION"));
    assert!(has(&l, "STATUS:COMPLETED"));
    assert!(
        l.iter()
            .any(|x| x.starts_with("COMPLETED:") && x.ends_with('Z'))
    );
    assert!(has(&l, "DUE:20260301T093000"));
    assert!(has(&l, "URL:https://example.com/list"));

    let (list, text) = w.file("task.export_ics", json!({ "list_id": errands }));
    assert_eq!(list["name"], "Errands.ics");
    assert_eq!(list["count"], 1);
    assert!(text.contains("Buy milk") && !text.contains("Post letter"));

    let (one, text) = w.file("task.export_ics", json!({ "task_id": milk }));
    assert_eq!(one["name"], "Buy milk, eggs.ics");
    assert_eq!(text.matches("BEGIN:VTODO").count(), 1);
    assert_eq!(w.writes(), before, "an export writes nothing");
}
