//! EARLIER VERSIONS of a Locker item (#1185): the plain fields, and a changed secret kept SEALED.
//! A version that held a password is drawn as dots with a Reveal behind the unlocked session; the
//! value is never in a line, label or spoken name; a relock wipes it; a restore brings the old
//! sealed value back. The entry and the screen are behind the Locker's wall. Every test goes
//! through `Driver`.

mod locker_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::locker;
use centraid_screens::testing::Driver;
use locker_support::*;
use wire::screen_event::Kind as E;

fn opened() -> (Driver, u64) {
    let mut d = driver();
    login(&d, "i1", "Bank");
    d.start();
    d.answer_effect(passed(wire::Biometry::Face));
    let id = push_item(&mut d, "i1");
    (d, id)
}

/// What an edit sends: the vault REPLACES a type's fields from the draft, so the draft is whole
/// and a sealed value being kept goes as the placeholder.
#[derive(Clone)]
struct Draft {
    title: String,
    username: String,
    url: String,
    notes: String,
    password: String,
}

impl Draft {
    fn new() -> Self {
        Self {
            title: "Bank".to_owned(),
            username: "maya@example.com".to_owned(),
            url: "example.com".to_owned(),
            notes: String::new(),
            password: "«sealed»".to_owned(),
        }
    }

    fn save(&self, d: &Driver) {
        let text = |value: &str| (!value.is_empty()).then(|| value.to_owned());
        arrange(
            d,
            act::locker::EditItem {
                item_id: "i1".to_owned(),
                title: Some(self.title.clone()),
                username: text(&self.username),
                url: text(&self.url),
                notes: text(&self.notes),
                password: Some(self.password.clone()),
                ..act::locker::EditItem::default()
            },
        );
    }
}

/// The username moved twice: two earlier versions.
fn renamed(d: &Driver) -> Draft {
    let mut draft = Draft::new();
    draft.username = "maya@work.example".to_owned();
    draft.save(d);
    draft.username = "maya@home.example".to_owned();
    draft.save(d);
    draft
}

fn entry(d: &Driver, id: u64) -> Option<wire::EarlierEntry> {
    item_data(d, id).earlier
}

fn earlier_view(v: &wire::ViewState) -> &wire::EarlierView {
    match &v.kind {
        Some(wire::view_state::Kind::Earlier(view)) => view,
        other => panic!("not the earlier-versions screen: {other:?}"),
    }
}

fn rows(v: &wire::ViewState) -> &[wire::EarlierRow] {
    match &earlier_view(v).content {
        Some(wire::earlier_view::Content::Data(data)) => &data.rows,
        other => panic!("no data: {other:?}"),
    }
}

fn open_earlier(d: &mut Driver, item: u64) -> u64 {
    // The page reads the count with itself: a change since is read on its next load.
    d.send(item, E::DataChanged(wire::DataChanged::default()));
    let entry = entry(d, item).expect("the entry");
    d.push(locker::TAB, entry.route.expect("a route"))
}

fn lines(d: &Driver, at: u64) -> Vec<String> {
    rows(d.view(at)).iter().map(|r| r.value.clone()).collect()
}

fn send(d: &mut Driver, i: u64, kind: wire::earlier_event::Kind) {
    d.send(i, E::Earlier(wire::EarlierEvent { kind: Some(kind) }));
}

fn username_now(d: &Driver) -> String {
    d.with_ctx(|ctx| {
        let answer = ctx
            .load(
                load::locker::Item {
                    item_id: "i1".to_owned(),
                }
                .into(),
            )
            .expect("item");
        match answer.answer.and_then(|a| a.answer) {
            Some(wire::app_query_response::Answer::LockerItem(found)) => {
                found.item.expect("an item").username
            }
            other => panic!("item answered {other:?}"),
        }
    })
}

#[test]
fn plain_field_edits_make_versions_and_the_entry_counts_them() {
    let (mut d, id) = opened();
    assert!(entry(&d, id).is_none(), "never edited: no entry");
    renamed(&d);
    d.send(id, E::DataChanged(wire::DataChanged::default()));
    let entry = entry(&d, id).expect("the entry");
    assert_eq!(entry.label, "Earlier versions");
    assert_eq!(entry.count_label, "2");
    let route = entry.route.expect("a route");
    assert_eq!(route.screen, locker::EARLIER);
    let Some(wire::route::Args::Earlier(args)) = route.args else {
        panic!("the shared route");
    };
    assert_eq!(args.entity_id, "i1");
    assert_eq!(args.back_label, "Bank");

    let at = open_earlier(&mut d, id);
    assert_eq!(
        lines(&d, at),
        [
            "Username: maya@home.example",
            "Username: maya@work.example",
            "Username: maya@example.com"
        ]
    );
}

