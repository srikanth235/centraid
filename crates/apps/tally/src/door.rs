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
//! - **`invoke_key` is the caller's correlation key** (D-1020-D3-5). It is
//!   mandatory on an [`Invocation`], so a caller pairs an answer with the call
//!   that caused it on something stable rather than on the ordinal of the call.
//!   **The vault never sees it**: `Vault::execute` takes a name and an input,
//!   and no replay ledger answers a second delivery (#1029 §1, R-1088-12), so
//!   the same key delivered twice runs twice. A caller that may re-offer a
//!   write makes it idempotent by its own content or an id it minted first.

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Vault, VaultError};

use crate::commands::{Commands, CommandsUnavailable, Invocation, Outcome};

/// The vault, the registry it serves and who is asking.
pub struct VaultDoor<'a> {
    vault: &'a Vault,
    registry: &'a Registry,
    principal: Principal,
}

impl<'a> VaultDoor<'a> {
    #[must_use]
    pub const fn new(vault: &'a Vault, registry: &'a Registry, principal: Principal) -> Self {
        Self {
            vault,
            registry,
            principal,
        }
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
        let command = Command::new(invocation.command, input);
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
