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

use std::collections::BTreeSet;

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
        actions.push(ActionEntry {
            name,
            description: optional_string(entry, "description"),
            confirmation,
            input: input.clone(),
            output: field(entry, "output").cloned(),
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
        let action =
            minimal(r#", "actions": [{"name": "_private", "confirmation": "none", "input": {}}]"#);
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
            r#", "actions": [{"name": "search", "confirmation": "none", "input": {}}], "queries": [{"name": "search", "input": {}}]"#,
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
                r#", "actions": [{{"name": "add", "confirmation": "none", "input": {{}}, {declared}}}]"#
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
        let plain =
            minimal(r#", "actions": [{"name": "add", "confirmation": "none", "input": {}}]"#);
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
}