#[test]
fn the_name_the_address_and_the_notes_read_in_the_pages_own_words() {
    let (mut d, id) = opened();
    let mut draft = Draft::new();
    draft.title = "Bank of Maya".to_owned();
    draft.url = "bank.example".to_owned();
    draft.save(&d);
    draft.notes = "Ask for Priya.\nSecond line".to_owned();
    draft.save(&d);
    draft.title = "Bank (old)".to_owned();
    draft.save(&d);
    let at = open_earlier(&mut d, id);
    let listed = lines(&d, at);
    assert_eq!(listed[0], "Title: Bank (old)", "{listed:?}");
    assert_eq!(listed[1], "Title: Bank of Maya", "{listed:?}");
    assert_eq!(listed[2], "Notes: none", "{listed:?}");
    assert_eq!(
        listed[3], "Title: Bank · Address: example.com",
        "{listed:?}"
    );
}

#[test]
fn restore_works_for_a_plain_field_asks_nothing_and_undo_puts_it_back() {
    let (mut d, id) = opened();
    renamed(&d);
    let at = open_earlier(&mut d, id);
    let oldest = rows(d.view(at)).last().expect("a row").seq;
    send(
        &mut d,
        at,
        wire::earlier_event::Kind::Restore(wire::earlier_event::RestoreTapped { seq: oldest }),
    );
    assert_eq!(username_now(&d), "maya@example.com");
    let status = earlier_view(d.view(at)).status.clone().expect("a status");
    assert_eq!(status.sentence, "Earlier version restored");
    assert_eq!(status.action_label, "Undo");

    send(
        &mut d,
        at,
        wire::earlier_event::Kind::StatusActed(wire::earlier_event::StatusActed {}),
    );
    assert_eq!(username_now(&d), "maya@home.example");
}

/// The password moved twice, in the clear as a member types it (the core seals it).
fn rotated(d: &Driver) -> Draft {
    let mut draft = Draft::new();
    draft.password = "battery staple".to_owned();
    draft.save(d);
    draft.password = "tr0ub4dor three".to_owned();
    draft.save(d);
    draft
}

const SECRETS: [&str; 3] = ["correct horse", "battery staple", "tr0ub4dor three"];

fn tap(d: &mut Driver, at: u64, seq: i64, key: &str, reveal: bool) {
    let tapped = wire::earlier_event::SecretTapped {
        seq,
        key: key.to_owned(),
    };
    send(
        d,
        at,
        if reveal {
            wire::earlier_event::Kind::Reveal(tapped)
        } else {
            wire::earlier_event::Kind::Conceal(tapped)
        },
    );
}

fn live_password(d: &Driver) -> String {
    unlock_core(d);
    session(
        d,
        wire::locker_session_request::Step::Reveal(wire::LockerReveal {
            item_id: "i1".to_owned(),
            column: "password".to_owned(),
            ..Default::default()
        }),
    )
    .revealed
    .expect("the live password")
    .value
}

#[test]
fn a_password_change_is_a_version_drawn_as_dots_and_no_value_reaches_the_screen() {
    let (mut d, id) = opened();
    rotated(&d);
    let at = open_earlier(&mut d, id);
    // Three rows: now, the one before, the original. Each earlier one held a password.
    assert_eq!(
        lines(&d, at),
        ["Password changed", "Password changed", "Password changed"]
    );
    let shown = rows(d.view(at));
    assert!(
        shown[0].secrets.is_empty(),
        "the current row opens the live item"
    );
    for row in &shown[1..] {
        assert_eq!(row.secrets.len(), 1);
        let secret = &row.secrets[0];
        assert_eq!(
            (
                secret.key.as_str(),
                secret.label.as_str(),
                secret.masked.as_str()
            ),
            ("password", "Password", "••••••••")
        );
        assert!(!secret.revealed && secret.value.is_empty());
        assert_eq!(secret.reveal_label, "Reveal");
        assert_eq!(secret.conceal_label, "Conceal");
        assert_eq!(secret.accessibility_label, "Password, hidden");
    }
    let everything = format!("{:?}", d.view(at));
    for secret in SECRETS {
        assert!(!everything.contains(secret), "{secret} reached the screen");
    }
    assert!(
        !everything.contains("lk1:"),
        "ciphertext reached the screen"
    );

    // A plain field and the password moved together read both.
    let mut draft = Draft::new();
    draft.username = "maya@work.example".to_owned();
    draft.password = "a fourth secret".to_owned();
    draft.save(&d);
    send(
        &mut d,
        at,
        wire::earlier_event::Kind::Refreshed(wire::earlier_event::Refreshed {}),
    );
    assert_eq!(
        lines(&d, at)[1],
        "Username: maya@example.com · Password changed"
    );
}

