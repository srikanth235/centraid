//! Matching and the grounding menu (issue #1044, decision D-1044-11): names
//! match with accents and case folded and a person answers to a nickname; a
//! by-name selector that names no live row is read once more as words and word
//! starts, and one fitting row is taken; the vault block ranks an exact name
//! first, keeps kinds apart, and counts what a container holds.
//!
//! nt11: a name is resolved in tiers (`resolve::resolve`), so a word start is a tier-3 read and
//! not a fallback: the tests of the `matched ... to` line and of the `ambiguous:` reply of a read
//! were rewritten for it (`phase9_nt11.rs` holds the new ones).

mod common;

use centraid_nativetools::meta::PREGROUND_CAP;
use centraid_nativetools::search;
use serde_json::{Value, json};

/// The fixture world plus the rows the cases below need.
fn world_with(extra: &Value) -> common::World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).unwrap();
    for (section, rows) in extra.as_object().unwrap() {
        let list = world[section.as_str()].as_array_mut().unwrap();
        list.extend(rows.as_array().unwrap().iter().cloned());
    }
    common::seeded_with(&world)
}

/// People with accents, a nickname, a prefix shared by two, and a near spelling.
fn people() -> common::World {
    world_with(&json!({
        "people": [
            {"key": "lucia", "name": "Lucía Gómez", "role": "friend"},
            {"key": "kamini", "name": "Kamini Rao", "nickname": "Kami", "role": "friend"},
            {"key": "kamal", "name": "Kamal Singh"},
            {"key": "ama", "name": "Ama Boateng"},
        ],
        "events": [
            {"key": "recital", "name": "Lucía's winter ballet recital", "start": "2026-12-12T17:00"},
        ],
    }))
}

fn rows_of(response: &Value) -> Vec<String> {
    common::ids(&response["effect"]["rows"])
}

fn find(session: &mut centraid_nativetools::Session, args: Value) -> Value {
    common::call(session, "find", args)
}

fn matched_lines(text: &str) -> Vec<&str> {
    text.lines()
        .filter(|line| line.starts_with("matched "))
        .collect()
}

// -------------------------------------------------------------------------
// Target 1: accents, case and nicknames.
// -------------------------------------------------------------------------

#[test]
fn a_name_without_the_accent_reaches_the_accented_row_in_every_tool() {
    let world = people();
    let lucia = world.id("lucia");
    let mut session = world.session();
    session.user("");
    for name in ["Lucia", "lucía", "LUCIA GOMEZ", "gomez lucia"] {
        let found = find(&mut session, json!({"kind": "person", "name": name}));
        assert_eq!(rows_of(&found), vec![lucia.clone()], "find {name}");
    }
    let counted = common::call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "person", "name": "Lucia"}),
    );
    assert_eq!(
        counted["effect"]["value"]["values"][0]["amount"], 1,
        "{}",
        counted["text"]
    );
    session.user("");
    let answered = common::call(
        &mut session,
        "answer",
        json!({"kind": "person", "name": "Lucia"}),
    );
    assert_eq!(answered["ends_turn"], true);
    assert_eq!(
        common::ids(&answered["effect"]["answer"]["rows"]),
        vec![lucia.clone()]
    );
    session.user("");
    let starred = common::call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Lucia"}),
    );
    assert_eq!(common::diff_rows(&starred)[0]["id"], json!(lucia));
}

#[test]
fn search_reaches_the_accented_row_by_the_plain_spelling() {
    let world = people();
    let mut session = world.session();
    session.user("");
    for text in ["lucia", "Lucía", "gomez"] {
        let found = common::call(&mut session, "search", json!({"text": text}));
        assert_eq!(
            rows_of(&found).first(),
            Some(&world.id("lucia")),
            "{text}: {}",
            found["text"]
        );
    }
}

#[test]
fn a_nickname_matches_a_by_name_selector_like_the_name() {
    let world = people();
    let kamini = world.id("kamini");
    let mut session = world.session();
    session.user("");
    for name in ["Kami", "kami", "KAMI"] {
        let found = find(&mut session, json!({"kind": "person", "name": name}));
        assert_eq!(rows_of(&found), vec![kamini.clone()], "find {name}");
    }
    session.user("");
    let answered = common::call(
        &mut session,
        "answer",
        json!({"kind": "person", "name": "kami"}),
    );
    assert_eq!(
        common::ids(&answered["effect"]["answer"]["rows"]),
        vec![kamini.clone()]
    );
    session.user("");
    let starred = common::call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "kami"}),
    );
    assert_eq!(common::diff_rows(&starred)[0]["id"], json!(kamini));
}

