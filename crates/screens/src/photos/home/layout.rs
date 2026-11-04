//! THE LIBRARY'S LAYOUT RULES, ONCE (#1029; v0's `justify.ts`, `timeline-rows.ts`,
//! `PhotoGrainView.tsx`, `photos-rungs.ts`): uniform square packing, the rows a width makes of the cells, the cards a grain draws, how
//! months pair, the tile sizes, and the pinch table.
//!
//! The cells arrive newest first and already grouped by the read's order, so a
//! section is a run of equal `day`s and NOTHING IS RE-SORTED: a re-sort would
//! make this a different library from the one the lightbox walks. The shell
//! reports a width; everything else is arithmetic over it.

use centraid_api_proto::core_v1 as wire;
use wire::PhotosGrain as Grain;

use crate::kit::civil;
use crate::strings::{Locale, photos as words};

/// The gutter between tiles, both axes: the 4 base rung halved.
pub const GAP: f64 = 2.0;
/// How far past the width a row packs before it closes.
pub const OVERSHOOT: f64 = 0.28;

/// The phone's tile heights, XS to L (`photos-rungs.ts`).
pub const RUNG_HEIGHTS: [u32; 4] = [64, 88, 120, 168];
pub const RUNG_LABELS: [&str; 4] = ["XS", "S", "M", "L"];
/// v0's `DEFAULT_RUNG`: M.
pub const DEFAULT_RUNG: u32 = 2;
/// The device-memory key the tile size is kept under.
pub const RUNG_KEY: &str = "photos.tileSize";

/// The key of the undated tail.
pub const UNDATED: &str = "undated";

#[must_use]
pub fn clamp_rung(rung: u32) -> u32 {
    rung.min(RUNG_HEIGHTS.len() as u32 - 1)
}

/// One photograph's pixel box. The grid draws every photograph in the same
/// square, so the box only counts the tile.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Boxed {
    pub width: u32,
    pub height: u32,
}

/// One packed tile: the input it came from, and its box in the row.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Packed {
    pub index: usize,
    pub width: f64,
    pub height: f64,
}

/// The rows `boxes` pack into at `container`: one square size, the same number of
/// tiles to every row (the last may hold fewer), in the order given.
#[must_use]
pub fn justify(boxes: &[Boxed], container: f64, target: f64) -> Vec<Vec<Packed>> {
    pack(boxes.len(), container, target)
}

/// THE GRID IS ONE SIZE: every tile is the same square, `columns` to a row, so a
/// photograph alone in its row is one cell and not a stretched one, and the first
/// row is the height of every other (the tile's shape is the grid's, never the
/// photograph's: a photograph is cropped to fill its cell).
fn pack(count: usize, container: f64, target: f64) -> Vec<Vec<Packed>> {
    if container <= 0.0 || target <= 0.0 || count == 0 {
        return Vec::new();
    }
    // The fewest columns whose cells are no taller than the target allows.
    let mut columns = 1usize;
    while (columns as f64) * target < container - GAP * (columns as f64 - 1.0) + target * OVERSHOOT
    {
        columns += 1;
    }
    let spare = container - GAP * (columns as f64 - 1.0);
    let side = (spare / columns as f64).floor();
    let remainder = spare - side * columns as f64;
    let mut rows = Vec::new();
    let mut next = 0;
    while next < count {
        let end = (next + columns).min(count);
        let full = end - next == columns;
        rows.push(
            (next..end)
                .map(|index| Packed {
                    index,
                    // A FULL ROW REACHES THE EDGE: the pixels the division left go to its last tile.
                    width: if full && index + 1 == end {
                        side + remainder
                    } else {
                        side
                    },
                    height: side,
                })
                .collect(),
        );
        next = end;
    }
    rows
}

