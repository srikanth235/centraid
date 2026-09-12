//! The automation manifest: five trigger kinds, one structural watch list
//! (#1020, D-1020-AU1).
//!
//! ## The manifest is the source of truth, and there is no definition table
//!
//! `manifest.ts:1`–`:20`: an automation is a unit that lives inside an app
//! folder at `<appCodeDir>/automations/<id>/`, `automation.json` is its
//! manifest, and **`enabled` lives there** — toggling it rewrites the file, so
//! a scheduler host can register or suppress from the manifest alone. A port
//! that added a SQLite definition table would have two answers to "is this
//! automation on" and no rule about which wins.
//!
//! ## Five kinds, and each one's deterministic side effect
//!
//! [`TRIGGER_REGISTRY`] is v0's `AUTOMATION_TRIGGER_REGISTRY` (`:352`–`:396`),
//! and it is a table rather than five `match` arms for the reason v0 gives:
//! *"New kinds must declare their deterministic side-effect and consent
//! posture here before they can enter the wire vocabulary."* The table is what
//! the consent, health and ledger-coverage gates read.
//!
//! ## Two properties the census singles out, and where each one is
//!
//! - **A pending webhook is a distinct state** (`:697`–`:719`). The builder
//!   harness cannot mint crypto-random credentials, so
//!   `{"kind":"webhook","pending":true}` is legal and round-trips until the
//!   gateway provisions it. The Rust shape makes it an enum arm rather than an
//!   `Option<String>` pair, so "minted but missing its hash" is not
//!   representable.
//! - **The watch list is structural**, not a name list: a `condition` or
//!   `data` trigger carries [`crate::watch::Watchable`] values, which cannot be
//!   constructed from an unregistered or machinery-band entity. See
//!   [`crate::watch`] for the argument; the manifest's job is only to surface
//!   the refusal with the field that caused it.
//!
//! ## Four couplings a shape check alone would miss
//!
//! The interesting refusals are not about types, they are about **coherence**,
//! and every one of them came out of the parity fixture rather than out of the
//! type:
//!
//! 1. **A condition or data trigger needs a `vault` block.** Such a trigger IS
//!    a consented vault read, so without a block there is no grant to evaluate
//!    it under and the manifest means nothing it can carry out.
//! 2. **An event trigger needs a BOUND connection of its kind.** A provider
//!    cursor with no connection is a subscription to nothing.
//! 3. **`requires.secrets` is connector-only** (#293). A non-connector
//!    declaring them is a manifest bug, not a latent capability.
//! 4. **A connector needs a `vault` block**, because a connector's whole job is
//!    writing staged rows into the vault.
//!
//! There is **no `confirmation` field** on an automation manifest — census A0's
//! `confirmation` is an APP manifest's, and the census's point stands either
//! way: a manifest's gate and a command's `confirm` are two different gates.
//!
//! `requires.secrets` is parsed and preserved but reaches nothing: `ctx.fetch`
//! is connector-only and connectors are on the back burner, so the fetch rail
//! answers [`crate::handler::CtxError::NotAvailable`] this wave rather than
//! resolving a Locker cell it has no consumer for (D-1020-AU4).

use std::collections::BTreeSet;

use serde_json::Value;

use crate::cron;
use crate::watch::{WatchRefusal, Watchable};

/// The conventional filenames inside an automation directory.
pub const MANIFEST_FILE: &str = "automation.json";
pub const HANDLER_FILE: &str = "handler.js";

/// How many missed occurrences an `each` backfill delivers before the rest are
/// a recorded gap (`docs/cron-timezone.md` Backfill classes).
pub const MAX_BACKFILL_OCCURRENCES: usize = 24;

/// Default polling gates, v0's (`manifest.ts`).
pub const CONDITION_DEFAULT_EVERY: &str = "*/5 * * * *";
pub const DATA_DEFAULT_EVERY: &str = "* * * * *";
pub const EVENT_DEFAULT_EVERY: &str = "*/5 * * * *";

/// What a MISSED cron occurrence is worth (#1014, R-1014-9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Backfill {
    /// One fire at the newest missed instant; the rest are a `scheduler_gap`.
    /// Right for a POLL, because "everything since my cursor" fetched twice is
    /// the same mailbox twice.
    #[default]
    Latest,
    /// Every missed occurrence, newest-first, up to
    /// [`MAX_BACKFILL_OCCURRENCES`]. Right for a recipe whose fire IS the
    /// occurrence: two missed mornings are two reminders nobody got.
    Each,
}

impl Backfill {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Latest => "latest",
            Self::Each => "each",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "latest" => Some(Self::Latest),
            "each" => Some(Self::Each),
            _ => None,
        }
    }
}

/// One `where` clause on a condition trigger.
#[derive(Debug, Clone, PartialEq)]
pub struct WhereClause {
    pub column: String,
    pub op: ConditionOp,
    pub value: Option<Value>,
}

/// v0's `CONDITION_OPS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionOp {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
    IsNull,
    IsNotNull,
    In,
}

impl ConditionOp {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Eq => "eq",
            Self::Ne => "ne",
            Self::Lt => "lt",
            Self::Lte => "lte",
            Self::Gt => "gt",
            Self::Gte => "gte",
            Self::IsNull => "is-null",
            Self::IsNotNull => "is-not-null",
            Self::In => "in",
        }
    }

    /// Every op, for the refusal's own sentence.
    pub const ALL: [Self; 9] = [
        Self::Eq,
        Self::Ne,
        Self::Lt,
        Self::Lte,
        Self::Gt,
        Self::Gte,
        Self::IsNull,
        Self::IsNotNull,
        Self::In,
    ];

    fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|op| op.as_str() == raw)
    }
}

/// A webhook trigger's provisioning state. Two arms, so "minted without a
/// secret hash" cannot be written down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebhookState {
    /// Declared by a builder that cannot mint credentials; round-trips until
    /// the gateway provisions it.
    Pending,
    /// Provisioned: a route slug and the SHA-256 of a secret shown once.
    /// **The plaintext is never in the manifest** — `automation.json` is
    /// member-visible (`scaffold/webhook.ts:1`–`:6`).
    Minted { id: String, secret_hash: String },
}

/// The five kinds.
#[derive(Debug, Clone, PartialEq)]
pub enum Trigger {
    Cron {
        expr: String,
        /// Tier 1 of [`crate::cron::FireZone::resolve`]. `None` defers to the
        /// vault's zone — and, with neither, the schedule is refused.
        tz: Option<String>,
        backfill: Backfill,
    },
    Webhook(WebhookState),
    Condition {
        entity: Watchable,
        clauses: Vec<WhereClause>,
        every: Option<String>,
    },
    Data {
        entities: Vec<Watchable>,
        every: Option<String>,
    },
    Event {
        connector_kind: String,
        event: String,
        filter: Option<Value>,
        every: Option<String>,
    },
}

/// The wire vocabulary. `Trigger["kind"]` in v0.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TriggerKind {
    Cron,
    Webhook,
    Condition,
    Data,
    Event,
}

impl TriggerKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cron => "cron",
            Self::Webhook => "webhook",
            Self::Condition => "condition",
            Self::Data => "data",
            Self::Event => "event",
        }
    }
}

/// What one kind declares before it may enter the vocabulary.
#[derive(Debug, Clone, Copy)]
pub struct TriggerContract {
    pub kind: TriggerKind,
    /// The deterministic side effect firing this kind has.
    pub side_effect: &'static str,
    /// Where this kind's authority comes from.
    pub consent: &'static str,
    /// Every kind is ledger-covered; the field exists so a kind that was not
    /// would have to say so here (`manifest.ts:352`).
    pub ledger: bool,
}

