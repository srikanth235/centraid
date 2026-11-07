//! THE WIDGET FOLD (#1135, #1173), pure over widgets and never over a row: which
//! widgets, in what order, how big, how they pack into rows, and the verdict on
//! the springboard as a whole.
//!
//! Home is a grid of widgets on four columns, like the phone's own: a small
//! widget is one column, a medium two, a large all four. Each app has one widget
//! except Agenda, which has two: the day, and what is owed today (Reminders),
//! which exists only while something is owed. An app's widgets wear that app's
//! colour; the shells take it from `app_id`, and `widget` is the identity.
//!
//! A widget with something to show is its own size ([`size_of`]). One with
//! nothing to show (an empty app, an unreadable one) is medium, because what it
//! says ("Write your first note") needs the room. The order is the content
//! order, or on day one the first-run order, which leads with the apps a first
//! move belongs to.
//!
//! Every verdict here is a statement about the grid AS A WHOLE, and three of
//! them can flip on one tile's arrival, so [`fold`] recomputes all of them from
//! the tiles on every change instead of patching: a `first-run` Home that stayed
//! `first-run` after one app reported content would tell a member their vault is
//! empty while showing them what is in it.

use centraid_api_proto::core_v1 as wire;
use wire::HomeTileSize as Size;
use wire::HomeTileStatus as Status;

use super::tiles::REMINDERS;

/// Every app, in the order Home reads them. A widget's place is decided by
/// [`CONTENT_ORDER`] or [`FIRST_RUN_ORDER`], never by arrival: a grid built from
/// arrival order would reorder itself under the member's thumb as reads landed.
pub const ORDER: [&str; 8] = [
    "photos", "docs", "agenda", "notes", "money", "health", "people", "locker",
];

/// The widgets in the order they sit once the vault holds something (the Home
/// board): the day and what is owed, the photographs, the glances, then the two
/// that read as a line.
pub const CONTENT_ORDER: [&str; 9] = [
    "agenda", REMINDERS, "photos", "money", "health", "people", "locker", "notes", "docs",
];

/// The widgets on day one (the First Home board): every app's first move, the
/// calendar and the photographs first.
pub const FIRST_RUN_ORDER: [&str; 8] = [
    "agenda", "photos", "notes", "docs", "people", "money", "health", "locker",
];

/// Columns on the grid: a small widget takes one, a medium two, a large four.
pub const COLUMNS: u32 = 4;

/// How wide a size is, in columns.
#[must_use]
pub fn span(size: Size) -> u32 {
    match size {
        Size::Small | Size::Unspecified => 1,
        Size::Medium => 2,
        Size::Large => COLUMNS,
    }
}

/// How big a widget is while it has something to show.
#[must_use]
pub fn content_size(widget: &str) -> Size {
    match widget {
        "photos" => Size::Large,
        "agenda" | REMINDERS | "notes" | "docs" => Size::Medium,
        _ => Size::Small,
    }
}

/// How big a widget is: its own size with something to show, medium when it
/// shows an invitation or nothing yet. A widget still reading keeps its own, so
/// the usual case does not move when it lands.
#[must_use]
pub fn size_of(widget: &str, status: Status) -> Size {
    match status {
        Status::Empty | Status::Unknown => Size::Medium,
        _ => content_size(widget),
    }
}

/// How many grid rows tall: the calendar, the reminders and the photographs hold
/// a list or a strip, so they take two; the rest take one.
#[must_use]
pub fn height_of(widget: &str) -> u32 {
    match widget {
        "agenda" | REMINDERS | "photos" => 2,
        _ => 1,
    }
}

/// What the fold made of the widgets.
pub struct Folded {
    pub springboard: wire::HomeSpringboard,
    /// In the order they sit, each with its size and height set.
    pub tiles: Vec<wire::HomeTile>,
    pub rows: Vec<wire::HomeTileRow>,
}

