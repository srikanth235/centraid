//! nt11 (#1044, iteration 2): one fuzzy name resolver for the runtime. R1 the tiers, R2 what a read
//! takes, R3 what a write does, R4 one matcher (the old ones are gone), R5 a write over a handle
//! past the cap ends as its selector does, R6 a `when` on trashed rows is dropped with a note.

mod common;

use centraid_nativetools::resolve::{Tier, resolve};
use common::{World, call, ids, seeded, seeded_with};
use serde_json::{Value, json};

fn text(response: &Value) -> &str {
    response["text"].as_str().unwrap_or_default()
}

fn tool_of(response: &Value) -> &str {
    response["effect"]["tool"].as_str().unwrap_or_default()
}

fn world_with(edit: impl FnOnce(&mut Value)) -> World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).expect("the fixture");
    edit(&mut world);
    seeded_with(&world)
}

fn push(world: &mut Value, section: &str, row: Value) {
    world[section].as_array_mut().expect("a section").push(row);
}

fn options(response: &Value) -> Vec<String> {
    ids(&response["effect"]["ask"]["options"])
}

fn sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort();
    list
}

/// The tier a name reaches among the names of one row.
fn tier(query: &str, names: &[&str]) -> Option<Tier> {
    resolve(query, &[(0, names.to_vec())]).tier
}

// ---------------------------------------------------------------------------------------------
// R1: the tiers

#[test]
fn nt11_r1_equal_after_folding_is_tier_one() {
    // case, accents, punctuation, runs of hyphens, underscores and spaces
    assert_eq!(tier("mother in law", &["Mother-in-law"]), Some(Tier::Equal));
    assert_eq!(tier("Mother in-law", &["mother_in_law"]), Some(Tier::Equal));
    assert_eq!(
        tier("MOTHER   IN LAW", &["Mother-in-law"]),
        Some(Tier::Equal)
    );
    assert_eq!(tier("lucia", &["Lucía"]), Some(Tier::Equal));
    assert_eq!(tier("yunho", &["Yun-ho"]), Some(Tier::Equal));
    assert_eq!(tier("obriens", &["O'Brien's"]), Some(Tier::Equal));
    assert_eq!(tier("Chi Hen Do", &["Chi's Hen Do"]), Some(Tier::Equal));
}

#[test]
fn nt11_r1_the_same_words_in_any_order_is_tier_two() {
    assert_eq!(
        tier("weiss benedikt", &["Benedikt Weiss"]),
        Some(Tier::Words)
    );
    assert_eq!(tier("law in mother", &["Mother-in-law"]), Some(Tier::Words));
}

#[test]
fn nt11_r1_every_word_said_present_is_tier_three() {
    assert_eq!(tier("house", &["Beach House 2026"]), Some(Tier::Contains));
    assert_eq!(
        tier("beach 2026", &["Beach House 2026"]),
        Some(Tier::Contains)
    );
    // a start of three letters or more, the floor of nt10's word-start reading
    assert_eq!(tier("kamin", &["Kamini Rao"]), Some(Tier::Contains));
    assert_eq!(tier("ka", &["Kamini Rao"]), None);
    // an article and a possessive stand aside
    assert_eq!(
        tier("the Tiago's birthday pres", &["Tiago birthday present"]),
        Some(Tier::Contains)
    );
    // a word the name does not have is no match
    assert_eq!(tier("house garden", &["Beach House 2026"]), None);
}

#[test]
fn nt11_r1_a_whole_word_comes_before_a_word_start_within_tier_three() {
    let rows = [
        (1, vec!["Sami Khoury"]),
        (2, vec!["Samira Khalil"]),
        (3, vec!["Sami Haddad"]),
    ];
    let found = resolve("sami", &rows);
    assert_eq!(found.tier, Some(Tier::Contains));
    assert_eq!(found.matches, vec![1, 3]);
    // with no one called Sami the word start is the read
    let rows = [(2, vec!["Samira Khalil"]), (4, vec!["Samir Aziz"])];
    let found = resolve("sami", &rows);
    assert_eq!(
        (found.tier, found.matches),
        (Some(Tier::Contains), vec![2, 4])
    );
}

