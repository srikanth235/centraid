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
pub mod core_links;
pub mod knowledge;
pub mod locker;
pub mod media;
pub mod people;
pub mod schedule;
pub mod social;
pub mod tally;

use std::collections::BTreeMap;

use rusqlite::Connection;

use crate::access::{Decision, Principal, Verb, evaluate_access};
use crate::audit::{self, Check, Invocation, Receipt};
use crate::clock::Ids;
use crate::error::{Result, VaultError};
use crate::file::Vault;
use crate::log::CommitTx;

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

/// WHAT A COMMAND DOES TO THE VAULT.
///
/// For most commands the handler's own SQL says it — every command that stamps
/// `deleted_at` is a `Delete` whatever it is called — and
/// `crates/evalsuite/grammar/derive/derive_grammar.py` reads it off the SQL
/// rather than off a list. Twenty-six handlers state it somewhere the SQL
/// cannot be seen: the statement lives in a helper (`set_starred`,
/// `write_new_expense`, `task_for_person`), or the command writes nothing at
/// all. Those are DECLARED in [`DECLARED_EFFECTS`] below, each with the reason,
/// so the effect of a command is a fact of the registry and not of whether a
/// parser could find the INSERT.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    /// Mints a row a member can then name.
    Create,
    /// Changes a row that already exists.
    Edit,
    /// Stamps `deleted_at`.
    Delete,
    /// Clears `deleted_at`.
    Restore,
    /// Stamps `completed_at`.
    Complete,
    /// Stamps `settled_at`.
    Settle,
    /// Sets a row's status to cancelled.
    Cancel,
    /// Moves a row in time.
    Reschedule,
    /// Folds one row into another and leaves one behind: neither an `Edit` of
    /// the survivor nor a `Delete` of the loser, because the references move.
    Merge,
    /// Reads and writes nothing but its own receipt. A command rather than a
    /// query because a query handler is read-only by directive and so cannot
    /// write the receipt a reveal owes.
    Read,
}

impl Effect {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Edit => "edit",
            Self::Delete => "delete",
            Self::Restore => "restore",
            Self::Complete => "complete",
            Self::Settle => "settle",
            Self::Cancel => "cancel",
            Self::Reschedule => "reschedule",
            Self::Merge => "merge",
            Self::Read => "read",
        }
    }
}

/// WHETHER A COMMAND'S EFFECT LEAVES THE VAULT.
///
/// Until now nothing in the registry said so. `sealed_input` declares which
/// arguments are secrets, `online_only` declares what a seat refuses to queue,
/// `risk` and `confirm` declare how loudly to ask — and all eight app manifests
/// declare the same `actionSideEffect: "vault-write"`, so the manifests
/// separated nothing either. The one consumer that needed the fact,
/// `crates/candidates/src/exec.rs`, carried a hand-written list of ONE name and
/// missed `locker.export`, which is R-R2's own example.
///
/// So egress is declared here, for every command the structural signals raise
/// as a candidate, and `derive_grammar.py` fails when a candidate carries no
/// declaration. `None` is a real answer and must still be written down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Egress {
    /// Nothing leaves. The vault's own rows change and stop there.
    None,
    /// Hands material to a transport that carries it to somebody else.
    Transport,
    /// Hands material to the member, out of the vault's custody, in bulk.
    Export,
}

impl Egress {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Transport => "transport",
            Self::Export => "export",
        }
    }
}

/// One command's declared effect, and why the SQL cannot state it.
pub struct DeclaredEffect {
    pub command: &'static str,
    pub effect: Effect,
    /// One line. The handler this was read out of, and what it does there.
    pub why: &'static str,
}

