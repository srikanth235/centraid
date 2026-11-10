//! LOCKER'S LANDING AND ITS ITEM PAGE (#1173): the six category cards and
//! their counts, Starred and Recently used, the verification-code card and
//! "Change password on website". Counts and values only; no clock is read.

mod locker_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use locker_support::*;
use wire::locker_home_event::Kind as H;

fn add(
    d: &centraid_screens::testing::Driver,
    id: &str,
    title: &str,
    build: impl FnOnce(&mut act::locker::AddItem),
) {
    let mut item = act::locker::AddItem {
        title: title.to_owned(),
        item_id: Some(id.to_owned()),
        ..Default::default()
    };
    build(&mut item);
    arrange(d, item);
}

fn card(data: &wire::LockerHomeData, key: &str) -> (String, u32) {
    let card = data
        .categories
        .iter()
        .find(|card| card.key == key)
        .unwrap_or_else(|| panic!("no card `{key}`"));
    (card.label.clone(), card.count)
}

#[test]
fn the_landing_counts_every_category_in_the_boards_order() {
    let mut d = driver();
    add(&d, "l1", "GitHub", |i| {
        i.r#type = act::locker::AddItemType::Login;
        i.otp_seed = Some("JBSWY3DPEHPK3PXP".to_owned());
        i.password = Some("pw".to_owned());
    });
    add(&d, "l2", "Zerodha", |i| {
        i.r#type = act::locker::AddItemType::Login;
        i.compromised = Some(true);
        i.password = Some("pw".to_owned());
    });
    add(&d, "c1", "HDFC Visa", |i| {
        i.r#type = act::locker::AddItemType::Card;
    });
    add(&d, "c2", "Amex", |i| {
        i.r#type = act::locker::AddItemType::Card;
    });
    add(&d, "w1", "Airtel", |i| {
        i.r#type = act::locker::AddItemType::Wifi;
    });
    add(&d, "x1", "Old", |i| {
        i.r#type = act::locker::AddItemType::Login;
    });
    arrange(
        &d,
        act::locker::TrashItem {
            locker_item_id: "x1".to_owned(),
        },
    );
    let id = open_home(&mut d);
    d.pump(std::time::Duration::from_millis(300));
    let data = home_data(&d, id);
    let keys: Vec<&str> = data.categories.iter().map(|c| c.key.as_str()).collect();
    assert_eq!(keys, ["all", "codes", "card", "wifi", "review", "trash"]);
    assert_eq!(card(&data, "all"), ("All".to_owned(), 5));
    assert_eq!(card(&data, "codes"), ("Codes".to_owned(), 1));
    assert_eq!(card(&data, "card"), ("Cards".to_owned(), 2));
    assert_eq!(card(&data, "wifi"), ("Wi-Fi".to_owned(), 1));
    assert_eq!(card(&data, "review"), ("Review".to_owned(), 1));
    assert_eq!(card(&data, "trash"), ("Trash".to_owned(), 1));
    // Only Trash carries a page; the rest the home browses itself.
    for c in &data.categories {
        assert_eq!(c.route.is_some(), c.key == "trash", "{}", c.key);
    }
    assert!(data.rows.is_empty(), "the landing lists no rows of its own");
}

#[test]
fn a_card_opens_its_list_and_the_items_key_goes_back() {
    let mut d = driver();
    add(&d, "l1", "GitHub", |i| {
        i.otp_seed = Some("JBSWY3DPEHPK3PXP".to_owned());
        i.password = Some("pw".to_owned());
    });
    add(&d, "l2", "Plain", |i| i.password = Some("pw".to_owned()));
    let id = open_home(&mut d);
    d.pump(std::time::Duration::from_millis(300));
    home_event(
        &mut d,
        id,
        H::CategoryPicked(wire::locker_home_event::CategoryPicked {
            key: "codes".to_owned(),
        }),
    );
    let data = home_data(&d, id);
    assert_eq!(data.list_title, "Codes");
    assert_eq!(data.list_back_label, "Locker");
    let titles: Vec<&str> = data.rows.iter().map(|r| r.title.as_str()).collect();
    assert_eq!(titles, ["GitHub"]);
    assert!(
        data.rows[0].chips.iter().any(|chip| chip.label == "CODE"),
        "a login that makes codes says so"
    );
    home_event(
        &mut d,
        id,
        H::CategoryClosed(wire::locker_home_event::CategoryClosed {}),
    );
    let data = home_data(&d, id);
    assert!(data.rows.is_empty() && data.categories.len() == 6);
    // Review is a destination, not a list on this page.
    home_event(
        &mut d,
        id,
        H::CategoryPicked(wire::locker_home_event::CategoryPicked {
            key: "review".to_owned(),
        }),
    );
    assert_eq!(
        home(&d, id).destination,
        wire::LockerDestination::Review as i32
    );
}

#[test]
fn starred_lists_the_starred_and_recently_used_only_what_was_used() {
    let mut d = driver();
    add(&d, "a", "Alpha", |i| i.password = Some("pw".to_owned()));
    add(&d, "b", "Beta", |i| i.password = Some("pw".to_owned()));
    add(&d, "c", "Gamma", |i| i.password = Some("pw".to_owned()));
    arrange(
        &d,
        act::locker::StarItem {
            locker_item_id: "c".to_owned(),
        },
    );
    let id = open_home(&mut d);
    d.pump(std::time::Duration::from_millis(300));
    let data = home_data(&d, id);
    assert_eq!(data.starred_title, "Starred");
    assert_eq!(data.recent_title, "Recently used");
    let starred: Vec<&str> = data.starred.iter().map(|r| r.title.as_str()).collect();
    assert_eq!(starred, ["Gamma"]);
    assert!(data.starred[0].starred);
    assert!(data.recent.is_empty(), "nothing was used yet");
    // Revealing a secret is a use.
    let page = push_item(&mut d, "b");
    verb(&mut d, page, "password", "reveal");
    d.pump(std::time::Duration::from_millis(300));
    let data = home_data(&d, id);
    let recent: Vec<&str> = data.recent.iter().map(|r| r.title.as_str()).collect();
    assert_eq!(recent, ["Beta"]);
}

