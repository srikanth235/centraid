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
//!    names the chat `verb` it is, the `kind` it acts on, its `inverse`, the
//!    fields whose value never reaches the model (`sealed`), whether chat runs
//!    it `direct`ly or hands the member a `card`, the vault `command` it
//!    invokes and three to five `phrasings`; a query names the `kind` it
//!    answers and the `figures` it returns. A missing field is a parse error,
//!    so a new action cannot ship without saying what chat does with it. The
//!    assistant's kind and verb tables (`centraid-assist`'s `build.rs`) are
//!    generated from these fields and the `kinds` block, so the catalog and the
//!    chat surface cannot drift.

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
/// tense, and whether the assistant's runtime executes it yet (`live`). The
/// assistant's `build.rs` reads the same file.
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
    /// The chat verb this action is (`create`, `edit`, `star`, …).
    pub verb: String,
    /// Other verbs the same action serves (`edit` also `reschedule`).
    pub also: Vec<String>,
    /// The kind it acts on.
    pub kind: String,
    /// The action that undoes it, in the same manifest.
    pub inverse: Option<String>,
    /// Input fields whose value never reaches the model.
    pub sealed: Vec<String>,
    pub chat: ChatSurface,
    /// The vault command it invokes (`schema.name`).
    pub command: String,
    /// Three to five requests a member might make for it.
    pub phrasings: Vec<String>,
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
    /// The command an `edit` of this field runs.
    #[serde(default)]
    pub edit: Option<String>,
    /// Whether `create` accepts it.
    #[serde(default)]
    pub create: bool,
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
        actions.push(ActionEntry {
            name,
            description: optional_string(entry, "description"),
            confirmation,
            input: input.clone(),
            output: field(entry, "output").cloned(),
            verb: class.verb,
            also: class.also,
            kind: class.kind,
            inverse: class.inverse,
            sealed: class.sealed,
            chat: class.chat,
            command: class.command,
            phrasings: class.phrasings,
        });
    }
    Ok(actions)
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
    also: Vec<String>,
    kind: String,
    inverse: Option<String>,
    sealed: Vec<String>,
    chat: ChatSurface,
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

    let verb = required_string(entry, "verb", path)
        .map_err(|_| refuse(format!("{who} must declare the chat \"verb\" it is")))?;
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
    let chat = match field(entry, "chat").and_then(Value::as_str) {
        Some("direct") => ChatSurface::Direct,
        Some("card") => ChatSurface::Card,
        _ => {
            return Err(refuse(format!(
                "{who} must declare \"chat\" as \"direct\" or \"card\""
            )));
        }
    };
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
        also,
        kind,
        inverse,
        sealed,
        chat,
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

/// The cross-checks a per-entry parse cannot make: an `inverse` names another
/// action of this manifest, a direct action acts on a kind this manifest
/// declares, and no two direct actions are the same (verb, kind) to the chat
/// surface — the assistant's verb table has one command per pair.
fn check_classification(actions: &[ActionEntry], kinds: &[KindDecl]) -> KitResult<()> {
    let refuse = |message: String| KitError::manifest("invalid_handler_entry", message, None);
    for action in actions {
        if let Some(inverse) = &action.inverse
            && (inverse == &action.name || !actions.iter().any(|other| &other.name == inverse))
        {
            return Err(refuse(format!(
                "action \"{}\" declares the inverse \"{inverse}\", which is not another action of this manifest",
                action.name
            )));
        }
    }
    let declared = |kind: &str| kinds.iter().any(|decl| decl.id == kind);
    let mut pairs: Vec<(&str, &str, &str)> = Vec::new();
    for action in actions.iter().filter(|a| a.chat == ChatSurface::Direct) {
        if !declared(&action.kind) {
            return Err(refuse(format!(
                "the direct action \"{}\" acts on the kind \"{}\", which this manifest does not declare under \"kinds\"",
                action.name, action.kind
            )));
        }
        for verb in std::iter::once(&action.verb).chain(&action.also) {
            if let Some((_, _, other)) = pairs
                .iter()
                .find(|(v, k, _)| *v == verb && *k == action.kind)
            {
                return Err(refuse(format!(
                    "the direct actions \"{other}\" and \"{}\" are both `{verb} {}`; one of them is a card",
                    action.name, action.kind
                )));
            }
            pairs.push((verb, &action.kind, &action.name));
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
    const CLASS: &str = r#""verb": "create", "kind": "thing", "inverse": null, "sealed": [], "chat": "card", "command": "thing.add", "phrasings": ["add a thing", "make a thing", "new thing please"]"#;
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
        for dropped in [
            "verb",
            "kind",
            "inverse",
            "sealed",
            "chat",
            "command",
            "phrasings",
        ] {
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
            ((r#""chat": "card""#, r#""chat": "maybe""#), "chat"),
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
            ((r#""inverse": null"#, r#""inverse": "add""#), "inverse"),
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

    #[test]
    fn two_direct_actions_may_not_be_the_same_verb_and_kind() {
        let kinds = r#", "kinds": [{"id": "thing", "name": "thing", "plural": "things", "order": 0, "live": "write", "entity": "thing", "table": "thing", "pk": "id", "nameSource": ["entity", "title"], "fields": [], "links": [], "trash": false, "container": false}]"#;
        let direct = |name: &str| action(name, "").replace("\"card\"", "\"direct\"");
        let one = minimal(&format!(r#", "actions": [{}]{kinds}"#, direct("add")));
        parse_manifest(&one).unwrap();
        let two = minimal(&format!(
            r#", "actions": [{}, {}]{kinds}"#,
            direct("add"),
            direct("make")
        ));
        let error = parse_manifest(&two).unwrap_err();
        assert!(
            matches!(&error, KitError::Manifest { message, .. } if message.contains("one of them is a card")),
            "{error}"
        );
        // a direct action on a kind the manifest never declared
        let orphan = minimal(&format!(r#", "actions": [{}]"#, direct("add")));
        assert!(parse_manifest(&orphan).is_err());
    }

    /// THE CATALOG, as committed: the nine bundled manifests, read from their
    /// files. The counts are the census of #1135; the rest are the rules a
    /// catalog entry must keep for chat's generated tables to be sound.
    #[test]
    fn the_nine_bundled_manifests_are_fully_classified() {
        let apps = [
            ("agenda", 7, 4),
            ("docs", 18, 4),
            ("health", 3, 6),
            ("locker", 19, 5),
            ("money", 22, 11),
            ("notes", 17, 6),
            ("people", 25, 5),
            ("photos", 19, 3),
            ("tasks", 15, 2),
        ];
        let mut total = (0, 0);
        let mut orders = BTreeSet::new();
        let mut kind_ids = BTreeSet::new();
        for (app, actions, queries) in apps {
            let path = format!("{}/../{app}/manifest.json", env!("CARGO_MANIFEST_DIR"));
            let text = std::fs::read_to_string(&path).unwrap();
            let manifest = parse_manifest(&text).unwrap_or_else(|error| panic!("{app}: {error}"));
            assert_eq!(manifest.actions.len(), actions, "{app} actions");
            assert_eq!(manifest.queries.len(), queries, "{app} queries");
            total = (total.0 + actions, total.1 + queries);
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
        assert_eq!(total, (145, 46));
        // the orders are 0..N with no hole, so the generated enum is dense
        let expected: BTreeSet<u32> = (0..u32::try_from(orders.len()).unwrap()).collect();
        assert_eq!(orders, expected);
    }
}
