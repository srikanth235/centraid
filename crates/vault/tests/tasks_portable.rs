//! Reminders as a calendar file (#1185, #1214): `task.export_ics` writes VTODOs a calendar app
//! reads back (unfolded, split into lines, unescaped), names the file for what it holds, leaves the
//! trash out and writes nothing. Nothing imports a calendar file: a phone's Reminders are followed
//! (`tests/follow_reminders.rs`) and a task is added by `task.add`.

mod common;

use common::world::World;
use serde_json::json;

fn id(w: &World, name: &str, input: serde_json::Value) -> String {
    w.ok(name, input)["id"].as_str().expect("an id").to_owned()
}

fn file(w: &World, input: serde_json::Value) -> (serde_json::Value, String) {
    let out = w.ok("task.export_ics", input);
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
fn a_reminder_is_a_todo_with_its_due_status_priority_rule_and_alerts() {
    let w = World::new("ics_tasks");
    let errands = w.container("project", "Errands");
    let milk = id(
        &w,
        "task.add",
        json!({ "title": "Buy milk, eggs", "due": "2026-03-05", "priority": 3,
                "description": "semi; skimmed", "parent_id": errands,
                "rule": "FREQ=WEEKLY", "url": "https://example.com/list", "scheduled_on": "2026-03-04" }),
    );
    let done = id(&w, "task.add", json!({ "title": "Post letter", "due": "2026-03-01T09:30", "reminders": [15] }));
    w.ok("task.complete", json!({ "id": done }));
    let trashed = id(&w, "task.add", json!({ "title": "Old chore" }));
    w.ok("entity.trash", json!({ "id": trashed }));
    id(&w, "task.add", json!({ "title": "No date" }));
    let before: i64 = w.one("SELECT writes FROM vault", &[]);

    let (all, text) = file(&w, json!({}));
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
    assert!(l.iter().any(|x| x.starts_with("COMPLETED:") && x.ends_with('Z')));
    assert!(has(&l, "DUE:20260301T093000"));
    assert!(has(&l, "URL:https://example.com/list"));
    assert!(has(&l, "X-CENTRAID-SCHEDULED:20260304"), "the day the member plans it is not the due");
    assert!(l.iter().any(|x| x.starts_with("X-CENTRAID-SERIES:")), "a repeat names its series");
    // The alerts are the reminder rows: the one stated (15) and the timed default (0) are both there.
    assert!(has(&l, "TRIGGER:-PT15M"));

    let (list, text) = file(&w, json!({ "list_id": errands }));
    assert_eq!(list["name"], "Errands.ics");
    assert_eq!(list["count"], 1);
    assert!(text.contains("Buy milk") && !text.contains("Post letter"));

    let (one, text) = file(&w, json!({ "task_id": milk }));
    assert_eq!(one["name"], "Buy milk, eggs.ics");
    assert_eq!(text.matches("BEGIN:VTODO").count(), 1);
    assert_eq!(w.one::<i64>("SELECT writes FROM vault", &[]), before, "an export writes nothing");
}

#[test]
fn a_zoned_due_is_written_as_the_wall_clock_of_its_zone() {
    let w = World::new("ics_tasks_zoned");
    id(&w, "task.add", json!({ "title": "Call", "due": "2026-03-02T09:30", "zone": "Europe/Paris" }));
    let (_, text) = file(&w, json!({}));
    assert!(has(&lines(&text), "DUE;TZID=Europe/Paris:20260302T093000"));
}

#[test]
fn a_reminder_carries_its_parent_tags_section_list_effort_and_star() {
    let w = World::new("ics_tasks_more");
    let errands = w.container("project", "Errands");
    let section = id(&w, "container.create", json!({ "kind": "section", "title": "This week, soon", "parent": errands }));
    let parent = id(&w, "task.add", json!({ "title": "Move house", "parent_id": errands }));
    let child = id(&w, "task.add", json!({ "title": "Pack books", "parent_id": parent, "effort_min": 90 }));
    w.ok("entity.move", json!({ "id": &parent, "parent": &section }));
    w.ok("tag.add", json!({ "id": child, "label": "boxes, heavy" }));
    w.ok("tag.add", json!({ "id": child, "label": "home" }));
    w.ok("flag.set", json!({ "id": child, "flag": "starred" }));
    let (_, text) = file(&w, json!({ "task_id": child }));
    let l = lines(&text);
    assert!(has(&l, &format!("RELATED-TO;RELTYPE=PARENT:{parent}@centraid")));
    assert!(has(&l, "CATEGORIES:boxes\\, heavy,home") || has(&l, "CATEGORIES:home,boxes\\, heavy"));
    assert!(has(&l, "ESTIMATED-DURATION:PT90M"));
    assert!(has(&l, "X-CENTRAID-STARRED:TRUE"));
    let (_, text) = file(&w, json!({ "task_id": parent }));
    let l = lines(&text);
    assert!(has(&l, "X-CENTRAID-LIST:Errands"));
    assert!(has(&l, "X-CENTRAID-SECTION:This week\\, soon"));
    assert!(!text.contains("RELATED-TO") && !text.contains("CATEGORIES"));
    assert!(!text.contains("ESTIMATED-DURATION") && !text.contains("X-CENTRAID-STARRED"));
}
