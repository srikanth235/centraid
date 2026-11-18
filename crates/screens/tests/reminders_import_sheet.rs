//! "Import reminders" in Agenda's More (#1173): the Reminders import starts from Agenda, without the
//! import status banner, on the ONE import path (`imports.made`'s `RemindersRequested`, which asks the
//! shell for a `RemindersRead`). The row is offered only where the platform has a Reminders store
//! (iOS); its option sheet carries "Include completed reminders" (off) and the verb, in
//! `ImportsMadeState`'s words; the outcome is said on the import status line, in the import's words.

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::custody::secrets::VaultSecrets;
use centraid_screens::field::Keyed;
use centraid_screens::testing::Driver;
use centraid_screens::{Runtime, agenda, imports};
use wire::agenda_home_event::Kind as H;
use wire::agenda_home_state::Sheet;
use wire::effect::Kind as K;
use wire::effect_result::Outcome as O;
use wire::screen_event::Kind as E;

struct Rig {
    d: Driver,
    home: u64,
    made: u64,
}

/// Agenda's home and the three import services, on a phone of `platform`.
fn rig(platform: &str) -> Rig {
    rig_on(platform, routes::home(wire::AgendaDestination::Todo, ""))
}

/// The same, with Reminders opened on `route` (Home's tile opens it importing).
fn rig_on(platform: &str, route: wire::Route) -> Rig {
    rig_in(Driver::with_runtime, platform, route)
}

/// The same, over `make`'s vault.
fn rig_in(make: fn(Runtime) -> Driver, platform: &str, route: wire::Route) -> Rig {
    let registry = agenda::registry().merge(imports::registry(&VaultSecrets::new()));
    let mut tabs = vec![(agenda::TAB.to_owned(), route)];
    tabs.extend(imports::roots());
    let mut d = make(Runtime::new(registry, tabs));
    d.start();
    d.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: "en".to_owned(),
        zone: "UTC".to_owned(),
        platform: platform.to_owned(),
        ..Default::default()
    }));
    let tabs = d.navigation.clone().expect("navigation").tabs;
    let home = tabs[0].entries[0].instance;
    let made = tabs[3].entries[0].instance;
    // The camera roll's first read of the grant is not this file's.
    d.effects.clear();
    Rig { d, home, made }
}

impl Rig {
    fn state(&self) -> &wire::AgendaHomeState {
        match &self.d.view(self.home).kind {
            Some(wire::view_state::Kind::AgendaHome(state)) => state,
            other => panic!("not Agenda's home: {other:?}"),
        }
    }

    fn send(&mut self, kind: H) {
        let home = self.home;
        self.d.send(
            home,
            E::AgendaHome(wire::AgendaHomeEvent { kind: Some(kind) }),
        );
    }

    fn more_keys(&self) -> Vec<String> {
        self.state()
            .more_rows
            .iter()
            .map(|row| row.key.clone())
            .collect()
    }

    fn tap_row(&mut self) {
        self.send(H::MoreRow(wire::agenda_home_event::MoreRowPicked {
            key: "turn-on".to_owned(),
        }));
    }

    fn line(&self) -> wire::ImportsMadeState {
        match &self.d.view(self.made).kind {
            Some(wire::view_state::Kind::ImportsMade(state)) => state.clone(),
            other => panic!("made draws {other:?}"),
        }
    }

    /// The `RemindersRead`s asked and not yet answered.
    fn reads(&self) -> Vec<wire::RemindersRead> {
        self.d
            .effects
            .iter()
            .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
                K::RemindersRead(read) => Some(*read),
                _ => None,
            })
            .collect()
    }

    fn answer(&mut self, outcome: O) {
        let at = self
            .d
            .effects
            .iter()
            .position(|request| {
                matches!(
                    request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                    Some(K::RemindersRead(_))
                )
            })
            .expect("a reminders read was asked");
        let request = self.d.effects.remove(at);
        assert_eq!(
            request.instance, self.made,
            "the read is the ONE import path's: asked by imports.made, not by Agenda"
        );
        self.d.send(
            request.instance,
            E::EffectResult(wire::EffectResult {
                effect_id: request.effect_id,
                outcome: Some(outcome),
            }),
        );
    }
}

