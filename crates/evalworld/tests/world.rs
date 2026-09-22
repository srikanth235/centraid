//! THE WORLD, PROVED — reproducible, dense, ambiguous, and readable.
//!
//! Four properties, and each one is a thing a later lane would otherwise
//! discover the expensive way:
//!
//! 1. **The same seed builds the same world.** Two builds into two directories
//!    agree row for row, by id. A suite whose ground truth shifts between runs
//!    is not ground truth.
//! 2. **Every app is in it, Locker included.** A world missing an app is a
//!    world that scores every candidate as perfect at that app.
//! 3. **The planted ambiguities are still planted.** Seven "dentist" rows,
//!    three Nehas, an event and a place sharing a name. These assertions are
//!    written as `>=` floors precisely so that adding to the world does not
//!    break them and REMOVING from it does.
//! 4. **The rows read back through the product's own doors** — the app plane's
//!    paged door and the FTS door. A row a corpus author can name and no
//!    runtime can reach is a case nobody can pass.

use centraid_apps_kit::testdoor::TestDoor;
use centraid_evalworld::{Inventory, State, build};
use centraid_search::{Search as _, SearchRequest, SqliteDoor};

/// The eight apps of the springboard.
const APPS: [&str; 8] = [
    "agenda", "docs", "locker", "notes", "people", "photos", "tally", "tasks",
];

fn world() -> (tempfile::TempDir, centraid_evalworld::World) {
    let dir = tempfile::tempdir().expect("a temp dir");
    let world = build(dir.path()).expect("the world builds");
    (dir, world)
}

#[test]
fn the_same_seed_builds_the_same_world() {
    let (_first_dir, first) = world();
    let (_second_dir, second) = world();

    // ROW FOR ROW, BY ID. A count would pass on two worlds holding the same
    // number of different rows, which is the failure this exists to catch.
    assert_eq!(
        first.inventory.entities, second.inventory.entities,
        "two builds of the same seed disagree about what is in the vault"
    );
    assert_eq!(
        first.inventory.owner_party_id,
        second.inventory.owner_party_id
    );
    assert_eq!(first.inventory.vault_id, second.inventory.vault_id);
    assert_eq!(first.inventory.now, second.inventory.now);

    // AND THE INVENTORY FILE IS THE SAME BYTES, because that file is the
    // artifact a corpus lane reads and a diff of it is how a change to the
    // world becomes visible in review.
    assert_eq!(
        first.inventory.to_json().expect("it serialises"),
        second.inventory.to_json().expect("it serialises")
    );
}

/// **The one thing that is NOT reproducible, stated rather than discovered.**
///
/// Locker cells are sealed with a fresh nonce per call under a key drawn from
/// the OS, so the ciphertext differs between builds by design — that is the
/// property the locker's whole custody rests on. What must not differ is the
/// row: same id, same title, same type. This test is the reason the
/// determinism claim above is about the inventory and not about files.
#[test]
fn the_locker_rows_replay_even_though_their_ciphertext_cannot() {
    let (_first_dir, first) = world();
    let (_second_dir, second) = world();
    let locker = |inventory: &Inventory| {
        inventory
            .of_app("locker")
            .into_iter()
            .map(|entity| (entity.id.clone(), entity.label.clone(), entity.state))
            .collect::<Vec<_>>()
    };
    assert!(
        !locker(&first.inventory).is_empty(),
        "locker seeded nothing"
    );
    assert_eq!(locker(&first.inventory), locker(&second.inventory));
}

#[test]
fn every_one_of_the_eight_apps_has_rows_in_it() {
    let (_dir, world) = world();
    for app in APPS {
        assert!(
            !world.inventory.of_app(app).is_empty(),
            "{app} seeded nothing; the world scores every candidate as perfect at it"
        );
    }
    assert!(
        world.inventory.refusals.is_empty(),
        "the build reported refusals: {:?}",
        world.inventory.refusals
    );
}

