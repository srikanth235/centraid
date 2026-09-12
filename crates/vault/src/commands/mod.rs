//! The typed command catalogue: definitions, the registry, the gate order.
//!
//! ## What a command is
//!
//! A [`CommandDefinition`] is a name, an owner schema, a JSON schema for its
//! input, an idempotency class, a risk label, its pre- and postconditions, and
//! a handler. **Risk is salience only, not an approval trigger**: a `high` risk
//! does not park a command, and `confirm` is what does — plus the rule that a
//! NON-OWNER invocation parks regardless of risk.
//!
//! ## The gate order, and each gate's reason
//!
//! 1. **Ontology version equality.** Not "at least": there is ONE served
//!    ontology version, so a mismatch is a stale REGISTRATION rather than an
//!    old client, and treating it as a compatibility range would let a command
//!    registered against a schema that has moved keep running (#310).
//! 2. **Input-schema validation**, with every error run through the sealed
//!    scrub before it reaches a journal, a receipt or a response. A validation
//!    message quotes the value that failed, which for a sealed field is the
//!    secret.
//! 3. **The LIVE definition is what runs.** `preconditions_json` in
//!    `agent_command` is the registry's *record*; a predicate does not survive
//!    `JSON.stringify`, so the row cannot be the thing that executes.
//! 4. **Preconditions**, every result written as a `pre` check row, then the
//!    first failure denies with the author's SENTENCE while the raw predicate
//!    still reaches the audit trail.
//! 5. `checked`.
//! 6. **The handler, inside the commit guard** — so its writes are captured.
//! 7. **Postconditions**, written as `post` check rows.
//! 8. **The receipt.** A deny is receipted too.
//!
//! ## Replay idempotency
//!
//! An invocation carrying an `intent_id` is looked up in
//! `replica_intent_outcome` under `(vault_id, intent_id, payload_hash)` first.
//! A duplicate delivery therefore **executes once** and the second delivery is
//! answered from the ledger.

pub mod core;
pub mod enrich;
pub mod locker;
pub mod media;
pub mod tally;

use std::collections::BTreeMap;

use rusqlite::Connection;

use crate::access::{Decision, Principal, Verb, evaluate_access};
use crate::audit::{self, Check, Invocation, Receipt};
use crate::clock::Ids;
use crate::error::{Result, VaultError};
use crate::file::Vault;
use crate::intents::{self, IntentPayload};
use crate::log::{CommitTx, ProducedRow};

/// The one served ontology version. Equality, on purpose.
pub const ONTOLOGY_VERSION: &str = "1.0";

/// How safe a command is to run again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Idempotency {
    /// Running it twice lands the same state.
    Idempotent,
    /// It must run exactly once; a retry is answered from the ledger.
    Once,
    /// It may be retried freely because it writes nothing a second run would
    /// duplicate — a recompute, a probe.
    RetrySafe,
}

impl Idempotency {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idempotent => "idempotent",
            Self::Once => "once",
            Self::RetrySafe => "retry-safe",
        }
    }
}

/// How loudly a command is presented. **Salience only.**
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Risk {
    Low,
    Medium,
    High,
}

