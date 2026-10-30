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
pub const COLUMNS: usize = 2;

/// How big an app's tile is.
#[must_use]
pub fn size_of(app: &str) -> Size {
    match app {
        "photos" => Size::Large,
        "agenda" => Size::Medium,
        _ => Size::Small,
    }
}

/// Whether an app's tile takes a whole row.
#[must_use]
pub fn is_wide(app: &str) -> bool {
    size_of(app) != Size::Small
}

/// The tiles in the order they sit: a small tile pulls the next small ones up
/// beside it, so a wide tile between two small ones does not leave a hole.
#[must_use]
pub fn pack(tiles: &[wire::HomeTile]) -> Vec<&wire::HomeTile> {
    let mut queue: Vec<&wire::HomeTile> = tiles.iter().collect();
    let mut packed = Vec::with_capacity(queue.len());
    while !queue.is_empty() {
        let next = queue.remove(0);
        packed.push(next);
        if next.wide {
            continue;
        }
        for _ in 1..COLUMNS {
            let Some(partner) = queue.iter().position(|tile| !tile.wide) else {
                break;
            };
            packed.push(queue.remove(partner));
        }
    }
    packed
}

/// The packed tiles cut into rows: a wide tile alone, small ones in `COLUMNS`.
#[must_use]
pub fn rows(tiles: &[wire::HomeTile]) -> Vec<wire::HomeTileRow> {
    let mut out = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for tile in pack(tiles) {
        if tile.wide {
            if !current.is_empty() {
                out.push(row(std::mem::take(&mut current)));
            }
            out.push(row(vec![tile.app_id.clone()]));
            continue;
        }
        current.push(tile.app_id.clone());
        if current.len() == COLUMNS {
            out.push(row(std::mem::take(&mut current)));
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
            wide: is_wide(app),
            ..wire::HomeTile::default()
        }
    }

    fn all(status: Status) -> Vec<wire::HomeTile> {
        ORDER.iter().map(|app| tile(app, status)).collect()
    }

    fn ids(rows: &[wire::HomeTileRow]) -> Vec<Vec<&str>> {
        rows.iter()
            .map(|row| row.app_ids.iter().map(String::as_str).collect())
            .collect()
    }

    #[test]
    fn the_grid_packs_small_tiles_beside_each_other_around_the_wide_ones() {
        assert_eq!(
            ids(&rows(&all(Status::Loading))),
            vec![
                vec!["photos"],
                vec!["docs", "notes"],
                vec!["agenda"],
                vec!["money", "health"],
                vec!["people", "locker"],
            ]
        );
    }

    #[test]
    fn a_small_tile_pulls_the_next_small_one_up_past_a_wide_tile() {
        let tiles: Vec<_> = ["notes", "agenda", "money", "health"]
            .iter()
            .map(|app| tile(app, Status::Content))
            .collect();
        assert_eq!(
            ids(&rows(&tiles)),
            vec![vec!["notes", "money"], vec!["agenda"], vec!["health"]]
        );
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
