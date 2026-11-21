//! UNUSUAL INPUT THROUGH THE DOORS A SHELL USES (#1202, S8 and S14): what Home's search does
//! with records whose text is 10,000 characters, joined emoji, right-to-left script, CJK, the
//! characters a file name may not hold and control characters; and Locker's export, imported
//! into another phone, then exported again. The vault's own exports are
//! `crates/vault/tests/unusual_input.rs`.

mod locker_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::locker::{self, routes};
use centraid_screens::shell;
use centraid_screens::testing::Driver;
use locker_support::*;
use wire::locker_export_event::Kind as X;
use wire::locker_import_event::Kind as I;
use wire::screen_event::Kind as E;

fn samples() -> Vec<(&'static str, String)> {
    vec![
        ("long", "Long line of text, with words. ".repeat(330)),
        (
            "emoji",
            "Party \u{1F389} family \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466} flag \u{1F3F3}\u{FE0F}\u{200D}\u{1F308}".to_owned(),
        ),
        (
            "rtl",
            "\u{645}\u{631}\u{62D}\u{628}\u{627} \u{628}\u{627}\u{644}\u{639}\u{627}\u{644}\u{645} \u{5E9}\u{5DC}\u{5D5}\u{5DD}".to_owned(),
        ),
        (
            "cjk",
            "\u{65E5}\u{672C}\u{8A9E}\u{306E}\u{30C6}\u{30AD}\u{30B9}\u{30C8} \u{4E2D}\u{6587}\u{6C49}\u{5B57} \u{D55C}\u{AD6D}\u{C5B4}".to_owned(),
        ),
        ("names", "a/b\\c:d*e?f\"g<h>i|j".to_owned()),
        ("lines", "one\ntwo, \"quoted\"; semi\\colon\nthree".to_owned()),
        ("controls", "tab\there \u{1}\u{8}\u{1F}\u{7F} end".to_owned()),
    ]
}

fn command(d: &Driver, name: &str, input: serde_json::Value) -> bool {
    static KEYS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let key = format!(
        "unusual-{}",
        KEYS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    d.handle
        .command(name, &input, &key)
        .expect("the command runs")
        .status
        == centraid_vault::CommandStatus::Executed
}

fn searched(d: &mut Driver, page: u64, term: &str) -> Vec<String> {
    d.send(
        page,
        E::HomeSearch(wire::HomeSearchEvent {
            kind: Some(wire::home_search_event::Kind::Term(
                wire::home_search_event::TermChanged {
                    term: term.to_owned(),
                },
            )),
        }),
    );
    d.pump(std::time::Duration::from_millis(300));
    match &d.view(page).kind {
        Some(wire::view_state::Kind::HomeSearch(state)) => match &state.content {
            Some(wire::home_search_state::Content::Data(data)) => data
                .groups
                .iter()
                .flat_map(|group| {
                    group
                        .rows
                        .iter()
                        .map(|row| row.title.clone())
                        .chain(group.containers.iter().map(|c| c.title.clone()))
                })
                .collect(),
            _ => Vec::new(),
        },
        other => panic!("not Home's search: {other:?}"),
    }
}

#[test]
fn search_finds_records_with_unusual_text_by_a_plain_word_and_survives_unusual_terms() {
    let mut d = Driver::with_runtime(shell::runtime());
    d.start();
    let page = d.push("home", shell::routes::search());
    let mut saved = 0;
    for (label, text) in samples() {
        let token = format!("zqx{label}");
        let title = format!("{token} {text}");
        let inputs = [
            (
                "note.create",
                serde_json::json!({ "title": title, "body": text }),
            ),
            ("person.add", serde_json::json!({ "title": title })),
            (
                "event.propose",
                serde_json::json!({ "title": title, "starts": "2026-03-03T10:00", "description": text }),
            ),
            (
                "task.add",
                serde_json::json!({ "title": title, "description": text }),
            ),
        ];
        let mut made = 0;
        for (name, input) in inputs {
            if command(&d, name, input) {
                made += 1;
            }
        }
        assert!(
            made > 0,
            "{label}: a record with this text is saved by some app"
        );
        saved += made;
        d.pump(std::time::Duration::from_millis(300));
        if label != "controls" {
            let found = searched(&mut d, page, &token);
            assert!(
                found.iter().any(|t| t.contains(&token)),
                "{label}: a plain word in the title finds it: {found:?}"
            );
            // The record is listed with its text whole, not cut or altered.
            assert!(
                found.iter().any(|t| *t == title || t.starts_with(&token)),
                "{label}: {found:?}"
            );
        }
        // The text itself as a term: no panic, whatever it finds.
        let _ = searched(&mut d, page, &text);
    }
    assert!(saved >= samples().len() * 3);
}

fn csv_records(text: &str) -> Vec<Vec<String>> {
    let (mut rows, mut row, mut cell) = (Vec::new(), Vec::new(), String::new());
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '"') if chars.peek() == Some(&'"') => {
                chars.next();
                cell.push('"');
            }
            (true, '"') => quoted = false,
            (false, '"') if cell.is_empty() => quoted = true,
            (false, ',') => row.push(std::mem::take(&mut cell)),
            (false, '\r') => {}
            (false, '\n') => {
                row.push(std::mem::take(&mut cell));
                rows.push(std::mem::take(&mut row));
            }
            (_, c) => cell.push(c),
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows
}

