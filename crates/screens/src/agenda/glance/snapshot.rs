//! THE WIDGETS' SNAPSHOT, as one pure function from what Agenda's reads
//! answered to the JSON document a shell keeps in its shared container.
//!
//! A widget cannot call the core and cannot format a word, so everything it
//! draws is decided here and finished in the device's locale: the rows, the
//! labels, the counts, the sentence Siri speaks. The shells read this document
//! and draw it; they compute nothing from it except "has `refresh_after`
//! passed", which is a comparison of two civil strings the core spelled.
//!
//! # PRIVACY OBLIGATION
//!
//! The builder reads Agenda's answers and nothing else. **Never Locker, never a
//! note's or a task's description, never a location, never a guest's name:
//! titles and times only.** The document sits in a container the lock screen's
//! widgets and the OS's indexers can reach, so a field added here is a field
//! disclosed. A new key is an owner's call, not a convenience.
//!
//! # Bounds, by construction
//!
//! At most [`MAX_ROWS`] `up_next` rows and [`MAX_ROWS`] reminder rows, every
//! title at most [`MAX_TITLE`] characters, every id at most [`MAX_ID`], and the
//! whole document at most [`MAX_BYTES`]: when the rows still do not fit (a title
//! of control characters escapes to six bytes each), rows are dropped from the
//! end until they do. The counts are always the true counts of what the board
//! answered, never the number of rows drawn.
//!
//! # Schema, version 1
//!
//! ```text
//! version, state ("ready" | "unavailable"), today, now_local, zone,
//! refresh_after (local wall clock; after it the widget shows words.stale),
//! words {..every sentence the widget draws..},
//! open_up_next, open_reminders, open_add (keys, see below),
//! up_next [ {id, kind ("event"|"task"), title, time_label, day_label,
//!            starts_local, ends_local, all_day, tint, open} ],
//! reminders { today_count, overdue_count, flagged_count,
//!             rows [ {id, title, due_label, overdue, flagged, open} ] },
//! siri { next_sentence }
//! ```
//!
//! **Additive keys**: the schema grows by adding keys and keeps `version` 1; a
//! reader tolerates a key it does not know and a shell never requires a new one
//! (a document an older core wrote has no `open` keys: a tap then opens the app).
//! A change that removes or retypes a key is a new version.
//!
//! # What a tap opens: the `open` keys
//!
//! Every row, and the widget's body, carries an OPEN KEY: an opaque short string
//! the shell hands back untouched (`centraid://agenda?open=<key>` on iOS, an
//! intent extra on Android) and the core answers with a page. **The shells name
//! no screen and no destination**, and a key the core did not emit in its last
//! document opens Agenda's home and nothing else, so what an outside app can
//! push into Agenda is exactly what the snapshot offered. The keys are
//! `e:<event id>:<local start>` (one occurrence), `t:<task id>`, `up_next`
//! (Agenda's Day), `reminders` (To-do) and `add` (To-do, the quick-add bar open
//! and empty). [`Opens`] is the table the service keeps for the last document.
//!
//! An all-day row's `starts_local` is its day at `T00:00` and its `ends_local`
//! is empty; a task's `ends_local` is empty. `tint` is a colour key the shells
//! map to their tokens, never a colour.

use std::collections::{BTreeMap, BTreeSet};

use centraid_api_proto::core_v1 as wire;
use serde_json::{Map, Value, json};

use crate::kit::civil::{self, HourCycle};
use crate::kit::schedule::rows;
use crate::strings::{Locale, agenda, agenda_glance as words, fill, shared, task as task_words};

/// The document's schema version.
pub const VERSION: u32 = 1;
/// The most rows either list carries.
pub const MAX_ROWS: usize = 6;
/// The longest title, in characters, the ellipsis included.
pub const MAX_TITLE: usize = 80;
/// The longest id, in characters.
pub const MAX_ID: usize = 64;
/// The most bytes the document may be.
pub const MAX_BYTES: usize = 8 * 1024;

const ELLIPSIS: char = '\u{2026}';
const TINT_AGENDA: &str = "calendar";
const TINT_RED: &str = "red";

/// The key that opens Agenda's Day.
pub const KEY_UP_NEXT: &str = "up_next";
/// The key that opens To-do.
pub const KEY_REMINDERS: &str = "reminders";
/// The key that opens To-do with the quick-add bar open.
pub const KEY_ADD: &str = "add";