/// THE GRID IS THE LOADING STATE (v0 §14): the placeholders' rows at the rung's
/// own geometry, so the photographs land where their placeholders stood. The
/// aspect sequence is FIXED (random aspects would flicker) and both halves of
/// the count round up: too few reads as "the library ends here".
#[must_use]
pub fn skeleton(container: f64, target: f64, viewport_height: f64) -> Vec<Vec<Packed>> {
    let unit = target.max(1.0);
    let per_row = ((container / unit) as usize).max(1) + 1;
    let row_count = ((viewport_height / unit) as usize + 1).max(1);
    pack(per_row * row_count, container, target)
}

/// What a row of the All grain is.
pub use wire::PhotosRowKind as RowKind;

/// One cell as the layout sees it.
#[derive(Clone, Debug)]
pub struct Cell<'a> {
    pub id: &'a str,
    pub day: &'a str,
    pub video: bool,
    pub boxed: Boxed,
}

/// THE MONTH A DAY BELONGS TO: its `YYYY-MM`, or [`UNDATED`] for no day.
#[must_use]
pub fn month_key(day: &str) -> String {
    if day.is_empty() {
        UNDATED.to_owned()
    } else {
        day.chars().take(7).collect()
    }
}

/// `August 2026`, or "Undated" for the tail.
#[must_use]
pub fn month_title(locale: Locale, key: &str) -> String {
    if key == UNDATED {
        return words::photos_undated(locale);
    }
    let parts: Vec<u32> = key
        .split('-')
        .filter_map(|part| part.parse().ok())
        .collect();
    match parts.as_slice() {
        [year, month] => format!("{} {year}", civil::month_name(locale, *month)),
        _ => key.to_owned(),
    }
}

/// `Fri, Aug 14`, with the year when it is not this one.
fn day_title(locale: Locale, day: &str, current_year: i32) -> String {
    let parts: Vec<i32> = day
        .split('-')
        .filter_map(|part| part.parse().ok())
        .collect();
    let [year, month, _] = parts.as_slice() else {
        return day.to_owned();
    };
    let month_name = civil::month_name(locale, u32::try_from(*month).unwrap_or(0));
    let short: String = month_name.chars().take(3).collect();
    let dom = civil::day_of_month_of(day).unwrap_or(0);
    let head = format!("{}, {short} {dom}", civil::weekday_short(locale, day));
    if *year == current_year {
        head
    } else {
        format!("{head}, {year}")
    }
}

/// One row of All, before the picked set is known.
#[derive(Clone, Debug)]
pub struct Row {
    pub kind: RowKind,
    pub id: String,
    pub day: String,
    pub title: String,
    pub ids: Vec<String>,
    pub tiles: Vec<Packed>,
}

