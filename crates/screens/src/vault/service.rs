//! THE SHELF'S SERVICE (#1135, lane H2): a screen with no view and no tab that
//! runs for as long as the runtime does. It opens the vaults at launch, performs
//! what screens ask of the shelf, and tells Home what the shelf holds.
//!
//! ## The launch
//!
//! The vaults are opened keyed from the phone's secrets, and the secrets are the
//! shell's: reading them is a round trip. So the launch is a short saga, each
//! step waiting for the shell's answer to the last:
//!
//! 1. read every secret the phone keeps (skipped when a screen already did);
//! 2. a debug build's demo seed is stored where a real seed lives;
//! 3. [`Shelf::survey`] asks each vault file which vault it is, and answers the
//!    writes the launch owes (the index a found recorded only in its marker);
//! 4. the per-vault keys an earlier build wrote under names built from a vault's
//!    id are read, now that the ids are known (`VaultSecrets::hydrate_ops`: the
//!    Android store lists only the names it has indexed);
//! 5. [`Shelf::open_all`] opens every vault, keyed when it can be.
//!
//! One batch is in flight at a time, so an answer finds its ops.
//!
//! ## What Home is told
//!
//! Home (`shell::home`) takes what the phone holds as events the shell tells it.
//! The shell is this service now: when a Home opens, when the shelf changes (it
//! announces under the table `shelf`, which this service reads) and when a pass
//! moved the backup line, it tells every Home `VaultsTold`, `BackupLineTold` and
//! `OutcomeTold`. What Home asks of the shelf (`VaultCommand`: switch, make,
//! restore, forget, rename) reaches this service and not a shell.
//!
//! Afterwards it hears the app's lifecycle: the app leaving the foreground
//! settles the crash window's markers, and the operating system asking for
//! memory back rests every vault but the one in front.

use std::collections::VecDeque;
use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;

use super::shelf::Shelf;
use crate::Registry;
use crate::backup::{line, reading};
use crate::catalog::load;
use crate::custody::secrets::{self, VaultSecrets};
use crate::kit::read::Reading;
use crate::passes::conductor::TOPIC as PASSES;
use crate::screen::{Ctx, Screen};
use crate::shell::HOME;

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
            launch: Launch::Idle,
            in_flight: None,
            waiting: VecDeque::new(),
        }) as Box<dyn Screen>)
    })
}

/// Where the launch is. A batch is what it waits for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Launch {
    /// Not begun, or no shelf to open.
    Idle,
    /// Waiting on the secrets, the demo seed, the owed writes or the hydration.
    Waiting,
    /// The vaults are open.
    Ready,
}

/// What a batch's answer sets going next.
#[derive(Clone, Copy)]
enum Then {
    /// The cache is read: the demo seed, then the survey.
    AfterRead,
    /// The demo seed is stored: survey.
    Survey,
    /// The writes the survey owed landed: hydrate.
    Hydrate,
    /// The per-vault keys are read: open.
    Open,
    /// Nothing follows: a settle's or a command's writes.
    Nothing,
}

struct Service {
    shelf: Arc<Shelf>,
    secrets: VaultSecrets,
    launch: Launch,
    /// The batch the shell is performing, and what its answer sets going.
    in_flight: Option<(Vec<wire::SecretOp>, Then)>,
    /// Batches that wait for it.
    waiting: VecDeque<(Vec<wire::SecretOp>, Then)>,
}

impl Service {
    /// Send `ops` now, or after the batch in flight.
    fn send(&mut self, ops: Vec<wire::SecretOp>, then: Then) -> Vec<wire::Effect> {
        if ops.is_empty() {
            return self.proceed(then);
        }
        if self.in_flight.is_some() {
            self.waiting.push_back((ops, then));
            return Vec::new();
        }
        self.in_flight = Some((ops.clone(), then));
        vec![secrets::effect(ops)]
    }

