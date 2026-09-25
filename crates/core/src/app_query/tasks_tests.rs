//! Tasks' arm, through `Handle::call` — the door a shell uses.

use super::super::*;
use crate::config::CoreConfig;
use crate::handle::{Core, Handle};

/// The vault clock, stopped: 02:00Z on 2 June is still 1 June, 22:00, in New
/// York — so a test that reads "today" in UTC gets a different answer.
const NOW: &str = "2099-06-02T02:00:00.000Z";
const TZ: &str = "America/New_York";

type Q = wire::app_query_request::Query;
type A = wire::app_query_response::Answer;

struct Scratch {
    dir: std::path::PathBuf,
    handle: Handle,
    writes: std::cell::Cell<u32>,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Scratch {
    fn founded() -> Self {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let now = centraid_vault::time::recurrence::parse_instant_ms(NOW).expect("an instant");
        let handle = Core::open(CoreConfig::new(dir.join("vault.db")).with_clock(
            std::sync::Arc::new(centraid_vault::clock::FixedClock::at(now)),
            std::sync::Arc::new(centraid_vault::clock::ClockIds::new(Box::new(
                centraid_vault::clock::FixedClock::at(now),
            ))),
        ))
        .expect("it opens");
        handle
            .with_vault(|vault| Ok(vault.found("Tasks", "Owner")?))
            .expect("it founds");
        Self {
            dir,
            handle,
            writes: std::cell::Cell::new(0),
        }
    }

    fn ask(&self, query: Q) -> Result<A> {
        match self.handle.call(&wire::Request {
            kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                query: Some(query),
            })),
        })? {
            wire::Response {
                kind: Some(wire::response::Kind::AppQuery(answer)),
            } => Ok(answer.answer.expect("an app query is answered")),
            other => panic!("an app query answered as {other:?}"),
        }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        self.writes.set(self.writes.get() + 1);
        let response = self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Command(wire::Command {
                    name: name.to_owned(),
                    input: serde_json::to_vec(&input).expect("json"),
                    invoke_key: format!("tasks-query-test-{}", self.writes.get()),
                    ..wire::Command::default()
                })),
            })
            .unwrap_or_else(|error| panic!("{name} refused: {error}"));
        let Some(wire::response::Kind::Command(outcome)) = response.kind else {
            panic!("a command answered with something else");
        };
        assert_eq!(
            outcome.status,
            wire::CommandStatus::Executed as i32,
            "{name}: {}",
            outcome.reason
        );
        serde_json::from_slice(&outcome.output).expect("the output is JSON")
    }

    fn add(&self, input: serde_json::Value) -> String {
        self.run("schedule.add_task", input)["task_id"]
            .as_str()
            .expect("a task id")
            .to_owned()
    }

    fn titled(&self, title: &str, due: Option<&str>) -> String {
        let mut input = serde_json::json!({ "title": title });
        if let Some(due) = due {
            input["due_at"] = serde_json::json!(due);
        }
        self.add(input)
    }

    fn board(&self, view: wire::TasksView) -> wire::TasksBoard {
        self.board_for(view, "")
    }

    fn board_for(&self, view: wire::TasksView, project_id: &str) -> wire::TasksBoard {
        match self
            .ask(Q::TasksBoard(wire::TasksBoardRequest {
                tz: TZ.to_owned(),
                limit: 0,
                view: view as i32,
                project_id: project_id.to_owned(),
            }))
            .expect("the board answers")
        {
            A::TasksBoard(board) => board,
            other => panic!("the board answered as {other:?}"),
        }
    }

    fn detail(&self, task_id: &str) -> wire::TasksTaskDetail {
        match self
            .ask(Q::TasksTask(wire::TasksTaskRequest {
                task_id: task_id.to_owned(),
                tz: TZ.to_owned(),
            }))
            .expect("the task answers")
        {
            A::TasksTask(detail) => *detail,
            other => panic!("the task answered as {other:?}"),
        }
    }

    fn catch_up(&self) -> wire::TasksCatchUp {
        match self
            .ask(Q::TasksCatchUp(wire::TasksCatchUpRequest {
                tz: TZ.to_owned(),
            }))
            .expect("catch up answers")
        {
            A::TasksCatchUp(piles) => piles,
            other => panic!("catch up answered as {other:?}"),
        }
    }
}

fn titles(group: &wire::TasksGroup) -> Vec<&str> {
    group.tasks.iter().map(|task| task.title.as_str()).collect()
}

fn every_id(board: &wire::TasksBoard) -> Vec<String> {
    fn walk(task: &wire::TasksTask, out: &mut Vec<String>) {
        out.push(task.task_id.clone());
        for child in &task.children {
            walk(child, out);
        }
    }
    let mut out = Vec::new();
    for group in &board.groups {
        for task in &group.tasks {
            walk(task, &mut out);
        }
    }
    out
}

