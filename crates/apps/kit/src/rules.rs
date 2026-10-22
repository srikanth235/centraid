//! THE RULES EVERY APP APPLIES THE SAME WAY (#1135).
//!
//! Five questions every app had answered for itself, in five spellings:
//!
//! | Question | The rule | Where it is stated |
//! |---|---|---|
//! | Is it **live**? | the entity is not trashed: `deleted_at IS NULL` | [`LIVE`], [`is_live`] |
//! | Is it **archived**? | it carries a `tagged` edge to `flag:archived` | [`ARCHIVED_FLAG`], [`archived_ids`] |
//! | How long does the **trash** wait? | [`TRASH_DAYS`], the vault's own, which stamps `purge_at` | [`purge_at`], [`days_left`] |
//! | What does a **zone-less wall time** mean? | the member's local wall clock | [`civil_ms`] |
//! | Is a **photograph** live, on the archive shelf, or in the trash? | [`Standing`] | [`Standing::is_live`], [`Standing::on_archive_shelf`], [`Standing::is_trashed`] |
//!
//! Archived is a lookup and not a predicate: the kit's grammar refuses a
//! subquery, so an app asks which of the ids it already holds are archived
//! ([`archived_ids`]) and filters in Rust, as Tasks' board does.
//!
//! The civil reader is the vault's ([`centraid_vault::time::civil`]); it is
//! re-exported here so an app reaches one name for it.

use std::collections::{BTreeMap, BTreeSet};

use centraid_vault::time::civil::parse_civil_ms;
use centraid_vault::time::recurrence::parse_instant_ms;
use centraid_vault::time::zone::FireZone;

pub use centraid_vault::commands::entity::TRASH_DAYS;

use crate::error::KitResult;
use crate::reads::{FanOutBound, PageDoor, Read, read_pages, read_pages_by_predicate};
use crate::row::{Row, text_of};
use crate::statement::{PageBindValue, PageOrder, PageQuery};

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

// ---------------------------------------------------------------------------
// Photographs (#1135): ONE definition of live, where there were six.
// ---------------------------------------------------------------------------

/// What `entity.kind` calls a photograph.
pub const PHOTO_KIND: &str = "photo";

/// The tag a hearted entity carries: `tagged` edge to this id.
pub const STARRED_FLAG: &str = "flag:starred";

/// How far a whole-library walk may go: 500 rows a page, 400 pages, so 200,000
/// photographs. Past it the read ERRORS ([`crate::KitError::FanOutExceeded`]); a
/// count that stopped early would be a wrong number that reads as a right one.
pub const LIBRARY_WALK: FanOutBound = FanOutBound::new(500, 400);

/// What the fold needs to know about one photograph that belongs to a group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grouped {
    pub id: String,
    /// `photo`, `video` or `scan`.
    pub form: Option<String>,
    pub burst: Option<String>,
    pub edited_from: Option<String>,
}

impl Grouped {
    fn is_still(&self) -> bool {
        self.form.as_deref() == Some("photo")
    }
}

/// THE FOLD: which photographs an edit hides.
///
/// A phone's edited photograph arrives as two photographs of one capture: the
/// camera's bytes, and the edit's render with `edited_from` naming them and a
/// shared `burst`. The library draws the newest live one of a group, so the grid
/// shows the edit, the original is still there, and trashing or archiving the edit
/// brings the original back. A second edit folds the first the same way.
///
/// A photograph is folded when a LIVE, UNARCHIVED, GROUPED still supersedes it,
/// in one of two ways. **It was made from it** (the camera original of an iOS
/// edit, or an Android file edited in place, whose earlier version carries no
/// burst and is named by the edit's lineage alone). **Or it shares its burst and
/// is newer**: not the photograph it was made from, and with the larger id (an id
/// is minted in time order, so the larger is the newer). A crop saved from
/// Centraid's own editor carries no burst and folds nothing. A Live Photo's movie
/// shares its still's burst and is a `video`, which this never touches.
///
/// `all` is every photograph that carries a burst; `superseding` says which of
/// them are live and unarchived.
#[must_use]
pub fn folded_by_edits(all: &[Grouped], superseding: impl Fn(&str) -> bool) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut bursts: BTreeMap<&str, Vec<&Grouped>> = BTreeMap::new();
    for photo in all.iter().filter(|photo| photo.is_still()) {
        let Some(burst) = photo.burst.as_deref() else {
            continue;
        };
        bursts.entry(burst).or_default().push(photo);
        if superseding(&photo.id)
            && let Some(origin) = photo.edited_from.as_deref()
        {
            out.insert(origin.to_owned());
        }
    }
    for group in bursts.values() {
        // The newest superseding stills first, so the first one that is not the
        // photograph's own source settles it.
        let mut newer: Vec<&Grouped> = group
            .iter()
            .copied()
            .filter(|photo| superseding(&photo.id))
            .collect();
        newer.sort_by(|left, right| right.id.cmp(&left.id));
        for older in group {
            let folds = newer
                .iter()
                .take_while(|photo| photo.id > older.id)
                .any(|photo| older.edited_from.as_deref() != Some(photo.id.as_str()));
            if folds {
                out.insert(older.id.clone());
            }
        }
    }
    out
}

