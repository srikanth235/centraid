//! THE RULES EVERY APP APPLIES THE SAME WAY (#1135).
//!
//! Four questions every app had answered for itself, in four spellings:
//!
//! | Question | The rule | Where it is stated |
//! |---|---|---|
//! | Is it **live**? | the entity is not trashed: `deleted_at IS NULL` | [`LIVE`], [`is_live`] |
//! | Is it **archived**? | it carries a `tagged` edge to `flag:archived` | [`ARCHIVED_FLAG`], [`archived_ids`] |
//! | How long does the **trash** wait? | [`TRASH_DAYS`], the vault's own, which stamps `purge_at` | [`purge_at`], [`days_left`] |
//! | What does a **zone-less wall time** mean? | the member's local wall clock | [`civil_ms`] |
//!
//! Archived is a lookup and not a predicate: the kit's grammar refuses a
//! subquery, so an app asks which of the ids it already holds are archived
//! ([`archived_ids`]) and filters in Rust, as Tasks' board does.
//!
//! The civil reader is the vault's ([`centraid_vault::time::civil`]); it is
//! re-exported here so an app reaches one name for it.

use std::collections::BTreeSet;

use centraid_vault::time::civil::parse_civil_ms;
use centraid_vault::time::recurrence::parse_instant_ms;
use centraid_vault::time::zone::FireZone;

pub use centraid_vault::commands::entity::TRASH_DAYS;

use crate::error::KitResult;
use crate::reads::{PageDoor, Read};
use crate::row::{Row, text_of};
use crate::statement::PageBindValue;

/// The tag an archived entity carries: `tagged` edge to this id.
pub const ARCHIVED_FLAG: &str = "flag:archived";

/// The predicate for a live (not trashed) entity, over a table with `deleted_at`.
pub const LIVE: &str = "deleted_at IS NULL";

/// The predicate for a trashed entity, over a table with `deleted_at`.
pub const TRASHED: &str = "deleted_at IS NOT NULL";

/// Whether an entity with this `deleted_at` is live.
#[must_use]
pub const fn is_live(deleted_at: Option<&str>) -> bool {
    deleted_at.is_none()
}

/// Which of `ids` are archived: the `from_id` of a `tagged` edge to
/// [`ARCHIVED_FLAG`].
///
/// # Errors
/// The door's refusal, or a fan-out ceiling.
pub fn archived_ids(door: &dyn PageDoor, ids: &[String]) -> KitResult<BTreeSet<String>> {
    let rows: Vec<Row> = Read {
        name: "kit.rules.archived",
        table: "edge",
        select: "from_id, to_id",
        order: ("from_id", "from_id"),
        column: "from_id",
    }
    .of(
        door,
        ids,
        Some((
            "rel = ? AND to_id = ?",
            vec![
                PageBindValue::Text("tagged".to_owned()),
                PageBindValue::Text(ARCHIVED_FLAG.to_owned()),
            ],
        )),
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| text_of(row, "from_id"))
        .collect())
}

/// When a thing trashed at `deleted_at` may be purged: the instant
/// [`TRASH_DAYS`] later, in the spelling the vault writes. `None` when
/// `deleted_at` is not an instant.
#[must_use]
pub fn purge_at(deleted_at: &str) -> Option<String> {
    let at = parse_instant_ms(deleted_at)?;
    Some(centraid_vault::clock::format_iso_ms(
        at + TRASH_DAYS * 86_400_000,
    ))
}

/// Whole days left before a thing trashed at `deleted_at` is purged, counted
/// from `now` and never below zero. `None` when either is not an instant.
#[must_use]
pub fn days_left(deleted_at: &str, now: &str) -> Option<i64> {
    let due = parse_instant_ms(&purge_at(deleted_at)?)?;
    let remaining = due - parse_instant_ms(now)?;
    Some(remaining.max(0).div_euclid(86_400_000))
}

/// A date or datetime as an instant. A zone-less wall time is the member's own
/// clock in `zone`; a date is UTC midnight; a designator is its instant.
#[must_use]
pub fn civil_ms(value: &str, zone: &FireZone) -> Option<i64> {
    parse_civil_ms(value, zone)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdoor::TestDoor;
    use rusqlite::Connection;

    #[test]
    fn the_trash_window_is_the_vaults_and_counts_down_to_zero() {
        assert_eq!(TRASH_DAYS, 30);
        let trashed = "2026-10-01T00:00:00.000Z";
        assert_eq!(
            purge_at(trashed).as_deref(),
            Some("2026-10-31T00:00:00.000Z")
        );
        assert_eq!(days_left(trashed, "2026-10-01T00:00:00.000Z"), Some(30));
        assert_eq!(days_left(trashed, "2026-10-30T12:00:00.000Z"), Some(0));
        assert_eq!(days_left(trashed, "2026-12-01T00:00:00.000Z"), Some(0));
        assert_eq!(purge_at("not a time"), None);
    }

    #[test]
    fn live_is_not_trashed() {
        assert!(is_live(None));
        assert!(!is_live(Some("2026-10-01T00:00:00.000Z")));
    }

    #[test]
    fn a_zoneless_wall_time_is_the_zones() {
        let new_york = FireZone::named("America/New_York").expect("a zone");
        assert_eq!(
            civil_ms("2026-10-22T09:00", &new_york),
            parse_instant_ms("2026-10-22T13:00:00.000Z")
        );
    }

    #[test]
    fn archived_ids_names_the_tagged_edges_among_the_ids_asked() {
        let connection = Connection::open_in_memory().expect("a connection");
        connection
            .execute_batch(
                "CREATE TABLE edge (id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, rel TEXT);
                 INSERT INTO edge VALUES ('e1','a','flag:archived','tagged');
                 INSERT INTO edge VALUES ('e2','b','flag:starred','tagged');
                 INSERT INTO edge VALUES ('e3','c','flag:archived','tagged');",
            )
            .expect("seeded");
        let door = TestDoor::new(&connection);
        let ids = ["a", "b", "d"].map(str::to_owned);
        let archived = archived_ids(&door, &ids).expect("a read");
        assert_eq!(archived, BTreeSet::from(["a".to_owned()]));
        assert!(archived_ids(&door, &[]).expect("no ids").is_empty());
    }
}
