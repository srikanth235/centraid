//! The conversation ⊃ turn ⊃ item store (#1020, D-1020-AS3).
//!
//! ## Vocabulary
//!
//! **conversation ⊃ turn ⊃ item** — never "chat" for the ledger. A
//! *conversation* is the thread (a chat, one automation's history, a build); a
//! *turn* is one dispatch to a harness; an *item* is one thing that happened
//! inside it (a message in, a reasoning step, a tool call, a delegate to a
//! sub-run).
//!
//! ## Why these writes do not go through a command
//!
//! The band is **machinery, not app data**. A command exists so that a member's
//! intent is gated, receipted, replayed and replicated; a turn's items are none
//! of those things — they are the gateway's own record of what a subprocess
//! streamed, written dozens of times per turn, never replicated, never
//! exported, and with no member intent behind any single one of them. Routing
//! them through `Vault::execute` would put an invocation row, a receipt and a
//! grant evaluation behind every streamed token.
//!
//! So the store writes directly, like v0's does — but *inside the commit
//! guard*, so the doorbell still rings for the screens that are watching, and
//! the rows are captured as `local = 1` because every table in the band is in
//! the local list (see [`super::schema::assert_band_registration`]).
//!
//! ## Ids and time are injected
//!
//! Always the vault's [`crate::Clock`] and [`crate::Ids`], never
//! `SystemTime::now`. A retention rule is about *edges* — a 30-day cutoff, a
//! sealed cold range — and a test that cannot move time cannot have a live
//! cursor and an aged-out row at once.

use rusqlite::{OptionalExtension, params};

use crate::error::{Result, VaultError};
use crate::file::Vault;

/// `conversations.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversationKind {
    Chat,
    Automation,
    Build,
}

impl ConversationKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Automation => "automation",
            Self::Build => "build",
        }
    }
}

/// `turns.trigger`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnTrigger {
    Scheduled,
    Manual,
    Replay,
    OnFailure,
    Compile,
    Interactive,
}

impl TurnTrigger {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::Manual => "manual",
            Self::Replay => "replay",
            Self::OnFailure => "on_failure",
            Self::Compile => "compile",
            Self::Interactive => "interactive",
        }
    }
}

/// `items.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    MessageIn,
    Step,
    Tool,
    Delegate,
}

impl ItemKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MessageIn => "message_in",
            Self::Step => "step",
            Self::Tool => "tool",
            Self::Delegate => "delegate",
        }
    }
}

/// Where a cost figure came from. There is no `Unknown`: a row with no source
/// stores NULL, which is the honest absence of a claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CostSource {
    /// The harness reported USD itself.
    Harness,
    /// Computed here from token counts and a rate table, and therefore
    /// repriceable.
    Estimated,
}

impl CostSource {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Harness => "harness",
            Self::Estimated => "estimated",
        }
    }
}

/// A conversation row, as much of it as a reader needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub turn_count: i64,
    pub item_count: i64,
}

/// A turn, as opened.
#[derive(Debug, Clone)]
pub struct Turn {
    pub id: String,
    pub conversation_id: String,
    pub seq: i64,
}

/// What to record for one item.
#[derive(Debug, Clone, Default)]
pub struct Item {
    pub kind: &'static str,
    pub ordinal: i64,
    /// The harness's own call id, for a tool item. UNIQUE per turn when present
    /// (`idx_items_turn_call`), which is what makes a re-delivered tool result
    /// an update rather than a duplicate.
    pub call_id: Option<String>,
    pub role: Option<String>,
    pub text: Option<String>,
    pub name: Option<String>,
    pub args_json: Option<String>,
    pub output_json: Option<String>,
    pub model: Option<String>,
    pub harness: Option<String>,
    /// The ACP semantic `thought_level` the harness CONFIRMED for this call.
    ///
    /// `None` means it did not confirm a selectable effort. **Never infer a
    /// default** (`ledger.ts:126`–`:127`): writing `"medium"` here because most
    /// calls are medium would turn an absent fact into a recorded one, and the
    /// Insights rollup counts these.
    pub effort: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub cost_source: Option<CostSource>,
    /// The sub-run this delegate item opened.
    pub child_turn_id: Option<String>,
}

