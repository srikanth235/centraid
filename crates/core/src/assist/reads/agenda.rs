//! Agenda's two reads: what is on, and a search of what is on.

use centraid_api_proto::core_v1 as wire;
use centraid_assist::{App, Card, ReadError, ToolCall, ToolOutput};

use super::{Answer, Env, Query, ROWS, civil, counted, text, title_or, unexpected};

/// The card for one occurrence. A repeating event's instance rides as the
/// qualifier, because the event screen opens an occurrence and not a series.
fn card(event: &wire::AgendaEvent) -> Card {
    let when = if event.all_day {
        event.local_days.first().cloned().unwrap_or_default()
    } else {
        event.local_start.replacen('T', " ", 1)
    };
    let place = text(&event.location_name);
    let meta = if place.is_empty() {
        text(&event.recurrence_summary)
    } else {
        place
    };
    Card::new(
        App::Agenda,
        "event",
        &event.event_id,
        title_or(event.summary.as_deref(), "", "Untitled event"),
    )
    .qualifier(&event.instance_key)
    .subtitle(when)
    .meta(meta)
}

/// `agenda.upcoming`. The core expands every repeating series; this keeps the
/// occurrences whose local days meet the asked range, counted forward from the
/// `today` the core stated.
pub(super) fn upcoming(env: &Env<'_>, call: &ToolCall) -> Result<ToolOutput, ReadError> {
    let range = call.arg("range").unwrap_or("week");
    let Answer::AgendaUpcoming(answer) =
        env.ask(Query::AgendaUpcoming(wire::AgendaUpcomingRequest {
            from: String::new(),
            to: String::new(),
            tz: env.tz.to_owned(),
        }))?
    else {
        return Err(unexpected("agenda.upcoming"));
    };
    let (first, days, label) = match range {
        "today" => (0, 1, "today"),
        "tomorrow" => (1, 1, "tomorrow"),
        _ => (0, 7, "in the next 7 days"),
    };
    let wanted: Vec<String> = (first..first + days)
        .filter_map(|offset| civil::add_days(&answer.today, offset))
        .collect();
    let mut events: Vec<&wire::AgendaEvent> = answer
        .events
        .iter()
        .filter(|event| {
            event.status.as_deref() != Some("cancelled")
                && event.local_days.iter().any(|day| wanted.contains(day))
        })
        .collect();
    events.sort_by(|a, b| a.local_start.cmp(&b.local_start));
    events.truncate(ROWS as usize);
    let rows: Vec<Card> = events.into_iter().map(card).collect();
    let headline = format!("{} {label}", counted(rows.len(), "event", "events"));
    Ok(ToolOutput::of_rows(headline, rows))
}

/// `agenda.search`.
pub(super) fn search(env: &Env<'_>, call: &ToolCall) -> Result<ToolOutput, ReadError> {
    let term = call.arg("term").unwrap_or_default();
    let Answer::AgendaSearch(answer) = env.ask(Query::AgendaSearch(wire::AgendaSearchRequest {
        term: term.to_owned(),
        limit: ROWS,
        tz: env.tz.to_owned(),
    }))?
    else {
        return Err(unexpected("agenda.search"));
    };
    let rows: Vec<Card> = answer.events.iter().map(card).collect();
    Ok(ToolOutput::of_rows(
        format!(
            "{} matching \"{term}\"",
            counted(rows.len(), "event", "events")
        ),
        rows,
    ))
}