    /// The next step of the launch.
    fn proceed(&mut self, then: Then) -> Vec<wire::Effect> {
        match then {
            Then::AfterRead => {
                if let Some(seed) = self.shelf.dev_seed() {
                    let seed = seed.trim().to_ascii_lowercase();
                    if secrets::is_seed(&seed) && self.secrets.seed().is_none() {
                        let ops = VaultSecrets::remember_seed(&seed, false).first();
                        return self.send(ops, Then::Survey);
                    }
                }
                self.proceed(Then::Survey)
            }
            Then::Survey => {
                let owed = self.shelf.survey();
                self.send(owed, Then::Hydrate)
            }
            Then::Hydrate => {
                let ids = self.shelf.surveyed_ids();
                let ops = VaultSecrets::hydrate_ops(&ids);
                self.send(ops, Then::Open)
            }
            Then::Open => {
                self.shelf.open_all();
                self.launch = Launch::Ready;
                Vec::new()
            }
            Then::Nothing => Vec::new(),
        }
    }

    fn begin(&mut self) -> Vec<wire::Effect> {
        if self.shelf.dir().is_none() || self.shelf.loaded() || self.launch != Launch::Idle {
            return Vec::new();
        }
        self.launch = Launch::Waiting;
        if self.secrets.loaded() {
            return self.proceed(Then::AfterRead);
        }
        self.send(VaultSecrets::load_ops(), Then::AfterRead)
    }

    fn answered(&mut self, batched: &wire::SecretBatched) -> Vec<wire::Effect> {
        let Some((ops, then)) = self.in_flight.take() else {
            return Vec::new();
        };
        self.secrets.absorb(&ops, &batched.answers);
        let mut effects = self.proceed(then);
        if self.in_flight.is_none()
            && let Some((ops, then)) = self.waiting.pop_front()
        {
            effects.extend(self.send(ops, then));
        }
        effects
    }

    // ---- what Home is told -------------------------------------------------

    /// The shelf's holdings, through the same read every screen has.
    fn holdings(ctx: &Ctx) -> Option<wire::Holdings> {
        let loaded = ctx.load(load::shell::Holdings {}.into()).ok()?;
        match loaded.answer?.answer? {
            wire::app_query_response::Answer::Holdings(holdings) => Some(holdings),
            _ => None,
        }
    }

    fn told(event: wire::home_event::Kind) -> wire::ScreenEvent {
        wire::ScreenEvent {
            kind: Some(E::Home(wire::HomeEvent { kind: Some(event) })),
        }
    }

    /// Tell every Home what the shelf holds, and the backup line under the
    /// vault in front. Nothing is told before the shelf has read its directory:
    /// Home keeps its loading state rather than a claim.
    fn tell_home(&self, ctx: &Ctx) {
        let Some(held) = Self::holdings(ctx) else {
            return;
        };
        if !held.loaded {
            return;
        }
        let shell_vault = |vault: &wire::HeldVault| wire::ShellVault {
            vault_id: vault.vault_id.clone(),
            name: vault.name.clone(),
            color: String::new(),
            state: if vault.frozen.is_some() {
                wire::HomeVaultState::Frozen
            } else {
                wire::HomeVaultState::Online
            } as i32,
            originals_withheld: 0,
        };
        let vaults: Vec<wire::ShellVault> = held.vaults.iter().map(shell_vault).collect();
        ctx.tell_screen(
            HOME,
            Self::told(wire::home_event::Kind::VaultsTold(
                wire::home_event::VaultsTold {
                    vault: held.vaults.iter().find(|v| v.foreground).map(shell_vault),
                    none: vaults.is_empty(),
                    vaults,
                },
            )),
        );
        ctx.tell_screen(
            HOME,
            Self::told(wire::home_event::Kind::BackupTold(
                wire::home_event::BackupLineTold {
                    line: Self::backup_line(ctx, held.foreground.is_empty()),
                },
            )),
        );
        if let Some(sentence) = self.shelf.take_outcome() {
            ctx.tell_screen(
                HOME,
                Self::told(wire::home_event::Kind::OutcomeTold(
                    wire::home_event::OutcomeTold {
                        status_line: sentence,
                        rename_failed: false,
                    },
                )),
            );
        }
    }