impl Risk {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

/// What a handler is handed.
pub struct CommandCtx<'tx, 'conn> {
    tx: &'tx CommitTx<'tx, 'conn>,
    /// The command being run, so a handler's own error can name itself.
    pub command: &'static str,
    pub input: serde_json::Value,
    pub principal: Principal,
    pub now: String,
    pub invocation_id: String,
    ids: &'tx dyn Ids,
    clock: &'tx dyn crate::clock::Clock,
    produced_ids: std::cell::RefCell<Vec<String>>,
}

impl<'conn> CommandCtx<'_, 'conn> {
    /// The connection this command writes through — the guard's, so every
    /// write is captured.
    #[must_use]
    pub const fn connection(&self) -> &'conn Connection {
        self.tx.connection()
    }

    /// A fresh id.
    pub fn next_id(&self) -> String {
        let id = self.ids.next();
        self.produced_ids.borrow_mut().push(id.clone());
        id
    }

    /// Append a SUBJECT-BEARING receipt beside the command's own.
    ///
    /// Gate 8 already writes one receipt per invocation, under
    /// `object_type: "agent.command"`. That answers *which command ran*; it
    /// does not answer *which row was opened*, and the two are different
    /// audit questions — Locker's access history reads `object_type IN
    /// ('locker.item', 'locker.auth')` and would never see a command receipt
    /// (`packages/blueprints/apps/locker/queries/access.ts`).
    ///
    /// So a command whose subject is a row, not itself, appends a second
    /// receipt naming that row. It goes through the same chained writer — same
    /// `seq`, same hash chain, same append-only triggers — because a reveal
    /// receipt that a member could remove is not a receipt
    /// (#1020, D-1020-L3).
    pub fn write_subject_receipt(
        &self,
        action: &str,
        object_type: &str,
        object_id: Option<&str>,
        decision: &str,
        detail: serde_json::Value,
    ) -> Result<String> {
        audit::write_receipt(
            self.connection(),
            self.clock,
            self.ids,
            &Receipt {
                authority_id: None,
                invocation_id: &self.invocation_id,
                action,
                object_type,
                object_id,
                decision,
                detail,
            },
        )
    }

    /// A required string input.
    pub fn required_str(&self, key: &str) -> Result<&str> {
        self.input
            .get(key)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| VaultError::InvalidInput {
                name: key.to_owned(),
                detail: "a required string is missing".to_owned(),
            })
    }

    /// An optional string input.
    #[must_use]
    pub fn optional_str(&self, key: &str) -> Option<&str> {
        self.input.get(key).and_then(serde_json::Value::as_str)
    }
}

/// A handler's body.
pub type CommandHandler = fn(&CommandCtx<'_, '_>) -> Result<serde_json::Value>;

/// One condition, and the SENTENCE it says when it does not hold.
///
/// A condition returns `None` when it holds and an owner-facing sentence when
/// it does not — never a boolean. The sentence is the thing a member reads, and
/// a boolean forces the caller to invent one.
pub struct CommandCondition {
    /// The raw predicate, for the audit trail. The owner never sees it.
    pub predicate: &'static str,
    pub check: fn(&CommandCtx<'_, '_>) -> Result<Option<String>>,
}

/// A registered command.
pub struct CommandDefinition {
    pub name: &'static str,
    pub owner_schema: &'static str,
    /// A JSON Schema, as text, compiled once at registration.
    pub input_schema: &'static str,
    pub idempotency: Idempotency,
    pub risk: Risk,
    /// A non-owner invocation parks regardless of risk; this is the owner-facing
    /// confirmation on top of that.
    pub confirm: bool,
    pub preconditions: &'static [CommandCondition],
    pub postconditions: &'static [CommandCondition],
    pub handler: CommandHandler,
    /// Input keys whose values are secrets: tokenised before the journal.
    pub sealed_input: &'static [&'static str],
    /// A seat refuses to QUEUE this offline, with a typed reason the shell
    /// renders — a Locker reveal, an assistant turn, an export.
    pub online_only: bool,
}

/// A command plus its compiled validator.
pub struct Registered {
    pub definition: CommandDefinition,
    validator: jsonschema::Validator,
    schema: serde_json::Value,
}

impl Registered {
    #[must_use]
    pub const fn schema(&self) -> &serde_json::Value {
        &self.schema
    }
}

/// The catalogue.
#[derive(Default)]
pub struct Registry {
    commands: BTreeMap<String, Registered>,
}

