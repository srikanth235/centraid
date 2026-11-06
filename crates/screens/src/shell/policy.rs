//! THE SPRINGBOARD'S LAWS (#1135), pure over tiles and never over a row: which
//! apps, in what order, how big, how they pack into rows, and the verdict on the
//! springboard as a whole.
//!
//! Every verdict here is a statement about the grid AS A WHOLE, and three of
//! them can flip on one tile's arrival, so [`grade`] recomputes all of them from
//! the tiles on every change instead of patching: a `first-run` Home that stayed
//! `first-run` after one app reported content would tell a member their vault is
//! empty while showing them what is in it.

use centraid_api_proto::core_v1 as wire;
use wire::HomeTileSize as Size;
use wire::HomeTileStatus as Status;

/// Every app, in the order the grid places it. A tile's place is decided by
/// this and its content by freshness; a grid built from arrival order would
/// reorder itself under the member's thumb as reads landed.
pub const ORDER: [&str; 8] = [
    "photos", "docs", "agenda", "notes", "money", "health", "people", "locker",
];

/// Columns on a phone.
pub const COLUMNS: usize = 4;

pub const WIDGETS: [&str; 9] = [
    "agenda",
    "reminders",
    "photos",
    "money",
    "health",
    "people",
    "locker",
    "notes",
    "docs",
];

pub fn span(size: Size) -> u32 {
    match size {
        Size::Large => 4,
        Size::Medium => 2,
        _ => 1,
    }
}

/// How big an app's tile is.
#[must_use]
pub fn size_of(app: &str) -> Size {
    match app {
        "photos" => Size::Large,
        "agenda" | "reminders" | "notes" | "docs" => Size::Medium,
        _ => Size::Small,
    }
}

/// Pack in the saved order, preserving the member's arrangement. Small widgets
/// occupy one column, medium two, large four; a full-width accessibility layout
/// is the native renderer's reflow of these same rows.
#[must_use]
pub fn rows(tiles: &[wire::HomeTile]) -> Vec<wire::HomeTileRow> {
    let mut out = Vec::new();
    let mut current = Vec::new();
    let mut occupied = 0;
    for tile in tiles {
        let width = span(tile.size()) as usize;
        if occupied + width > COLUMNS {
            out.push(row(std::mem::take(&mut current)));
            occupied = 0;
        }
        current.push(tile.app_id.clone());
        occupied += width;
        if occupied == COLUMNS {
            out.push(row(std::mem::take(&mut current)));
            occupied = 0;
        }
    }
    if !current.is_empty() {
        out.push(row(current));
    }
    out
}

fn row(app_ids: Vec<String>) -> wire::HomeTileRow {
    wire::HomeTileRow { app_ids }
}

/// The springboard as a whole.
///
/// Content as soon as one tile has some; loading while any is still reading;
/// content (not first-run) when nothing could be read at all, since eight
/// unreadable apps are a failure and not a fresh vault; first-run only when
/// every readable tile is empty.
#[must_use]
pub fn springboard(tiles: &[wire::HomeTile]) -> wire::HomeSpringboard {
    use wire::HomeSpringboard as S;
    if tiles.is_empty() {
        return S::Loading;
    }
    if tiles.iter().any(|tile| tile.status() == Status::Content) {
        return S::Content;
    }
    if tiles.iter().any(|tile| tile.status() == Status::Loading) {
        return S::Loading;
    }
    if tiles.iter().all(|tile| tile.status() == Status::Unknown) {
        return S::Content;
    }
    S::FirstRun
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tile(app: &str, status: Status) -> wire::HomeTile {
        wire::HomeTile {
            app_id: app.to_owned(),
            status: status as i32,
            size: size_of(app) as i32,
            ..wire::HomeTile::default()
        }
    }

    fn all(status: Status) -> Vec<wire::HomeTile> {
        WIDGETS.iter().map(|app| tile(app, status)).collect()
    }

    fn ids(rows: &[wire::HomeTileRow]) -> Vec<Vec<&str>> {
        rows.iter()
            .map(|row| row.app_ids.iter().map(String::as_str).collect())
            .collect()
    }

    #[test]
    fn the_grid_packs_compact_medium_and_large_widgets_in_the_saved_order() {
        assert_eq!(
            ids(&rows(&all(Status::Loading))),
            vec![
                vec!["agenda", "reminders"],
                vec!["photos"],
                vec!["money", "health", "people", "locker"],
                vec!["notes", "docs"],
            ]
        );
    }

    #[test]
    fn the_order_is_preserved_in_a_mixed_size_layout() {
        let tiles: Vec<_> = ["notes", "agenda", "money", "health"]
            .iter()
            .map(|app| tile(app, Status::Content))
            .collect();
        assert_eq!(
            ids(&rows(&tiles)),
            vec![vec!["notes", "agenda"], vec!["money", "health"]]
        );
    }

    #[test]
    fn every_resize_combination_preserves_order_and_stays_within_four_columns() {
        for first in [Size::Small, Size::Medium, Size::Large] {
            for second in [Size::Small, Size::Medium, Size::Large] {
                for third in [Size::Small, Size::Medium, Size::Large] {
                    let tiles: Vec<_> = ["notes", "agenda", "money"]
                        .into_iter()
                        .zip([first, second, third])
                        .map(|(app, size)| wire::HomeTile {
                            size: size as i32,
                            ..tile(app, Status::Content)
                        })
                        .collect();
                    let rows = rows(&tiles);
                    assert_eq!(
                        rows.iter()
                            .flat_map(|row| row.app_ids.iter())
                            .collect::<Vec<_>>(),
                        tiles.iter().map(|tile| &tile.app_id).collect::<Vec<_>>()
                    );
                    for row in rows {
                        let used: u32 = row
                            .app_ids
                            .iter()
                            .map(|id| {
                                span(tiles.iter().find(|tile| &tile.app_id == id).unwrap().size())
                            })
                            .sum();
                        assert!((1..=4).contains(&used));
                    }
                }
            }
        }
    }

    #[test]
    fn the_springboard_is_graded_from_every_tile_each_time() {
        use wire::HomeSpringboard as S;
        assert_eq!(springboard(&[]), S::Loading);
        assert_eq!(springboard(&all(Status::Loading)), S::Loading);
        assert_eq!(springboard(&all(Status::Empty)), S::FirstRun);
        let mut tiles = all(Status::Empty);
        tiles[3].status = Status::Content as i32;
        assert_eq!(springboard(&tiles), S::Content);
        // One still reading holds the verdict: not first-run yet.
        tiles[3].status = Status::Loading as i32;
        assert_eq!(springboard(&tiles), S::Loading);
        // Unknown tiles do not make a first run, and all of them make a failure.
        tiles[3].status = Status::Unknown as i32;
        assert_eq!(springboard(&tiles), S::FirstRun);
        assert_eq!(springboard(&all(Status::Unknown)), S::Content);
    }
}