fn reminders(items: &[(&str, bool)]) -> O {
    O::RemindersSnapshot(wire::RemindersSnapshot {
        reminders: items
            .iter()
            .map(|(title, completed)| wire::PhoneReminder {
                title: (*title).to_owned(),
                completed: *completed,
                completed_at: if *completed {
                    "2026-10-01T09:00:00Z".to_owned()
                } else {
                    String::new()
                },
                ..wire::PhoneReminder::default()
            })
            .collect(),
    })
}

#[test]
fn the_row_is_offered_only_where_the_platform_has_a_reminders_source() {
    let ios = rig("ios");
    assert!(
        ios.more_keys().contains(&"turn-on".to_owned()),
        "{:?}",
        ios.more_keys()
    );
    let row = ios
        .state()
        .more_rows
        .iter()
        .find(|row| row.key == "turn-on")
        .expect("the row");
    // THE STOP SLOT, in the words every app shares: Turn on while it does not read the phone.
    assert_eq!(row.label, "Turn on Phone reminders");
    assert_eq!(row.icon_key, "Power");

    for platform in ["android", ""] {
        let rig = rig(platform);
        assert!(
            !rig.more_keys().contains(&"turn-on".to_owned())
                && !rig.more_keys().contains(&"stop".to_owned()),
            "{platform}: no reminders store, neither row"
        );
    }
    // And a tap on a row the sheet does not hold does nothing, and nothing is read.
    let mut android = rig("android");
    android.tap_row();
    assert_ne!(android.state().sheet, Sheet::ImportReminders as i32);
    assert!(android.state().import_reminders.is_none());
    android.send(H::ImportRemindersSubmitted(
        wire::agenda_home_event::ImportRemindersSubmitted {},
    ));
    assert!(android.reads().is_empty());
}

#[test]
fn the_row_opens_a_sheet_with_the_option_off_and_the_import_words() {
    let mut r = rig("ios");
    r.tap_row();
    assert_eq!(r.state().sheet, Sheet::ImportReminders as i32);
    let sheet = r.state().import_reminders.clone().expect("the sheet");
    assert_eq!(sheet.title, "Import reminders");
    assert_eq!(sheet.completed_label, "Include completed reminders");
    assert!(!sheet.completed_on, "off by default");
    assert_eq!(sheet.import_label, "Import reminders");

    r.send(H::ImportRemindersCompleted(
        wire::agenda_home_event::ImportRemindersCompletedToggled {},
    ));
    assert!(
        r.state()
            .import_reminders
            .clone()
            .expect("sheet")
            .completed_on
    );
    r.send(H::ImportRemindersCompleted(
        wire::agenda_home_event::ImportRemindersCompletedToggled {},
    ));
    assert!(
        !r.state()
            .import_reminders
            .clone()
            .expect("sheet")
            .completed_on
    );

    // Closing the sheet asks for nothing, and the option does not outlive it.
    r.send(H::ImportRemindersCompleted(
        wire::agenda_home_event::ImportRemindersCompletedToggled {},
    ));
    r.send(H::SheetClosed(wire::agenda_home_event::SheetClosed {}));
    assert_eq!(r.state().sheet, Sheet::None as i32);
    assert!(r.state().import_reminders.is_none());
    assert!(r.reads().is_empty());
    r.tap_row();
    assert!(
        !r.state()
            .import_reminders
            .clone()
            .expect("sheet")
            .completed_on
    );
}