/// THE COLLISIONS, AS FLOORS.
///
/// `>=` and not `==` on purpose: a later lane adding a row must not go red, and
/// a later lane REMOVING the ambiguity must. An `==` here would invert that —
/// it would make enriching the world the expensive change and impoverishing it
/// the free one.
#[test]
fn the_planted_ambiguities_are_still_planted() {
    let (_dir, world) = world();
    let inventory = &world.inventory;

    let dentist = inventory.matching("dentist");
    assert!(
        dentist.len() >= 7,
        "only {} rows say 'dentist'; the world has stopped being ambiguous: {:?}",
        dentist.len(),
        dentist.iter().map(|e| &e.label).collect::<Vec<_>>()
    );
    // ACROSS APPS, not seven rows in one list. A runtime that only ever opens
    // Tasks would score full marks on seven task rows.
    let apps: std::collections::BTreeSet<&str> =
        dentist.iter().map(|entity| entity.app.as_str()).collect();
    assert!(
        apps.len() >= 5,
        "'dentist' reaches only {apps:?}; the cross-app hop is not exercised"
    );

    assert!(
        inventory.matching("Neha").len() >= 3,
        "fewer than three parties are called Neha"
    );
    assert!(
        inventory.matching("Marco").len() >= 3,
        "fewer than three parties are called Marco"
    );

    // AN EVENT AND A PLACE WITH THE SAME NAME, which is the case that makes
    // "where is Emerald Bay" and "when is Emerald Bay" two different questions
    // with the same subject string.
    let emerald: std::collections::BTreeSet<&str> = inventory
        .matching("Emerald Bay")
        .iter()
        .map(|entity| entity.entity.as_str())
        .collect();
    assert!(
        emerald.contains("core.event") && emerald.contains("core.place"),
        "'Emerald Bay' is not both an event and a place: {emerald:?}"
    );

    // A TASK AND AN EVENT WITH THE SAME TITLE.
    let cabin: std::collections::BTreeSet<&str> = inventory
        .matching("Book the Tahoe cabin")
        .iter()
        .map(|entity| entity.entity.as_str())
        .collect();
    assert!(
        cabin.contains("schedule.task") && cabin.contains("core.event"),
        "'Book the Tahoe cabin' is not both a task and an event: {cabin:?}"
    );

    // SOFT-DELETED ROWS, in more than one app, and at least one of them
    // colliding with a live row's label.
    let trashed: Vec<&centraid_evalworld::Entity> = inventory
        .entities
        .iter()
        .filter(|entity| entity.state == State::Trashed)
        .collect();
    let trashed_apps: std::collections::BTreeSet<&str> =
        trashed.iter().map(|entity| entity.app.as_str()).collect();
    assert!(
        trashed_apps.len() >= 5,
        "only {trashed_apps:?} hold a trashed row; a reader that forgets deleted_at goes unpunished"
    );
    assert!(
        dentist.iter().any(|entity| entity.state == State::Trashed),
        "no trashed row says 'dentist', so ignoring deleted_at costs nothing"
    );

    // OVERLAPPING DATE WINDOWS: more than one row falls on the same day.
    let due_same_day = inventory
        .entities
        .iter()
        .filter(|entity| {
            entity
                .date
                .as_deref()
                .is_some_and(|date| date.starts_with(&centraid_evalworld::day(2)))
        })
        .count();
    assert!(
        due_same_day >= 3,
        "only {due_same_day} rows land on the same day; nothing has to be disambiguated by time"
    );
}

/// THE ROWS READ BACK THROUGH THE PRODUCT'S OWN DOORS.
///
/// Not a second query of this crate's own: the board a member sees is
/// `centraid_apps_tasks::queries::load_board` and the search a member runs is
/// `centraid_search::SqliteDoor`. A row in the inventory that neither can reach
/// is a case no runtime could ever pass, and finding that out in lane C would
/// cost a whole corpus.
#[test]
fn the_world_reads_back_through_the_app_door_and_the_fts_door() {
    let (_dir, world) = world();
    let vault = centraid_vault::Vault::open(&world.vault_path).expect("the world opens");
    let now = world.inventory.now.clone();

    let (board_titles, hits) = vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let (board, _denial) = centraid_apps_tasks::queries::load_board(&door, Some(50), &now)
                .expect("the board loads");
            let titles: Vec<String> = board.open.iter().map(|task| task.title.clone()).collect();

            let search = SqliteDoor::open(connection).expect("the FTS door opens");
            let answer = search
                .query(
                    &centraid_search::Principal::Owner,
                    &SearchRequest::new("schedule.task", "dentist", 10),
                )
                .expect("the FTS door answers");
            let hits: Vec<String> = answer
                .targets()
                .unwrap_or_else(|| panic!("the FTS door denied the owner: {answer:?}"))
                .iter()
                .map(|target| target.title.clone())
                .collect();
            Ok((titles, hits))
        })
        .expect("the world reads");
    vault.close().expect("it closes");

    assert!(
        board_titles
            .iter()
            .any(|title| title.contains("Book dentist appointment")),
        "the board does not hold the dentist task: {board_titles:?}"
    );
    assert!(
        hits.len() >= 2,
        "the FTS door found {} dentist task(s); the within-app ambiguity is gone: {hits:?}",
        hits.len()
    );
}