#[test]
fn reveal_opens_that_versions_password_behind_the_unlock_and_conceal_hides_it() {
    let (mut d, id) = opened();
    rotated(&d);
    let at = open_earlier(&mut d, id);
    let shown = rows(d.view(at)).to_vec();
    let (middle, oldest) = (shown[1].seq, shown[2].seq);
    let before = d.effects.len();

    tap(&mut d, at, oldest, "password", true);
    let after = rows(d.view(at));
    let secret = &after[2].secrets[0];
    assert!(secret.revealed, "{secret:?}");
    assert_eq!(secret.value, "correct horse", "the version's own password");
    assert_eq!(secret.accessibility_label, "Password, revealed");
    assert!(
        after[1].secrets[0].value.is_empty(),
        "only the one asked for is shown"
    );
    assert!(
        effects_of(&d, before).iter().any(|effect| matches!(
            effect,
            wire::effect::Kind::ScreenshotShield(shield) if shield.on
        )),
        "a shown secret raises the screenshot shield"
    );

    // Another reveal replaces it: one at a time.
    tap(&mut d, at, middle, "password", true);
    let after = rows(d.view(at));
    assert_eq!(after[1].secrets[0].value, "battery staple");
    assert!(!after[2].secrets[0].revealed);

    tap(&mut d, at, middle, "password", false);
    let after = rows(d.view(at));
    assert!(after[1].secrets[0].value.is_empty() && !after[1].secrets[0].revealed);
    assert!(effects_of(&d, before).iter().any(|effect| matches!(
        effect,
        wire::effect::Kind::ScreenshotShield(shield) if !shield.on
    )));

    // A key the version did not hold, and the current row, open nothing.
    tap(&mut d, at, oldest, "cvv", true);
    tap(&mut d, at, 0, "password", true);
    assert!(
        rows(d.view(at))
            .iter()
            .all(|row| row.secrets.iter().all(|secret| !secret.revealed))
    );
}

#[test]
fn a_shut_wall_reveals_nothing_and_a_relock_wipes_what_was_shown() {
    let (mut d, id) = opened();
    rotated(&d);
    let at = open_earlier(&mut d, id);
    let oldest = rows(d.view(at)).last().expect("a row").seq;
    tap(&mut d, at, oldest, "password", true);
    assert!(rows(d.view(at)).last().unwrap().secrets[0].revealed);

    // The phone leaves the foreground: the revealed value goes with the wall.
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: false,
    }));
    d.send(at, E::DataChanged(wire::DataChanged::default()));
    assert!(matches!(
        earlier_view(d.view(at))
            .page
            .as_ref()
            .and_then(|page| page.state.as_ref()),
        Some(wire::page_state::State::Refused(_))
    ));
    let everything = format!("{:?}", d.view(at));
    for secret in SECRETS {
        assert!(!everything.contains(secret), "{secret} outlived the relock");
    }
    // A reveal asked of the shut screen opens nothing.
    tap(&mut d, at, oldest, "password", true);
    let everything = format!("{:?}", d.view(at));
    assert!(!everything.contains("correct horse"));
}

#[test]
fn restore_brings_back_the_old_sealed_password_and_undo_puts_back_the_new_one() {
    let (mut d, id) = opened();
    rotated(&d);
    assert_eq!(live_password(&d), "tr0ub4dor three");
    let at = open_earlier(&mut d, id);
    let oldest = rows(d.view(at)).last().expect("a row").seq;
    send(
        &mut d,
        at,
        wire::earlier_event::Kind::Restore(wire::earlier_event::RestoreTapped { seq: oldest }),
    );
    assert_eq!(
        live_password(&d),
        "correct horse",
        "the first password is live again"
    );
    assert_eq!(
        earlier_view(d.view(at))
            .status
            .clone()
            .expect("a status")
            .sentence,
        "Earlier version restored"
    );
    send(
        &mut d,
        at,
        wire::earlier_event::Kind::StatusActed(wire::earlier_event::StatusActed {}),
    );
    assert_eq!(
        live_password(&d),
        "tr0ub4dor three",
        "undo restores the replaced one"
    );
}

