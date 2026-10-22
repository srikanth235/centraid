//! The published ontology page is held to the code (ONT-01).
//!
//! `scripts/docs-site/src/content/ontology-body.html` is the model's public
//! design. Its schema section is generated and compared byte for byte; its
//! entity map and its counts are written, so this test reads them back and asks
//! the code: the kinds, their hosts, the relations and the tables. The rail of
//! the Astro page is held to the sections that exist.

use std::collections::BTreeSet;

use centraid_ontology::scratch::repo_root;
use centraid_vault::model::{Kind, Rel};
use centraid_vault::ontology_doc::{self, TABLES};

fn page() -> String {
    std::fs::read_to_string(repo_root().join("scripts/docs-site/src/content/ontology-body.html"))
        .expect("the page is committed")
}

/// Every value of `attribute="…"` in `text`, in order.
fn values(text: &str, attribute: &str) -> Vec<String> {
    let needle = format!("{attribute}=\"");
    text.match_indices(&needle)
        .map(|(at, _)| {
            let rest = &text[at + needle.len()..];
            rest[..rest.find('"').expect("a closing quote")].to_owned()
        })
        .collect()
}

#[test]
fn the_schema_section_is_what_a_founded_vault_renders() {
    let page = page();
    let live = ontology_doc::render_schema_section().expect("the section renders");
    let spliced = ontology_doc::splice(&page, &live).expect("the page carries both markers");
    assert!(
        spliced == page,
        "the page's schema section is stale: run `cargo run -p centraid-vault --bin export-ontology-page`"
    );
}

#[test]
fn every_table_of_a_founded_vault_has_a_sentence_and_one_group() {
    // The render refuses an unlisted table, and a listed one that is not founded.
    ontology_doc::render_schema_section().expect("the table list and the file agree");
    let groups: BTreeSet<&str> = ontology_doc::GROUPS.iter().map(|(id, _, _)| *id).collect();
    let mut seen = BTreeSet::new();
    for (group, table, purpose) in TABLES {
        assert!(
            groups.contains(group),
            "`{table}` is in the unknown group `{group}`"
        );
        assert!(seen.insert(table), "`{table}` is listed twice");
        assert!(purpose.len() > 20, "`{table}` has no real sentence");
    }
}

#[test]
fn the_entity_map_names_every_kind_once_under_its_host() {
    let page = page();
    let map = &page[page.find("<div class=\"kindgrid\">").expect("the map")..];
    let map = &map[..map
        .find("Eight relations join them")
        .expect("the relations follow")];
    let zones: Vec<&str> = map.split("<div class=\"zone\">").skip(1).collect();
    assert_eq!(zones.len(), 3, "one zone per host");
    let kinds_of =
        |zone: &str| -> BTreeSet<String> { values(zone, "data-kind").into_iter().collect() };
    let own: BTreeSet<String> = Kind::ALL
        .into_iter()
        .filter(|kind| !kind.is_concept() && !kind.is_container())
        .map(|kind| kind.as_str().to_owned())
        .collect();
    let concepts: BTreeSet<String> = Kind::CONCEPTS
        .iter()
        .map(|k| k.as_str().to_owned())
        .collect();
    let containers: BTreeSet<String> = Kind::CONTAINERS
        .iter()
        .map(|k| k.as_str().to_owned())
        .collect();
    assert_eq!(kinds_of(zones[0]), own, "the own-table zone");
    assert_eq!(kinds_of(zones[1]), concepts, "the concept zone");
    assert_eq!(kinds_of(zones[2]), containers, "the container zone");
    let listed = values(map, "data-kind");
    assert_eq!(listed.len(), Kind::ALL.len(), "a kind is listed twice");
}

#[test]
fn the_relations_and_the_counts_are_the_codes() {
    let page = page();
    let listed: BTreeSet<String> = values(&page, "data-rel").into_iter().collect();
    let code: BTreeSet<String> = Rel::ALL.iter().map(|rel| rel.as_str().to_owned()).collect();
    assert_eq!(listed, code, "the relations");
    let count = |name: &str| -> usize {
        let at = page
            .find(&format!("data-count=\"{name}\">"))
            .unwrap_or_else(|| panic!("no `{name}` count"));
        let rest = &page[at + name.len() + 14..];
        rest[..rest.find('<').expect("a close")]
            .parse()
            .expect("a number")
    };
    assert_eq!(count("kinds"), Kind::ALL.len());
    assert_eq!(count("relations"), Rel::ALL.len());
    assert_eq!(count("tables"), TABLES.len());
    // The map's heading says the same numbers in words.
    for word in ["Twenty-six kinds", "three hosts", "eight relations"] {
        assert!(
            page.contains(word),
            "the map heading no longer says `{word}`"
        );
    }
    assert_eq!((Kind::ALL.len(), Rel::ALL.len()), (26, 8));
}

#[test]
fn the_astro_rail_points_at_sections_that_exist() {
    let page = page();
    let astro =
        std::fs::read_to_string(repo_root().join("scripts/docs-site/src/pages/ontology.astro"))
            .expect("the page shell is committed");
    let rail = &astro[astro.find("const rail = [").expect("a rail")..];
    let rail = &rail[..rail.find("];").expect("the rail ends")];
    let targets = values(
        &rail.replace("href: '", "href=\"").replace("',", "\","),
        "href",
    );
    assert!(!targets.is_empty(), "the rail is empty");
    for target in targets {
        let id = target.trim_start_matches('#');
        assert!(
            page.contains(&format!("<section id=\"{id}\"")),
            "the rail names `#{id}`, which the page has no section for"
        );
    }
}
