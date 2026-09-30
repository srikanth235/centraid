//! THE PHONE'S SHELVES, CUT FROM THE ONE DRIVE WINDOW (#1046).
//!
//! v0 shipped [`crate::queries::load_drive`]'s whole window to every screen and
//! let each one filter, sort and slice it in JavaScript (`logic.ts`'s
//! `currentRows`, `filters.ts`, `folder-counts.ts`). A v1 shell's shared layer
//! holds no second copy of those rules, so the phone names the shelf, the
//! filters and the order, and this module answers the rows that shelf draws
//! plus the counts its rail needs — pure, over the drive's answer, with no
//! read of its own.
//!
//! **Every shelf is cut from ONE window**, the drive's newest-filed `limit`,
//! so when the drive says `truncated` every count here is of that window too.
//! That is v0's own limitation, carried and stated rather than hidden.
//!
//! Civil time is the request's zone: [`local_minute`], [`local_day`] and
//! [`days_between`] are the only date arithmetic, and they read through the
//! vault's one zone database.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use centraid_vault::time::recurrence::parse_instant_ms;
use centraid_vault::time::zone::{FireZone, WallTime, parse_wall_iso, wall_epoch, wall_iso};

use crate::kind::{TypeFilter, kind_of};
use crate::queries::{DocumentRow, DriveData};

/// "Recently added" is a WINDOW, not a filter: v0's phone drew the fifty
/// newest-added live documents (`RecentlyChanged.tsx`'s `RECENT_WINDOW`).
pub const RECENT_WINDOW: usize = 50;

/// Which rows a screen asks for.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Shelf {
    /// Every live document.
    #[default]
    All,
    /// The live direct children of a folder; `None` is the top level.
    Folder(Option<String>),
    Starred,
    Recent,
    Trash,
}

/// v0's Modified pills.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modified {
    Today,
    Last7Days,
    Last30Days,
    ThisYear,
}

/// The column a shelf is ordered by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Sort {
    #[default]
    Changed,
    Name,
    Kind,
    Size,
}

/// A screen's question.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct View {
    pub shelf: Shelf,
    pub type_filter: Option<TypeFilter>,
    pub modified: Option<Modified>,
    pub label: Option<String>,
    pub sort: Sort,
    pub ascending: bool,
}

/// What a shelf answers beside the drive's folders.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ShelfData {
    pub documents: Vec<DocumentRow>,
    /// Live documents filed DIRECTLY in each folder.
    pub folder_counts: BTreeMap<String, usize>,
    /// Every label on a live document, sorted — from the unfiltered set.
    pub labels: Vec<String>,
    pub all_count: usize,
    pub unfiled_count: usize,
    pub starred_count: usize,
    pub trash_count: usize,
}

/// Cut one shelf from the drive's window.
///
/// `today` is the vault clock's local day and `now_ms` its instant; both are
/// the caller's, read once, so every row in one answer is judged by the same
/// clock.
#[must_use]
pub fn shelve(
    drive: &DriveData,
    view: &View,
    zone: &FireZone,
    today: &str,
    now_ms: i64,
) -> ShelfData {
    let live: Vec<&DocumentRow> = drive.documents.iter().filter(|row| !row.trashed).collect();
    let mut folder_counts: BTreeMap<String, usize> = drive
        .folders
        .iter()
        .map(|folder| (folder.folder_id.clone(), 0))
        .collect();
    for row in &live {
        if let Some(count) = row
            .folder_id
            .as_ref()
            .and_then(|folder_id| folder_counts.get_mut(folder_id))
        {
            *count += 1;
        }
    }
    let labels: Vec<String> = live
        .iter()
        .flat_map(|row| row.tags.iter().map(|tag| tag.label.clone()))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();

    let mut documents: Vec<DocumentRow> = match &view.shelf {
        Shelf::All | Shelf::Recent => live.iter().map(|row| (*row).clone()).collect(),
        Shelf::Folder(folder_id) => live
            .iter()
            .filter(|row| row.folder_id.as_deref() == folder_id.as_deref())
            .map(|row| (*row).clone())
            .collect(),
        Shelf::Starred => live
            .iter()
            .filter(|row| row.starred)
            .map(|row| (*row).clone())
            .collect(),
        Shelf::Trash => drive
            .documents
            .iter()
            .filter(|row| row.trashed)
            .cloned()
            .collect(),
    };
    documents.retain(|row| passes(row, view, zone, today, now_ms));

    if view.shelf == Shelf::Recent {
        // The drive's own order is newest-added (`created_at`) first; a window
        // keeps it.
        documents.truncate(RECENT_WINDOW);
    } else if view.shelf == Shelf::Trash && view.sort == Sort::Changed && !view.ascending {
        // TRASH'S DEFAULT IS WHEN IT WENT IN, newest first — what a member
        // looking for the thing they just trashed scans for.
        documents.sort_by(|left, right| {
            right
                .deleted_at
                .cmp(&left.deleted_at)
                .then_with(|| left.document_id.cmp(&right.document_id))
        });
    } else {
        documents.sort_by(|left, right| {
            let order = compare(left, right, view.sort);
            let order = if view.ascending {
                order
            } else {
                order.reverse()
            };
            order.then_with(|| left.document_id.cmp(&right.document_id))
        });
    }

    ShelfData {
        documents,
        folder_counts,
        labels,
        all_count: live.len(),
        unfiled_count: live.iter().filter(|row| row.folder_id.is_none()).count(),
        starred_count: live.iter().filter(|row| row.starred).count(),
        trash_count: drive.documents.len() - live.len(),
    }
}