/// THE TWENTY-SIX whose effect the handler's SQL does not state.
///
/// Read out of `crates/vault/src/commands/*.rs` one handler at a time. Every
/// other command's effect is derived from its own SQL and is NOT repeated here:
/// a second list of facts the code already carries is the thing that drifts.
/// `derive_grammar.py` refuses a name here that the SQL classifies differently,
/// and refuses a registered command that neither the SQL nor this list places.
pub const DECLARED_EFFECTS: &[DeclaredEffect] = &[
    DeclaredEffect {
        command: "core.edit_document",
        effect: Effect::Edit,
        why: "its UPDATE runs inside `update_document`, and `set_representation` \
              re-points the body at freshly minted bytes.",
    },
    DeclaredEffect {
        command: "core.replace_document_content",
        effect: Effect::Edit,
        why: "`update_document` plus `set_representation`: one document, a new body.",
    },
    DeclaredEffect {
        command: "core.set_extracted_text",
        effect: Effect::Edit,
        why: "`upsert_text_derivative` fills in an existing document's text; no \
              row a member names appears.",
    },
    DeclaredEffect {
        command: "core.merge_party",
        effect: Effect::Merge,
        why: "`fold_party` moves every reference onto the survivor and trashes \
              the loser — not the `Delete` its SQL would look like.",
    },
    DeclaredEffect {
        command: "locker.star_item",
        effect: Effect::Edit,
        why: "`set_starred` carries the UPDATE.",
    },
    DeclaredEffect {
        command: "locker.unstar_item",
        effect: Effect::Edit,
        why: "`set_starred` carries the UPDATE.",
    },
    DeclaredEffect {
        command: "locker.counts",
        effect: Effect::Read,
        why: "counts the locker's rows and writes nothing.",
    },
    DeclaredEffect {
        command: "locker.totp_code",
        effect: Effect::Read,
        why: "derives a code from a stored seed and writes only its subject receipt.",
    },
    DeclaredEffect {
        command: "locker.watchtower",
        effect: Effect::Read,
        why: "reports weak and reused secrets; writes only its subject receipt.",
    },
    DeclaredEffect {
        command: "locker.export",
        effect: Effect::Read,
        why: "reads every item and writes only the one receipt the mass reveal \
              owes; what makes it grave is its egress, not its effect.",
    },
    DeclaredEffect {
        command: "locker.reveal_receipt",
        effect: Effect::Read,
        why: "records that a seat-side reveal happened; `access_receipt` is \
              append-only and is not a row a member names.",
    },
    DeclaredEffect {
        command: "media.add_asset",
        effect: Effect::Create,
        why: "mints an asset and its content item; identical bytes dedupe onto one.",
    },
    DeclaredEffect {
        command: "media.derive_missing",
        effect: Effect::Edit,
        why: "fills in derivatives for assets that already exist; no new asset appears.",
    },
    DeclaredEffect {
        command: "media.set_favorite",
        effect: Effect::Edit,
        why: "`set_starred` carries the UPDATE.",
    },
    DeclaredEffect {
        command: "people.star_person",
        effect: Effect::Edit,
        why: "`set_starred` carries the UPDATE.",
    },
    DeclaredEffect {
        command: "people.unstar_person",
        effect: Effect::Edit,
        why: "`set_starred` carries the UPDATE.",
    },
    DeclaredEffect {
        command: "people.move_person",
        effect: Effect::Edit,
        why: "`file_into_list` re-files an existing party.",
    },
    DeclaredEffect {
        command: "people.add_note",
        effect: Effect::Create,
        why: "`annotate` mints the journal note the member then names.",
    },
    DeclaredEffect {
        command: "people.add_task",
        effect: Effect::Create,
        why: "`task_for_person` mints a task and links it to the party.",
    },
    DeclaredEffect {
        command: "people.add_gift",
        effect: Effect::Create,
        why: "`task_for_person` mints a task and links it to the party.",
    },
    DeclaredEffect {
        command: "schedule.set_task_status",
        effect: Effect::Edit,
        why: "one command that completes, cancels or reopens depending on \
              `status`: the registry fixes no single effect, only the argument does.",
    },
    DeclaredEffect {
        command: "tally.add_group_member",
        effect: Effect::Create,
        why: "`add_circle_member` mints the circle membership the group reads back.",
    },
    DeclaredEffect {
        command: "tally.add_expense",
        effect: Effect::Create,
        why: "`write_new_expense` mints the expense, its payers and its splits.",
    },
    DeclaredEffect {
        command: "tally.add_receipt_expense",
        effect: Effect::Create,
        why: "the same mint as `tally.add_expense`, from a receipt's line items.",
    },
    DeclaredEffect {
        command: "tally.reallocate_receipt",
        effect: Effect::Edit,
        why: "`write_line_items` and `write_splits` re-cut an expense that already exists.",
    },
    DeclaredEffect {
        command: "tally.materialize_recurring_expense",
        effect: Effect::Create,
        why: "mints this occurrence of a recurring expense as a real one.",
    },
];

