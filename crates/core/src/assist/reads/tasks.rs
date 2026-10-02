//! Tasks' three reads: a view or a project, a search, and the projects.

use centraid_api_proto::core_v1 as wire;
use centraid_assist::{App, Card, ReadError, ToolCall, ToolOutput};

use super::{Answer, Env, Query, ROWS, counted, text, title_or, unexpected};

fn card(task: &wire::TasksTask) -> Card {
    // A finished task is done whatever its date says: the logbook lists
    // completed work whose due day has long passed.
    let meta = if task.status == "completed" {
        "done"
    } else if task.overdue {
        "overdue"
    } else {
        ""
    };
    Card::new(
        App::Tasks,
        "task",
        &task.task_id,
        title_or(Some(&task.title), "", "Untitled task"),
    )
    .subtitle(&task.due_day)
    .meta(meta)
}

fn board(
    env: &Env<'_>,
    view: wire::TasksView,
    project_id: &str,
) -> Result<wire::TasksBoard, ReadError> {
    match env.ask(Query::TasksBoard(wire::TasksBoardRequest {
        tz: env.tz.to_owned(),
        limit: 30,
        view: view as i32,
        project_id: project_id.to_owned(),
    }))? {
        Answer::TasksBoard(board) => Ok(board),
        _ => Err(unexpected("tasks.list")),
    }
}

fn projects_of(env: &Env<'_>) -> Result<wire::TasksProjects, ReadError> {
    match env.ask(Query::TasksProjects(wire::TasksProjectsRequest {
        tz: env.tz.to_owned(),
    }))? {
        Answer::TasksProjects(projects) => Ok(projects),
        _ => Err(unexpected("tasks.projects")),
    }
}

/// The project a member named: an exact name first, then one that contains it.
fn project_named<'a>(
    projects: &'a [wire::TasksProject],
    named: &str,
) -> Option<&'a wire::TasksProject> {
    let named = named.to_lowercase();
    projects
        .iter()
        .find(|project| project.name.to_lowercase() == named)
        .or_else(|| {
            projects
                .iter()
                .find(|project| project.name.to_lowercase().contains(&named))
        })
}

/// `tasks.list`: a view of the board, or one project's.
pub(super) fn list(env: &Env<'_>, call: &ToolCall) -> Result<ToolOutput, ReadError> {
    if let Some(named) = call.arg("project") {
        let projects = projects_of(env)?;
        let Some(project) = project_named(&projects.projects, named) else {
            return Ok(ToolOutput::of_rows(
                format!("No project named \"{named}\""),
                Vec::new(),
            ));
        };
        let answered = board(env, wire::TasksView::Project, &project.project_id)?;
        let rows = tasks_of(&answered, |_| true);
        let headline = format!(
            "{} in {}",
            counted(rows.len(), "task", "tasks"),
            project.name
        );
        return Ok(ToolOutput::of_rows(headline, rows));
    }
    let view = call.arg("view").unwrap_or("today");
    let (asked, label) = match view {
        "upcoming" => (wire::TasksView::Upcoming, "upcoming"),
        "overdue" => (wire::TasksView::Today, "overdue"),
        "inbox" => (wire::TasksView::Inbox, "in the inbox"),
        "anytime" => (wire::TasksView::Anytime, "for anytime"),
        "done" => (wire::TasksView::Logbook, "done recently"),
        _ => (wire::TasksView::Today, "for today"),
    };
    let answered = board(env, asked, "")?;
    let overdue_only = view == "overdue";
    let rows = tasks_of(&answered, |group| {
        !overdue_only || group.kind == wire::TasksGroupKind::Overdue as i32
    });
    let late = rows.iter().filter(|card| card.meta == "overdue").count();
    let mut headline = format!("{} {label}", counted(rows.len(), "task", "tasks"));
    if view == "today" && late > 0 && late < rows.len() {
        headline.push_str(&format!(", {late} overdue"));
    }
    Ok(ToolOutput::of_rows(headline, rows))
}

fn tasks_of(board: &wire::TasksBoard, keep: impl Fn(&wire::TasksGroup) -> bool) -> Vec<Card> {
    board
        .groups
        .iter()
        .filter(|group| keep(group))
        .flat_map(|group| group.tasks.iter())
        .take(ROWS as usize)
        .map(card)
        .collect()
}

/// `tasks.search`.
pub(super) fn search(env: &Env<'_>, call: &ToolCall) -> Result<ToolOutput, ReadError> {
    let term = call.arg("term").unwrap_or_default();
    let Answer::TasksSearch(answer) = env.ask(Query::TasksSearch(wire::TasksSearchRequest {
        term: term.to_owned(),
        limit: ROWS,
        tz: env.tz.to_owned(),
    }))?
    else {
        return Err(unexpected("tasks.search"));
    };
    let rows: Vec<Card> = answer.tasks.iter().map(card).collect();
    Ok(ToolOutput::of_rows(
        format!(
            "{} matching \"{term}\"",
            counted(rows.len(), "task", "tasks")
        ),
        rows,
    ))
}

/// `tasks.projects`.
pub(super) fn projects(env: &Env<'_>, _: &ToolCall) -> Result<ToolOutput, ReadError> {
    let answered = projects_of(env)?;
    let rows: Vec<Card> = answered
        .projects
        .iter()
        .take(ROWS as usize)
        .map(|project| {
            Card::new(App::Tasks, "project", &project.project_id, &project.name)
                .subtitle(format!("{} open", project.open_count))
                .meta(text(&project.area))
        })
        .collect();
    Ok(ToolOutput::of_rows(
        counted(rows.len(), "project", "projects"),
        rows,
    ))
}
