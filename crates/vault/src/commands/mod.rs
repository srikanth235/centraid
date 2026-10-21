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
//! The catalogue is two layers ([#1135](https://github.com/srikanth235/centraid/issues/1135)):
//! the **shared verbs** in this module's children — `entity.*`, `tag.*`,
//! `flag.*`, `edge.*`, `container.*`, `blob.*`, `derivative.*`, `person.merge`,
//! `follow.<system>` — each serving every kind that allows it and refusing the
//! rest with a sentence; and the **per-kind verbs** each app registers for its
//! own kinds (`note.create`, `task.complete`, …). A per-kind verb that
//! duplicates a shared verb is not written.
//!
//! ## The gate order, and each gate's reason
//!
//! 1. **Input-schema validation**, with every error run through the sealed
//!    scrub before it reaches the journal or a response. A validation message
//!    quotes the value that failed, which for a sealed field is the secret.
//! 2. **Authority**: the principal's declared reach, and whether it may act.
//! 3. **The LIVE definition is what runs.** A predicate is a function; the
//!    registry is Rust, not a table, and nothing is installed into the file.
//! 4. **Preconditions**: the first failure refuses with the author's SENTENCE.
//! 5. **The handler, inside the commit guard** — its writes, the entities it
//!    touched and their search rows land together or not at all.
//! 6. **Postconditions**: a failed one rolls the whole commit back.
//! 7. **The journal row**, in the same transaction. A refusal is journalled
//!    too; a handler that errored leaves a `failed` row written after the
//!    rollback.
//!
//! ## There is no replay ledger
//!
//! `execute` takes a name and an input, and nothing else: no intent id, no
//! device, no payload hash. The caller is the shell on the device the file is
//! on, so a command that arrives twice **was made twice**: the second delivery
//! runs the handler again (#1029 §1, R-1088-12). The `invoke_key` a shell sends
//! is its own correlation key and never reaches this module. A write a shell
//! may re-offer is idempotent by its own content, or by an id the phone minted
//! before the first attempt.

pub mod blob;
pub mod contact_point;
pub mod container;
pub mod document;
pub mod edge;
pub mod entity;
pub mod event;
pub mod flag;
pub mod follow;
pub mod locker;
pub mod measurement;
pub mod money;
pub mod note;
pub mod person;
pub mod photo;
pub mod place;
pub mod rule;
pub mod tag;
pub mod task;
pub mod workout;

use std::collections::BTreeMap;

use rusqlite::Connection;

use crate::access::{Decision, Principal, Verb, evaluate_access};
use crate::clock::Ids;
use crate::error::{Result, VaultError};
use crate::file::Vault;
use crate::journal::{self, Outcome};
use crate::log::CommitTx;
use crate::model::Kind;

/// How safe a command is to run again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Idempotency {
    /// Running it twice lands the same state.
    Idempotent,
    /// It must not be run twice for one intent. **Nothing answers a second run
    /// from a ledger** (#1029 §1, R-1088-12): a caller that may re-offer it keys
    /// it by its own content or by an id it minted first.
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
    tx: &'tx CommitTx<'conn>,
    /// The command being run, so a handler's own error can name itself.
    pub command: &'static str,
    pub input: serde_json::Value,
    pub principal: Principal,
    pub now: String,
    /// The `journal.seq` this invocation's row will take, reserved before the
    /// handler runs so evidence a handler writes can name the row that
    /// explains it.
    pub journal_seq: i64,
    ids: &'tx dyn Ids,
    /// The vault's local content store, when it has one. See [`CommandCtx::blobs`].
    blobs: Option<&'tx (dyn crate::bytes::BlobStore + Send + Sync)>,
}

