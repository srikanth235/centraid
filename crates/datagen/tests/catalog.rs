//! Stage 0: the catalog is derived from the runtime, complete for the nine apps and stable.

use centraid_datagen::Catalog;
use centraid_datagen::catalog::ArgClass;

const APPS: [&str; 9] = [
    "calendar",
    "docs",
    "health",
    "locker",
    "money",
    "notes",
    "people",
    "photos",
    "reminders",
];

#[test]
fn the_catalog_hash_is_a_function_of_the_catalog() {
    let (a, b) = (
        Catalog::build().expect("builds"),
        Catalog::build().expect("builds"),
    );
    assert_eq!(a.hash(), b.hash());
    assert_eq!(a.canonical(), b.canonical());
    let mut changed = a.clone();
    changed.verbs[0].name.push('x');
    assert_ne!(
        a.hash(),
        changed.hash(),
        "a changed verb must change the hash"
    );
    let mut changed = a.clone();
    changed.kinds[0].fields[0].values.push("new".to_owned());
    assert_ne!(
        a.hash(),
        changed.hash(),
        "a changed fixed list must change the hash"
    );
}

#[test]
fn all_nine_apps_own_kinds_and_tally_is_gone() {
    let catalog = Catalog::build().expect("builds");
    let mut apps = catalog.apps.clone();
    apps.sort();
    assert_eq!(apps, APPS);
    for app in APPS {
        assert!(catalog.kinds_of(app).next().is_some(), "{app} owns no kind");
    }
    let text = catalog.canonical().to_lowercase();
    for word in ["tally", "expense", "debt"] {
        assert!(
            !text.contains(word),
            "{word} is Tally's (#1099) and must not be in the catalog"
        );
    }
}

#[test]
fn money_and_health_are_fully_present() {
    let catalog = Catalog::build().expect("builds");
    for (app, kinds) in [
        (
            "money",
            &["transaction", "account", "budget", "category", "rule"][..],
        ),
        ("health", &["workout", "daily figure"][..]),
    ] {
        for kind in kinds {
            let found = catalog
                .kind(kind)
                .unwrap_or_else(|| panic!("no kind {kind}"));
            assert_eq!(found.app, app, "{kind}");
            assert!(!found.fields.is_empty(), "{kind} has no fields");
        }
    }
    let figure = catalog.kind("daily figure").expect("daily figure");
    let metric = figure
        .fields
        .iter()
        .find(|f| f.name == "metric")
        .expect("metric");
    assert!(
        metric.values.iter().any(|v| v == "steps"),
        "{:?}",
        metric.values
    );
    assert!(catalog.lists["category"].iter().any(|c| c == "food.dining"));
    assert!(catalog.lists["workout_kind"].iter().any(|c| c == "run"));
}

#[test]
fn every_verb_has_its_argument_class_and_the_issue_table_holds() {
    let catalog = Catalog::build().expect("builds");
    let class = |name: &str| {
        catalog
            .verb(name)
            .unwrap_or_else(|| panic!("no verb {name}"))
            .arg
    };
    for none in [
        "complete",
        "reopen",
        "cancel",
        "delete",
        "restore",
        "star",
        "unstar",
        "archive",
        "unarchive",
        "unlink",
        "undo",
    ] {
        assert_eq!(class(none), ArgClass::None, "{none}");
    }
    assert_eq!(class("reschedule"), ArgClass::Date);
    assert_eq!(class("add_to"), ArgClass::Row);
    assert_eq!(class("remove_from"), ArgClass::Row);
    assert_eq!(class("tag"), ArgClass::Label);
    assert_eq!(class("untag"), ArgClass::Label);
    assert_eq!(class("log"), ArgClass::Choice);
    assert_eq!(class("reveal"), ArgClass::Choice);
    assert!(!catalog.verb("log").expect("log").choices.is_empty());
    for verb in &catalog.verbs {
        if verb.name != "undo" {
            assert!(!verb.kinds.is_empty(), "{} applies to no kind", verb.name);
        }
    }
}

#[test]
fn the_eight_tools_are_listed_and_unrun_ones_say_so() {
    let catalog = Catalog::build().expect("builds");
    let names: Vec<&str> = catalog.tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "find", "compute", "create", "edit", "do", "answer", "ask", "decline"
        ]
    );
    let op = |name: &str| catalog.ops.iter().find(|o| o.name == name).expect("op");
    assert!(op("count").live);
}

#[test]
fn the_locker_names_its_sealed_fields_so_no_stage_can_emit_one() {
    let catalog = Catalog::build().expect("builds");
    for field in ["password", "card_number", "cvv"] {
        assert!(catalog.sealed.iter().any(|s| s == field), "{field}");
    }
}
