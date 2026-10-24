//! ONE PHOTOGRAPH, AS EVERY GRID DRAWS IT (#1135): the core's [`wire::PhotosCell`]
//! made into the [`wire::PhotoTile`] a shell paints. The library, a shelf, the
//! picker, the film strip, a search hit and a duplicate cluster all go through
//! [`tile`], so what a cell says about this device cannot differ between them.
//!
//! ## What this device holds
//!
//! A path is NOT the whole state. The door's thumbnail path falls back to the
//! original's hash on a vault with no derivative rows, so a present path means
//! the original on some libraries and a thumbnail on others: `original_held` is
//! its own column, and [`held_of`] is the one function that derives the closed
//! [`Held`] enum from it. `HELD_FETCHING` is never produced here: a tap is not a
//! fact a page read can see, so the screen that started the fetch paints it over
//! the cell the member touched.
//!
//! The arithmetic of what crosses on which link is the core's
//! (`phone::drain::Conditions`); [`would_withhold`] states only which sentence a
//! cell shows, and a disagreement costs a label and never a byte.
//!
//! ## A Live Photo is two photographs and one cell
//!
//! The still says `live` and names its movie; the movie says whose it is
//! (`live_of`). [`dedupe_live`] drops a movie whose still is among the cells, and
//! keeps one whose still has not arrived yet: it IS a video, and hiding it on a
//! guess would lose it if the still never came.

use std::collections::HashSet;

use centraid_api_proto::core_v1 as wire;
use wire::photo_tile::{Held, Kind};

use crate::kit::civil;
use crate::strings::{Locale, fill, photos as words};

/// The member's transfer rule and whether the link is metered: the two facts a
/// cell's download arrow depends on. The default is the product's own default
/// (Wi-Fi only, on a link that is not metered) until a screen is told better.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Link {
    pub rule: wire::TransferRule,
    pub metered: bool,
}

impl Default for Link {
    fn default() -> Self {
        Self {
            rule: wire::TransferRule::WifiOnly,
            metered: false,
        }
    }
}

/// Would an ordinary window refuse to ask for this original? The core's
/// `Conditions` for a pass nobody asked for: `MANUAL` withholds everything,
/// `WIFI_ONLY` withholds on a metered link, and photographs-on-cellular still
/// withholds a video there. An unspecified rule is `WIFI_ONLY`, as the core
/// reads it.
#[must_use]
pub fn would_withhold(kind: Kind, link: Link) -> bool {
    match link.rule {
        wire::TransferRule::Manual => true,
        wire::TransferRule::WifiAndCellularPhotos => link.metered && kind == Kind::Video,
        wire::TransferRule::WifiOnly | wire::TransferRule::Unspecified => link.metered,
    }
}

/// What this device has of one photograph. Five states in the order they
/// exclude each other:
///
/// 1. the original is here;
/// 2. there is no original to ask for (no hash), so nothing is offered: a
///    thumbnail, or nothing;
/// 3. the member's rule is why the original is not here: the download arrow,
///    when a thumbnail is under it to carry one;
/// 4. a thumbnail is here and nothing holds the original back;
/// 5. nothing at all has reached this device.
#[must_use]
pub fn held_of(
    thumbnail: bool,
    original_held: bool,
    original_hash: &str,
    kind: Kind,
    link: Link,
) -> Held {
    let thumbnail_state = if thumbnail {
        Held::ThumbnailOnly
    } else {
        Held::Absent
    };
    if original_held {
        Held::Original
    } else if original_hash.is_empty() {
        thumbnail_state
    } else if would_withhold(kind, link) && thumbnail {
        Held::WithheldByRule
    } else if would_withhold(kind, link) {
        Held::Absent
    } else {
        thumbnail_state
    }
}

/// The kind of a photograph from its `form`.
#[must_use]
pub fn kind_of(form: Option<&str>) -> Kind {
    match form {
        Some("photo") => Kind::Photo,
        Some("video") => Kind::Video,
        Some("scan") => Kind::Scan,
        _ => Kind::Unspecified,
    }
}

/// The capture-local day, `YYYY-MM-DD`, of a capture instant and the offset it
/// was taken under; empty when the instant is not a narrow RFC 3339 stamp. A
/// photograph is filed under the day it was taken where it was taken, so a
/// 20:00-local one is never filed under the next day's UTC date, and one whose
/// day cannot be told is undated rather than guessed at.
#[must_use]
pub fn capture_day(taken_at: &str, offset_minutes: i64) -> String {
    epoch_minutes(taken_at).map_or_else(String::new, |instant| {
        civil::civil_day_of((instant + offset_minutes).div_euclid(MINUTES_PER_DAY))
    })
}

/// The capture-local clock, `HH:MM` on 24 hours; empty when there is no capture
/// time. The same instant and offset as [`capture_day`], so the stamp's date and
/// time cannot name two moments.
#[must_use]
pub fn capture_clock(taken_at: &str, offset_minutes: i64) -> String {
    epoch_minutes(taken_at).map_or_else(String::new, |instant| {
        let minute_of_day = (instant + offset_minutes).rem_euclid(MINUTES_PER_DAY);
        format!("{:02}:{:02}", minute_of_day / 60, minute_of_day % 60)
    })
}

const MINUTES_PER_DAY: i64 = 1_440;

