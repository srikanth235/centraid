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
//!
//! One thing this port makes stricter, recorded as D-1020-D3-5 in the receipt:
//! **`writes` is required on every action**, not optional. v0's schema has it
//! optional and the `declared-writes` directive re-imposes it from outside with
//! a shell script that takes no waiver, because "JSON has no comments and the
//! right opt-out is the explicit empty array"
//! (`.governance/packs/.../handler-contract/constitution.md:5`, `:10`). A gate
//! outside the type is a gate that can be forgotten; here the type is the gate,
//! and `[]` is still valid and still means "no database writes".

use std::collections::{BTreeMap, BTreeSet};

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

#[derive(Debug, Clone, PartialEq)]
pub struct ActionEntry {
    pub name: String,
    pub description: Option<String>,
    pub confirmation: Confirmation,
    /// The JSON Schema the dispatcher validates a body against, as data.
    pub input: Value,
    pub output: Option<Value>,
    /// Required here; `[]` means "no database writes". Carried verbatim to the
    /// change bus for per-table query invalidation, and NOT the share
    /// doorbell.
    pub writes: Vec<String>,
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

/// What a MEMBER can do with the rows a read scope hands back.
///
/// The doors serve 119 (entity, door) pairs and a member never sees most of
/// them: a door reads `core_link` to render a backlink, not so anyone can ask
/// for their links. Which pairs a member can NAME is a product decision, so
/// every read scope declares one of these rather than leaving a parser to
/// guess. `crates/evalsuite/grammar/derive/derive_grammar.py` computes the
/// DEFAULT from the ontology and `emit.py` holds the `Kind` declarations and
/// the grammar's Kind table to each other, both ways.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    /// A member names it as a thing and asks for the board.
    Kind,
    /// A row that only exists inside a parent kind — reachable as
    /// `X of (Kind …)`, never as a bare board.
    Facet,
    /// Plumbing: an edge, a revision, a representation, a row a door joins
    /// through.
    Internal,
}