impl Registry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The registry the gateway serves: every command this build carries.
    pub fn with_system_commands() -> Result<Self> {
        let mut registry = Self::new();
        for definition in core::definitions() {
            registry.register(definition)?;
        }
        for definition in enrich::definitions() {
            registry.register(definition)?;
        }
        for definition in locker::definitions() {
            registry.register(definition)?;
        }
        for definition in media::definitions() {
            registry.register(definition)?;
        }
        for definition in tally::definitions() {
            registry.register(definition)?;
        }
        Ok(registry)
    }

    /// Register one command, compiling its schema.
    ///
    /// A duplicate name is refused rather than overwritten: two definitions
    /// under one name means whichever registered last runs, which is the kind
    /// of ordering dependency nobody finds.
    pub fn register(&mut self, definition: CommandDefinition) -> Result<()> {
        if self.commands.contains_key(definition.name) {
            return Err(VaultError::Invariant {
                context: format!("`{}` is registered twice", definition.name),
            });
        }
        if !definition
            .name
            .starts_with(&format!("{}.", definition.owner_schema))
        {
            return Err(VaultError::Invariant {
                context: format!(
                    "`{}` is owned by `{}` and must be named `{}.…`",
                    definition.name, definition.owner_schema, definition.owner_schema
                ),
            });
        }
        let schema: serde_json::Value =
            serde_json::from_str(definition.input_schema).map_err(|source| VaultError::Json {
                context: format!("`{}`'s input schema is not JSON", definition.name),
                source,
            })?;
        let validator =
            jsonschema::validator_for(&schema).map_err(|error| VaultError::Invariant {
                context: format!("`{}`'s input schema is not valid: {error}", definition.name),
            })?;
        self.commands.insert(
            definition.name.to_owned(),
            Registered {
                definition,
                validator,
                schema,
            },
        );
        Ok(())
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&Registered> {
        self.commands.get(name)
    }

    #[must_use]
    pub fn names(&self) -> Vec<&str> {
        self.commands.keys().map(String::as_str).collect()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.commands.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }

    /// Write the registry's RECORD into `agent_command`.
    ///
    /// The record, not the definition: a predicate is a function and does not
    /// serialise, so these rows say what is registered and the Rust definition
    /// says what runs. The `ontology_version` column is what gate one compares.
    pub fn install(&self, vault: &Vault) -> Result<()> {
        let outcome = vault.commit(|tx| {
            tx.set_producer("registry.install");
            for (name, entry) in &self.commands {
                let definition = &entry.definition;
                tx.connection().execute(
                    "INSERT INTO agent_command
                       (command_id, name, owner_schema, input_schema_json, output_schema_json,
                        preconditions_json, postconditions_json, idempotency, risk, ontology_version)
                     VALUES (?1, ?2, ?3, ?4, '{}', ?5, ?6, ?7, ?8, ?9)
                     ON CONFLICT (command_id) DO UPDATE SET
                       input_schema_json = excluded.input_schema_json,
                       preconditions_json = excluded.preconditions_json,
                       postconditions_json = excluded.postconditions_json,
                       idempotency = excluded.idempotency,
                       risk = excluded.risk,
                       ontology_version = excluded.ontology_version",
                    rusqlite::params![
                        name,
                        name,
                        definition.owner_schema,
                        definition.input_schema,
                        predicate_names(definition.preconditions),
                        predicate_names(definition.postconditions),
                        definition.idempotency.as_str(),
                        definition.risk.as_str(),
                        ONTOLOGY_VERSION,
                    ],
                )?;
            }
            Ok(())
        })?;
        drop(outcome);
        Ok(())
    }
}

fn predicate_names(conditions: &[CommandCondition]) -> String {
    let names: Vec<&str> = conditions
        .iter()
        .map(|condition| condition.predicate)
        .collect();
    serde_json::to_string(&names).unwrap_or_else(|_| "[]".to_owned())
}

/// What a caller asks for.
#[derive(Debug, Clone)]
pub struct Command {
    pub name: String,
    pub input: serde_json::Value,
    /// The seat's idempotency key, when the call came from an outbox.
    pub intent_id: Option<String>,
    /// The device that owns the intent, for the ledger's own bookkeeping.
    pub device_id: Option<String>,
}

