//! THE TASK WRITE OPERATION (#996 R21; drift ONT-26, ONT-31).
//!
//! Every writer that puts a row into `schedule_task` — `schedule.add_task`,
//! `schedule.edit_task`, `schedule.organize_task`, People's task commands, the
//! completion operation, an import and Atlas' row editor — asks the same five
//! questions of the same proposed row image. Before this they asked five
//! different subsets: Atlas accepted a task as its own parent and
//! `due_at: "banana"`; the domain command checked the parent was open and
//! top-level but not that the hierarchy was acyclic; nothing checked that a
//! section belonged to the task's project.
//!
//! **The image is the row AS IT WILL BE**: on an update the stored row is
//! loaded and the draft's stated fields applied over it, so "move this task
//! under its own child" is judged on the resulting graph rather than on the
//! two ids in the request.

use rusqlite::Connection;

use crate::time::{rrule, temporal};

/// A stated field.
///
/// **Three states, spelled** (census §A seam 5): `Option<Option<T>>` collapses
/// "unchanged" and "cleared" for every reader that forgets which nesting is
/// which, and the failure mode is a silently unfiled task.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Stated<T> {
    /// The draft says nothing; the stored value stands.
    #[default]
    Unchanged,
    /// The draft explicitly clears the field.
    Cleared,
    /// The draft sets the field.
    Set(T),
}

impl<T> Stated<T> {
    /// v0's `settle`: the stated value, else what is stored.
    fn settle(self, current: Option<T>) -> Option<T> {
        match self {
            Self::Unchanged => current,
            Self::Cleared => None,
            Self::Set(value) => Some(value),
        }
    }

    /// A stated string, from an optional input plus an explicit `clear_*` flag.
    #[must_use]
    pub fn read(value: Option<T>, cleared: bool) -> Self {
        if cleared {
            return Self::Cleared;
        }
        value.map_or(Self::Unchanged, Self::Set)
    }
}

/// The proposed row image, in the operation's own vocabulary.
#[derive(Debug, Clone, Default)]
pub struct TaskWriteDraft {
    /// The row being written; `None` for an insert that has not minted one.
    pub task_id: Option<String>,
    pub parent_task_id: Stated<String>,
    pub project_id: Stated<String>,
    pub section_id: Stated<String>,
    pub due_at: Stated<String>,
    pub rrule: Stated<String>,
    pub status: Stated<String>,
}

/// The row as it will be after the draft lands.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskImage {
    pub task_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub project_id: Option<String>,
    pub section_id: Option<String>,
    pub due_at: Option<String>,
    pub rrule: Option<String>,
    pub status: Option<String>,
}

struct StoredTask {
    parent_task_id: Option<String>,
    project_id: Option<String>,
    section_id: Option<String>,
    due_at: Option<String>,
    rrule: Option<String>,
    status: String,
}

fn stored(connection: &Connection, task_id: &str) -> Option<StoredTask> {
    connection
        .query_row(
            "SELECT parent_task_id, project_id, section_id, due_at, rrule, status
               FROM schedule_task WHERE task_id = ?1",
            [task_id],
            |row| {
                Ok(StoredTask {
                    parent_task_id: row.get(0)?,
                    project_id: row.get(1)?,
                    section_id: row.get(2)?,
                    due_at: row.get(3)?,
                    rrule: row.get(4)?,
                    status: row.get(5)?,
                })
            },
        )
        .ok()
}

/// The row as it will be after `draft` lands.
#[must_use]
pub fn task_image(connection: &Connection, draft: TaskWriteDraft) -> TaskImage {
    let current = draft
        .task_id
        .as_deref()
        .and_then(|task_id| stored(connection, task_id));
    let (parent, project, section, due, rule, status) = match current {
        Some(row) => (
            row.parent_task_id,
            row.project_id,
            row.section_id,
            row.due_at,
            row.rrule,
            Some(row.status),
        ),
        None => (None, None, None, None, None, None),
    };
    TaskImage {
        task_id: draft.task_id,
        parent_task_id: draft.parent_task_id.settle(parent),
        project_id: draft.project_id.settle(project),
        section_id: draft.section_id.settle(section),
        due_at: draft.due_at.settle(due),
        rrule: draft.rrule.settle(rule),
        status: draft.status.settle(status),
    }
}

/// How deep a subtask chain may be walked before the walk itself is the bug.
pub const MAX_HIERARCHY_DEPTH: usize = 256;

/// One condition of the operation, and the SENTENCE it says when it fails.
pub struct TaskCondition {
    pub name: &'static str,
    pub assert: fn(&Connection, &TaskImage) -> Option<String>,
}

