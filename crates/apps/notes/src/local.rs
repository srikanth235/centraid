//! THE JOURNAL BY THE MEMBER'S LOCAL DAY (#1046).
//!
//! `mobile/shared`'s `commonMain` has no calendar or zone library, and the
//! Journal place still reads as days — "Today", "Tuesday 3 June". So the core
//! groups the entries by the civil day each was WRITTEN on (`created_at`), in
//! the zone the request states, through the vault's one zone engine
//! ([`FireZone`], the same `crates/apps/agenda`'s `local` module reads). A
//! shell reads `YYYY-MM-DD` strings and does no zone arithmetic.
//!
//! Every function is pure: entries, a zone and the vault clock in; days out.

use std::collections::BTreeMap;

use centraid_vault::time::recurrence::parse_instant_ms;
use centraid_vault::time::zone::{FireZone, WallTime, wall_iso};

use crate::queries::JournalEntry;

/// One journal entry, placed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacedEntry {
    pub entry: JournalEntry,
    /// `HH:MM`, the wall clock `created_at` reads in the zone.
    pub local_time: String,
}

/// One local day of the Journal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalDay {
    /// `YYYY-MM-DD` in the zone.
    pub day: String,
    /// Newest `created_at` first.
    pub entries: Vec<PlacedEntry>,
}

/// The civil day an instant falls on in `zone`.
#[must_use]
pub fn civil_day(zone: &FireZone, instant: &str) -> Option<String> {
    parse_instant_ms(instant).map(|millis| wall_iso(zone.zoned_parts(millis), false))
}

fn civil_time(wall: WallTime) -> String {
    format!("{:02}:{:02}", wall.hour, wall.minute)
}

/// The vault clock's day in `zone`.
#[must_use]
pub fn today(zone: &FireZone, now: &str) -> Option<String> {
    civil_day(zone, now)
}

/// The entries grouped by the local day of their `created_at`, newest day
/// first.
///
/// `knowledge_note.created_at` is `NOT NULL` and written by the vault clock,
/// so every entry parses; one that did not would be placed on its
/// `updated_at`, and one with neither on the first ten characters of what it
/// has — an entry is never dropped from the Journal over its date.
#[must_use]
pub fn journal_days(entries: Vec<JournalEntry>, zone: &FireZone) -> Vec<JournalDay> {
    let mut days: BTreeMap<String, Vec<PlacedEntry>> = BTreeMap::new();
    for entry in entries {
        let stamp = entry
            .created_at
            .clone()
            .or_else(|| entry.updated_at.clone())
            .unwrap_or_default();
        let parsed = parse_instant_ms(&stamp)
            .or_else(|| entry.updated_at.as_deref().and_then(parse_instant_ms));
        let (day, local_time) = match parsed {
            Some(millis) => {
                let wall = zone.zoned_parts(millis);
                (wall_iso(wall, false), civil_time(wall))
            }
            None => (stamp.chars().take(10).collect(), String::new()),
        };
        days.entry(day)
            .or_default()
            .push(PlacedEntry { entry, local_time });
    }
    days.into_iter()
        .rev()
        .map(|(day, mut entries)| {
            entries.sort_by(|left, right| right.entry.created_at.cmp(&left.entry.created_at));
            JournalDay { day, entries }
        })
        .collect()
}
