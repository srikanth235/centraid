//! THE APP MANIFEST (`app.json`), and the three cross-cuts a schema cannot
//! express.
//!
//! `MANIFEST_VERSION` is 1 and is checked **before** anything else, so a
//! future incompatible manifest fails loudly rather than reading as an old
//! one.
//!
//! What Ajv did there, serde's types do here. What only a second pass can say is
//! kept as a second pass:
//!
//! 1. **Reserved names.** Anything starting `_` is refused for both actions and
//!    queries, because `_`-prefixed names dispatch to built-ins
//!    (`manifest.ts:26`, `:471`, `:488`).
//! 2. **Duplicate handler names**, per list. One name may appear in *both*
//!    actions and queries — two different tools — but two actions with one name
//!    would let the dispatcher silently pick one (`manifest.ts:464`).
//! 3. **`states` is a closed partition** over the seven canonical states, each
//!    claimed exactly once across the two sides (`manifest.ts:508-537`). A
//!    manifest that forgets a state fails validation instead of reading as "it
//!    does not apply here".
//! 4. **No action declares `writes`** (V3 in `docs/release/v1-handoffs.md`).
//!    v0 required each action to list the tables it wrote, so that change-stream
//!    invalidation could not drop a subscriber. The vault now says what a commit
//!    wrote itself: the commit guard's `update_hook` census, carried as
//!    `CommandOutcome.tables` and turned into the change events. A declared copy
//!    has no reader and can only drift, so the parser refuses the key — `[]`
//!    included — rather than carry a second copy of a fact the vault already
//!    reports.
//! 5. **Every action and query is classified for the conversation surface**
//!    ([#1135](https://github.com/srikanth235/centraid/issues/1135)). An action
//!    names the chat `verb` it is (`edit`, or `edit:cadence` when it edits one
//!    field of its kind: the part after the colon is its `qualifier`, the form a
//!    Locker card writes `<action>:<column>`), the `kind` it acts on, its
//!    `inverse` (the action that takes it back; an edit is its own inverse, run
//!    with the prior values), the fields whose value never reaches the model
//!    (`sealed`), whether it acts on `bulk`, the vault `command` it invokes and
//!    three to five `phrasings`; a query names the `kind` it answers and the
//!    `figures` it returns. A missing field is a parse error, so a new action
//!    cannot ship without saying what chat does with it.
//!
//!    **Whether chat runs an action itself or hands the member a card is never
//!    written down**: [`ActionEntry::surface`] derives it from those same facts,
//!    so the two cannot disagree. It is a card when the action has no inverse
//!    (a `log` is the one append-only exception), acts on many items, requires a
//!    sealed value, or requires a value chat has no word for (a property with no
//!    `aliases`). Two direct actions are never the same (verb, kind, qualifier).
//!    The assistant's kind and verb tables (`centraid-assist`'s `build.rs`) are
//!    generated from these fields and the `kinds` block, so the catalog and the
//!    chat surface cannot drift.
//! 6. **An input property may be `x-minted`** (an id the core mints when the
//!    caller states none: Locker seals a secret against its row's id, so the id
//!    must exist before the write) **or carry `aliases`** (the names chat and the
//!    training harness say it under: `title` is `name`, `effort_min` is `effort`).

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::Value;

use crate::error::{KitError, KitResult};

pub const MANIFEST_VERSION: u64 = 1;
pub const RESERVED_HANDLER_PREFIX: &str = "_";

/// Facts about the vault/replica plane, never per-app inventions (#839). The
/// ORDER is what manifests declare and reports render in — keep it stable.
pub const CANONICAL_DESIGNED_STATES: [&str; 7] = [
    "dayone", "pending", "offline", "stale", "conflict", "parked", "denied",
];

pub fn is_reserved_handler_name(name: &str) -> bool {
    name.starts_with(RESERVED_HANDLER_PREFIX)
}

/// Whether the conversation surface asks before dispatching. The dispatcher is
/// PERMISSIONLESS; this is not enforced by it (`manifest.ts:51`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confirmation {
    None,
    Required,
}

/// The chat verbs, committed as data: each verb's argument line and past
/// tense. Whether the runtime executes a verb is not written here: a verb is
/// live when an action backs it. The assistant's `build.rs` reads the same file.
pub const CHAT_VERBS_JSON: &str = include_str!("../../../../contracts/assist/verbs.json");

/// The names in [`CHAT_VERBS_JSON`], in its order.
///
/// # Panics
///
/// If the committed file is not the `{"verbs": [{"name": …}]}` shape — a
/// build-time fact about a file in this repository.
#[must_use]
pub fn chat_verb_names() -> Vec<String> {
    let verbs: Value =
        serde_json::from_str(CHAT_VERBS_JSON).expect("contracts/assist/verbs.json is JSON");
    verbs["verbs"]
        .as_array()
        .expect("verbs.json has a \"verbs\" array")
        .iter()
        .map(|verb| {
            verb["name"]
                .as_str()
                .expect("every verb has a name")
                .to_owned()
        })
        .collect()
}

/// What the conversation surface does with an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatSurface {
    /// The assistant runs it on the member's words.
    Direct,
    /// The assistant proposes it and the member finishes it on a card or
    /// screen: a file, a secret, a form, an array of ids, a mass or
    /// irreversible act.
    Card,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActionEntry {
    pub name: String,
    pub description: Option<String>,
    pub confirmation: Confirmation,
    /// The JSON Schema the dispatcher validates a body against, as data.
    pub input: Value,
    pub output: Option<Value>,
    /// The chat verb this action is (`create`, `edit`, `star`, …), without its
    /// qualifier.
    pub verb: String,
    /// The field an `edit` targets (`edit:cadence`), when the action edits one
    /// field of its kind and not the kind's fields in general.
    pub qualifier: Option<String>,
    /// Other verbs the same action serves (`edit` also `reschedule`).
    pub also: Vec<String>,
    /// The kind it acts on.
    pub kind: String,
    /// The action that undoes it, in the same manifest: another action, or this
    /// one (an edit, run again with the values it replaced).
    pub inverse: Option<String>,
    /// Input fields whose value never reaches the model.
    pub sealed: Vec<String>,
    /// Whether it acts on many items at once (an array of ids, a whole history).
    pub bulk: bool,
    /// The vault command it invokes (`schema.name`).
    pub command: String,
    /// Three to five requests a member might make for it.
    pub phrasings: Vec<String>,
    /// The id properties of its input the core mints when the caller leaves
    /// them out: those the schema marks `"x-minted": true`.
    pub minted: Vec<String>,
}

impl ActionEntry {
    /// The input property that names the row the action acts on: the one marked
    /// `x-target`, else `id`, else `item_id`.
    #[must_use]
    pub fn id_property(&self) -> Option<&str> {
        let properties = self.input.get("properties")?.as_object()?;
        properties
            .iter()
            .find(|(_, schema)| schema.get("x-target") == Some(&Value::Bool(true)))
            .map(|(name, _)| name.as_str())
            .or_else(|| {
                ["id", "item_id"]
                    .into_iter()
                    .find(|name| properties.contains_key(*name))
            })
    }

