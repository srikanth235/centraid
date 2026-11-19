//! "What <app> may read" (owner, 2026-11-19): every app that reads other apps' items says so from
//! its More sheet, as Calendar, Reminders and Health do. One row with the Shield glyph, first in
//! the sheet, opens the kit's one reads page, and the page lists exactly the kinds the app may read.
//!
//! The lists are held against each app's `manifest.json`: the kinds in its read scopes that are not
//! its own, with the vault's plumbing left out, are exactly the foreign kinds the page names.

use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::testing::Driver;
use centraid_screens::{Runtime, agenda, calendar, docs, health, money, notes, people, reminders};

fn reads_view(d: &mut Driver, tab: &str, route: wire::Route) -> wire::ReadsView {
    let i = d.push(tab, route);
    match &d.view(i).kind {
        Some(wire::view_state::Kind::Reads(view)) => view.clone(),
        other => panic!("not a reads page: {other:?}"),
    }
}

fn fact<'a>(view: &'a wire::ReadsView, label: &str) -> &'a str {
    view.facts
        .iter()
        .find(|fact| fact.label == label)
        .map(|fact| fact.detail.as_str())
        .unwrap_or_else(|| panic!("no `{label}` fact"))
}

/// The foreign kinds of an app's manifest: its read scopes over the vault's tables, less the
/// plumbing every app needs and the tables that are the app's own, in a member's words.
fn foreign_kinds(manifest: &str, own: &[&str]) -> BTreeSet<&'static str> {
    const PLUMBING: [&str; 10] = [
        "blob",
        "concept",
        "container",
        "edge",
        "entity",
        "revision",
        "vault",
        "origin",
        "source",
        "derivative",
    ];
    let manifest: serde_json::Value = serde_json::from_str(manifest).expect("a manifest");
    manifest["vault"]["scopes"]
        .as_array()
        .expect("scopes")
        .iter()
        .filter(|scope| scope["verbs"] == "read")
        .filter_map(|scope| scope["table"].as_str())
        .filter(|table| !PLUMBING.contains(table) && !own.contains(table))
        .map(|table| match table {
            "person" => "people",
            "event" => "events",
            "task" => "tasks",
            "document" => "documents",
            "photo" => "photos",
            "note" => "notes",
            "reminder" => "reminders",
            "txn" => "transactions",
            other => panic!("a read scope on `{other}` has no member word: name it here"),
        })
        .collect()
}

/// The words the page lists that are not the app's own kinds.
fn listed_foreign<'a>(reads: &'a str, own: &[&str]) -> BTreeSet<&'a str> {
    reads
        .split(", ")
        .filter(|kind| !own.contains(kind))
        .collect()
}

fn assert_reads_match_manifest(
    reads: &str,
    manifest: &str,
    own_tables: &[&str],
    own_words: &[&str],
) {
    assert_eq!(
        listed_foreign(reads, own_words),
        foreign_kinds(manifest, own_tables)
            .into_iter()
            .collect::<BTreeSet<_>>(),
        "the page names the kinds the manifest reads and nothing else"
    );
}

#[test]
fn notes_reads_people_events_tasks_documents_and_photos_to_draw_a_links_far_end() {
    let mut d = Driver::with_runtime(notes::runtime());
    d.start();
    let view = reads_view(&mut d, notes::TAB, notes::routes::reads());
    assert_eq!(view.app_id, "notes");
    assert_eq!(view.title, "What Notes may read");
    assert_eq!(view.back_label, "Notes");
    assert_eq!(
        fact(&view, "Reads"),
        "notes, notebooks, people, events, tasks, documents, photos"
    );
    assert_eq!(fact(&view, "Writes"), "notes and notebooks you make");
    assert_reads_match_manifest(
        fact(&view, "Reads"),
        include_str!("../../apps/notes/manifest.json"),
        &["note"],
        &["notes", "notebooks"],
    );
}

#[test]
fn docs_reads_documents_folders_and_photos() {
    let mut d = Driver::with_runtime(docs::runtime());
    d.start();
    let view = reads_view(&mut d, docs::TAB, docs::routes::reads());
    assert_eq!(view.title, "What Docs may read");
    assert_eq!(fact(&view, "Reads"), "documents, folders, photos");
    assert_eq!(fact(&view, "Writes"), "documents and folders you make");
    assert_reads_match_manifest(
        fact(&view, "Reads"),
        include_str!("../../apps/docs/manifest.json"),
        &["document"],
        &["documents", "folders"],
    );
}

#[test]
fn money_reads_its_ledger_and_the_documents_and_photos_it_attaches() {
    let mut d = Driver::with_runtime(money::runtime());
    d.start();
    let view = reads_view(&mut d, money::TAB, money::routes::reads());
    assert_eq!(view.title, "What Money may read");
    assert_eq!(
        fact(&view, "Reads"),
        "transactions, accounts, categories, budgets, rules, documents, photos"
    );
    assert_reads_match_manifest(
        fact(&view, "Reads"),
        include_str!("../../apps/money/manifest.json"),
        &["account", "budget", "checkpoint", "rule", "transfer", "txn"],
        &["transactions", "accounts", "categories", "budgets", "rules"],
    );
}

#[test]
fn people_reads_what_is_written_about_a_person_and_the_documents_and_photos_it_attaches() {
    let mut d = Driver::with_runtime(people::runtime());
    d.start();
    let view = reads_view(&mut d, people::TAB, people::routes::reads());
    assert_eq!(view.title, "What People may read");
    assert_eq!(
        fact(&view, "Reads"),
        "people, lists, notes, events, reminders, transactions, documents, photos"
    );
    assert_reads_match_manifest(
        fact(&view, "Reads"),
        include_str!("../../apps/people/manifest.json"),
        &["person", "contact_point", "activity"],
        &["people", "lists"],
    );
}