/// One command's declared egress, and why.
pub struct DeclaredEgress {
    pub command: &'static str,
    pub egress: Egress,
    pub why: &'static str,
}

/// EVERY COMMAND THE STRUCTURAL SIGNALS RAISE, ruled one way or the other.
///
/// The signals are the ones `derive_grammar.py` can see without a judgement:
/// a name that states a transfer, a handler that stamps a row as sent, an
/// `online_only` command, a sealed input. A command that trips one and appears
/// nowhere here is a red derivation, so the list cannot go quietly stale — and
/// `Egress::None` beside a reason is how a candidate is cleared.
pub const DECLARED_EGRESS: &[DeclaredEgress] = &[
    DeclaredEgress {
        command: "locker.export",
        egress: Egress::Export,
        why: "every secret the locker holds, in the clear, in a file the seat writes.",
    },
    DeclaredEgress {
        command: "social.send_message",
        egress: Egress::Transport,
        why: "the member's request is for the message to ARRIVE; the row it \
              records is the vault's half of a transfer.",
    },
    DeclaredEgress {
        command: "social.draft_message",
        egress: Egress::None,
        why: "a draft is a row and stays one; sending it is `social.send_message`.",
    },
    DeclaredEgress {
        command: "locker.reveal_receipt",
        egress: Egress::None,
        why: "records that a seat revealed something. The reveal left custody; \
              writing down that it did, did not.",
    },
    DeclaredEgress {
        command: "tally.nudge",
        egress: Egress::None,
        why: "writes one row saying a reminder was PREPARED, with `sent` stated \
              and always false, because no delivery path exists.",
    },
    DeclaredEgress {
        command: "locker.add_item",
        egress: Egress::None,
        why: "`online_only` and sealed-input: the seat seals the secret before \
              the gateway sees it. Nothing leaves.",
    },
    DeclaredEgress {
        command: "locker.edit_item",
        egress: Egress::None,
        why: "as `locker.add_item` — the seat seals, the vault stores.",
    },
    DeclaredEgress {
        command: "locker.set_field",
        egress: Egress::None,
        why: "as `locker.add_item` — the seat seals, the vault stores.",
    },
    DeclaredEgress {
        command: "locker.duplicate_item",
        egress: Egress::None,
        why: "copies one item's sealed cells to a second row inside the same \
              vault; the ciphertext never leaves.",
    },
    DeclaredEgress {
        command: "locker.set_passkey",
        egress: Egress::None,
        why: "as `locker.add_item` — the seat seals the private key, the vault stores it.",
    },
    DeclaredEgress {
        command: "locker.rotate_key",
        egress: Egress::None,
        why: "`online_only` because the seat holds the key it rotates; the new \
              key never leaves that seat.",
    },
    DeclaredEgress {
        command: "locker.totp_code",
        egress: Egress::None,
        why: "derives a code at the member's own seat; it is shown, not sent.",
    },
    DeclaredEgress {
        command: "locker.watchtower",
        egress: Egress::None,
        why: "reads the locker's own rows and answers at the seat.",
    },
    DeclaredEgress {
        command: "tally.materialize_recurring_expense",
        egress: Egress::None,
        why: "`online_only` so the recurrence plane is reachable, not because \
              anything is handed out.",
    },
];

/// What a handler is handed.
pub struct CommandCtx<'tx, 'conn> {
    tx: &'tx CommitTx<'conn>,
    /// The command being run, so a handler's own error can name itself.
    pub command: &'static str,
    pub input: serde_json::Value,
    pub principal: Principal,
    pub now: String,
    pub invocation_id: String,
    ids: &'tx dyn Ids,
    clock: &'tx dyn crate::clock::Clock,
    produced_ids: std::cell::RefCell<Vec<String>>,
    /// The vault's local content store, when it has one. See [`CommandCtx::blobs`].
    blobs: Option<&'tx (dyn crate::backup::store::BlobStore + Send + Sync)>,
}