/// Locker's export, the way a member runs it: confirm, owner check, then the file for the sheet.
fn exported(d: &mut Driver) -> String {
    let id = d.push(locker::TAB, routes::export("Locker"));
    for kind in [
        X::Commit(wire::locker_export_event::CommitTapped {}),
        X::Confirmed(wire::locker_export_event::Confirmed {}),
    ] {
        d.send(
            id,
            E::LockerExport(wire::LockerExportEvent { kind: Some(kind) }),
        );
    }
    d.answer_effect(passed(wire::Biometry::Face));
    let file = effects_of(d, 0)
        .into_iter()
        .rev()
        .find_map(|kind| match kind {
            wire::effect::Kind::SaveFile(file) => Some(file),
            _ => None,
        })
        .expect("the save sheet is offered the file");
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    String::from_utf8(file.content).expect("utf-8")
}

fn imported(d: &mut Driver, csv: &str) -> String {
    let id = d.push(locker::TAB, routes::import("Locker"));
    d.send(
        id,
        E::LockerImport(wire::LockerImportEvent {
            kind: Some(I::Choose(wire::locker_import_event::ChooseTapped {})),
        }),
    );
    d.answer_effect(wire::effect_result::Outcome::BytesPicked(
        wire::BytesPicked {
            cancelled: false,
            name: "export.csv".to_owned(),
            media_type: "text/csv".to_owned(),
            content: csv.as_bytes().to_vec(),
            ..Default::default()
        },
    ));
    d.send(
        id,
        E::LockerImport(wire::LockerImportEvent {
            kind: Some(I::Publish(wire::locker_import_event::PublishTapped {})),
        }),
    );
    match &d.view(id).kind {
        Some(wire::view_state::Kind::LockerImport(state)) => state
            .status
            .as_ref()
            .map(|s| s.sentence.clone())
            .unwrap_or_default(),
        other => panic!("{other:?}"),
    }
}

fn ready() -> Driver {
    let mut d = driver();
    open_home(&mut d);
    d.effects.clear();
    d
}

#[test]
fn locker_items_with_unusual_text_survive_an_export_an_import_and_a_second_export() {
    let mut a = ready();
    let mut made = Vec::new();
    for (i, (label, text)) in samples().into_iter().enumerate() {
        // A control character in a title or a name is the vault's to refuse in words; the password
        // and the notes carry anything.
        if label == "controls" {
            continue;
        }
        let short: String = text.chars().take(200).collect();
        let title = format!("{label} {short}");
        arrange(
            &a,
            act::locker::AddItem {
                title: title.clone(),
                r#type: act::locker::AddItemType::Login,
                item_id: Some(format!("u{i}")),
                username: Some(short.clone()),
                password: Some(text.clone()),
                url: Some("example.com".to_owned()),
                ..act::locker::AddItem::default()
            },
        );
        made.push((title, short, text));
    }
    let first = exported(&mut a);
    let rows = csv_records(&first);
    let width = rows[0].len();
    assert!(
        rows.iter().all(|r| r.len() == width),
        "every record has {width} cells"
    );
    for (title, user, password) in &made {
        assert!(
            rows.iter()
                .any(|r| r.contains(title) && r.contains(user) && r.contains(password)),
            "{title:?} is in the file whole"
        );
    }

    // Another phone imports that file, and exports the same items.
    let mut b = ready();
    let said = imported(&mut b, &first);
    assert!(said.starts_with("Added"), "{said}");
    let second = exported(&mut b);
    let mut left: Vec<Vec<String>> = csv_records(&first);
    let mut right: Vec<Vec<String>> = csv_records(&second);
    let key = |rows: &mut Vec<Vec<String>>| {
        rows.retain(|r| made.iter().any(|(t, _, _)| r.contains(t)));
        rows.sort();
    };
    key(&mut left);
    key(&mut right);
    assert_eq!(left.len(), made.len());
    // The same items: title, username and password come back whole.
    let essence = |rows: &[Vec<String>]| -> Vec<(String, String, String)> {
        rows.iter()
            .map(|r| {
                made.iter()
                    .find(|(t, _, _)| r.contains(t))
                    .map(|(t, u, p)| {
                        assert!(
                            r.contains(u) && r.contains(p),
                            "{t:?}: user {} pass {} cells {:?}",
                            r.contains(u),
                            r.contains(p),
                            r.iter().map(|c| c.chars().count()).collect::<Vec<_>>()
                        );
                        (t.clone(), u.clone(), p.clone())
                    })
                    .expect("a made item")
            })
            .collect()
    };
    let mut l = essence(&left);
    let mut r = essence(&right);
    l.sort();
    r.sort();
    assert_eq!(l, r, "export, import, export");
}