impl<'conn> CommandCtx<'_, 'conn> {
    /// The connection this command writes through — the guard's, so the
    /// commit carries every write.
    #[must_use]
    pub const fn connection(&self) -> &'conn Connection {
        self.tx.connection()
    }

    /// THE BLOB DOOR: where bytes that are not text go.
    ///
    /// `None` means this vault was opened without a content store, and a
    /// handler that needs one must REFUSE rather than write a row pointing at
    /// bytes nothing kept.
    #[must_use]
    pub const fn blobs(&self) -> Option<&(dyn crate::bytes::BlobStore + Send + Sync)> {
        self.blobs
    }

    /// A fresh id.
    pub fn next_id(&self) -> String {
        self.ids.next()
    }

    /// Stamp an entity as changed: `updated_at`, `version`, and a place on the
    /// list the search index is rebuilt from at commit.
    ///
    /// **Every command that changes an entity's row, its kind row or its child
    /// rows calls this.** Adding or removing an `about` or `links` edge touches
    /// the note at the edge's start.
    pub fn touch(&self, id: &str) -> Result<()> {
        self.tx.touch(id, &self.now)
    }

    /// Re-index an entity whose own row did not change but whose search text
    /// did.
    pub fn mark_for_index(&self, id: &str) {
        self.tx.mark_for_index(id);
    }

    /// Mint an id and insert the entity row: the first half of every kind's
    /// create. The command inserts the kind row next. Returns the new id.
    pub fn insert_entity(&self, kind: Kind, title: &str) -> Result<String> {
        let id = self.next_id();
        self.insert_entity_as(&id, kind, title)?;
        Ok(id)
    }

    /// [`Self::insert_entity`] for an id the caller minted first (a row a
    /// shell may re-offer, keyed by an id the phone minted).
    pub fn insert_entity_as(&self, id: &str, kind: Kind, title: &str) -> Result<()> {
        self.tx.insert_entity(id, kind, title, &self.now)
    }

    /// Append Locker's access evidence: that an item (or, with `None`, the
    /// locker itself) was opened, revealed or exported. The row names the
    /// journal row that explains it; it is evidence a member can read, and
    /// `receipt_is_evidence` refuses to rewrite it.
    pub fn write_receipt(&self, item_id: Option<&str>, act: &str) -> Result<i64> {
        self.connection().execute(
            "INSERT INTO receipt (at, item_id, act, journal_seq) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![self.now, item_id, act, self.journal_seq],
        )?;
        Ok(self.connection().last_insert_rowid())
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
#[derive(Clone, Copy)]
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
}

impl CommandDefinition {
    /// A low-risk, unconfirmed command with no postconditions and no sealed
    /// input: what almost every shared verb is.
    #[must_use]
    pub const fn plain(
        name: &'static str,
        owner_schema: &'static str,
        input_schema: &'static str,
        idempotency: Idempotency,
        preconditions: &'static [CommandCondition],
        handler: CommandHandler,
    ) -> Self {
        Self {
            name,
            owner_schema,
            input_schema,
            idempotency,
            risk: Risk::Low,
            confirm: false,
            preconditions,
            postconditions: &[],
            handler,
            sealed_input: &[],
        }
    }
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

    /// The registry the phone serves: every command this build carries.
    pub fn with_system_commands() -> Result<Self> {
        let mut registry = Self::new();
        let modules: [fn() -> Vec<CommandDefinition>; 19] = [
            blob::definitions,
            contact_point::definitions,
            container::definitions,
            document::definitions,
            edge::definitions,
            entity::definitions,
            event::definitions,
            flag::definitions,
            follow::definitions,
            locker::definitions,
            measurement::definitions,
            money::definitions,
            note::definitions,
            person::definitions,
            photo::definitions,
            place::definitions,
            rule::definitions,
            tag::definitions,
            task::definitions,
        ];
        for definitions in modules {
            for definition in definitions() {
                registry.register(definition)?;
            }
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
}

/// What a caller asks for.
#[derive(Debug, Clone)]
pub struct Command {
    pub name: String,
    pub input: serde_json::Value,
}

impl Command {
    #[must_use]
    pub fn new(name: impl Into<String>, input: serde_json::Value) -> Self {
        Self {
            name: name.into(),
            input,
        }
    }
}

/// How a command ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandStatus {
    Executed,
    /// The gate refused it, with a sentence in [`CommandOutcome::reason`].
    Failed,
}

/// What running a command produced.
#[derive(Debug, Clone)]
pub struct CommandOutcome {
    pub status: CommandStatus,
    /// The `journal.seq` of the row that records this run, as text.
    pub invocation_id: String,
    /// The tables this command changed, from the commit guard's
    /// `update_hook`. What a change event is made of (#1029 §1).
    pub tables: Vec<String>,
    pub output: serde_json::Value,
    /// The owner-facing sentence, on a refusal.
    pub reason: Option<String>,
    /// The raw predicate that refused, for the journal.
    pub predicate: Option<String>,
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

        // Gate 1. Validation, with the scrub on every message.
        let invalid: Vec<String> = entry
            .validator
            .iter_errors(&command.input)
            .map(|error| {
                journal::scrub_sealed(
                    &format!("{}: {error}", error.instance_path),
                    definition.sealed_input,
                    &command.input,
                )
            })
            .collect();

        // Gate 2. A command acts on its schema as a whole; the per-table
        // narrowing is the handler's reads, through the paged door.
        let decision = self.read(|connection| {
            evaluate_access(
                connection,
                principal,
                definition.owner_schema,
                "command",
                Verb::Act,
            )
        })?;

