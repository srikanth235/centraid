//! Home's search through the door a shell uses: one term asked of the whole vault
//! through the shell's named query, grouped by app, every row carrying its page.
//! Ports the cases of the KMP `HomeSearchSpec`.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::shell;
use centraid_screens::testing::Driver;
use wire::home_search_event::Kind as S;
use wire::screen_event::Kind as E;

fn opened() -> (Driver, u64) {
    let mut d = Driver::with_runtime(shell::runtime());
    d.start();
    let i = d.push("home", shell::routes::search());
    (d, i)
}

fn state(d: &Driver, i: u64) -> wire::HomeSearchState {
    match &d.view(i).kind {
        Some(wire::view_state::Kind::HomeSearch(state)) => (**state).clone(),
        other => panic!("not Home's search: {other:?}"),
    }
}

fn type_term(d: &mut Driver, i: u64, term: &str) {
    d.send(
        i,
        E::HomeSearch(wire::HomeSearchEvent {
            kind: Some(S::Term(wire::home_search_event::TermChanged {
                term: term.to_owned(),
            })),
        }),
    );
}

fn say(d: &mut Driver, i: u64, kind: S) {
    d.send(i, E::HomeSearch(wire::HomeSearchEvent { kind: Some(kind) }));
}

fn data(d: &Driver, i: u64) -> wire::HomeSearchData {
    match state(d, i).content {
        Some(wire::home_search_state::Content::Data(data)) => *data,
        other => panic!("not data: {other:?}"),
    }
}

#[test]
fn it_rests_on_a_note_with_no_recent_terms_and_never_reads_nothing() {
    let (d, i) = opened();
    let state = state(&d, i);
    assert_eq!(
        state.chrome.as_ref().unwrap().placeholder,
        "Search everything"
    );
    assert_eq!(state.chrome.as_ref().unwrap().scope_label, "All apps");
    let Some(wire::home_search_state::Content::Resting(resting)) = state.content else {
        panic!("not resting");
    };
    assert_eq!(resting.note, "Searches every app.");
    assert!(resting.suggestions.is_empty());
    assert!(resting.suggestions_label.is_empty());
}

#[test]
fn a_term_is_grouped_by_app_in_the_springboards_order_and_every_row_opens_its_page() {
    let (mut d, i) = opened();
    type_term(&mut d, i, "tahoe");
    let found = data(&d, i);
    assert!(
        !found.groups.is_empty(),
        "the example scenario mentions Tahoe"
    );
    let order = [
        "photos",
        "docs",
        "calendar",
        "reminders",
        "notes",
        "money",
        "health",
        "people",
        "locker",
    ];
    let positions: Vec<usize> = found
        .groups
        .iter()
        .map(|group| {
            order
                .iter()
                .position(|app| *app == group.app_id)
                .unwrap_or(order.len())
        })
        .collect();
    assert!(
        positions.windows(2).all(|pair| pair[0] <= pair[1]),
        "{positions:?}"
    );
    for group in &found.groups {
        assert_eq!(
            group.count as usize,
            group.rows.len() + group.containers.len()
        );
        let said = if group.count == 1 {
            format!("{}, 1 result", group.label)
        } else {
            format!("{}, {} results", group.label, group.count)
        };
        assert_eq!(group.accessibility_label, said);
        for row in &group.rows {
            let route = row
                .route
                .as_ref()
                .expect("a row with no page is not offered");
            assert!(
                route.screen.starts_with(&format!("{}.", group.app_id)),
                "{} opens {}",
                group.app_id,
                route.screen
            );
            assert_eq!(
                row.accessibility_label,
                if row.kind_label.is_empty() {
                    row.title.clone()
                } else {
                    format!("{}, {}", row.kind_label, row.title)
                }
            );
        }
        for container in &group.containers {
            assert!(container.route.is_some());
            assert!(!container.kind_label.is_empty());
        }
    }
    // The Ask row hands the term to the assistant across every app.
    let ask = found.ask.expect("an Ask row");
    assert_eq!(ask.label, "Ask about “tahoe”");
    assert_eq!(ask.question, "Find tahoe");
    assert_eq!(ask.scope, "");
    assert_eq!(found.ask_route, Some(shell::routes::ask("Find tahoe", "")));
}