/// What an open key names, for the service to turn into a route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Open {
    /// One occurrence of an event, drawn under `day`.
    Event {
        event_id: String,
        instance_key: String,
        original_start_local: Option<String>,
        day: String,
    },
    /// One task.
    Task { task_id: String },
    /// Agenda's Day.
    UpNext,
    /// To-do.
    Reminders,
    /// To-do with the quick-add bar open.
    Add,
}

/// The keys a document offered and what each opens: the only keys the service
/// will answer.
pub type Opens = BTreeMap<String, Open>;

/// What the reads answered. Every day and wall clock is the core's, in the
/// device's zone.
pub struct Inputs<'a> {
    pub locale: Locale,
    pub zone: &'a str,
    /// `YYYY-MM-DD`.
    pub today: &'a str,
    /// `YYYY-MM-DDTHH:MM`.
    pub now_local: &'a str,
    /// The events covering today and tomorrow, padded (see `held.rs`): a row is
    /// kept for the days its `local_days` names.
    pub upcoming: &'a wire::AgendaUpcoming,
    /// The open tasks the rows are drawn from: the earliest due (overdue and
    /// today) and the timed ones due today or tomorrow, each read in due order
    /// over every open task (`agenda.task.due-rows`), never a window of the
    /// newest. Their number says nothing about how many tasks there are.
    pub tasks: &'a [wire::AgendaTask],
    /// How the phone words a time of day.
    pub cycle: HourCycle,
    /// The true Today, Overdue and Flagged counts, over the whole vault.
    pub counts: &'a wire::AgendaTaskSmartCounts,
}

/// One `up_next` row, before it is words.
struct Item {
    id: String,
    kind: &'static str,
    title: String,
    time_label: String,
    day_label: String,
    starts_local: String,
    ends_local: String,
    all_day: bool,
    tint: &'static str,
    /// Tomorrow's, for the sentence Siri speaks.
    tomorrow: bool,
    /// What a tap on the row opens, and the key that says so.
    open: Open,
    open_key: String,
}

/// One reminder row.
struct Reminder {
    id: String,
    title: String,
    due_label: String,
    overdue: bool,
    flagged: bool,
    /// What a tap on the row opens, and the key that says so.
    open: Open,
    open_key: String,
}

/// The document for a day that was read.
#[must_use]
pub fn ready(inputs: &Inputs) -> Vec<u8> {
    ready_with_opens(inputs).0
}

/// The document for a day that was read, and the keys it offers.
#[must_use]
pub fn ready_with_opens(inputs: &Inputs) -> (Vec<u8>, Opens) {
    let locale = inputs.locale;
    let tomorrow = civil::plus_days(inputs.today, 1).unwrap_or_default();
    let mut up_next = up_next(inputs, &tomorrow);
    let open = open_roots(inputs.tasks);
    let mut reminders = reminders(inputs, &open);
    let counts = Counts {
        today: inputs.counts.today as usize,
        overdue: inputs.counts.overdue as usize,
        flagged: inputs.counts.flagged as usize,
    };
    up_next.truncate(MAX_ROWS);
    reminders.truncate(MAX_ROWS);
    let refresh_after = refresh_after(inputs.today, inputs.now_local, &up_next);
    loop {
        let document = document(
            inputs,
            "ready",
            &refresh_after,
            &up_next,
            &reminders,
            counts,
            siri_sentence(locale, up_next.first()),
        );
        if document.0.len() <= MAX_BYTES || (up_next.is_empty() && reminders.is_empty()) {
            return document;
        }
        // DROP FROM THE LONGER LIST'S END until the document fits.
        if reminders.len() >= up_next.len() {
            reminders.pop();
        } else {
            up_next.pop();
        }
    }
}

/// The document for a day that could not be read: no vault in front, a failed
/// read, or a vault that refused. Never an empty `ready`.
#[must_use]
pub fn unavailable(locale: Locale, zone: &str) -> Vec<u8> {
    unavailable_with_opens(locale, zone).0
}

/// The document for a day that could not be read, and the keys it offers (the
/// three that open a place: a tap on the widget still opens Agenda).
#[must_use]
pub fn unavailable_with_opens(locale: Locale, zone: &str) -> (Vec<u8>, Opens) {
    let inputs = Inputs {
        locale,
        zone,
        today: "",
        now_local: "",
        upcoming: &wire::AgendaUpcoming::default(),
        tasks: &[],
        cycle: HourCycle::default(),
        counts: &wire::AgendaTaskSmartCounts::default(),
    };
    document(
        &inputs,
        "unavailable",
        "",
        &[],
        &[],
        Counts::default(),
        words::siri_unavailable(locale),
    )
}

