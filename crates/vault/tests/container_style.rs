//! A list and a calendar wear a colour and an icon (#1185, #1214): made, renamed, styled; a key that
//! is not the palette's or an icon a list can wear is refused with a sentence.

mod common;

use centraid_vault::commands::container::{LIST_COLORS, LIST_ICONS};
use common::world::World;
use serde_json::json;

fn id(w: &World, name: &str, input: serde_json::Value) -> String {
    w.ok(name, input)["id"].as_str().expect("an id").to_owned()
}

#[test]
fn the_curated_icons_are_all_in_icons_toml_and_the_colours_are_the_list_palette() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let icons = std::fs::read_to_string(root.join("design/icons.toml")).expect("icons.toml");
    for key in LIST_ICONS {
        assert!(
            icons
                .lines()
                .any(|line| line.starts_with(&format!("{key} = "))),
            "`{key}` is not an icon of design/icons.toml"
        );
    }
    let mut sorted = LIST_ICONS.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), LIST_ICONS.len(), "no icon twice");
    let tokens = std::fs::read_to_string(root.join("design/tokens.toml")).expect("tokens.toml");
    let list: Vec<&str> = tokens
        .split("\n[list]\n")
        .nth(1)
        .and_then(|rest| rest.split("\n[").next())
        .expect("a [list] palette")
        .lines()
        .filter_map(|line| line.split_once(" = ").map(|(key, _)| key.trim()))
        .collect();
    assert_eq!(list, LIST_COLORS, "the palette's eight keys, in its order");
}

fn style_of(w: &World, id: &str) -> (Option<String>, Option<String>) {
    (
        w.one("SELECT color FROM container WHERE id = ?1", &[id]),
        w.one("SELECT icon FROM container WHERE id = ?1", &[id]),
    )
}

#[test]
fn a_list_is_made_renamed_and_styled() {
    let w = World::new("container_style");
    let list = id(
        &w,
        "container.create",
        json!({ "kind": "project", "title": "Home", "color": "petrol", "icon": "Home" }),
    );
    assert_eq!(
        style_of(&w, &list),
        (Some("petrol".to_owned()), Some("Home".to_owned()))
    );
    w.ok("entity.retitle", json!({ "id": list, "title": "House" }));
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&list]),
        "House"
    );
    w.ok(
        "container.style",
        json!({ "id": list, "color": "orchid", "icon": "Heart" }),
    );
    assert_eq!(
        style_of(&w, &list),
        (Some("orchid".to_owned()), Some("Heart".to_owned()))
    );
    // A key that is absent is left alone; null clears.
    w.ok("container.style", json!({ "id": list, "color": "blue" }));
    assert_eq!(
        style_of(&w, &list),
        (Some("blue".to_owned()), Some("Heart".to_owned()))
    );
    w.ok("container.style", json!({ "id": list, "icon": null }));
    assert_eq!(style_of(&w, &list), (Some("blue".to_owned()), None));
    // The plain `list` kind wears the same.
    let plain = id(
        &w,
        "container.create",
        json!({ "kind": "list", "title": "Wishes", "icon": "Gift" }),
    );
    assert_eq!(style_of(&w, &plain).1.as_deref(), Some("Gift"));
}

#[test]
fn a_calendar_is_made_renamed_and_styled() {
    let w = World::new("container_style");
    let cal = id(
        &w,
        "container.create",
        json!({ "kind": "calendar", "title": "Family", "color": "raspberry", "icon": "Users" }),
    );
    assert_eq!(
        style_of(&w, &cal),
        (Some("raspberry".to_owned()), Some("Users".to_owned()))
    );
    w.ok("entity.retitle", json!({ "id": cal, "title": "Household" }));
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&cal]),
        "Household"
    );
    w.ok(
        "container.style",
        json!({ "id": cal, "color": "indigo", "icon": "Calendar" }),
    );
    assert_eq!(
        style_of(&w, &cal),
        (Some("indigo".to_owned()), Some("Calendar".to_owned()))
    );
    // An event can be put in the new calendar.
    let event = id(
        &w,
        "event.propose",
        json!({ "title": "Dinner", "starts": "2026-03-02T19:00", "calendar_id": cal }),
    );
    assert_eq!(
        w.one::<String>("SELECT parent_id FROM entity WHERE id = ?1", &[&event]),
        cal
    );
}

#[test]
fn a_colour_an_icon_or_a_kind_that_is_not_the_palettes_is_refused_with_a_sentence() {
    let w = World::new("container_style");
    let list = id(
        &w,
        "container.create",
        json!({ "kind": "project", "title": "P" }),
    );
    let cal = id(
        &w,
        "container.create",
        json!({ "kind": "calendar", "title": "C" }),
    );
    let notebook = id(
        &w,
        "container.create",
        json!({ "kind": "notebook", "title": "N" }),
    );
    for target in [&list, &cal] {
        let sentence = w.refused(
            "container.style",
            json!({ "id": target, "color": "#FF0000" }),
        );
        assert!(
            sentence.contains("not one of the list colours"),
            "{sentence}"
        );
        let sentence = w.refused("container.style", json!({ "id": target, "icon": "Trash" }));
        assert!(
            sentence.contains("not an icon a list can wear"),
            "{sentence}"
        );
        assert!(
            w.refused("container.style", json!({ "id": target }))
                .contains("say a colour or an icon")
        );
    }
    let sentence = w.refused(
        "container.style",
        json!({ "id": notebook, "color": "blue" }),
    );
    assert!(
        sentence.contains("notebook wears no colour or icon"),
        "{sentence}"
    );
    let sentence = w.refused(
        "container.create",
        json!({ "kind": "calendar", "title": "X", "color": "green" }),
    );
    assert!(
        sentence.contains("not one of the list colours"),
        "{sentence}"
    );
    let sentence = w.refused(
        "container.create",
        json!({ "kind": "project", "title": "X", "icon": "Nope" }),
    );
    assert!(
        sentence.contains("not an icon a list can wear"),
        "{sentence}"
    );
    let sentence = w.refused(
        "container.create",
        json!({ "kind": "notebook", "title": "X", "icon": "Home" }),
    );
    assert!(sentence.contains("does not wear an icon"), "{sentence}");
    assert!(
        !w.refused(
            "container.style",
            json!({ "id": "missing", "color": "blue" })
        )
        .is_empty()
    );
    // Nothing the refusals touched changed.
    assert_eq!(style_of(&w, &list), (None, None));
}
