//! A BLOCK DRAGGED ON THE HOUR GRID (#1173): the write it makes and the
//! guess it never writes.
//!
//! A drop reports a minute; the core snaps it ([`grid::snap`]) and writes the
//! event's new times the way the editor saves a time change: `edit-event` for a
//! one-off, `edit-occurrence` (this occurrence only) for one of a series. A move
//! keeps the event's length; a resize keeps its start and is never under
//! [`grid::MIN_BLOCK`] long. The core has no inverse for either, so Undo is the
//! same command carrying the old times ([`Ops::changed`]), under a key of its
//! own. A refusal shows the vault's sentence and changes nothing.
//!
//! A long press on an empty slot writes nothing: it opens the add sheet at the
//! snapped time, and the member saves or walks away.

use centraid_api_proto::core_v1 as wire;

use super::{Home, grid};
use crate::calendar::event::is_series_occurrence;
use crate::calendar::routes;
use crate::catalog::act::calendar as command_cal;
use crate::field::Field;
use crate::kit::civil;
use crate::screen::Ctx;
use crate::strings::agenda_grid as sayings;

/// An event's times as the grid and the vault state them: `YYYY-MM-DDTHH:MM`.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Times {
    start: String,
    end: String,
}

impl Times {
    /// What the held occurrence has now. No end is its start: an instant.
    fn of(event: &wire::AgendaEvent) -> Self {
        let start = event.local_start.get(..16).unwrap_or_default().to_owned();
        let end = event
            .local_end
            .get(..16)
            .map_or_else(|| start.clone(), str::to_owned);
        Self { start, end }
    }
}

/// The command that writes `times` on `event`: the editor's own.
fn write(event: &wire::AgendaEvent, times: &Times, zone: &str) -> wire::ActRequest {
    let starts = Some(format!("{}:00", times.start));
    let ends = Field::Is(format!("{}:00", times.end));
    let zone = Field::Is(zone.to_owned());
    if is_series_occurrence(event) {
        command_cal::EditOccurrence {
            action: command_cal::EditOccurrenceAction::Override,
            event_id: event.event_id.clone(),
            original_start: event.original_start_local.clone().unwrap_or_default(),
            scope: command_cal::EditOccurrenceScope::Occurrence,
            starts,
            ends,
            zone,
            ..command_cal::EditOccurrence::default()
        }
        .into()
    } else {
        command_cal::EditEvent {
            event_id: event.event_id.clone(),
            starts,
            ends,
            zone,
            ..command_cal::EditEvent::default()
        }
        .into()
    }
}

/// The press, snapped: the add sheet's route for an event on `day` at that time.
#[must_use]
pub fn slot(day: &str, minute: i32) -> Option<wire::Route> {
    civil::epoch_day_of(day)?;
    Some(routes::editor_at(
        day,
        &grid::clock_label(grid::snap(minute)),
    ))
}

impl Home {
    /// The held occurrence a block stands for, when it can be dragged.
    fn dragged(&self, instance_key: &str) -> Option<wire::AgendaEvent> {
        if instance_key.is_empty() {
            return None;
        }
        self.held
            .upcoming
            .as_ref()?
            .events
            .iter()
            .find(|event| event.instance_key == instance_key && grid::draggable(event))
            .cloned()
    }

    /// A block dropped with its top at `moved.minute` on `moved.day`.
    pub(super) fn move_event(&mut self, ctx: &Ctx, moved: &wire::agenda_home_event::EventMoved) {
        let Some(event) = self.dragged(&moved.instance_key) else {
            return;
        };
        if civil::epoch_day_of(&moved.day).is_none() {
            return;
        }
        let from = Times::of(&event);
        let length = grid::minutes_of(&from.end)
            .zip(grid::minutes_of(&from.start))
            .map_or(0, |(end, start)| (end - start).max(0));
        let start = format!(
            "{}T{}",
            moved.day,
            grid::clock_label(grid::snap(moved.minute))
        );
        let Some(opens) = grid::minutes_of(&start) else {
            return;
        };
        let to = Times {
            end: grid::local_of(opens + length),
            start,
        };
        self.rewrite(ctx, &event, &from, &to, sayings::event_moved(ctx.locale()));
    }

    /// A block's foot dropped at `resized.end_minute` on its own day.
    pub(super) fn resize_event(
        &mut self,
        ctx: &Ctx,
        resized: &wire::agenda_home_event::EventResized,
    ) {
        let Some(event) = self.dragged(&resized.instance_key) else {
            return;
        };
        let from = Times::of(&event);
        let day = from.start.get(..10).unwrap_or_default();
        let (Some(midnight), Some(opens)) = (
            grid::minutes_of(&format!("{day}T00:00")),
            grid::minutes_of(&from.start),
        ) else {
            return;
        };
        let ends = (midnight + i64::from(grid::snap_end(resized.end_minute)))
            .max(opens + i64::from(grid::MIN_BLOCK));
        let to = Times {
            start: from.start.clone(),
            end: grid::local_of(ends),
        };
        self.rewrite(
            ctx,
            &event,
            &from,
            &to,
            sayings::event_changed(ctx.locale()),
        );
    }

    /// Write `to`, with the old times behind Undo. Nothing changed, nothing written.
    fn rewrite(
        &mut self,
        ctx: &Ctx,
        event: &wire::AgendaEvent,
        from: &Times,
        to: &Times,
        sentence: String,
    ) {
        if from == to {
            return;
        }
        let zone = ctx.zone();
        self.ops.changed(
            ctx,
            &event.instance_key,
            write(event, to, zone),
            write(event, from, zone),
            sentence,
        );
        // Committed or refused, the next draw is the vault's: a refused block
        // snaps back to where it was.
        self.refresh(ctx);
    }
}