/// LOCKER IS NOT REACHABLE FROM THE SEARCH PLANE, and that is the point.
///
/// The absence is structural — "a secret cannot become a link target by adding
/// a probe" — so this is a typed refusal rather than an empty page. An empty
/// page would read as "no matches", which is a different and false sentence.
/// The world seeds two Locker rows whose labels collide with rows other apps
/// hold precisely so a candidate that reaches every app through one text index
/// is scored against what it cannot see.
#[test]
fn the_search_plane_refuses_locker_rather_than_answering_empty() {
    let (_dir, world) = world();
    let vault = centraid_vault::Vault::open(&world.vault_path).expect("the world opens");
    let answer = vault
        .read(|connection| {
            let search = SqliteDoor::open(connection).expect("the FTS door opens");
            Ok(format!(
                "{:?}",
                search.query(
                    &centraid_search::Principal::Owner,
                    &SearchRequest::new("locker.item", "dentist", 10),
                )
            ))
        })
        .expect("the world reads");
    vault.close().expect("it closes");
    assert!(
        answer.starts_with("Err"),
        "asking the search plane for a locker item answered {answer} rather than refusing"
    );

    // AND THE ROWS IT CANNOT SEE ARE REALLY THERE.
    let locker_labels: Vec<&String> = world
        .inventory
        .of_app("locker")
        .into_iter()
        .map(|entity| &entity.label)
        .collect();
    assert!(
        locker_labels.iter().any(|label| label.contains("Dentist")),
        "no locker row says 'Dentist': {locker_labels:?}"
    );
}

/// THE GUARD, DEMONSTRATED RED. A builder that deletes what it seeds and does
/// not refuse a founded vault is a builder that can destroy one.
#[test]
fn building_over_a_founded_vault_is_refused_by_name() {
    let (dir, world) = world();
    let error = build(dir.path()).expect_err("a second build over a founded vault was allowed");
    let complaint = error.to_string();
    assert!(
        complaint.contains(&world.inventory.vault_id),
        "the refusal did not name the vault it found: {complaint}"
    );
}

