//! The lock wall and the home it guards: ports of the `LockerSpec` gate cases
//! (opening asks at once; the OS saying yes is not the Locker opening; a cancel
//! is not a failure; leaving the foreground relocks) and the Items · Review ·
//! Generate · search cases, headless.

mod locker_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::locker::generator::Entropy;
use centraid_screens::locker::{self, routes};
use centraid_screens::testing::Driver;
use centraid_screens::{Registry, Runtime};
use locker_support::*;
use wire::locker_home_event::Kind as H;
use wire::screen_event::Kind as E;

#[test]
fn opening_locker_asks_at_once_and_a_cancel_leaves_the_wall_to_try_again() {
    let mut d = driver();
    d.start();
    let id = home_instance(&d);
    // No wall before the prompt: the prompt is the first thing.
    assert!(matches!(
        effects_of(&d, 0).as_slice(),
        [wire::effect::Kind::OwnerCheck(check)] if check.ask && !check.title.is_empty()
    ));
    let wall = wall_of(&d, id).expect("locked is a wall");
    assert_eq!(wall.phase, wire::locker_wall::Phase::Unlocking as i32);
    d.answer_effect(checked(wire::owner_checked::Outcome::Cancelled));
    let wall = wall_of(&d, id).expect("still a wall");
    assert_eq!(wall.phase, wire::locker_wall::Phase::Locked as i32);
    assert_eq!(wall.unlock_label, "Unlock with your face");
    assert!(wall.notice.is_empty(), "a cancel is not a failure");
    // The wall reads nothing: no content under it.
    assert!(home(&d, id).content.is_none() && !home(&d, id).secure);
}

#[test]
fn the_os_saying_yes_opens_the_locker_only_through_the_core() {
    let mut d = driver();
    d.start();
    let id = home_instance(&d);
    d.answer_effect(passed(wire::Biometry::Face));
    let state = home(&d, id);
    assert!(state.wall.is_none(), "the core opened its session");
    assert!(state.secure, "the capture shield holds while open");
    assert!(matches!(
        state.content,
        Some(wire::locker_home_state::Content::Data(_))
    ));
    let out = effects_of(&d, 0);
    assert!(
        out.iter()
            .any(|k| matches!(k, wire::effect::Kind::Announce(a) if a.topic == "locker.unlocked"))
    );
}

#[test]
fn a_core_without_keys_says_so_before_any_prompt() {
    let mut d = Driver::with_runtime(locker::runtime());
    d.start();
    let id = home_instance(&d);
    assert!(
        effects_of(&d, 0).is_empty(),
        "no prompt for a core that would refuse"
    );
    let wall = wall_of(&d, id).unwrap();
    assert_eq!(wall.phase, wire::locker_wall::Phase::Unavailable as i32);
    assert_eq!(wall.title, "Locker needs your recovery key");
    assert_eq!(wall.words_label, "Enter your recovery key");
    // The control's page is Rust's to name: words.enter, a re-key from Locker.
    assert_eq!(
        wall.words_route,
        Some(centraid_screens::custody::routes::rekey_for_locker())
    );
}

#[test]
fn a_failed_check_names_the_way_back_and_a_lockout_says_so() {
    let mut d = driver();
    d.start();
    let id = home_instance(&d);
    d.answer_effect(checked(wire::owner_checked::Outcome::Failed));
    let wall = wall_of(&d, id).unwrap();
    assert_eq!(wall.phase, wire::locker_wall::Phase::Failed as i32);
    assert_eq!(wall.unlock_label, "Try again");
    assert!(!wall.notice.is_empty());
    d.send(
        id,
        E::LockerWall(wire::LockerWallEvent {
            kind: Some(wire::locker_wall_event::Kind::Unlock(
                wire::locker_wall_event::UnlockTapped {},
            )),
        }),
    );
    d.answer_effect(checked(wire::owner_checked::Outcome::LockedOut));
    assert!(wall_of(&d, id).unwrap().notice.contains("Too many tries"));
}