#[test]
fn the_item_page_leads_with_a_verification_code_card() {
    let mut d = driver();
    add(&d, "g", "GitHub", |i| {
        i.otp_seed = Some("JBSWY3DPEHPK3PXP".to_owned());
        i.password = Some("pw".to_owned());
        i.url = Some("github.com/login".to_owned());
    });
    d.start();
    d.answer_effect(passed(wire::Biometry::Face));
    let id = push_item(&mut d, "g");
    let data = item_data(&d, id);
    let first = &data.sections[0];
    assert_eq!(first.rows.len(), 1);
    assert_eq!(first.rows[0].key, "otp_seed");
    assert_eq!(first.rows[0].label, "Verification code");
    verb(&mut d, id, "otp_seed", "code");
    let data = item_data(&d, id);
    let code = &data.sections[0].rows[0];
    assert!(
        code.revealed && code.value.len() == 7,
        "grouped: {}",
        code.value
    );
    assert_eq!(code.countdown.as_ref().unwrap().period, 30);
}

#[test]
fn change_password_opens_the_items_own_site_and_only_for_a_login_with_one() {
    let mut d = driver();
    add(&d, "g", "GitHub", |i| {
        i.password = Some("pw".to_owned());
        i.url = Some("github.com/login".to_owned());
    });
    add(&d, "n", "No site", |i| i.password = Some("pw".to_owned()));
    add(&d, "w", "Home", |i| {
        i.r#type = act::locker::AddItemType::Wifi;
        i.password = Some("pw".to_owned());
    });
    d.start();
    d.answer_effect(passed(wire::Biometry::Face));
    let id = push_item(&mut d, "g");
    let action = item_data(&d, id)
        .change_password
        .expect("a login with a site");
    assert_eq!(action.key, "change_password");
    assert_eq!(action.label, "Change password on website");
    let before = d.effects.len();
    item_event(
        &mut d,
        id,
        wire::locker_item_event::Kind::Action(wire::locker_item_event::ActionTapped {
            key: "change_password".to_owned(),
        }),
    );
    let opened: Vec<String> = effects_of(&d, before)
        .into_iter()
        .filter_map(|effect| match effect {
            wire::effect::Kind::OpenUrl(open) => Some(open.url),
            _ => None,
        })
        .collect();
    assert_eq!(opened, ["https://github.com/login"]);
    let none = push_item(&mut d, "n");
    assert!(item_data(&d, none).change_password.is_none());
    let wifi = push_item(&mut d, "w");
    assert!(item_data(&d, wifi).change_password.is_none());
}

/// EVERY TRASH CAN BE EMPTIED (#1185): Locker's too, behind the kit's confirm,
/// with Locker's own first sentence on a single purge.
#[test]
fn the_trash_deletes_forever_and_empties_in_the_shared_words() {
    use centraid_screens::locker::{self, routes};
    use wire::trash_event::{self as te, Kind as T};

    fn trash_state(d: &centraid_screens::testing::Driver, i: u64) -> wire::TrashView {
        match &d.view(i).kind {
            Some(wire::view_state::Kind::Trash(trash)) => trash.clone(),
            other => panic!("not the trash: {other:?}"),
        }
    }
    fn send(d: &mut centraid_screens::testing::Driver, i: u64, kind: T) {
        d.send(
            i,
            wire::screen_event::Kind::Trash(wire::TrashEvent { kind: Some(kind) }),
        );
    }

    let mut d = driver();
    for (id, title) in [("a", "Old login"), ("b", "Old card")] {
        add(&d, id, title, |i| i.password = Some("pw".to_owned()));
        arrange(
            &d,
            act::locker::TrashItem {
                locker_item_id: id.to_owned(),
            },
        );
    }
    open_home(&mut d);
    let i = d.push(locker::TAB, routes::trash());
    let view = trash_state(&d, i);
    let Some(wire::trash_view::Content::Data(data)) = &view.content else {
        panic!("no data: {view:?}");
    };
    assert_eq!(data.count_label, "Trash · 2");
    assert_eq!(data.empty_label, "Empty trash");
    assert!(
        data.rows[0].meta.contains(" · Erased "),
        "{}",
        data.rows[0].meta
    );

    send(&mut d, i, T::Purge(te::PurgeTapped { id: "a".to_owned() }));
    let confirm = trash_state(&d, i).confirm.expect("a confirm");
    assert_eq!(confirm.title, "Delete this item forever?");
    assert_eq!(
        confirm.body,
        "It's erased with its secrets and history. This cannot be undone."
    );
    send(&mut d, i, T::Dismissed(te::Dismissed {}));

    send(&mut d, i, T::Empty(te::EmptyTapped {}));
    let confirm = trash_state(&d, i).confirm.expect("a confirm");
    assert_eq!(confirm.title, "Empty trash?");
    assert_eq!(confirm.confirm_label, "Empty trash");
    send(&mut d, i, T::Confirmed(te::Confirmed {}));
    let view = trash_state(&d, i);
    let Some(wire::trash_view::Content::Data(data)) = &view.content else {
        panic!("no data: {view:?}");
    };
    assert!(data.rows.is_empty(), "the trash is empty");
    assert_eq!(data.empty_label, "");
}