#[test]
fn the_verb_asks_the_one_import_to_read_with_the_option_and_the_line_says_the_outcome() {
    // OFF: completed reminders are read past.
    let mut r = rig("ios");
    r.tap_row();
    r.send(H::ImportRemindersSubmitted(
        wire::agenda_home_event::ImportRemindersSubmitted {},
    ));
    assert_eq!(r.state().sheet, Sheet::None as i32, "the sheet shuts");
    let reads = r.reads();
    assert_eq!(reads.len(), 1, "{reads:?}");
    assert!(reads[0].ask_permission);
    assert!(!reads[0].include_completed);
    assert!(r.line().running, "the import says it is running");
    r.answer(reminders(&[("Renew passport", false), ("Old chore", true)]));
    let line = r.line();
    assert_eq!(
        line.summary, "1 task imported",
        "the completed one stays on the phone: the option was off"
    );
    assert!(!line.running);
    assert!(
        !line.finished,
        "a member's own import leaves the service up"
    );

    // ON: the completed reminder comes too, and the line says how many tasks.
    let mut r = rig("ios");
    r.tap_row();
    r.send(H::ImportRemindersCompleted(
        wire::agenda_home_event::ImportRemindersCompletedToggled {},
    ));
    r.send(H::ImportRemindersSubmitted(
        wire::agenda_home_event::ImportRemindersSubmitted {},
    ));
    let reads = r.reads();
    assert_eq!(reads.len(), 1);
    assert!(
        reads[0].include_completed,
        "the option travels with the verb"
    );
    r.answer(reminders(&[("Renew passport", false), ("Old chore", true)]));
    assert_eq!(r.line().summary, "2 tasks imported");
}

#[test]
fn a_refusal_is_the_apps_card_and_an_empty_phone_says_so_on_the_line() {
    let mut r = rig_in(
        Driver::first_vault,
        "ios",
        routes::home(wire::AgendaDestination::Todo, ""),
    );
    r.tap_row();
    r.send(H::ImportRemindersSubmitted(
        wire::agenda_home_event::ImportRemindersSubmitted {},
    ));
    r.answer(O::Failed(wire::EffectFailed {
        reason: "denied".to_owned(),
        denied: true,
        cancelled: false,
        ..Default::default()
    }));
    // A REFUSAL IS REMINDERS' TO SAY, not the shell's line (it would follow the member into every
    // app): the line is silent, and Reminders' own card says it with Open Settings.
    assert_eq!(r.line().summary, "");
    assert_eq!(r.line().open_label, "");
    assert!(!r.line().running);
    let Some(wire::agenda_home_state::Content::Data(data)) = &r.state().content else {
        panic!("no data");
    };
    let empty = data
        .todo
        .as_ref()
        .and_then(|todo| todo.empty.clone())
        .expect("the card");
    assert_eq!(empty.headline, "Reminders access is off.");
    assert_eq!(empty.action_label, "Open Settings");
    assert_eq!(empty.import_source, wire::ImportSource::Unspecified as i32);

    r.tap_row();
    r.send(H::ImportRemindersSubmitted(
        wire::agenda_home_event::ImportRemindersSubmitted {},
    ));
    r.answer(reminders(&[]));
    assert_eq!(r.line().summary, "No open reminders to import");
    assert_eq!(r.line().open_label, "");
}

#[test]
fn a_shell_answering_unavailable_makes_the_screen_say_the_phone_has_no_reminders() {
    // The row is offered only where a Reminders store exists, so ask as a phone that offers it and
    // let the shell answer that the store is not there after all.
    let mut r = rig("ios");
    r.tap_row();
    r.send(H::ImportRemindersSubmitted(
        wire::agenda_home_event::ImportRemindersSubmitted {},
    ));
    // The shell reports the fact only; the sentence is Rust's.
    r.answer(O::Failed(wire::EffectFailed {
        reason: imports::made::UNAVAILABLE.to_owned(),
        ..wire::EffectFailed::default()
    }));
    assert_eq!(r.line().summary, "This phone has no Reminders to import");
}