#[test]
fn a_my_card_hit_from_home_opens_the_owners_people_page() {
    let mut d = Driver::founded();
    d.start();
    let owner = d
        .handle
        .with_vault(|vault| Ok(vault.self_id()?.expect("the owner")))
        .expect("the vault is open");
    let edited = d.act(wire::ActRequest {
        app: "people".to_owned(),
        action: "edit-person".to_owned(),
        input: [
            (
                "id".to_owned(),
                wire::Value {
                    kind: Some(wire::value::Kind::Text(owner.clone())),
                },
            ),
            (
                "title".to_owned(),
                wire::Value {
                    kind: Some(wire::value::Kind::Text("Quokka Owner".to_owned())),
                },
            ),
            (
                "role".to_owned(),
                wire::Value {
                    kind: Some(wire::value::Kind::Text("Keeper".to_owned())),
                },
            ),
        ]
        .into_iter()
        .collect(),
        invoke_key: "test:home-find-my-card".to_owned(),
        ..wire::ActRequest::default()
    });
    assert_eq!(edited.status, wire::ActStatus::Executed as i32);

    let i = d.push("home", shell::routes::search());
    type_term(&mut d, i, "Keeper");
    let hit = data(&d, i)
        .groups
        .into_iter()
        .find(|group| group.app_id == "people")
        .and_then(|group| group.rows.into_iter().next())
        .expect("My card is a Home Find result");
    let route = hit.route.expect("the search result opens its People row");
    let Some(wire::route::Args::PeoplePerson(person)) = route.args.as_ref() else {
        panic!("the My card result routes to a person page");
    };
    assert_eq!(person.party_id, owner);

    let opened = d.push("home", route);
    let Some(wire::view_state::Kind::PeoplePerson(state)) = &d.view(opened).kind else {
        panic!("the My card search hit opens People");
    };
    let Some(wire::people_person_state::Content::Data(person)) = &state.content else {
        panic!("the People page reads the owner's card");
    };
    assert!(person.is_me, "the destination remains My card");
}

#[test]
fn a_term_that_finds_nothing_says_so_and_still_offers_the_ask() {
    let (mut d, i) = opened();
    type_term(&mut d, i, "zzqxjv");
    let found = data(&d, i);
    assert!(found.groups.is_empty());
    // Nothing matched is the page's own empty state; the answer stays for the Ask row under it.
    let Some(wire::page_state::State::Empty(empty)) = state(&d, i).page.and_then(|page| page.state)
    else {
        panic!("a term that found nothing is an empty page");
    };
    assert_eq!(empty.headline, "No matches");
    assert_eq!(empty.body, "Nothing in this vault matches “zzqxjv”.");
    assert!(found.ask.is_some());
}

#[test]
fn a_blank_term_is_the_resting_page_and_a_typed_one_is_trimmed_for_the_question() {
    let (mut d, i) = opened();
    type_term(&mut d, i, "   ");
    assert!(matches!(
        state(&d, i).content,
        Some(wire::home_search_state::Content::Resting(_))
    ));
    type_term(&mut d, i, "  zzqxjv ");
    assert_eq!(data(&d, i).ask.unwrap().question, "Find zzqxjv");
    say(&mut d, i, S::Cleared(wire::home_search_event::Cleared {}));
    assert!(matches!(
        state(&d, i).content,
        Some(wire::home_search_state::Content::Resting(_))
    ));
    assert!(state(&d, i).term.is_empty());
}