#[test]
fn nt11_r1_a_typo_of_one_edit_in_a_word_of_four_letters_is_tier_four() {
    assert_eq!(
        tier("farukh kasimov", &["Farrukh Kasimov"]),
        Some(Tier::Typo)
    ); // a letter fewer
    assert_eq!(tier("benedict", &["Benedikt Weiss"]), Some(Tier::Typo)); // one different
    assert_eq!(tier("ochoo", &["Ray Ochoa"]), Some(Tier::Typo));
    assert_eq!(tier("recieve", &["Receive parcel"]), Some(Tier::Typo)); // two swapped
    assert_eq!(tier("amma", &["Ama"]), Some(Tier::Typo));
    // two edits, a short word, a digit: none
    assert_eq!(tier("benedyct", &["Benedikt Weiss"]), None);
    assert_eq!(tier("amm", &["Ama"]), None);
    assert_eq!(tier("house 2025", &["Beach House 2026"]), None);
    // the other words of the name still have to be there
    assert_eq!(tier("farukh smith", &["Farrukh Kasimov"]), None);
}

#[test]
fn nt11_r1_the_best_tier_alone_and_a_nickname_is_a_name() {
    let rows = [
        (1, vec!["Beach House 2026"]),
        (2, vec!["House"]),
        (3, vec!["Housse"]),
    ];
    let found = resolve("house", &rows);
    assert_eq!((found.tier, found.matches), (Some(Tier::Equal), vec![2]));
    let rows = [(1, vec!["Beach House 2026"]), (2, vec!["Housse"])];
    let found = resolve("house", &rows);
    assert_eq!((found.tier, found.matches), (Some(Tier::Contains), vec![1]));
    // a person's nickname is another name of theirs; the row's tier is its best
    let rows = [(7, vec!["Neha Kulkarni", "NK"])];
    assert_eq!(resolve("nk", &rows).tier, Some(Tier::Equal));
    assert_eq!(resolve("kulkarni", &rows).tier, Some(Tier::Contains));
    assert_eq!(resolve("", &rows).tier, None);
}

// ---------------------------------------------------------------------------------------------
// R2: a read takes the rows of the best tier, a typo says so

fn house_world() -> World {
    world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "beach_house", "name": "Beach House 2026", "due": "2026-10-20"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "house_task", "name": "House", "due": "2026-10-21"}),
        );
        push(
            world,
            "people",
            json!({"key": "mil", "name": "Mother-in-law"}),
        );
        push(
            world,
            "people",
            json!({"key": "farrukh", "name": "Farrukh Kasimov"}),
        );
    })
}

#[test]
fn nt11_r2_a_wording_variant_reads_as_the_name() {
    let world = house_world();
    let mut session = world.session();
    session.user("my mother in law");
    for said in ["mother in law", "Mother-in-law", "mother_in_law"] {
        let found = call(
            &mut session,
            "find",
            json!({"kind": "person", "name": said}),
        );
        assert_eq!(
            ids(&found["effect"]["rows"]),
            vec![world.id("mil")],
            "{found}"
        );
        assert!(!text(&found).contains("matched "), "{found}");
    }
}

#[test]
fn nt11_r2_a_read_takes_every_row_of_tiers_one_to_three() {
    // no read returns fewer rows than nt10 did: `house` is the row called `House` and the row
    // that contains the word
    let world = house_world();
    let mut session = world.session();
    session.user("the house");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "house"}),
    );
    assert_eq!(
        sorted(ids(&found["effect"]["rows"])),
        sorted(vec![world.id("beach_house"), world.id("house_task")]),
        "{found}"
    );
    assert!(!text(&found).contains("matched "), "{found}");
    let answered = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "house"}),
    );
    assert_eq!(
        ids(&answered["effect"]["answer"]["rows"]).len(),
        2,
        "{answered}"
    );
}