/// TODAY IS THE DEVICE'S DAY: 01:00Z on the 2nd is 21:00 on the 1st in New
/// York, so it is due TODAY, and a UTC reading would call it tomorrow. The
/// overdue group leads, and Upcoming is keyed by the local day.
#[test]
fn the_board_groups_today_in_the_request_zone() {
    let scratch = Scratch::founded();
    scratch.titled("Late", Some("2099-05-30"));
    scratch.titled("Tonight", Some("2099-06-02T01:00:00.000Z"));
    scratch.titled("Tomorrow", Some("2099-06-02"));
    scratch.titled("Someday", None);

    let today = scratch.board(wire::TasksView::Today);
    assert_eq!(today.today, "2099-06-01");
    assert_eq!(today.now_local, "2099-06-01T22:00");
    assert_eq!(today.groups.len(), 2);
    assert_eq!(today.groups[0].kind, wire::TasksGroupKind::Overdue as i32);
    assert_eq!(titles(&today.groups[0]), ["Late"]);
    assert_eq!(titles(&today.groups[1]), ["Tonight"]);
    let tonight = &today.groups[1].tasks[0];
    assert_eq!(tonight.due_local, "2099-06-01T21:00");
    assert_eq!(tonight.due_time, "21:00");
    assert!(tonight.lands_today && !tonight.overdue);
    assert_eq!(today.groups[0].tasks[0].days_from_today, Some(-2));

    let upcoming = scratch.board(wire::TasksView::Upcoming);
    assert_eq!(upcoming.groups.len(), 1);
    assert_eq!(upcoming.groups[0].day, "2099-06-02");
    assert_eq!(titles(&upcoming.groups[0]), ["Tomorrow"]);

    let counts = today.counts.expect("counts");
    assert_eq!(
        (
            counts.overdue,
            counts.today,
            counts.upcoming,
            counts.anytime
        ),
        (1, 1, 1, 1)
    );
    assert_eq!(counts.inbox, 4, "nothing is filed");
    assert_eq!(today.window, 500, "zero is the manifest's default window");
    assert!(!today.truncated);
}

/// THE TRASH IS NOT THE BOARD. `schedule.delete_task` trashes a task and its
/// subtasks; before #1046 every board statement brought them back — on the
/// open board, in the logbook, and as a promoted orphan.
#[test]
fn a_trashed_task_and_its_family_are_on_no_place() {
    let scratch = Scratch::founded();
    let kept = scratch.titled("Kept", None);
    let parent = scratch.titled("Trashed parent", Some("2099-06-05"));
    let child = scratch.add(serde_json::json!({ "title": "Its child", "parent_task_id": parent }));
    let done = scratch.titled("Done then trashed", None);
    scratch.run(
        "schedule.set_task_status",
        serde_json::json!({ "task_id": done, "status": "completed" }),
    );
    scratch.run(
        "schedule.delete_task",
        serde_json::json!({ "task_id": parent }),
    );
    scratch.run(
        "schedule.delete_task",
        serde_json::json!({ "task_id": done }),
    );

    let all = scratch.board(wire::TasksView::All);
    let logbook = scratch.board(wire::TasksView::Logbook);
    let seen: Vec<String> = every_id(&all)
        .into_iter()
        .chain(every_id(&logbook))
        .collect();
    assert_eq!(seen, std::slice::from_ref(&kept));
    for gone in [&parent, &child, &done] {
        assert!(!seen.contains(gone));
        assert!(
            scratch.detail(gone).task.is_none(),
            "the detail does not open the trash"
        );
    }
    let counts = all.counts.expect("counts");
    assert_eq!((counts.open, counts.closed), (1, 0));
}

/// THE FOLD ACROSS DST, AND THE REMINDER. The same UTC hour reads 09:00 in
/// January (EST) and 10:00 in July (EDT); the reminder's lead time is read
/// back — v0 never read it — and its wall clock is the due less the lead.
#[test]
fn local_times_follow_daylight_saving_and_the_reminder_is_read() {
    let scratch = Scratch::founded();
    scratch.add(serde_json::json!({
        "title": "Winter", "due_at": "2100-01-15T14:00:00.000Z", "remind_before_min": 30,
    }));
    scratch.add(serde_json::json!({
        "title": "Summer", "due_at": "2099-07-15T14:00:00.000Z", "remind_before_min": 90,
    }));
    scratch.add(serde_json::json!({
        "title": "Dated only", "due_at": "2099-07-20", "remind_before_min": 15,
    }));
    let all = scratch.board(wire::TasksView::All);
    let dated = &all.groups[0];
    assert_eq!(dated.kind, wire::TasksGroupKind::Dated as i32);
    assert_eq!(titles(dated), ["Summer", "Dated only", "Winter"]);
    let summer = &dated.tasks[0];
    assert_eq!(summer.due_time, "10:00");
    assert_eq!(summer.remind_before_min, Some(90));
    assert_eq!(summer.remind_at_local, "2099-07-15T08:30");
    let winter = &dated.tasks[2];
    assert_eq!(winter.due_time, "09:00");
    assert_eq!(winter.remind_at_local, "2100-01-15T08:30");
    let dated_only = &dated.tasks[1];
    assert_eq!(dated_only.due_local, "2099-07-20");
    assert_eq!(dated_only.due_time, "");
    assert_eq!(dated_only.remind_at_local, "", "a date has no moment");

    let reminders = scratch.board(wire::TasksView::Reminders);
    assert_eq!(titles(&reminders.groups[0]).len(), 3);
    assert_eq!(reminders.counts.expect("counts").reminders, 3);
}