/// One ENDED turn's rollup, as the `run_summary` view computes it.
///
/// The view's own column names are kept (`run_id`, `model`, `harness`,
/// `effort`) rather than renamed to something tidier, because the view is the
/// contract the Insights screens read and two names for one column is how a
/// query ends up reading the wrong one.
///
/// `run_summary` selects `WHERE t.ended_at IS NOT NULL`: an open turn has no
/// summary, and that absence is the answer rather than a row of zeros.
#[derive(Debug, Clone, PartialEq)]
pub struct RunSummary {
    pub run_id: String,
    pub kind: String,
    pub ok: i64,
    pub step_count: Option<i64>,
    pub tool_count: Option<i64>,
    /// The model that burned the most tokens across this turn's `step` and
    /// `delegate` items — not the last one seen.
    pub model: Option<String>,
    pub harness: Option<String>,
    /// The dominant CONFIRMED effort. `None` when no item carried one, which is
    /// the ordinary case for a harness that does not expose `thought_level`.
    pub effort: Option<String>,
}

/// The band's store. Borrows the vault; holds no connection of its own.
pub struct Store<'v> {
    vault: &'v Vault,
}

impl<'v> Store<'v> {
    #[must_use]
    pub const fn new(vault: &'v Vault) -> Self {
        Self { vault }
    }

    /// Open a conversation, or return the one that is already open for this
    /// automation reference.
    ///
    /// Idempotent on `automation_id`, because an automation's history is one
    /// conversation for the life of the automation: a fire that opened a second
    /// would split the Insights rollup in half.
    pub fn ensure_conversation(
        &self,
        kind: ConversationKind,
        user_id: &str,
        automation_id: Option<&str>,
        title: &str,
    ) -> Result<Conversation> {
        if let Some(reference) = automation_id
            && let Some(existing) = self.conversation_for_automation(reference)?
        {
            return Ok(existing);
        }
        let id = self.vault.ids().next();
        let now = self.vault.clock().now_ms();
        self.vault.commit(|tx| {
            tx.set_producer("ledger.ensure_conversation");
            tx.connection()
                .execute(
                    "INSERT INTO conversations \
                     (id, kind, user_id, automation_id, title, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    params![&id, kind.as_str(), user_id, automation_id, title, now],
                )
                .map_err(|error| VaultError::from_sqlite("opening a conversation", error))?;
            Ok(())
        })?;
        Ok(Conversation {
            id,
            kind: kind.as_str().to_owned(),
            title: title.to_owned(),
            turn_count: 0,
            item_count: 0,
        })
    }

    fn conversation_for_automation(&self, reference: &str) -> Result<Option<Conversation>> {
        self.vault.read(|connection| {
            connection
                .query_row(
                    "SELECT id, kind, title, turn_count, item_count FROM conversations \
                     WHERE automation_id = ?1 AND archived = 0 ORDER BY created_at LIMIT 1",
                    [reference],
                    |row| {
                        Ok(Conversation {
                            id: row.get(0)?,
                            kind: row.get(1)?,
                            title: row.get(2)?,
                            turn_count: row.get(3)?,
                            item_count: row.get(4)?,
                        })
                    },
                )
                .optional()
                .map_err(|error| VaultError::from_sqlite("reading a conversation", error))
        })
    }

    pub fn conversation(&self, id: &str) -> Result<Option<Conversation>> {
        self.vault.read(|connection| {
            connection
                .query_row(
                    "SELECT id, kind, title, turn_count, item_count FROM conversations \
                     WHERE id = ?1",
                    [id],
                    |row| {
                        Ok(Conversation {
                            id: row.get(0)?,
                            kind: row.get(1)?,
                            title: row.get(2)?,
                            turn_count: row.get(3)?,
                            item_count: row.get(4)?,
                        })
                    },
                )
                .optional()
                .map_err(|error| VaultError::from_sqlite("reading a conversation", error))
        })
    }

