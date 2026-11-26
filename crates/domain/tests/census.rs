//! The census file is what the catalogue says, and every action is reached from chat.

use centraid_domain::action::Chat;
use centraid_domain::{ACTIONS, census};

#[test]
fn the_committed_census_is_the_catalogue() {
    let committed = std::fs::read_to_string(
        centraid_ontology::scratch::repo_root().join("contracts/assist/catalog-census.csv"),
    )
    .expect("the census is committed");
    assert_eq!(
        committed,
        census::csv(),
        "regenerate with: cargo run -p centraid-domain --bin export-census > contracts/assist/catalog-census.csv"
    );
}

#[test]
fn no_action_is_screen_only() {
    for action in ACTIONS {
        assert!(
            matches!(
                action.chat,
                Chat::Direct(_) | Chat::Handoff(_) | Chat::Card(..)
            ),
            "{} is reached from chat neither directly nor by a card",
            action.name()
        );
    }
    let rows = census::csv();
    assert_eq!(rows.lines().count(), ACTIONS.len() + 1);
    assert!(rows.lines().skip(1).all(|line| {
        let chat = line.rsplit(',').next().unwrap_or_default();
        chat.starts_with("direct:") || chat.contains("handoff:")
    }));
}
