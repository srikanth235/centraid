//! "Import reminders" in Agenda's More (#1173): the Reminders import starts from Agenda, without the
//! import status banner, on the ONE import path (`imports.made`'s `RemindersRequested`, which asks the
//! shell for a `RemindersRead`). The row is offered only where the platform has a Reminders store
//! (iOS); its option sheet carries "Include completed reminders" (off) and the verb, in
//! `ImportsMadeState`'s words; the outcome is said on the import status line, in the import's words.

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::custody::secrets::VaultSecrets;
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
    let registry = agenda::registry().merge(imports::registry(&VaultSecrets::new()));
    let mut tabs = vec![(
        agenda::TAB.to_owned(),
        routes::home(wire::AgendaDestination::Todo, ""),
    )];
    tabs.extend(imports::roots());
    let mut d = Driver::with_runtime(Runtime::new(registry, tabs));
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
            key: "import-reminders".to_owned(),
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
        ios.more_keys().contains(&"import-reminders".to_owned()),
        "{:?}",
        ios.more_keys()
    );
    let row = ios
        .state()
        .more_rows
        .iter()
        .find(|row| row.key == "import-reminders")
        .expect("the row");
    assert_eq!(row.label, "Import reminders");
    assert_eq!(row.icon_key, "Download");

    for platform in ["android", ""] {
        let rig = rig(platform);
        assert!(
            !rig.more_keys().contains(&"import-reminders".to_owned()),
            "{platform}: no reminders store, no row"
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
    // The words are ImportsMadeState's.
    let line = r.line();
    assert_eq!(sheet.completed_label, line.completed_label);
    assert_eq!(sheet.import_label, line.reminders_label);

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
fn a_refusal_and_an_empty_phone_say_so_on_the_line_in_the_import_words() {
    let mut r = rig("ios");
    r.tap_row();
    r.send(H::ImportRemindersSubmitted(
        wire::agenda_home_event::ImportRemindersSubmitted {},
    ));
    r.answer(O::Failed(wire::EffectFailed {
        reason: "denied".to_owned(),
        denied: true,
        cancelled: false,
    }));
    assert_eq!(
        r.line().summary,
        // The line drops a sentence's final full stop, as every import line does.
        "Reminders access is off. Turn it on in Settings"
    );

    r.tap_row();
    r.send(H::ImportRemindersSubmitted(
        wire::agenda_home_event::ImportRemindersSubmitted {},
    ));
    r.answer(reminders(&[]));
    assert_eq!(r.line().summary, "No open reminders to import");
}