        let ran = self.commit(|tx| {
            tx.set_producer(&command.name);
            let connection = tx.connection();
            let seq = journal::next_seq(connection)?;
            let at = self.clock().now_text();
            let record = |outcome: Outcome, detail: Option<&str>| {
                journal::write(
                    connection,
                    &journal::Entry {
                        seq,
                        at: &at,
                        command: &command.name,
                        input: &command.input,
                        sealed_keys: definition.sealed_input,
                        outcome,
                        detail,
                    },
                )
            };
            let refused = |sentence: String, predicate: &str| -> Result<Ran> {
                record(Outcome::Refused, Some(&sentence))?;
                Ok(Ran {
                    seq,
                    refusal: Some((sentence, predicate.to_owned())),
                    output: serde_json::Value::Null,
                })
            };

            if let Decision::Deny { failing, .. } = &decision {
                return refused(failing.clone(), "authority");
            }
            if !invalid.is_empty() {
                return refused(invalid.join("; "), "schema");
            }

            let ctx = CommandCtx {
                tx,
                command: definition.name,
                input: command.input.clone(),
                principal: principal.clone(),
                now: at.clone(),
                journal_seq: seq,
                ids: self.ids(),
                blobs: self.blobs(),
            };

            // Gate 4. The first failure refuses, with the author's sentence
            // and the raw predicate.
            for condition in definition.preconditions {
                if let Some(sentence) = (condition.check)(&ctx)? {
                    return refused(sentence, condition.predicate);
                }
            }

            // Gate 5. Inside the guard, so the writes are one commit.
            let output = (definition.handler)(&ctx)?;

            // Gate 6. A FAILED POSTCONDITION ROLLS THE WHOLE COMMIT BACK. The
            // handler's writes are not "mostly right"; either the command's own
            // statement about what it did holds, or the command did not happen.
            for condition in definition.postconditions {
                if let Some(sentence) = (condition.check)(&ctx)? {
                    return Err(VaultError::Invariant {
                        context: format!(
                            "`{}` broke its own postcondition `{}`: {sentence}",
                            definition.name, condition.predicate
                        ),
                    });
                }
            }

            // Gate 7.
            record(Outcome::Executed, None)?;
            Ok(Ran {
                seq,
                refusal: None,
                output,
            })
        });

        let result = match ran {
            Ok(result) => result,
            Err(error) => {
                // The command's writes rolled back and took the row with them,
                // so the failure is written in a transaction of its own. Best
                // effort: a vault that cannot take this write (a full disk) is
                // the failure being reported, not a second one.
                let _ = self.commit(|tx| {
                    journal::write(
                        tx.connection(),
                        &journal::Entry {
                            seq: journal::next_seq(tx.connection())?,
                            at: &self.clock().now_text(),
                            command: &command.name,
                            input: &command.input,
                            sealed_keys: definition.sealed_input,
                            outcome: Outcome::Failed,
                            detail: Some(&journal::scrub_sealed(
                                &error.to_string(),
                                definition.sealed_input,
                                &command.input,
                            )),
                        },
                    )
                });
                return Err(error);
            }
        };

        let Ran {
            seq,
            refusal,
            output,
        } = result.value;
        let (status, reason, predicate) = match refusal {
            Some((sentence, predicate)) => (CommandStatus::Failed, Some(sentence), Some(predicate)),
            None => (CommandStatus::Executed, None, None),
        };
        // A purge collected the blobs nothing names any more, inside its own
        // commit; with the commit made, their files go from this device's store.
        // A file that will not delete is left for a later sweep: the rows are
        // already gone, so nothing refers to it.
        if status == CommandStatus::Executed
            && let (Some(store), Some(released)) = (
                self.blobs(),
                output.get("released").and_then(serde_json::Value::as_array),
            )
        {
            for hash in released.iter().filter_map(serde_json::Value::as_str) {
                let _ = store.remove(hash);
            }
        }
        Ok(CommandOutcome {
            status,
            invocation_id: seq.to_string(),
            tables: result.tables,
            output,
            reason,
            predicate,
        })
    }
}

/// What the gate's transaction produced.
struct Ran {
    seq: i64,
    /// The sentence and the raw predicate, when the gate refused.
    refusal: Option<(String, String)>,
    output: serde_json::Value,
}

/// The handler every stub carries.
///
/// A TYPED error, not a panic: a shell renders "not in this build yet" and the
/// process survives. And it is reached only AFTER the gate order has run, so a
/// stub still validates its input and journals the refusal.
pub fn not_implemented(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    Err(VaultError::NotImplemented {
        name: ctx.command.to_owned(),
    })
}
