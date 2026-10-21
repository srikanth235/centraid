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
use centraid_apps_kit::reads::PageDoor;
use centraid_vault::time::occurrence::{SEARCH_WINDOW_DAYS, search_window};

use crate::expansion::expand_recurring_events;
use crate::queries::{CalendarRow, EventRow, events_among, read_calendars, read_exceptions};
use crate::{Denial, denial_of};

/// What `event` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EventDetailData {
    /// Absent when nothing live answers to the id and key (the module header).
    pub event: Option<EventRow>,
    /// The event's calendar row — its name and stored color — so a detail
    /// names the calendar without reading `upcoming` (#1047). Absent with no
    /// event, no calendar edge, or a calendar that is gone.
    pub calendar: Option<CalendarRow>,
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
    let ids = [event_id.to_owned()];
    let found = match events_among(door, &ids) {
        Ok(found) => found,
        Err(KitError::Door(message)) => {
            return Ok((EventDetailData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let Some(mut event) = found.into_iter().next() else {
        return Ok((EventDetailData::default(), None));
    };
    let key = occurrence_key(event_id, instance_key, original_start_local);
    let event = match (key, event.rrule.as_ref()) {
        (Some(key), Some(_)) => {
            let Some((from, to)) = search_window(key, SEARCH_WINDOW_DAYS) else {
                return Ok((EventDetailData::default(), None));
            };
            let exceptions = read_exceptions(door, std::slice::from_ref(&event))?;
            expand_recurring_events(vec![event], &from, &to, &exceptions)?
                .into_iter()
                .find(|row| row.original_start_local.as_deref() == Some(key))
        }
        // A one-off, or the series itself: the row, keyed as `search` keys it.
        _ => {
            event.instance_key = event.event_id.clone();
            Some(event)
        }
    };
    let calendar = match event.as_ref().and_then(|row| row.calendar_id.as_deref()) {
        Some(calendar_id) => read_calendars(door)?
            .into_iter()
            .find(|calendar| calendar.calendar_id == calendar_id),
        None => None,
    };
    Ok((EventDetailData { event, calendar }, None))
}

/// How far either side of the vault clock [`next_occurrence`] looks.
pub const NEXT_OCCURRENCE_REACH_DAYS: i64 = 366;

/// THE OCCURRENCE A SEARCH HIT MEANS (#1047): a hit is the series, whose own
/// start is its anchor — perhaps years back — so the phone opens this one
/// instead. The first occurrence still running at or after `now` within
/// [`NEXT_OCCURRENCE_REACH_DAYS`], with the series' exceptions applied; else
/// the last one before `now` in the same reach; else none. `None` for a
/// one-off, which is its own occurrence.
///
/// # Errors
///
/// A door refusal, and [`KitError::FanOutExceeded`] from the expansion.
pub fn next_occurrence(
    door: &dyn PageDoor,
    event: &EventRow,
    now: &str,
) -> KitResult<Option<EventRow>> {
    if event.rrule.is_none() {
        return Ok(None);
    }
    let Some(now_ms) = centraid_vault::time::recurrence::parse_instant_ms(now) else {
        return Ok(None);
    };
    let reach = NEXT_OCCURRENCE_REACH_DAYS * 86_400_000;
    let at = centraid_vault::clock::format_iso_ms;
    let exceptions = read_exceptions(door, std::slice::from_ref(event))?;
    let ahead = expand_recurring_events(
        vec![event.clone()],
        &at(now_ms),
        &at(now_ms + reach),
        &exceptions,
    )?;
    // A RANGE WITH NO OCCURRENCE ANSWERS THE ANCHOR (the expansion keeps an
    // unsupported rule visible that way), so a series that ended comes back
    // as its first start: only a start at or after now is "next". Compared to
    // the minute, because a floating start carries no zone suffix.
    let minute = |text: &str| text.get(..16).unwrap_or(text).to_owned();
    let floor = minute(&at(now_ms));
    if let Some(next) = ahead
        .into_iter()
        .filter(|row| minute(&row.dtstart) >= floor)
        .min_by_key(|row| minute(&row.dtstart))
    {
        return Ok(Some(next));
    }
    Ok(expand_recurring_events(
        vec![event.clone()],
        &at(now_ms - reach),
        &at(now_ms),
        &exceptions,
    )?
    .into_iter()
    .filter(|row| minute(&row.dtstart) < floor)
    .max_by_key(|row| minute(&row.dtstart)))
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