/// The five questions, in the order a member should read them.
pub static TASK_WRITE_CONDITIONS: &[TaskCondition] = &[
    TaskCondition {
        // ONT-31. `banana` stored, and completion then silently had no
        // successor: an unreadable due date is indistinguishable from no due
        // date at read time, so the series just stopped and nothing said why.
        name: "task_due_at_is_a_time",
        assert: |_connection, image| {
            let due = image.due_at.as_deref()?;
            match temporal::classify(due) {
                Some(
                    temporal::Kind::Instant
                    | temporal::Kind::FloatingDateTime
                    | temporal::Kind::LocalDate,
                ) => None,
                _ => Some(temporal::refusal(
                    "due_at",
                    due,
                    &[
                        temporal::Kind::Instant,
                        temporal::Kind::FloatingDateTime,
                        temporal::Kind::LocalDate,
                    ],
                )),
            }
        },
    },
    TaskCondition {
        // ONT-31's other half. A rule outside the expander's subset is refused
        // HERE rather than stored as an executable rule that quietly expands
        // to the wrong dates — the failure the rrule refusal was built for.
        name: "task_rrule_is_supported",
        assert: |_connection, image| {
            let rule = image.rrule.as_deref()?;
            rrule::inspect(rule).err().map(|refusal| {
                format!(
                    "rrule: {} — {}",
                    serde_json::Value::String(rule.to_owned()),
                    refusal.message()
                )
            })
        },
    },
    TaskCondition {
        // A rule advances `due_at` on completion, so a rule with nothing to
        // advance never recurs. Held for EVERY writer, not just the command
        // whose input schema happened to say so.
        name: "task_rrule_needs_a_due_at",
        assert: |_connection, image| {
            (image.rrule.is_some() && image.due_at.is_none())
                .then(|| "A repeating task needs a due date to repeat from.".to_owned())
        },
    },
    TaskCondition {
        // ONT-26's headline: Atlas accepted a task as its own parent, and a
        // longer cycle was reachable through any writer. The walk climbs the
        // PROPOSED graph, so a move that would close a loop is refused before
        // it lands.
        name: "task_hierarchy_is_acyclic",
        assert: |connection, image| {
            let parent = image.parent_task_id.as_deref()?;
            if image.task_id.as_deref() == Some(parent) {
                return Some("A task cannot be its own parent.".to_owned());
            }
            let mut seen: std::collections::BTreeSet<String> = image
                .task_id
                .as_deref()
                .map(|id| std::iter::once(id.to_owned()).collect())
                .unwrap_or_default();
            let mut cursor = Some(parent.to_owned());
            let mut depth = 0_usize;
            while let Some(current) = cursor {
                if seen.contains(&current) {
                    return Some(
                        "That parent is already below this task — a task hierarchy has no loops."
                            .to_owned(),
                    );
                }
                if depth >= MAX_HIERARCHY_DEPTH {
                    return Some("That task hierarchy is too deep to be a hierarchy.".to_owned());
                }
                seen.insert(current.clone());
                let parent_row = stored(connection, &current)?;
                cursor = parent_row.parent_task_id;
                depth += 1;
            }
            None
        },
    },
    TaskCondition {
        // A section belongs to exactly one project, so a task filed in a
        // section of another project is in two places at once — the state no
        // reader can render and every writer used to be able to create.
        name: "task_section_agrees_with_project",
        assert: |connection, image| {
            let section_id = image.section_id.as_deref()?;
            let found: Option<String> = connection
                .query_row(
                    "SELECT project_id FROM schedule_section WHERE section_id = ?1",
                    [section_id],
                    |row| row.get(0),
                )
                .ok();
            let Some(project_of_section) = found else {
                return Some("That section does not exist.".to_owned());
            };
            let Some(project_id) = image.project_id.as_deref() else {
                return Some(
                    "A task in a section is in that section's project — file it in the project too."
                        .to_owned(),
                );
            };
            (project_of_section != project_id)
                .then(|| "That section belongs to a different project.".to_owned())
        },
    },
];

/// A refusal: the condition that failed, and what the member reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRefusal {
    pub condition: &'static str,
    pub message: String,
}

/// The first failing condition, or `None`.
#[must_use]
pub fn assert_task_write(connection: &Connection, draft: TaskWriteDraft) -> Option<TaskRefusal> {
    let image = task_image(connection, draft);
    TASK_WRITE_CONDITIONS.iter().find_map(|condition| {
        (condition.assert)(connection, &image).map(|message| TaskRefusal {
            condition: condition.name,
            message,
        })
    })
}