/// THE PHONE'S REFUSALS ARE COUNTED AND SAID (#1146, R-1146-1A-2). The core never
/// sees the OS prompt, so the wall reports a refusal; the locked wall says how
/// many, a dismissal is not one, and the unlock that follows tells the home once
/// what it cleared.
#[test]
fn a_refused_check_is_counted_said_on_the_wall_and_told_once_after_the_unlock() {
    let mut d = driver();
    d.start();
    let id = home_instance(&d);
    let tap_unlock = |d: &mut Driver| {
        d.send(
            id,
            E::LockerWall(wire::LockerWallEvent {
                kind: Some(wire::locker_wall_event::Kind::Unlock(
                    wire::locker_wall_event::UnlockTapped {},
                )),
            }),
        );
    };
    // A dismissal is not a failure.
    d.answer_effect(checked(wire::owner_checked::Outcome::Cancelled));
    assert!(!wall_of(&d, id).unwrap().notice.contains("failed unlock"));

    tap_unlock(&mut d);
    d.answer_effect(checked(wire::owner_checked::Outcome::Failed));
    let notice = wall_of(&d, id).unwrap().notice;
    assert!(notice.contains("1 failed unlock · last "), "{notice}");

    tap_unlock(&mut d);
    d.answer_effect(checked(wire::owner_checked::Outcome::LockedOut));
    let notice = wall_of(&d, id).unwrap().notice;
    assert!(notice.contains("Too many tries"), "{notice}");
    assert!(notice.contains("2 failed unlocks · last "), "{notice}");

    // The unlock the phone allows opens, and says what it cleared.
    tap_unlock(&mut d);
    d.answer_effect(passed(wire::Biometry::Face));
    let status = home_data(&d, id).status_line;
    assert!(status.contains("2 failed unlocks · last "), "{status}");

    // Relock and open again: nothing is left to say.
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: false,
    }));
    tap_unlock(&mut d);
    d.answer_effect(passed(wire::Biometry::Face));
    let status = home_data(&d, id).status_line;
    assert!(!status.contains("failed unlock"), "{status}");
}

#[test]
fn leaving_the_foreground_relocks_at_once_and_returning_does_not_prompt() {
    let mut d = driver();
    login(&d, "i1", "Bank");
    let id = open_home(&mut d);
    assert_eq!(home_data(&d, id).rows.len(), 1);
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: false,
    }));
    let state = home(&d, id);
    assert!(state.wall.is_some() && !state.secure && state.content.is_none());
    let before = d.effects.len();
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: true,
    }));
    assert!(effects_of(&d, before).is_empty(), "returning asks nothing");
    assert!(wall_of(&d, id).is_some());
    // The core itself is locked, whether or not a screen heard.
    let state = session(
        &d,
        wire::locker_session_request::Step::State(wire::LockerStateAsk::default()),
    );
    assert_eq!(state.state, wire::LockerSessionState::Locked as i32);
}

#[test]
fn a_screen_finds_a_session_another_screen_opened() {
    let mut d = driver();
    login(&d, "i1", "Bank");
    d.start();
    unlock_core(&d);
    // A page pushed over a wall that is already open simply opens.
    let item = push_item(&mut d, "i1");
    assert!(wall_of(&d, item).is_none());
    assert_eq!(item_data_title(&d, item), "Bank");
}

fn item_data_title(d: &Driver, id: u64) -> String {
    item_data(d, id).title
}

#[test]
fn items_fold_into_chips_rows_and_a_day_one_state() {
    let mut d = driver();
    let id = open_home(&mut d);
    let data = home_data(&d, id);
    assert!(data.rows.is_empty());
    let empty = data.items_empty.expect("day one");
    assert_eq!(empty.headline, "Nothing is kept here yet");
    login(&d, "i1", "Bank");
    arrange(
        &d,
        centraid_screens::catalog::act::locker::AddItem {
            title: "Visa".to_owned(),
            r#type: centraid_screens::catalog::act::locker::AddItemType::Card,
            ..Default::default()
        },
    );
    d.pump(std::time::Duration::from_millis(300));
    let data = home_data(&d, id);
    assert_eq!(data.rows.len(), 2);
    let keys: Vec<&str> = data.filters.iter().map(|c| c.key.as_str()).collect();
    assert_eq!(keys, ["all", "login", "card"]);
    let bank = data.rows.iter().find(|r| r.title == "Bank").unwrap();
    assert_eq!(bank.type_chip, "LO");
    assert!(bank.meta.starts_with("Login · maya@example.com"));
    assert!(matches!(
        bank.route.as_ref().and_then(|r| r.args.as_ref()),
        Some(wire::route::Args::LockerItem(item)) if item.item_id == "i1"
    ));
    // A filter re-folds the shelf already held.
    home_event(
        &mut d,
        id,
        H::Filter(wire::locker_home_event::FilterPicked {
            key: "card".to_owned(),
        }),
    );
    assert_eq!(home_data(&d, id).rows.len(), 1);
}