    /// The line under the vault's name, from the backup lane's reading of the
    /// vault in front. A vault that could not be asked draws no line.
    fn backup_line(ctx: &Ctx, none: bool) -> Option<wire::HomeBackupLine> {
        if none {
            return None;
        }
        let Reading::Data(standing) = reading::load(ctx) else {
            return None;
        };
        let line = line::line(
            ctx.locale(),
            Some(&standing.reading),
            standing.reading.frozen,
            standing.now_ms,
        );
        (!line.status.is_empty()).then_some(wire::HomeBackupLine {
            status: line.status,
            tone: line.tone,
            accessibility_label: line.accessibility_label,
        })
    }

    fn outcome(ctx: &Ctx, sentence: &str, rename_failed: bool) {
        ctx.tell_screen(
            HOME,
            Self::told(wire::home_event::Kind::OutcomeTold(
                wire::home_event::OutcomeTold {
                    status_line: sentence.to_owned(),
                    rename_failed,
                },
            )),
        );
    }

    // ---- what Home asks ------------------------------------------------------

    fn open(route: wire::Route) -> wire::Effect {
        wire::Effect {
            kind: Some(wire::effect::Kind::OpenRoute(wire::OpenRoute {
                route: Some(route),
            })),
        }
    }

    fn commanded(&mut self, command: wire::VaultCommand, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::vault_command::Kind as C;
        match command.kind {
            // THE VAULT IN FRONT CHANGES at the end of this call, and the tabs
            // follow it (`Runtime::follow_foreground`).
            Some(C::SwitchTo(vault_id)) => {
                ctx.switch_vault(&vault_id);
                Vec::new()
            }
            // MAKING AND RESTORING ARE THE WORDS' PAGES, pushed where the member is.
            Some(C::Make(true)) => vec![Self::open(crate::custody::routes::make())],
            Some(C::Restore(true)) => vec![Self::open(crate::custody::routes::restore())],
            Some(C::Forget(vault_id)) => {
                let forgotten = self.shelf.forget(&vault_id);
                Self::outcome(ctx, "", false);
                self.send(forgotten.writes, Then::Nothing)
            }
            Some(C::Rename(rename)) => {
                let renamed = self.shelf.rename(&rename.vault_id, &rename.name);
                Self::outcome(ctx, "", !renamed);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }
}

impl Screen for Service {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => self.begin(),
            Some(E::EffectResult(result)) => {
                let Some(wire::effect_result::Outcome::Secrets(batched)) = result.outcome else {
                    return Vec::new();
                };
                self.answered(&batched)
            }
            Some(E::ScreenOpened(opened)) => {
                if opened.screen == HOME {
                    self.tell_home(ctx);
                }
                Vec::new()
            }
            Some(E::DataChanged(changed)) => {
                if changed
                    .tables
                    .iter()
                    .any(|table| table == centraid_core::vaults::SHELF_TABLE)
                {
                    self.tell_home(ctx);
                }
                Vec::new()
            }
            Some(E::Signalled(signalled)) => {
                if signalled.topic == PASSES && self.launch == Launch::Ready {
                    self.tell_home(ctx);
                }
                Vec::new()
            }
            Some(E::VaultCommanded(command)) => self.commanded(command, ctx),
            Some(E::MemoryWarning(_)) => {
                if self.launch == Launch::Ready {
                    self.shelf.rest();
                }
                Vec::new()
            }
            Some(E::Lifecycle(lifecycle)) if self.launch == Launch::Ready => {
                if lifecycle.foreground {
                    return Vec::new();
                }
                let owed = self.shelf.settle();
                self.send(owed, Then::Nothing)
            }
            _ => Vec::new(),
        }
    }

    fn hears(&self, topic: &str) -> bool {
        topic == PASSES
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}