/// v0's `AUTOMATION_TRIGGER_REGISTRY`, and the list the enumerability gate
/// reads.
pub const TRIGGER_REGISTRY: [TriggerContract; 5] = [
    TriggerContract {
        kind: TriggerKind::Cron,
        side_effect: "schedule",
        consent: "manifest-grant",
        ledger: true,
    },
    TriggerContract {
        kind: TriggerKind::Webhook,
        side_effect: "external-input",
        consent: "route-secret",
        ledger: true,
    },
    TriggerContract {
        kind: TriggerKind::Condition,
        side_effect: "vault-read",
        consent: "manifest-grant",
        ledger: true,
    },
    TriggerContract {
        kind: TriggerKind::Data,
        side_effect: "vault-read",
        consent: "manifest-grant",
        ledger: true,
    },
    TriggerContract {
        kind: TriggerKind::Event,
        side_effect: "provider-read",
        consent: "connection-binding",
        ledger: true,
    },
];

impl Trigger {
    #[must_use]
    pub const fn kind(&self) -> TriggerKind {
        match self {
            Self::Cron { .. } => TriggerKind::Cron,
            Self::Webhook(_) => TriggerKind::Webhook,
            Self::Condition { .. } => TriggerKind::Condition,
            Self::Data { .. } => TriggerKind::Data,
            Self::Event { .. } => TriggerKind::Event,
        }
    }

    /// The polling gate this trigger is evaluated on, when it has one.
    #[must_use]
    pub fn schedule_expr(&self) -> Option<&str> {
        match self {
            Self::Cron { expr, .. } => Some(expr),
            Self::Condition { every, .. } => {
                Some(every.as_deref().unwrap_or(CONDITION_DEFAULT_EVERY))
            }
            Self::Data { every, .. } => Some(every.as_deref().unwrap_or(DATA_DEFAULT_EVERY)),
            Self::Event { every, .. } => Some(every.as_deref().unwrap_or(EVENT_DEFAULT_EVERY)),
            Self::Webhook(_) => None,
        }
    }

    /// The cursor's stored `source_kind`.
    ///
    /// An `event` trigger's identity includes its connection and filter, so a
    /// trigger edited in place at the same index does not inherit a position
    /// that means nothing to its replacement (`cursor-engine-support.ts`
    /// `cursorIdentity`).
    #[must_use]
    pub fn cursor_identity(&self) -> String {
        match self {
            Self::Event {
                connector_kind,
                event,
                filter,
                ..
            } => format!(
                "event:{connector_kind}:{event}:{}",
                filter
                    .as_ref()
                    .map_or_else(|| "{}".to_owned(), ToString::to_string)
            ),
            other => other.kind().as_str().to_owned(),
        }
    }
}

/// The containment lane a handler asks for (`ManifestSandbox`).
///
/// A DECLARATION that only ever asks for MORE than the floor, and the floor is
/// an absent block. `system` is **not** spellable here: the parser accepts
/// exactly these two, and the system lane is reached by PROVENANCE
/// ([`crate::handler::provenance`]) and never by a manifest field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxLane {
    ModelRuntime,
    MediaTranscode,
}

impl SandboxLane {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ModelRuntime => "model-runtime",
            Self::MediaTranscode => "media-transcode",
        }
    }
}

/// The enrichment domain an `enrich` block names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnrichDomain {
    Photos,
    Docs,
}

impl EnrichDomain {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Photos => "photos",
            Self::Docs => "docs",
        }
    }
}

/// Which lane an enricher's work runs in. **An omitted lane reads as
/// [`EnrichLane::Gateway`]** — see [`crate::fire::enrich_gate`] for why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EnrichLane {
    Device,
    #[default]
    Gateway,
}

impl EnrichLane {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Device => "device",
            Self::Gateway => "gateway",
        }
    }
}

/// `manifest.enrich`: the declaration that makes an automation an ENRICHER
/// governed by `enrich_policy`.
#[derive(Debug, Clone, PartialEq)]
pub struct ManifestEnrich {
    pub domain: EnrichDomain,
    /// The stable capability id, and the CONSENT SCOPE an `enrich_request` is
    /// tagged with so consenting to one enricher does not enable the rest.
    pub capability: String,
    pub lane: EnrichLane,
}

/// `manifest.requires`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ManifestRequires {
    pub mcps: Vec<String>,
    /// An OPEN registry key: the manifest validates only that it is non-empty
    /// (`manifest.ts:47`–`:52`). The executing gateway decides whether the key
    /// is registered.
    pub harness: Option<String>,
    /// `provider/model-id`. The mock provider is refused: routing
    /// `ctx.delegate` at it would recurse into the mock stream.
    pub model: Option<String>,
    /// The ACP semantic `thought_level`, an open string by design.
    pub thought_level: Option<String>,
    /// `locker:<item>:<column>` references `ctx.fetch` may use. Preserved,
    /// and unreachable this wave — see the module header.
    pub secrets: Vec<String>,
}

/// When a run tells the member about itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Notify {
    Always,
    /// The default. A quiet success is not news.
    #[default]
    Failures,
    Never,
}

impl Notify {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Always => "always",
            Self::Failures => "failures",
            Self::Never => "never",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "always" => Some(Self::Always),
            "failures" => Some(Self::Failures),
            "never" => Some(Self::Never),
            _ => None,
        }
    }
}

/// The verbs a vault scope may ask for.
pub const VAULT_VERBS: [&str; 4] = ["read", "read+act", "act", "reveal"];

/// The vault filter operators a manifest scope may use.
pub const VAULT_FILTER_OPS: [&str; 10] = [
    "eq",
    "ne",
    "lt",
    "lte",
    "gt",
    "gte",
    "in",
    "is-null",
    "not-null",
    "within-days",
];

/// One requested scope. **A REQUEST the owner answers**, never a grant.
#[derive(Debug, Clone, PartialEq)]
pub struct VaultScope {
    pub schema: String,
    pub table: Option<String>,
    pub verbs: String,
    pub row_filter: Vec<WhereClause>,
    pub field_mask: Vec<String>,
}

/// `manifest.vault`: the access this automation asks for, and why.
#[derive(Debug, Clone, PartialEq)]
pub struct ManifestVault {
    pub why: Option<String>,
    /// Non-empty by construction: a vault block that asked for nothing would
    /// be a block the owner cannot answer.
    pub scopes: Vec<VaultScope>,
}

/// One bound provider connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionBinding {
    pub connection_id: String,
    pub kind: String,
    pub label: String,
}

/// Who wrote this manifest, and when. **Required**: an automation with no
/// provenance is one nobody can answer questions about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Generated {
    pub by: String,
    pub at: String,
}

/// One automation.
#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    pub name: String,
    /// `0.1.0` when absent — a version is how a member tells two copies apart,
    /// and the default is a real version rather than an empty string.
    pub version: String,
    pub description: Option<String>,
    /// Lives HERE, not in a table (`manifest.ts:10`–`:13`).
    pub enabled: bool,
    pub notify: Notify,
    /// The instructions, with `@[…]` anchors still in them
    /// ([`crate::anchor`]). **Required**: an automation with no prompt has
    /// nothing to run.
    pub prompt: String,
    pub triggers: Vec<Trigger>,
    pub requires: ManifestRequires,
    /// True when a `connector` block is declared. The block's own shape is the
    /// connectors lane's, and that lane is on the back burner — so this crate
    /// records its PRESENCE, which is all the four coupling rules need.
    pub connector: bool,
    pub connections: Vec<ConnectionBinding>,
    pub vault: Option<ManifestVault>,
    pub sandbox: Option<SandboxLane>,
    pub enrich: Option<ManifestEnrich>,
    pub generated: Generated,
}

impl Manifest {
    /// The cron triggers, in declaration order (`cronTriggersOf`).
    pub fn cron_triggers(&self) -> impl Iterator<Item = (&str, Option<&str>, Backfill)> {
        self.triggers.iter().filter_map(|trigger| match trigger {
            Trigger::Cron { expr, tz, backfill } => Some((expr.as_str(), tz.as_deref(), *backfill)),
            _ => None,
        })
    }

