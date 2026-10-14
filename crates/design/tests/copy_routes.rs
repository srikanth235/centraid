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

/// A synthetic leaf: the route-id claim is about the two sets of ids, and no
/// emitted leaf carries a routed table since Tally left (#1099), so the claim is
/// proved on a leaf built here until an app brings one back.
fn routed(routes: &[&str], shelves: &[&str]) -> CopyLeaf {
    CopyLeaf::from_json(&serde_json::json!({
        "app": "synthetic",
        "strings": { "SOME_SENTENCE": "A sentence." },
        "functions": ["routeStatus"],
        "routes": routes,
        "moreRoutes": [],
        "shelves": shelves
            .iter()
            .map(|id| serde_json::json!({ "id": id, "label": id, "segment": id }))
            .collect::<Vec<_>>(),
    }))
}

/// The ids that are a second sentence for one route, or a state of it, rather
/// than a route of their own. Each is named with its reason on purpose: a bare
/// allow-list is how a deleted route's copy survives for a year.
///
/// - `denied` — the consent denial, which every route can be in and no route
///   is.
const VARIANTS: &[&str] = &["denied"];

#[test]
fn a_copy_table_and_a_shelf_table_that_name_the_same_routes_have_no_gap() {
    let leaf = routed(&["list", "trash", "denied"], &["list", "trash"]);
    assert!(route_gaps(&leaf, VARIANTS).is_empty());
}

#[test]
fn a_leaf_carries_sentences_and_names_what_did_not_cross() {
    let docs = leaf("docs");
    assert!(
        docs.strings.len() >= 100,
        "Docs' leaf holds {} sentences",
        docs.strings.len()
    );
    // The composed sentences are LISTED, not emitted: a generated port of one
    // would be a second implementation that drifts.
    for composed in ["shelfCopy", "folderCaption"] {
        assert!(
            docs.functions.iter().any(|name| name == composed),
            "{composed} is a composed sentence and must be listed as not crossing"
        );
        assert!(
            docs.text(composed).is_none(),
            "{composed} must not be emitted as a string"
        );
    }
    // An absent name is `None`, never `""` — a missing sentence has to be
    // distinguishable from a deliberately empty one.
    assert_eq!(docs.text("NO_SUCH_SENTENCE"), None);
}

/// Every copy leaf still reads.
///
/// **The list is `copy/`'s own contents, and a leaf that exists and is never
/// loaded is the failure this sweep exists for.**
#[test]
fn every_emitted_leaf_loads() {
    for app in [
        "agenda", "docs", "locker", "notes", "people", "photos", "shared", "tasks",
    ] {
        let loaded = leaf(app);
        assert_eq!(loaded.app, app);
        assert!(
            !loaded.strings.is_empty() || !loaded.functions.is_empty(),
            "{app} emitted neither a sentence nor a note about what did not cross"
        );
    }
}

/// A DEMONSTRATED RED: a route whose sentence was deleted is named, by id.
#[test]
fn a_route_with_no_sentence_is_reported_rather_than_rendered_empty() {
    let leaf = routed(&["list", "denied"], &["list", "trash"]);
    let gaps = route_gaps(&leaf, VARIANTS);
    assert_eq!(
        gaps.without_copy
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["trash"]
    );
    // And the other direction: a sentence for a route that no longer exists.
    let stale = routed(&["list", "trash", "deleted-shelf"], &["list", "trash"]);
    assert!(
        route_gaps(&stale, VARIANTS)
            .without_screen
            .contains("deleted-shelf")
    );
}