#[test]
fn a_near_spelling_is_not_a_fold() {
    // `Amma` and `Ama` are two spellings, not one: neither selector reaches the
    // other's row, and `search` is where a near spelling is offered.
    let both = world_with(&json!({"people": [
        {"key": "ama", "name": "Ama Boateng"},
        {"key": "amma", "name": "Amma Devi"},
    ]}));
    let mut session = both.session_uncomposed();
    session.user("");
    let ama = find(&mut session, json!({"kind": "person", "name": "Ama"}));
    assert_eq!(rows_of(&ama), vec![both.id("ama")]);
    let amma = find(&mut session, json!({"kind": "person", "name": "Amma"}));
    assert_eq!(rows_of(&amma), vec![both.id("amma")]);

    let only = world_with(&json!({"people": [{"key": "ama", "name": "Ama Boateng"}]}));
    let mut session = only.session_uncomposed();
    session.user("");
    // nt11 R2: a typo reaches the row (tier 4) and the reply says so; it is no fold
    let missed = find(&mut session, json!({"kind": "person", "name": "Amma"}));
    assert_eq!(rows_of(&missed), vec![only.id("ama")], "{}", missed["text"]);
    assert!(
        missed["text"]
            .as_str()
            .unwrap()
            .contains("matched \"Ama Boateng\" for \"Amma\""),
        "{}",
        missed["text"]
    );
    let searched = common::call(
        &mut session,
        "search",
        json!({"text": "Amma", "kind": "person"}),
    );
    assert_eq!(rows_of(&searched), vec![only.id("ama")]);
}

#[test]
fn folding_is_the_public_name_match() {
    use centraid_nativetools::resolve::{Tier, resolve};
    assert_eq!(search::fold("Lucía"), "lucia");
    let tier = |query: &str, names: &[&str]| resolve(query, &[(0, names.to_vec())]).tier;
    assert_eq!(tier("Lucia", &["Lucía Gómez"]), Some(Tier::Contains));
    assert_eq!(tier("Amma", &["Ama"]), Some(Tier::Typo));
    // A person's nickname is a name of the row (nt11: tier 1; a start of the name is tier 3).
    assert_eq!(tier("kami", &["Kamini Rao"]), Some(Tier::Contains));
    assert_eq!(tier("kami", &["Kamini Rao", "Kami"]), Some(Tier::Equal));
    assert_eq!(
        tier("Kamini", &["Kamini Rao", "Kami"]),
        Some(Tier::Contains)
    );
    assert_eq!(tier("Ka", &["Kamini Rao", "Kami"]), None);
}

// -------------------------------------------------------------------------
// Target 2: the by-name fallback.
// -------------------------------------------------------------------------

#[test]
fn a_name_that_matches_nothing_is_read_as_word_starts_and_one_fit_is_taken() {
    let world = people();
    let recital = world.id("recital");
    let mut session = world.session();
    session.user("");
    let found = find(
        &mut session,
        json!({"kind": "event", "name": "Lucia's ball recit"}),
    );
    assert_eq!(rows_of(&found), vec![recital.clone()], "{}", found["text"]);
    let n = found["effect"]["rows"][0]["n"].as_u64().unwrap();
    let text = found["text"].as_str().unwrap();
    // nt11 R2: a word start is tier 3, reached as it is said, so there is no `matched ... to` line
    assert!(matched_lines(text).is_empty(), "{text}");
    // The row is numbered, so the next call can use it.
    let opened = common::call(&mut session, "open", json!({"row": format!("#{n}")}));
    assert!(opened["text"].as_str().unwrap().contains("winter ballet"));
}