    /// The one webhook trigger, if it is provisioned.
    #[must_use]
    pub fn minted_webhook(&self) -> Option<(&str, &str)> {
        self.triggers.iter().find_map(|trigger| match trigger {
            Trigger::Webhook(WebhookState::Minted { id, secret_hash }) => {
                Some((id.as_str(), secret_hash.as_str()))
            }
            _ => None,
        })
    }

    /// True while a webhook trigger still awaits provisioning.
    #[must_use]
    pub fn has_pending_webhook(&self) -> bool {
        self.triggers
            .iter()
            .any(|trigger| matches!(trigger, Trigger::Webhook(WebhookState::Pending)))
    }
}

/// Why a manifest was refused. Each carries the FIELD, because a refusal
/// without a field makes an author read the whole file.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{field}: {detail}")]
pub struct ManifestError {
    pub code: ManifestErrorCode,
    pub field: String,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestErrorCode {
    NotJson,
    InvalidShape,
    InvalidTrigger,
    /// The watch-list refusal, kept as its own code so a surface can say
    /// "this entity cannot be watched" rather than "invalid trigger".
    DeniedWatch,
}

impl ManifestError {
    fn new(code: ManifestErrorCode, field: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            code,
            field: field.into(),
            detail: detail.into(),
        }
    }
}

/// Parse and validate `automation.json`.
pub fn parse(text: &str) -> Result<Manifest, ManifestError> {
    let raw: Value = serde_json::from_str(text).map_err(|error| {
        ManifestError::new(
            ManifestErrorCode::NotJson,
            "manifest",
            format!("automation.json is not JSON: {error}"),
        )
    })?;
    from_value(&raw)
}

/// Validate an already-parsed document.
pub fn from_value(raw: &Value) -> Result<Manifest, ManifestError> {
    let object = raw.as_object().ok_or_else(|| {
        ManifestError::new(
            ManifestErrorCode::InvalidShape,
            "manifest",
            "a manifest is a JSON object",
        )
    })?;
    let name = required_str(object, "name")?;
    let version = match object.get("version") {
        None | Some(Value::Null) => "0.1.0".to_owned(),
        Some(_) => required_str(object, "version")?,
    };
    let description = match object.get("description") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => {
            return Err(ManifestError::new(
                ManifestErrorCode::InvalidShape,
                "manifest.description",
                "description is a string",
            ));
        }
    };
    // `enabled` is TRUE unless it is exactly `false`, which is v0's
    // `r.enabled === true` inverted for the same reason: a truthy junk value
    // must not silently disable an automation.
    let enabled = object.get("enabled").map_or(true, |value| value != &Value::Bool(false));
    let notify = match object.get("notify") {
        None | Some(Value::Null) => Notify::default(),
        Some(value) => value
            .as_str()
            .and_then(Notify::parse)
            .ok_or_else(|| {
                ManifestError::new(
                    ManifestErrorCode::InvalidShape,
                    "manifest.notify",
                    "notify is one of always, failures, never",
                )
            })?,
    };
    let prompt = required_str(object, "prompt")?;

    let triggers_value = object.get("triggers").ok_or_else(|| {
        ManifestError::new(
            ManifestErrorCode::InvalidShape,
            "manifest.triggers",
            "a manifest declares a triggers array",
        )
    })?;
    let list = triggers_value.as_array().ok_or_else(|| {
        ManifestError::new(
            ManifestErrorCode::InvalidShape,
            "manifest.triggers",
            "triggers is an array",
        )
    })?;
    let mut triggers = Vec::with_capacity(list.len());
    for (index, entry) in list.iter().enumerate() {
        triggers.push(parse_trigger(entry, &format!("manifest.triggers[{index}]"))?);
    }
    // AT MOST ONE WEBHOOK (`manifest.ts:337`–`:342`): a second one would be a
    // second route slug for one handler, and the ingress lookup is by slug.
    if triggers
        .iter()
        .filter(|trigger| trigger.kind() == TriggerKind::Webhook)
        .count()
        > 1
    {
        return Err(ManifestError::new(
            ManifestErrorCode::InvalidTrigger,
            "manifest.triggers",
            "an automation may carry many cron triggers but at most one webhook",
        ));
    }

    let requires = parse_requires(object)?;
    let connector = object
        .get("connector")
        .is_some_and(|value| !value.is_null());
    let connections = parse_connections(object)?;
    let vault = parse_vault(object)?;
    let generated = parse_generated(object)?;

    // THE FOUR COUPLINGS. Each one is a manifest that type-checks and means
    // nothing it can carry out; see the module header.
    if connector && vault.is_none() {
        return Err(ManifestError::new(
            ManifestErrorCode::InvalidShape,
            "manifest.connector",
            "a connector stages rows into the vault, so it needs a manifest.vault block",
        ));
    }
    if !connector && !requires.secrets.is_empty() {
        return Err(ManifestError::new(
            ManifestErrorCode::InvalidShape,
            "manifest.requires.secrets",
            "requires.secrets is connector-only (#293) — a non-connector declaring them is a \
             manifest bug, not a latent capability",
        ));
    }
    if vault.is_none()
        && triggers.iter().any(|trigger| {
            matches!(trigger.kind(), TriggerKind::Condition | TriggerKind::Data)
        })
    {
        return Err(ManifestError::new(
            ManifestErrorCode::InvalidTrigger,
            "manifest.vault",
            "a condition or data trigger IS a consented vault read, and without a manifest.vault \
             block there is no grant to evaluate it under",
        ));
    }
    for trigger in &triggers {
        if let Trigger::Event {
            connector_kind,
            event,
            ..
        } = trigger
            && !connections
                .iter()
                .any(|binding| &binding.kind == connector_kind)
        {
            return Err(ManifestError::new(
                ManifestErrorCode::InvalidTrigger,
                "manifest.connections",
                format!(
                    "the \"{event}\" event trigger needs a bound \"{connector_kind}\" connection — \
                     a provider cursor with no connection is a subscription to nothing"
                ),
            ));
        }
    }

    Ok(Manifest {
        name,
        version,
        description,
        enabled,
        notify,
        prompt,
        triggers,
        requires,
        connector,
        connections,
        vault,
        sandbox: parse_sandbox(object)?,
        enrich: parse_enrich(object)?,
        generated,
    })
}

fn parse_connections(
    object: &serde_json::Map<String, Value>,
) -> Result<Vec<ConnectionBinding>, ManifestError> {
    let Some(value) = object.get("connections") else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let list = value.as_array().ok_or_else(|| {
        ManifestError::new(
            ManifestErrorCode::InvalidShape,
            "manifest.connections",
            "connections is an array",
        )
    })?;
    let mut out = Vec::with_capacity(list.len());
    for (index, entry) in list.iter().enumerate() {
        let field = format!("manifest.connections[{index}]");
        let binding = entry.as_object().ok_or_else(|| {
            ManifestError::new(
                ManifestErrorCode::InvalidShape,
                field.clone(),
                "a connection binding is an object",
            )
        })?;
        let pick = |key: &str| -> Result<String, ManifestError> {
            binding
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    ManifestError::new(
                        ManifestErrorCode::InvalidShape,
                        format!("{field}.{key}"),
                        "a required non-empty string is missing",
                    )
                })
        };
        out.push(ConnectionBinding {
            connection_id: pick("connectionId")?,
            kind: pick("kind")?,
            label: pick("label")?,
        });
    }
    Ok(out)
}

