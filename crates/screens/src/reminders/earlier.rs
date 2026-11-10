//! REMINDERS' EARLIER VERSIONS: the kit's one earlier-versions screen with Reminders' spec (#1185).
//!
//! A task keeps its title, notes, due day and time, repeat and what it repeats from, reminder
//! lead, link, effort, priority, status, and its list and section. A version's line is the ones it
//! held, as the task page words them: `Pay rent · Thu 5 March, 09:00 · Every month · Home`. The due
//! day is the day as written ("Thu 5 March"), never "Today", which a past version cannot mean. What the page
//! does not show (the zone, the position, the parent) has no words; a version that changed only
//! those reads "Other details".

use centraid_api_proto::core_v1 as wire;
use serde_json::Value;
use wire::app_query_response::Answer;

use super::detail::lead_label;
use super::list;
use crate::catalog::load;
use crate::kit::civil;
use crate::kit::earlier::{self, EarlierSpec, Field, Look, Names};
use crate::kit::read::{self, Reading};
use crate::kit::schedule::{rows, rule_words};
use crate::screen::{Ctx, Screen};
use crate::strings::{agenda_event as link_words, shared, task as words};

/// Reminders' earlier versions, as the kit's screen takes it.
pub static SPEC: EarlierSpec = EarlierSpec {
    app: "reminders",
    noun: shared::trash_noun_task,
    denied: list::denied,
    line,
    know: Some(know),
    gate: None,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    earlier::build(&SPEC, route)
}

/// The names of the lists and sections a version names by id, as the page names them.
fn know(ctx: &Ctx, _task_id: &str) -> Names {
    let mut names = Names::new();
    if let Reading::Data(projects) = read::read(
        ctx,
        load::reminders::Projects::default(),
        |answer| match answer {
            Answer::AgendaTaskProjects(projects) => Some(projects),
            _ => None,
        },
    ) {
        for project in &projects.projects {
            names.insert(project.project_id.clone(), project.name.clone());
        }
        for section in &projects.sections {
            names.insert(section.section_id.clone(), section.name.clone());
        }
    }
    names
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The due day and time as the page words them: `Thu 5 March, 09:00`, or the day alone.
fn due(look: &Look, value: &str) -> Option<String> {
    let day = value
        .get(..10)
        .filter(|day| civil::epoch_day_of(day).is_some())?;
    let day = civil::day_month(look.locale, day);
    match value
        .get(11..16)
        .filter(|time| time.as_bytes().get(2) == Some(&b':'))
    {
        Some(time) => Some(
            link_words::says_at(look.locale)
                .replace("{day}", &day)
                .replace("{time}", &civil::time_for(look.locale, time, look.cycle)),
        ),
        None => Some(day),
    }
}

/// The one line a task's fields read as.
fn line(look: &Look, fields: &[Field]) -> String {
    let locale = look.locale;
    let named = |name: &str| fields.iter().find(|field| field.name == name);
    let own = |name: &str| named(name).and_then(|field| text(&field.value));
    let number = |name: &str| named(name).and_then(|field| field.value.as_i64());
    let list = match (own("task.project_id"), own("task.section_id")) {
        (Some(project), Some(section)) => look
            .names
            .get(&project)
            .zip(look.names.get(&section))
            .map(|(project, section)| format!("{project} · {section}")),
        (Some(id), None) | (None, Some(id)) => look.names.get(&id).cloned(),
        (None, None) => None,
    };
    let status = own("task.status").and_then(|status| match status.as_str() {
        "done" => Some(words::done(locale)),
        "cancelled" => Some(words::wont_do(locale)),
        _ => None,
    });
    [
        own("entity.title"),
        own("task.due").and_then(|value| due(look, &value)),
        own("task.rule").map(|rule| rule_words::stored(locale, &rule)),
        own("task.anchor")
            .filter(|anchor| anchor == "completion")
            .map(|_| words::anchor_completion(locale)),
        number("task.remind_before_min")
            .and_then(|lead| u32::try_from(lead).ok())
            .map(|lead| lead_label(locale, lead)),
        own("task.url"),
        number("task.effort_min")
            .filter(|minutes| *minutes > 0)
            .map(|minutes| rows::effort_label(locale, minutes)),
        number("task.priority")
            .map(|priority| rows::priority_label(locale, priority))
            .filter(|label| !label.is_empty()),
        status,
        own("task.description").map(|notes| first_line(&notes)),
        list,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ")
}

/// The first line of the notes, cut at 80 characters.
fn first_line(notes: &str) -> String {
    const MOST: usize = 80;
    let first = notes.lines().next().unwrap_or_default().trim();
    if first.chars().count() <= MOST && first.len() == notes.trim().len() {
        return first.to_owned();
    }
    let cut: String = first.chars().take(MOST).collect();
    format!("{}…", cut.trim_end())
}