#[test]
fn the_last_four_terms_acted_on_are_the_suggestions_newest_first_and_without_repeats() {
    let (mut d, i) = opened();
    for term in ["alpha", "beta", "Alpha", "gamma", "delta", "epsilon"] {
        type_term(&mut d, i, term);
        say(
            &mut d,
            i,
            S::Committed(wire::home_search_event::Committed {}),
        );
    }
    say(&mut d, i, S::Cleared(wire::home_search_event::Cleared {}));
    let Some(wire::home_search_state::Content::Resting(resting)) = state(&d, i).content else {
        panic!("not resting");
    };
    assert_eq!(resting.suggestions_label, "Recent");
    assert_eq!(resting.suggestions, ["epsilon", "delta", "gamma", "Alpha"]);
    // A term typed and never acted on is not remembered.
    type_term(&mut d, i, "unacted");
    say(&mut d, i, S::Cleared(wire::home_search_event::Cleared {}));
    assert_eq!(state(&d, i).recent[0], "epsilon");
    // Picking a suggestion searches it.
    say(
        &mut d,
        i,
        S::Suggestion(wire::home_search_event::SuggestionPicked {
            term: "delta".to_owned(),
        }),
    );
    assert_eq!(state(&d, i).term, "delta");
    assert!(matches!(
        state(&d, i).content,
        Some(wire::home_search_state::Content::Data(_))
    ));
}

#[test]
fn a_photograph_hit_opens_its_lightbox_among_the_photographs_beside_it() {
    let (mut d, i) = opened();
    type_term(&mut d, i, "tahoe");
    let found = data(&d, i);
    let photos = found
        .groups
        .iter()
        .find(|group| group.app_id == "photos")
        .expect("the scenario captions photographs with Tahoe");
    assert!(photos.rows.iter().any(|row| row.entity == "photo"));
    // The album that matched is a container with its own page.
    assert!(
        photos
            .containers
            .iter()
            .any(|c| c.entity == "album" && c.icon_key == "Image")
    );
    for row in photos.rows.iter().filter(|row| row.entity == "photo") {
        let route = row.route.as_ref().unwrap();
        let Some(wire::route::Args::PhotosLightbox(lightbox)) = &route.args else {
            panic!("a photograph opens its lightbox: {route:?}");
        };
        assert!(lightbox.neighbour_ids.contains(&lightbox.photo_id));
    }
}

#[test]
fn the_home_search_and_ask_routes_are_the_shells_values() {
    let route = shell::routes::search();
    assert_eq!(route.screen, "home.search");
    assert!(matches!(route.args, Some(wire::route::Args::HomeSearch(_))));
    let ask = shell::routes::ask("Find x", "notes");
    assert_eq!(ask.screen, "chat.ask");
    let Some(wire::route::Args::Ask(args)) = ask.args else {
        panic!("not an ask");
    };
    assert_eq!(
        (args.question.as_str(), args.scope.as_str()),
        ("Find x", "notes")
    );
}

fn commit(d: &mut Driver, i: u64, term: &str) {
    type_term(d, i, term);
    say(d, i, S::Committed(wire::home_search_event::Committed {}));
}

#[test]
fn a_recent_search_is_still_there_when_search_is_closed_and_opened_again() {
    let (mut d, i) = opened();
    commit(&mut d, i, "tahoe");
    commit(&mut d, i, "alpha");
    d.pop("home", i);
    let again = d.push("home", shell::routes::search());
    let Some(wire::home_search_state::Content::Resting(resting)) = state(&d, again).content else {
        panic!("not resting");
    };
    assert_eq!(resting.suggestions_label, "Recent");
    assert_eq!(resting.suggestions, ["alpha", "tahoe"]);
    assert_eq!(state(&d, again).recent, ["alpha", "tahoe"]);
}

#[test]
fn a_fresh_core_has_no_recent_searches() {
    let (mut d, i) = opened();
    commit(&mut d, i, "tahoe");
    let (fresh, j) = opened();
    assert!(state(&fresh, j).recent.is_empty());
    assert!(state(&d, i).recent == ["tahoe"]);
}