/// A REPEATING TASK CARRIES ITS SENTENCE, built in Rust — v0's phone drew
/// "—" for every cadence — and its raw rule, which only the editor's repeat
/// picker reads (to pre-select and send back); a shell never expands it.
#[test]
fn a_repeating_task_carries_its_summary_and_next_period() {
    let scratch = Scratch::founded();
    let daily = scratch.add(serde_json::json!({
        "title": "Water the plants", "due_at": "2099-05-20", "rrule": "FREQ=DAILY",
    }));
    let detail = scratch.detail(&daily);
    let task = detail.task.expect("the task");
    assert!(task.repeats);
    assert_eq!(task.recurrence_summary.as_deref(), Some("Daily"));
    assert_eq!(task.rrule.as_deref(), Some("FREQ=DAILY"));
    assert!(task.missed > 0, "the unactioned days collapse into a count");
    assert!(task.next_due.is_some());
    assert!(
        !task.overdue,
        "the next period stands in for the stored due"
    );
}

/// ONE TASK, WHEREVER IT IS: its family, its parent, its project and section.
#[test]
fn the_detail_answers_the_family_and_the_filing() {
    let scratch = Scratch::founded();
    let project = scratch.run(
        "schedule.save_project",
        serde_json::json!({ "name": "House" }),
    )["project_id"]
        .as_str()
        .expect("a project")
        .to_owned();
    let section = scratch.run(
        "schedule.save_section",
        serde_json::json!({ "project_id": project, "name": "Kitchen" }),
    )["section_id"]
        .as_str()
        .expect("a section")
        .to_owned();
    let parent = scratch.titled("Paint the kitchen", Some("2099-06-10"));
    scratch.run(
        "schedule.organize_task",
        serde_json::json!({
            "task_id": parent, "project_id": project, "section_id": section, "sort_order": 1,
            "tz": "Europe/London",
        }),
    );
    let open_child =
        scratch.add(serde_json::json!({ "title": "Buy paint", "parent_task_id": parent }));
    let done_child =
        scratch.add(serde_json::json!({ "title": "Tape edges", "parent_task_id": parent }));
    scratch.run(
        "schedule.set_task_status",
        serde_json::json!({ "task_id": done_child, "status": "completed" }),
    );

    let detail = scratch.detail(&parent);
    let task = detail.task.expect("the task");
    assert_eq!(task.children.len(), 2);
    assert_eq!(task.done_children, 1);
    assert_eq!(
        task.tz.as_deref(),
        Some("Europe/London"),
        "organize-task's `tz` lands"
    );
    assert_eq!(detail.project.expect("filed").name, "House");
    assert_eq!(detail.section.expect("sectioned").name, "Kitchen");
    assert!(detail.parent.is_none());

    let child = scratch.detail(&open_child);
    assert_eq!(child.parent.expect("a parent").task_id, parent);

    let unknown = scratch.detail("no-such-task");
    assert!(unknown.task.is_none());
    assert_eq!(unknown.today, "2099-06-01");

    // THE PROJECT PLACE answers every section, and the projects list counts.
    let board = scratch.board_for(wire::TasksView::Project, &project);
    assert_eq!(board.groups.len(), 1);
    assert_eq!(board.groups[0].kind, wire::TasksGroupKind::Section as i32);
    assert_eq!(
        board.groups[0].section_id.as_deref(),
        Some(section.as_str())
    );
    let A::TasksProjects(projects) = scratch
        .ask(Q::TasksProjects(wire::TasksProjectsRequest {
            tz: TZ.to_owned(),
        }))
        .expect("projects answer")
    else {
        panic!("projects answered as something else");
    };
    assert_eq!(projects.projects[0].open_count, 1);
    assert_eq!(projects.sections[0].open_count, 1);
    assert_eq!(projects.inbox_count, 0);
    // A PROJECT PLACE NAMING NO PROJECT is the request's fault.
    let refused = scratch
        .ask(Q::TasksBoard(wire::TasksBoardRequest {
            tz: TZ.to_owned(),
            view: wire::TasksView::Project as i32,
            ..wire::TasksBoardRequest::default()
        }))
        .expect_err("no project is refused");
    assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
}