fn parse_vault(
    object: &serde_json::Map<String, Value>,
) -> Result<Option<ManifestVault>, ManifestError> {
    let Some(value) = object.get("vault") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let block = value.as_object().ok_or_else(|| {
        ManifestError::new(
            ManifestErrorCode::InvalidShape,
            "manifest.vault",
            "vault is an object",
        )
    })?;
    let why = match block.get("why") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => {
            return Err(ManifestError::new(
                ManifestErrorCode::InvalidShape,
                "manifest.vault.why",
                "why is a string",
            ));
        }
    };
    let list = block
        .get("scopes")
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
        .ok_or_else(|| {
            ManifestError::new(
                ManifestErrorCode::InvalidShape,
                "manifest.vault.scopes",
                "scopes is a non-empty array — a block that asked for nothing would be one the \
                 owner cannot answer",
            )
        })?;
    let mut scopes = Vec::with_capacity(list.len());
    for (index, entry) in list.iter().enumerate() {
        let field = format!("manifest.vault.scopes[{index}]");
        let scope = entry.as_object().ok_or_else(|| {
            ManifestError::new(
                ManifestErrorCode::InvalidShape,
                field.clone(),
                "a scope is an object",
            )
        })?;
        let schema = scope
            .get("schema")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ManifestError::new(
                    ManifestErrorCode::InvalidShape,
                    format!("{field}.schema"),
                    "a scope names its schema",
                )
            })?
            .to_owned();
        let verbs = scope
            .get("verbs")
            .and_then(Value::as_str)
            .filter(|value| VAULT_VERBS.contains(value))
            .ok_or_else(|| {
                ManifestError::new(
                    ManifestErrorCode::InvalidShape,
                    format!("{field}.verbs"),
                    format!("verbs is one of {}", VAULT_VERBS.join(", ")),
                )
            })?
            .to_owned();
        let table = match scope.get("table") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
            Some(_) => {
                return Err(ManifestError::new(
                    ManifestErrorCode::InvalidShape,
                    format!("{field}.table"),
                    "table is a non-empty string",
                ));
            }
        };
        let mut row_filter = Vec::new();
        if let Some(clauses) = scope.get("rowFilter").filter(|value| !value.is_null()) {
            let list = clauses
                .as_array()
                .filter(|list| !list.is_empty())
                .ok_or_else(|| {
                    ManifestError::new(
                        ManifestErrorCode::InvalidShape,
                        format!("{field}.rowFilter"),
                        "rowFilter is a non-empty array",
                    )
                })?;
            for (clause_index, clause) in list.iter().enumerate() {
                let clause_field = format!("{field}.rowFilter[{clause_index}]");
                let clause = clause.as_object().ok_or_else(|| {
                    ManifestError::new(
                        ManifestErrorCode::InvalidShape,
                        clause_field.clone(),
                        "a filter clause is an object",
                    )
                })?;
                let column = clause
                    .get("column")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        ManifestError::new(
                            ManifestErrorCode::InvalidShape,
                            format!("{clause_field}.column"),
                            "a filter clause names a column",
                        )
                    })?
                    .to_owned();
                let raw_op = clause
                    .get("op")
                    .and_then(Value::as_str)
                    .filter(|value| VAULT_FILTER_OPS.contains(value))
                    .ok_or_else(|| {
                        ManifestError::new(
                            ManifestErrorCode::InvalidShape,
                            format!("{clause_field}.op"),
                            format!(
                                "op is one of {}",
                                VAULT_FILTER_OPS.join(", ")
                            ),
                        )
                    })?;
                row_filter.push(WhereClause {
                    column,
                    op: ConditionOp::parse(raw_op).unwrap_or(ConditionOp::Eq),
                    value: clause.get("value").cloned(),
                });
            }
        }
        let mut field_mask: Vec<String> = Vec::new();
        if let Some(mask) = scope.get("fieldMask").filter(|value| !value.is_null()) {
            let list = mask
                .as_array()
                .filter(|list| !list.is_empty())
                .ok_or_else(|| {
                    ManifestError::new(
                        ManifestErrorCode::InvalidShape,
                        format!("{field}.fieldMask"),
                        "fieldMask is a non-empty array",
                    )
                })?;
            for entry in list {
                let column = entry
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        ManifestError::new(
                            ManifestErrorCode::InvalidShape,
                            format!("{field}.fieldMask"),
                            "a field mask is an array of column names",
                        )
                    })?;
                // A DUPLICATE IS REFUSED rather than deduped: a mask written
                // twice is a mask somebody edited without reading.
                if field_mask.iter().any(|existing| existing == column) {
                    return Err(ManifestError::new(
                        ManifestErrorCode::InvalidShape,
                        format!("{field}.fieldMask"),
                        "fieldMask must not repeat a column",
                    ));
                }
                field_mask.push(column.to_owned());
            }
        }
        // A NARROWING WITH NO TABLE IS NOT A NARROWING: a row filter or a field
        // mask at schema scope would silently apply to nothing.
        if (!row_filter.is_empty() || !field_mask.is_empty()) && table.is_none() {
            return Err(ManifestError::new(
                ManifestErrorCode::InvalidShape,
                format!("{field}.table"),
                "a rowFilter or a fieldMask narrows one table, so the table must be named",
            ));
        }
        scopes.push(VaultScope {
            schema,
            table,
            verbs,
            row_filter,
            field_mask,
        });
    }
    Ok(Some(ManifestVault { why, scopes }))
}

fn parse_generated(
    object: &serde_json::Map<String, Value>,
) -> Result<Generated, ManifestError> {
    let block = object
        .get("generated")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ManifestError::new(
                ManifestErrorCode::InvalidShape,
                "manifest.generated",
                "generated is an object naming who wrote this manifest and when",
            )
        })?;
    let pick = |key: &str| -> Result<String, ManifestError> {
        block
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| {
                ManifestError::new(
                    ManifestErrorCode::InvalidShape,
                    format!("manifest.generated.{key}"),
                    "a required non-empty string is missing",
                )
            })
    };
    Ok(Generated {
        by: pick("by")?,
        at: pick("at")?,
    })
}

