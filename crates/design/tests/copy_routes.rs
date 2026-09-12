//! THE ROUTE-ID CLAIM: the copy table and the screen name the same routes.
//!
//! A route id in one and not the other is a silent empty string (census §A0),
//! which is the one failure in copy that no surface reports and no snapshot
//! catches. The two sets are emitted independently — the sentences from the
//! app's `*-copy.ts` leaves, the routes from its shelf table — and compared
//! here (#1020, D-1020-T5).

use std::fs;
use std::path::{Path, PathBuf};

use centraid_design::copy::{CopyLeaf, route_gaps};

fn leaf(app: &str) -> CopyLeaf {
    let path: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../copy")
        .join(format!("{app}.json"));
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is not readable: {error}", path.display()));
    let value: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()));
    CopyLeaf::from_json(&value)
}

/// The ids that are a second sentence for one route, or a state of it, rather
/// than a route of their own. Each is named with its reason on purpose: a bare
/// allow-list is how a deleted route's copy survives for a year.
///
/// - `groupOwn` — the group ledger's OTHER sentence, for a group the member
///   keeps alone rather than shares (`route-copy.ts:26-34`).
/// - `denied` — the consent denial, which every route can be in and no route
///   is (`queries/dashboard.ts`'s `deniedPayload`).
const TALLY_VARIANTS: &[&str] = &["groupOwn", "denied"];

#[test]
fn tallys_copy_table_and_shelf_table_name_the_same_routes() {
    let tally = leaf("tally");
    assert_eq!(tally.app, "tally");
    assert_eq!(
        tally.shelves.len(),
        15,
        "Tally's spec has fifteen routed shelves (`shelves.ts:45-61`)"
    );
    let gaps = route_gaps(&tally, TALLY_VARIANTS);
    assert!(
        gaps.without_copy.is_empty(),
        "these routes render a silent empty string: {:?}",
        gaps.without_copy
    );
    assert!(
        gaps.without_screen.is_empty(),
        "these sentences reach no route: {:?}",
        gaps.without_screen
    );
    // The More sheet's lenses are routes too, and its metas key on the same ids.
    for id in &tally.more_routes {
        assert!(
            tally.shelves.iter().any(|shelf| &shelf.id == id),
            "the More sheet names {id}, which is not a shelf"
        );
    }
}

#[test]
fn a_leaf_carries_sentences_and_names_what_did_not_cross() {
    let tally = leaf("tally");
    assert!(
        tally.strings.len() >= 100,
        "Tally's three leaves hold {} sentences",
        tally.strings.len()
    );
    // The composed sentences are LISTED, not emitted: a generated port of one
    // would be a second implementation that drifts.
    for composed in ["routeStatus", "moreMeta"] {
        assert!(
            tally.functions.iter().any(|name| name == composed),
            "{composed} is a composed sentence and must be listed as not crossing"
        );
        assert!(
            tally.text(composed).is_none(),
            "{composed} must not be emitted as a string"
        );
    }
    // An absent name is `None`, never `""` — a missing sentence has to be
    // distinguishable from a deliberately empty one.
    assert_eq!(tally.text("NO_SUCH_SENTENCE"), None);
}

/// Every emitted leaf still reads — wave 3's mobile shell brought three and each
/// wave 4 app lane adds its own (Docs' is the fourth).
#[test]
fn every_emitted_leaf_loads() {
    for app in ["docs", "notes", "photos", "shared", "tally"] {
        let loaded = leaf(app);
        assert_eq!(loaded.app, app);
        assert!(
            !loaded.strings.is_empty() || app == "tally" || !loaded.functions.is_empty(),
            "{app} emitted neither a sentence nor a note about what did not cross"
        );
    }
}

/// A DEMONSTRATED RED: a route whose sentence was deleted is named, by id.
#[test]
fn a_route_with_no_sentence_is_reported_rather_than_rendered_empty() {
    let mut tally = leaf("tally");
    tally.routes.remove("trash");
    let gaps = route_gaps(&tally, TALLY_VARIANTS);
    assert_eq!(
        gaps.without_copy
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["trash"]
    );
    // And the other direction: a sentence for a route that no longer exists.
    let mut stale = leaf("tally");
    stale.routes.insert("deleted-shelf".to_owned());
    assert!(
        route_gaps(&stale, TALLY_VARIANTS)
            .without_screen
            .contains("deleted-shelf")
    );
}