/// SEARCH, THROUGH THE FTS DOOR AND THE PAGE DOOR, with the trash left out
/// and a zero limit refused.
#[test]
fn search_answers_ranked_live_tasks() {
    let scratch = Scratch::founded();
    let cabin = scratch.titled("Book the cabin", Some("2099-06-03"));
    let trashed = scratch.titled("Cabin deposit", None);
    scratch.titled("Dentist", None);
    scratch.run(
        "schedule.delete_task",
        serde_json::json!({ "task_id": trashed }),
    );
    let search = |limit: u32| {
        scratch.ask(Q::TasksSearch(wire::TasksSearchRequest {
            term: "cabin".to_owned(),
            limit,
            tz: TZ.to_owned(),
        }))
    };
    let A::TasksSearch(found) = search(10).expect("search answers") else {
        panic!("search answered as something else");
    };
    let ids: Vec<&str> = found
        .tasks
        .iter()
        .map(|task| task.task_id.as_str())
        .collect();
    assert_eq!(ids, [cabin.as_str()]);
    assert_eq!(found.tasks[0].due_day, "2099-06-03");
    assert!(
        found.tasks[0]
            .snippet
            .as_deref()
            .is_some_and(|s| s.contains('⟦'))
    );
    assert_eq!(
        search(0).expect_err("zero is refused").code(),
        wire::ErrorCode::InvalidRequest
    );
}

/// CATCH UP: each overdue row in one pile, and a week away named.
#[test]
fn catch_up_names_a_long_absence() {
    let scratch = Scratch::founded();
    scratch.titled("Ten days late", Some("2099-05-22"));
    scratch.titled("Yesterday", Some("2099-05-31"));
    scratch.titled("Undated and fresh", None);
    let piles = scratch.catch_up();
    let late: Vec<&str> = piles.dated.iter().map(|task| task.title.as_str()).collect();
    assert_eq!(late, ["Ten days late", "Yesterday"]);
    assert!(piles.repeating.is_empty());
    // `sitting` is not asserted here: `schedule.add_task` stamps `created_at`
    // from SQLite's own clock, not the vault clock this test stops in 2099, so
    // every task made here "sat" since today's real date (an owner question in
    // the crate README). `views`' own tests cover the pile.
    assert_eq!((piles.away_days, piles.overdue), (10, 2));
    assert!(piles.absent);
}

/// AN EMPTY VAULT is an answer on every place, not a refusal.
#[test]
fn an_empty_vault_answers_every_place_empty() {
    let scratch = Scratch::founded();
    for view in [
        wire::TasksView::Unspecified,
        wire::TasksView::Today,
        wire::TasksView::Upcoming,
        wire::TasksView::Inbox,
        wire::TasksView::Anytime,
        wire::TasksView::All,
        wire::TasksView::Logbook,
        wire::TasksView::Reminders,
    ] {
        let board = scratch.board(view);
        assert!(board.groups.is_empty(), "{view:?}");
        assert_eq!(board.counts, Some(wire::TasksCounts::default()));
        assert_eq!(board.view, view as i32);
    }
    let piles = scratch.catch_up();
    assert!(piles.dated.is_empty() && !piles.absent);
    assert_eq!(piles.today, "2099-06-01");
}

/// THE ZONE RULE: an unknown name is refused, never demoted to UTC.
#[test]
fn an_unknown_zone_is_refused() {
    let scratch = Scratch::founded();
    let refused = scratch
        .ask(Q::TasksCatchUp(wire::TasksCatchUpRequest {
            tz: "Mars/Olympus_Mons".to_owned(),
        }))
        .expect_err("refused");
    assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
}

/// A DENIAL IS A STATE: Tasks' `Denial` reaches the wire as the `denied` arm,
/// field for field.
#[test]
fn a_tasks_denial_is_answered_as_the_denied_arm() {
    let scratch = Scratch::founded();
    scratch
        .handle
        .with_vault(|vault| {
            let door = VaultDoor::new(vault);
            let denial = centraid_apps_tasks::Denial {
                code: Some("revoked".to_owned()),
                message: Some("Tasks may not read".to_owned()),
                revoked_at: None,
            };
            let settled = settle(&door, Ok((0_u8, Some(denial))), |_| {
                unreachable!("a denial carries no data")
            })
            .expect("a denial is not an error");
            let A::Denied(denied) = settled else {
                panic!("answered as {settled:?}");
            };
            assert_eq!(denied.code.as_deref(), Some("revoked"));
            assert_eq!(denied.message.as_deref(), Some("Tasks may not read"));
            Ok(())
        })
        .expect("the vault is open");
}
