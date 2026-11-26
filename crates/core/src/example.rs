//! ONE COMMAND, RUN AND REPORTED: the door the starter rows ([`crate::starters`]) write through.
//!
//! A refusal is loud and the pass continues: a refused starter is a warning, never a failure.

use std::collections::BTreeSet;

use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::{Principal, Vault};
use serde_json::Value;

/// What a seeding pass did not do.
#[derive(Debug, Default)]
pub struct Report {
    /// `"<command>: <reason>"`, one per refused command.
    pub refused: Vec<String>,
    /// Commands that are registered and have no body yet, named once each.
    pub gaps: BTreeSet<String>,
}

impl Report {
    /// Every command ran and every one was executed.
    #[must_use]
    pub fn is_whole(&self) -> bool {
        self.refused.is_empty() && self.gaps.is_empty()
    }
}

/// One command, run and reported.
pub(crate) struct Seeder<'a> {
    pub(crate) vault: &'a Vault,
    pub(crate) registry: &'a Registry,
    pub(crate) principal: &'a Principal,
    pub(crate) report: Report,
}

impl Seeder<'_> {
    pub(crate) fn run(&mut self, name: &'static str, body: Value) -> Option<Value> {
        match self
            .vault
            .execute(self.registry, self.principal, &Command::new(name, body))
        {
            Ok(outcome) if outcome.status == CommandStatus::Executed => Some(outcome.output),
            Ok(outcome) => {
                let why = outcome.reason.unwrap_or_else(|| "no reason".to_owned());
                tracing::warn!(command = name, %why, "a starter command was refused");
                self.report.refused.push(format!("{name}: {why}"));
                None
            }
            Err(centraid_vault::VaultError::NotImplemented { name }) => {
                self.report.gaps.insert(name);
                None
            }
            Err(error) => {
                tracing::warn!(command = name, %error, "a starter command errored");
                self.report.refused.push(format!("{name}: {error}"));
                None
            }
        }
    }
}