/// How many local seconds lie between two `YYYY-MM-DDTHH:MM` wall clocks, or
/// `None` when either does not parse. The runtime's timer is set from this, so
/// the clock the core answered is the only one read.
#[must_use]
pub fn seconds_between(from: &str, to: &str) -> Option<u64> {
    let minutes = |stamp: &str| -> Option<i64> {
        let day = civil::epoch_day_of(stamp.get(..10)?)?;
        let hours: i64 = stamp.get(11..13)?.parse().ok()?;
        let mins: i64 = stamp.get(14..16)?.parse().ok()?;
        Some(day * 1440 + hours * 60 + mins)
    };
    let span = minutes(to)?.checked_sub(minutes(from)?)?;
    u64::try_from(span).ok().map(|minutes| minutes * 60)
}

fn stamp_of(document: &[u8], key: &str) -> Option<String> {
    let parsed: Value = serde_json::from_slice(document).ok()?;
    let stamp = parsed.get(key)?.as_str()?;
    (!stamp.is_empty()).then(|| stamp.to_owned())
}

/// The `refresh_after` a ready document names, read back out of its bytes.
#[must_use]
pub fn refresh_after_of(document: &[u8]) -> Option<String> {
    stamp_of(document, "refresh_after")
}

/// The `now_local` a document was built at, read back out of its bytes.
#[must_use]
pub fn now_local_of(document: &[u8]) -> Option<String> {
    stamp_of(document, "now_local")
}

#[derive(Clone, Copy, Default)]
struct Counts {
    today: usize,
    overdue: usize,
    flagged: usize,
}

fn document(
    inputs: &Inputs,
    state: &str,
    refresh_after: &str,
    up_next: &[Item],
    reminders: &[Reminder],
    counts: Counts,
    sentence: String,
) -> (Vec<u8>, Opens) {
    let locale = inputs.locale;
    let mut opens: Opens = BTreeMap::from([
        (KEY_UP_NEXT.to_owned(), Open::UpNext),
        (KEY_REMINDERS.to_owned(), Open::Reminders),
        (KEY_ADD.to_owned(), Open::Add),
    ]);
    for (key, open) in up_next
        .iter()
        .map(|item| (&item.open_key, &item.open))
        .chain(reminders.iter().map(|row| (&row.open_key, &row.open)))
    {
        opens.insert(key.clone(), open.clone());
    }
    let mut root = Map::new();
    root.insert("version".into(), json!(VERSION));
    root.insert("state".into(), json!(state));
    root.insert("today".into(), json!(inputs.today));
    root.insert("now_local".into(), json!(inputs.now_local));
    root.insert("zone".into(), json!(inputs.zone));
    root.insert("refresh_after".into(), json!(refresh_after));
    root.insert("open_up_next".into(), json!(KEY_UP_NEXT));
    root.insert("open_reminders".into(), json!(KEY_REMINDERS));
    root.insert("open_add".into(), json!(KEY_ADD));
    root.insert(
        "words".into(),
        json!({
            "up_next_title": words::up_next_title(locale),
            "today_title": words::today_title(locale),
            "reminders_title": words::reminders_title(locale),
            "nothing_next": words::nothing_next(locale),
            "no_reminders": words::no_reminders(locale),
            "unavailable": words::unavailable(locale),
            "stale": words::stale(locale),
            "overdue_label": words::overdue_label(locale, counts.overdue as u64),
            "today_label": words::today_label(locale, counts.today as u64),
            "flagged_label": words::flagged_label(locale, counts.flagged as u64),
            "add_label": words::add_label(locale),
        }),
    );
    root.insert(
        "up_next".into(),
        Value::Array(
            up_next
                .iter()
                .map(|item| {
                    json!({
                        "id": item.id,
                        "kind": item.kind,
                        "title": item.title,
                        "time_label": item.time_label,
                        "day_label": item.day_label,
                        "starts_local": item.starts_local,
                        "ends_local": item.ends_local,
                        "all_day": item.all_day,
                        "tint": item.tint,
                        "open": item.open_key,
                    })
                })
                .collect(),
        ),
    );
    root.insert(
        "reminders".into(),
        json!({
            "today_count": counts.today,
            "overdue_count": counts.overdue,
            "flagged_count": counts.flagged,
            "rows": reminders.iter().map(|row| json!({
                "id": row.id,
                "title": row.title,
                "due_label": row.due_label,
                "overdue": row.overdue,
                "flagged": row.flagged,
                "open": row.open_key,
            })).collect::<Vec<_>>(),
        }),
    );
    root.insert("siri".into(), json!({ "next_sentence": sentence }));
    // A map of strings, numbers and bools always serialises.
    (
        serde_json::to_vec(&Value::Object(root)).unwrap_or_default(),
        opens,
    )
}

