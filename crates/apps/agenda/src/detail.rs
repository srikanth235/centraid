//! `event` — ONE EVENT, OR ONE OCCURRENCE OF ONE, BY ID (#1029, the
//! phone-shell port).
//!
//! The detail screen used to find its row by re-reading `upcoming` over a
//! padded window around the occurrence, which is a range read standing in for
//! an id read and misses an occurrence the padding did not reach. This reads
//! the series row by id, decorates it exactly as `upcoming` does, and — for an
//! occurrence — expands the series over [`search_window`] around the
//! occurrence's own wall clock and keeps the one whose key matches.
//!
//! An occurrence is named by `original_start_local`, or by the list's
//! `instance_key` (`<event_id>:<wall clock>`) when that is what the screen
//! holds. **Absent is an answer**: an id with no live row, a trashed event, a
//! key that is not an occurrence, and a SKIPPED occurrence all answer no
//! event, which the screen draws as "not here". A cancelled event is still
//! answered — its status is what the detail shows.

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::{PageDoor, read_pages};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_vault::time::occurrence::{SEARCH_WINDOW_DAYS, StoredExceptionRow, search_window};

use crate::expansion::expand_recurring_events;
use crate::queries::{
    EVENT_COLUMNS, EVENT_JOIN_BOUND, EventRow, decorate, event_of, exception_of,
    exceptions_statement, place_ids_of, read_decorations,
};
use crate::{Denial, denial_of};

/// What `event` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EventDetailData {
    /// Absent when nothing live answers to the id and key (the module header).
    pub event: Option<EventRow>,
}

/// `agenda.event.row` — the one live row, by id.
#[must_use]
pub fn event_row_statement(event_id: &str) -> PageQuery {
    PageQuery::new(
        "agenda.event.row",
        EVENT_COLUMNS,
        "core_event",
        PageOrder::asc("event_id", "event_id"),
    )
    .filter(
        "event_id = ? AND deleted_at IS NULL",
        vec![PageBindValue::Text(event_id.to_owned())],
    )
}

/// The occurrence a request names: `original_start_local`, else the wall
/// clock after `<event_id>:` in `instance_key`.
fn occurrence_key<'a>(
    event_id: &str,
    instance_key: Option<&'a str>,
    original_start_local: Option<&'a str>,
) -> Option<&'a str> {
    original_start_local
        .filter(|key| !key.is_empty())
        .or_else(|| {
            instance_key?
                .strip_prefix(event_id)?
                .strip_prefix(':')
                .filter(|key| !key.is_empty())
        })
}

/// `event` — the module header.
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a reached bound is an `Err`.
pub fn load_event(
    door: &dyn PageDoor,
    event_id: &str,
    instance_key: Option<&str>,
    original_start_local: Option<&str>,
) -> KitResult<(EventDetailData, Option<Denial>)> {
    let rows = match read_pages(door, &event_row_statement(event_id), EVENT_JOIN_BOUND) {
        Ok(rows) => rows,
        Err(KitError::Door(message)) => {
            return Ok((EventDetailData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let Some(mut event) = rows.first().and_then(event_of) else {
        return Ok((EventDetailData::default(), None));
    };
    let ids = [event.event_id.clone()];
    let decorations = read_decorations(door, "event", &ids, &place_ids_of(rows.iter()), true)?;
    decorate(&mut event, &decorations);
    let key = occurrence_key(event_id, instance_key, original_start_local);
    let (Some(key), Some(_)) = (key, event.rrule.as_ref()) else {
        // A one-off, or the series itself: the row, keyed as `search` keys it.
        event.instance_key = event.event_id.clone();
        return Ok((EventDetailData { event: Some(event) }, None));
    };
    let Some((from, to)) = search_window(key, SEARCH_WINDOW_DAYS) else {
        return Ok((EventDetailData::default(), None));
    };
    let exceptions: Vec<StoredExceptionRow> =
        read_pages(door, &exceptions_statement(&ids)?, EVENT_JOIN_BOUND)?
            .iter()
            .map(exception_of)
            .collect();
    let occurrence = expand_recurring_events(vec![event], &from, &to, &exceptions)?
        .into_iter()
        .find(|row| row.original_start_local.as_deref() == Some(key));
    Ok((EventDetailData { event: occurrence }, None))
}

#[cfg(test)]
mod tests {
    use super::occurrence_key;

    #[test]
    fn the_key_is_the_stated_wall_clock_else_the_instance_keys_tail() {
        assert_eq!(
            occurrence_key("e1", Some("e1:2026-01-02T09:00:00"), Some("2026-01-03")),
            Some("2026-01-03")
        );
        assert_eq!(
            occurrence_key("e1", Some("e1:2026-01-02T09:00:00"), None),
            Some("2026-01-02T09:00:00")
        );
        assert_eq!(occurrence_key("e1", Some("e1"), None), None);
        assert_eq!(occurrence_key("e1", Some("e2:2026-01-02"), Some("")), None);
    }
}
