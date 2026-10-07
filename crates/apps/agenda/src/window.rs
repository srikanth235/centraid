//! THE EVENTS OF A RANGE OF LOCAL DAYS, one row per occurrence, in the member's zone (#1088, R-1088-8).
//!
//! Agenda's `upcoming` already answers what is on: it reads the window and the recurring
//! anchors, expands every repeating series into its occurrences, drops the cancelled and the
//! trashed, and places each occurrence on the member's calendar in the request's zone
//! ([`crate::local::place`]). A reader that only needs *what is on when* (the assistant's
//! read model, which groups by local day and says "tomorrow at 9") asks this function and
//! gets exactly those rows, so it cannot disagree with the Agenda tab: there is one
//! implementation of "which days does this occupy", the one the screens use.
//!
//! The harness door and the core's door both call [`occurrences`] over their own
//! [`PageDoor`]; neither holds a second copy.

use centraid_apps_kit::{Denial, KitResult, PageDoor};
use centraid_vault::time::zone::{FireZone, WallTime, add_wall_days, parse_wall_iso};

use crate::local::{Placement, civil_day, place, start_of_day};
use crate::queries::load_upcoming;

/// One occurrence in a range of local days.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occurrence {
    /// The series' (or the one-off's) event id: what a command that changes the whole event names.
    pub event_id: String,
    /// The one-off's event id, and `<event_id>:<wall clock>` for an occurrence of a series.
    pub instance_key: String,
    /// An occurrence of a repeating series (not the one-off's only row).
    pub is_instance: bool,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    /// Where it falls in the zone: its wall clock, its end, the civil days it occupies.
    pub placement: Placement,
}

fn day_wall(day: &str) -> Option<WallTime> {
    parse_wall_iso(day).map(|wall| WallTime {
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
        ..wall
    })
}

/// Every occurrence that occupies at least one civil day of `from_day..=to_day` (`YYYY-MM-DD`,
/// days of `zone`), repeating series expanded, cancelled and trashed events left out, in the
/// order Agenda lists them.
///
/// # Errors
///
/// A day that is not a date, or a bound `load_upcoming` reaches (the expansion cap), names the
/// size it reached. A door refusal comes back as the payload's denial, beside no rows.
pub fn occurrences(
    door: &dyn PageDoor,
    from_day: &str,
    to_day: &str,
    now: &str,
    zone: &FireZone,
) -> KitResult<(Vec<Occurrence>, Option<Denial>)> {
    let (Some(first), Some(last)) = (day_wall(from_day), day_wall(to_day)) else {
        return Err(centraid_apps_kit::KitError::Door(format!(
            "`{from_day}..{to_day}` is not a range of days"
        )));
    };
    let from = start_of_day(zone, first);
    // the range's end is the first instant of the day after its last day
    let to = start_of_day(zone, add_wall_days(last, 1));
    let (data, denial) = load_upcoming(door, Some(&from), Some(&to), now, zone)?;
    let wanted = |days: &[String]| {
        days.iter().any(|day| {
            day.as_str() >= civil_day(first).as_str() && day.as_str() <= civil_day(last).as_str()
        })
    };
    let rows = data
        .events
        .into_iter()
        .filter_map(|event| {
            let placement = place(&event, zone)?;
            if !wanted(&placement.local_days) {
                return None;
            }
            Some(Occurrence {
                event_id: event.event_id,
                instance_key: event.instance_key,
                is_instance: event.is_recurrence_instance,
                summary: event.summary,
                description: event.description,
                status: event.status,
                placement,
            })
        })
        .collect();
    Ok((rows, denial))
}
