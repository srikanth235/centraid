use std::collections::BTreeMap;

use rusqlite::Connection;

use crate::apps::{self, calendar, entity, reminders};
use crate::read::{Args, Read, ReadError, door::run_on};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone)]
pub struct Day<'a> {
    pub day: &'a str,
    pub from: &'a str,
    pub to: &'a str,
    pub floating_from: &'a str,
    pub floating_to: &'a str,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Today {
    pub events: Vec<Item>,
    pub tasks: Vec<Item>,
}

fn to_rusqlite(error: ReadError) -> rusqlite::Error {
    match error {
        ReadError::Sql(inner) => inner,
        other => rusqlite::Error::ToSqlConversionFailure(Box::new(other)),
    }
}

fn collect_all(
    connection: &Connection,
    read: &Read<apps::Item>,
    args: &Args,
) -> rusqlite::Result<Vec<apps::Item>> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let mut ask = args.clone();
        if let Some(cursor) = after {
            ask = ask.after(cursor);
        }
        let page = run_on(connection, read, &ask).map_err(to_rusqlite)?;
        out.extend(page.rows);
        match page.next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    Ok(out)
}

fn week_before(day: &str) -> String {
    let iso = format!("{day}T00:00:00.000Z");
    centraid_vault::time::recurrence::parse_instant_ms(&iso)
        .map(|ms| centraid_vault::clock::format_iso_ms(ms - 7 * 86_400_000)[..10].to_owned())
        .unwrap_or_else(|| day.to_owned())
}

fn merge_sorted(a: Vec<apps::Item>, b: Vec<apps::Item>) -> Vec<Item> {
    let mut by_id: BTreeMap<String, (String, String)> = BTreeMap::new();
    for item in a.into_iter().chain(b) {
        by_id
            .entry(item.id)
            .or_insert_with(|| (item.at, item.title));
    }
    let mut rows: Vec<(String, String, String)> = by_id
        .into_iter()
        .map(|(id, (at, title))| (at, id, title))
        .collect();
    rows.sort();
    rows.into_iter()
        .map(|(_, id, title)| Item { id, title })
        .collect()
}

pub fn entity_held(connection: &Connection, id: &str) -> rusqlite::Result<bool> {
    if id.is_empty() || id.contains(char::is_whitespace) {
        return Ok(false);
    }
    let answer =
        run_on(connection, &entity::HELD, &Args::new().text("id", id)).map_err(to_rusqlite)?;
    Ok(!answer.rows.is_empty())
}

pub fn today(connection: &Connection, day: &Day<'_>) -> rusqlite::Result<Today> {
    let week_back = week_before(day.day);
    let event_low = week_back.as_str().min(day.from);
    let event_high = day.to.max(day.floating_to);
    let short_events = collect_all(
        connection,
        &calendar::TODAY_SHORT,
        &Args::new()
            .day("day", day.day)
            .text("from", day.from)
            .text("to", day.to)
            .text("floating_from", day.floating_from)
            .text("floating_to", day.floating_to)
            .text("low", event_low)
            .text("high", event_high),
    )?;
    let long_events = collect_all(
        connection,
        &calendar::TODAY_LONG,
        &Args::new().day("day", day.day),
    )?;
    let task_low = day.day.min(day.from);
    let task_high = day.to.max(day.floating_to);
    let due_tasks = collect_all(
        connection,
        &reminders::TODAY_DUE,
        &Args::new()
            .day("day", day.day)
            .text("from", day.from)
            .text("to", day.to)
            .text("floating_from", day.floating_from)
            .text("floating_to", day.floating_to)
            .text("low", task_low)
            .text("high", task_high),
    )?;
    let scheduled_tasks = collect_all(
        connection,
        &reminders::TODAY_SCHEDULED,
        &Args::new().day("day", day.day),
    )?;
    Ok(Today {
        events: merge_sorted(short_events, long_events),
        tasks: merge_sorted(due_tasks, scheduled_tasks),
    })
}
