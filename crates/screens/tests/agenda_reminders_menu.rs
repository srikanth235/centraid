//! The Reminders "Filter and sort" menu (#1173, `Main.dc.html`): the funnel on the Reminders
//! place only, its picks kept in the keychain, and the choice worn by the home, the smart-list
//! pages and a list's own page.

mod todo_support;

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda;
use centraid_screens::kit::menu;
use centraid_screens::runtime::Runtime;
use centraid_screens::testing::Driver;
use todo_support::*;
use wire::AgendaDestination as Dest;

fn home(destination: Dest) -> (Driver, u64) {
    let mut driver = Driver::with_runtime(Runtime::new(
        agenda::registry(),
        vec![(agenda::TAB.to_owned(), routes::home(destination, ""))],
    ));
    driver.start();
    let id = driver.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    (driver, id)
}

fn state(d: &Driver, id: u64) -> &wire::AgendaHomeState {
    match &d.view(id).kind {
        Some(wire::view_state::Kind::AgendaHome(state)) => state,
        other => panic!("not Agenda's home: {other:?}"),
    }
}

fn titles_of(groups: &[wire::TodoRowGroup]) -> Vec<String> {
    rows(groups).iter().map(|r| r.title.clone()).collect()
}

fn keychain(found: bool, text: &str) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::Keychain(wire::KeychainValue {
        found,
        value: text.as_bytes().to_vec(),
    })
}

fn is_keychain(request: &wire::EffectRequest, op: wire::keychain_op::Op) -> bool {
    matches!(
        request.effect.as_ref().and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::Keychain(k)) if k.op == op as i32
    )
}

/// Answer the choice's read (the one Get Reminders' home asks when it appears), the way a shell
/// does.
fn settle_reads(d: &mut Driver, stored: Option<&str>) {
    d.answer_effect(match stored {
        Some(text) => keychain(true, text),
        None => keychain(false, ""),
    });
}

#[test]
fn the_choice_is_asked_once_when_the_home_appears_and_its_answer_is_worn() {
    let (mut d, _) = home(Dest::Todo);
    let gets = d
        .effects
        .iter()
        .filter(|r| is_keychain(r, wire::keychain_op::Op::Get))
        .count();
    assert_eq!(
        gets, 1,
        "Reminders reads its own choice and waits on no calendar's flag"
    );
    d.answer_effect(keychain(true, "sort=title;flagged=0;completed=0"));
    assert!(d.effects.is_empty());
}

#[test]
fn the_menu_is_on_the_reminders_place_only() {
    let (mut d, id) = home(Dest::Todo);
    settle_reads(&mut d, None);
    let menu = state(&d, id).filter_menu.as_ref().expect("the funnel");
    assert_eq!(menu.spoken, "Filter and sort");
    assert!(!menu.filtering);
    let show = menu::find(menu, "show").unwrap();
    assert_eq!(show.options.len(), 2);
    assert_eq!(
        menu::checked(menu::find(menu, menu::SORT).unwrap()),
        ["manual"]
    );

    let (c, cid) = home(Dest::Day);
    assert!(state(&c, cid).filter_menu.is_none(), "not on the Calendar");
}

#[test]
fn a_page_opened_afterwards_reads_the_choice_and_wears_it() {
    let (mut d, _) = home(Dest::Todo);
    clear_tasks(&d);
    for title in ["Pear", "apple", "Mango"] {
        task(&d, title);
    }
    let all = d.push(agenda::TAB, routes::todo_list(wire::TodoView::All));
    assert_ne!(
        titles_of(&list_data(d.view(all)).groups),
        ["apple", "Mango", "Pear"],
        "the core's own order until the choice is read"
    );
    d.answer_effect(keychain(true, "sort=title;flagged=0;completed=0"));
    assert_eq!(
        titles_of(&list_data(d.view(all)).groups),
        ["apple", "Mango", "Pear"]
    );
}