fn parse_trigger(raw: &Value, field: &str) -> Result<Trigger, ManifestError> {
    let object = raw.as_object().ok_or_else(|| {
        ManifestError::new(
            ManifestErrorCode::InvalidTrigger,
            field,
            "a trigger is an object with a \"kind\"",
        )
    })?;
    let kind = object.get("kind").and_then(Value::as_str).ok_or_else(|| {
        ManifestError::new(
            ManifestErrorCode::InvalidTrigger,
            field,
            format!(
                "a trigger's \"kind\" is one of {}",
                TRIGGER_REGISTRY
                    .iter()
                    .map(|entry| entry.kind.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
    })?;
    match kind {
        "cron" => parse_cron(object, field),
        "webhook" => parse_webhook(object, field),
        "condition" => parse_condition(object, field),
        "data" => parse_data(object, field),
        "event" => parse_event(object, field),
        other => Err(ManifestError::new(
            ManifestErrorCode::InvalidTrigger,
            field,
            format!(
                "\"{other}\" is not a trigger kind this build carries ({})",
                TRIGGER_REGISTRY
                    .iter()
                    .map(|entry| entry.kind.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

fn parse_cron(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Trigger, ManifestError> {
    let expr = object.get("expr").and_then(Value::as_str).ok_or_else(|| {
        ManifestError::new(
            ManifestErrorCode::InvalidTrigger,
            format!("{field}.expr"),
            "a cron trigger needs a 5-field expression",
        )
    })?;
    if !cron::is_valid(expr) {
        return Err(ManifestError::new(
            ManifestErrorCode::InvalidTrigger,
            format!("{field}.expr"),
            format!("\"{expr}\" is not a valid 5-field cron expression"),
        ));
    }
    // UNKNOWN ZONES ARE REFUSED HERE, NOT AT FIRE TIME
    // (`docs/cron-timezone.md` Validation). A fire-time rejection is a
    // silently dead automation: nothing is watching the log at 07:00.
    let tz = match object.get("tz") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let name = value.as_str().ok_or_else(|| {
                ManifestError::new(
                    ManifestErrorCode::InvalidTrigger,
                    format!("{field}.tz"),
                    "tz is an IANA time-zone name",
                )
            })?;
            cron::FireZone::named(name).map_err(|error| {
                ManifestError::new(
                    ManifestErrorCode::InvalidTrigger,
                    format!("{field}.tz"),
                    error.to_string(),
                )
            })?;
            Some(name.trim().to_owned())
        }
    };
    let backfill = match object.get("backfill") {
        None | Some(Value::Null) => Backfill::default(),
        Some(value) => value.as_str().and_then(Backfill::parse).ok_or_else(|| {
            ManifestError::new(
                ManifestErrorCode::InvalidTrigger,
                format!("{field}.backfill"),
                "backfill is one of latest, each",
            )
        })?,
    };
    Ok(Trigger::Cron {
        expr: expr.trim().to_owned(),
        tz,
        backfill,
    })
}

fn parse_webhook(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Trigger, ManifestError> {
    let has_id = object.contains_key("id");
    let has_hash = object.contains_key("secretHash");
    if !has_id && !has_hash {
        if object.get("pending").and_then(Value::as_bool) == Some(true) {
            return Ok(Trigger::Webhook(WebhookState::Pending));
        }
        return Err(ManifestError::new(
            ManifestErrorCode::InvalidTrigger,
            field,
            "a webhook trigger needs a minted \"id\" + \"secretHash\", or \"pending\": true",
        ));
    }
    let id = object.get("id").and_then(Value::as_str).ok_or_else(|| {
        ManifestError::new(
            ManifestErrorCode::InvalidTrigger,
            format!("{field}.id"),
            "a provisioned webhook carries its route id",
        )
    })?;
    if !is_valid_webhook_id(id) {
        return Err(ManifestError::new(
            ManifestErrorCode::InvalidTrigger,
            format!("{field}.id"),
            format!("\"{id}\" is not a valid webhook route slug"),
        ));
    }
    let secret_hash = object
        .get("secretHash")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ManifestError::new(
                ManifestErrorCode::InvalidTrigger,
                format!("{field}.secretHash"),
                "a provisioned webhook carries the SHA-256 of its secret, never the secret",
            )
        })?;
    if secret_hash.len() != 64 || !secret_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ManifestError::new(
            ManifestErrorCode::InvalidTrigger,
            format!("{field}.secretHash"),
            "secretHash is 64 hex characters — the SHA-256 of a secret shown once",
        ));
    }
    Ok(Trigger::Webhook(WebhookState::Minted {
        id: id.to_owned(),
        secret_hash: secret_hash.to_ascii_lowercase(),
    }))
}

fn parse_condition(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Trigger, ManifestError> {
    let entity = object
        .get("entity")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ManifestError::new(
                ManifestErrorCode::InvalidTrigger,
                format!("{field}.entity"),
                "a condition trigger names one <schema>.<table> entity",
            )
        })?;
    let watchable = resolve_watchable(entity, &format!("{field}.entity"))?;
    let every = parse_every(object, field)?;
    let clauses = match object.get("where") {
        None | Some(Value::Null) => Vec::new(),
        Some(value) => {
            let list = value.as_array().ok_or_else(|| {
                ManifestError::new(
                    ManifestErrorCode::InvalidTrigger,
                    format!("{field}.where"),
                    "where is an array of {column, op, value?} clauses",
                )
            })?;
            let mut clauses = Vec::with_capacity(list.len());
            for (index, entry) in list.iter().enumerate() {
                let clause_field = format!("{field}.where[{index}]");
                let clause = entry.as_object().ok_or_else(|| {
                    ManifestError::new(
                        ManifestErrorCode::InvalidTrigger,
                        clause_field.clone(),
                        "a where clause is an object",
                    )
                })?;
                let column = clause
                    .get("column")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ManifestError::new(
                            ManifestErrorCode::InvalidTrigger,
                            format!("{clause_field}.column"),
                            "a where clause names a column",
                        )
                    })?;
                let op = clause
                    .get("op")
                    .and_then(Value::as_str)
                    .and_then(ConditionOp::parse)
                    .ok_or_else(|| {
                        ManifestError::new(
                            ManifestErrorCode::InvalidTrigger,
                            format!("{clause_field}.op"),
                            format!(
                                "op is one of {}",
                                ConditionOp::ALL
                                    .iter()
                                    .map(|op| op.as_str())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ),
                        )
                    })?;
                clauses.push(WhereClause {
                    column: column.to_owned(),
                    op,
                    value: clause.get("value").cloned(),
                });
            }
            clauses
        }
    };
    Ok(Trigger::Condition {
        entity: watchable,
        clauses,
        every,
    })
}

fn parse_data(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Trigger, ManifestError> {
    let list = object
        .get("entities")
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
        .ok_or_else(|| {
            ManifestError::new(
                ManifestErrorCode::InvalidTrigger,
                format!("{field}.entities"),
                "entities is a non-empty array of <schema>.<table> names",
            )
        })?;
    let mut entities = Vec::with_capacity(list.len());
    let mut seen = BTreeSet::new();
    for (index, entry) in list.iter().enumerate() {
        let entity_field = format!("{field}.entities[{index}]");
        let name = entry.as_str().ok_or_else(|| {
            ManifestError::new(
                ManifestErrorCode::InvalidTrigger,
                entity_field.clone(),
                "an entity name is a string",
            )
        })?;
        let watchable = resolve_watchable(name, &entity_field)?;
        // A repeated entity would read the same feed twice per gate and
        // deliver each change as two elements.
        if !seen.insert(watchable.logical().to_owned()) {
            return Err(ManifestError::new(
                ManifestErrorCode::InvalidTrigger,
                entity_field,
                format!("\"{name}\" is watched twice by this trigger"),
            ));
        }
        entities.push(watchable);
    }
    Ok(Trigger::Data {
        entities,
        every: parse_every(object, field)?,
    })
}

/// The provider events this build carries (`EVENT_TRIGGER_CATALOG`).
///
/// A CLOSED catalogue: the adapters interpret `event` + `filter` and the engine
/// sees only an ordered cursor. Connectors are on the back burner (owner,
/// 2026-09-12), so no adapter exists — the catalogue is kept because it is the
/// vocabulary a manifest is validated against, and a manifest accepted now
/// against a wider list would fire against nothing later.
pub const EVENT_CATALOG: [(&str, &[&str]); 2] = [
    ("pull.gmail", &["new-message"]),
    ("pull.github", &["pull-request", "issue"]),
];

fn parse_event(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Trigger, ManifestError> {
    let connector_kind = object
        .get("connectorKind")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ManifestError::new(
                ManifestErrorCode::InvalidTrigger,
                format!("{field}.connectorKind"),
                "an event trigger names the connector kind it binds to",
            )
        })?;
    let event = object.get("event").and_then(Value::as_str).ok_or_else(|| {
        ManifestError::new(
            ManifestErrorCode::InvalidTrigger,
            format!("{field}.event"),
            "an event trigger names a provider event",
        )
    })?;
    let supported = EVENT_CATALOG
        .iter()
        .find(|(kind, _)| *kind == connector_kind)
        .map(|(_, events)| *events);
    if !supported.is_some_and(|events| events.contains(&event)) {
        return Err(ManifestError::new(
            ManifestErrorCode::InvalidTrigger,
            format!("{field}.event"),
            format!("\"{connector_kind}:{event}\" is not a provider event this build carries"),
        ));
    }
    let filter = match object.get("filter") {
        None | Some(Value::Null) => None,
        Some(value) if value.is_object() => Some(value.clone()),
        Some(_) => {
            return Err(ManifestError::new(
                ManifestErrorCode::InvalidTrigger,
                format!("{field}.filter"),
                "filter is an object",
            ));
        }
    };
    Ok(Trigger::Event {
        connector_kind: connector_kind.to_owned(),
        event: event.to_owned(),
        filter,
        every: parse_every(object, field)?,
    })
}

fn parse_every(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<String>, ManifestError> {
    match object.get("every") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let expr = value.as_str().ok_or_else(|| {
                ManifestError::new(
                    ManifestErrorCode::InvalidTrigger,
                    format!("{field}.every"),
                    "every is a 5-field cron expression",
                )
            })?;
            if !cron::is_valid(expr) {
                return Err(ManifestError::new(
                    ManifestErrorCode::InvalidTrigger,
                    format!("{field}.every"),
                    format!("\"{expr}\" is not a valid 5-field cron expression"),
                ));
            }
            Ok(Some(expr.trim().to_owned()))
        }
    }
}

/// The one door from a manifest string to a [`Watchable`]. Every refusal is
/// carried through with its own code, so a surface can distinguish "you named
/// a table you may not watch" from "your trigger is malformed".
fn resolve_watchable(entity: &str, field: &str) -> Result<Watchable, ManifestError> {
    Watchable::resolve(entity).map_err(|refusal| {
        let code = match refusal {
            WatchRefusal::Unregistered { .. } => ManifestErrorCode::DeniedWatch,
            WatchRefusal::Machinery { .. } | WatchRefusal::Local { .. } => {
                ManifestErrorCode::DeniedWatch
            }
        };
        ManifestError::new(code, field, refusal.to_string())
    })
}

fn parse_requires(
    object: &serde_json::Map<String, Value>,
) -> Result<ManifestRequires, ManifestError> {
    let Some(value) = object.get("requires") else {
        return Ok(ManifestRequires::default());
    };
    if value.is_null() {
        return Ok(ManifestRequires::default());
    }
    let requires = value.as_object().ok_or_else(|| {
        ManifestError::new(
            ManifestErrorCode::InvalidShape,
            "manifest.requires",
            "requires is an object",
        )
    })?;
    let strings = |key: &str| -> Result<Vec<String>, ManifestError> {
        match requires.get(key) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| {
                    item.as_str().map(str::to_owned).ok_or_else(|| {
                        ManifestError::new(
                            ManifestErrorCode::InvalidShape,
                            format!("manifest.requires.{key}"),
                            "an array of strings",
                        )
                    })
                })
                .collect(),
            Some(_) => Err(ManifestError::new(
                ManifestErrorCode::InvalidShape,
                format!("manifest.requires.{key}"),
                "an array of strings",
            )),
        }
    };
    let optional = |key: &str| -> Result<Option<String>, ManifestError> {
        match requires.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) if !text.trim().is_empty() => {
                Ok(Some(text.trim().to_owned()))
            }
            Some(_) => Err(ManifestError::new(
                ManifestErrorCode::InvalidShape,
                format!("manifest.requires.{key}"),
                "a non-empty string",
            )),
        }
    };
    let model = optional("model")?;
    if let Some(model) = &model
        && model.starts_with("centraid-mock/")
    {
        return Err(ManifestError::new(
            ManifestErrorCode::InvalidShape,
            "manifest.requires.model",
            "the mock provider cannot back ctx.delegate — a delegate routed at it recurses into \
             the mock stream",
        ));
    }
    let secrets = strings("secrets")?;
    for reference in &secrets {
        if !is_valid_locker_ref(reference) {
            return Err(ManifestError::new(
                ManifestErrorCode::InvalidShape,
                "manifest.requires.secrets",
                format!(
                    "\"{reference}\" is not a locker reference (locker:<item>:<column> or \
                     locker:@<alias>:<column>)"
                ),
            ));
        }
    }
    Ok(ManifestRequires {
        mcps: strings("mcps")?,
        harness: optional("harness")?,
        model,
        thought_level: optional("thoughtLevel")?,
        secrets,
    })
}