    /// Open a turn.
    ///
    /// `seq` is allocated as `max(seq) + 1` within the conversation rather than
    /// from a global sequence, because the archive pass seals **ranges of seq**
    /// per conversation and a globally-allocated number would make every
    /// conversation's range sparse.
    ///
    /// `idempotency_key` is stored and indexed but **not unique**
    /// (`ledger.ts:107`–`:109`): automations and legacy rows leave it NULL, and
    /// a UNIQUE index over a column that is usually NULL buys nothing while
    /// refusing the second of two un-keyed turns on some SQLite builds.
    /// [`Self::turn_for_idempotency_key`] is the read that makes it useful.
    pub fn open_turn(
        &self,
        conversation_id: &str,
        trigger: TurnTrigger,
        parent_turn_id: Option<&str>,
        idempotency_key: Option<&str>,
        hydration_tokens: Option<i64>,
    ) -> Result<Turn> {
        let id = self.vault.ids().next();
        let now = self.vault.clock().now_ms();
        let seq = self.vault.read(|connection| {
            connection
                .query_row(
                    "SELECT COALESCE(MAX(seq), -1) + 1 FROM turns WHERE conversation_id = ?1",
                    [conversation_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| VaultError::from_sqlite("allocating a turn seq", error))
        })?;
        self.vault.commit(|tx| {
            tx.set_producer("ledger.open_turn");
            tx.connection()
                .execute(
                    "INSERT INTO turns \
                     (id, conversation_id, seq, parent_turn_id, trigger, idempotency_key, \
                      hydration_tokens, started_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        &id,
                        conversation_id,
                        seq,
                        parent_turn_id,
                        trigger.as_str(),
                        idempotency_key,
                        hydration_tokens,
                        now
                    ],
                )
                .map_err(|error| VaultError::from_sqlite("opening a turn", error))?;
            // `turn_count` HAS NO TRIGGER — only `item_count` does
            // (`ledger.ts:390`–`:402`). The asymmetry is v0's and is kept; the
            // increment lives here so there is exactly one writer of it.
            tx.connection()
                .execute(
                    "UPDATE conversations SET turn_count = turn_count + 1, updated_at = ?2 \
                     WHERE id = ?1",
                    params![conversation_id, now],
                )
                .map_err(|error| VaultError::from_sqlite("counting a turn", error))?;
            Ok(())
        })?;
        Ok(Turn {
            id,
            conversation_id: conversation_id.to_owned(),
            seq,
        })
    }

    /// The most recent turn carrying this idempotency key, if any.
    pub fn turn_for_idempotency_key(
        &self,
        conversation_id: &str,
        key: &str,
    ) -> Result<Option<String>> {
        self.vault.read(|connection| {
            connection
                .query_row(
                    "SELECT id FROM turns WHERE conversation_id = ?1 AND idempotency_key = ?2 \
                     ORDER BY seq DESC LIMIT 1",
                    params![conversation_id, key],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| VaultError::from_sqlite("reading a turn by key", error))
        })
    }