/// Fold the widgets read into the springboard: grade it, put the widgets in the
/// order that grade names, size each, and cut them into rows.
#[must_use]
pub fn fold(tiles: Vec<wire::HomeTile>) -> Folded {
    let springboard = springboard(&tiles);
    let order: &[&str] = if springboard == wire::HomeSpringboard::FirstRun {
        &FIRST_RUN_ORDER
    } else {
        &CONTENT_ORDER
    };
    let place = |widget: &str| {
        order
            .iter()
            .position(|known| *known == widget)
            .unwrap_or(order.len())
    };
    let mut tiles = tiles;
    tiles.sort_by_key(|tile| place(&tile.widget));
    for tile in &mut tiles {
        let size = size_of(&tile.widget, tile.status());
        tile.size = size as i32;
        tile.height = height_of(&tile.widget);
    }
    let rows = rows(&tiles);
    Folded {
        springboard,
        tiles,
        rows,
    }
}

/// The widgets cut into rows of [`COLUMNS`] columns, in order: a row takes the
/// next widget, then the earliest later ones that still fit beside it, so a wide
/// widget between small ones leaves no hole.
#[must_use]
pub fn rows(tiles: &[wire::HomeTile]) -> Vec<wire::HomeTileRow> {
    let mut queue: Vec<&wire::HomeTile> = tiles.iter().collect();
    let mut out = Vec::new();
    while !queue.is_empty() {
        let first = queue.remove(0);
        let mut left = COLUMNS.saturating_sub(span(first.size()));
        let mut widgets = vec![first.widget.clone()];
        while left > 0 {
            let Some(at) = queue.iter().position(|tile| span(tile.size()) <= left) else {
                break;
            };
            let next = queue.remove(at);
            left -= span(next.size());
            widgets.push(next.widget.clone());
        }
        out.push(wire::HomeTileRow { widgets });
    }
    out
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

    fn tile(widget: &str, status: Status) -> wire::HomeTile {
        wire::HomeTile {
            widget: widget.to_owned(),
            app_id: if widget == REMINDERS {
                "agenda"
            } else {
                widget
            }
            .to_owned(),
            status: status as i32,
            ..wire::HomeTile::default()
        }
    }

    fn of(widgets: &[&str], status: Status) -> Vec<wire::HomeTile> {
        widgets.iter().map(|widget| tile(widget, status)).collect()
    }

    fn ids(rows: &[wire::HomeTileRow]) -> Vec<Vec<&str>> {
        rows.iter()
            .map(|row| row.widgets.iter().map(String::as_str).collect())
            .collect()
    }

    fn order(folded: &Folded) -> Vec<&str> {
        folded
            .tiles
            .iter()
            .map(|tile| tile.widget.as_str())
            .collect()
    }

    #[test]
    fn the_content_board_sits_in_the_boards_order_and_rows() {
        // Read in the reading order, folded into the board's: arrival decides nothing.
        let mut read = of(&ORDER, Status::Content);
        read.push(tile(REMINDERS, Status::Content));
        let folded = fold(read);
        assert_eq!(folded.springboard, wire::HomeSpringboard::Content);
        assert_eq!(order(&folded), CONTENT_ORDER);
        assert_eq!(
            ids(&folded.rows),
            vec![
                vec!["agenda", "reminders"],
                vec!["photos"],
                vec!["money", "health", "people", "locker"],
                vec!["notes", "docs"],
            ]
        );
    }

    #[test]
    fn each_widget_has_the_size_and_height_the_board_gives_it() {
        let folded = fold(of(&CONTENT_ORDER, Status::Content));
        let shape = |widget: &str| {
            let tile = folded.tiles.iter().find(|t| t.widget == widget).unwrap();
            (tile.size(), tile.height)
        };
        assert_eq!(shape("agenda"), (Size::Medium, 2));
        assert_eq!(shape("reminders"), (Size::Medium, 2));
        assert_eq!(shape("photos"), (Size::Large, 2));
        for small in ["money", "health", "people", "locker"] {
            assert_eq!(shape(small), (Size::Small, 1), "{small}");
        }
        assert_eq!(shape("notes"), (Size::Medium, 1));
        assert_eq!(shape("docs"), (Size::Medium, 1));
    }

    #[test]
    fn day_one_is_the_first_run_order_with_every_invitation_medium() {
        let folded = fold(of(&ORDER, Status::Empty));
        assert_eq!(folded.springboard, wire::HomeSpringboard::FirstRun);
        assert_eq!(order(&folded), FIRST_RUN_ORDER);
        assert_eq!(
            ids(&folded.rows),
            vec![
                vec!["agenda", "photos"],
                vec!["notes", "docs"],
                vec!["people", "money"],
                vec!["health", "locker"],
            ]
        );
        // The calendar and the photographs are tall mediums; the rest one row.
        for tile in &folded.tiles {
            assert_eq!(tile.size(), Size::Medium, "{}", tile.widget);
        }
        let height = |widget: &str| {
            folded
                .tiles
                .iter()
                .find(|t| t.widget == widget)
                .unwrap()
                .height
        };
        assert_eq!(
            (height("agenda"), height("photos"), height("notes")),
            (2, 2, 1)
        );
    }

    #[test]
    fn a_widget_that_has_nothing_to_show_grows_to_hold_its_invitation() {
        assert_eq!(size_of("money", Status::Content), Size::Small);
        assert_eq!(size_of("money", Status::Empty), Size::Medium);
        assert_eq!(size_of("money", Status::Unknown), Size::Medium);
        // Still reading: the usual shape, so the grid does not move on arrival.
        assert_eq!(size_of("money", Status::Loading), Size::Small);
        assert_eq!(size_of("notes", Status::Loading), Size::Medium);
    }

    #[test]
    fn with_nothing_owed_the_calendar_takes_the_next_widgets_that_fit_beside_it() {
        let folded = fold(of(
            &["agenda", "photos", "money", "health", "notes"],
            Status::Content,
        ));
        // The photographs need the whole row, so the smalls come up beside the
        // calendar rather than leaving a hole.
        assert_eq!(
            ids(&folded.rows),
            vec![
                vec!["agenda", "money", "health"],
                vec!["photos"],
                vec!["notes"],
            ]
        );
    }

    #[test]
    fn no_row_is_wider_than_the_grid_and_every_widget_is_in_exactly_one() {
        for status in [Status::Content, Status::Empty, Status::Loading] {
            let mut read = of(&ORDER, status);
            read.push(tile(REMINDERS, status));
            let folded = fold(read);
            let mut seen: Vec<&str> = Vec::new();
            for row in &folded.rows {
                let width: u32 = row
                    .widgets
                    .iter()
                    .map(|widget| {
                        span(
                            folded
                                .tiles
                                .iter()
                                .find(|tile| tile.widget == *widget)
                                .unwrap()
                                .size(),
                        )
                    })
                    .sum();
                assert!(width <= COLUMNS, "{row:?}");
                seen.extend(row.widgets.iter().map(String::as_str));
            }
            assert_eq!(seen.len(), folded.tiles.len());
            seen.sort_unstable();
            seen.dedup();
            assert_eq!(seen.len(), folded.tiles.len(), "a widget sits twice");
        }
    }

    #[test]
    fn the_springboard_is_graded_from_every_tile_each_time() {
        use wire::HomeSpringboard as S;
        assert_eq!(springboard(&[]), S::Loading);
        assert_eq!(springboard(&of(&ORDER, Status::Loading)), S::Loading);
        assert_eq!(springboard(&of(&ORDER, Status::Empty)), S::FirstRun);
        let mut tiles = of(&ORDER, Status::Empty);
        tiles[3].status = Status::Content as i32;
        assert_eq!(springboard(&tiles), S::Content);
        // One still reading holds the verdict: not first-run yet.
        tiles[3].status = Status::Loading as i32;
        assert_eq!(springboard(&tiles), S::Loading);
        // Unknown tiles do not make a first run, and all of them make a failure.
        tiles[3].status = Status::Unknown as i32;
        assert_eq!(springboard(&tiles), S::FirstRun);
        assert_eq!(springboard(&of(&ORDER, Status::Unknown)), S::Content);
    }
}