#[test]
fn the_band_is_places_then_more_and_search_is_the_bar() {
    let mut d = driver();
    let id = open_home(&mut d);
    let band = home(&d, id).band;
    let keys: Vec<&str> = band.iter().map(|t| t.key.as_str()).collect();
    assert_eq!(keys, ["items", "review", "generate", "more"]);
    home_event(
        &mut d,
        id,
        H::SearchOpened(wire::locker_home_event::SearchOpened {}),
    );
    let state = home(&d, id);
    assert_eq!(state.destination, wire::LockerDestination::Search as i32);
    assert!(state.search.unwrap().open);
    assert!(state.band.iter().all(|t| !t.current), "no tab is lit");
    home_event(
        &mut d,
        id,
        H::SearchClosed(wire::locker_home_event::SearchClosed {}),
    );
    let state = home(&d, id);
    assert_eq!(state.destination, wire::LockerDestination::Items as i32);
    assert!(!state.search.unwrap().open);
    // More is a sheet, never a destination.
    home_event(
        &mut d,
        id,
        H::Band(wire::locker_home_event::BandPicked {
            key: "more".to_owned(),
        }),
    );
    assert_eq!(
        home(&d, id).sheet,
        wire::locker_home_state::Sheet::More as i32
    );
    assert_eq!(
        home(&d, id).destination,
        wire::LockerDestination::Items as i32
    );
}

#[test]
fn search_finds_by_title_and_never_offers_ask() {
    let mut d = driver();
    login(&d, "i1", "Bank");
    let id = open_home(&mut d);
    home_event(
        &mut d,
        id,
        H::SearchOpened(wire::locker_home_event::SearchOpened {}),
    );
    home_event(
        &mut d,
        id,
        H::SearchTyped(wire::locker_home_event::SearchTyped {
            term: "bank".to_owned(),
        }),
    );
    let data = home_data(&d, id);
    assert_eq!(data.hits.len(), 1);
    home_event(
        &mut d,
        id,
        H::SearchTyped(wire::locker_home_event::SearchTyped {
            term: "zzzz".to_owned(),
        }),
    );
    let data = home_data(&d, id);
    assert!(data.hits.is_empty());
    assert!(data.search_empty.unwrap().headline.contains("zzzz"));
}

#[test]
fn review_names_a_compromised_item_and_the_checks_this_phone_does_not_run() {
    let mut d = driver();
    arrange(
        &d,
        centraid_screens::catalog::act::locker::AddItem {
            title: "Leaked".to_owned(),
            compromised: Some(true),
            password: Some("x".to_owned()),
            ..Default::default()
        },
    );
    let id = open_home(&mut d);
    home_event(
        &mut d,
        id,
        H::Band(wire::locker_home_event::BandPicked {
            key: "review".to_owned(),
        }),
    );
    let data = home_data(&d, id);
    assert_eq!(data.review.len(), 1);
    assert_eq!(data.review[0].key, "compromised");
    assert_eq!(data.review_unchecked.len(), 2);
}

#[test]
fn a_relock_wipes_what_the_home_held() {
    let mut d = driver();
    login(&d, "i1", "Bank");
    let id = open_home(&mut d);
    home_event(
        &mut d,
        id,
        H::SearchOpened(wire::locker_home_event::SearchOpened {}),
    );
    home_event(
        &mut d,
        id,
        H::More(wire::locker_home_event::MorePicked {
            key: "lock".to_owned(),
        }),
    );
    let state = home(&d, id);
    assert!(state.wall.is_some() && state.content.is_none());
    // Where the member was is kept; what they saw and searched is not.
    assert_eq!(state.destination, wire::LockerDestination::Items as i32);
    assert_eq!(state.search.unwrap().term, "");
}

fn fixed(bytes: Vec<u8>) -> impl Fn() -> Entropy + Send + Sync + 'static {
    move || {
        let bytes = bytes.clone();
        Box::new(move |_| bytes.clone())
    }
}

#[test]
fn generate_draws_from_the_given_bytes_and_a_relock_drops_the_candidate() {
    let all: Vec<u8> = (0..=255).collect();
    let mut d = Driver::keyed(Runtime::new(
        Registry::default().with(locker::HOME, locker::home::build_with(fixed(all))),
        vec![(
            "locker".to_owned(),
            routes::home(wire::LockerDestination::Generate),
        )],
    ));
    d.start();
    let id = home_instance(&d);
    d.answer_effect(passed(wire::Biometry::Passcode));
    let generator = home_data(&d, id).generator.expect("generate tab");
    assert_eq!(generator.output.chars().count(), 20);
    assert!(!generator.use_label.is_empty());
    home_event(
        &mut d,
        id,
        H::GeneratorKind(wire::locker_home_event::GeneratorKindPicked {
            key: "pin".to_owned(),
        }),
    );
    let generator = home_data(&d, id).generator.unwrap();
    assert_eq!(generator.output.chars().count(), 6);
    assert!(
        generator.use_label.is_empty(),
        "a PIN is not put on an item"
    );
    // Copy is a sensitive clip with a deadline.
    let before = d.effects.len();
    home_event(
        &mut d,
        id,
        H::GeneratorCopy(wire::locker_home_event::GeneratorCopy {}),
    );
    assert!(effects_of(&d, before).iter().any(|k| matches!(
        k,
        wire::effect::Kind::ClipboardSet(set) if set.sensitive && set.clear_after_ms == 30_000
    )));
}