fn parse_sandbox(
    object: &serde_json::Map<String, Value>,
) -> Result<Option<SandboxLane>, ManifestError> {
    let Some(value) = object.get("sandbox") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let lane = value
        .as_object()
        .and_then(|sandbox| sandbox.get("lane"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ManifestError::new(
                ManifestErrorCode::InvalidShape,
                "manifest.sandbox.lane",
                "a sandbox block names its lane",
            )
        })?;
    match lane {
        "model-runtime" => Ok(Some(SandboxLane::ModelRuntime)),
        "media-transcode" => Ok(Some(SandboxLane::MediaTranscode)),
        // "system" IS NOT SPELLABLE (`docs/recognition-automations.md:17`): the
        // parent decides the lane at fire time from the automation's id, and a
        // system automation's own `sandbox.lane` is not consulted at all.
        other => Err(ManifestError::new(
            ManifestErrorCode::InvalidShape,
            "manifest.sandbox.lane",
            format!(
                "\"{other}\" is not a sandbox lane a manifest may ask for (model-runtime, \
                 media-transcode) — the system lane is decided by provenance and never declared"
            ),
        )),
    }
}

fn parse_enrich(
    object: &serde_json::Map<String, Value>,
) -> Result<Option<ManifestEnrich>, ManifestError> {
    let Some(value) = object.get("enrich") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let enrich = value.as_object().ok_or_else(|| {
        ManifestError::new(
            ManifestErrorCode::InvalidShape,
            "manifest.enrich",
            "enrich is an object",
        )
    })?;
    let domain = match enrich.get("domain").and_then(Value::as_str) {
        Some("photos") => EnrichDomain::Photos,
        Some("docs") => EnrichDomain::Docs,
        _ => {
            return Err(ManifestError::new(
                ManifestErrorCode::InvalidShape,
                "manifest.enrich.domain",
                "domain is one of photos, docs",
            ));
        }
    };
    let capability = enrich
        .get("capability")
        .and_then(Value::as_str)
        .filter(|value| (1..=64).contains(&value.len()))
        .ok_or_else(|| {
            ManifestError::new(
                ManifestErrorCode::InvalidShape,
                "manifest.enrich.capability",
                "capability is a stable id of 1 to 64 characters",
            )
        })?
        .to_owned();
    // AN OMITTED LANE READS AS `gateway`. Assuming the cheaper lane would be
    // assuming consent (`enrich-gate.ts:1`–`:39`).
    let lane = match enrich.get("lane").and_then(Value::as_str) {
        None => EnrichLane::default(),
        Some("device") => EnrichLane::Device,
        Some("gateway" | "model") => EnrichLane::Gateway,
        Some(other) => {
            return Err(ManifestError::new(
                ManifestErrorCode::InvalidShape,
                "manifest.enrich.lane",
                format!("\"{other}\" is not an enrichment lane (device, gateway)"),
            ));
        }
    };
    Ok(Some(ManifestEnrich {
        domain,
        capability,
        lane,
    }))
}

fn required_str(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, ManifestError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
        .ok_or_else(|| {
            ManifestError::new(
                ManifestErrorCode::InvalidShape,
                format!("manifest.{key}"),
                "a required non-empty string is missing",
            )
        })
}