#[test]
fn the_fallback_serves_every_tool_that_takes_a_selector() {
    let world = people();
    let kamini = world.id("kamini");
    let mut session = world.session();
    session.user("");
    // `kamin` is no whole word and no nickname; it begins `Kamini`, and nothing else.
    let counted = common::call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "person", "name": "kamin"}),
    );
    assert_eq!(
        counted["effect"]["value"]["values"][0]["amount"], 1,
        "{}",
        counted["text"]
    );
    assert!(matched_lines(counted["text"].as_str().unwrap()).is_empty());
    session.user("");
    let answered = common::call(
        &mut session,
        "answer",
        json!({"kind": "person", "name": "kamin"}),
    );
    assert_eq!(
        common::ids(&answered["effect"]["answer"]["rows"]),
        vec![kamini.clone()],
        "{}",
        answered["text"]
    );
    assert!(
        matched_lines(answered["text"].as_str().unwrap()).is_empty(),
        "{}",
        answered["text"]
    );
    session.user("");
    let starred = common::call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "kamin"}),
    );
    let text = starred["text"].as_str().unwrap();
    assert!(text.starts_with("starred: #"), "{text}");
    assert_eq!(
        common::diff_rows(&starred)[0]["id"],
        json!(kamini),
        "{text}"
    );
    assert!(matched_lines(text).is_empty(), "{text}");
}

#[test]
fn a_possessive_and_an_article_do_not_stand_in_the_way() {
    let world = world_with(&json!({"tasks": [
        {"key": "present", "name": "Tiago birthday present"},
    ]}));
    let mut session = world.session();
    session.user("");
    let found = find(
        &mut session,
        json!({"kind": "task", "name": "the Tiago's birthday pres"}),
    );
    assert_eq!(
        rows_of(&found),
        vec![world.id("present")],
        "{}",
        found["text"]
    );
}

#[test]
fn the_fallback_does_not_leave_the_kind_of_the_call() {
    // `Dentist` the event is not a task: the cross-kind recovery stays.
    let world = people();
    let mut session = world.session();
    session.user("");
    let found = find(&mut session, json!({"kind": "task", "name": "dentis"}));
    assert!(rows_of(&found).is_empty(), "{}", found["text"]);
    assert!(matched_lines(found["text"].as_str().unwrap()).is_empty());
}

#[test]
fn a_start_of_two_letters_is_no_word_start() {
    // `Ka` begins Kamal and Kamini, but a fallback needs three letters.
    let world = people();
    let mut session = world.session();
    session.user("");
    let found = find(&mut session, json!({"kind": "person", "name": "Ka"}));
    assert!(rows_of(&found).is_empty(), "{}", found["text"]);
    assert!(matched_lines(found["text"].as_str().unwrap()).is_empty());
}

#[test]
fn a_name_another_kind_has_in_full_no_longer_hides_a_word_form_of_the_kind() {
    // nt11 R1: `passport` begins `passports`, the one task, a tier-3 read of the call's own kind.
    // The note `Passport renewals` is another kind: the pool is the call's kinds, so the task is
    // the row (nt10 kept the "Other kinds called" recovery in its place).
    let world = world_with(&json!({
        "tasks": [{"key": "kids_passports", "name": "Find the kids' passports"}],
        "notes": [{"key": "renewals", "name": "Passport renewals", "body": "x"}],
    }));
    let mut session = world.session_uncomposed();
    session.user("");
    let found = find(&mut session, json!({"kind": "task", "name": "passport"}));
    let text = found["text"].as_str().unwrap();
    assert_eq!(rows_of(&found), vec![world.id("kids_passports")], "{text}");
    assert!(!text.contains("Other kinds called"), "{text}");
    assert!(matched_lines(text).is_empty(), "{text}");
}

#[test]
fn a_name_that_fits_no_row_is_the_dead_end_as_before() {
    let world = people();
    let mut session = world.session_uncomposed();
    session.user("");
    let found = find(&mut session, json!({"kind": "person", "name": "Zebedee"}));
    let text = found["text"].as_str().unwrap();
    assert!(rows_of(&found).is_empty(), "{text}");
    assert!(text.starts_with("0 people called \"Zebedee\""), "{text}");
}

