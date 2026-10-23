//! PHOTOS' FULL-TEXT LEG, and the few facts every Photos read shares (#1135).
//!
//! A photograph is an `entity` of kind `photo` (its title is the caption and may
//! be empty) over a `photo` row (the blob, what it is, when and where it was
//! taken); an album is a `container` joined to its photographs by ordered
//! `contains` edges; a heart, the archive and a label are `tagged` edges; a place
//! is a `place` entity; a thumbnail, a perceptual hash and a caption are the
//! blob's `derivative`s. The paged door's one shape is a keyset page of one table,
//! so a screen's read is one bounded read of each table that decorates the ids it
//! names: [`crate::cells`], [`crate::shelf`], [`crate::overview`],
//! [`crate::detail`], [`crate::places`] and [`crate::search`].
//!
//! What is LIVE is not decided here: it is one verdict for every read
//! ([`centraid_apps_kit::rules::Standing`]).

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::MAX_PAGE_ROWS;
use centraid_apps_kit::reads::{FanOutBound, JOIN_FAN_OUT, PageDoor};
use centraid_apps_kit::rules::Standing;

use crate::Denial;

/// What the index and the door call a photograph.
pub const PHOTO_KIND: &str = "photo";

/// The flags a heart and the archive are: `tagged` edges to these concepts.
pub const STARRED: &str = "flag:starred";
pub const ARCHIVED: &str = "flag:archived";

/// How many ranked hits `search` folds.
pub const SEARCH_ROWS: usize = MAX_PAGE_ROWS;

/// Where the vault serves a blob's bytes, by hash.
pub use centraid_apps_kit::attached::BLOB_ROUTE;

/// A join per windowed photograph: 500 x 8 = 4,000 rows, the kit's fan-out.
pub const PHOTO_JOIN_BOUND: FanOutBound = JOIN_FAN_OUT;

/// Tags and album entries are pairs over a 2,000-photograph window: 500 x 32 =
/// 16,000 rows, stated.
pub const PHOTO_PAIR_BOUND: FanOutBound = FanOutBound::new(500, 32);

fn denial_of(message: String) -> Denial {
    Denial {
        code: None,
        message: Some(message),
        revoked_at: None,
    }
}

/// One label on one photograph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhotoTag {
    pub tag_id: String,
    pub label: String,
}

/// Milliseconds in a day.
pub const DAY_MS: i64 = 86_400_000;

/// Whole days until `purge_at`, rounded UP and floored at zero. `None` when there
/// is no date to compare, and **`None` is not `0`**: "no grace window recorded" is
/// not "purges today".
#[must_use]
pub fn purge_in_days(purge_at: Option<&str>, now_ms: i64) -> Option<i64> {
    let parsed = parse_instant_ms(purge_at?)?;
    let ms = parsed - now_ms;
    Some(if ms <= 0 {
        0
    } else {
        (ms + DAY_MS - 1) / DAY_MS
    })
}

/// `Date.parse` for the ISO-8601 UTC instants the vault writes.
///
/// Deliberately narrow: the vault's own spelling is
/// `strftime('%Y-%m-%dT%H:%M:%fZ')`, so anything else is a value the port
/// refuses to guess at rather than one it reinterprets. v0's `Date.parse`
/// accepts far more and answers `NaN` for the rest, which becomes a `null`
/// `purge_in_days` — the same answer this gives.
#[must_use]
pub fn parse_instant_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let number = |from: usize, to: usize| -> Option<i64> { text.get(from..to)?.parse().ok() };
    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    let hour = number(11, 13)?;
    let minute = number(14, 16)?;
    let second = number(17, 19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let millis = if bytes.get(19) == Some(&b'.') {
        number(20, 23).unwrap_or(0)
    } else {
        0
    };
    // Days from the civil epoch (Howard Hinnant's `days_from_civil`), which is
    // exact for every year the vault can hold and needs no calendar crate.
    let year_shifted = year - i64::from(month <= 2);
    let era = if year_shifted >= 0 {
        year_shifted
    } else {
        year_shifted - 399
    } / 400;
    let year_of_era = year_shifted - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1_000 + millis)
}

// ---------------------------------------------------------------------------
// The full-text leg of `search`
// ---------------------------------------------------------------------------

/// What the full-text leg answers: the photographs whose caption, place or
/// recognised text the term names, in the index's **rank order**. A grid reads the
/// photographs themselves by these ids; the order it draws them in is its own.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SearchData {
    pub photo_ids: Vec<String>,
}

/// Ask the index for `term` over photographs and keep the hits that are LIVE
/// (`Standing::is_live`: not trashed, not archived, not folded under an edit). The
/// index holds live photographs only; the archive is an edge and the fold a fact of
/// a group, so the verdict is asked for the ids that came back. `limit` is clamped
/// to [`SEARCH_ROWS`]. A blank term, a term with no searchable word and a zero
/// `limit` answer the empty shape and no denial.
///
/// # Errors
///
/// A reached bound, as the other reads.
pub fn load_search_term(
    _door: &dyn PageDoor,
    standing: &Standing,
    search: &dyn centraid_search::Search,
    principal: &centraid_search::Principal,
    term: &str,
    limit: usize,
) -> KitResult<(SearchData, Option<Denial>)> {
    let term = term.trim();
    if term.is_empty() || limit == 0 {
        return Ok((SearchData::default(), None));
    }
    let request = centraid_search::SearchRequest::new(PHOTO_KIND, term, limit.min(SEARCH_ROWS));
    let page = match search.query(principal, &request) {
        Ok(centraid_search::Answer::Data { page, .. }) => page,
        Ok(centraid_search::Answer::Denied(denial)) => {
            return Ok((
                SearchData::default(),
                Some(Denial {
                    code: denial.code,
                    message: denial.message,
                    revoked_at: denial.revoked_at,
                }),
            ));
        }
        Err(centraid_search::SearchError::NoSearchableWords { .. }) => {
            return Ok((SearchData::default(), None));
        }
        Err(other) => return Ok((SearchData::default(), Some(denial_of(other.to_string())))),
    };
    Ok((
        SearchData {
            photo_ids: page
                .rows
                .into_iter()
                .map(|target| target.id)
                .filter(|id| standing.is_live(id))
                .collect(),
        },
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_countdown_is_whole_days_rounded_up_and_never_zero_for_no_date() {
        let now = parse_instant_ms("2026-06-01T00:00:00.000Z").expect("an instant");
        assert_eq!(
            purge_in_days(Some("2026-06-02T00:00:00.001Z"), now),
            Some(2)
        );
        assert_eq!(
            purge_in_days(Some("2026-06-01T00:00:00.000Z"), now),
            Some(0)
        );
        assert_eq!(purge_in_days(None, now), None);
    }
}
