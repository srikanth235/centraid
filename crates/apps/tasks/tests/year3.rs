//! THE YEAR-3 TASKS AXIS (#1020, D-1020-D3-7, D-1020-S5).
//!
//! v0's year-3 generator writes **no `schedule_task` rows at all** (#1020 apps
//! §5.2), so the board's caller-sized window — the app's ONLY bound — had no
//! golden artifact behind it. [`centraid_apps_kit::fixtures::year3_tasks`] is
//! that artifact.
//!
//! The full run is `#[ignore]`d: it seeds 9,000 tasks and is longer than the
//! whole `local` gate budget. A SHRUNKEN axis runs unignored, through the same
//! statements.
//!
//! ## What the shape is built to prove
//!
//! * **`truncated` is the page's own cursor.** At 9,000 tasks a 500-row window
//!   is eighteen pages deep, so `rows.length >= window` and "a cursor exists"
//!   answer the same at the boundary and differently one row either side.
//! * **The promotion rule holds at volume.** 150 released families of four
//!   means 450 promoted children, every one of which a port that nested them
//!   under a closed parent would lose.
//! * **Nulls last is measured.** 2,000 undated tasks and 800 cancelled ones
//!   (whose `completed_at` is NULL) are the two nullable columns the board
//!   orders by — lane V's finding, at volume.

use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::fixtures::{YEAR3_TASKS, Year3TasksShape, year3_tasks};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_tasks::board::{BOARD_MAX, LOGBOOK_ROWS, is_open_status};
use centraid_apps_tasks::queries::load_board;

const NOW: &str = "2099-06-01T09:00:00.000Z";
const SEED: u64 = 679_003;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .to_path_buf()
}

fn empty_vault() -> rusqlite::Connection {
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql"))
        .expect("the committed DDL is readable");
    open_contract_vault(&ddl, "[]").expect("an empty fixture vault is built")
}

/// A tenth of the year-3 shape: the same statements, the same edges, small
/// enough for the gate.
const SHRUNKEN: Year3TasksShape = Year3TasksShape {
    tasks: 900,
    closed: 300,
    cancelled: 80,
    families: 60,
    children: 4,
    released: 15,
    undated: 200,
    projects: 6,
    sections: 18,
    tags: 30,
    tagged: 300,
    repeating: 40,
};

#[test]
fn the_shrunken_axis_seeds_and_the_board_reads_it() {
    let connection = empty_vault();
    let counts = year3_tasks(&connection, SHRUNKEN, SEED).expect("the axis seeds");
    assert_eq!(
        counts.tasks,
        SHRUNKEN.tasks + SHRUNKEN.families * (SHRUNKEN.children + 1)
    );
    assert_eq!(counts.cancelled, SHRUNKEN.cancelled);
    assert_eq!(counts.released, SHRUNKEN.released);
    assert_eq!(counts.projects, SHRUNKEN.projects);
    assert_eq!(counts.sections, SHRUNKEN.sections);

    let door = TestDoor::new(&connection);
    let (board, denial) = load_board(&door, Some(50), NOW).expect("the board reads");
    assert!(denial.is_none());
    assert_eq!(board.window, 50);
    // THE PAGE'S OWN CURSOR: 900 tasks against a 50-row window.
    assert!(board.truncated, "a year-3 board is many windows deep");
    assert!(board.logbook.len() <= LOGBOOK_ROWS);
    assert_eq!(board.projects.len(), SHRUNKEN.projects);
    assert_eq!(board.sections.len(), SHRUNKEN.sections);
    assert!(!board.tags.is_empty(), "the tag rail is not empty");
    // NO ROW IS DRAWN TWICE: an open root is never also a child of a root.
    let roots: std::collections::BTreeSet<&str> = board
        .open
        .iter()
        .map(|task| task.task_id.as_str())
        .collect();
    for root_task in board.open.iter().chain(board.logbook.iter()) {
        for child in &root_task.children {
            assert!(
                !roots.contains(child.task_id.as_str()),
                "{} is drawn as a root and as a child",
                child.task_id
            );
        }
    }
    // A LOGBOOK PARENT KEEPS ONLY ITS CLOSED CHILDREN.
    for entry in &board.logbook {
        assert!(
            entry
                .children
                .iter()
                .all(|child| !is_open_status(&child.status)),
            "{} keeps an open child in the logbook",
            entry.task_id
        );
        assert_eq!(
            entry.done_children,
            Some(entry.children.len()),
            "{}: every logbook child is done",
            entry.task_id
        );
    }
    // NULLS LAST: within the open board, no dated row follows an undated one.
    let mut seen_undated = false;
    for task in &board.open {
        if task.due_at.is_none() {
            seen_undated = true;
        } else {
            assert!(
                !seen_undated,
                "{} is dated and follows an undated row",
                task.task_id
            );
        }
    }
}

/// THE PROMOTION RULE AT VOLUME: every open child of a released family is a
/// root of the open board.
#[test]
fn a_released_family_promotes_every_unfinished_child() {
    let connection = empty_vault();
    year3_tasks(&connection, SHRUNKEN, SEED).expect("the axis seeds");
    let door = TestDoor::new(&connection);
    // The whole board, so the promotion is not a window artifact.
    let (board, _) = load_board(&door, Some(i64::try_from(BOARD_MAX).unwrap_or(500)), NOW)
        .expect("the board reads");
    let promoted = board
        .open
        .iter()
        .filter(|task| task.parent_task_id.is_some())
        .count();
    // Three open children per released family — the fourth of every four is
    // done.
    assert_eq!(
        promoted,
        SHRUNKEN.released * (SHRUNKEN.children - 1),
        "every unfinished child of a closed parent is a root of its own"
    );
}

/// THE MEASURED PROFILE. Ignored by default; run it with
/// `cargo test -p centraid-apps-tasks --test year3 -- --ignored --nocapture`.
#[test]
#[ignore = "seeds 9,000 tasks; longer than the whole local gate budget"]
fn the_year3_tasks_axis_measures_the_boards_own_window() {
    let connection = empty_vault();
    let counts = year3_tasks(&connection, YEAR3_TASKS, SEED).expect("the axis seeds");
    let door = TestDoor::new(&connection);
    let (board, _) = load_board(&door, Some(i64::try_from(BOARD_MAX).unwrap_or(500)), NOW)
        .expect("the board reads");
    println!(
        "year3 tasks: {} rows ({} open, {} closed, {} cancelled), board window {} → \
         {} open roots, {} logbook, truncated {}",
        counts.tasks,
        counts.open,
        counts.closed,
        counts.cancelled,
        board.window,
        board.open.len(),
        board.logbook.len(),
        board.truncated
    );
    assert!(board.truncated, "eighteen windows deep");
    assert_eq!(board.window, BOARD_MAX);
}