/// A title as one short line: whitespace collapsed, at most [`MAX_TITLE`]
/// characters, the last an ellipsis when it was cut (never mid-character).
#[must_use]
pub fn clip(title: &str) -> String {
    let line = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= MAX_TITLE {
        return line;
    }
    let mut cut: String = line.chars().take(MAX_TITLE - 1).collect();
    cut.truncate(cut.trim_end().len());
    cut.push(ELLIPSIS);
    cut
}

fn id_of(id: &str) -> String {
    id.chars().take(MAX_ID).collect()
}

fn event_title(locale: Locale, event: &wire::AgendaEvent) -> String {
    let title = clip(event.summary.as_deref().unwrap_or_default());
    if title.is_empty() {
        agenda::untitled(locale)
    } else {
        title
    }
}

fn task_title(locale: Locale, task: &wire::AgendaTask) -> String {
    let title = clip(&task.title);
    if title.is_empty() {
        task_words::untitled(locale)
    } else {
        title
    }
}

/// The colour key of a task row: attention for an overdue one.
pub(super) fn tint_of(task: &wire::AgendaTask) -> &'static str {
    if task.overdue { TINT_RED } else { TINT_AGENDA }
}

fn open_roots(tasks: &[wire::AgendaTask]) -> Vec<&wire::AgendaTask> {
    tasks.iter().filter(|task| rows::is_open(task)).collect()
}

/// An event has not ended while its end (its start, with no length) is still
/// ahead of `now`; one with no length is ahead at its own minute.
fn event_ahead(event: &wire::AgendaEvent, now: &str) -> bool {
    if event.local_end.is_empty() || event.local_end == event.local_start {
        event.local_start.as_str() >= now
    } else {
        event.local_end.as_str() > now
    }
}

fn start_day(event: &wire::AgendaEvent) -> &str {
    event.local_start.get(..10).unwrap_or_default()
}

fn midnight(day: &str) -> String {
    format!("{day}T00:00")
}

fn up_next(inputs: &Inputs, tomorrow: &str) -> Vec<Item> {
    let locale = inputs.locale;
    let mut shown: BTreeSet<String> = BTreeSet::new();
    let mut out: Vec<Item> = Vec::new();
    for (day, is_tomorrow) in [(inputs.today, false), (tomorrow, true)] {
        if day.is_empty() || (is_tomorrow && out.len() >= MAX_ROWS) {
            continue;
        }
        let mut items: Vec<Item> = Vec::new();
        for event in &inputs.upcoming.events {
            let key = if event.instance_key.is_empty() {
                &event.event_id
            } else {
                &event.instance_key
            };
            if !event.local_days.iter().any(|d| d == day)
                || shown.contains(key)
                || event.status.as_deref() == Some("cancelled")
            {
                continue;
            }
            if !is_tomorrow && !event.all_day && !event_ahead(event, inputs.now_local) {
                continue;
            }
            shown.insert(key.clone());
            let starts_here = start_day(event) >= day;
            let (time_label, starts, ends) = if event.all_day {
                (shared::all_day(locale), midnight(day), String::new())
            } else if starts_here {
                (
                    civil::clock_for(locale, &event.local_start, inputs.cycle),
                    event.local_start.clone(),
                    event.local_end.clone(),
                )
            } else {
                (
                    agenda::continues(locale),
                    event.local_start.clone(),
                    event.local_end.clone(),
                )
            };
            let open = Open::Event {
                event_id: event.event_id.clone(),
                instance_key: event.instance_key.clone(),
                original_start_local: event.original_start_local.clone(),
                day: day.to_owned(),
            };
            items.push(Item {
                open_key: format!("e:{}:{}", id_of(key), starts),
                open,
                id: id_of(key),
                kind: "event",
                title: event_title(locale, event),
                time_label,
                day_label: day_label(locale, is_tomorrow),
                starts_local: starts,
                ends_local: ends,
                all_day: event.all_day,
                tint: TINT_AGENDA,
                tomorrow: is_tomorrow,
            });
        }
        for task in open_roots(inputs.tasks) {
            if task.due_day != day || task.due_time.is_empty() || task.overdue {
                continue;
            }
            if !is_tomorrow && task.due_local.as_str() < inputs.now_local {
                continue;
            }
            items.push(Item {
                open_key: format!("t:{}", id_of(&task.task_id)),
                open: Open::Task {
                    task_id: task.task_id.clone(),
                },
                id: id_of(&task.task_id),
                kind: "task",
                title: task_title(locale, task),
                time_label: civil::time_for(locale, &task.due_time, inputs.cycle),
                day_label: day_label(locale, is_tomorrow),
                starts_local: task.due_local.clone(),
                ends_local: String::new(),
                all_day: false,
                tint: tint_of(task),
                tomorrow: is_tomorrow,
            });
        }
        // ALL-DAY FIRST, then by start; an event before a task at the same
        // minute; the id last, so the order never depends on the read's.
        items.sort_by(|a, b| {
            (!a.all_day, &a.starts_local, a.kind, &a.id).cmp(&(
                !b.all_day,
                &b.starts_local,
                b.kind,
                &b.id,
            ))
        });
        out.extend(items);
    }
    out
}