    /// Record one item.
    ///
    /// A tool item carrying a `call_id` is an **upsert** on
    /// `(turn_id, call_id)`: ACP delivers a tool call and then its result as
    /// separate updates for the same call, and two rows would double the tool
    /// count the rollup reads.
    ///
    /// The conflict target repeats `WHERE call_id IS NOT NULL`, because
    /// `idx_items_turn_call` is a **partial** unique index and SQLite matches a
    /// partial index only when the upsert restates its predicate. Without it
    /// the statement fails with *"ON CONFLICT clause does not match any PRIMARY
    /// KEY or UNIQUE constraint"* — which reads like a missing index rather
    /// than a missing clause, and cost this slot a debugging pass.
    pub fn append_item(&self, turn_id: &str, item: &Item) -> Result<String> {
        let id = self.vault.ids().next();
        let now = self.vault.clock().now_ms();
        self.vault.commit(|tx| {
            tx.set_producer("ledger.append_item");
            tx.connection()
                .execute(
                    "INSERT INTO items \
                     (id, turn_id, ordinal, call_id, kind, role, text, name, args_json, \
                      output_json, child_turn_id, model, harness, effort, input_tokens, \
                      output_tokens, cost_usd, cost_source, started_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, \
                             ?16, ?17, ?18, ?19) \
                     ON CONFLICT (turn_id, call_id) WHERE call_id IS NOT NULL DO UPDATE SET \
                       output_json = COALESCE(excluded.output_json, items.output_json), \
                       args_json   = COALESCE(excluded.args_json, items.args_json), \
                       text        = COALESCE(excluded.text, items.text), \
                       effort      = COALESCE(excluded.effort, items.effort)",
                    params![
                        &id,
                        turn_id,
                        item.ordinal,
                        item.call_id.as_deref(),
                        item.kind,
                        item.role.as_deref(),
                        item.text.as_deref(),
                        item.name.as_deref(),
                        item.args_json.as_deref(),
                        item.output_json.as_deref(),
                        item.child_turn_id.as_deref(),
                        item.model.as_deref(),
                        item.harness.as_deref(),
                        item.effort.as_deref(),
                        item.input_tokens,
                        item.output_tokens,
                        item.cost_usd,
                        item.cost_source.map(CostSource::as_str),
                        now
                    ],
                )
                .map_err(|error| VaultError::from_sqlite("recording an item", error))?;
            Ok(())
        })?;
        Ok(id)
    }

    /// Close a turn with its outcome and rollup.
    pub fn close_turn(&self, turn_id: &str, ok: bool, error: Option<&str>) -> Result<()> {
        let now = self.vault.clock().now_ms();
        self.vault.commit(|tx| {
            tx.set_producer("ledger.close_turn");
            tx.connection()
                .execute(
                    "UPDATE turns SET ok = ?2, error = ?3, ended_at = ?4, \
                       step_count = (SELECT COUNT(*) FROM items \
                                     WHERE turn_id = ?1 AND kind = 'step'), \
                       tool_count = (SELECT COUNT(*) FROM items \
                                     WHERE turn_id = ?1 AND kind = 'tool'), \
                       total_input_tokens  = (SELECT SUM(input_tokens) FROM items \
                                              WHERE turn_id = ?1), \
                       total_output_tokens = (SELECT SUM(output_tokens) FROM items \
                                              WHERE turn_id = ?1), \
                       total_cost_usd      = (SELECT SUM(cost_usd) FROM items \
                                              WHERE turn_id = ?1) \
                     WHERE id = ?1",
                    params![turn_id, i64::from(ok), error, now],
                )
                .map_err(|sqlite| VaultError::from_sqlite("closing a turn", sqlite))?;
            Ok(())
        })?;
        Ok(())
    }

    /// One turn's rollup, read through the view rather than recomputed.
    pub fn run_summary(&self, turn_id: &str) -> Result<Option<RunSummary>> {
        self.vault.read(|connection| {
            connection
                .query_row(
                    "SELECT run_id, kind, ok, step_count, tool_count, model, harness, effort \
                     FROM run_summary WHERE run_id = ?1",
                    [turn_id],
                    |row| {
                        Ok(RunSummary {
                            run_id: row.get(0)?,
                            kind: row.get(1)?,
                            ok: row.get(2)?,
                            step_count: row.get(3)?,
                            tool_count: row.get(4)?,
                            model: row.get(5)?,
                            harness: row.get(6)?,
                            effort: row.get(7)?,
                        })
                    },
                )
                .optional()
                .map_err(|error| VaultError::from_sqlite("reading a run summary", error))
        })
    }

    /// A conversation's turn ids in order, for hydration and for the archive
    /// selector.
    pub fn turn_ids(&self, conversation_id: &str) -> Result<Vec<(String, i64, i64)>> {
        self.vault.read(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, seq, started_at FROM turns WHERE conversation_id = ?1 \
                     ORDER BY seq",
                )
                .map_err(|error| VaultError::from_sqlite("listing turns", error))?;
            let rows = statement
                .query_map([conversation_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .map_err(|error| VaultError::from_sqlite("listing turns", error))?;
            let mut found = Vec::new();
            for row in rows {
                found.push(row.map_err(|error| VaultError::from_sqlite("listing turns", error))?);
            }
            Ok(found)
        })
    }
}
