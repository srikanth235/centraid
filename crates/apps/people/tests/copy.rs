//! PEOPLE'S COPY LEAF, and the shape it has rather than the one Tally has
//! (#1020, D-1020-T5).
//!
//! `contracts/tools/export-copy.ts` emits `copy/people.json` from
//! `packages/blueprints/apps/people/people-copy.ts` plus the app's shelf table.
//! **Copy leaves move with their screens** (census §A0): a route id in one and
//! not the other is a silent empty string, which is the one failure in copy that
//! no surface reports and no snapshot catches.
//!
//! ## Why this is not the route-gap test Tally has
//!
//! Tally keys its ambient sentences on a route id (`ROUTE_STATUS`), so
//! `centraid_design::copy::route_gaps` can compare the two sets. **People does
//! not**: its status line is a family of `STATUS` FUNCTIONS of counts — "3
//! people · 1 to reconnect · 2 starred" — so `routes` is empty by design and a
//! route-gap check over it would report all eight shelves as uncovered. What is
//! asserted instead is the shape: the four strings that crossed, the
//! twenty-five records and functions that did not and are listed, and the eight
//! shelves the screen declares.
//!
//! ## Finding PE-F7, as a test
//!
//! The emitter used to spell every app's ROOT shelf `balances` — Tally's route
//! id — because the shelf table writes it `null` and the id lives in the band.
//! Docs' drive was emitted with Tally's name for a wave. `ROOT_SHELF_IDS` names
//! it per app now, and `the_root_shelf_carries_this_apps_own_route_id` is what
//! holds it.

use std::fs;
use std::path::{Path, PathBuf};

use centraid_design::copy::CopyLeaf;

fn leaf(app: &str) -> CopyLeaf {
    let path: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../copy")
        .join(format!("{app}.json"));
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is not readable: {error}", path.display()));
    let value: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()));
    CopyLeaf::from_json(&value)
}

#[test]
fn the_leaf_carries_its_sentences_and_names_what_did_not_cross() {
    let people = leaf("people");
    assert_eq!(people.app, "people");
    // THE FOUR THAT CROSSED. A plain `export const NAME = "…"` and nothing else:
    // a template literal, a concatenation or a computed value is a DECISION
    // about how a sentence is composed, and the emitter leaves those to the kit.
    assert_eq!(people.text("APP_TITLE"), Some("People"));
    assert_eq!(people.text("SEARCH_TITLE"), Some("Search"));
    assert_eq!(people.text("TOUCH_TITLE"), Some("Touch"));
    assert_eq!(people.text("CADENCE_NEVER"), Some("Never"));
    assert_eq!(people.strings.len(), 4);

    // AND THE REST ARE LISTED, so a reader can see what did not cross rather
    // than wondering whether it was missed.
    for composed in [
        "STATUS",
        "OUTCOMES",
        "REFUSALS",
        "LABELS",
        "CONFIRMS",
        "SENTENCES",
        "EMPTY",
        "VERBS",
        "ROUTE_TITLES",
        "FIELDS",
        "SECTIONS",
        "LOG_KINDS",
        "MERGE_HEADS",
        "FIRST_RUN",
        "filterChips",
        "channelKindLabel",
        "touchKindLabel",
    ] {
        assert!(
            people.functions.iter().any(|name| name == composed),
            "{composed} is composed copy and must be listed as not crossing"
        );
        assert!(
            people.text(composed).is_none(),
            "{composed} must not be emitted as a string"
        );
    }
    // An absent name is `None`, never `""` — a missing sentence has to be
    // distinguishable from a deliberately empty one.
    assert_eq!(people.text("NO_SUCH_SENTENCE"), None);
}

/// **People's ambient copy does not key on a route id**, so `routes` is empty
/// and that is the shape rather than a gap. Asserted, so the day People grows a
/// `ROUTE_STATUS` table this test fails and the route-gap check goes in.
#[test]
fn the_status_line_is_a_function_of_counts_and_not_a_route_table() {
    let people = leaf("people");
    assert!(
        people.routes.is_empty(),
        "People grew a route-keyed copy table: add the route-gap check"
    );
    assert!(people.more_routes.is_empty(), "People has no More sheet");
    assert!(
        people.functions.iter().any(|name| name == "STATUS"),
        "the status line is a family of functions of counts"
    );
}

/// THE SCREEN'S OWN SIDE. Eight routed shelves, each listed once — People's
/// shelf table lists three of them twice, in `ROUTED` and in
/// `DESTINATION_SHELVES`, and a shelf listed twice is still one shelf.
#[test]
fn the_shelf_table_carries_eight_routed_shelves_each_once() {
    let people = leaf("people");
    let ids: Vec<&str> = people
        .shelves
        .iter()
        .map(|shelf| shelf.id.as_str())
        .collect();
    assert_eq!(
        ids,
        [
            "people", "touch", "search", "person", "log", "edit", "trash", "merge"
        ]
    );
    // Nested screens carry no id of their own beyond these: the person is
    // `AppState.personId`, so there is no `people/person/<id>` family
    // (`shelves.ts:4`-`:8`).
    assert_eq!(people.shelves.len(), 8);
}

/// FINDING PE-F7: the root shelf is this app's own route id, not Tally's.
#[test]
fn the_root_shelf_carries_this_apps_own_route_id() {
    let people = leaf("people");
    let root = people
        .shelves
        .iter()
        .find(|shelf| shelf.segment.is_empty())
        .expect("the root shelf has an empty segment");
    assert_eq!(root.id, "people");
    assert_eq!(root.label, "People");
    // AND THE APPS THAT SHARE THE EMITTER KEEP THEIRS.
    let root_of = |app: &str| {
        leaf(app)
            .shelves
            .into_iter()
            .find(|shelf| shelf.segment.is_empty())
            .map(|shelf| shelf.id)
    };
    assert_eq!(root_of("tally").as_deref(), Some("balances"));
    assert_eq!(
        root_of("docs").as_deref(),
        Some("list"),
        "Docs' drive was emitted with Tally's route id before this fix"
    );
    assert_eq!(
        root_of("locker").as_deref(),
        Some("items"),
        "Locker's shelf landed a wave after Docs' and carried the same wrong id"
    );
}
