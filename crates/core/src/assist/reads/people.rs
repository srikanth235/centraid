//! People's three reads: the circle, a search by name, and who to reach.

use centraid_api_proto::core_v1 as wire;
use centraid_assist::{App, Card, ReadError, ToolCall, ToolOutput};

use super::{Answer, Env, Query, ROWS, counted, unexpected};

fn card(person: &wire::PeopleRosterRow) -> Card {
    let meta = if person.last_contacted_local_day.is_empty() {
        "not contacted yet".to_owned()
    } else {
        format!("last contacted {}", person.last_contacted_local_day)
    };
    Card::new(App::People, "person", &person.party_id, &person.name)
        .subtitle(&person.role)
        .meta(if person.due {
            format!("{meta}, due")
        } else {
            meta
        })
}

/// `people.list`.
pub(super) fn list(env: &Env<'_>, call: &ToolCall) -> Result<ToolOutput, ReadError> {
    let (filter, label) = match call.arg("filter").unwrap_or("all") {
        "starred" => (wire::PeopleRosterFilter::Starred, "starred"),
        "due" => (wire::PeopleRosterFilter::Due, "due for a catch-up"),
        _ => (wire::PeopleRosterFilter::All, "in the circle"),
    };
    let Answer::PeopleRoster(roster) = env.ask(Query::PeopleRoster(wire::PeopleRosterRequest {
        limit: ROWS,
        filter: filter as i32,
        sort: wire::PeopleRosterSort::Recent as i32,
        tz: env.tz.to_owned(),
    }))?
    else {
        return Err(unexpected("people.list"));
    };
    let rows: Vec<Card> = roster.people.iter().take(ROWS as usize).map(card).collect();
    Ok(ToolOutput::of_rows(
        format!("{} {label}", counted(rows.len(), "person", "people")),
        rows,
    ))
}

/// `people.search`.
pub(super) fn search(env: &Env<'_>, call: &ToolCall) -> Result<ToolOutput, ReadError> {
    let term = call.arg("term").unwrap_or_default();
    let Answer::PeopleSearch(answer) = env.ask(Query::PeopleSearch(wire::PeopleSearchRequest {
        term: term.to_owned(),
        limit: ROWS,
        tz: env.tz.to_owned(),
    }))?
    else {
        return Err(unexpected("people.search"));
    };
    let rows: Vec<Card> = answer.people.iter().map(card).collect();
    Ok(ToolOutput::of_rows(
        format!(
            "{} matching \"{term}\"",
            counted(rows.len(), "person", "people")
        ),
        rows,
    ))
}

/// `people.reconnect`: who is overdue for a catch-up, then the dates coming up.
pub(super) fn reconnect(env: &Env<'_>, _: &ToolCall) -> Result<ToolOutput, ReadError> {
    let Answer::PeopleTouch(touch) = env.ask(Query::PeopleTouch(wire::PeopleTouchRequest {
        tz: env.tz.to_owned(),
    }))?
    else {
        return Err(unexpected("people.reconnect"));
    };
    let mut rows: Vec<Card> = touch
        .reconnect
        .iter()
        .map(|person| {
            let meta = person
                .days_over
                .filter(|days| *days > 0)
                .map_or_else(String::new, |days| format!("{days} days overdue"));
            Card::new(App::People, "person", &person.party_id, &person.name)
                .subtitle(&person.role)
                .meta(meta)
        })
        .collect();
    let reconnecting = rows.len();
    let mut dates = 0;
    for upcoming in &touch.upcoming {
        let (Some(person), Some(date)) = (&upcoming.person, &upcoming.date) else {
            continue;
        };
        if rows.iter().any(|card| card.id == person.party_id) {
            continue;
        }
        let when = date.in_days.map_or_else(
            || date.month_day.clone(),
            |days| match days {
                0 => "today".to_owned(),
                1 => "tomorrow".to_owned(),
                n => format!("in {n} days"),
            },
        );
        rows.push(
            Card::new(App::People, "person", &person.party_id, &person.name)
                .subtitle(format!("{} {when}", date.label))
                .meta(&person.role),
        );
        dates += 1;
    }
    rows.truncate(ROWS as usize);
    let headline = format!(
        "{} due for a catch-up, {} coming up",
        counted(reconnecting, "person", "people"),
        counted(dates, "date", "dates").to_lowercase()
    );
    Ok(ToolOutput::of_rows(headline, rows))
}