/// WHERE EVERY PHOTOGRAPH STANDS: trashed, archived, or folded under an edit.
///
/// The trash is the `entity`'s, the archive is an edge, and the fold is a fact
/// about a group of `photo` rows, so none of them is a column of the row a page
/// reads and the kit's grammar refuses the subquery that would say it. The
/// verdict is read once and every Photos read asks it, which is what makes the
/// library, the shelves, the counts, Home's tile, search and the duplicates one
/// answer:
///
/// * **live** = not trashed AND not archived AND not folded. The library, the
///   favorites and videos shelves, a place's shelf, the unplaced shelf, search,
///   the duplicates and every count of them.
/// * **the archive shelf** = not trashed AND archived. A photograph archived and
///   then thrown away is on the trash shelf only; the archive is not folded.
/// * **the trash** = every trashed photograph, archived or not.
/// * **an album** draws every member that is not trashed: archiving puts a
///   photograph away from the timeline, not out of a list the member curated, and
///   an edit's original is a member they chose.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Standing {
    /// Photographs whose entity is in the trash, and when each was put there.
    pub trashed: BTreeMap<String, String>,
    /// Entities tagged `flag:archived`: any kind, so ask about a photograph id.
    pub archived: BTreeSet<String>,
    /// Photographs an edit hides.
    pub folded: BTreeSet<String>,
}

impl Standing {
    /// Read the three verdicts.
    ///
    /// # Errors
    /// The door's refusal, or a walk past [`LIBRARY_WALK`].
    pub fn read(door: &dyn PageDoor) -> KitResult<Self> {
        let trashed: BTreeMap<String, String> = read_pages_by_predicate(
            door,
            &PageQuery::new(
                "kit.rules.photos.trashed",
                "id, deleted_at",
                "entity",
                PageOrder::desc("deleted_at", "id"),
            )
            .filter(
                "kind = ? AND deleted_at IS NOT NULL",
                vec![PageBindValue::Text(PHOTO_KIND.to_owned())],
            ),
            LIBRARY_WALK,
        )?
        .iter()
        .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "deleted_at")?)))
        .collect();
        let archived = ids_of(&read_pages(
            door,
            &PageQuery::new(
                "kit.rules.photos.archived",
                "from_id, to_id",
                "edge",
                PageOrder::asc("from_id", "to_id"),
            )
            .filter(
                "rel = ? AND to_id = ?",
                vec![
                    PageBindValue::Text("tagged".to_owned()),
                    PageBindValue::Text(ARCHIVED_FLAG.to_owned()),
                ],
            ),
            LIBRARY_WALK,
        )?);
        let grouped = grouped_photos(door)?;
        let folded = folded_by_edits(&grouped, |id| {
            !trashed.contains_key(id) && !archived.contains(id)
        });
        Ok(Self {
            trashed,
            archived,
            folded,
        })
    }

    /// In the trash: the trash shelf, archived or not.
    #[must_use]
    pub fn is_trashed(&self, id: &str) -> bool {
        self.trashed.contains_key(id)
    }

    /// Put away with the archive flag, trashed or not.
    #[must_use]
    pub fn is_archived(&self, id: &str) -> bool {
        self.archived.contains(id)
    }

    /// On the library's shelves: not trashed, not archived, not folded.
    #[must_use]
    pub fn is_live(&self, id: &str) -> bool {
        !self.trashed.contains_key(id) && !self.archived.contains(id) && !self.folded.contains(id)
    }

    /// On the archive shelf: archived and not trashed.
    #[must_use]
    pub fn on_archive_shelf(&self, id: &str) -> bool {
        self.archived.contains(id) && !self.trashed.contains_key(id)
    }

    /// Whether an album draws this member: anything that is not trashed.
    #[must_use]
    pub fn in_album_view(&self, id: &str) -> bool {
        !self.trashed.contains_key(id)
    }
}