#[test]
fn nt11_r2_a_typo_is_read_only_when_no_row_reaches_a_better_tier() {
    // `Housse` is a typo of `House` and `Beach House 2026` has the word `house`: the rows that
    // reach tier 3 are the read, and the typo says nothing
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "beach_house", "name": "Beach House 2026"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "house_task", "name": "Hause"}),
        );
    });
    let mut session = world.session();
    session.user("the house");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "house"}),
    );
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("beach_house")],
        "{found}"
    );
    assert!(!text(&found).contains("matched "), "{found}");
}

#[test]
fn nt11_r2_a_typo_adds_one_line_and_only_a_typo() {
    let world = house_world();
    let mut session = world.session();
    session.user("farukh");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Farukh Kasimov"}),
    );
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("farrukh")],
        "{found}"
    );
    assert!(
        text(&found).contains("matched \"Farrukh Kasimov\" for \"Farukh Kasimov\""),
        "{found}"
    );
    assert_eq!(text(&found).matches("matched ").count(), 1, "{found}");
    // the answer and the count read it the same way
    session.user("farukh");
    let answered = call(
        &mut session,
        "answer",
        json!({"kind": "person", "name": "Farukh Kasimov"}),
    );
    assert_eq!(
        ids(&answered["effect"]["answer"]["rows"]),
        vec![world.id("farrukh")],
        "{answered}"
    );
    assert!(
        text(&answered).contains("matched \"Farrukh Kasimov\" for \"Farukh Kasimov\""),
        "{answered}"
    );
    session.user("how many farukh");
    let counted = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "person", "name": "Farukh Kasimov"}),
    );
    assert_eq!(
        counted["effect"]["value"]["values"][0]["amount"], 1,
        "{counted}"
    );
    assert!(
        text(&counted).contains("matched \"Farrukh Kasimov\""),
        "{counted}"
    );
    // a name reached as it is said has no line
    session.user("farrukh");
    let exact = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "kasimov farrukh"}),
    );
    assert_eq!(
        ids(&exact["effect"]["rows"]),
        vec![world.id("farrukh")],
        "{exact}"
    );
    assert!(!text(&exact).contains("matched "), "{exact}");
}

#[test]
fn nt11_r2_a_typo_keeps_the_rows_that_meet_the_other_conditions() {
    let world = seeded();
    let mut session = world.session();
    session.user("neha raoo");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Neha Raoo", "where": "cadence > 0"}),
    );
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("neha_r")],
        "{found}"
    );
}

// ---------------------------------------------------------------------------------------------
// R3: a write acts on a tier of 1 to 3 and exactly one row, and asks otherwise

#[test]
fn nt11_r3_a_write_by_a_name_two_rows_reach_is_the_ask_even_when_one_is_exact() {
    let world = house_world();
    let mut session = world.session();
    session.user("finish the house");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "house"}),
    );
    // nt12 R6: the exact name `House` is not enough when `Beach House 2026` also reaches it
    assert_eq!(tool_of(&done), "ask", "{done}");
    assert_eq!(
        sorted(options(&done)),
        sorted(vec![world.id("beach_house"), world.id("house_task")]),
        "{done}"
    );
    assert!(common::diff_rows(&done).is_empty(), "{done}");
}

#[test]
fn nt11_r3_a_wording_variant_and_a_word_order_are_acted_on() {
    let world = house_world();
    let mut session = world.session();
    session.user("star my mother in law");
    let starred = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "mother in law"}),
    );
    assert_eq!(
        common::diff_rows(&starred)[0]["id"],
        world.id("mil"),
        "{starred}"
    );
    session.user("star kasimov farrukh");
    let reordered = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "kasimov farrukh"}),
    );
    assert_eq!(
        common::diff_rows(&reordered)[0]["id"],
        world.id("farrukh"),
        "{reordered}"
    );
}

