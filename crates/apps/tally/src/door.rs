//! THE REAL DOOR: [`Commands`] over the vault's own `execute` (#1020,
//! D-1020-T3d).
//!
//! Wave 2 left `Commands` as a trait with an in-memory implementation, because
//! `crates/vault/src/commands/tally.rs` was a registry of skeletons and there
//! was nothing to invoke. Now there is, and this is the adapter.
//!
//! ## Why it is behind a feature
//!
//! An app crate that always linked the vault would undo the compile-time
//! argument for one crate per app (#1020, Tooling coverage): editing Tally
//! would rebuild the vault and everything under it. So `centraid-vault` is an
//! OPTIONAL dependency and this module is behind `vault-door`. The app's own
//! build — the one a surface and the unit tests use — carries the trait and the
//! in-memory implementation and nothing else; the seat, which holds the file
//! anyway, turns the feature on.
//!
//! ## What the mapping is careful about
//!
//! - **A denial is a value** (`Outcome::Denied`), never an `Err`. `Err` is
//!   reserved for a door that is not there at all — v0's `VAULT_UNAVAILABLE`,
//!   which fails closed.
//! - **A refusal is `Failed`, with the SENTENCE the condition wrote.** The raw
//!   predicate stays in the audit trail; what reaches the surface is the
//!   owner-facing sentence.
//! - **`invoke_key` is the intent id** (D-1020-D3-5). It is mandatory on an
//!   [`Invocation`], so the vault's replay ledger is keyed on something stable
//!   rather than on the ordinal of the call — a replayed intent whose handler
//!   branched differently would otherwise re-execute a committed command under
//!   another call's key.

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Vault, VaultError};

use crate::commands::{Commands, CommandsUnavailable, Invocation, Outcome};

/// The vault, the registry it serves and who is asking.
pub struct VaultDoor<'a> {
    vault: &'a Vault,
    registry: &'a Registry,
    principal: Principal,
    /// The device an intent belongs to, for the replay ledger's bookkeeping.
    /// `None` means a call that is not an outbox delivery.
    device_id: Option<String>,
}

impl<'a> VaultDoor<'a> {
    #[must_use]
    pub const fn new(vault: &'a Vault, registry: &'a Registry, principal: Principal) -> Self {
        Self {
            vault,
            registry,
            principal,
            device_id: None,
        }
    }

    /// The same door, delivering a seat's queued intents: every invocation is
    /// recorded under its `invoke_key`, so a duplicate delivery is answered
    /// from the ledger instead of running twice.
    #[must_use]
    pub fn for_device(mut self, device_id: impl Into<String>) -> Self {
        self.device_id = Some(device_id.into());
        self
    }
}

impl Commands for VaultDoor<'_> {
    fn invoke(&self, invocation: &Invocation) -> Result<Outcome, CommandsUnavailable> {
        let input = serde_json::Value::Object(
            invocation
                .input
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        );
        let mut command = Command::new(invocation.command, input);
        if let Some(device_id) = &self.device_id {
            command = command.with_intent(invocation.invoke_key.clone(), device_id.clone());
        }
        match self.vault.execute(self.registry, &self.principal, &command) {
            Ok(outcome) => Ok(match outcome.status {
                CommandStatus::Executed => Outcome::Executed {
                    output: outcome.output,
                },
                CommandStatus::Failed => {
                    // THE AUTHORITY STAGE IS THE ONE DENIAL. Every other
                    // failure is the command's own refusal, and a surface
                    // renders the two differently: a denial is a consent state
                    // the member can grant, a refusal is a fact about the
                    // ledger.
                    if outcome.predicate.as_deref() == Some("authority") {
                        Outcome::Denied {
                            reason: outcome.reason,
                            code: Some("vault_denied".to_owned()),
                        }
                    } else {
                        Outcome::Failed {
                            reason: outcome.reason,
                        }
                    }
                }
            }),
            // A command this build does not carry is not an absent door: the
            // door answered, and what it said is that the command has no body
            // here. The sentence travels so a shell can say which plane is
            // missing rather than "something went wrong".
            Err(VaultError::NotImplemented { name }) => Ok(Outcome::Failed { reason: Some(name) }),
            Err(VaultError::InvalidInput { name, detail }) => Ok(Outcome::Failed {
                reason: Some(format!("{name}: {detail}")),
            }),
            Err(VaultError::UnknownCommand { .. }) => Err(CommandsUnavailable {
                command: invocation.command,
            }),
            Err(other) => Ok(Outcome::Failed {
                reason: Some(other.to_string()),
            }),
        }
    }
}
