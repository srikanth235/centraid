//! AN EVENT'S TIMES AS A COMMAND STATES THEM — the two input shapes, and the
//! one ordering rule (#1029, the phone-shell port).
//!
//! ## The two shapes
//!
//! | input | `dtstart` / `dtend` are | stored as |
//! |---|---|---|
//! | no `tz` | stored verbatim: an instant, a floating wall clock, or an all-day date, as `recurrence_semantics` says | as sent |
//! | `tz` (IANA) | WALL CLOCKS in that zone, `YYYY-MM-DDTHH:MM[:SS]`, no `Z`, no offset | the instants [`FireZone::resolve_wall_time`] answers, with `start_tz = end_tz = tz` and `recurrence_semantics = 'zoned'` |
//!
//! The second shape exists because the phone's `commonMain` has no zone
//! engine: it knows the member's wall clock and the device's zone name, and
//! the core is the one place that turns the pair into an instant. A wall
//! clock the zone skips (the spring gap) is REFUSED rather than nudged; one it
//! repeats (the autumn fold) takes the earlier instant, as every resolution in
//! this tree does. `tz` is exclusive with `start_tz`, `end_tz` and a
//! non-`zoned` `recurrence_semantics`, because each of those would be a second
//! answer to the question `tz` already answered.
//!
//! ## The ordering rule
//!
//! A timed end is EXCLUSIVE, so it must be after the start. **An all-day end
//! is the LAST DAY, inclusive** — `centraid_apps_agenda::local`'s table, and
//! `core_event`'s own `dtend >= dtstart` CHECK — so a one-day all-day event
//! stores `dtend == dtstart` and equality is admitted for it and only for it.

use crate::time::zone::{FireZone, parse_wall_iso};

use super::CommandCtx;

/// The times an event command states, resolved to what the row stores.
#[derive(Debug, Default)]
pub(super) struct Bounds {
    pub start: Option<String>,
    pub end: Option<String>,
    /// The zone `tz` named, when the wall-clock shape was used.
    pub tz: Option<String>,
}

/// Read `dtstart` / `dtend` (and `tz`) from the input. `Err` is the sentence
/// a member reads.
pub(super) fn bounds(ctx: &CommandCtx<'_, '_>) -> Result<Bounds, String> {
    let start = ctx.optional_str("dtstart");
    let end = ctx.optional_str("dtend");
    let Some(tz) = ctx.optional_str("tz") else {
        return Ok(Bounds {
            start: start.map(str::to_owned),
            end: end.map(str::to_owned),
            tz: None,
        });
    };
    if ctx.optional_str("start_tz").is_some() || ctx.optional_str("end_tz").is_some() {
        return Err("Send `tz` or `start_tz`/`end_tz`, not both.".to_owned());
    }
    if ctx
        .optional_str("recurrence_semantics")
        .is_some_and(|semantics| semantics != "zoned")
    {
        return Err("A time in `tz` is zoned; it cannot also be floating or all-day.".to_owned());
    }
    if start.is_none() && end.is_none() {
        return Err("`tz` names the zone of `dtstart`/`dtend`; send at least one.".to_owned());
    }
    let zone = FireZone::named(tz).map_err(|_| format!("{tz} is not a time zone."))?;
    let resolve = |field: &str, value: Option<&str>| -> Result<Option<String>, String> {
        value
            .map(|wall| resolve_wall(field, wall, &zone))
            .transpose()
    };
    Ok(Bounds {
        start: resolve("dtstart", start)?,
        end: resolve("dtend", end)?,
        tz: Some(zone.name().to_owned()),
    })
}

/// A PRECONDITION's view: the resolution's refusal, or nothing.
pub(super) fn bounds_refusal(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    bounds(ctx).err()
}

fn resolve_wall(field: &str, value: &str, zone: &FireZone) -> Result<String, String> {
    let shape = format!(
        "With `tz`, `{field}` is a wall clock, YYYY-MM-DDTHH:MM[:SS] with no Z or offset; got {value}."
    );
    let bare = value.len() >= 16
        && value.as_bytes()[10] == b'T'
        && value[11..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b':' || byte == b'.');
    if !bare {
        return Err(shape);
    }
    let wall = parse_wall_iso(value).ok_or(shape)?;
    zone.resolve_wall_time(wall)
        .map(|resolved| resolved.instant)
        .ok_or_else(|| format!("{value} does not exist in {zone}: the clocks skip it."))
}

/// The ordering refusal, or nothing. `all_day` admits `end == start`.
pub(super) fn order_refusal(start: &str, end: &str, all_day: bool) -> Option<String> {
    if all_day {
        (end < start).then(|| "An all-day event must end on or after the day it starts.".to_owned())
    } else {
        (end <= start).then(|| "An event must end after it starts.".to_owned())
    }
}
