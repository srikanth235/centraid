//! Shared arrangement for the 24 words' Driver tests: a keyed core, the custody
//! screens over a fake shelf, and a shell whose two secret stores are in memory.
#![allow(dead_code)]

use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::custody::keeper::{FakeKeeper, KeeperSlot};
use centraid_screens::custody::secrets::VaultSecrets;
use centraid_screens::custody::{self, routes};
use centraid_screens::locker;
use centraid_screens::testing::{Driver, FakeShell};
use centraid_screens::{Registry, Runtime};

pub struct Phone {
    pub driver: Driver,
    pub shell: FakeShell,
    pub secrets: VaultSecrets,
    pub keeper: Arc<FakeKeeper>,
    /// The root screen's instance.
    pub id: u64,
}

pub fn words_a() -> Vec<String> {
    let mut words = vec!["abandon".to_owned(); 23];
    words.push("art".to_owned());
    words
}

pub fn words_b() -> Vec<String> {
    let mut words = vec!["zoo".to_owned(); 23];
    words.push("vote".to_owned());
    words
}

/// A phone whose first screen is `route`, on the platform `platform`.
pub fn phone(route: wire::Route, platform: &str) -> Phone {
    let secrets = VaultSecrets::new();
    let keeper = FakeKeeper::watching(&secrets);
    let slot = KeeperSlot::with(keeper.clone());
    let registry = Registry::default()
        .merge(custody::registry_with(&secrets, &slot))
        .merge(locker::registry());
    let runtime = Runtime::new(registry, vec![("words".to_owned(), route)])
        .with_services(custody::services());
    let mut driver = Driver::keyed(runtime);
    driver.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: "en-US".to_owned(),
        zone: "UTC".to_owned(),
        platform: platform.to_owned(),
    }));
    driver.start();
    let id = *driver.views.keys().next().expect("the root opened");
    Phone {
        driver,
        shell: FakeShell::default(),
        secrets,
        keeper,
        id,
    }
}

pub fn make_phone(platform: &str) -> Phone {
    phone(routes::make(), platform)
}

impl Phone {
    /// Answer every secret and probe effect the way a shell does.
    pub fn serve(&mut self) {
        self.driver.serve(&mut self.shell);
    }

    pub fn make(&self) -> &wire::WordsMakeState {
        match &self.driver.view(self.id).kind {
            Some(wire::view_state::Kind::WordsMake(state)) => state,
            other => panic!("not words.make: {other:?}"),
        }
    }

    pub fn enter(&self) -> &wire::WordsEnterState {
        match &self.driver.view(self.id).kind {
            Some(wire::view_state::Kind::WordsEnter(state)) => state,
            other => panic!("not words.enter: {other:?}"),
        }
    }

    pub fn show(&self) -> &wire::WordsShowState {
        match &self.driver.view(self.id).kind {
            Some(wire::view_state::Kind::WordsShow(state)) => state,
            other => panic!("not words.show: {other:?}"),
        }
    }

    pub fn send_make(&mut self, kind: wire::words_make_event::Kind) {
        self.driver.send(
            self.id,
            wire::screen_event::Kind::WordsMake(wire::WordsMakeEvent { kind: Some(kind) }),
        );
        self.serve();
    }

    pub fn send_enter(&mut self, kind: wire::words_enter_event::Kind) {
        self.driver.send(
            self.id,
            wire::screen_event::Kind::WordsEnter(wire::WordsEnterEvent { kind: Some(kind) }),
        );
        self.serve();
    }

    pub fn send_show(&mut self, kind: wire::words_show_event::Kind) {
        self.driver.send(
            self.id,
            wire::screen_event::Kind::WordsShow(wire::WordsShowEvent { kind: Some(kind) }),
        );
        self.serve();
    }

    /// The effect kinds still pending, oldest first.
    pub fn pending(&self) -> Vec<wire::effect::Kind> {
        self.driver
            .effects
            .iter()
            .filter_map(|request| request.effect.as_ref()?.kind.clone())
            .collect()
    }

    pub fn primary_make(&mut self) {
        self.send_make(wire::words_make_event::Kind::Primary(wire::WordsPrimary {}));
    }
}

pub fn owner_checked(outcome: wire::owner_checked::Outcome) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::OwnerChecked(wire::OwnerChecked {
        available: true,
        biometry: wire::Biometry::Face as i32,
        outcome: outcome as i32,
    })
}