/// A DEFECT THIS WORLD FOUND ON ITS FIRST RUN, PINNED WHERE IT WAS FOUND.
///
/// `schedule.delete_task` soft-deletes: it writes `deleted_at` and `purge_at`
/// and the row stays restorable for the grace window. Two doors then read that
/// row and they do not agree.
///
/// * The **FTS door** excludes it. `centraid_search`'s `schedule.task` domain
///   declares `deleted_column: Some("deleted_at")`, so a trashed task leaves
///   the index.
/// * The **Tasks board** includes it. `centraid_apps_tasks::queries::
///   open_statement` filters on `status` and nothing else, and neither
///   `queries.rs` nor `board.rs` names `deleted_at` anywhere — the two app
///   crates in the workspace that never do. Docs, Locker, Notes, People, Photos
///   and Tally all filter it; Tasks and Agenda are the outliers, six to two.
///
/// So a member who deletes a task still sees it on their board, and a runtime
/// reading through the app door would answer with a row the member deleted.
///
/// **This test asserts the divergence, not the behaviour.** It is a
/// characterisation, deliberately written to go RED the moment somebody adds
/// the missing predicate — at which point the fix is to delete this test and
/// restore the plain assertion in
/// `the_world_reads_back_through_the_app_door_and_the_fts_door`: that a trashed
/// task is not on the board. It is here rather than quietly absent because a
/// world that plants a trashed row and then says nothing about what the product
/// does with it is a world that has hidden its own most interesting finding.
#[test]
fn a_trashed_task_leaves_the_index_and_stays_on_the_board() {
    let (_dir, world) = world();
    let vault = centraid_vault::Vault::open(&world.vault_path).expect("the world opens");
    let now = world.inventory.now.clone();

    let (on_the_board, in_the_index) = vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let (board, _denial) = centraid_apps_tasks::queries::load_board(&door, Some(50), &now)
                .expect("the board loads");
            let on_the_board = board
                .open
                .iter()
                .chain(board.logbook.iter())
                .any(|task| task.title == "Return the library books");

            let search = SqliteDoor::open(connection).expect("the FTS door opens");
            let answer = search
                .query(
                    &centraid_search::Principal::Owner,
                    &SearchRequest::new("schedule.task", "library", 10),
                )
                .expect("the FTS door answers");
            let in_the_index = answer
                .targets()
                .unwrap_or_default()
                .iter()
                .any(|target| target.title == "Return the library books");
            Ok((on_the_board, in_the_index))
        })
        .expect("the world reads");
    vault.close().expect("it closes");

    // THE ROW REALLY IS TRASHED — this is what stops the assertion below being
    // vacuous. If `deleted_at` had never been written, the FTS door would hold
    // the row too and the divergence would be a fiction.
    assert!(
        !in_the_index,
        "the trashed task is still in the FTS index, so deleted_at was never written \
         and this test proves nothing"
    );
    assert!(
        on_the_board,
        "the Tasks board now excludes a trashed task — the defect this test \
         characterises is FIXED. Delete this test and restore the plain assertion in \
         `the_world_reads_back_through_the_app_door_and_the_fts_door`."
    );
}

/// **BOTH SIDES OF THE THIRTY-DAY GRACE WINDOW, WITH ROOM EITHER SIDE.**
///
/// `core.restore_document` refuses a document whose window has run out, so the
/// world owes a corpus one of each: a document that can be put back and one
/// that cannot. Both were a function of *where in the seeding order* the trash
/// happened to fall, and the Emerald Bay permit once sat six hours inside its
/// window — a dozen extra commands anywhere ahead of it flipped a case from a
/// refusal to a success in silence, which is exactly the class of drift stable
/// handles closed for ids and nothing had closed for dates.
///
/// So the margin is asserted, in days, at both ends. A week is the smallest
/// number that a seeding change can be expected not to cross without anybody
/// noticing.
#[test]
fn the_grace_windows_are_not_on_a_knife_edge() {
    let (_dir, world) = world();
    let vault = centraid_vault::Vault::open(&world.vault_path).expect("the world opens");
    let now_ms = centraid_evalworld::NOW_MS;
    let windows = vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let (drive, _denial) = centraid_apps_docs::queries::load_drive(
                &door,
                centraid_apps_docs::queries::DriveInput { limit: Some(100_000) },
                &world.inventory.now,
            )
            .expect("the drive loads");
            Ok(drive
                .documents
                .iter()
                .filter_map(|document| {
                    let title = document.title.clone()?;
                    Some((title, document.purge_at.clone()?))
                })
                .collect::<Vec<_>>())
        })
        .expect("the world reads");
    vault.close().expect("it closes");

    let days_left = |title: &str| -> i64 {
        let (_, purge_at) = windows
            .iter()
            .find(|(found, _)| found == title)
            .unwrap_or_else(|| panic!("{title} is not a trashed document of this world"));
        (centraid_vault::clock::parse_iso_ms(purge_at).unwrap_or(0) - now_ms)
            / centraid_evalworld::DAY_MS
    };

    let lapsed = days_left("Emerald Bay permit (sample)");
    assert!(
        lapsed <= -7,
        "the permit's grace window closed only {} day(s) ago; a corpus case that \
         expects the restore to be REFUSED is one seeding change from passing",
        -lapsed
    );
    let restorable = days_left("Trip receipts (sample)");
    assert!(
        restorable >= 7,
        "the trip receipts have only {restorable} day(s) of grace left; a corpus case \
         that expects the restore to SUCCEED is one seeding change from failing"
    );
}