impl Surface {
    fn parse(word: &str) -> Option<Self> {
        Some(match word {
            "kind" => Self::Kind,
            "facet" => Self::Facet,
            "internal" => Self::Internal,
            _ => return None,
        })
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Kind => "kind",
            Self::Facet => "facet",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct VaultScope {
    pub schema: String,
    pub table: Option<String>,
    pub verbs: ScopeVerbs,
    pub row_filter: Vec<RowFilter>,
    pub field_mask: Option<Vec<String>>,
    /// The declared surface of every entity this scope grants, by TABLE name.
    /// A named scope holds exactly one entry; a whole-schema scope holds one
    /// per entity it serves, because one grant covers several and they do not
    /// share a surface. Empty for a scope with no `read` verb.
    pub surface: BTreeMap<String, Surface>,
    /// Why a declared surface departs from the derivation's default, by table.
    /// Required there and refused nowhere — the derivation is what checks that
    /// an override carries one.
    pub surface_reason: BTreeMap<String, String>,
}

/// A fact an app's READER computes and hands back beside a row.
///
/// GRAMMAR.md §2.2 admits these as Fields and they appear in no column list,
/// so until now the only statement that one existed was the grammar naming it
/// — and four of them turned out to be computed by nothing this product ships.
/// The app declares them instead: what computes the field, and which tables
/// that reader reads. `computed_by: None` is a declared GAP, not an omission,
/// and it must carry the `gap` note that says so.
#[derive(Debug, Clone, PartialEq)]
pub struct DerivedField {
    pub field: String,
    /// The entity whose rows carry it.
    pub entity: Option<String>,
    /// The reader or statement that produces it, or `None` where nothing does.
    pub computed_by: Option<String>,
    /// Required exactly when `computed_by` is `None`.
    pub gap: Option<String>,
    /// The logical tables the reader reads. Every one must lie inside this
    /// app's own read scopes.
    pub inputs: Vec<String>,
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
    /// App-declared tables the gateway creates inside the vault. **No bundled
    /// app uses `ext`**; the block is read so a manifest that grows one is not
    /// silently dropped.
    pub ext_tables: Vec<String>,
    /// Reader-computed Fields this app declares. See [`DerivedField`].
    pub derived_fields: Vec<DerivedField>,
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

    /// Every table any action declares it writes, deduplicated.
    pub fn declared_writes(&self) -> BTreeSet<&str> {
        self.actions
            .iter()
            .flat_map(|action| action.writes.iter().map(String::as_str))
            .collect()
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
    let derived_fields = parse_derived_fields(&raw, vault.as_ref())?;
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
        ext_tables,
        derived_fields,
    })
}

/// `derivedFields`, held to this app's own read scopes.
///
/// The check that earns the block: a derived field naming a table the app may
/// not read is a claim the app could not honour, and it would have gone
/// unnoticed exactly as `owed_to_me` did — stated by the grammar, scored by the
/// corpus, computed by nothing.
fn parse_derived_fields(raw: &Value, vault: Option<&VaultBlock>) -> KitResult<Vec<DerivedField>> {
    let entries = match field(raw, "derivedFields") {
        None => return Ok(Vec::new()),
        Some(Value::Array(entries)) => entries.clone(),
        Some(_) => {
            return Err(KitError::manifest(
                "invalid_field",
                "\"derivedFields\" must be an array",
                Some("derivedFields"),
            ));
        }
    };
    // What the app may READ, as `schema.table` plus the whole-schema grants.
    let mut named: BTreeSet<String> = BTreeSet::new();
    let mut wide: BTreeSet<String> = BTreeSet::new();
    for scope in vault.map(|block| block.scopes.as_slice()).unwrap_or(&[]) {
        if !matches!(scope.verbs, ScopeVerbs::Read | ScopeVerbs::ReadAct) {
            continue;
        }
        match &scope.table {
            Some(table) => {
                named.insert(format!("{}.{table}", scope.schema));
            }
            None => {
                wide.insert(scope.schema.clone());
            }
        }
    }
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out = Vec::with_capacity(entries.len());
    for entry in &entries {
        let name = required_string(entry, "field", "derivedFields[].field")?;
        let path = format!("derivedFields[field={name}]");
        if !seen.insert(name.clone()) {
            return Err(KitError::manifest(
                "duplicate_handler",
                format!("manifest declares the derived field \"{name}\" twice"),
                Some(&path),
            ));
        }
        let computed_by = optional_string(entry, "computedBy");
        let gap = optional_string(entry, "gap");
        if computed_by.is_none() && gap.is_none() {
            return Err(KitError::manifest(
                "invalid_field",
                format!(
                    "derived field \"{name}\" names no \"computedBy\"; name the reader, or say in \"gap\" that nothing computes it"
                ),
                Some(&path),
            ));
        }
        let inputs = string_list(entry, "inputs", &path)?;
        if inputs.is_empty() {
            return Err(KitError::manifest(
                "invalid_field",
                format!("derived field \"{name}\" names no \"inputs\""),
                Some(&path),
            ));
        }
        for input in &inputs {
            let schema = input.split('.').next().unwrap_or_default();
            if named.contains(input) || wide.contains(schema) {
                continue;
            }
            return Err(KitError::manifest(
                "invalid_field",
                format!(
                    "derived field \"{name}\" reads \"{input}\", which this app's vault read scopes do not grant"
                ),
                Some(&path),
            ));
        }
        out.push(DerivedField {
            field: name,
            entity: optional_string(entry, "entity"),
            computed_by,
            gap,
            inputs,
        });
    }
    Ok(out)
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
        // Required here, unlike v0. `[]` is valid and means "no writes".
        if field(entry, "writes").is_none() {
            return Err(KitError::manifest(
                "invalid_handler_entry",
                format!(
                    "action \"{name}\" declares no \"writes\"; list the tables it writes, or [] to say it writes none"
                ),
                Some(&path),
            ));
        }
        actions.push(ActionEntry {
            name,
            description: optional_string(entry, "description"),
            confirmation,
            input: input.clone(),
            output: field(entry, "output").cloned(),
            writes: string_list(entry, "writes", &path)?,
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
        queries.push(QueryEntry {
            name,
            description: optional_string(entry, "description"),
            input: input.clone(),
            output: field(entry, "output").cloned(),
            reads: string_list(entry, "reads", &path)?,
        });
    }
    Ok(queries)
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

/// `surface` (and its optional `surfaceReason`) on one vault scope.
///
/// A NAMED read scope declares a string; a WHOLE-SCHEMA read scope declares an
/// object keyed by table, because one grant covers several entities and they
/// do not share a surface — Agenda's single `schedule` grant carries tasks,
/// projects, sections and the recurrence machinery at once. An undeclared or
/// misspelt value fails here, so a scope cannot quietly opt out of saying what
/// a member may name.
fn parse_surface(
    entry: &Value,
    schema: &str,
    table: Option<&str>,
    verbs: ScopeVerbs,
) -> KitResult<(BTreeMap<String, Surface>, BTreeMap<String, String>)> {
    let named = table.map_or_else(
        || format!("{schema}.*"),
        |table| format!("{schema}.{table}"),
    );
    let reading = matches!(verbs, ScopeVerbs::Read | ScopeVerbs::ReadAct);
    let Some(declared) = field(entry, "surface") else {
        if reading {
            return Err(KitError::manifest(
                "missing_field",
                format!(
                    "vault read scope on \"{named}\" declares no \"surface\"; one of kind, facet, internal"
                ),
                Some("vault.scopes[].surface"),
            ));
        }
        return Ok((BTreeMap::new(), BTreeMap::new()));
    };
    if !reading {
        return Err(KitError::manifest(
            "invalid_field",
            format!("vault scope on \"{named}\" declares a \"surface\" and no read verb"),
            Some("vault.scopes[].surface"),
        ));
    }
    let bad = |word: &str| {
        KitError::manifest(
            "invalid_field",
            format!(
                "vault scope on \"{named}\" declares surface \"{word}\"; one of kind, facet, internal"
            ),
            Some("vault.scopes[].surface"),
        )
    };
    let mut surface = BTreeMap::new();
    match (declared, table) {
        (Value::String(word), Some(table)) => {
            surface.insert(
                table.to_owned(),
                Surface::parse(word).ok_or_else(|| bad(word))?,
            );
        }
        (Value::Object(entries), None) => {
            for (key, value) in entries {
                let word = value.as_str().ok_or_else(|| bad("<not a string>"))?;
                surface.insert(key.clone(), Surface::parse(word).ok_or_else(|| bad(word))?);
            }
            if surface.is_empty() {
                return Err(KitError::manifest(
                    "invalid_field",
                    format!("whole-schema read scope on \"{named}\" declares an empty surface map"),
                    Some("vault.scopes[].surface"),
                ));
            }
        }
        (_, Some(_)) => return Err(bad("<not a string>")),
        (_, None) => {
            return Err(KitError::manifest(
                "invalid_field",
                format!(
                    "whole-schema read scope on \"{named}\" must declare \"surface\" as an object keyed by table"
                ),
                Some("vault.scopes[].surface"),
            ));
        }
    }
    let mut reason = BTreeMap::new();
    match field(entry, "surfaceReason") {
        None => {}
        Some(Value::String(why)) if table.is_some() => {
            reason.insert(table.unwrap_or_default().to_owned(), why.clone());
        }
        Some(Value::Object(entries)) if table.is_none() => {
            for (key, value) in entries {
                let why = value.as_str().ok_or_else(|| {
                    KitError::manifest(
                        "invalid_field",
                        format!("\"surfaceReason\" on \"{named}\" must hold strings"),
                        Some("vault.scopes[].surfaceReason"),
                    )
                })?;
                if !surface.contains_key(key) {
                    return Err(KitError::manifest(
                        "invalid_field",
                        format!(
                            "\"surfaceReason\" on \"{named}\" explains \"{key}\", which the scope's surface map does not name"
                        ),
                        Some("vault.scopes[].surfaceReason"),
                    ));
                }
                reason.insert(key.clone(), why.to_owned());
            }
        }
        Some(_) => {
            return Err(KitError::manifest(
                "invalid_field",
                format!(
                    "\"surfaceReason\" on \"{named}\" must match \"surface\": a string beside a string, an object beside an object"
                ),
                Some("vault.scopes[].surfaceReason"),
            ));
        }
    }
    Ok((surface, reason))
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
        let table = optional_string(entry, "table");
        let (surface, surface_reason) = parse_surface(entry, &schema, table.as_deref(), verbs)?;
        scopes.push(VaultScope {
            schema,
            table,
            verbs,
            row_filter,
            field_mask,
            surface,
            surface_reason,
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
            r#"{{"manifestVersion": 1, "id": "tally", "name": "Tally", "version": "0.3.0"{extra}}}"#
        )
    }

    fn scope(scope: &str) -> String {
        minimal(&format!(r#", "vault": {{"scopes": [{scope}]}}"#))
    }

    #[test]
    fn a_read_scope_must_declare_a_surface() {
        let error = parse_manifest(&scope(
            r#"{"schema": "core", "table": "event", "verbs": "read"}"#,
        ))
        .unwrap_err();
        assert!(
            format!("{error:?}").contains("surface"),
            "a read scope with no surface must name the field: {error:?}"
        );
    }

    #[test]
    fn a_misspelt_surface_is_refused() {
        let error = parse_manifest(&scope(
            r#"{"schema": "core", "table": "event", "verbs": "read", "surface": "Kind"}"#,
        ))
        .unwrap_err();
        assert!(
            format!("{error:?}").contains("kind, facet, internal"),
            "the refusal must name the three values: {error:?}"
        );
    }

    #[test]
    fn a_whole_schema_read_scope_declares_a_surface_per_table() {
        // One grant, several entities, and they do not share a surface: a
        // string here would silently give every table in the schema the same
        // answer.
        parse_manifest(&scope(
            r#"{"schema": "schedule", "verbs": "read", "surface": "kind"}"#,
        ))
        .unwrap_err();
        let manifest = parse_manifest(&scope(
            r#"{"schema": "schedule", "verbs": "read",
                "surface": {"task": "kind", "section": "facet"}}"#,
        ))
        .expect("a per-table surface map is the shape a whole-schema scope takes");
        let scopes = &manifest.vault.expect("vault block").scopes;
        assert_eq!(scopes[0].surface.get("task"), Some(&Surface::Kind));
        assert_eq!(scopes[0].surface.get("section"), Some(&Surface::Facet));
    }

    #[test]
    fn a_surface_reason_must_explain_a_table_the_scope_names() {
        parse_manifest(&scope(
            r#"{"schema": "schedule", "verbs": "read", "surface": {"task": "kind"},
                "surfaceReason": {"project": "…"}}"#,
        ))
        .unwrap_err();
    }

    #[test]
    fn an_act_only_scope_declares_no_surface() {
        // `surface` says what a member may NAME among the rows a scope hands
        // back, and an act scope hands none back.
        let manifest = parse_manifest(&scope(
            r#"{"schema": "knowledge", "table": "create_note", "verbs": "act"}"#,
        ))
        .expect("an act scope is complete without a surface");
        assert!(
            manifest.vault.expect("vault block").scopes[0]
                .surface
                .is_empty()
        );
        parse_manifest(&scope(
            r#"{"schema": "knowledge", "table": "create_note", "verbs": "act", "surface": "kind"}"#,
        ))
        .unwrap_err();
    }

    #[test]
    fn a_derived_field_may_only_read_what_the_app_may_read() {
        // The check that earns the block. `owed_to_me` was stated by the
        // grammar, scored by the corpus and computed by nothing; a field that
        // names a table the app cannot read is the same failure one step
        // earlier.
        let granted = minimal(
            r#", "vault": {"scopes": [{"schema": "tally", "table": "obligation", "verbs": "read", "surface": "kind"}]},
                "derivedFields": [{"field": "owed_to_me", "computedBy": null,
                                   "gap": "no shipped reader",
                                   "inputs": ["tally.obligation"]}]"#,
        );
        let manifest = parse_manifest(&granted).expect("a granted input is fine");
        assert_eq!(manifest.derived_fields[0].field, "owed_to_me");
        assert!(manifest.derived_fields[0].computed_by.is_none());

        let ungranted = minimal(
            r#", "vault": {"scopes": [{"schema": "tally", "table": "obligation", "verbs": "read", "surface": "kind"}]},
                "derivedFields": [{"field": "owed_to_me", "computedBy": "x.rs",
                                   "inputs": ["locker.item"]}]"#,
        );
        let error = parse_manifest(&ungranted).unwrap_err();
        assert!(
            format!("{error:?}").contains("read scopes do not grant"),
            "{error:?}"
        );
    }

    #[test]
    fn a_derived_field_with_no_reader_must_say_so() {
        // `computedBy: null` is a STATEMENT — the product ships nothing that
        // computes this — and it only counts as one beside the note.
        let silent = minimal(
            r#", "derivedFields": [{"field": "next_occurrence", "computedBy": null,
                                    "inputs": ["people.important_date"]}]"#,
        );
        let error = parse_manifest(&silent).unwrap_err();
        assert!(format!("{error:?}").contains("gap"), "{error:?}");
    }

    #[test]
    fn a_derived_field_needs_inputs() {
        let empty = minimal(
            r#", "derivedFields": [{"field": "balance", "computedBy": "balance.rs", "inputs": []}]"#,
        );
        assert!(parse_manifest(&empty).is_err());
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
        let action = minimal(
            r#", "actions": [{"name": "_private", "confirmation": "none", "input": {}, "writes": []}]"#,
        );
        assert!(matches!(
            parse_manifest(&action).unwrap_err(),
            KitError::Manifest {
                code: "reserved_handler_name",
                ..
            }
        ));
        let query = minimal(r#", "queries": [{"name": "_private", "input": {}}]"#);
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
        let both = minimal(
            r#", "actions": [{"name": "search", "confirmation": "none", "input": {}, "writes": []}], "queries": [{"name": "search", "input": {}}]"#,
        );
        parse_manifest(&both).unwrap();
        let twice = minimal(
            r#", "queries": [{"name": "search", "input": {}}, {"name": "search", "input": {}}]"#,
        );
        assert!(matches!(
            parse_manifest(&twice).unwrap_err(),
            KitError::Manifest {
                code: "duplicate_handler",
                ..
            }
        ));
    }

    #[test]
    fn an_action_with_no_writes_key_is_refused() {
        let text =
            minimal(r#", "actions": [{"name": "add", "confirmation": "none", "input": {}}]"#);
        let error = parse_manifest(&text).unwrap_err();
        assert!(matches!(
            error,
            KitError::Manifest {
                code: "invalid_handler_entry",
                ..
            }
        ));
        // `[]` is valid and says "no database writes".
        let empty = minimal(
            r#", "actions": [{"name": "add", "confirmation": "none", "input": {}, "writes": []}]"#,
        );
        assert!(parse_manifest(&empty).unwrap().actions[0].writes.is_empty());
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
}