fn is_valid_webhook_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// `locker:<item_id>:<column>` or the rotation-stable `locker:@<alias>:<column>`.
fn is_valid_locker_ref(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("locker:") else {
        return false;
    };
    let Some((subject, column)) = rest.rsplit_once(':') else {
        return false;
    };
    let column_ok = !column.is_empty()
        && column
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_');
    if !column_ok {
        return false;
    }
    match subject.strip_prefix('@') {
        Some(alias) => {
            (1..=64).contains(&alias.len())
                && alias.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' || byte == b'-'
                })
        }
        None => !subject.is_empty() && !subject.contains(':') && !subject.starts_with('@'),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The smallest legal manifest, as a base every case varies.
    fn document(extra: &str) -> String {
        format!(
            r#"{{"name":"Morning digest","prompt":"summarise yesterday",
               "generated":{{"by":"builder","at":"2026-01-01T00:00:00.000Z"}}{extra}}}"#
        )
    }

    fn with_triggers(triggers: &str) -> String {
        document(&format!(r#","triggers":{triggers}"#))
    }

    /// A vault block wide enough for a condition or data trigger.
    const VAULT_BLOCK: &str = r#","vault":{"why":"to reconcile","scopes":[{"schema":"core","verbs":"read"}]}"#;

    #[test]
    fn the_registry_carries_every_kind_exactly_once_with_its_side_effect() {
        assert_eq!(TRIGGER_REGISTRY.len(), 5);
        let mut kinds: Vec<TriggerKind> = TRIGGER_REGISTRY.iter().map(|entry| entry.kind).collect();
        kinds.sort_unstable();
        kinds.dedup();
        assert_eq!(kinds.len(), 5, "five kinds, no duplicates");
        for entry in TRIGGER_REGISTRY {
            assert!(!entry.side_effect.is_empty());
            assert!(!entry.consent.is_empty());
            assert!(entry.ledger, "{} must be ledger-covered", entry.kind.as_str());
        }
    }

    #[test]
    fn the_five_kinds_parse() {
        let text = document(&format!(
            r#","triggers":[
              {{"kind":"cron","expr":"0 7 * * *","tz":"Asia/Kolkata","backfill":"each"}},
              {{"kind":"webhook","pending":true}},
              {{"kind":"condition","entity":"core.transaction",
                "where":[{{"column":"amount","op":"gt","value":100}}]}},
              {{"kind":"data","entities":["core.document","media.asset"],"every":"*/2 * * * *"}},
              {{"kind":"event","connectorKind":"pull.gmail","event":"new-message"}}
            ]{VAULT_BLOCK},
            "connections":[{{"connectionId":"c1","kind":"pull.gmail","label":"Inbox"}}]"#
        ));
        let manifest = parse(&text).expect("the five kinds are legal");
        assert_eq!(manifest.triggers.len(), 5);
        assert!(manifest.enabled, "an absent `enabled` reads as on");
        assert_eq!(manifest.notify, Notify::Failures, "a quiet success is not news");
        assert_eq!(manifest.version, "0.1.0", "an absent version is a real one");
        assert_eq!(manifest.prompt, "summarise yesterday");
        assert_eq!(manifest.generated.by, "builder");
        assert_eq!(
            manifest.triggers[0],
            Trigger::Cron {
                expr: "0 7 * * *".to_owned(),
                tz: Some("Asia/Kolkata".to_owned()),
                backfill: Backfill::Each,
            }
        );
        assert!(manifest.has_pending_webhook());
        assert_eq!(manifest.minted_webhook(), None);
        assert_eq!(manifest.triggers[3].schedule_expr(), Some("*/2 * * * *"));
        assert_eq!(
            manifest.triggers[2].schedule_expr(),
            Some(CONDITION_DEFAULT_EVERY),
            "an absent gate is the default, resolved once"
        );
        assert_eq!(manifest.triggers[1].schedule_expr(), None);
        assert_eq!(
            manifest.triggers[4].cursor_identity(),
            "event:pull.gmail:new-message:{}",
            "an event cursor's identity carries its binding"
        );
        assert_eq!(manifest.vault.expect("a block").scopes.len(), 1);
    }

    /// THE STRUCTURAL WATCH LIST, through the manifest door.
    #[test]
    fn a_data_trigger_on_a_ledger_table_refuses_with_its_field() {
        for entity in [
            "automation_trigger_cursor",
            "trigger_ingress",
            "conversations",
            "ledger.turns",
            "outbox.item",
            "enrich.derivation",
        ] {
            let text = document(&format!(
                r#","triggers":[{{"kind":"data","entities":["{entity}"]}}]{VAULT_BLOCK}"#
            ));
            let error = parse(&text).expect_err("a loop-sensitive entity is refused");
            assert_eq!(error.code, ManifestErrorCode::DeniedWatch, "{entity}");
            assert_eq!(error.field, "manifest.triggers[0].entities[0]");
        }
        let text = document(&format!(
            r#","triggers":[{{"kind":"condition","entity":"trigger_ingress"}}]{VAULT_BLOCK}"#
        ));
        let error = parse(&text).expect_err("a condition trigger is guarded too");
        assert_eq!(error.code, ManifestErrorCode::DeniedWatch);
        assert_eq!(error.field, "manifest.triggers[0].entity");
    }

    #[test]
    fn a_pending_webhook_round_trips_and_a_half_minted_one_refuses() {
        assert!(parse(&with_triggers(r#"[{"kind":"webhook","pending":true}]"#)).is_ok());
        // Neither id nor hash and not pending: refused.
        assert_eq!(
            parse(&with_triggers(r#"[{"kind":"webhook"}]"#))
                .expect_err("a bare webhook is not a state")
                .code,
            ManifestErrorCode::InvalidTrigger
        );
        // An id with no hash: refused, and it is the HASH that is named.
        assert_eq!(
            parse(&with_triggers(r#"[{"kind":"webhook","id":"abc123"}]"#))
                .expect_err("half-minted")
                .field,
            "manifest.triggers[0].secretHash"
        );
        let minted = with_triggers(&format!(
            r#"[{{"kind":"webhook","id":"abc123","secretHash":"{}"}}]"#,
            "a".repeat(64)
        ));
        let manifest = parse(&minted).expect("a minted webhook");
        assert_eq!(manifest.minted_webhook().expect("minted").0, "abc123");
        assert!(!manifest.has_pending_webhook());
        // A secret where a hash belongs is refused by LENGTH, so a manifest
        // cannot carry a plaintext secret that happens to look like one.
        assert!(
            parse(&with_triggers(
                r#"[{"kind":"webhook","id":"abc123","secretHash":"hunter2"}]"#
            ))
            .is_err()
        );
    }

    #[test]
    fn at_most_one_webhook() {
        let text = with_triggers(
            r#"[{"kind":"webhook","pending":true},{"kind":"webhook","pending":true}]"#,
        );
        assert_eq!(
            parse(&text).expect_err("two webhooks").field,
            "manifest.triggers"
        );
    }

    #[test]
    fn an_unknown_zone_is_refused_at_validation_and_not_at_fire_time() {
        let text = with_triggers(r#"[{"kind":"cron","expr":"0 7 * * *","tz":"Mars/Olympus"}]"#);
        let error = parse(&text).expect_err("an unknown zone");
        assert_eq!(error.field, "manifest.triggers[0].tz");
        assert!(error.detail.contains("Mars/Olympus"), "{}", error.detail);
    }

    #[test]
    fn the_backfill_default_is_latest_and_unknown_classes_refuse() {
        let manifest = parse(&with_triggers(r#"[{"kind":"cron","expr":"0 7 * * *"}]"#))
            .expect("no class declared");
        assert_eq!(
            manifest.cron_triggers().next().expect("one").2,
            Backfill::Latest
        );
        assert!(
            parse(&with_triggers(
                r#"[{"kind":"cron","expr":"0 7 * * *","backfill":"all"}]"#
            ))
            .is_err()
        );
    }

    #[test]
    fn the_system_sandbox_lane_is_not_spellable() {
        let error = parse(&document(r#","triggers":[],"sandbox":{"lane":"system"}"#))
            .expect_err("system is decided by provenance");
        assert_eq!(error.field, "manifest.sandbox.lane");
        assert!(error.detail.contains("provenance"), "{}", error.detail);
        for lane in ["model-runtime", "media-transcode"] {
            let text = document(&format!(r#","triggers":[],"sandbox":{{"lane":"{lane}"}}"#));
            assert!(parse(&text).is_ok(), "{lane}");
        }
    }

    #[test]
    fn an_omitted_enrich_lane_reads_as_gateway() {
        let text =
            document(r#","triggers":[],"enrich":{"domain":"photos","capability":"faces"}"#);
        let manifest = parse(&text).expect("an enricher");
        let enrich = manifest.enrich.expect("the block");
        assert_eq!(
            enrich.lane,
            EnrichLane::Gateway,
            "assuming the cheaper lane would be assuming consent"
        );
        assert_eq!(EnrichLane::default(), EnrichLane::Gateway);
    }

    #[test]
    fn the_mock_provider_cannot_back_a_delegate() {
        assert_eq!(
            parse(&document(
                r#","triggers":[],"requires":{"model":"centraid-mock/echo"}"#
            ))
            .expect_err("the mock recurses")
            .field,
            "manifest.requires.model"
        );
        let manifest = parse(&document(
            r#","triggers":[],"requires":{"model":"anthropic/some-model","harness":"codex",
                "mcps":["github"]}"#,
        ))
        .expect("a legal requires block");
        assert_eq!(manifest.requires.harness.as_deref(), Some("codex"));
    }

    /// COUPLING 3: `requires.secrets` is connector-only (#293).
    #[test]
    fn secrets_are_connector_only() {
        let error = parse(&document(
            r#","triggers":[],"requires":{"secrets":["locker:@bank:password"]}"#,
        ))
        .expect_err("a non-connector declaring secrets");
        assert_eq!(error.field, "manifest.requires.secrets");
        assert!(error.detail.contains("connector-only"), "{}", error.detail);
        // With a connector block and a vault block, they are legal.
        let text = document(&format!(
            r#","triggers":[],"connector":{{"kind":"pull.gmail"}},
               "requires":{{"secrets":["locker:@bank:password","locker:item-1:api_key"]}}{VAULT_BLOCK}"#
        ));
        let manifest = parse(&text).expect("a connector may");
        assert_eq!(manifest.requires.secrets.len(), 2);
        assert!(manifest.connector);
    }

    #[test]
    fn a_malformed_locker_reference_refuses() {
        for reference in ["bank:password", "locker:bank", "locker:@:password", "locker::x"] {
            let text = document(&format!(
                r#","triggers":[],"connector":{{"kind":"x"}},
                   "requires":{{"secrets":["{reference}"]}}{VAULT_BLOCK}"#
            ));
            assert!(parse(&text).is_err(), "{reference}");
        }
    }

    /// COUPLING 4: a connector stages rows, so it needs a vault block.
    #[test]
    fn a_connector_with_no_vault_block_refuses() {
        let error = parse(&document(r#","triggers":[],"connector":{"kind":"pull.gmail"}"#))
            .expect_err("a connector with nowhere to stage");
        assert_eq!(error.field, "manifest.connector");
    }

    /// COUPLING 1: a condition or data trigger IS a consented vault read.
    #[test]
    fn a_condition_or_data_trigger_with_no_vault_block_refuses() {
        for triggers in [
            r#"[{"kind":"condition","entity":"core.transaction"}]"#,
            r#"[{"kind":"data","entities":["core.document"]}]"#,
        ] {
            let error = parse(&with_triggers(triggers)).expect_err("no grant to read under");
            assert_eq!(error.field, "manifest.vault", "{triggers}");
            assert!(error.detail.contains("consented vault read"), "{}", error.detail);
        }
    }

    /// COUPLING 2: an event trigger needs a bound connection of its kind.
    #[test]
    fn an_event_trigger_with_no_bound_connection_refuses() {
        let text = with_triggers(
            r#"[{"kind":"event","connectorKind":"pull.gmail","event":"new-message"}]"#,
        );
        let error = parse(&text).expect_err("a subscription to nothing");
        assert_eq!(error.field, "manifest.connections");
        // A binding of ANOTHER kind is not a binding for this one.
        let wrong = document(
            r#","triggers":[{"kind":"event","connectorKind":"pull.gmail","event":"new-message"}],
               "connections":[{"connectionId":"c1","kind":"pull.github","label":"Repos"}]"#,
        );
        assert!(parse(&wrong).is_err());
    }

    #[test]
    fn an_unknown_provider_event_refuses_even_though_connectors_are_unbuilt() {
        assert!(
            parse(&with_triggers(
                r#"[{"kind":"event","connectorKind":"pull.gmail","event":"deleted-message"}]"#
            ))
            .is_err()
        );
        assert!(
            parse(&with_triggers(
                r#"[{"kind":"event","connectorKind":"pull.dropbox","event":"new-message"}]"#
            ))
            .is_err()
        );
    }

    #[test]
    fn an_entity_watched_twice_refuses() {
        let text = document(&format!(
            r#","triggers":[{{"kind":"data","entities":["core.document","core.document"]}}]{VAULT_BLOCK}"#
        ));
        assert!(parse(&text).is_err());
    }

    /// The vault block's own narrowing rules.
    #[test]
    fn a_narrowing_with_no_table_is_not_a_narrowing() {
        let text = document(
            r#","triggers":[],"vault":{"scopes":[{"schema":"core","verbs":"read",
               "fieldMask":["title"]}]}"#,
        );
        let error = parse(text.as_str()).expect_err("a mask at schema scope");
        assert_eq!(error.field, "manifest.vault.scopes[0].table");
        // Named, it is legal.
        let named = document(
            r#","triggers":[],"vault":{"scopes":[{"schema":"core","table":"document",
               "verbs":"read","fieldMask":["title","body"],
               "rowFilter":[{"column":"document_id","op":"in","value":["d1"]}]}]}"#,
        );
        let manifest = parse(&named).expect("a narrow scope");
        let scope = &manifest.vault.expect("a block").scopes[0];
        assert_eq!(scope.field_mask, ["title", "body"]);
        assert_eq!(scope.row_filter.len(), 1);
        assert_eq!(scope.row_filter[0].op, ConditionOp::In);
        // A repeated column in a mask is refused rather than deduped.
        let repeated = document(
            r#","triggers":[],"vault":{"scopes":[{"schema":"core","table":"document",
               "verbs":"read","fieldMask":["title","title"]}]}"#,
        );
        assert!(parse(&repeated).is_err());
        // An empty scope list is refused: the owner cannot answer it.
        assert!(parse(&document(r#","triggers":[],"vault":{"scopes":[]}"#)).is_err());
        // And an unknown verb is refused with the list.
        let verb = document(
            r#","triggers":[],"vault":{"scopes":[{"schema":"core","verbs":"write"}]}"#,
        );
        let error = parse(&verb).expect_err("write is not a vault verb");
        assert!(error.detail.contains("read+act"), "{}", error.detail);
    }

    #[test]
    fn provenance_and_the_prompt_are_required() {
        // No `generated` block: refused.
        let error = parse(
            r#"{"name":"X","prompt":"do it","triggers":[]}"#,
        )
        .expect_err("no provenance");
        assert_eq!(error.field, "manifest.generated");
        // No prompt: refused.
        let error = parse(
            r#"{"name":"X","triggers":[],"generated":{"by":"b","at":"t"}}"#,
        )
        .expect_err("nothing to run");
        assert_eq!(error.field, "manifest.prompt");
        // A generated block missing half of itself.
        let error = parse(
            r#"{"name":"X","prompt":"p","triggers":[],"generated":{"by":"b"}}"#,
        )
        .expect_err("half a provenance");
        assert_eq!(error.field, "manifest.generated.at");
    }

    #[test]
    fn notify_is_a_closed_vocabulary_and_enabled_only_false_disables() {
        for (value, expected) in [
            ("always", Notify::Always),
            ("failures", Notify::Failures),
            ("never", Notify::Never),
        ] {
            let text = document(&format!(r#","triggers":[],"notify":"{value}""#));
            assert_eq!(parse(&text).expect("legal").notify, expected);
        }
        assert!(parse(&document(r#","triggers":[],"notify":"sometimes"#)).is_err());
        // ONLY an explicit `false` disables: a truthy junk value must not
        // silently switch an automation off.
        assert!(!parse(&document(r#","triggers":[],"enabled":false"#))
            .expect("legal")
            .enabled);
        assert!(parse(&document(r#","triggers":[],"enabled":true"#))
            .expect("legal")
            .enabled);
        assert!(parse(&document(r#","triggers":[],"enabled":"yes""#))
            .expect("legal")
            .enabled);
    }

    #[test]
    fn a_document_that_is_not_json_says_so() {
        assert_eq!(
            parse("{not json").expect_err("not JSON").code,
            ManifestErrorCode::NotJson
        );
        assert_eq!(
            parse("[]").expect_err("not an object").code,
            ManifestErrorCode::InvalidShape
        );
        assert_eq!(
            parse(r#"{"name":"X","prompt":"p","generated":{"by":"b","at":"t"}}"#)
                .expect_err("no triggers")
                .field,
            "manifest.triggers"
        );
        assert_eq!(
            parse(r#"{"prompt":"p","triggers":[],"generated":{"by":"b","at":"t"}}"#)
                .expect_err("no name")
                .field,
            "manifest.name"
        );
    }
}
