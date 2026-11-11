//! CALENDAR'S EXPORT (`calendar.export`, #1185), the kit's one export screen over
//! `event.export_ics`: the rows are "All calendars" and each calendar, and the calendar file the
//! command answers goes to the OS save sheet once the owner check passed.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::export::{self, Choice, ExportSpec};
use crate::kit::owner::NoPasscode;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, agenda as words};

/// The row that exports every calendar.
const ALL: &str = "all";

static SPEC: ExportSpec = ExportSpec {
    app: "calendar",
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

/// The gate drawn when the vault will not let Calendar read.
fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: words::denied_title(locale),
        body: words::denied_body(locale),
        receipt: denial.code.clone().unwrap_or_default(),
    }
}

fn choices(ctx: &Ctx) -> Reading<Vec<Choice>> {
    let upcoming = read::read(
        ctx,
        load::calendar::Upcoming::default(),
        |answer| match answer {
            Answer::AgendaUpcoming(upcoming) => Some(upcoming),
            _ => None,
        },
    );
    match upcoming {
        Reading::Data(upcoming) => {
            let mut rows = vec![Choice {
                key: ALL.to_owned(),
                label: words::export_all(ctx.locale()),
                value: String::new(),
            }];
            rows.extend(upcoming.calendars.iter().map(|calendar| Choice {
                key: calendar.calendar_id.clone(),
                label: calendar.name.clone().unwrap_or_default(),
                value: String::new(),
            }));
            Reading::Data(rows)
        }
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}

/// The calendar file of one calendar (`calendar_id`) or of one event (`event_id`), through the
/// same command the export screen calls.
pub fn file(
    ctx: &Ctx,
    calendar_id: Option<&str>,
    event_id: Option<&str>,
) -> Result<export::ExportFile, String> {
    // undo-exempt: an export writes nothing (`writes_nothing` in the manifest), so there is nothing to take back.
    let settled = kit_act::act(
        ctx,
        act::calendar::ExportIcs {
            calendar_id: calendar_id.map(str::to_owned),
            event_id: event_id.map(str::to_owned),
        },
        &kit_act::key(
            &[
                "event.export_ics",
                calendar_id.unwrap_or_default(),
                event_id.unwrap_or_default(),
            ],
            kit_act::fresh(),
        ),
    );
    if event_id.is_some()
        && settled.committed
        && crate::kit::transfer::count(&settled.output, "count") == 0
    {
        return Err(String::new());
    }
    export::file_of(&settled, "text/calendar", "Calendar.ics")
}

fn export(ctx: &Ctx, key: &str) -> Result<export::Made, String> {
    file(ctx, (key != ALL).then_some(key), None).map(Into::into)
}
