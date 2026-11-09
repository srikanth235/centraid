//! The Reminders "Filter and sort" menu (#1173, `Main.dc.html`): the funnel on the Reminders
//! place only, its picks kept in the keychain, and the choice worn by the home, the smart-list
//! pages and a list's own page.

mod todo_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda::{self, routes};
use centraid_screens::catalog::act;
use centraid_screens::kit::menu;
use centraid_screens::runtime::Runtime;
use centraid_screens::testing::Driver;
use todo_support::*;
use wire::AgendaDestination as Dest;
use wire::agenda_home_event::Kind as H;
use wire::screen_event::Kind as E;

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

fn pick(d: &mut Driver, id: u64, section: &str, option: &str) {
    d.send(
        id,
        E::AgendaHome(wire::AgendaHomeEvent {
            kind: Some(H::FilterMenuPicked(wire::FilterMenuPicked {
                section_key: section.to_owned(),
                option_key: option.to_owned(),
            })),
        }),
    );
}

fn inbox_titles(d: &Driver, id: u64) -> Vec<String> {
    let Some(wire::agenda_home_state::Content::Data(data)) = &state(d, id).content else {
        panic!("no data");
    };
    titles_of(&data.todo.as_ref().unwrap().groups)
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

/// Answer the calendar's flag (the first Get) and then the choice's (the second), the way a shell
/// answers them one after the other.
fn settle_reads(d: &mut Driver, stored: Option<&str>) {
    d.answer_effect(keychain(false, ""));
    let second = d
        .effects
        .iter()
        .position(|r| is_keychain(r, wire::keychain_op::Op::Get))
        .expect("the choice is read after the calendar's flag");
    assert_eq!(second, 0);
    d.answer_effect(match stored {
        Some(text) => keychain(true, text),
        None => keychain(false, ""),
    });
}

#[test]
fn the_choice_is_read_after_the_calendars_flag_never_beside_it() {
    let (mut d, _) = home(Dest::Todo);
    let gets = d
        .effects
        .iter()
        .filter(|r| is_keychain(r, wire::keychain_op::Op::Get))
        .count();
    assert_eq!(gets, 1, "only the calendar's flag is out");
    d.answer_effect(keychain(false, ""));
    let gets = d
        .effects
        .iter()
        .filter(|r| is_keychain(r, wire::keychain_op::Op::Get))
        .count();
    assert_eq!(gets, 1, "the choice is asked once the flag landed");
    // The choice's answer is its own: a stored value is worn, the flag is untouched.
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

    d.send(
        id,
        E::AgendaHome(wire::AgendaHomeEvent {
            kind: Some(H::Destination(
                wire::agenda_home_event::DestinationChanged {
                    destination: Dest::Day as i32,
                },
            )),
        }),
    );
    assert!(state(&d, id).filter_menu.is_none(), "not on the Calendar");
}

#[test]
fn a_sort_reorders_the_inbox_is_kept_and_does_not_light_the_funnel() {
    let (mut d, id) = home(Dest::Todo);
    clear_tasks(&d);
    for title in ["Pear", "apple", "Mango"] {
        task(&d, title);
    }
    settle_reads(&mut d, None);
    d.pump(Duration::from_millis(300));
    pick(&mut d, id, menu::SORT, "title");
    assert_eq!(inbox_titles(&d, id), ["apple", "Mango", "Pear"]);
    let menu = state(&d, id).filter_menu.as_ref().unwrap();
    assert!(!menu.filtering, "a sort is not a filter");
    assert_eq!(
        menu::checked(menu::find(menu, menu::SORT).unwrap()),
        ["title"]
    );
    let saved = d
        .effects
        .iter()
        .find(|r| is_keychain(r, wire::keychain_op::Op::Set))
        .expect("the pick is kept");
    let Some(wire::effect::Kind::Keychain(op)) =
        saved.effect.as_ref().and_then(|e| e.kind.as_ref())
    else {
        unreachable!()
    };
    assert_eq!(op.key, "agenda.reminders.view");
    assert_eq!(
        String::from_utf8_lossy(&op.value),
        "sort=title;flagged=0;completed=0"
    );
}

#[test]
fn flagged_only_lights_the_funnel_and_clear_puts_the_rows_back() {
    let (mut d, id) = home(Dest::Todo);
    clear_tasks(&d);
    let keep = task(&d, "Call the bank");
    task(&d, "Water the plants");
    arrange(&d, act::reminders::StarTask { task_id: keep });
    settle_reads(&mut d, None);
    d.pump(Duration::from_millis(300));
    pick(&mut d, id, "show", "flagged");
    assert_eq!(inbox_titles(&d, id), ["Call the bank"]);
    let menu = state(&d, id).filter_menu.as_ref().unwrap();
    assert!(menu.filtering);
    assert_eq!(menu.spoken, "Filter and sort, on");

    d.send(
        id,
        E::AgendaHome(wire::AgendaHomeEvent {
            kind: Some(H::FilterMenuCleared(wire::FilterMenuCleared {})),
        }),
    );
    assert_eq!(inbox_titles(&d, id).len(), 2);
    assert!(!state(&d, id).filter_menu.as_ref().unwrap().filtering);
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
    d.answer_effect(keychain(false, ""));
    d.answer_effect(keychain(true, "sort=title;flagged=0;completed=0"));
    assert_eq!(
        titles_of(&list_data(d.view(all)).groups),
        ["apple", "Mango", "Pear"]
    );
}