#[test]
fn after_the_import_the_slot_stops_asks_first_and_after_a_stop_turns_on_again() {
    let mut r = rig("ios");
    assert!(r.more_keys().contains(&"turn-on".to_owned()));
    r.tap_row();
    r.send(H::ImportRemindersSubmitted(
        wire::agenda_home_event::ImportRemindersSubmitted {},
    ));
    r.answer(reminders(&[("Renew passport", false)]));

    // THE SLOT SWAPS: Stop is in the place of Turn on, never both and never neither.
    let keys = r.more_keys();
    assert!(
        keys.contains(&"stop".to_owned()) && !keys.contains(&"turn-on".to_owned()),
        "{keys:?}"
    );
    let stop = r
        .state()
        .more_rows
        .iter()
        .find(|row| row.key == "stop")
        .expect("the stop row")
        .clone();
    assert_eq!(
        (stop.label.as_str(), stop.icon_key.as_str()),
        ("Stop reading Phone reminders", "Stop")
    );
    assert!(stop.route.is_none());

    // It asks first, in the shared sheet's words; dismissing keeps following.
    r.send(H::MoreRow(wire::agenda_home_event::MoreRowPicked {
        key: "stop".to_owned(),
    }));
    let confirm = r.state().stop.clone().expect("asked first");
    assert_eq!(confirm.title, "Stop reading Phone reminders?");
    assert_eq!(
        confirm.body,
        "Reminders stops reading Phone reminders on this phone. The reminders already here stay."
    );
    assert_eq!(confirm.confirm_label, "Stop reading");
    assert!(confirm.destructive);
    r.send(H::StopDismissed(wire::agenda_home_event::StopDismissed {}));
    assert!(r.state().stop.is_none());
    assert!(r.more_keys().contains(&"stop".to_owned()));

    // Confirming retires the lists and forgets the habit; the tasks stay.
    r.send(H::MoreRow(wire::agenda_home_event::MoreRowPicked {
        key: "stop".to_owned(),
    }));
    r.d.effects.clear();
    r.send(H::StopConfirmed(wire::agenda_home_event::StopConfirmed {}));
    let ops: Vec<i32> =
        r.d.effects
            .iter()
            .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
                K::Keychain(op) => Some(op.op),
                _ => None,
            })
            .collect();
    assert_eq!(ops, [wire::keychain_op::Op::Delete as i32]);
    assert_eq!(
        r.state().status.as_ref().map(|s| s.sentence.as_str()),
        Some("Reminders stopped reading your phone reminders.")
    );
    let keys = r.more_keys();
    assert!(
        keys.contains(&"turn-on".to_owned()) && !keys.contains(&"stop".to_owned()),
        "{keys:?}"
    );

    // A confirm that was never asked stops nothing.
    r.d.effects.clear();
    r.send(H::StopConfirmed(wire::agenda_home_event::StopConfirmed {}));
    assert!(r.d.effects.is_empty());
}

#[test]
fn a_cold_start_reads_the_stored_follow_and_stop_works_from_it() {
    let mut r = rig("ios");
    // Nothing is followed: the slot offers Turn on.
    assert!(r.more_keys().contains(&"turn-on".to_owned()));
    // The vault follows a list of the phone's Reminders (a pass in an earlier launch stored it);
    // THIS runtime has run no pass and holds nothing in memory about one.
    let followed = r.d.act(
        wire::ActRequest::from(act::reminders::FollowReminders {
            origin: serde_json::json!({ "ref": "list-1", "label": "Home" }).to_string(),
            records: serde_json::json!([{
                "external_id": "r1",
                "fields": { "title": "Renew passport", "status": "open", "done_at": null },
            }])
            .to_string(),
            complete: Some(false),
            since: None,
            ..Default::default()
        })
        .keyed("arrange:cold-start".to_owned()),
    );
    assert_eq!(
        followed.status,
        wire::ActStatus::Executed as i32,
        "{}",
        followed.reason
    );
    r.d.send(r.home, E::Appeared(wire::Appeared {}));

    // THE ROW SAYS WHAT IS STORED: Stop, never Turn on while the phone is followed.
    let keys = r.more_keys();
    assert!(
        keys.contains(&"stop".to_owned()) && !keys.contains(&"turn-on".to_owned()),
        "{keys:?}"
    );

    // And Stop works from that state: it retires the stored list and the row swaps.
    r.send(H::MoreRow(wire::agenda_home_event::MoreRowPicked {
        key: "stop".to_owned(),
    }));
    assert!(r.state().stop.is_some());
    r.d.effects.clear();
    r.send(H::StopConfirmed(wire::agenda_home_event::StopConfirmed {}));
    let keys = r.more_keys();
    assert!(
        keys.contains(&"turn-on".to_owned()) && !keys.contains(&"stop".to_owned()),
        "{keys:?}"
    );
    assert_eq!(
        r.state().status.as_ref().map(|s| s.sentence.as_str()),
        Some("Reminders stopped reading your phone reminders.")
    );
}