#[test]
fn the_fallback_reads_a_lookup_of_trashed_rows_as_a_live_one() {
    let world = world_with(&json!({"tasks": [
        {"key": "parcel_old", "name": "Parcel returns", "trashed": true},
    ]}));
    let mut session = world.session_uncomposed();
    session.user("");
    // Trashed lookup: the words and word starts of the name reach the trashed row, as they
    // reach a live one (M1d: a restore by a word start must not decline).
    let found = find(
        &mut session,
        json!({"kind": "task", "name": "Parcel ret", "trashed": true}),
    );
    assert_eq!(
        rows_of(&found),
        vec![world.id("parcel_old")],
        "{}",
        found["text"]
    );
    assert!(
        matched_lines(found["text"].as_str().unwrap()).is_empty(),
        "{}",
        found["text"]
    );
    // The exact name of a trashed row, with a live row that begins like it: the
    // recovery names the trashed one; nothing is taken.
    let world = world_with(&json!({"tasks": [
        {"key": "parcel_old", "name": "Parcel", "trashed": true},
        {"key": "parcels", "name": "Parcels to post"},
    ]}));
    let mut session = world.session_uncomposed();
    session.user("");
    let found = find(&mut session, json!({"kind": "task", "name": "Parcel"}));
    let text = found["text"].as_str().unwrap();
    assert!(rows_of(&found).is_empty(), "{text}");
    assert!(text.starts_with("no live task called \"Parcel\""), "{text}");
    assert!(matched_lines(text).is_empty(), "{text}");
}

#[test]
fn a_write_that_may_take_many_rows_takes_the_one_row_the_name_fits() {
    // nt11 R3: a name is resolved in tiers whatever the scope; `kamin` is tier 3 and one row, so
    // a scope of all takes that row, as the scope of one does (nt10 refused to read it).
    let world = people();
    let star = json!({"verb": "star", "kind": "person", "name": "kamin"});
    // The trace says scope all: the write takes every row the name fits, the one.
    let mut session = world.session();
    session.user("star the kamins");
    let all = session.call_traced(
        "act",
        &star,
        Some("intent: write \"star\"\nverb: star\nscope: all"),
    );
    let text = all["text"].as_str().unwrap();
    assert_eq!(
        common::diff_rows(&all)[0]["id"],
        json!(world.id("kamini")),
        "{text}"
    );
    assert!(matched_lines(text).is_empty(), "{text}");
    // scope one: the same call goes on (a fresh vault: the first write starred the row)
    let world = people();
    let mut session = world.session();
    session.user("star kamin");
    let one = session.call_traced(
        "act",
        &star,
        Some("intent: write \"star\"\nverb: star\nscope: one"),
    );
    assert_eq!(
        common::diff_rows(&one)[0]["id"],
        json!(world.id("kamini")),
        "{}",
        one["text"]
    );
    // With no trace, the message's own "all" decides.
    let world = people();
    let mut session = world.session();
    session.user("star all the kamin people");
    let said_all = common::call(&mut session, "act", star.clone());
    assert_eq!(
        common::diff_rows(&said_all)[0]["id"],
        json!(world.id("kamini")),
        "{}",
        said_all["text"]
    );
    // A read is not a write: scope all on a read does not stop it.
    let mut session = world.session();
    session.user("who are all the kamins");
    let read = session.call_traced(
        "answer",
        &json!({"kind": "person", "name": "kamin"}),
        Some("intent: read \"all\"\nscope: all"),
    );
    assert_eq!(
        common::ids(&read["effect"]["answer"]["rows"]),
        vec![world.id("kamini")],
        "{}",
        read["text"]
    );
}

#[test]
fn the_fallback_stays_inside_the_result_the_call_narrows_to() {
    let world = people();
    let mut session = world.session();
    session.user("");
    let all = find(&mut session, json!({"kind": "person", "name": "Kamal"}));
    assert_eq!(rows_of(&all), vec![world.id("kamal")]);
    let result = all["effect"]["result"].as_str().unwrap().to_owned();
    // `kamin` begins Kamini, who is not in @1: no fit inside it.
    let inside = find(&mut session, json!({"within": result, "name": "kamin"}));
    assert!(rows_of(&inside).is_empty(), "{}", inside["text"]);
    assert!(matched_lines(inside["text"].as_str().unwrap()).is_empty());
}

