//! YEAR-3 TASKS VOLUME ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//!
//! `centraid_apps_kit::fixtures::year3_tasks` writes the profile `YEAR3_TASKS`
//! declares: 3,000 open and 12,000 done tasks over three years, 400 cancelled and
//! 300 trashed, 40 projects of 4 sections, 200 repeating, 600 subtasks and 1,200
//! tagged. This suite asks Tasks' own board, trash and chrome reads for the
//! answer over that volume and asserts what a count cannot: the open walk reaches
//! its declared 500-row window and says when more open work exists, the logbook is a bounded read of
//! the newest closed, and a trashed task is on no list.
//!
//! **A timing here is a DEBUG build** and is projected provenance, never a ceiling.

use std::sync::Arc;
use std::time::Instant;

use centraid_apps_kit::fixtures::{YEAR3_TASKS, Year3TasksCounts, Year3TasksShape, year3_tasks};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_tasks::queries::{load_board, load_chrome, load_trash};
use centraid_vault::Vault;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::time::zone::FireZone;

const SEED: u64 = 1_135_005;
const NOW: &str = "2025-06-02T09:00:00.000Z";

/// A smaller profile in the SHAPE of the declared one; a field added to the
/// shape fails this literal rather than being inherited silently.
const SAMPLE: Year3TasksShape = Year3TasksShape {
    open: 900,
    done: 3_000,
    cancelled: 100,
    trashed: 80,
    projects: 10,
    sections: 4,
    dated: 500,
    repeating: 50,
    subtasks: 150,
    tagged: 300,
};

struct Seeded {
    dir: std::path::PathBuf,
    vault: Vault,
    counts: Year3TasksCounts,
}

impl Drop for Seeded {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn seeded(shape: Year3TasksShape) -> Seeded {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    let vault = Vault::create_with(
        dir.join("vault.db"),
        Box::new(Arc::new(FixedClock::frozen())),
        Box::new(SeededIds::new("year3")),
    )
    .expect("a vault");
    vault.found("Year 3", "Owner").expect("founded");
    let counts = vault
        .commit(|tx| Ok(year3_tasks(tx.connection(), shape, SEED).expect("seeded")))
        .expect("the corpus lands")
        .value;
    Seeded { dir, vault, counts }
}

fn utc() -> FireZone {
    FireZone::named("Etc/UTC").expect("UTC is in the bundled database")
}

/// THE BOARD WALKS ITS WINDOW AND SAYS WHEN IT FILLED, THE TRASH IS BESIDE IT, AND THE CHROME HOLDS THE PROJECTS.
#[test]
fn the_board_walks_every_open_task_and_the_trash_is_on_no_list() {
    let world = seeded(SAMPLE);
    let started = Instant::now();
    let (board, trash, chrome) = world
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let (board, denial) = load_board(&door, None, NOW, &utc()).expect("the board reads");
            assert!(denial.is_none(), "{denial:?}");
            let (trash, _) = load_trash(&door).expect("the trash reads");
            let chrome = load_chrome(&door).expect("the chrome reads");
            Ok((board, trash, chrome))
        })
        .expect("a read");
    eprintln!(
        "year3 tasks (sample): {} open rows of {} fetched open ({} subtasks), {} logbook, {} trashed in {:?}",
        board.open.len(),
        board.open_count,
        board
            .open
            .iter()
            .map(|row| row.children.len())
            .sum::<usize>(),
        board.logbook.len(),
        trash.tasks.len(),
        started.elapsed()
    );
    // THE BOARD IS A DECLARED WINDOW (500 rows, `BOARD_MAX`): more open work than
    // that is said (`truncated`), never shown as a short board that reads whole.
    // The walk fills its window with open tasks; subtasks are folded under their parent.
    assert!(board.open_count >= world.counts.open.min(board.window));
    assert_eq!(board.truncated, world.counts.open > board.window);
    // The logbook is the newest closed work, not all twelve thousand.
    assert!(!board.logbook.is_empty());
    assert!(board.logbook.len() < world.counts.done);
    assert_eq!(trash.tasks.len(), world.counts.trashed);
    assert_eq!(chrome.0.len(), SAMPLE.projects);
    assert_eq!(chrome.1.len(), SAMPLE.projects * SAMPLE.sections);
    // A trashed task is not among the open ones.
    let open: std::collections::HashSet<&str> =
        board.open.iter().map(|row| row.task_id.as_str()).collect();
    assert!(
        trash
            .tasks
            .iter()
            .all(|row| !open.contains(row.task_id.as_str()))
    );
}

/// The declared profile, run on demand:
/// `cargo test -p centraid-apps-tasks --test year3 -- --ignored --nocapture`.
#[test]
#[ignore = "the declared 15,000-task profile; run for the receipt's numbers"]
fn the_declared_profile() {
    let started = Instant::now();
    let world = seeded(YEAR3_TASKS);
    eprintln!(
        "year3 tasks: seeded {} open, {} done in {:?}",
        world.counts.open,
        world.counts.done,
        started.elapsed()
    );
    let started = Instant::now();
    let board = world
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            Ok(load_board(&door, None, NOW, &utc())
                .expect("the board reads")
                .0)
        })
        .expect("a read");
    eprintln!(
        "year3 tasks: the board walked {} open and {} logbook in {:?}",
        board.open.len(),
        board.logbook.len(),
        started.elapsed()
    );
    assert!(
        board.truncated,
        "3,000 open tasks overrun the 500-row window, and say so"
    );
    assert!(board.open_count >= board.window);
}