#[test]
fn each_apps_more_sheet_opens_it_first_with_the_shield() {
    // Notes and People: the first More row.
    let mut d = Driver::with_runtime(notes::runtime());
    d.start();
    let i = d.push(
        notes::TAB,
        notes::routes::home(wire::NotesPlace::Notes, "", "", false),
    );
    let Some(wire::view_state::Kind::NotesHome(state)) = d.view(i).kind.clone() else {
        panic!("not Notes' home");
    };
    let row = &state.more_rows[0];
    assert_eq!(
        (row.label.as_str(), row.icon_key.as_str()),
        ("What Notes may read", "Shield")
    );
    assert_eq!(row.route.as_ref().unwrap().screen, "notes.reads");

    let mut d = Driver::with_runtime(people::runtime());
    d.start();
    let i = d.push(
        people::TAB,
        people::routes::home(wire::PeopleDestination::People),
    );
    let Some(wire::view_state::Kind::PeopleHome(state)) = d.view(i).kind.clone() else {
        panic!("not People's home");
    };
    let row = &state.more_rows[0];
    assert_eq!(
        (row.label.as_str(), row.icon_key.as_str()),
        ("What People may read", "Shield")
    );
    assert_eq!(row.route.as_ref().unwrap().screen, "people.reads");

    // Money: the first of the chrome's rows.
    let mut d = Driver::with_runtime(money::runtime());
    d.start();
    let i = d.push(
        money::TAB,
        money::routes::home(wire::MoneyDestination::Activity),
    );
    let Some(wire::view_state::Kind::MoneyHome(state)) = d.view(i).kind.clone() else {
        panic!("not Money's home");
    };
    let row = &state.chrome.as_ref().unwrap().more_rows[0];
    assert_eq!(
        (row.label.as_str(), row.icon_key.as_str()),
        ("What Money may read", "Shield")
    );
    assert_eq!(row.route.as_ref().unwrap().screen, "money.reads");

    // Docs: the first action of the More sheet.
    let mut d = Driver::with_runtime(docs::runtime());
    d.start();
    let i = d.push(
        docs::TAB,
        docs::routes::drive(wire::DocsDestination::Recent, "", "", ""),
    );
    d.send(
        i,
        wire::screen_event::Kind::DocsDrive(wire::DocsDriveEvent {
            kind: Some(wire::docs_drive_event::Kind::Band(
                wire::docs_drive_event::BandPicked { key: "more".into() },
            )),
        }),
    );
    let Some(wire::view_state::Kind::DocsDrive(state)) = d.view(i).kind.clone() else {
        panic!("not the drive");
    };
    let Some(wire::docs_sheet::Body::Actions(list)) = state.sheet.and_then(|s| s.body) else {
        panic!("More is a list of actions");
    };
    let row = &list.actions[0];
    assert_eq!(
        (row.label.as_str(), row.icon_key.as_str()),
        ("What Docs may read", "Shield")
    );
    assert_eq!(row.route.as_ref().unwrap().screen, "docs.reads");
}

/// Calendar, Reminders and Health say it from their reads sheets (the facts of a sheet, not the
/// kit's page), and the sheets are held against the manifests the same way.
fn agenda_reads(route: wire::Route) -> String {
    let mut d = Driver::with_runtime(Runtime::new(
        agenda::registry(),
        vec![(agenda::TAB.to_owned(), route)],
    ));
    d.start();
    let i = d.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    let Some(wire::view_state::Kind::AgendaHome(state)) = d.view(i).kind.clone() else {
        panic!("not Agenda's home");
    };
    state
        .chrome
        .expect("a chrome")
        .reads_facts
        .iter()
        .find(|fact| fact.label == "Reads")
        .expect("a Reads fact")
        .detail
        .clone()
}

#[test]
fn calendar_reads_events_people_reminders_tasks_documents_and_photos() {
    let reads = agenda_reads(calendar::routes::home(wire::AgendaDestination::Schedule));
    assert_eq!(
        reads,
        "events, calendars, people, reminders, tasks, documents, photos"
    );
    assert_reads_match_manifest(
        &reads,
        include_str!("../../apps/calendar/manifest.json"),
        &["event", "occurrence"],
        &["events", "calendars"],
    );
}

#[test]
fn reminders_reads_people_and_the_documents_and_photos_it_attaches() {
    let reads = agenda_reads(reminders::routes::home());
    assert_eq!(reads, "reminders, lists, people, documents, photos");
    assert_reads_match_manifest(
        &reads,
        include_str!("../../apps/reminders/manifest.json"),
        &["task"],
        &["reminders", "lists"],
    );
}

#[test]
fn health_reads_its_totals_and_workouts_and_the_documents_and_photos_it_attaches() {
    let mut d = Driver::with_runtime(health::runtime());
    d.start();
    let i = d.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    let Some(wire::view_state::Kind::HealthHome(state)) = d.view(i).kind.clone() else {
        panic!("not Health's home");
    };
    let reads = state
        .reads_facts
        .iter()
        .find(|fact| fact.label == "Reads")
        .expect("a Reads fact")
        .detail
        .clone();
    assert_eq!(reads, "daily totals and workouts, documents, photos");
    assert_reads_match_manifest(
        &reads,
        include_str!("../../apps/health/manifest.json"),
        &["activity", "measurement", "workout"],
        &["daily totals and workouts"],
    );
}