#[test]
fn a_call_that_names_its_rows_is_left_alone() {
    let world = people();
    let mut session = world.session();
    session.user("");
    let found = find(&mut session, json!({"kind": "person", "name": "Kamal"}));
    let n = found["effect"]["rows"][0]["n"].as_u64().unwrap();
    let starred = common::call(
        &mut session,
        "act",
        json!({"verb": "star", "rows": format!("#{n}")}),
    );
    assert!(matched_lines(starred["text"].as_str().unwrap()).is_empty());
    assert_eq!(
        common::diff_rows(&starred)[0]["id"],
        json!(world.id("kamal"))
    );
}

#[test]
fn an_exact_fold_or_nickname_hit_is_no_fallback() {
    let world = people();
    let mut session = world.session();
    session.user("");
    for (name, key) in [("Lucia", "lucia"), ("kami", "kamini")] {
        let found = find(&mut session, json!({"kind": "person", "name": name}));
        assert_eq!(rows_of(&found), vec![world.id(key)], "{name}");
        let text = found["text"].as_str().unwrap();
        assert!(matched_lines(text).is_empty(), "{name}: {text}");
    }
}

/// A name that fits several rows only by their word starts: a read lists them (tier 3), a write
/// is the ambiguous reply (nt11 R2, R3).
mod wired {
    use super::*;

    #[test]
    fn several_fits_are_listed_by_a_read_and_ambiguous_for_a_write() {
        let world = people();
        let mut session = world.session_uncomposed();
        session.user("");
        // `Kam` begins Kamal and Kamini (and is a whole word of neither).
        let found = find(&mut session, json!({"kind": "person", "name": "Kam"}));
        let text = found["text"].as_str().unwrap();
        assert!(text.contains("person \"Kamal Singh\""), "{text}");
        assert!(text.contains("person \"Kamini Rao\""), "{text}");
        assert_eq!(rows_of(&found).len(), 2, "{text}");
        assert!(matched_lines(text).is_empty(), "{text}");
        // The same name on a write: the ambiguous reply once, no write.
        let starred = common::call(
            &mut session,
            "act",
            json!({"verb": "star", "kind": "person", "name": "Kam"}),
        );
        let text = starred["text"].as_str().unwrap();
        assert!(text.starts_with("ambiguous: \"Kam\" fits #"), "{text}");
        assert_eq!(text.matches("nothing was done").count(), 1, "{text}");
        assert!(common::diff_rows(&starred).is_empty(), "{text}");
    }
}

// -------------------------------------------------------------------------
// Target 3: the vault block.
// -------------------------------------------------------------------------

/// One row of a block: `#12 list "Kids" (75 tasks)`.
#[derive(Debug, PartialEq)]
struct Shown {
    number: usize,
    kind: String,
    name: String,
    holds: Option<String>,
}

fn block(session: &mut centraid_nativetools::Session, message: &str) -> Vec<Shown> {
    let turn = session.user(message);
    let Some(text) = turn["preground"].as_str() else {
        return Vec::new();
    };
    let body = text.strip_prefix("vault: ").expect("a vault block");
    body.split(" · ").map(parse_row).collect()
}

fn parse_row(part: &str) -> Shown {
    let rest = part.strip_prefix('#').expect("a #n");
    let (number, rest) = rest.split_once(' ').expect("a kind");
    let (kind, rest) = rest.split_once(" \"").expect("a name");
    let (name, rest) = rest.split_once('"').expect("a closing quote");
    let holds = rest
        .strip_prefix(" (")
        .and_then(|rest| rest.strip_suffix(')'))
        .map(str::to_owned);
    assert!(holds.is_some() || rest.is_empty(), "{part}");
    Shown {
        number: number.parse().expect("a number"),
        kind: kind.to_owned(),
        name: name.to_owned(),
        holds,
    }
}

fn names_of(shown: &[Shown], kind: &str) -> Vec<String> {
    shown
        .iter()
        .filter(|row| row.kind == kind)
        .map(|row| row.name.clone())
        .collect()
}

/// A list `Christmas` with two tasks beside eleven photos `Christmas 1` to
/// `Christmas 11`.
fn christmas() -> common::World {
    let photos: Vec<Value> = (1..=11)
        .map(|n| {
            json!({"key": format!("xmas_{n}"), "name": format!("Christmas {n}"), "taken": "2025-12-25T10:00"})
        })
        .collect();
    world_with(&json!({
        "lists": [{"key": "xmas", "name": "Christmas"}],
        "tasks": [
            {"key": "wrap", "name": "Wrap presents", "list": "xmas"},
            {"key": "cards", "name": "Post the cards", "list": "xmas"},
        ],
        "photos": photos,
    }))
}

