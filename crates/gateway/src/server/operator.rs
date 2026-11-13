//! THE OPERATOR'S VERBS, AS THE CLI RUNS THEM (#1191, E6, E14).
//!
//! `centraid-gateway vault <id8> <verb> --data-dir DIR`: the person at the
//! gateway machine has the last word. The verbs are local and unsigned, and
//! every one goes through the same [`crate::rules::engine::Gateway`] a phone's
//! request does, so the rules stay the only decision-maker. What is here
//! resolves the vault the member typed, asks the rules, and says **counts
//! only**: a blind gateway prints no name.

use crate::rules::engine::Operated;
use crate::rules::ids::VaultId;
use crate::rules::state::Fault;
use crate::server::Shared;
use crate::server::report::utc;
use crate::server::sweeps::{Finished, purge_once};

/// What the operator asked of a vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    /// Refuse every state-changing route and skip the vault in the purge.
    Freeze,
    /// Lift the freeze, adding the time it lasted to every hold.
    Unfreeze,
    /// Lift every hold, no signature.
    Undo,
    /// Make every hold due and run the purge once. Needs `--yes`.
    PurgeNow,
    /// Remove a frozen vault and everything of it. Needs `--yes`.
    DeleteVault,
}

impl Verb {
    /// The word the CLI spells it with.
    #[must_use]
    pub const fn word(self) -> &'static str {
        match self {
            Self::Freeze => "freeze",
            Self::Unfreeze => "unfreeze",
            Self::Undo => "undo",
            Self::PurgeNow => "purge-now",
            Self::DeleteVault => "delete-vault",
        }
    }
}

/// Why a verb did nothing: a sentence for the terminal.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct Refused(pub String);

impl From<Fault> for Refused {
    fn from(fault: Fault) -> Self {
        Self(format!("the gateway's store failed: {fault}"))
    }
}

/// The vault whose id starts with `id8`, the first 8 hex that `pairings`
/// prints; refused when it names none or more than one.
///
/// # Errors
///
/// [`Refused`] with the sentence to print.
pub fn resolve(shared: &Shared, id8: &str) -> Result<VaultId, Refused> {
    let id = id8.trim().trim_end_matches('…').to_ascii_lowercase();
    if id.len() < 8 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(Refused(
            "a vault is named by the first 8 hex characters `pairings` prints".to_owned(),
        ));
    }
    let pairings = shared.rules(|gateway| gateway.pairings())?;
    let matches: Vec<VaultId> = pairings
        .iter()
        .map(|pairing| pairing.vault.vault)
        .filter(|vault| vault.hex().starts_with(&id))
        .collect();
    match matches.as_slice() {
        [vault] => Ok(*vault),
        other => Err(Refused(format!(
            "{} vaults start with {id}; `pairings` lists each vault's id",
            other.len()
        ))),
    }
}

/// Run `verb` on `vault`. Answers the lines to print.
///
/// # Errors
///
/// [`Refused`] for a verb the vault's state, or a missing `--yes`, forbids.
pub fn run(
    shared: &Shared,
    vault: &VaultId,
    verb: Verb,
    yes: bool,
) -> Result<Vec<String>, Refused> {
    let now = shared.now();
    let short = crate::server::report::short(vault);
    match verb {
        Verb::Freeze => {
            expect(shared.rules(|gateway| gateway.freeze(vault, now))?)?;
            Ok(vec![format!(
                "frozen    vault {short}: every write is refused and nothing is purged until `unfreeze`"
            )])
        }
        Verb::Unfreeze => {
            let lasted = expect(shared.rules(|gateway| gateway.unfreeze(vault, now))?)?;
            Ok(vec![format!(
                "unfrozen  vault {short}: it was frozen {} minutes; every hold gained that time",
                lasted / 60_000
            )])
        }
        Verb::Undo => {
            let lifted = expect(shared.rules(|gateway| gateway.operator_undo(vault))?)?;
            Ok(vec![format!(
                "undone    vault {short}: {lifted} holds lifted"
            )])
        }
        Verb::PurgeNow => {
            if !yes {
                return Err(Refused(
                    "purge-now makes every held delete of the vault final; run it again with --yes"
                        .to_owned(),
                ));
            }
            let due = expect(shared.rules(|gateway| gateway.purge_now(vault, now))?)?;
            let purged = purge_once(shared, now)?;
            Ok(vec![format!(
                "purged    vault {short}: {due} holds made due, {purged} objects purged"
            )])
        }
        Verb::DeleteVault => {
            if !yes {
                return Err(Refused(
                    "delete-vault removes the vault and every object of it for good; run it again with --yes"
                        .to_owned(),
                ));
            }
            let store = shared.store();
            let deleted =
                expect(shared.rules(|gateway| {
                    gateway.delete_vault(vault, |name| store.remove(vault, name))
                })?)?;
            Ok(vec![format!(
                "deleted   vault {short}: {} objects and {} tokens removed",
                deleted.objects, deleted.tokens
            )])
        }
    }
}

/// Run the purge the way `serve`'s sweep does, recording when it finished.
///
/// # Errors
///
/// A store fault, or the sweeps file.
pub fn sweep(shared: &Shared) -> Result<u64, Fault> {
    let now = shared.now();
    let finished = Finished::load_or_start(shared.data_dir(), now)
        .map_err(|error| crate::rules::state::StoreFault::new(error.to_string()))?;
    let purged = purge_once(shared, finished.purge_ms)?;
    Finished {
        purge_ms: shared.now(),
        ..finished
    }
    .save(shared.data_dir())
    .map_err(|error| crate::rules::state::StoreFault::new(error.to_string()))?;
    Ok(purged)
}

fn expect<T>(operated: Operated<T>) -> Result<T, Refused> {
    match operated {
        Operated::Done(value) => Ok(value),
        Operated::NoSuchVault => Err(Refused("no such vault".to_owned())),
        Operated::Frozen { since_ms } => Err(Refused(format!(
            "the vault has been frozen since {}; `unfreeze` it first",
            utc(since_ms)
        ))),
        Operated::NotFrozen => Err(Refused(
            "the vault is not frozen; `freeze` it first".to_owned(),
        )),
    }
}