#[test]
fn nt11_r3_several_rows_a_name_reaches_are_the_which_one_ask() {
    // `house` is tier 3 for two rows and tier 1 for one: all three are asked over
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "a", "name": "Beach House 2026"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "b", "name": "Old House 1999"}),
        );
        push(world, "tasks", json!({"key": "c", "name": "House"}));
    });
    let mut session = world.session();
    session.user("finish the house");
    let one = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "house"}),
    );
    // nt12 R6: all three rows reach tiers 1 to 3, so the exact one is no longer taken alone
    assert_eq!(tool_of(&one), "ask", "{one}");
    assert_eq!(
        sorted(options(&one)),
        sorted(vec![world.id("a"), world.id("b"), world.id("c")]),
        "{one}"
    );
    // with no row called just that, the rows that contain it are the ask over all of them
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "a", "name": "Beach House 2026"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "b", "name": "Old House 1999"}),
        );
    });
    let mut session = world.session();
    session.user("finish the house");
    let ask = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "house"}),
    );
    assert_eq!(tool_of(&ask), "ask", "{ask}");
    assert_eq!(ask["effect"]["ask"]["question"], "Which one?", "{ask}");
    assert_eq!(
        sorted(options(&ask)),
        sorted(vec![world.id("a"), world.id("b")]),
        "{ask}"
    );
    assert!(common::diff_rows(&ask).is_empty(), "{ask}");
}

#[test]
fn nt11_r3_a_typo_with_one_candidate_acts_and_several_are_asked_over() {
    let world = house_world();
    let mut session = world.session();
    session.user("star farukh kasimov");
    let ask = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Farukh Kasimov"}),
    );
    // nt12 R6: a typo with exactly one candidate of the stated kind acts, and says what it matched
    assert_eq!(tool_of(&ask), "act", "{ask}");
    assert_eq!(
        common::diff_rows(&ask)[0]["id"],
        world.id("farrukh"),
        "{ask}"
    );
    assert!(
        text(&ask).contains("matched \"Farrukh Kasimov\" for \"Farukh Kasimov\""),
        "{ask}"
    );
    // several typo rows are the which-one ask with those candidates
    let world = world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "pa", "name": "Pedro Almeida"}),
        );
        push(
            world,
            "people",
            json!({"key": "pc", "name": "Pedro Almeido"}),
        );
        push(world, "people", json!({"key": "pd", "name": "Pedro Costa"}));
    });
    let mut session = world.session();
    session.user("star pedro almeidu");
    let many = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Pedro Almeidu"}),
    );
    assert_eq!(tool_of(&many), "ask", "{many}");
    assert_eq!(many["effect"]["ask"]["question"], "Which one?", "{many}");
    assert_eq!(
        sorted(options(&many)),
        sorted(vec![world.id("pa"), world.id("pc")]),
        "{many}"
    );
    assert!(common::diff_rows(&many).is_empty(), "{many}");
}

#[test]
fn nt11_r3_a_trashed_row_called_that_beats_a_live_row_that_only_contains_it() {
    // `Parcel` is the trashed row's name as said; the live `Parcels to post` only starts with it
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "parcel", "name": "Parcel", "trashed": true}),
        );
        push(
            world,
            "tasks",
            json!({"key": "post", "name": "Parcels to post"}),
        );
    });
    let mut session = world.session();
    session.user("tick off parcel");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Parcel"}),
    );
    assert!(common::diff_rows(&done).is_empty(), "{done}");
    assert!(text(&done).contains("in the trash"), "{done}");
}

// ---------------------------------------------------------------------------------------------
// R4: one matcher