#[test]
fn locked_there_is_no_entry_and_the_route_refuses_to_read_or_restore() {
    let (mut d, id) = opened();
    renamed(&d);
    let at = open_earlier(&mut d, id);
    let route = entry(&d, id).expect("the entry").route.expect("a route");
    assert_eq!(rows(d.view(at)).len(), 3);

    // The phone leaves the foreground: a relock is a wipe, on the item and on this screen.
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: false,
    }));
    d.send(at, E::DataChanged(wire::DataChanged::default()));
    assert!(
        item(&d, id).content.is_none(),
        "the item page is blank behind its wall"
    );
    match earlier_view(d.view(at))
        .page
        .as_ref()
        .and_then(|page| page.state.as_ref())
    {
        Some(wire::page_state::State::Refused(gate)) => {
            assert_eq!(gate.title, "Locker is locked.");
        }
        other => panic!("a shut wall draws the gate: {other:?}"),
    }
    // A restore asked of the shut screen writes nothing.
    send(
        &mut d,
        at,
        wire::earlier_event::Kind::Restore(wire::earlier_event::RestoreTapped { seq: 1 }),
    );
    // A fresh push of the route is the same gate.
    let again = d.push(locker::TAB, route);
    assert!(matches!(
        earlier_view(d.view(again))
            .page
            .as_ref()
            .and_then(|page| page.state.as_ref()),
        Some(wire::page_state::State::Refused(_))
    ));
    unlock_core(&d);
    assert_eq!(
        username_now(&d),
        "maya@home.example",
        "nothing was restored"
    );
}

#[test]
fn an_imported_item_says_the_files_name_only_and_a_typed_one_does_not() {
    let mut d = driver();
    login(&d, "typed", "Bank");
    arrange(
        &d,
        act::locker::AddItem {
            title: "Shop".to_owned(),
            r#type: act::locker::AddItemType::Login,
            item_id: Some("imported".to_owned()),
            username: Some("maya@example.com".to_owned()),
            password: Some("shop-secret-pw".to_owned()),
            arrived_system: Some(act::locker::AddItemArrivedSystem::Csv),
            arrived_label: Some("/Downloads/Chrome Passwords.csv".to_owned()),
            ..act::locker::AddItem::default()
        },
    );
    d.start();
    d.answer_effect(passed(wire::Biometry::Face));
    let page = push_item(&mut d, "imported");
    let line = item_data(&d, page).origin.expect("a line");
    assert_eq!(line.text, "From Chrome Passwords.csv");
    assert_eq!(line.accessibility_label, "Came from Chrome Passwords.csv");
    assert!(!line.text.contains("shop-secret-pw") && !line.text.contains("Downloads"));
    let page = push_item(&mut d, "typed");
    assert_eq!(item_data(&d, page).origin, None);
}

fn preview_view(v: &wire::ViewState) -> &wire::EarlierPreviewView {
    match &v.kind {
        Some(wire::view_state::Kind::EarlierPreview(view)) => view,
        other => panic!("not the preview: {other:?}"),
    }
}

fn open_preview(d: &mut Driver, list: u64, row: usize) -> u64 {
    let route = rows(d.view(list))[row].open.clone().expect("a route");
    d.push(locker::TAB, route)
}

#[test]
fn the_preview_shows_a_password_as_dots_and_no_value_reaches_the_screen() {
    let (mut d, id) = opened();
    rotated(&d);
    let list = open_earlier(&mut d, id);
    let at = open_preview(&mut d, list, 2);
    let data = preview_view(d.view(at))
        .data
        .clone()
        .expect("a ready preview");
    assert_eq!(data.heading, "Title: Bank");
    assert!(
        data.details.contains(&"Password: ••••••••".to_owned()),
        "{:?}",
        data.details
    );
    let everything = format!("{:?}", d.view(at));
    for secret in SECRETS {
        assert!(!everything.contains(secret), "{secret} reached the preview");
    }
    assert!(
        !everything.contains("lk1:"),
        "ciphertext reached the preview"
    );
}

#[test]
fn a_shut_wall_closes_the_preview_to_the_gate_and_restores_nothing() {
    let (mut d, id) = opened();
    renamed(&d);
    let list = open_earlier(&mut d, id);
    let at = open_preview(&mut d, list, 2);
    assert!(preview_view(d.view(at)).data.is_some());

    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: false,
    }));
    d.send(at, E::DataChanged(wire::DataChanged::default()));
    let view = preview_view(d.view(at));
    assert!(view.data.is_none(), "a relock is a wipe");
    assert!(matches!(
        view.page.as_ref().and_then(|page| page.state.as_ref()),
        Some(wire::page_state::State::Refused(_))
    ));
    d.send(
        at,
        E::EarlierPreview(wire::EarlierPreviewEvent {
            kind: Some(wire::earlier_preview_event::Kind::Restore(
                wire::earlier_preview_event::Restored {},
            )),
        }),
    );
    assert!(
        !preview_view(d.view(at)).done,
        "nothing restored, nothing closed"
    );
    unlock_core(&d);
    assert_eq!(
        username_now(&d),
        "maya@home.example",
        "nothing was restored"
    );
}