fn day_label(locale: Locale, tomorrow: bool) -> String {
    if tomorrow {
        shared::tomorrow(locale)
    } else {
        String::new()
    }
}

/// Overdue first, then today's, each by due then sort order. The rows are the
/// earliest due the read answered; the counts are the vault's ([`Inputs::counts`]).
fn reminders(inputs: &Inputs, open: &[&wire::AgendaTask]) -> Vec<Reminder> {
    let locale = inputs.locale;
    let context = rows::Context {
        today: inputs.today,
        cycle: inputs.cycle,
        ..rows::Context::default()
    };
    let mut due: Vec<&wire::AgendaTask> = open
        .iter()
        .copied()
        .filter(|task| task.overdue || task.lands_today)
        .collect();
    due.sort_by(|a, b| {
        (
            !a.overdue,
            &a.due_day,
            &a.due_time,
            a.sort_order,
            &a.task_id,
        )
            .cmp(&(
                !b.overdue,
                &b.due_day,
                &b.due_time,
                b.sort_order,
                &b.task_id,
            ))
    });
    due.into_iter()
        .take(MAX_ROWS)
        .map(|task| Reminder {
            open_key: format!("t:{}", id_of(&task.task_id)),
            open: Open::Task {
                task_id: task.task_id.clone(),
            },
            id: id_of(&task.task_id),
            title: task_title(locale, task),
            // A task due today with no time is in the Today list already: it
            // needs no label of its own.
            due_label: if task.overdue || !task.due_time.is_empty() {
                due_label(locale, task, &context)
            } else {
                String::new()
            },
            overdue: task.overdue,
            flagged: task.flagged,
        })
        .collect()
}

/// A REMINDERS ROW'S DUE WORDS, as the widget board writes them: "Yesterday", then the weekday
/// ("Wed") for the rest of the week, and past a week a short date ("28 Oct"). The app's lists keep
/// "3 days ago" ([`rows::due_label`]); a widget row has no room for a sentence and the weekday or
/// the date is what a glance reads.
fn due_label(locale: Locale, task: &wire::AgendaTask, context: &rows::Context) -> String {
    if task.overdue
        && task
            .days_from_today
            .is_some_and(|days| (-6..=-2).contains(&days))
    {
        return civil::weekday_short(locale, &task.due_day);
    }
    if task.overdue && task.days_from_today.is_some_and(|days| days <= -7) {
        return civil::short_date(locale, &task.due_day);
    }
    rows::due_label(locale, task, context)
}

/// The local wall clock after which the document is stale: the next local
/// midnight, or the start or end of a shown row if that comes sooner.
fn refresh_after(today: &str, now: &str, shown: &[Item]) -> String {
    let mut next = civil::plus_days(today, 1)
        .map(|day| midnight(&day))
        .unwrap_or_default();
    for item in shown.iter().filter(|item| !item.tomorrow && !item.all_day) {
        for stamp in [&item.starts_local, &item.ends_local] {
            if stamp.len() == 16 && stamp.as_str() > now && (next.is_empty() || *stamp < next) {
                next.clone_from(stamp);
            }
        }
    }
    next
}

fn siri_sentence(locale: Locale, first: Option<&Item>) -> String {
    let Some(item) = first else {
        return words::siri_nothing(locale);
    };
    let row = match (item.tomorrow, item.all_day) {
        (false, false) => words::siri_next(locale),
        (false, true) => words::siri_next_all_day(locale),
        (true, false) => words::siri_next_tomorrow(locale),
        (true, true) => words::siri_next_tomorrow_all_day(locale),
    };
    fill(&row, &[("title", &item.title), ("time", &item.time_label)])
}