fn ids_of(rows: &[Row]) -> BTreeSet<String> {
    rows.iter()
        .filter_map(|row| text_of(row, "id").or_else(|| text_of(row, "from_id")))
        .collect()
}

/// Every photograph that carries a burst: the only ones a fold can involve.
///
/// # Errors
/// The door's refusal, or a walk past [`LIBRARY_WALK`].
pub fn grouped_photos(door: &dyn PageDoor) -> KitResult<Vec<Grouped>> {
    Ok(read_pages(
        door,
        &PageQuery::new(
            "kit.rules.photos.grouped",
            "id, blob, form, burst, edited_from",
            "photo",
            PageOrder::asc("blob", "id"),
        )
        .filter("burst IS NOT NULL", Vec::new()),
        LIBRARY_WALK,
    )?
    .iter()
    .filter_map(|row| {
        Some(Grouped {
            id: text_of(row, "id")?,
            form: text_of(row, "form"),
            burst: text_of(row, "burst"),
            edited_from: text_of(row, "edited_from"),
        })
    })
    .collect())
}

/// Every photograph's id, in id order: the set a count is taken over.
///
/// # Errors
/// The door's refusal, or a walk past [`LIBRARY_WALK`].
pub fn photo_ids(door: &dyn PageDoor) -> KitResult<Vec<String>> {
    Ok(read_pages(
        door,
        &PageQuery::new(
            "kit.rules.photos.ids",
            "id, blob",
            "photo",
            PageOrder::asc("blob", "id"),
        ),
        LIBRARY_WALK,
    )?
    .iter()
    .filter_map(|row| text_of(row, "id"))
    .collect())
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

    fn grouped(id: &str, form: &str, burst: Option<&str>, from: Option<&str>) -> Grouped {
        Grouped {
            id: id.to_owned(),
            form: Some(form.to_owned()),
            burst: burst.map(str::to_owned),
            edited_from: from.map(str::to_owned),
        }
    }

    /// AN EDIT DRAWS AND THE ORIGINAL STAYS UNDERNEATH: the render folds the camera's
    /// bytes, a second edit folds the first, and a movie of a burst is never folded.
    /// Ids are minted in time order, so the larger is the newer.
    #[test]
    fn an_edit_folds_what_it_was_made_from_and_a_crop_folds_nothing() {
        let set =
            |ids: &[&str]| -> BTreeSet<String> { ids.iter().map(|id| (*id).to_owned()).collect() };
        let all = [
            grouped("a", "photo", Some("b"), None),
            grouped("b", "photo", Some("b"), Some("a")),
            grouped("c", "photo", Some("b"), Some("b")),
            grouped("d", "video", Some("b"), None),
        ];
        assert_eq!(folded_by_edits(&all, |_| true), set(&["a", "b"]));
        // Trashing the newest edit brings the one under it back.
        assert_eq!(folded_by_edits(&all, |id| id != "c"), set(&["a"]));
        // Trashing every edit brings the original back.
        assert!(folded_by_edits(&all, |id| id == "a" || id == "d").is_empty());
        // A crop carries no burst, so it is not in the grouped set at all.
    }

    /// Two edits of one original: the newer folds the older sibling and the
    /// original; an original that is itself newer than its edit is not folded by
    /// the arm that is about "shares a burst and is newer".
    #[test]
    fn the_newer_of_a_burst_folds_the_older_unless_the_older_was_made_from_it() {
        let all = [
            grouped("a", "photo", Some("b"), None),
            grouped("b", "photo", Some("b"), None),
        ];
        assert_eq!(
            folded_by_edits(&all, |_| true),
            ["a"].map(str::to_owned).into_iter().collect()
        );
        // `a` was made from `b`, the larger id: `b` does not fold its own source's
        // lineage backwards, so `a` (the edit) is not folded by it.
        let lineage = [
            grouped("a", "photo", Some("b"), Some("b")),
            grouped("b", "photo", Some("b"), None),
        ];
        let folds = folded_by_edits(&lineage, |_| true);
        assert!(!folds.contains("a"), "{folds:?}");
        assert!(folds.contains("b"), "the edit folds its source: {folds:?}");
    }
}