/// CELLS INTO ROWS (v0's `buildRows`): a month header where the month changes, a
/// day header per day, then the day's cells justified at the rung's height. THE
/// UNDATED TAIL HAS ONE HEADER, "Undated", and no day under it.
#[must_use]
pub fn rows(
    locale: Locale,
    cells: &[Cell<'_>],
    width: f64,
    rung: u32,
    current_year: i32,
) -> Vec<Row> {
    let target = f64::from(RUNG_HEIGHTS[clamp_rung(rung) as usize]);
    let mut out = Vec::new();
    let mut month: Option<String> = None;
    let mut start = 0;
    while start < cells.len() {
        let day = cells[start].day;
        let mut end = start;
        while end < cells.len() && cells[end].day == day {
            end += 1;
        }
        // A SECTION THAT PACKS TO NOTHING (no width reported yet) DRAWS NO HEADER: a month or
        // a day with no photographs under it is a title stuck over the next month's.
        let section = &cells[start..end];
        let boxes: Vec<Boxed> = section.iter().map(|cell| cell.boxed).collect();
        let packed = justify(&boxes, width, target);
        if packed.is_empty() {
            start = end;
            continue;
        }
        let key = month_key(day);
        if month.as_deref() != Some(key.as_str()) {
            out.push(Row {
                kind: RowKind::Month,
                id: format!("m:{key}"),
                day: day.to_owned(),
                title: month_title(locale, &key),
                ids: Vec::new(),
                tiles: Vec::new(),
            });
            month = Some(key);
        }
        if !day.is_empty() {
            out.push(Row {
                kind: RowKind::Day,
                id: format!("d:{day}"),
                day: day.to_owned(),
                title: day_title(locale, day, current_year),
                ids: section.iter().map(|cell| cell.id.to_owned()).collect(),
                tiles: Vec::new(),
            });
        }
        for (at, tiles) in packed.into_iter().enumerate() {
            out.push(Row {
                kind: RowKind::Tiles,
                id: format!("r:{day}:{at}"),
                day: day.to_owned(),
                title: String::new(),
                ids: Vec::new(),
                // The packer names tiles within the day; the library names them
                // within the cells.
                tiles: tiles
                    .into_iter()
                    .map(|tile| Packed {
                        index: start + tile.index,
                        ..tile
                    })
                    .collect(),
            });
        }
        start = end;
    }
    out
}

/// One Years or Months card.
#[derive(Clone, Debug)]
pub struct Period {
    pub key: String,
    pub title: String,
    pub count: String,
    /// Index of the cell that covers it: the newest with a thumbnail, else the
    /// newest.
    pub cover: usize,
    pub anchor_day: String,
}

/// PERIODS FROM CELLS (v0's `buildPeriods`), in the cells' own newest-first
/// order. COVER = NEWEST. Undated photographs are in All only: "sometime" is not
/// a stretch of time.
#[must_use]
pub fn periods(
    locale: Locale,
    cells: &[Cell<'_>],
    has_thumbnail: impl Fn(usize) -> bool,
    years: bool,
) -> Vec<Period> {
    let width = if years { 4 } else { 7 };
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, Vec<usize>> =
        std::collections::HashMap::new();
    for (index, cell) in cells.iter().enumerate() {
        if cell.day.is_empty() {
            continue;
        }
        let key: String = cell.day.chars().take(width).collect();
        groups
            .entry(key.clone())
            .or_insert_with(|| {
                order.push(key);
                Vec::new()
            })
            .push(index);
    }
    order
        .into_iter()
        .map(|key| {
            let group = &groups[&key];
            let videos = group.iter().filter(|at| cells[**at].video).count();
            Period {
                title: if years {
                    key.clone()
                } else {
                    month_title(locale, &key)
                },
                count: describe_counts(locale, group.len() - videos, videos),
                cover: group
                    .iter()
                    .copied()
                    .find(|at| has_thumbnail(*at))
                    .unwrap_or(group[0]),
                anchor_day: cells[group[0]].day.to_owned(),
                key,
            }
        })
        .collect()
}

/// `3 photos · 1 video` (v0's `describeCounts`).
fn describe_counts(locale: Locale, photographs: usize, videos: usize) -> String {
    let mut parts = Vec::new();
    if photographs > 0 {
        let noun = if photographs == 1 {
            words::tile_count_one(locale)
        } else {
            words::tile_count_many(locale)
        };
        parts.push(format!("{photographs} {noun}"));
    }
    if videos > 0 {
        let noun = if videos == 1 {
            words::photos_video_one(locale)
        } else {
            words::photos_video_many(locale)
        };
        parts.push(format!("{videos} {noun}"));
    }
    if parts.is_empty() {
        format!("0 {}", words::tile_count_many(locale))
    } else {
        parts.join(" · ")
    }
}

/// One item of a grain's list: a year header, a year card, or a pair of months.
#[derive(Clone, Debug)]
pub struct GrainItem {
    pub key: String,
    pub header: String,
    pub periods: Vec<Period>,
}

/// What a grain's list holds. Years: a card each. Months: two to a row, PAIRED
/// WITHIN A YEAR, with a year header only when the library spans more than one
/// year. An odd month leaves its column empty: a wider card would read as a
/// bigger month. A pair's key is its first month's.
#[must_use]
pub fn grain_items(periods: Vec<Period>, years: bool) -> Vec<GrainItem> {
    if years {
        return periods
            .into_iter()
            .map(|period| GrainItem {
                key: format!("y:{}", period.key),
                header: String::new(),
                periods: vec![period],
            })
            .collect();
    }
    let year_of = |period: &Period| period.key.chars().take(4).collect::<String>();
    let mut spans: Vec<String> = periods.iter().map(year_of).collect();
    spans.dedup();
    let spans_years = {
        let mut unique = spans.clone();
        unique.sort();
        unique.dedup();
        unique.len() > 1
    };
    let mut items = Vec::new();
    let mut at = 0;
    while at < periods.len() {
        let year = year_of(&periods[at]);
        let mut end = at;
        while end < periods.len() && year_of(&periods[end]) == year {
            end += 1;
        }
        if spans_years {
            items.push(GrainItem {
                key: format!("h:{year}"),
                header: year.clone(),
                periods: Vec::new(),
            });
        }
        for pair in periods[at..end].chunks(2) {
            items.push(GrainItem {
                key: format!("p:{}", pair[0].key),
                header: String::new(),
                periods: pair.to_vec(),
            });
        }
        at = end;
    }
    items
}

/// THE DAY A GRAIN LANDS ON (v0's `anchorForGrain`): a period's key is a PREFIX
/// of every day it holds, so the period containing a day is the day cut to the
/// key's width, and its anchor is the NEWEST loaded day with that prefix. Empty
/// (the top) for no day or the undated tail.
#[must_use]
pub fn anchor(grain: Grain, day: &str, days: &[&str]) -> String {
    if day.is_empty() {
        return String::new();
    }
    let width = match grain {
        Grain::Years => 4,
        Grain::Months => 7,
        _ => return day.to_owned(),
    };
    let prefix: String = day.chars().take(width).collect();
    days.iter()
        .find(|candidate| !candidate.is_empty() && candidate.starts_with(&prefix))
        .map_or_else(String::new, |found| (*found).to_owned())
}

/// ONE GRAIN NARROWER: what a period card opens (Years to Months, Months to All).
#[must_use]
pub fn narrower(grain: Grain) -> Grain {
    match grain {
        Grain::Years => Grain::Months,
        _ => Grain::All,
    }
}

/// Where a pinch lands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pinch {
    pub grain: Grain,
    pub rung: u32,
}

const PINCH_OUT: f32 = 1.15;
const PINCH_IN: f32 = 0.86;

/// A PINCH IS A STEPPER PRESS, NOT A CONTINUOUS ZOOM (v0 §4.2), and past the
/// table's ends it moves the GRAIN: Apple Photos' pinch, which zooms out of the
/// smallest tiles into Months and on into Years, and back in the other way.
#[must_use]
pub fn pinch(grain: Grain, rung: u32, scale: f32) -> Pinch {
    let out = scale >= PINCH_OUT;
    let inward = scale <= PINCH_IN;
    if !out && !inward {
        return Pinch { grain, rung };
    }
    match grain {
        Grain::Years => {
            if out {
                Pinch {
                    grain: Grain::Months,
                    rung,
                }
            } else {
                Pinch { grain, rung }
            }
        }
        Grain::Months => Pinch {
            grain: if out { Grain::All } else { Grain::Years },
            rung,
        },
        Grain::All | Grain::Unspecified => {
            if out {
                Pinch {
                    grain: Grain::All,
                    rung: clamp_rung(rung + 1),
                }
            } else if rung > 0 {
                Pinch {
                    grain: Grain::All,
                    rung: rung - 1,
                }
            } else {
                Pinch {
                    grain: Grain::Months,
                    rung,
                }
            }
        }
    }
}

/// The current UTC year, which decides only whether a day's title prints its
/// year.
#[must_use]
pub fn current_year() -> i32 {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| i64::try_from(since.as_secs()).unwrap_or(0));
    civil::civil_day_of(seconds.div_euclid(86_400))
        .get(0..4)
        .and_then(|year| year.parse().ok())
        .unwrap_or(2026)
}