/// THE FIRST-OPEN CARD'S IMPORT AND HOME'S TILE (FirstImports): one tap, or the tile's route, asks the
/// phone for its Reminders at once, without the option sheet and without the completed ones; where
/// the phone has no Reminders it asks nothing.
#[test]
fn the_card_and_the_tile_start_the_import_without_the_sheet() {
    let mut r = rig("ios");
    // The first-open card names the import where the phone has Reminders, and not elsewhere.
    let first = |platform| {
        rig_in(
            Driver::first_vault,
            platform,
            routes::home(wire::AgendaDestination::Todo, ""),
        )
    };
    assert_eq!(first("ios").state().import_label, "Import from Reminders");
    assert_eq!(first("android").state().import_label, "");
    r.send(H::ImportRemindersRequested(
        wire::agenda_home_event::ImportRemindersRequested {},
    ));
    let reads = r.reads();
    assert_eq!(reads.len(), 1, "{reads:?}");
    assert!(reads[0].ask_permission && !reads[0].include_completed);
    assert_eq!(r.state().sheet, Sheet::None as i32);

    let tile = centraid_screens::reminders::routes::home_importing();
    let mut r = rig_on("ios", tile.clone());
    // The screen first appeared before the environment named the platform: it appears again.
    let home = r.home;
    r.d.send(home, E::Appeared(wire::Appeared {}));
    let reads = r.reads();
    assert_eq!(
        reads.len(),
        1,
        "opening on the tile's route imports: {reads:?}"
    );
    assert!(reads[0].ask_permission);

    let mut android = rig_on("android", tile);
    android.send(H::ImportRemindersRequested(
        wire::agenda_home_event::ImportRemindersRequested {},
    ));
    assert!(android.reads().is_empty());
}

/// A REFUSED REMINDERS GRANT reads on Home's Reminders tile as Photos' does (FirstHomeRefused), and
/// only there: the shell's import line says nothing.
#[test]
fn a_refused_reminders_grant_reads_on_the_home_tile_and_nowhere_else() {
    let secrets = VaultSecrets::new();
    let registry = agenda::registry()
        .merge(imports::registry(&secrets))
        .merge(centraid_screens::shell::registry(&secrets));
    let mut tabs = vec![(
        agenda::TAB.to_owned(),
        routes::home(wire::AgendaDestination::Todo, ""),
    )];
    tabs.extend(imports::roots());
    tabs.push((
        centraid_screens::shell::TAB.to_owned(),
        centraid_screens::shell::routes::home(),
    ));
    let mut d = Driver::first_vault(Runtime::new(registry, tabs));
    d.start();
    d.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: "en".to_owned(),
        zone: "UTC".to_owned(),
        platform: "ios".to_owned(),
        ..Default::default()
    }));
    let tabs = d.navigation.clone().expect("navigation").tabs;
    let home = tabs[0].entries[0].instance;
    let made = tabs[3].entries[0].instance;
    let springboard = tabs[4].entries[0].instance;
    d.effects.clear();
    d.send(
        home,
        E::AgendaHome(wire::AgendaHomeEvent {
            kind: Some(H::ImportRemindersRequested(
                wire::agenda_home_event::ImportRemindersRequested {},
            )),
        }),
    );
    let at = d
        .effects
        .iter()
        .position(|request| {
            matches!(
                request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                Some(K::RemindersRead(_))
            )
        })
        .expect("a reminders read was asked");
    let request = d.effects.remove(at);
    d.send(
        request.instance,
        E::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(O::Failed(wire::EffectFailed {
                reason: "denied".to_owned(),
                denied: true,
                ..Default::default()
            })),
        }),
    );
    let Some(wire::view_state::Kind::Home(state)) = d.view(springboard).kind.clone() else {
        panic!("not Home");
    };
    let Some(wire::home_state::Content::Data(data)) = state.content else {
        panic!("no data");
    };
    let tile = data
        .tiles
        .iter()
        .find(|tile| tile.widget == "reminders")
        .expect("the reminders widget");
    assert_eq!(tile.empty_copy, "Reminders access is off · Open Settings");
    let Some(wire::view_state::Kind::ImportsMade(line)) = d.view(made).kind.clone() else {
        panic!("not made");
    };
    assert_eq!(line.summary, "");
}