/// Minutes since the epoch of `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)`.
fn epoch_minutes(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20
        || !matches!(bytes[10], b'T' | b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let day = civil::epoch_day_of(text.get(0..10)?)?;
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    if !(0..24).contains(&hour) || !(0..60).contains(&minute) {
        return None;
    }
    // The seconds and any fraction never move a minute into another day, so the
    // zone is found past them rather than parsed out of them.
    let mut at = 19;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
    }
    let zone = match *bytes.get(at)? {
        b'Z' | b'z' => 0,
        sign @ (b'+' | b'-') => {
            if bytes.len() < at + 6 || bytes[at + 3] != b':' {
                return None;
            }
            let hours: i64 = text.get(at + 1..at + 3)?.parse().ok()?;
            let minutes: i64 = text.get(at + 4..at + 6)?.parse().ok()?;
            let signed = hours * 60 + minutes;
            if sign == b'+' { signed } else { -signed }
        }
        _ => return None,
    };
    Some(day * MINUTES_PER_DAY + hour * 60 + minute - zone)
}

/// `1:04`, `12:07`, `1:02:03`: a recording's length, with an hours arm so a
/// 61-minute one does not read `61:40`.
#[must_use]
pub fn clock(seconds: u32) -> String {
    let hours = seconds / 3_600;
    let minutes = (seconds % 3_600) / 60;
    let rest = seconds % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{rest:02}")
    } else {
        format!("{minutes}:{rest:02}")
    }
}

/// A count that may be a floor, as a phrase: `5 photos`, `1 photo`, `At least 5
/// photos`; `Empty` for a shelf holding nothing. A count read off a page that
/// filled is a floor, and a bare number over it would state a total nobody
/// counted. "At least 1 photo" is a true sentence, so the noun follows the count
/// alone.
#[must_use]
pub fn count_phrase(locale: Locale, count: u32, capped: bool) -> String {
    if count == 0 && !capped {
        return words::photos_count_empty(locale);
    }
    let noun = if count == 1 {
        words::tile_count_one(locale)
    } else {
        words::tile_count_many(locale)
    };
    let quantity = format!("{count} {noun}");
    if capped {
        fill(
            &words::photos_count_at_least(locale),
            &[("quantity", &quantity)],
        )
    } else {
        quantity
    }
}

/// A whole number of seconds from the core's real, truncated and never
/// negative. A float-to-integer cast saturates, so a huge length is `u32::MAX`.
fn whole_seconds(seconds: f64) -> u32 {
    seconds.max(0.0).floor() as u32
}

fn positive(value: Option<i64>) -> u32 {
    value
        .filter(|value| *value > 0)
        .map_or(0, |value| u32::try_from(value).unwrap_or(u32::MAX))
}

/// What a screen reader says of a cell: the noun, with the preview's absence
/// when no thumbnail is here.
fn accessibility(locale: Locale, cell: &wire::PhotosCell, kind: Kind) -> String {
    let noun = if cell.live {
        words::photos_cell_live(locale)
    } else if kind == Kind::Video {
        words::photos_cell_video(locale)
    } else {
        words::photograph(locale)
    };
    if cell
        .thumbnail_path
        .as_deref()
        .is_some_and(|path| !path.is_empty())
    {
        noun
    } else {
        fill(&words::photos_cell_preview_gone(locale), &[("noun", &noun)])
    }
}

/// The core's cell as the shell draws it.
#[must_use]
pub fn tile(cell: &wire::PhotosCell, link: Link, locale: Locale) -> wire::PhotoTile {
    let kind = kind_of(cell.form.as_deref());
    let thumbnail_path = cell.thumbnail_path.clone().filter(|path| !path.is_empty());
    let seconds = if kind == Kind::Video {
        cell.duration_s.map_or(0, whole_seconds)
    } else {
        0
    };
    let held = held_of(
        thumbnail_path.is_some(),
        cell.original_held,
        &cell.content_id,
        kind,
        link,
    );
    wire::PhotoTile {
        photo_id: cell.photo_id.clone(),
        content_id: cell.content_id.clone(),
        accessibility_label: accessibility(locale, cell, kind),
        thumbnail_path,
        held: held as i32,
        kind: kind as i32,
        favorite: cell.favorite,
        archived: cell.archived,
        capture_group: cell.burst.clone().unwrap_or_default(),
        width: positive(cell.width),
        height: positive(cell.height),
        duration_seconds: seconds,
        duration_label: if seconds > 0 {
            clock(seconds)
        } else {
            String::new()
        },
        day: cell
            .taken_at
            .as_deref()
            .map(|at| capture_day(at, cell.offset_min.unwrap_or(0)))
            .unwrap_or_default(),
        live: cell.live,
        live_movie_id: cell.live_movie_id.clone().unwrap_or_default(),
        fetch_percent: 0,
        title: cell.title.clone(),
        purge_in_days: positive(cell.purge_in_days),
        live_label: if cell.live {
            words::photos_cell_live_mark(locale)
        } else {
            String::new()
        },
        held_label: match held {
            Held::WithheldByRule => words::photos_cell_download_full(locale),
            Held::Fetching => words::photos_cell_downloading_mark(locale),
            _ => String::new(),
        },
    }
}

/// The cells a grid draws: a Live Photo's movie is folded into its still.
pub fn dedupe_live(cells: &[wire::PhotosCell]) -> Vec<&wire::PhotosCell> {
    let ids: HashSet<&str> = cells.iter().map(|cell| cell.photo_id.as_str()).collect();
    cells
        .iter()
        .filter(|cell| {
            cell.live_of
                .as_deref()
                .is_none_or(|still| !ids.contains(still))
        })
        .collect()
}

/// [`dedupe_live`], then [`tile`] each.
#[must_use]
pub fn tiles(cells: &[wire::PhotosCell], link: Link, locale: Locale) -> Vec<wire::PhotoTile> {
    dedupe_live(cells)
        .into_iter()
        .map(|cell| tile(cell, link, locale))
        .collect()
}
