//! REMINDERS' EXPORT (`reminders.export`, #1185), the kit's one export screen over
//! `task.export_ics`: the rows are "All lists" and each list, and the calendar file of to-dos the
//! command answers goes to the OS save sheet once the owner check passed.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::export::{self, Choice, ExportSpec};
use crate::kit::owner::NoPasscode;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, task as words};

/// The row that exports every list.
const ALL: &str = "all";

static SPEC: ExportSpec = ExportSpec {
    app: "reminders",
    title: words::export_title,
    lede: words::export_lede,
    back_label: words::app_title,
    denied,
    choices,
    export,
    no_passcode: NoPasscode::Warn,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    export::build(&SPEC, route)
}

/// The gate drawn when the vault will not let Reminders read its tasks.
fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: words::denied_title(locale),
        body: words::denied_body(locale),
        receipt: denial.code.clone().unwrap_or_default(),
    }
}

fn choices(ctx: &Ctx) -> Reading<Vec<Choice>> {
    let projects = read::read(
        ctx,
        load::reminders::Projects::default(),
        |answer| match answer {
            Answer::AgendaTaskProjects(projects) => Some(projects),
            _ => None,
        },
    );
    match projects {
        Reading::Data(projects) => {
            let mut rows = vec![Choice {
                key: ALL.to_owned(),
                label: words::export_all(ctx.locale()),
                value: String::new(),
            }];
            rows.extend(projects.projects.iter().map(|project| Choice {
                key: project.project_id.clone(),
                label: project.name.clone(),
                value: String::new(),
            }));
            Reading::Data(rows)
        }
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}

/// The calendar file of one list (`list_id`) or of one reminder (`task_id`), through the same
/// command the export screen calls.
pub fn file(
    ctx: &Ctx,
    list_id: Option<&str>,
    task_id: Option<&str>,
) -> Result<export::ExportFile, String> {
    let settled = kit_act::act(
        ctx,
        act::reminders::ExportIcs {
            list_id: list_id.map(str::to_owned),
            task_id: task_id.map(str::to_owned),
        },
        &kit_act::key(
            &[
                "task.export_ics",
                list_id.unwrap_or_default(),
                task_id.unwrap_or_default(),
            ],
            kit_act::fresh(),
        ),
    );
    if task_id.is_some()
        && settled.committed
        && crate::kit::transfer::count(&settled.output, "count") == 0
    {
        return Err(String::new());
    }
    export::file_of(&settled, "text/calendar", "Reminders.ics")
}

fn export(ctx: &Ctx, key: &str) -> Result<export::ExportFile, String> {
    file(ctx, (key != ALL).then_some(key), None)
}