#[test]
fn the_kinds_that_hold_rows_are_the_containers_and_the_parent_task() {
    use centraid_nativetools::meta::Kind;
    let holds: Vec<(Kind, &str)> = Kind::ALL
        .into_iter()
        .filter_map(|kind| kind.holds().map(|link| (kind, link.label)))
        .collect();
    assert_eq!(
        holds,
        vec![
            (Kind::Group, "members"),
            (Kind::Task, "subtasks"),
            (Kind::Album, "photos"),
            (Kind::Notebook, "notes"),
            (Kind::Folder, "documents"),
            (Kind::List, "tasks"),
        ]
    );
}

#[test]
fn the_cap_is_eight() {
    assert_eq!(PREGROUND_CAP, 8);
    let walks: Vec<Value> = (1..=12)
        .map(|n| json!({"key": format!("p{n}"), "name": format!("Harbour walk {n}"), "taken": "2026-06-01T10:00"}))
        .collect();
    let world = world_with(&json!({
        "photos": walks,
        "tasks": [{"key": "h_task", "name": "Harbour task"}],
        "notes": [{"key": "h_note", "name": "Harbour note"}],
        "events": [{"key": "h_event", "name": "Harbour event", "start": "2026-10-10T10:00"}],
    }));
    let mut session = world.session();
    let shown = block(&mut session, "harbour");
    assert_eq!(shown.len(), PREGROUND_CAP, "{shown:?}");
}

#[test]
fn the_list_beats_the_numbered_photos_it_shares_a_word_with() {
    let world = christmas();
    let mut session = world.session();
    let shown = block(&mut session, "what's left on the christmas list");
    assert_eq!(shown.len(), PREGROUND_CAP, "{shown:?}");
    // The exact name is first, and it says how much it holds.
    assert_eq!(shown[0].kind, "list", "{shown:?}");
    assert_eq!(shown[0].name, "Christmas");
    assert_eq!(shown[0].holds.as_deref(), Some("2 tasks"));
    // The photos fill what the list leaves: no other kind has a hit.
    assert_eq!(
        names_of(&shown, "photo").len(),
        PREGROUND_CAP - 1,
        "{shown:?}"
    );
}

#[test]
fn an_exact_whole_name_comes_before_partial_hits() {
    let world = world_with(&json!({
        "tasks": [
            {"key": "pay_rent", "name": "Pay the rent deposit slowly"},
            {"key": "rent_deposit", "name": "Rent deposit"},
            {"key": "rent_review", "name": "Rent review meeting"},
        ],
        "notes": [{"key": "rent_note", "name": "Rent"}],
    }));
    let mut session = world.session();
    let shown = block(&mut session, "how much was the rent deposit");
    let names: Vec<&str> = shown.iter().map(|row| row.name.as_str()).collect();
    // Both words of `Rent deposit` are said; the longer exact name leads the
    // shorter one (`Rent`), and every partial hit comes after them.
    assert_eq!(&names[..2], ["Rent deposit", "Rent"], "{names:?}");
    assert!(names.contains(&"Pay the rent deposit slowly"));
    assert!(names.contains(&"Rent review meeting"));
}

#[test]
fn the_name_the_message_says_in_full_leads_the_numbered_siblings() {
    let world = christmas();
    let mut session = world.session();
    let shown = block(&mut session, "show me christmas 10");
    assert_eq!(shown[0].name, "Christmas 10", "{shown:?}");
    assert_eq!(shown[1].name, "Christmas", "{shown:?}");
}