    /// The names chat says an input property under: its `aliases`.
    #[must_use]
    pub fn aliases_of(&self, property: &str) -> Vec<&str> {
        self.input
            .get("properties")
            .and_then(|properties| properties.get(property))
            .and_then(|schema| schema.get("aliases"))
            .and_then(Value::as_array)
            .map(|names| names.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default()
    }

    /// The property chat's `name` means: its own name or one of its aliases.
    #[must_use]
    pub fn property_named(&self, name: &str) -> Option<&str> {
        let properties = self.input.get("properties")?.as_object()?;
        properties
            .keys()
            .find(|property| self.aliases_of(property).contains(&name))
            .map(String::as_str)
            .or_else(|| {
                properties
                    .keys()
                    .find(|property| *property == name)
                    .map(String::as_str)
            })
    }

    /// The value an input property can only take: a `const` or a one-valued
    /// `enum` (`flag: starred`, `rel: contains`).
    #[must_use]
    pub fn constant_of(&self, property: &str) -> Option<&Value> {
        let schema = self.input.get("properties")?.get(property)?;
        schema.get("const").or_else(|| match schema.get("enum") {
            Some(Value::Array(values)) if values.len() == 1 => values.first(),
            _ => None,
        })
    }

    /// The value an input property takes when the caller states none.
    #[must_use]
    pub fn default_of(&self, property: &str) -> Option<&Value> {
        self.input.get("properties")?.get(property)?.get("default")
    }

    /// Whether chat can state a required property itself: it names the row, the
    /// core mints it, it can only be one value or has a default, the verb says it
    /// (`flag`), or chat has a word for it.
    fn chat_can_state(&self, property: &str) -> bool {
        self.id_property() == Some(property)
            || self.minted.iter().any(|minted| minted == property)
            || self.constant_of(property).is_some()
            || property == "flag"
            || self.default_of(property).is_some()
            || !self.aliases_of(property).is_empty()
    }

    /// WHAT THE CONVERSATION SURFACE DOES WITH THIS ACTION, derived and never
    /// declared: [`ChatSurface::Direct`] when the assistant can run it on the
    /// member's words, [`ChatSurface::Card`] when the member finishes it.
    ///
    /// A card when it cannot be taken back (no `inverse`; a `log` appends a fact
    /// and is the one exception), acts on many items (`bulk`), requires a sealed
    /// value (an action whose purpose is a secret; an edit that merely MAY carry
    /// one stays direct, the door seals what the member typed), or requires a
    /// value chat has no word for (a file, a person only the member can name).
    #[must_use]
    pub fn surface(&self) -> ChatSurface {
        let required: Vec<&str> = self
            .input
            .get("required")
            .and_then(Value::as_array)
            .map(|names| names.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let irreversible = self.inverse.is_none() && self.verb != "log";
        let sealed_required = required
            .iter()
            .any(|name| self.sealed.iter().any(|s| s == name));
        let unsayable = required.iter().any(|name| !self.chat_can_state(name));
        if irreversible || self.bulk || sealed_required || unsayable {
            ChatSurface::Card
        } else {
            ChatSurface::Direct
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueryEntry {
    pub name: String,
    pub description: Option<String>,
    pub input: Value,
    pub output: Option<Value>,
    /// Exists in v0's type and **no bundled app populates it**; the real read
    /// declaration is `vault.scopes` plus the query plan (#1020 apps §1.1).
    pub reads: Vec<String>,
    /// The kind it answers.
    pub kind: String,
    /// The figures it returns, by name.
    pub figures: Vec<String>,
}

/// Whether the assistant's runtime reads and writes a kind yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KindLive {
    /// Reads and writes run.
    Write,
    /// Reads run; writes are declared only.
    Read,
    /// Declared only: the row exists so the catalog is whole, and the runtime
    /// neither reads nor writes it.
    Declared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    Text,
    Number,
    Money,
    Enum,
    Bool,
    Date,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkVia {
    Attendee,
    About,
    Subtask,
    ListColumn,
    Entry,
    FolderColumn,
}

/// An enum field's values: `[model, vault]` pairs, or `"$token"` for a list the
/// assistant derives from the vault itself (`$locker_item_types`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum FieldValues {
    Pairs(Vec<(String, String)>),
    Token(String),
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldDecl {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: FieldKind,
    /// `(table, column)`.
    pub source: (String, String),
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub values: Option<FieldValues>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinkDecl {
    pub kind: String,
    pub label: String,
    pub via: LinkVia,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DateDecl {
    pub label: String,
    pub source: (String, String),
}

/// One model-facing kind an app owns: how the vault holds it, its fields and
/// its links. The assistant's `KINDS` table is generated from these.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct KindDecl {
    /// The snake_case id (`locker_item`).
    pub id: String,
    /// The model-facing word (`locker item`) and its plural.
    pub name: String,
    pub plural: String,
    /// Position in the assistant's kind list; unique across all apps.
    pub order: u32,
    pub live: KindLive,
    /// The vault kind the row is an entity of.
    pub entity: String,
    pub table: String,
    pub pk: String,
    pub name_source: (String, String),
    #[serde(default)]
    pub date: Option<DateDecl>,
    pub fields: Vec<FieldDecl>,
    pub links: Vec<LinkDecl>,
    pub trash: bool,
    pub container: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RowFilter {
    pub column: String,
    pub op: String,
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeVerbs {
    Read,
    ReadAct,
    Act,
    Reveal,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VaultScope {
    pub schema: String,
    pub table: Option<String>,
    pub verbs: ScopeVerbs,
    pub row_filter: Vec<RowFilter>,
    pub field_mask: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VaultBlock {
    pub why: Option<String>,
    pub scopes: Vec<VaultScope>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StateExclusion {
    pub state: String,
    /// Says why the case is UNREPRESENTABLE; an unbuilt state is a gap and
    /// belongs in `designed`.
    pub reason: String,
    pub citation: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StatesBlock {
    pub designed: Vec<String>,
    pub excluded: Vec<StateExclusion>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    pub manifest_version: u64,
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub actions: Vec<ActionEntry>,
    pub queries: Vec<QueryEntry>,
    pub vault: Option<VaultBlock>,
    pub states: Option<StatesBlock>,
    /// The model-facing kinds this app owns.
    pub kinds: Vec<KindDecl>,
    /// App-declared tables the gateway creates inside the vault. **No bundled
    /// app uses `ext`**; the block is read so a manifest that grows one is not
    /// silently dropped.
    pub ext_tables: Vec<String>,
}

impl Manifest {
    /// The action of that name, or `None`.
    pub fn action(&self, name: &str) -> Option<&ActionEntry> {
        self.actions.iter().find(|action| action.name == name)
    }

    /// The query of that name, or `None`.
    pub fn query(&self, name: &str) -> Option<&QueryEntry> {
        self.queries.iter().find(|query| query.name == name)
    }

    /// Where the manifest's `act` scopes and the commands its actions invoke
    /// disagree, as sentences; empty when they agree. `commands` are the
    /// qualified names (`schema.name`) of the app's action table.
    ///
    /// A narrow `act` scope is a command's name, and a consent screen lists it
    /// as a command the app reaches, so the two directions are one rule:
    ///
    /// 1. every narrow `act` scope (a `schema` and a `table` naming a command)
    ///    names a command some action invokes; a scope no action uses misleads
    ///    the screen (Locker's `locker.counts` and `locker.totp_code` did), and
    /// 2. every action's command is covered: by a scope that grants its whole
    ///    schema (`read+act` or `act` with no table), or by a narrow `act`
    ///    scope naming it.
    ///
    /// The first app to hold itself to this was People (finding PE-F1, P3).
    #[must_use]
    pub fn act_scope_disagreements(&self, commands: &[&str]) -> Vec<String> {
        let scopes: &[VaultScope] = self
            .vault
            .as_ref()
            .map_or(&[], |vault| vault.scopes.as_slice());
        let acts =
            |scope: &&VaultScope| matches!(scope.verbs, ScopeVerbs::Act | ScopeVerbs::ReadAct);
        let mut found = Vec::new();
        for scope in scopes.iter().filter(|scope| scope.verbs == ScopeVerbs::Act) {
            if let Some(table) = &scope.table {
                let qualified = format!("{}.{table}", scope.schema);
                if !commands.contains(&qualified.as_str()) {
                    found.push(format!(
                        "the `act` scope {qualified} names a command no action invokes"
                    ));
                }
            }
        }
        for command in commands {
            let Some((schema, name)) = command.split_once('.') else {
                found.push(format!("{command} is not `schema.name`"));
                continue;
            };
            let covered = scopes.iter().filter(acts).any(|scope| {
                scope.schema == schema
                    && scope
                        .table
                        .as_deref()
                        .is_none_or(|table| table == name && scope.verbs == ScopeVerbs::Act)
            });
            if !covered {
                found.push(format!(
                    "an action invokes {command} and no scope grants it"
                ));
            }
        }
        found
    }
}

fn field<'a>(object: &'a Value, key: &str) -> Option<&'a Value> {
    object.get(key).filter(|value| !value.is_null())
}

fn required_string(object: &Value, key: &str, path: &str) -> KitResult<String> {
    field(object, key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            KitError::manifest(
                "missing_field",
                format!("app.json is missing a string \"{key}\""),
                Some(path),
            )
        })
}

fn optional_string(object: &Value, key: &str) -> Option<String> {
    field(object, key)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn string_list(object: &Value, key: &str, path: &str) -> KitResult<Vec<String>> {
    match field(object, key) {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str().map(str::to_owned).ok_or_else(|| {
                    KitError::manifest(
                        "invalid_field",
                        format!("\"{key}\" must be an array of strings"),
                        Some(path),
                    )
                })
            })
            .collect(),
        Some(_) => Err(KitError::manifest(
            "invalid_field",
            format!("\"{key}\" must be an array of strings"),
            Some(path),
        )),
    }
}

/// Read one `app.json`.
pub fn parse_manifest(text: &str) -> KitResult<Manifest> {
    let raw: Value = serde_json::from_str(text).map_err(|error| {
        KitError::manifest(
            "invalid_json",
            format!("app.json is not JSON: {error}"),
            None,
        )
    })?;
    if !raw.is_object() {
        return Err(KitError::manifest(
            "invalid_manifest",
            "manifest must be a JSON object",
            None,
        ));
    }
    // `manifestVersion` is checked BEFORE the shape, so a future incompatible
    // manifest fails loudly rather than reading as an old one.
    let Some(declared) = field(&raw, "manifestVersion") else {
        return Err(KitError::manifest(
            "unsupported_manifest_version",
            format!("app.json is missing \"manifestVersion\"; expected {MANIFEST_VERSION}"),
            Some("manifestVersion"),
        ));
    };
    if declared.as_u64() != Some(MANIFEST_VERSION) {
        return Err(KitError::manifest(
            "unsupported_manifest_version",
            format!(
                "app.json declares manifestVersion {declared}, but this runtime understands {MANIFEST_VERSION}"
            ),
            Some("manifestVersion"),
        ));
    }

    let id = required_string(&raw, "id", "id")?;
    let name = required_string(&raw, "name", "name")?;
    let version = required_string(&raw, "version", "version")?;

    let actions = parse_actions(&raw)?;
    let queries = parse_queries(&raw)?;
    let states = parse_states(&raw)?;
    let vault = parse_vault(&raw)?;
    let kinds = parse_kinds(&raw)?;
    check_classification(&actions, &kinds)?;
    let ext_tables = match field(&raw, "ext").and_then(|ext| field(ext, "tables")) {
        Some(Value::Array(tables)) => tables
            .iter()
            .map(|table| required_string(table, "name", "ext.tables[].name"))
            .collect::<KitResult<Vec<String>>>()?,
        _ => Vec::new(),
    };

    Ok(Manifest {
        manifest_version: MANIFEST_VERSION,
        id,
        name,
        version,
        description: optional_string(&raw, "description"),
        actions,
        queries,
        vault,
        states,
        kinds,
        ext_tables,
    })
}

fn parse_actions(raw: &Value) -> KitResult<Vec<ActionEntry>> {
    let Some(Value::Array(entries)) = field(raw, "actions") else {
        return Ok(Vec::new());
    };
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut actions = Vec::with_capacity(entries.len());
    for entry in entries {
        let name = required_string(entry, "name", "actions[].name")?;
        let path = format!("actions[name={name}]");
        if is_reserved_handler_name(&name) {
            return Err(KitError::manifest(
                "reserved_handler_name",
                format!(
                    "action name \"{name}\" is reserved; names starting with \"{RESERVED_HANDLER_PREFIX}\" are dispatched to built-in handlers"
                ),
                Some(&path),
            ));
        }
        if !seen.insert(name.clone()) {
            return Err(KitError::manifest(
                "duplicate_handler",
                format!("manifest declares the action \"{name}\" twice"),
                Some(&path),
            ));
        }
        let confirmation = match field(entry, "confirmation").and_then(Value::as_str) {
            Some("none") => Confirmation::None,
            Some("required") => Confirmation::Required,
            _ => {
                return Err(KitError::manifest(
                    "invalid_handler_entry",
                    format!(
                        "action \"{name}\" must declare confirmation as \"none\" or \"required\""
                    ),
                    Some(&path),
                ));
            }
        };
        let Some(input) = field(entry, "input").filter(|input| input.is_object()) else {
            return Err(KitError::manifest(
                "invalid_handler_entry",
                format!("action \"{name}\" must declare an input schema"),
                Some(&path),
            ));
        };
        // REFUSED, not ignored: a `writes` list nobody reads is a comment with a
        // schema, and a quiet one is how the second copy comes back (module note,
        // 4). The commit's own census says what an action wrote.
        if entry.get("writes").is_some() {
            return Err(KitError::manifest(
                "removed_field",
                format!(
                    "action \"{name}\" declares \"writes\", which is not a manifest field: the vault reports the tables a command wrote"
                ),
                Some(&path),
            ));
        }
        let class = parse_action_class(entry, &name, input, &path)?;
        let minted = minted_ids(&name, input, &path)?;
        actions.push(ActionEntry {
            name,
            description: optional_string(entry, "description"),
            confirmation,
            input: input.clone(),
            output: field(entry, "output").cloned(),
            verb: class.verb,
            qualifier: class.qualifier,
            also: class.also,
            kind: class.kind,
            inverse: class.inverse,
            sealed: class.sealed,
            bulk: class.bulk,
            command: class.command,
            phrasings: class.phrasings,
            minted,
        });
    }
    Ok(actions)
}

/// The input properties marked `"x-minted": true`: ids the core mints, from the
/// vault's own source, when the caller states none. A mark is for a text
/// property; anything else cannot hold an id.
fn minted_ids(name: &str, input: &Value, path: &str) -> KitResult<Vec<String>> {
    let Some(properties) = input.get("properties").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let mut minted = Vec::new();
    for (property, schema) in properties {
        match schema.get("x-minted") {
            None => {}
            Some(Value::Bool(true))
                if schema.get("type").and_then(Value::as_str) == Some("string") =>
            {
                minted.push(property.clone());
            }
            Some(_) => {
                return Err(KitError::manifest(
                    "invalid_handler_entry",
                    format!(
                        "action \"{name}\" marks \"{property}\" `x-minted` and it is not `true` on a string property"
                    ),
                    Some(path),
                ));
            }
        }
    }
    Ok(minted)
}

fn parse_queries(raw: &Value) -> KitResult<Vec<QueryEntry>> {
    let Some(Value::Array(entries)) = field(raw, "queries") else {
        return Ok(Vec::new());
    };
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut queries = Vec::with_capacity(entries.len());
    for entry in entries {
        let name = required_string(entry, "name", "queries[].name")?;
        let path = format!("queries[name={name}]");
        if is_reserved_handler_name(&name) {
            return Err(KitError::manifest(
                "reserved_handler_name",
                format!(
                    "query name \"{name}\" is reserved; names starting with \"{RESERVED_HANDLER_PREFIX}\" are dispatched to built-in handlers"
                ),
                Some(&path),
            ));
        }
        if !seen.insert(name.clone()) {
            return Err(KitError::manifest(
                "duplicate_handler",
                format!("manifest declares the query \"{name}\" twice"),
                Some(&path),
            ));
        }
        let Some(input) = field(entry, "input").filter(|input| input.is_object()) else {
            return Err(KitError::manifest(
                "invalid_handler_entry",
                format!("query \"{name}\" must declare an input schema"),
                Some(&path),
            ));
        };
        let kind = required_kind(entry, "kind", &format!("query \"{name}\""), &path)?;
        let figures = string_list(entry, "figures", &path)?;
        if figures.is_empty() || figures.iter().any(|figure| !is_snake(figure)) {
            return Err(KitError::manifest(
                "invalid_handler_entry",
                format!(
                    "query \"{name}\" must name the figures it returns: a non-empty \"figures\" array of snake_case words"
                ),
                Some(&path),
            ));
        }
        queries.push(QueryEntry {
            name,
            description: optional_string(entry, "description"),
            input: input.clone(),
            output: field(entry, "output").cloned(),
            reads: string_list(entry, "reads", &path)?,
            kind,
            figures,
        });
    }
    Ok(queries)
}

/// An input property's `aliases` are a list of distinct words, and no word is
/// two properties' name or alias, so a name chat says reaches one property.
fn check_aliases(
    who: &str,
    properties: Option<&serde_json::Map<String, Value>>,
    refuse: &dyn Fn(String) -> KitError,
) -> KitResult<()> {
    let Some(properties) = properties else {
        return Ok(());
    };
    let mut seen: Vec<(&str, &str)> = Vec::new();
    for (property, schema) in properties {
        let Some(aliases) = schema.get("aliases") else {
            continue;
        };
        let Some(aliases) = aliases.as_array() else {
            return Err(refuse(format!(
                "{who} gives \"{property}\" `aliases` that are not a list of words"
            )));
        };
        for alias in aliases {
            let Some(alias) = alias.as_str().filter(|alias| !alias.trim().is_empty()) else {
                return Err(refuse(format!(
                    "{who} gives \"{property}\" an alias that is not a word"
                )));
            };
            if let Some((_, other)) = seen.iter().find(|(seen, _)| *seen == alias) {
                return Err(refuse(format!(
                    "{who}: \"{alias}\" is an alias of both \"{other}\" and \"{property}\""
                )));
            }
            seen.push((alias, property));
        }
    }
    Ok(())
}

/// A snake_case word: lowercase letters and digits, `_` between them.
fn is_snake(word: &str) -> bool {
    !word.is_empty()
        && !word.starts_with('_')
        && !word.ends_with('_')
        && !word.contains("__")
        && word
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn required_kind(object: &Value, key: &str, who: &str, path: &str) -> KitResult<String> {
    match field(object, key).and_then(Value::as_str) {
        Some(kind) if is_snake(kind) => Ok(kind.to_owned()),
        _ => Err(KitError::manifest(
            "invalid_handler_entry",
            format!("{who} must name the \"{key}\" it acts on, a snake_case word"),
            Some(path),
        )),
    }
}

/// What an action declares for the conversation surface.
struct ActionClass {
    verb: String,
    qualifier: Option<String>,
    also: Vec<String>,
    kind: String,
    inverse: Option<String>,
    sealed: Vec<String>,
    bulk: bool,
    command: String,
    phrasings: Vec<String>,
}

fn parse_action_class(
    entry: &Value,
    name: &str,
    input: &Value,
    path: &str,
) -> KitResult<ActionClass> {
    let who = format!("action \"{name}\"");
    let refuse = |message: String| KitError::manifest("invalid_handler_entry", message, Some(path));
    let vocabulary = chat_verb_names();
    let known = |verb: &str| vocabulary.iter().any(|known| known == verb);

    let written = required_string(entry, "verb", path)
        .map_err(|_| refuse(format!("{who} must declare the chat \"verb\" it is")))?;
    let (verb, qualifier) = match written.split_once(':') {
        Some((verb, qualifier)) => (verb.to_owned(), Some(qualifier.to_owned())),
        None => (written, None),
    };
    if !known(&verb) {
        return Err(refuse(format!(
            "{who} declares the verb \"{verb}\", which is not in contracts/assist/verbs.json"
        )));
    }
    let also = string_list(entry, "also", path)?;
    if let Some(bad) = also.iter().find(|also| !known(also) || **also == verb) {
        return Err(refuse(format!(
            "{who} declares \"also\" {bad:?}: a verb of verbs.json other than its own"
        )));
    }
    let kind = required_kind(entry, "kind", &who, path)?;
    // THE KEY MUST BE PRESENT: `null` says "nothing undoes it", absence says
    // nobody decided.
    let inverse = match entry.get("inverse") {
        Some(Value::Null) => None,
        Some(Value::String(inverse)) if !inverse.is_empty() => Some(inverse.clone()),
        _ => {
            return Err(refuse(format!(
                "{who} must declare \"inverse\": the action that undoes it, or null"
            )));
        }
    };
    if !matches!(entry.get("sealed"), Some(Value::Array(_))) {
        return Err(refuse(format!(
            "{who} must declare \"sealed\": the input fields whose value never reaches the model, or []"
        )));
    }
    let sealed = string_list(entry, "sealed", path)?;
    let properties = input.get("properties").and_then(Value::as_object);
    if let Some(bad) = sealed
        .iter()
        .find(|name| !properties.is_some_and(|properties| properties.contains_key(*name)))
    {
        return Err(refuse(format!(
            "{who} seals \"{bad}\", which is not a property of its input"
        )));
    }
    // REFUSED, not ignored: what chat does with an action is derived from the facts above
    // (`ActionEntry::surface`), and a written copy is how the two come apart again.
    if entry.get("chat").is_some() {
        return Err(KitError::manifest(
            "removed_field",
            format!(
                "{who} declares \"chat\", which is not a manifest field: whether chat runs an action or hands the member a card is derived"
            ),
            Some(path),
        ));
    }
    let bulk = match entry.get("bulk") {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        Some(_) => {
            return Err(refuse(format!(
                "{who} declares \"bulk\" as something but true"
            )));
        }
    };
    if let Some(qualifier) = &qualifier {
        let names_it = |name: &str| {
            properties.is_some_and(|properties| {
                properties.contains_key(name)
                    || properties.values().any(|schema| {
                        schema
                            .get("aliases")
                            .and_then(Value::as_array)
                            .is_some_and(|aliases| aliases.iter().any(|alias| alias == name))
                    })
            })
        };
        if !names_it(qualifier) {
            return Err(refuse(format!(
                "{who} is `{verb}:{qualifier}` and no property of its input is, or is also called, \"{qualifier}\""
            )));
        }
    }
    check_aliases(&who, properties, &refuse)?;
    let command = required_string(entry, "command", path).map_err(|_| {
        refuse(format!(
            "{who} must declare the vault \"command\" it invokes"
        ))
    })?;
    if command
        .split_once('.')
        .is_none_or(|(schema, name)| schema.is_empty() || name.is_empty())
    {
        return Err(refuse(format!(
            "{who} declares the command \"{command}\", which is not `schema.name`"
        )));
    }
    let phrasings = string_list(entry, "phrasings", path)?;
    let distinct: BTreeSet<&String> = phrasings.iter().collect();
    if !(3..=5).contains(&phrasings.len())
        || distinct.len() != phrasings.len()
        || phrasings.iter().any(|phrase| phrase.trim().is_empty())
    {
        return Err(refuse(format!(
            "{who} must declare three to five distinct, non-empty \"phrasings\" (found {})",
            phrasings.len()
        )));
    }
    Ok(ActionClass {
        verb,
        qualifier,
        also,
        kind,
        inverse,
        sealed,
        bulk,
        command,
        phrasings,
    })
}

fn parse_kinds(raw: &Value) -> KitResult<Vec<KindDecl>> {
    let Some(kinds) = field(raw, "kinds") else {
        return Ok(Vec::new());
    };
    let kinds: Vec<KindDecl> = serde_json::from_value(kinds.clone()).map_err(|error| {
        KitError::manifest(
            "invalid_field",
            format!("\"kinds\" is not a list of kind declarations: {error}"),
            Some("kinds"),
        )
    })?;
    let mut seen = BTreeSet::new();
    for kind in &kinds {
        if !is_snake(&kind.id) || !seen.insert(kind.id.clone()) {
            return Err(KitError::manifest(
                "invalid_field",
                format!("kind \"{}\" is not a unique snake_case id", kind.id),
                Some("kinds"),
            ));
        }
    }
    Ok(kinds)
}

/// The cross-checks a per-entry parse cannot make: an `inverse` names an action
/// of this manifest (an edit may name itself), a direct action acts on a kind
/// this manifest declares, and no two direct actions are the same (verb, kind,
/// qualifier) to the chat surface — the assistant looks up one action per triple.
fn check_classification(actions: &[ActionEntry], kinds: &[KindDecl]) -> KitResult<()> {
    let refuse = |message: String| KitError::manifest("invalid_handler_entry", message, None);
    for action in actions {
        if let Some(inverse) = &action.inverse
            && !actions.iter().any(|other| &other.name == inverse)
        {
            return Err(refuse(format!(
                "action \"{}\" declares the inverse \"{inverse}\", which is not another action of this manifest",
                action.name
            )));
        }
    }
    let declared = |kind: &str| kinds.iter().any(|decl| decl.id == kind);
    let mut pairs: Vec<(&str, &str, Option<&str>, &str)> = Vec::new();
    for action in actions
        .iter()
        .filter(|a| a.surface() == ChatSurface::Direct)
    {
        if !declared(&action.kind) {
            return Err(refuse(format!(
                "the direct action \"{}\" acts on the kind \"{}\", which this manifest does not declare under \"kinds\"",
                action.name, action.kind
            )));
        }
        for verb in std::iter::once(&action.verb).chain(&action.also) {
            let qualifier = action.qualifier.as_deref();
            if let Some((_, _, _, other)) = pairs
                .iter()
                .find(|(v, k, q, _)| *v == verb && *k == action.kind && *q == qualifier)
            {
                return Err(refuse(format!(
                    "the direct actions \"{other}\" and \"{}\" are both `{verb}{} {}`; name the field one edits (`edit:field`) or make one a card",
                    action.name,
                    qualifier.map(|q| format!(":{q}")).unwrap_or_default(),
                    action.kind
                )));
            }
            pairs.push((verb, &action.kind, qualifier, &action.name));
        }
    }
    Ok(())
}

fn parse_states(raw: &Value) -> KitResult<Option<StatesBlock>> {
    let Some(block) = field(raw, "states").filter(|block| block.is_object()) else {
        return Ok(None);
    };
    let designed = string_list(block, "designed", "states.designed")?;
    let excluded = match field(block, "excluded") {
        None => Vec::new(),
        Some(Value::Array(entries)) => entries
            .iter()
            .map(|entry| {
                Ok(StateExclusion {
                    state: required_string(entry, "state", "states.excluded[].state")?,
                    reason: required_string(entry, "reason", "states.excluded[].reason")?,
                    citation: required_string(entry, "citation", "states.excluded[].citation")?,
                })
            })
            .collect::<KitResult<Vec<StateExclusion>>>()?,
        Some(_) => {
            return Err(KitError::manifest(
                "invalid_field",
                "\"states.excluded\" must be an array",
                Some("states.excluded"),
            ));
        }
    };

    // A schema can say each entry is one of the seven; only this pass can say
    // each of the seven is claimed exactly once.
    let mut claimed: Vec<(&str, &'static str)> = Vec::new();
    let mut claim = |state: &str, side: &'static str| -> KitResult<()> {
        if !CANONICAL_DESIGNED_STATES.contains(&state) {
            return Err(KitError::manifest(
                "invalid_field",
                format!(
                    "states names \"{state}\", which is not a canonical designed state ({})",
                    CANONICAL_DESIGNED_STATES.join(", ")
                ),
                Some("states"),
            ));
        }
        if let Some((_, prior)) = claimed.iter().find(|(known, _)| *known == state) {
            return Err(KitError::manifest(
                "invalid_field",
                format!(
                    "states declares \"{state}\" twice ({prior}, then {side}); each canonical state belongs to exactly one side"
                ),
                Some(&format!("states.{side}")),
            ));
        }
        claimed.push((
            CANONICAL_DESIGNED_STATES
                .iter()
                .find(|known| **known == state)
                .expect("checked above"),
            side,
        ));
        Ok(())
    };
    for state in &designed {
        claim(state, "designed")?;
    }
    for entry in &excluded {
        claim(&entry.state, "excluded")?;
    }
    let missing: Vec<&str> = CANONICAL_DESIGNED_STATES
        .iter()
        .copied()
        .filter(|state| !claimed.iter().any(|(known, _)| known == state))
        .collect();
    if !missing.is_empty() {
        return Err(KitError::manifest(
            "invalid_field",
            format!(
                "states omits {}; list every canonical state under \"designed\", or under \"excluded\" with a reason and a citation",
                missing.join(", ")
            ),
            Some("states"),
        ));
    }
    Ok(Some(StatesBlock { designed, excluded }))
}

fn parse_vault(raw: &Value) -> KitResult<Option<VaultBlock>> {
    let Some(block) = field(raw, "vault").filter(|block| block.is_object()) else {
        return Ok(None);
    };
    let Some(Value::Array(entries)) = field(block, "scopes") else {
        return Err(KitError::manifest(
            "invalid_field",
            "\"vault\" declares no \"scopes\" array",
            Some("vault.scopes"),
        ));
    };
    let mut scopes = Vec::with_capacity(entries.len());
    for entry in entries {
        let schema = required_string(entry, "schema", "vault.scopes[].schema")?;
        let verbs = match field(entry, "verbs").and_then(Value::as_str) {
            Some("read") => ScopeVerbs::Read,
            Some("read+act") => ScopeVerbs::ReadAct,
            Some("act") => ScopeVerbs::Act,
            Some("reveal") => ScopeVerbs::Reveal,
            other => {
                return Err(KitError::manifest(
                    "invalid_field",
                    format!(
                        "vault scope on \"{schema}\" declares verbs {other:?}; one of read, read+act, act, reveal"
                    ),
                    Some("vault.scopes[].verbs"),
                ));
            }
        };
        let row_filter = match field(entry, "rowFilter") {
            None => Vec::new(),
            Some(Value::Array(clauses)) => clauses
                .iter()
                .map(|clause| {
                    Ok(RowFilter {
                        column: required_string(
                            clause,
                            "column",
                            "vault.scopes[].rowFilter[].column",
                        )?,
                        op: required_string(clause, "op", "vault.scopes[].rowFilter[].op")?,
                        value: clause.get("value").cloned(),
                    })
                })
                .collect::<KitResult<Vec<RowFilter>>>()?,
            Some(_) => {
                return Err(KitError::manifest(
                    "invalid_field",
                    "\"rowFilter\" must be an array",
                    Some("vault.scopes[].rowFilter"),
                ));
            }
        };
        let field_mask = match field(entry, "fieldMask") {
            None => None,
            Some(_) => Some(string_list(entry, "fieldMask", "vault.scopes[].fieldMask")?),
        };
        scopes.push(VaultScope {
            schema,
            table: optional_string(entry, "table"),
            verbs,
            row_filter,
            field_mask,
        });
    }
    Ok(Some(VaultBlock {
        why: optional_string(block, "why"),
        scopes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal(extra: &str) -> String {
        format!(
            r#"{{"manifestVersion": 1, "id": "sample", "name": "Sample", "version": "0.3.0"{extra}}}"#
        )
    }

    /// The classification every action must carry, spliced into a test action.
    const CLASS: &str = r#""verb": "create", "kind": "thing", "inverse": null, "sealed": [], "command": "thing.add", "phrasings": ["add a thing", "make a thing", "new thing please"]"#;
    /// The one kind the test actions act on, which a direct action must declare.
    const THING: &str = r#", "kinds": [{"id": "thing", "name": "thing", "plural": "things", "order": 0, "live": "write", "entity": "thing", "table": "thing", "pk": "id", "nameSource": ["entity", "title"], "fields": [], "links": [], "trash": false, "container": false}]"#;
    const QUERY_CLASS: &str = r#""kind": "thing", "figures": ["things"]"#;

    fn action(name: &str, extra: &str) -> String {
        format!(r#"{{"name": "{name}", "confirmation": "none", "input": {{}}, {CLASS}{extra}}}"#)
    }

    fn query(name: &str) -> String {
        format!(r#"{{"name": "{name}", "input": {{}}, {QUERY_CLASS}}}"#)
    }

    #[test]
    fn the_version_is_checked_before_the_shape() {
        let error = parse_manifest(r#"{"manifestVersion": 2}"#).unwrap_err();
        assert!(matches!(
            error,
            KitError::Manifest {
                code: "unsupported_manifest_version",
                ..
            }
        ));
        let error = parse_manifest(r#"{"id": "x"}"#).unwrap_err();
        assert!(matches!(
            error,
            KitError::Manifest {
                code: "unsupported_manifest_version",
                ..
            }
        ));
    }

    #[test]
    fn a_reserved_handler_name_is_refused_on_both_sides() {
        let action = minimal(&format!(r#", "actions": [{}]"#, action("_private", "")));
        assert!(matches!(
            parse_manifest(&action).unwrap_err(),
            KitError::Manifest {
                code: "reserved_handler_name",
                ..
            }
        ));
        let query = minimal(&format!(r#", "queries": [{}]"#, query("_private")));
        assert!(matches!(
            parse_manifest(&query).unwrap_err(),
            KitError::Manifest {
                code: "reserved_handler_name",
                ..
            }
        ));
    }

    #[test]
    fn one_name_in_both_lists_is_allowed_and_two_in_one_is_not() {
        let both = minimal(&format!(
            r#", "actions": [{}], "queries": [{}]"#,
            action("search", ""),
            query("search")
        ));
        parse_manifest(&both).unwrap();
        let twice = minimal(&format!(
            r#", "queries": [{}, {}]"#,
            query("search"),
            query("search")
        ));
        assert!(matches!(
            parse_manifest(&twice).unwrap_err(),
            KitError::Manifest {
                code: "duplicate_handler",
                ..
            }
        ));
    }

    #[test]
    fn an_action_that_declares_writes_is_refused_and_one_that_does_not_parses() {
        // THE KEY IS REFUSED, `[]` and `null` included: "no database writes"
        // was a claim nothing read, and a copy of what the commit's census
        // already says can only drift.
        for declared in [
            r#""writes": []"#,
            r#""writes": ["core.party"]"#,
            r#""writes": null"#,
        ] {
            let text = minimal(&format!(
                r#", "actions": [{}]"#,
                action("add", &format!(", {declared}"))
            ));
            let error = parse_manifest(&text).unwrap_err();
            assert!(
                matches!(
                    &error,
                    KitError::Manifest {
                        code: "removed_field",
                        ..
                    }
                ),
                "{declared}: {error}"
            );
        }
        let plain = minimal(&format!(r#", "actions": [{}]"#, action("add", "")));
        assert_eq!(parse_manifest(&plain).unwrap().actions[0].name, "add");
    }

    #[test]
    fn states_is_a_closed_partition() {
        let missing = minimal(r#", "states": {"designed": ["dayone"], "excluded": []}"#);
        let error = parse_manifest(&missing).unwrap_err();
        assert!(
            matches!(&error, KitError::Manifest { code: "invalid_field", message, .. }
                if message.contains("pending") && message.contains("denied")),
            "{error}"
        );

        let twice = minimal(
            r#", "states": {"designed": ["dayone", "pending", "offline", "stale", "conflict", "parked", "denied"], "excluded": [{"state": "denied", "reason": "r", "citation": "c"}]}"#,
        );
        assert!(matches!(
            parse_manifest(&twice).unwrap_err(),
            KitError::Manifest {
                code: "invalid_field",
                ..
            }
        ));

        let whole = minimal(
            r##", "states": {"designed": ["dayone", "pending", "offline", "stale", "conflict", "parked"], "excluded": [{"state": "denied", "reason": "first-party apps hold no grant", "citation": "#928"}]}"##,
        );
        let manifest = parse_manifest(&whole).unwrap();
        let states = manifest.states.unwrap();
        assert_eq!(states.designed.len(), 6);
        assert_eq!(states.excluded.len(), 1);
    }

    #[test]
    fn an_uncanonical_state_is_refused() {
        let text = minimal(r#", "states": {"designed": ["sparkling"], "excluded": []}"#);
        assert!(matches!(
            parse_manifest(&text).unwrap_err(),
            KitError::Manifest {
                code: "invalid_field",
                ..
            }
        ));
    }

    /// EVERY CLASSIFYING FIELD IS REQUIRED, one at a time: dropping any of them
    /// from an otherwise whole action is a parse error that names the action.
    #[test]
    fn an_action_missing_any_classification_field_is_refused() {
        for dropped in ["verb", "kind", "inverse", "sealed", "command", "phrasings"] {
            let mut entry: Value = serde_json::from_str(&action("add", "")).unwrap();
            entry.as_object_mut().unwrap().remove(dropped);
            let text = minimal(&format!(r#", "actions": [{entry}]"#));
            let error = parse_manifest(&text).unwrap_err();
            assert!(
                matches!(&error, KitError::Manifest { code: "invalid_handler_entry", message, .. }
                    if message.contains("\"add\"")),
                "{dropped}: {error}"
            );
        }
        for dropped in ["kind", "figures"] {
            let mut entry: Value = serde_json::from_str(&query("q")).unwrap();
            entry.as_object_mut().unwrap().remove(dropped);
            let text = minimal(&format!(r#", "queries": [{entry}]"#));
            assert!(parse_manifest(&text).is_err(), "{dropped}");
        }
    }

    #[test]
    fn a_classification_that_contradicts_itself_is_refused() {
        let bad = |extra: &str, replace: (&str, &str)| {
            let entry = action("add", extra).replace(replace.0, replace.1);
            parse_manifest(&minimal(&format!(r#", "actions": [{entry}]"#))).unwrap_err()
        };
        // a verb nobody defined, a card/direct word nobody defined, a phrase count
        // outside three to five, a seal on a field the input lacks
        for (replace, what) in [
            ((r#""verb": "create""#, r#""verb": "conjure""#), "verb"),
            (
                (
                    r#""phrasings": ["add a thing", "make a thing", "new thing please"]"#,
                    r#""phrasings": ["one", "two"]"#,
                ),
                "phrasings",
            ),
            ((r#""sealed": []"#, r#""sealed": ["password"]"#), "sealed"),
            (
                (r#""command": "thing.add""#, r#""command": "add""#),
                "command",
            ),
            ((r#""inverse": null"#, r#""inverse": "nothing""#), "inverse"),
        ] {
            let error = bad("", replace);
            assert!(
                matches!(
                    &error,
                    KitError::Manifest {
                        code: "invalid_handler_entry",
                        ..
                    }
                ),
                "{what}: {error}"
            );
        }
    }

    /// WHAT CHAT DOES WITH AN ACTION IS DERIVED, never written: a `chat` key is refused, and the
    /// surface follows from the inverse, the seal, `bulk` and whether chat has a word for what
    /// the action requires.
    #[test]
    fn the_chat_surface_is_derived_from_the_facts_and_never_declared() {
        let with = |extra: &str| {
            let entry = action("add", extra);
            parse_manifest(&minimal(&format!(r#", "actions": [{entry}]{THING}"#))).unwrap()
        };
        let error = parse_manifest(&minimal(&format!(
            r#", "actions": [{}]"#,
            action("add", r#", "chat": "direct""#)
        )))
        .unwrap_err();
        assert!(
            matches!(
                &error,
                KitError::Manifest {
                    code: "removed_field",
                    ..
                }
            ),
            "{error}"
        );
        // no inverse: a card
        assert_eq!(with("").actions[0].surface(), ChatSurface::Card);
        let undoable = |manifest: &str| {
            let entry =
                action("add", manifest).replace("\"inverse\": null", "\"inverse\": \"add\"");
            parse_manifest(&minimal(&format!(r#", "actions": [{entry}]{THING}"#))).unwrap()
        };
        assert_eq!(undoable("").actions[0].surface(), ChatSurface::Direct);
        // bulk: a card
        assert_eq!(
            undoable(r#", "bulk": true"#).actions[0].surface(),
            ChatSurface::Card
        );
        // a required sealed value: a card; an optional one does not make it one
        let input = |required: &str| {
            format!(
                r#", "input": {{"type": "object", "properties": {{"secret": {{"type": "string", "aliases": ["secret"]}}, "title": {{"type": "string", "aliases": ["name"]}}}}, "required": [{required}]}}"#
            )
        };
        let shaped = |required: &str, sealed: &str| {
            let entry = format!(
                r#"{{"name": "add", "confirmation": "none"{}, "verb": "create", "kind": "thing", "inverse": "add", "sealed": [{sealed}], "command": "thing.add", "phrasings": ["a", "b", "c"]}}"#,
                input(required)
            );
            parse_manifest(&minimal(&format!(r#", "actions": [{entry}]{THING}"#))).unwrap()
        };
        assert_eq!(
            shaped("\"title\"", "\"secret\"").actions[0].surface(),
            ChatSurface::Direct
        );
        assert_eq!(
            shaped("\"secret\"", "\"secret\"").actions[0].surface(),
            ChatSurface::Card
        );
        // a required value chat has no word for: a card
        let unsayable = action("add", "").replace("\"inverse\": null", "\"inverse\": \"add\"");
        let unsayable = unsayable.replace(
            "\"input\": {}",
            r#""input": {"type": "object", "properties": {"blob": {"type": "string"}}, "required": ["blob"]}"#,
        );
        let manifest =
            parse_manifest(&minimal(&format!(r#", "actions": [{unsayable}]{THING}"#))).unwrap();
        assert_eq!(manifest.actions[0].surface(), ChatSurface::Card);
    }

    #[test]
    fn two_direct_actions_may_not_be_the_same_verb_kind_and_qualifier() {
        let kinds = r#", "kinds": [{"id": "thing", "name": "thing", "plural": "things", "order": 0, "live": "write", "entity": "thing", "table": "thing", "pk": "id", "nameSource": ["entity", "title"], "fields": [], "links": [], "trash": false, "container": false}]"#;
        let direct = |name: &str, verb: &str| {
            action(name, "")
                .replace("\"inverse\": null", &format!("\"inverse\": \"{name}\""))
                .replace("\"verb\": \"create\"", &format!("\"verb\": \"{verb}\""))
                .replace(
                    "\"input\": {}",
                    r#""input": {"type": "object", "properties": {"cadence": {"type": "integer", "aliases": ["cadence"]}}}"#,
                )
        };
        let one = minimal(&format!(
            r#", "actions": [{}]{kinds}"#,
            direct("add", "create")
        ));
        parse_manifest(&one).unwrap();
        let two = minimal(&format!(
            r#", "actions": [{}, {}]{kinds}"#,
            direct("add", "create"),
            direct("make", "create")
        ));
        let error = parse_manifest(&two).unwrap_err();
        assert!(
            matches!(&error, KitError::Manifest { message, .. } if message.contains("name the field one edits")),
            "{error}"
        );
        // the same verb and kind are two actions once one names the field it edits
        let apart = minimal(&format!(
            r#", "actions": [{}, {}]{kinds}"#,
            direct("edit-thing", "edit"),
            direct("set-cadence", "edit:cadence")
        ));
        let parsed = parse_manifest(&apart).unwrap();
        assert_eq!(parsed.actions[1].verb, "edit");
        assert_eq!(parsed.actions[1].qualifier.as_deref(), Some("cadence"));
        // ... but two of one qualifier are the same action to chat
        let twice = minimal(&format!(
            r#", "actions": [{}, {}]{kinds}"#,
            direct("set-a", "edit:cadence"),
            direct("set-b", "edit:cadence")
        ));
        assert!(parse_manifest(&twice).is_err());
        // a qualifier names a field the input has
        let stranger = minimal(&format!(
            r#", "actions": [{}]{kinds}"#,
            direct("set-x", "edit:colour")
        ));
        assert!(parse_manifest(&stranger).is_err());
        // a direct action on a kind the manifest never declared
        let orphan = minimal(&format!(r#", "actions": [{}]"#, direct("add", "create")));
        assert!(parse_manifest(&orphan).is_err());
    }

    /// AN ALIAS NAMES ONE PROPERTY, and an `x-minted` mark sits on a text property only.
    #[test]
    fn an_alias_reaches_one_property_and_a_minted_id_is_text() {
        let shaped = |properties: &str| {
            let entry = action("add", "").replace(
                "\"input\": {}",
                &format!(r#""input": {{"type": "object", "properties": {properties}}}"#),
            );
            parse_manifest(&minimal(&format!(r#", "actions": [{entry}]"#)))
        };
        assert!(shaped(r#"{"a": {"type": "string", "aliases": ["x"]}, "b": {"type": "string", "aliases": ["y"]}}"#).is_ok());
        assert!(shaped(r#"{"a": {"type": "string", "aliases": ["x"]}, "b": {"type": "string", "aliases": ["x"]}}"#).is_err());
        assert!(shaped(r#"{"a": {"type": "string", "aliases": "x"}}"#).is_err());
        let minted = shaped(r#"{"id": {"type": "string", "x-minted": true}}"#).unwrap();
        assert_eq!(minted.actions[0].minted, ["id"]);
        assert!(shaped(r#"{"id": {"type": "integer", "x-minted": true}}"#).is_err());
        assert!(shaped(r#"{"id": {"type": "string", "x-minted": "yes"}}"#).is_err());
    }

    /// THE CATALOG, as committed: the eight bundled manifests, read from their files. The action
    /// counts are the census of #1135; the rest are the rules a catalog entry must keep for chat's
    /// generated tables to be sound. The QUERIES are not counted here: a query is declared by its
    /// manifest and read by the core's `load`, and `crates/core`'s test holds the two lists to
    /// each other both ways.
    #[test]
    fn the_eight_bundled_manifests_are_fully_classified() {
        let apps = [
            ("agenda", 24),
            ("docs", 18),
            ("health", 3),
            ("locker", 19),
            ("money", 22),
            ("notes", 17),
            ("people", 25),
            ("photos", 19),
        ];
        let mut total = 0;
        let mut orders = BTreeSet::new();
        let mut kind_ids = BTreeSet::new();
        for (app, actions) in apps {
            let path = format!("{}/../{app}/manifest.json", env!("CARGO_MANIFEST_DIR"));
            let text = std::fs::read_to_string(&path).unwrap();
            let manifest = parse_manifest(&text).unwrap_or_else(|error| panic!("{app}: {error}"));
            assert_eq!(manifest.actions.len(), actions, "{app} actions");
            total += actions;
            for kind in &manifest.kinds {
                assert!(
                    orders.insert(kind.order),
                    "{app}: order {} repeats",
                    kind.order
                );
                assert!(
                    kind_ids.insert(kind.id.clone()),
                    "{app}: kind {} repeats",
                    kind.id
                );
            }
            for action in &manifest.actions {
                // the parser already refuses a missing field; this is the
                // census's own floor on what the fields say
                assert!(!action.verb.is_empty() && !action.command.is_empty());
                assert!(
                    (3..=5).contains(&action.phrasings.len()),
                    "{app}/{}",
                    action.name
                );
            }
            for query in &manifest.queries {
                assert!(!query.figures.is_empty(), "{app}/{}", query.name);
            }
        }
        assert_eq!(total, 147);
        // the orders are 0..N with no hole, so the generated enum is dense
        let expected: BTreeSet<u32> = (0..u32::try_from(orders.len()).unwrap()).collect();
        assert_eq!(orders, expected);
    }
}