impl Command {
    #[must_use]
    pub fn new(name: impl Into<String>, input: serde_json::Value) -> Self {
        Self {
            name: name.into(),
            input,
            intent_id: None,
            device_id: None,
        }
    }

    /// The same command, carrying a seat's intent id.
    #[must_use]
    pub fn with_intent(
        mut self,
        intent_id: impl Into<String>,
        device_id: impl Into<String>,
    ) -> Self {
        self.intent_id = Some(intent_id.into());
        self.device_id = Some(device_id.into());
        self
    }
}

/// How a command ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandStatus {
    Executed,
    Failed,
}

/// What running a command produced.
#[derive(Debug, Clone)]
pub struct CommandOutcome {
    pub status: CommandStatus,
    pub invocation_id: String,
    pub receipt_id: String,
    pub commit_seq: Option<i64>,
    pub produced: Vec<ProducedRow>,
    pub output: serde_json::Value,
    /// The owner-facing sentence, on a failure.
    pub reason: Option<String>,
    /// The raw predicate that failed, for the audit trail.
    pub predicate: Option<String>,
    /// This answer came from the ledger; the handler did not run again.
    pub replayed: bool,
}

impl Vault {
    /// Run a command through the gate order.
    pub fn execute(
        &self,
        registry: &Registry,
        principal: &Principal,
        command: &Command,
    ) -> Result<CommandOutcome> {
        // Gate 3, first in the code because it is what the rest is about: the
        // LIVE definition.
        let entry = registry
            .get(&command.name)
            .ok_or_else(|| VaultError::UnknownCommand {
                name: command.name.clone(),
            })?;
        let definition = &entry.definition;

        // Gate 1. Read from the registry's own record, so a stale row is what
        // is caught — comparing the constant against itself would prove
        // nothing.
        let registered: Option<String> = self.read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT ontology_version FROM agent_command WHERE name = ?1",
                    [&command.name],
                    |row| row.get(0),
                )
                .ok())
        })?;
        if let Some(registered) = registered
            && registered != ONTOLOGY_VERSION
        {
            return Err(VaultError::OntologyVersionMismatch {
                name: command.name.clone(),
                registered,
                served: ONTOLOGY_VERSION.to_owned(),
            });
        }

        // REPLAY IDEMPOTENCY, before the handler and before the journal: a
        // duplicate delivery must not even write a second invocation row.
        let claim = IntentPayload {
            app_id: definition.owner_schema.to_owned(),
            action: command.name.clone(),
            input: command.input.clone(),
            base_versions: Vec::new(),
            depends_on: Vec::new(),
        };
        let payload_hash = claim.hash()?;
        if let Some(intent_id) = command.intent_id.as_deref() {
            let existing = self.read(|connection| intents::read_outcome(connection, intent_id))?;
            if let Some(existing) = existing {
                if intents::is_expired(&existing, self.clock().now_ms()) {
                    return Err(VaultError::IntentRefused {
                        refusal: crate::error::IntentRefusal::OutcomeExpired,
                        detail: format!("intent `{intent_id}` is past its 30-day window"),
                    });
                }
                intents::assert_identity(&existing, &claim, &payload_hash, "executed")?;
                if existing.is_terminal() {
                    // ANSWERED FROM THE LEDGER. The handler does not run, and
                    // that is the whole point of the ledger.
                    return Ok(CommandOutcome {
                        status: CommandStatus::Executed,
                        invocation_id: existing.invocation_id.clone().unwrap_or_default(),
                        receipt_id: String::new(),
                        commit_seq: existing.commit_seq,
                        produced: Vec::new(),
                        output: serde_json::Value::Null,
                        reason: None,
                        predicate: None,
                        replayed: true,
                    });
                }
            }
        }

        // Gate 2. Validation, with the scrub on every message.
        let invalid: Vec<String> = entry
            .validator
            .iter_errors(&command.input)
            .map(|error| {
                audit::scrub_sealed(
                    &format!("{}: {error}", error.instance_path),
                    definition.sealed_input,
                    &command.input,
                )
            })
            .collect();

        let invocation_id = self.ids().next();
        let decision = self.read(|connection| {
            evaluate_access(
                connection,
                principal,
                definition.owner_schema,
                // A command acts on its schema as a whole; the per-table
                // narrowing is the handler's reads, through the paged door.
                "command",
                Verb::Act,
            )
        })?;

        let result = self.commit(|tx| {
            tx.set_producer(&command.name);
            let connection = tx.connection();
            audit::insert_invocation(
                connection,
                self.clock(),
                &Invocation {
                    invocation_id: &invocation_id,
                    command_id: &command.name,
                    caller_id: principal.caller_id(),
                    authority_id: match &decision {
                        Decision::Allow { authority_id, .. }
                        | Decision::Deny { authority_id, .. } => authority_id.as_deref(),
                    },
                    input: &command.input,
                    sealed_keys: definition.sealed_input,
                },
            )?;
            audit::assert_invocation_identity(
                connection,
                &invocation_id,
                &command.name,
                principal.caller_id(),
            )?;

            // Authority, before anything else is written.
            if let Decision::Deny { failing, .. } = &decision {
                return deny(
                    self,
                    tx,
                    definition,
                    &invocation_id,
                    failing,
                    "authority",
                    &decision,
                );
            }
            if !invalid.is_empty() {
                return deny(
                    self,
                    tx,
                    definition,
                    &invocation_id,
                    &invalid.join("; "),
                    "schema",
                    &decision,
                );
            }

            let ctx = CommandCtx {
                tx,
                command: definition.name,
                input: command.input.clone(),
                principal: principal.clone(),
                now: self.clock().now_text(),
                invocation_id: invocation_id.clone(),
                ids: self.ids(),
                clock: self.clock(),
                produced_ids: std::cell::RefCell::new(Vec::new()),
            };

            // Gate 4. EVERY precondition's result is written, then the first
            // failure denies.
            let mut first_failure: Option<(&'static str, String)> = None;
            for condition in definition.preconditions {
                let outcome = (condition.check)(&ctx)?;
                audit::write_check(
                    connection,
                    self.clock(),
                    self.ids(),
                    &Check {
                        invocation_id: &invocation_id,
                        phase: "pre",
                        predicate: condition.predicate,
                        passed: outcome.is_none(),
                        observed: None,
                    },
                )?;
                if first_failure.is_none()
                    && let Some(sentence) = outcome
                {
                    first_failure = Some((condition.predicate, sentence));
                }
            }
            if let Some((predicate, sentence)) = first_failure {
                return deny(
                    self,
                    tx,
                    definition,
                    &invocation_id,
                    &sentence,
                    predicate,
                    &decision,
                );
            }

            // Gate 5.
            audit::set_invocation_status(connection, self.clock(), &invocation_id, "checked")?;

            // Gate 6. Inside the guard, so the writes are captured.
            let output = (definition.handler)(&ctx)?;

            // Gate 7.
            for condition in definition.postconditions {
                let outcome = (condition.check)(&ctx)?;
                audit::write_check(
                    connection,
                    self.clock(),
                    self.ids(),
                    &Check {
                        invocation_id: &invocation_id,
                        phase: "post",
                        predicate: condition.predicate,
                        passed: outcome.is_none(),
                        observed: None,
                    },
                )?;
                if let Some(sentence) = outcome {
                    // A FAILED POSTCONDITION ROLLS THE WHOLE COMMIT BACK. The
                    // handler's writes are not "mostly right"; either the
                    // command's own statement about what it did holds, or the
                    // command did not happen.
                    return Err(VaultError::Invariant {
                        context: format!(
                            "`{}` broke its own postcondition `{}`: {sentence}",
                            definition.name, condition.predicate
                        ),
                    });
                }
            }

            audit::set_invocation_status(connection, self.clock(), &invocation_id, "executed")?;
            // Gate 8.
            let receipt_id = audit::write_receipt(
                connection,
                self.clock(),
                self.ids(),
                &Receipt {
                    authority_id: match &decision {
                        Decision::Allow { authority_id, .. } => authority_id.as_deref(),
                        Decision::Deny { .. } => None,
                    },
                    invocation_id: &invocation_id,
                    action: &format!("act {}", definition.name),
                    object_type: "agent.command",
                    object_id: Some(definition.name),
                    decision: "allow",
                    detail: serde_json::json!({
                        "risk": definition.risk.as_str(),
                        "idempotency": definition.idempotency.as_str(),
                    }),
                },
            )?;
            Ok((CommandStatus::Executed, receipt_id, output, None, None))
        })?;

        let (status, receipt_id, output, reason, predicate) = result.value;

        if let (Some(intent_id), Some(device_id)) =
            (command.intent_id.as_deref(), command.device_id.as_deref())
        {
            // The ledger row is written OUTSIDE the command's own commit on
            // purpose: `replica_intent_outcome` is a LOCAL table, so its rows
            // are logged for the doorbell and never served, and writing it
            // inside would make the command's commit carry a local row whose
            // presence a seat cannot see anyway.
            let outcome_status = if status == CommandStatus::Executed {
                "executed"
            } else {
                "failed"
            };
            self.commit(|tx| {
                tx.set_producer("intents.record");
                intents::record_outcome(
                    tx.connection(),
                    self.clock(),
                    &intents::OutcomeRecord {
                        intent_id,
                        device_id,
                        claim: &claim,
                        payload_hash: &payload_hash,
                        status: outcome_status,
                        invocation_id: Some(&invocation_id),
                        commit_seq: result.commit_seq,
                    },
                )
            })?;
        }

        Ok(CommandOutcome {
            status,
            invocation_id,
            receipt_id,
            commit_seq: result.commit_seq,
            produced: result.produced,
            output,
            reason,
            predicate,
            replayed: false,
        })
    }
}