impl<'conn> CommandCtx<'_, 'conn> {
    /// The connection this command writes through — the guard's, so every
    /// write is captured.
    #[must_use]
    pub const fn connection(&self) -> &'conn Connection {
        self.tx.connection()
    }

    /// THE BLOB DOOR: where bytes that are not text go.
    ///
    /// `None` means this vault was opened without a content store, and a
    /// handler that needs one must REFUSE rather than write a row pointing at
    /// bytes nothing kept. `pre_inline_bytes_are_storable` is that refusal, so
    /// in practice a handler reaching here has already been gated.
    #[must_use]
    pub const fn blobs(&self) -> Option<&(dyn crate::backup::store::BlobStore + Send + Sync)> {
        self.blobs
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
    /// ('locker.item', 'locker.auth')` and would never see a command receipt.
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
        // The `core` schema arrives in two files: the parties/tags/documents
        // half (slot 4b) and the link/attachment half (slot 4c). ONE schema,
        // registered together — the split is where a lane took it, not a second
        // owner (#1020, D-1020-N6).
        for definition in core_links::definitions() {
            registry.register(definition)?;
        }
        for definition in knowledge::definitions() {
            registry.register(definition)?;
        }
        for definition in locker::definitions() {
            registry.register(definition)?;
        }
        for definition in media::definitions() {
            registry.register(definition)?;
        }
        for definition in people::definitions() {
            registry.register(definition)?;
        }
        for definition in schedule::definitions() {
            registry.register(definition)?;
        }
        for definition in social::definitions() {
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
    Failed,
}

/// What running a command produced.
#[derive(Debug, Clone)]
pub struct CommandOutcome {
    pub status: CommandStatus,
    pub invocation_id: String,
    pub receipt_id: String,
    /// The tables this command changed, from the commit guard's
    /// `update_hook`. What a change event is made of (#1029 §1).
    pub tables: Vec<String>,
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

        // NO REPLAY LEDGER (#1029 §1). `replica_intent_outcome` answered a
        // SEAT resubmitting an intent its gateway may already have run: the
        // network between them could lose an answer, so the same write could
        // arrive twice and the ledger was what made the second one a replay
        // rather than a second execution. There is no network between the
        // caller and this vault — the caller is the shell on the device the
        // file is on — so a command that arrives twice was made twice.
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
                blobs: self.blobs(),
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

        Ok(CommandOutcome {
            status,
            invocation_id,
            receipt_id,
            tables: result.tables,
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
    tx: &CommitTx<'_>,
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

#[cfg(test)]
mod declaration_tests {
    use std::collections::BTreeSet;

    use super::{DECLARED_EFFECTS, DECLARED_EGRESS, Registry};

    /// A declaration that names nothing is a lie that never goes red, so the
    /// registry is what both lists are held to.
    #[test]
    fn every_declaration_names_a_registered_command() {
        let registry = Registry::with_system_commands().expect("the registry builds");
        let names: BTreeSet<&str> = registry.names().into_iter().collect();
        for declared in DECLARED_EFFECTS {
            assert!(
                names.contains(declared.command),
                "DECLARED_EFFECTS names `{}`, which is not registered",
                declared.command
            );
            assert!(
                !declared.why.is_empty(),
                "`{}` declares an effect with no reason",
                declared.command
            );
        }
        for declared in DECLARED_EGRESS {
            assert!(
                names.contains(declared.command),
                "DECLARED_EGRESS names `{}`, which is not registered",
                declared.command
            );
            assert!(
                !declared.why.is_empty(),
                "`{}` declares an egress with no reason",
                declared.command
            );
        }
    }

    #[test]
    fn neither_list_names_a_command_twice() {
        let mut seen = BTreeSet::new();
        for declared in DECLARED_EFFECTS {
            assert!(
                seen.insert(declared.command),
                "DECLARED_EFFECTS names `{}` twice",
                declared.command
            );
        }
        let mut seen = BTreeSet::new();
        for declared in DECLARED_EGRESS {
            assert!(
                seen.insert(declared.command),
                "DECLARED_EGRESS names `{}` twice",
                declared.command
            );
        }
    }
}