/// Filters COMPOSE: a chain, never a score (`filters.ts`).
fn passes(row: &DocumentRow, view: &View, zone: &FireZone, today: &str, now_ms: i64) -> bool {
    if let Some(filter) = view.type_filter
        && !filter.admits(row.media_type.as_deref(), row.title.as_deref())
    {
        return false;
    }
    if let Some(label) = &view.label
        && !row.tags.iter().any(|tag| &tag.label == label)
    {
        return false;
    }
    if let Some(modified) = view.modified {
        let stamp = row.updated_at.as_deref().or(row.created_at.as_deref());
        let Some(millis) = stamp.and_then(parse_instant_ms) else {
            // An unreadable stamp matches no window: absent, never "recent".
            return false;
        };
        let within = |days: i64| now_ms - millis <= days * 86_400_000;
        let admitted = match modified {
            Modified::Today => local_day(zone, stamp.unwrap_or_default()) == today,
            Modified::Last7Days => within(7),
            Modified::Last30Days => within(30),
            Modified::ThisYear => {
                local_day(zone, stamp.unwrap_or_default()).get(..4) == today.get(..4)
            }
        };
        if !admitted {
            return false;
        }
    }
    true
}

fn compare(left: &DocumentRow, right: &DocumentRow, sort: Sort) -> Ordering {
    match sort {
        Sort::Changed => left.updated_at.cmp(&right.updated_at),
        Sort::Size => left
            .byte_size
            .unwrap_or_default()
            .cmp(&right.byte_size.unwrap_or_default()),
        Sort::Name => natural(
            left.title.as_deref().unwrap_or_default(),
            right.title.as_deref().unwrap_or_default(),
        ),
        Sort::Kind => kind_of(left.media_type.as_deref(), left.title.as_deref())
            .name()
            .cmp(kind_of(right.media_type.as_deref(), right.title.as_deref()).name())
            .then_with(|| {
                natural(
                    left.title.as_deref().unwrap_or_default(),
                    right.title.as_deref().unwrap_or_default(),
                )
            }),
    }
}

/// Case-insensitive, with digit runs compared as numbers — "Scan 2" before
/// "Scan 10" — which is what v0's `localeCompare(…, {numeric: true,
/// sensitivity: "base"})` did for the titles a drive holds.
#[must_use]
pub fn natural(left: &str, right: &str) -> Ordering {
    let mut a = left.chars().flat_map(char::to_lowercase).peekable();
    let mut b = right.chars().flat_map(char::to_lowercase).peekable();
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let run = |chars: &mut std::iter::Peekable<_>| {
                    let mut digits = String::new();
                    while let Some(c) = chars.peek().copied().filter(char::is_ascii_digit) {
                        digits.push(c);
                        chars.next();
                    }
                    digits
                };
                let (x, y) = (run(&mut a), run(&mut b));
                let (tx, ty) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                let order = tx.len().cmp(&ty.len()).then_with(|| tx.cmp(ty));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }
                a.next();
                b.next();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Civil time, in the request's zone.
// ---------------------------------------------------------------------------

fn wall_of(zone: &FireZone, instant: &str) -> Option<WallTime> {
    parse_instant_ms(instant).map(|millis| zone.zoned_parts(millis))
}

/// `YYYY-MM-DDTHH:MM` — an instant's wall clock in `zone`. EMPTY when the
/// instant does not parse, which no command writes.
#[must_use]
pub fn local_minute(zone: &FireZone, instant: &str) -> String {
    wall_of(zone, instant).map_or_else(String::new, |wall| {
        format!(
            "{}T{:02}:{:02}",
            wall_iso(wall, false),
            wall.hour,
            wall.minute
        )
    })
}

/// `YYYY-MM-DD` — an instant's civil day in `zone`. EMPTY when it does not
/// parse.
#[must_use]
pub fn local_day(zone: &FireZone, instant: &str) -> String {
    wall_of(zone, instant).map_or_else(String::new, |wall| wall_iso(wall, false))
}

/// Whole civil days from `from` to `to`, both `YYYY-MM-DD`: positive when `to`
/// is later. `None` when either does not parse. Day arithmetic, never instant
/// arithmetic, so a DST day is still one day.
#[must_use]
pub fn days_between(from: &str, to: &str) -> Option<i64> {
    let from = parse_wall_iso(from)?;
    let to = parse_wall_iso(to)?;
    Some((wall_epoch(to) - wall_epoch(from)).div_euclid(86_400_000))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order_reads_numbers_as_numbers_and_ignores_case() {
        assert_eq!(natural("Scan 2", "scan 10"), Ordering::Less);
        assert_eq!(natural("lease", "Lease"), Ordering::Equal);
        assert_eq!(natural("a", "ab"), Ordering::Less);
        assert_eq!(natural("v007", "v7"), Ordering::Equal);
    }

    #[test]
    fn a_late_evening_instant_is_the_previous_local_day() {
        let zone = FireZone::named("America/New_York").expect("a zone");
        assert_eq!(local_day(&zone, "2099-06-02T02:00:00.000Z"), "2099-06-01");
        assert_eq!(
            local_minute(&zone, "2099-06-02T02:00:00.000Z"),
            "2099-06-01T22:00"
        );
        assert_eq!(local_day(&zone, "not an instant"), "");
    }

    #[test]
    fn days_between_is_civil() {
        assert_eq!(days_between("2099-06-01", "2099-07-01"), Some(30));
        assert_eq!(days_between("2099-06-10", "2099-06-01"), Some(-9));
        assert_eq!(days_between("2026-03-07", "2026-03-09"), Some(2));
        assert_eq!(days_between("nope", "2099-06-01"), None);
    }
}