#[test]
fn nt11_r4_the_hint_keeps_labelling_rows_of_other_kinds() {
    let world = world_with(|world| {
        push(
            world,
            "albums",
            json!({"key": "kyoto", "name": "Kyoto 2026"}),
        );
    });
    let mut session = world.session();
    session.user("my kyoto photos");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "photo", "name": "kyoto photos"}),
    );
    assert!(
        text(&miss).contains("other kinds (only if the message means one): #"),
        "{miss}"
    );
}

#[test]
fn nt11_r4_a_name_resolves_the_same_in_every_read_and_write() {
    // `Neh` is a word start of both Nehas: tier 3 in a find, an answer, a count and an act
    let world = seeded();
    let mut session = world.session();
    session.user("neh");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Neh"}),
    );
    assert_eq!(ids(&found["effect"]["rows"]).len(), 2, "{found}");
    let counted = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "person", "name": "Neh"}),
    );
    assert_eq!(
        counted["effect"]["value"]["values"][0]["amount"], 2,
        "{counted}"
    );
    let ask = call(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "person", "name": "Neh"}),
    );
    assert_eq!(tool_of(&ask), "ask", "{ask}");
    assert_eq!(options(&ask).len(), 2, "{ask}");
}

// ---------------------------------------------------------------------------------------------
// R5: a write over a handle past the cap ends as the selector that made it

fn many_chores(count: usize) -> World {
    world_with(|world| {
        for n in 0..count {
            push(
                world,
                "tasks",
                json!({"key": format!("bulk{n}"), "name": format!("Bulk chore {n}"), "due": "2026-11-01"}),
            );
        }
    })
}

/// A reply with the handle numbers, which differ, taken out of its text.
fn bare(reply: &Value) -> String {
    let mut out = text(reply).to_owned();
    for n in 1..=3 {
        out = out.replace(&format!("@{n}"), "@N");
    }
    out
}

#[test]
fn nt11_r5_a_handle_past_the_cap_asks_as_its_selector_does() {
    let world = many_chores(14);
    let write = |args: Value| {
        let mut session = world.session();
        session.user("finish the bulk chores");
        let found = call(
            &mut session,
            "find",
            json!({"kind": "task", "name": "bulk chore"}),
        );
        let handle = found["effect"]["result"].as_str().unwrap().to_owned();
        let args = if args["rows"] == "@" {
            let mut with = args.clone();
            with["rows"] = json!(handle);
            with
        } else {
            args
        };
        call(&mut session, "act", args)
    };
    let by_handle = write(json!({"verb": "complete", "rows": "@"}));
    let by_selector = write(json!({"verb": "complete", "kind": "task", "name": "bulk chore"}));
    assert_eq!(tool_of(&by_handle), "ask", "{by_handle}");
    assert_eq!(
        by_handle["effect"]["ask"]["question"], "Which one?",
        "{by_handle}"
    );
    // the same candidates, in the same order, and nothing was written
    assert_eq!(options(&by_handle), options(&by_selector), "{by_handle}");
    assert_eq!(options(&by_handle).len(), 12, "{by_handle}");
    assert_eq!(
        by_handle["effect"]["ambiguous"],
        by_selector["effect"]["ambiguous"]
    );
    assert_eq!(
        by_handle["effect"]["left_out"],
        by_selector["effect"]["left_out"]
    );
    assert_eq!(bare(&by_handle), bare(&by_selector));
    assert!(common::diff_rows(&by_handle).is_empty(), "{by_handle}");
}