#[test]
fn no_kind_takes_more_than_half_while_another_kind_has_a_hit() {
    let events: Vec<Value> = (1..=6)
        .map(|n| json!({"key": format!("e{n}"), "name": format!("Beach plan {n}"), "start": format!("2026-11-0{n}T10:00")}))
        .collect();
    let photos: Vec<Value> = (1..=6)
        .map(|n| json!({"key": format!("ph{n}"), "name": format!("Beach shot {n}"), "taken": "2026-07-01T10:00"}))
        .collect();
    let world = world_with(&json!({
        "events": events,
        "photos": photos,
        "tasks": [
            {"key": "t1", "name": "Beach bag"},
            {"key": "t2", "name": "Beach towels"},
        ],
    }));
    let mut session = world.session();
    let shown = block(&mut session, "beach");
    assert_eq!(shown.len(), PREGROUND_CAP, "{shown:?}");
    assert_eq!(
        names_of(&shown, "event").len(),
        PREGROUND_CAP / 2,
        "{shown:?}"
    );
    assert_eq!(names_of(&shown, "task").len(), 2, "{shown:?}");
    assert_eq!(names_of(&shown, "photo").len(), 2, "{shown:?}");
}

#[test]
fn a_kind_may_fill_the_block_when_no_other_kind_has_a_hit() {
    let events: Vec<Value> = (1..=9)
        .map(|n| json!({"key": format!("e{n}"), "name": format!("Pottery class {n}"), "start": format!("2026-11-0{n}T10:00")}))
        .collect();
    let world = world_with(&json!({"events": events}));
    let mut session = world.session();
    let shown = block(&mut session, "pottery");
    assert_eq!(shown.len(), PREGROUND_CAP, "{shown:?}");
    assert!(shown.iter().all(|row| row.kind == "event"));
}

#[test]
fn a_container_shows_what_it_holds_after_its_name() {
    let kids: Vec<Value> = (1..=13)
        .map(|n| json!({"key": format!("k{n}"), "name": format!("Chore {n}"), "list": "kids"}))
        .collect();
    let world = world_with(&json!({
        "lists": [{"key": "kids", "name": "Kids"}],
        "tasks": kids,
        "albums": [{"key": "kidsal", "name": "Kids album"}, {"key": "kidsnone", "name": "Kids empty"}],
        "photos": [{"key": "kp", "name": "Hiking trip", "taken": "2026-07-01T10:00", "albums": ["kidsal"]}],
        "notebooks": [{"key": "kidsnb", "name": "Kids notes"}],
        "notes": [{"key": "kn", "name": "Kids reading", "notebook": "kidsnb", "body": "x"}],
        "folders": [{"key": "kidsf", "name": "Kids papers"}],
        "documents": [{"key": "kd", "name": "Kids passport", "folder": "kidsf", "created": "2026-03-01T10:00"}],
        "groups": [{"key": "kidsg", "name": "Kids club", "members": ["neha_r", "ray"], "created": "2026-02-03T09:00"}],
    }));
    let mut session = world.session();
    let shown = block(&mut session, "kids");
    let holds = |kind: &str, name: &str| {
        shown
            .iter()
            .find(|row| row.kind == kind && row.name == name)
            .unwrap_or_else(|| panic!("{kind} {name} in {shown:?}"))
            .holds
            .clone()
    };
    assert_eq!(holds("list", "Kids").as_deref(), Some("13 tasks"));
    assert_eq!(holds("album", "Kids album").as_deref(), Some("1 photo"));
    assert_eq!(holds("album", "Kids empty").as_deref(), Some("0 photos"));
    assert_eq!(holds("notebook", "Kids notes").as_deref(), Some("1 note"));
    assert_eq!(
        holds("folder", "Kids papers").as_deref(),
        Some("1 document")
    );
    // The two people named and the owner, who is in every group.
    assert_eq!(holds("group", "Kids club").as_deref(), Some("3 members"));
    // A leaf shows nothing after its name.
    assert_eq!(holds("note", "Kids reading"), None);
    assert_eq!(holds("document", "Kids passport"), None);
}

#[test]
fn a_task_with_subtasks_counts_them_and_a_task_without_does_not() {
    let world = people();
    let mut session = world.session();
    // The fixture's `Write report` has one subtask, `Report outline`.
    let shown = block(&mut session, "report");
    let report = shown.iter().find(|row| row.name == "Write report").unwrap();
    assert_eq!(report.holds.as_deref(), Some("1 subtask"), "{shown:?}");
    let outline = shown
        .iter()
        .find(|row| row.name == "Report outline")
        .unwrap();
    assert_eq!(outline.holds, None);
}

