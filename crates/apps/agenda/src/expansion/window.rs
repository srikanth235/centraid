//! Bounded original-time windows around recurrence exceptions. The caller
//! filters the resulting rows by its actual displayed or alarm instant.
use std::collections::BTreeMap;

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_vault::clock::format_iso_ms as iso_of;
use centraid_vault::time::occurrence::{self, SeriesType, StoredExceptionRow};
use centraid_vault::time::recurrence::{
    self, ExceptionAction, ExceptionScope, ExpandInput, Occurrence, Semantics, parse_instant_ms,
};
use centraid_vault::time::zone::{FireZone, wall_iso};

use super::{MAX_TOTAL_INSTANCES, event_duration_ms, occurrence_row};
use crate::queries::EventRow;

fn bound(at: i64, semantics: Semantics) -> String {
    if semantics == Semantics::Zoned {
        iso_of(at)
    } else {
        wall_iso(centraid_vault::time::zone::wall_from_epoch(at), true)
    }
}

fn original_at(key: &str, semantics: Semantics, zone: &FireZone) -> Option<i64> {
    if semantics == Semantics::Zoned {
        centraid_vault::time::civil::parse_civil_ms(key, zone)
    } else {
        parse_instant_ms(key)
    }
}

/// Expand the earliest bounded prefix in each active exception segment using
/// the shared recurrence engine. `from`/`to` are engine-comparison values:
/// instants for zoned series and civil epochs for floating/all-day series.
/// Explicit moved originals/anchors are included; callers apply their own
/// final display/alert interval after interpreting any timing override.
pub(crate) fn expand_series_window(
    event: &EventRow,
    exceptions: &[StoredExceptionRow],
    from: i64,
    to: i64,
    zone: &FireZone,
    limit: usize,
) -> KitResult<Vec<EventRow>> {
    let Some(rule) = event.rrule.as_deref() else {
        return Ok(vec![EventRow {
            instance_key: event.event_id.clone(),
            ..event.clone()
        }]);
    };
    let semantics = event.semantics();
    let event_exceptions =
        occurrence::exceptions_of(exceptions, SeriesType::Event, &event.event_id);
    let matcher = occurrence::recurrence_exceptions_of(&event_exceptions);
    let mut future: Vec<_> = matcher
        .iter()
        .filter(|item| item.scope == ExceptionScope::Future)
        .collect();
    future.sort_by(|left, right| left.original_start.cmp(&right.original_start));
    let one_off_count = matcher
        .iter()
        .filter(|item| item.scope == ExceptionScope::Occurrence)
        .count();
    let limit = limit.saturating_add(one_off_count);
    if limit > MAX_TOTAL_INSTANCES || matcher.len() > MAX_TOTAL_INSTANCES {
        return Err(KitError::FanOutExceeded {
            query: "agenda.expansion.exceptions".into(),
            cap: MAX_TOTAL_INSTANCES,
        });
    }
    let expand = |from: i64, to: i64, count: usize| {
        let from = bound(from, semantics);
        let to = bound(to, semantics);
        let mut input = ExpandInput::new(rule, &event.dtstart, &from, &to)
            .with_semantics(semantics)
            .at_most(count);
        input.zone = Some(zone);
        recurrence::expand(&input)
    };
    let mut base: BTreeMap<String, Occurrence> = BTreeMap::new();
    // Each future override defines its own original-time segment. Shifting
    // separate windows avoids exhausting a dense rule in a long moved gap.
    for index in 0..=future.len() {
        let active = index.checked_sub(1).map(|index| future[index]);
        if active.is_some_and(|item| item.action == ExceptionAction::Skip) {
            continue;
        }
        let delta = active
            .and_then(|item| {
                let original = original_at(&item.original_start, semantics, zone)?;
                parse_instant_ms(item.start.as_deref()?)
                    .and_then(|moved| moved.checked_sub(original))
            })
            .unwrap_or(0);
        let segment_from =
            active.and_then(|item| original_at(&item.original_start, semantics, zone));
        let segment_to = future
            .get(index)
            .and_then(|item| original_at(&item.original_start, semantics, zone));
        let lower = from
            .saturating_sub(delta)
            .max(segment_from.unwrap_or(i64::MIN));
        let upper = to.saturating_sub(delta).min(segment_to.unwrap_or(i64::MAX));
        if lower >= upper {
            continue;
        }
        for instance in expand(lower, upper, limit) {
            base.insert(instance.wall_start.clone(), instance);
        }
        if base.len() > MAX_TOTAL_INSTANCES {
            return Err(KitError::FanOutExceeded {
                query: "agenda.expansion.window".into(),
                cap: MAX_TOTAL_INSTANCES,
            });
        }
    }
    // Explicit moved occurrences can originate outside the window. Future
    // anchors also give the shared matcher their true zoned instant, rather
    // than making it infer that instant from a civil key.
    for exception in &matcher {
        let Some(at) = original_at(&exception.original_start, semantics, zone) else {
            continue;
        };
        for instance in expand(at, at.saturating_add(1), 1) {
            base.insert(instance.wall_start.clone(), instance);
        }
    }
    if base.len() > MAX_TOTAL_INSTANCES {
        return Err(KitError::FanOutExceeded {
            query: "agenda.expansion.window".into(),
            cap: MAX_TOTAL_INSTANCES,
        });
    }
    let base: Vec<_> = base.into_values().collect();
    let duration = event_duration_ms(event);
    Ok(recurrence::apply_exceptions(&base, &matcher)
        .iter()
        .map(|instance| occurrence_row(event, instance, duration, &event_exceptions))
        .collect())
}