#[test]
fn nt11_r5_the_person_saying_all_keeps_the_cap_ask_for_both() {
    let world = many_chores(14);
    let write = |by_handle: bool| {
        let mut session = world.session();
        session.user("finish all the bulk chores");
        let found = call(
            &mut session,
            "find",
            json!({"kind": "task", "name": "bulk chore"}),
        );
        let handle = found["effect"]["result"].as_str().unwrap().to_owned();
        let args = if by_handle {
            json!({"verb": "complete", "rows": handle})
        } else {
            json!({"verb": "complete", "kind": "task", "name": "bulk chore"})
        };
        call(&mut session, "act", args)
    };
    let (by_handle, by_selector) = (write(true), write(false));
    for reply in [&by_handle, &by_selector] {
        assert_eq!(tool_of(reply), "ask", "{reply}");
        assert_eq!(reply["effect"]["ask"]["count"], 14, "{reply}");
        assert_eq!(reply["effect"]["bulk"]["cap"], 12, "{reply}");
    }
    assert_eq!(
        by_handle["effect"]["ask"]["question"],
        by_selector["effect"]["ask"]["question"]
    );
}

#[test]
fn nt11_r5_a_plain_yes_after_the_which_one_over_the_cap_is_that_write() {
    // the ask over a handle is `Which one?` (no all was said); it remembers the write as the
    // cap's own question does, so "yes all of them" in the next turn is the write itself
    let world = many_chores(14);
    let mut session = world.session();
    session.user("delete the finished chores");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "bulk chore"}),
    );
    let handle = found["effect"]["result"].as_str().unwrap().to_owned();
    let write = json!({"verb": "delete", "rows": handle});
    let asked = call(&mut session, "act", write.clone());
    assert_eq!(asked["effect"]["ask"]["question"], "Which one?", "{asked}");
    session.user("yes all of them");
    let done = call(&mut session, "act", write);
    assert_eq!(common::diff_rows(&done).len(), 14, "{done}");
}

// ---------------------------------------------------------------------------------------------
// R6: a `when` on a read of trashed rows is dropped, with a note

#[test]
fn nt11_r6_a_when_on_trashed_rows_is_dropped_with_a_note() {
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "gone_a", "name": "Old gutter job", "due": "2026-03-01", "trashed": true}),
        );
        push(
            world,
            "tasks",
            json!({"key": "gone_b", "name": "Old fence job", "due": "2026-04-01", "trashed": true}),
        );
    });
    let mut session = world.session();
    session.user("what did I delete last week");
    let when = json!({"unit": "week", "rel": -1});
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "trashed": true, "when": when}),
    );
    let rows = ids(&found["effect"]["rows"]);
    for key in ["gone_a", "gone_b", "library"] {
        assert!(rows.contains(&world.id(key)), "{key}: {found}");
    }
    assert!(
        text(&found).contains("the trash date is not kept; showing all trashed tasks"),
        "{found}"
    );
    assert!(!text(&found).contains("when:"), "{found}");
    // an answer and a count read it the same way
    session.user("what did I delete last week");
    let answered = call(
        &mut session,
        "answer",
        json!({"kind": "task", "trashed": true, "when": when}),
    );
    assert_eq!(
        ids(&answered["effect"]["answer"]["rows"]).len(),
        3,
        "{answered}"
    );
    assert!(
        text(&answered).contains("the trash date is not kept; showing all trashed tasks"),
        "{answered}"
    );
    // a `when` on live rows is the person's and is kept
    session.user("tasks due this week");
    let live = call(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"unit": "week", "rel": 0}}),
    );
    assert!(!text(&live).contains("the trash date"), "{live}");
}

#[test]
fn nt11_r6_a_when_that_reaches_a_trashed_rows_own_date_is_kept() {
    // "bring back the pay rent from october": the row's own date, not the trash date (T31-023)
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "rent_oct", "name": "Pay rent", "due": "2026-10-01", "trashed": true}),
        );
        push(
            world,
            "tasks",
            json!({"key": "rent_aug", "name": "Pay rent", "due": "2026-08-01", "trashed": true}),
        );
    });
    let mut session = world.session();
    session.user("bring back the pay rent from october");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Pay rent", "trashed": true, "when": {"unit": "month", "rel": 1}}),
    );
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("rent_oct")],
        "{found}"
    );
    assert!(!text(&found).contains("the trash date"), "{found}");
}
