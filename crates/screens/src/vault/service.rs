//! THE SHELF'S LAUNCH, AS A SERVICE (#1135, lane H2): a screen with no view
//! and no tab that runs for as long as the runtime does.
//!
//! The vaults are opened keyed from the phone's secrets, and the secrets are
//! the shell's: reading them is a round trip. So the launch is a short saga,
//! each step waiting for the shell's answer to the last:
//!
//! 1. read every secret the phone keeps (skipped when a screen already did);
//! 2. a debug build's demo seed is stored where a real seed lives;
//! 3. [`Shelf::survey`] asks each vault file which vault it is, and answers
//!    the writes the launch owes — send them;
//! 4. [`Shelf::open_all`] opens every vault, keyed when it can be.
//!
//! Afterwards it hears the app's lifecycle: the app leaving the foreground
//! settles the crash window's markers, and the operating system asking for
//! memory back rests every vault but the one in front.

use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;

use super::shelf::Shelf;
use crate::Registry;
use crate::custody::secrets::{self, VaultSecrets};
use crate::screen::{Ctx, Screen};

/// The service's route name.
pub const NAME: &str = "vault.shelf";

/// The service's route, for [`crate::Runtime::with_services`].
#[must_use]
pub fn route() -> wire::Route {
    wire::Route {
        screen: NAME.to_owned(),
        ..Default::default()
    }
}

/// The service, registered under [`NAME`].
#[must_use]
pub fn registry(shelf: &Arc<Shelf>, secrets: &VaultSecrets) -> Registry {
    let (shelf, secrets) = (Arc::clone(shelf), secrets.clone());
    Registry::default().with(NAME, move |_| {
        Some(Box::new(Service {
            shelf: Arc::clone(&shelf),
            secrets: secrets.clone(),
            phase: Phase::Idle,
        }) as Box<dyn Screen>)
    })
}

/// What the service is waiting for the shell to answer.
enum Phase {
    Idle,
    /// The ops of the batch in flight, to fold the answers back with.
    Reading(Vec<wire::SecretOp>),
    DemoSeed(Vec<wire::SecretOp>),
    Owed(Vec<wire::SecretOp>),
    /// The launch is done; a batch in flight is a settle's.
    Ready,
    Settling(Vec<wire::SecretOp>),
}

struct Service {
    shelf: Arc<Shelf>,
    secrets: VaultSecrets,
    phase: Phase,
}

impl Service {
    fn send(ops: Vec<wire::SecretOp>) -> Vec<wire::Effect> {
        vec![secrets::effect(ops)]
    }

    fn begin(&mut self) -> Vec<wire::Effect> {
        if self.shelf.dir().is_none() || self.shelf.loaded() {
            return Vec::new();
        }
        if self.secrets.loaded() {
            return self.after_read();
        }
        let ops = VaultSecrets::load_ops();
        self.phase = Phase::Reading(ops.clone());
        Self::send(ops)
    }

    fn after_read(&mut self) -> Vec<wire::Effect> {
        if let Some(seed) = self.shelf.dev_seed()
            && crate::custody::secrets::is_seed(&seed.trim().to_ascii_lowercase())
            && self.secrets.seed().is_none()
        {
            let ops = VaultSecrets::remember_seed(&seed.trim().to_ascii_lowercase(), false).first();
            self.phase = Phase::DemoSeed(ops.clone());
            return Self::send(ops);
        }
        self.survey()
    }

    fn survey(&mut self) -> Vec<wire::Effect> {
        let owed = self.shelf.survey();
        if owed.is_empty() {
            return self.open();
        }
        self.phase = Phase::Owed(owed.clone());
        Self::send(owed)
    }

    fn open(&mut self) -> Vec<wire::Effect> {
        self.shelf.open_all();
        self.phase = Phase::Ready;
        Vec::new()
    }
}

impl Screen for Service {
    fn update(&mut self, event: wire::ScreenEvent, _ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => self.begin(),
            Some(E::EffectResult(result)) => {
                let Some(wire::effect_result::Outcome::Secrets(batched)) = result.outcome else {
                    return Vec::new();
                };
                match std::mem::replace(&mut self.phase, Phase::Idle) {
                    Phase::Reading(ops) => {
                        self.secrets.absorb(&ops, &batched.answers);
                        self.after_read()
                    }
                    Phase::DemoSeed(ops) => {
                        self.secrets.absorb(&ops, &batched.answers);
                        self.survey()
                    }
                    Phase::Owed(ops) => {
                        self.secrets.absorb(&ops, &batched.answers);
                        self.open()
                    }
                    Phase::Settling(ops) => {
                        self.secrets.absorb(&ops, &batched.answers);
                        self.phase = Phase::Ready;
                        Vec::new()
                    }
                    other => {
                        self.phase = other;
                        Vec::new()
                    }
                }
            }
            Some(E::MemoryWarning(_)) => {
                if matches!(self.phase, Phase::Ready) {
                    self.shelf.rest();
                }
                Vec::new()
            }
            Some(E::Lifecycle(lifecycle)) if matches!(self.phase, Phase::Ready) => {
                if lifecycle.foreground {
                    return Vec::new();
                }
                let owed = self.shelf.settle();
                if owed.is_empty() {
                    return Vec::new();
                }
                self.phase = Phase::Settling(owed.clone());
                Self::send(owed)
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}