#[test]
fn a_trashed_child_is_not_counted() {
    let world = world_with(&json!({
        "lists": [{"key": "trip", "name": "Trip"}],
        "tasks": [
            {"key": "t1", "name": "Pack", "list": "trip"},
            {"key": "t2", "name": "Book", "list": "trip", "trashed": true},
        ],
    }));
    let mut session = world.session();
    let shown = block(&mut session, "trip");
    assert_eq!(shown[0].holds.as_deref(), Some("1 task"), "{shown:?}");
}

#[test]
fn a_row_keeps_the_shape_the_eval_tools_parse() {
    // `#n kind "name"` first, the count after the closing quote:
    // eval/lib.py `ROW_TEXT_RE` = #(\d+)(?: \[\d+\])? ([a-z ]+?) "([^"]+)".
    let world = christmas();
    let mut session = world.session();
    let turn = session.user("the christmas list");
    let text = turn["preground"].as_str().unwrap();
    assert!(text.starts_with("vault: #"), "{text}");
    let list = text.split(" · ").next().unwrap();
    assert!(list.ends_with("list \"Christmas\" (2 tasks)"), "{list}");
    for part in text.trim_start_matches("vault: ").split(" · ") {
        let row = parse_row(part);
        assert!(row.number > 0);
    }
}

#[test]
fn a_nickname_reaches_the_block_and_leads_it() {
    let world = people();
    let mut session = world.session();
    let shown = block(&mut session, "ring kami about the recital");
    assert_eq!(shown[0].kind, "person", "{shown:?}");
    assert_eq!(shown[0].name, "Kamini Rao", "{shown:?}");
}

#[test]
fn an_accent_is_no_obstacle_to_the_block() {
    let world = people();
    let mut session = world.session();
    let shown = block(&mut session, "what did lucia say");
    assert_eq!(shown[0].name, "Lucía Gómez", "{shown:?}");
}

#[test]
fn a_short_name_said_in_full_reaches_the_block_a_function_word_does_not() {
    let world = world_with(&json!({
        "lists": [{"key": "dj", "name": "DJ"}],
        "tasks": [{"key": "back", "name": "Back to school", "list": "dj"}],
    }));
    let mut session = world.session();
    let shown = block(&mut session, "clear the dj stuff");
    assert!(shown.iter().any(|row| row.name == "DJ"), "{shown:?}");
    // "to" is in the name `Back to school` and in the message; it names nothing.
    assert!(block(&mut session, "move it to friday").is_empty());
}

#[test]
fn a_two_letter_word_never_outranks_a_name_the_message_says() {
    // "co-op" says `co` and `op`; they let a row of that exact name in and count
    // for nothing else, so the recurring `Co-op shift` events do not push the
    // people the message names out of the block.
    let shifts: Vec<Value> = (1..=6)
        .map(|n| json!({"key": format!("s{n}"), "name": format!("Co-op shift {n}"), "start": format!("2026-11-0{n}T10:00")}))
        .collect();
    let world = world_with(&json!({
        "people": [
            {"key": "priya", "name": "Priya Raman"},
            {"key": "sam_o", "name": "Sam Okafor"},
            {"key": "sam_t", "name": "Sam Tran"},
        ],
        "groups": [{"key": "coop", "name": "Tinfoil Owl co-op", "members": ["priya"], "created": "2026-02-01T09:00"}],
        "events": shifts,
    }));
    let mut session = world.session();
    let shown = block(&mut session, "settle priya and sam okafor in the co-op");
    let names: Vec<&str> = shown.iter().map(|row| row.name.as_str()).collect();
    assert!(names.contains(&"Priya Raman"), "{names:?}");
    assert_eq!(names[0], "Sam Okafor", "{names:?}");
    // The group is not named in full by "co-op": it is not in the block.
    assert!(!names.contains(&"Tinfoil Owl co-op"), "{names:?}");
}

#[test]
fn the_block_still_reads_best_first_with_stable_numbers() {
    let world = christmas();
    let mut session = world.session();
    let first = block(&mut session, "christmas");
    let again = block(&mut session, "christmas");
    assert_eq!(first, again);
    // Numbers are the session's: the same row, the same `#n`.
    let numbers: Vec<usize> = first.iter().map(|row| row.number).collect();
    let mut sorted = numbers.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), numbers.len());
}