/// The deny path: four things, every time.
type DenyOutcome = (
    CommandStatus,
    String,
    serde_json::Value,
    Option<String>,
    Option<String>,
);

fn deny(
    vault: &Vault,
    tx: &CommitTx<'_, '_>,
    definition: &CommandDefinition,
    invocation_id: &str,
    sentence: &str,
    predicate: &str,
    decision: &Decision,
) -> Result<DenyOutcome> {
    let connection = tx.connection();
    audit::set_invocation_status(connection, vault.clock(), invocation_id, "failed")?;
    let receipt_id = audit::write_receipt(
        connection,
        vault.clock(),
        vault.ids(),
        &Receipt {
            authority_id: match decision {
                Decision::Allow { authority_id, .. } | Decision::Deny { authority_id, .. } => {
                    authority_id.as_deref()
                }
            },
            invocation_id,
            action: &format!("act {}", definition.name),
            object_type: "agent.command",
            object_id: Some(definition.name),
            decision: "deny",
            detail: serde_json::json!({
                "risk": definition.risk.as_str(),
                "stage": predicate,
            }),
        },
    )?;
    audit::write_explanation(
        connection,
        vault.clock(),
        vault.ids(),
        invocation_id,
        sentence,
    )?;
    Ok((
        CommandStatus::Failed,
        receipt_id,
        serde_json::Value::Null,
        Some(sentence.to_owned()),
        Some(predicate.to_owned()),
    ))
}

/// The handler every stub carries.
///
/// A TYPED error, not a panic: a shell renders "not in this build yet" and the
/// process survives. And it is reached only AFTER the gate order has run, so a
/// stub still validates its input, writes its invocation row and receipts the
/// refusal — which is what makes the registry useful before the bodies land.
pub fn not_implemented(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    Err(VaultError::NotImplemented {
        name: ctx.command.to_owned(),
    })
}
