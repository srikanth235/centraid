//! PART 1, DECLARATIONS & CHANGE CLASSIFIER: the single schema derived from `centraid_assist::native::meta`
//! (`ALL_MANIFEST_ACTIONS`, `KINDS`, `VERBS`, `ACTIONS`, `ActionSurface`) and `prompt::tools()`.
//!
//! Every tool, kind, field, verb, argument, and manifest action carries `{type, value_maker, live, wording_hint,
//! meaning_key}`. `meaning_key` captures semantic meaning rather than tool or argument spelling, so renaming or
//! reordering an argument classifies as `Rename` (rebuild targets only, 0 writer tokens).

use std::collections::{BTreeMap, BTreeSet};

use centraid_assist::native::meta::{self, ActionSurface, FieldType, KINDS, VERBS};
use centraid_assist::native::prompt;
use centraid_nativetools::export::manifests;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The founding schema, whose concept rows state the stock `category` and `workout_kind` lists.
const BASELINE: &str = include_str!("../../../contracts/migrations/001_baseline.sql");

/// Money currencies mixed across fixture worlds, with ~40% `INR` base currency.
pub const CURRENCIES: [&str; 6] = ["INR", "USD", "EUR", "GBP", "AED", "SGD"];
pub const INR_BASE_SHARE: f64 = 0.40;

/// What a `do` verb takes besides its rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArgClass {
    None,
    Date,
    Row,
    Label,
    Choice,
    Multi,
}

/// How values for a declaration/field/argument are synthesized.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ValueMaker {
    Text {
        pool: String,
    },
    Number {
        unit: Option<String>,
        min: f64,
        max: f64,
    },
    Money {
        currencies: Vec<String>,
        inr_share: f64,
    },
    Enum {
        values: Vec<String>,
    },
    Bool,
    Date,
    RowRef,
    RowsList,
    ValueHandle,
    KindName,
    VerbName,
    OpName,
    FieldName,
    GroupExpr,
    WhereExpr,
    WhenExpr,
    OrderExpr,
    LimitInt,
    ArgsLines,
    QuestionText,
    DeclineReason,
    SyntheticSecret {
        field: String,
    },
    ToolAction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArgDecl {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub value_maker: ValueMaker,
    pub live: bool,
    pub wording_hint: String,
    pub meaning_key: String,
    pub required: bool,
    pub enum_values: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolDecl {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub value_maker: ValueMaker,
    pub live: bool,
    pub wording_hint: String,
    pub meaning_key: String,
    pub args: Vec<ArgDecl>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldDecl {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub unit: Option<String>,
    pub values: Vec<String>,
    pub value_maker: ValueMaker,
    pub live: bool,
    pub wording_hint: String,
    pub meaning_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkDecl {
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KindDecl {
    pub name: String,
    pub plural: String,
    pub app: String,
    pub date: Option<String>,
    pub fields: Vec<FieldDecl>,
    pub links: Vec<LinkDecl>,
    pub verbs: Vec<String>,
    pub trash: bool,
    pub container: bool,
    #[serde(rename = "type")]
    pub ty: String,
    pub value_maker: ValueMaker,
    pub live: bool,
    pub wording_hint: String,
    pub meaning_key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerbDecl {
    pub name: String,
    pub arg: ArgClass,
    pub choices: Vec<String>,
    pub kinds: Vec<String>,
    #[serde(rename = "type")]
    pub ty: String,
    pub value_maker: ValueMaker,
    pub live: bool,
    pub wording_hint: String,
    pub meaning_key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpDecl {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub value_maker: ValueMaker,
    pub live: bool,
    pub wording_hint: String,
    pub meaning_key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestActionDecl {
    pub app: String,
    pub action: String,
    pub verb: String,
    pub kind: String,
    pub qualifier: Option<String>,
    pub surface: String,
    pub command: String,
    pub tool_path: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub value_maker: ValueMaker,
    pub live: bool,
    pub wording_hint: String,
    pub meaning_key: String,
}

/// Complete declarations derived from `centraid_assist::native::{meta, prompt}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Declarations {
    pub apps: Vec<String>,
    pub tools: Vec<ToolDecl>,
    pub kinds: Vec<KindDecl>,
    pub verbs: Vec<VerbDecl>,
    pub ops: Vec<OpDecl>,
    pub manifest_actions: Vec<ManifestActionDecl>,
    pub lists: BTreeMap<String, Vec<String>>,
    pub titles: BTreeMap<String, String>,
    pub sealed: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum DeclarationsError {
    #[error("the runtime has verb `{0}` and the verb table does not classify it")]
    UnclassifiedVerb(String),
    #[error("the verb table has `{0}` and the runtime has no such verb")]
    UnknownVerb(String),
    #[error("kind `{0}` is declared by no app manifest")]
    UnownedKind(String),
    #[error("manifest action `{app}.{action}` has no declared tool path")]
    MissingToolPath { app: String, action: String },
}

const VERB_CLASSES: &[(&str, ArgClass, &str)] = &[
    ("complete", ArgClass::None, "mark a task done"),
    ("reopen", ArgClass::None, "reopen a completed task"),
    ("cancel", ArgClass::None, "cancel an event or task"),
    ("delete", ArgClass::None, "move a row to trash"),
    ("restore", ArgClass::None, "restore a row from trash"),
    ("star", ArgClass::None, "star or favorite a row"),
    ("unstar", ArgClass::None, "remove the star from a row"),
    ("archive", ArgClass::None, "archive a row"),
    ("unarchive", ArgClass::None, "unarchive a row"),
    ("unlink", ArgClass::None, "unlink a linked row or transfer"),
    ("undo", ArgClass::None, "undo the most recent write"),
    ("purge", ArgClass::None, "permanently delete a trashed row"),
    (
        "duplicate",
        ArgClass::None,
        "make a duplicate copy of a row",
    ),
    ("apply", ArgClass::None, "apply a categorization rule"),
    ("empty_trash", ArgClass::None, "empty the trash for an app"),
    ("export", ArgClass::None, "export data out of an app"),
    ("import", ArgClass::None, "import data into an app"),
    (
        "follow",
        ArgClass::None,
        "connect or follow an external source",
    ),
    (
        "edit_media",
        ArgClass::None,
        "open media editor for a photo",
    ),
    ("configure", ArgClass::None, "configure settings or passkey"),
    (
        "reschedule",
        ArgClass::Date,
        "move a task or event to another date or time",
    ),
    ("add_to", ArgClass::Row, "put a row into a container"),
    (
        "remove_from",
        ArgClass::Row,
        "take a row out of a container",
    ),
    ("attach", ArgClass::Row, "attach a row to another row"),
    ("detach", ArgClass::Row, "detach a row from another row"),
    ("link", ArgClass::Row, "link two rows together"),
    ("merge", ArgClass::Row, "merge a row into another row"),
    ("tag", ArgClass::Label, "add a label or tag to a row"),
    ("untag", ArgClass::Label, "remove a label or tag from a row"),
    ("categorize", ArgClass::Label, "assign a spending category"),
    ("log", ArgClass::Choice, "log a contact or health check-in"),
    (
        "reveal",
        ArgClass::Choice,
        "request to reveal a sealed locker field",
    ),
    (
        "respond",
        ArgClass::Choice,
        "respond to an event invitation",
    ),
    (
        "unfollow",
        ArgClass::Multi,
        "stop following an external source",
    ),
    (
        "restore_version",
        ArgClass::Multi,
        "restore an earlier version of a document",
    ),
    ("recolor", ArgClass::Multi, "change the color of a label"),
    ("create", ArgClass::Multi, "create a new row"),
    ("edit", ArgClass::Multi, "edit fields on an existing row"),
];

const TOOL_VERBS: &[&str] = &["create", "edit"];
const OPS: &[&str] = &["count", "sum", "avg", "min", "max", "group", "compare"];
const OP_ARGUMENTS: &[&str] = &["group"];

fn stock_list(prefix: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in BASELINE.lines() {
        let Some(rest) = line.trim().strip_prefix("('") else {
            continue;
        };
        let Some((id, tail)) = rest.split_once("', '") else {
            continue;
        };
        let Some(key) = id.strip_prefix(prefix) else {
            continue;
        };
        if tail.contains(&format!("', '{key}'")) && !found.iter().any(|k| k == key) {
            found.push(key.to_owned());
        }
    }
    found
}

fn stock_titles(prefix: &str) -> BTreeMap<String, String> {
    let mut found = BTreeMap::new();
    for line in BASELINE.lines() {
        let Some(rest) = line.trim().strip_prefix("('") else {
            continue;
        };
        let fields: Vec<&str> = rest.split("', '").collect();
        if let [id, _, title, _, _] = fields.as_slice()
            && let Some(key) = id.strip_prefix(prefix)
        {
            found.insert(key.to_owned(), (*title).to_owned());
        }
    }
    found
}

fn money_value_maker() -> ValueMaker {
    ValueMaker::Money {
        currencies: CURRENCIES.iter().map(|c| (*c).to_owned()).collect(),
        inr_share: INR_BASE_SHARE,
    }
}

fn field_value_maker(
    kind_name: &str,
    name: &str,
    ty: FieldType,
    unit: Option<&str>,
    values: &[String],
) -> ValueMaker {
    if kind_name == "locker item" && matches!(name, "username" | "url" | "notes") {
        return ValueMaker::Text {
            pool: format!("locker.{name}"),
        };
    }
    match ty {
        FieldType::Money => money_value_maker(),
        FieldType::Number => {
            let (min, max) = match (kind_name, name) {
                ("task", "priority") => (0.0, 9.0),
                ("task", "effort") => (5.0, 240.0),
                ("event", "duration") => (15.0, 180.0),
                ("person", "cadence") => (7.0, 90.0),
                ("place", "lat") => (-60.0, 60.0),
                ("place", "lon") => (-120.0, 140.0),
                _ => (1.0, 500.0),
            };
            ValueMaker::Number {
                unit: unit.map(str::to_owned),
                min,
                max,
            }
        }
        FieldType::Enum => ValueMaker::Enum {
            values: values.to_vec(),
        },
        FieldType::Bool => ValueMaker::Bool,
        FieldType::Date => ValueMaker::Date,
        FieldType::Text => ValueMaker::Text {
            pool: format!("{kind_name}.{name}"),
        },
    }
}

fn field_wording_hint(kind_name: &str, name: &str, ty: FieldType, unit: Option<&str>) -> String {
    let plain = name.replace('_', " ");
    match ty {
        FieldType::Money => format!(
            "the {plain} of the {kind_name} as a money amount in the vault's or account's currency"
        ),
        FieldType::Number => match unit {
            Some(u) => format!("the {plain} of the {kind_name} in {u}"),
            None => format!("the {plain} number of the {kind_name}"),
        },
        FieldType::Enum => format!("the {plain} status or choice of the {kind_name}"),
        FieldType::Bool => format!("whether the {kind_name} is {plain}"),
        FieldType::Date => format!("the {plain} date of the {kind_name}"),
        FieldType::Text => format!("the {plain} of the {kind_name}"),
    }
}

type FieldMetaMap = BTreeMap<String, (String, FieldType, Option<String>, Vec<String>)>;

fn arg_decl_for(
    tool_name: &str,
    arg_name: &str,
    schema: &Value,
    required: bool,
    field_map: &FieldMetaMap,
) -> ArgDecl {
    let ty = schema["type"].as_str().unwrap_or("string").to_owned();
    let enum_values: Vec<String> = schema["enum"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let desc = schema["description"].as_str().unwrap_or("");
    let (value_maker, wording_hint, meaning_key) = match arg_name {
        "kind" => (
            ValueMaker::KindName,
            "the kind of item being asked about".to_owned(),
            "arg:semantic.entity_kind".to_owned(),
        ),
        "name" => (
            ValueMaker::Text {
                pool: "row.name".to_owned(),
            },
            "the name or title of the item".to_owned(),
            "arg:semantic.row_name".to_owned(),
        ),
        "where" => (
            ValueMaker::WhereExpr,
            "field conditions that narrow which items match".to_owned(),
            "arg:semantic.filter_predicate".to_owned(),
        ),
        "when" => (
            ValueMaker::WhenExpr,
            "a natural date or period expression".to_owned(),
            "arg:semantic.date_period".to_owned(),
        ),
        "linked_to" => (
            ValueMaker::RowRef,
            "the related person, list, folder, album, or event".to_owned(),
            "arg:semantic.linked_row".to_owned(),
        ),
        "within" => (
            ValueMaker::RowRef,
            "an earlier result set being narrowed".to_owned(),
            "arg:semantic.narrow_set".to_owned(),
        ),
        "exclude" => (
            ValueMaker::RowsList,
            "rows explicitly ruled out".to_owned(),
            "arg:semantic.exclude_rows".to_owned(),
        ),
        "order" => (
            ValueMaker::OrderExpr,
            "sort field and direction".to_owned(),
            "arg:semantic.sort_order".to_owned(),
        ),
        "limit" => (
            ValueMaker::LimitInt,
            "how many items to keep".to_owned(),
            "arg:semantic.result_limit".to_owned(),
        ),
        "trashed" => (
            ValueMaker::Bool,
            "whether to look in the trash".to_owned(),
            "arg:semantic.in_trash".to_owned(),
        ),
        "text" => (
            ValueMaker::Text {
                pool: "search.text".to_owned(),
            },
            "search words matching across names".to_owned(),
            "arg:semantic.fuzzy_query".to_owned(),
        ),
        "rows" => (
            ValueMaker::RowsList,
            "which shown items the action applies to".to_owned(),
            format!("arg:semantic.{tool_name}.target_rows"),
        ),
        "op" => (
            ValueMaker::OpName,
            "the calculation to perform (count, sum, avg, min, max, compare)".to_owned(),
            "arg:semantic.aggregate_op".to_owned(),
        ),
        "field" => (
            ValueMaker::FieldName,
            "the numeric or money field to aggregate".to_owned(),
            "arg:semantic.aggregate_field".to_owned(),
        ),
        "group" => (
            ValueMaker::GroupExpr,
            "how to group results by field or time period".to_owned(),
            "arg:semantic.group_by".to_owned(),
        ),
        "value" => (
            ValueMaker::ValueHandle,
            "the computed result value to present".to_owned(),
            "arg:semantic.answer_value".to_owned(),
        ),
        "verb" => (
            ValueMaker::VerbName,
            "the action to perform on the item".to_owned(),
            "arg:semantic.do_verb".to_owned(),
        ),
        "args" => (
            ValueMaker::ArgsLines,
            "parameters needed by the verb (target date, container, label, or secret field)"
                .to_owned(),
            "arg:semantic.verb_args".to_owned(),
        ),
        "more" => (
            ValueMaker::Bool,
            "chained step before ending the turn".to_owned(),
            format!("arg:semantic.{tool_name}.chain_more"),
        ),
        "question" => (
            ValueMaker::QuestionText,
            "clarifying question for the member".to_owned(),
            "arg:semantic.ask_question".to_owned(),
        ),
        "options" => (
            ValueMaker::RowsList,
            "ambiguous candidate items to choose among".to_owned(),
            "arg:semantic.ask_options".to_owned(),
        ),
        "reason" => (
            ValueMaker::DeclineReason,
            "why the request cannot be carried out".to_owned(),
            "arg:semantic.decline_reason".to_owned(),
        ),
        other => {
            if let Some((k_name, f_ty, unit, vals)) = field_map.get(other) {
                (
                    field_value_maker(k_name, other, *f_ty, unit.as_deref(), vals),
                    field_wording_hint(k_name, other, *f_ty, unit.as_deref()),
                    format!("arg:field.{tool_name}.{}", semantic_field_tag(other)),
                )
            } else {
                (
                    ValueMaker::Text {
                        pool: format!("arg.{other}"),
                    },
                    if desc.is_empty() {
                        format!("plain value for {}", other.replace('_', " "))
                    } else {
                        desc.to_owned()
                    },
                    format!("arg:field.{tool_name}.{}", semantic_field_tag(other)),
                )
            }
        }
    };
    ArgDecl {
        name: arg_name.to_owned(),
        ty,
        value_maker,
        live: true,
        wording_hint,
        meaning_key,
        required,
        enum_values,
    }
}

fn semantic_field_tag(name: &str) -> &str {
    match name {
        "due" | "start" | "posted" | "taken" | "filed" | "day" | "month" => "primary_date",
        "amount" | "opening" => "money_amount",
        _ => name,
    }
}

fn tool_wording_hint(name: &str) -> &'static str {
    match name {
        "find" => "look up or filter items in the vault",
        "compute" => "count, total, average, min, max, group, or compare figures",
        "create" => "add a new item to the vault",
        "edit" => "update fields on an existing item",
        "do" => "perform a verb action or workflow handoff on an item or app",
        "answer" => "finish with the retrieved items or computed figure",
        "ask" => "ask the member to disambiguate among matching items",
        "decline" => "decline a request that is out of scope, unsafe, or not found",
        _ => "tool call",
    }
}

fn tool_path_for(verb: &str, qualifier: Option<&str>) -> String {
    match verb {
        "create" => "create".to_owned(),
        "edit" => match qualifier {
            Some(q) => format!("edit:{q}"),
            None => "edit".to_owned(),
        },
        other => match qualifier {
            Some(q) => format!("do:{other}:{q}"),
            None => format!("do:{other}"),
        },
    }
}

impl Declarations {
    /// Build complete declarations from `centraid_assist::native::{meta, prompt}` and founding lists.
    ///
    /// # Errors
    ///
    /// If a runtime verb is unclassified, a kind has no owning app, or a manifest action has no declared tool path.
    pub fn build() -> Result<Self, DeclarationsError> {
        let manifests = manifests();
        let apps: Vec<String> = manifests.iter().map(|(app, _)| (*app).to_owned()).collect();
        let mut field_map: BTreeMap<String, (String, FieldType, Option<String>, Vec<String>)> =
            BTreeMap::new();
        let mut kinds = Vec::new();
        for spec in KINDS {
            let owner = manifests
                .iter()
                .find(|(_, manifest)| manifest.kinds.iter().any(|k| k.name == spec.name))
                .map(|(app, _)| (*app).to_owned())
                .ok_or_else(|| DeclarationsError::UnownedKind(spec.name.to_owned()))?;
            let mut fields = Vec::new();
            for f in spec.fields {
                let vals: Vec<String> = f.values.iter().map(|(n, _)| (*n).to_owned()).collect();
                let ty_str = match f.ty {
                    FieldType::Text => "text",
                    FieldType::Number => "number",
                    FieldType::Money => "money",
                    FieldType::Enum => "enum",
                    FieldType::Bool => "bool",
                    FieldType::Date => "date",
                }
                .to_owned();
                field_map.entry(f.name.to_owned()).or_insert_with(|| {
                    (
                        spec.name.to_owned(),
                        f.ty,
                        f.unit.map(str::to_owned),
                        vals.clone(),
                    )
                });
                fields.push(FieldDecl {
                    name: f.name.to_owned(),
                    ty: ty_str,
                    unit: f.unit.map(str::to_owned),
                    values: vals.clone(),
                    value_maker: field_value_maker(spec.name, f.name, f.ty, f.unit, &vals),
                    live: true,
                    wording_hint: field_wording_hint(spec.name, f.name, f.ty, f.unit),
                    meaning_key: format!("field:{}:{}", spec.name, semantic_field_tag(f.name)),
                });
            }
            // Also register any create/edit action chat_names into field_map so tool args resolve cleanly.
            for action_name in meta::create_args(spec.kind) {
                field_map
                    .entry(action_name.to_owned())
                    .or_insert_with(|| (spec.name.to_owned(), FieldType::Text, None, Vec::new()));
            }
            for act in meta::edit_actions(spec.kind) {
                for chat_name in act.chat_names() {
                    field_map.entry(chat_name.to_owned()).or_insert_with(|| {
                        (spec.name.to_owned(), FieldType::Text, None, Vec::new())
                    });
                }
            }
            kinds.push(KindDecl {
                name: spec.name.to_owned(),
                plural: spec.plural.to_owned(),
                app: owner.clone(),
                date: spec.date.map(|d| d.label.to_owned()),
                fields,
                links: spec
                    .links
                    .iter()
                    .map(|l| LinkDecl {
                        kind: l.kind.name().to_owned(),
                        label: l.label.to_owned(),
                    })
                    .collect(),
                verbs: spec
                    .verbs()
                    .iter()
                    .map(|v| v.spec().name.to_owned())
                    .collect(),
                trash: spec.trash,
                container: spec.container,
                ty: "kind".to_owned(),
                value_maker: ValueMaker::KindName,
                live: true,
                wording_hint: format!("{} ({owner} app)", spec.plural),
                meaning_key: format!("kind:{owner}:{}", spec.name),
            });
        }

        let sealed: Vec<String> = meta::REVEAL_FIELDS
            .iter()
            .map(|(name, _)| (*name).to_owned())
            .collect();

        let mut verbs = Vec::new();
        for spec in VERBS {
            if TOOL_VERBS.contains(&spec.name) {
                continue;
            }
            let (arg, hint) = VERB_CLASSES
                .iter()
                .find(|(name, _, _)| *name == spec.name)
                .map(|(_, class, hint)| (*class, *hint))
                .ok_or_else(|| DeclarationsError::UnclassifiedVerb(spec.name.to_owned()))?;
            let choices: Vec<String> = match spec.name {
                "log" => meta::LOG_KINDS.iter().map(|c| (*c).to_owned()).collect(),
                "reveal" => sealed.clone(),
                "respond" => vec![
                    "accepted".to_owned(),
                    "declined".to_owned(),
                    "tentative".to_owned(),
                ],
                _ => Vec::new(),
            };
            let value_maker = if !choices.is_empty() {
                ValueMaker::Enum {
                    values: choices.clone(),
                }
            } else {
                match arg {
                    ArgClass::Date => ValueMaker::WhenExpr,
                    ArgClass::Row => ValueMaker::RowRef,
                    ArgClass::Label => ValueMaker::Text {
                        pool: format!("verb.{}", spec.name),
                    },
                    _ => ValueMaker::VerbName,
                }
            };
            verbs.push(VerbDecl {
                name: spec.name.to_owned(),
                arg,
                choices,
                kinds: spec
                    .commands
                    .iter()
                    .map(|(k, _)| k.name().to_owned())
                    .collect(),
                ty: "verb".to_owned(),
                value_maker,
                live: true,
                wording_hint: (*hint).to_owned(),
                meaning_key: format!("verb:{}", spec.name),
            });
        }
        for (name, _, _) in VERB_CLASSES {
            if TOOL_VERBS.contains(name) {
                continue;
            }
            if !verbs.iter().any(|v| v.name == *name) {
                return Err(DeclarationsError::UnknownVerb((*name).to_owned()));
            }
        }

        let ops: Vec<OpDecl> = OPS
            .iter()
            .map(|name| {
                let live = meta::OPS.contains(name) || OP_ARGUMENTS.contains(name);
                OpDecl {
                    name: (*name).to_owned(),
                    ty: "op".to_owned(),
                    value_maker: ValueMaker::OpName,
                    live,
                    wording_hint: format!("aggregate operation: {name}"),
                    meaning_key: format!("op:{name}"),
                }
            })
            .collect();

        let prompt_tools = prompt::tools();
        let mut tools = Vec::new();
        for t in &prompt_tools {
            let func = &t["function"];
            let name = func["name"].as_str().unwrap_or_default().to_owned();
            let required: BTreeSet<String> = func["parameters"]["required"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            let mut args = Vec::new();
            if let Some(props) = func["parameters"]["properties"].as_object() {
                for (arg_name, schema) in props {
                    args.push(arg_decl_for(
                        &name,
                        arg_name,
                        schema,
                        required.contains(arg_name),
                        &field_map,
                    ));
                }
            }
            tools.push(ToolDecl {
                live: meta::TOOLS.contains(&name.as_str()),
                ty: "tool".to_owned(),
                value_maker: ValueMaker::ToolAction,
                wording_hint: tool_wording_hint(&name).to_owned(),
                meaning_key: format!("tool:{name}"),
                name,
                args,
            });
        }

        let mut manifest_actions = Vec::new();
        for ma in meta::manifest_actions() {
            let verb_name = ma.verb.spec().name.to_owned();
            let kind_name = ma.kind.name().to_owned();
            let surface = match ma.surface {
                ActionSurface::Direct => "direct",
                ActionSurface::Handoff => "handoff",
            }
            .to_owned();
            let tool_path = tool_path_for(&verb_name, ma.qualifier);
            if tool_path.is_empty() {
                return Err(DeclarationsError::MissingToolPath {
                    app: ma.app.to_owned(),
                    action: ma.action.to_owned(),
                });
            }
            manifest_actions.push(ManifestActionDecl {
                app: ma.app.to_owned(),
                action: ma.action.to_owned(),
                verb: verb_name.clone(),
                kind: kind_name.clone(),
                qualifier: ma.qualifier.map(str::to_owned),
                surface: surface.clone(),
                command: ma.command.to_owned(),
                tool_path,
                ty: "manifest_action".to_owned(),
                value_maker: ValueMaker::ToolAction,
                live: true,
                wording_hint: format!("{} {kind_name} ({})", ma.action.replace('-', " "), ma.app),
                meaning_key: format!(
                    "action:{}:{}:{}:{}",
                    ma.app,
                    verb_name,
                    kind_name,
                    ma.qualifier.unwrap_or("-")
                ),
            });
        }

        let mut lists = BTreeMap::new();
        lists.insert("category".to_owned(), stock_list("category:"));
        lists.insert("workout_kind".to_owned(), stock_list("workout_kind:"));
        let mut titles = stock_titles("category:");
        titles.extend(stock_titles("workout_kind:"));

        Ok(Self {
            apps,
            tools,
            kinds,
            verbs,
            ops,
            manifest_actions,
            lists,
            titles,
            sealed,
        })
    }

    /// Canonical JSON representation covered by [`Self::hash`].
    ///
    /// # Panics
    ///
    /// Never: declarations are plain JSON data.
    #[must_use]
    pub fn canonical(&self) -> String {
        serde_json::to_string(self).expect("declarations are plain data")
    }

    /// BLAKE3 hex hash of [`Self::canonical`] (`declarations_hash`).
    #[must_use]
    pub fn hash(&self) -> String {
        blake3::hash(self.canonical().as_bytes())
            .to_hex()
            .to_string()
    }

    #[must_use]
    pub fn kind(&self, name: &str) -> Option<&KindDecl> {
        self.kinds.iter().find(|k| k.name == name)
    }

    #[must_use]
    pub fn verb(&self, name: &str) -> Option<&VerbDecl> {
        self.verbs.iter().find(|v| v.name == name)
    }

    #[must_use]
    pub fn tool(&self, name: &str) -> Option<&ToolDecl> {
        self.tools.iter().find(|t| t.name == name)
    }

    pub fn kinds_of<'a>(&'a self, app: &'a str) -> impl Iterator<Item = &'a KindDecl> {
        self.kinds.iter().filter(move |k| k.app == app)
    }

    #[must_use]
    pub fn counts(&self) -> (usize, usize, usize, usize) {
        (
            self.kinds.len(),
            self.verbs.len(),
            self.kinds.iter().map(|k| k.fields.len()).sum(),
            self.manifest_actions.len(),
        )
    }
}

// ------------------------------------------------------------------ Change Classifier (Part 1)

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    /// Tool/arg/field renamed, reformatted, or reordered without changing semantic meaning -> rebuild targets only (0 writer tokens).
    Rename,
    /// New live capability -> generate deficit intents only up to floor.
    Added,
    /// Semantic type, unit, enum set, or value_maker changed -> invalidate affected / convert to ask or decline (0 or minimal writer tokens).
    ChangedMeaning,
    /// Previously live capability removed or made non-live -> convert existing examples to decline (0 writer tokens).
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeItem {
    pub scope: String,
    pub meaning_key: String,
    pub prev_name: Option<String>,
    pub curr_name: Option<String>,
    pub kind: ChangeKind,
    pub detail: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeSet {
    pub items: Vec<ChangeItem>,
}

impl ChangeSet {
    #[must_use]
    pub fn by_kind(&self, kind: ChangeKind) -> Vec<&ChangeItem> {
        self.items.iter().filter(|i| i.kind == kind).collect()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    #[must_use]
    pub fn renamed_keys(&self) -> BTreeSet<String> {
        self.items
            .iter()
            .filter(|i| i.kind == ChangeKind::Rename)
            .map(|i| i.meaning_key.clone())
            .collect()
    }

    #[must_use]
    pub fn added_keys(&self) -> BTreeSet<String> {
        self.items
            .iter()
            .filter(|i| i.kind == ChangeKind::Added)
            .map(|i| i.meaning_key.clone())
            .collect()
    }

    #[must_use]
    pub fn invalidated_keys(&self) -> BTreeSet<String> {
        self.items
            .iter()
            .filter(|i| matches!(i.kind, ChangeKind::ChangedMeaning | ChangeKind::Removed))
            .map(|i| i.meaning_key.clone())
            .collect()
    }
}

#[derive(Clone, PartialEq)]
struct SnapshotEntry {
    scope: String,
    name: String,
    local_id: String,
    meaning_key: String,
    live: bool,
    ty: String,
    semantic_sig: String,
    wording_hint: String,
    order_pos: usize,
}

fn semantic_sig(ty: &str, unit: Option<&str>, values: &[String], vm: &ValueMaker) -> String {
    let vm_json = serde_json::to_string(vm).unwrap_or_default();
    format!("{ty}|{}|{}|{vm_json}", unit.unwrap_or(""), values.join(","))
}

fn flatten(decls: &Declarations) -> Vec<SnapshotEntry> {
    let mut out = Vec::new();
    for (ti, t) in decls.tools.iter().enumerate() {
        out.push(SnapshotEntry {
            scope: "tool".to_owned(),
            name: t.name.clone(),
            local_id: format!("tool:{}", t.name),
            meaning_key: t.meaning_key.clone(),
            live: t.live,
            ty: t.ty.clone(),
            semantic_sig: semantic_sig(&t.ty, None, &[], &t.value_maker),
            wording_hint: t.wording_hint.clone(),
            order_pos: ti,
        });
        for (ai, a) in t.args.iter().enumerate() {
            out.push(SnapshotEntry {
                scope: "arg".to_owned(),
                name: format!("{}.{}", t.name, a.name),
                local_id: format!("arg:{}.{}", t.name, a.name),
                meaning_key: a.meaning_key.clone(),
                live: t.live && a.live,
                ty: a.ty.clone(),
                semantic_sig: semantic_sig(&a.ty, None, &a.enum_values, &a.value_maker),
                wording_hint: a.wording_hint.clone(),
                order_pos: ai,
            });
        }
    }
    for (ki, k) in decls.kinds.iter().enumerate() {
        out.push(SnapshotEntry {
            scope: "kind".to_owned(),
            name: k.name.clone(),
            local_id: format!("kind:{}", k.name),
            meaning_key: k.meaning_key.clone(),
            live: k.live,
            ty: k.ty.clone(),
            semantic_sig: semantic_sig(&k.ty, None, &[], &k.value_maker),
            wording_hint: k.wording_hint.clone(),
            order_pos: ki,
        });
        for (fi, f) in k.fields.iter().enumerate() {
            out.push(SnapshotEntry {
                scope: "field".to_owned(),
                name: format!("{}.{}", k.name, f.name),
                local_id: format!("field:{}.{}", k.name, f.name),
                meaning_key: f.meaning_key.clone(),
                live: k.live && f.live,
                ty: f.ty.clone(),
                semantic_sig: semantic_sig(&f.ty, f.unit.as_deref(), &f.values, &f.value_maker),
                wording_hint: f.wording_hint.clone(),
                order_pos: fi,
            });
        }
    }
    for (vi, v) in decls.verbs.iter().enumerate() {
        out.push(SnapshotEntry {
            scope: "verb".to_owned(),
            name: v.name.clone(),
            local_id: format!("verb:{}", v.name),
            meaning_key: v.meaning_key.clone(),
            live: v.live,
            ty: v.ty.clone(),
            semantic_sig: semantic_sig(&v.ty, None, &v.choices, &v.value_maker),
            wording_hint: v.wording_hint.clone(),
            order_pos: vi,
        });
    }
    for (oi, o) in decls.ops.iter().enumerate() {
        out.push(SnapshotEntry {
            scope: "op".to_owned(),
            name: o.name.clone(),
            local_id: format!("op:{}", o.name),
            meaning_key: o.meaning_key.clone(),
            live: o.live,
            ty: o.ty.clone(),
            semantic_sig: semantic_sig(&o.ty, None, &[], &o.value_maker),
            wording_hint: o.wording_hint.clone(),
            order_pos: oi,
        });
    }
    for (mi, m) in decls.manifest_actions.iter().enumerate() {
        out.push(SnapshotEntry {
            scope: "action".to_owned(),
            name: format!("{}.{}", m.app, m.action),
            local_id: format!("action:{}.{}", m.app, m.action),
            meaning_key: m.meaning_key.clone(),
            live: m.live,
            ty: m.ty.clone(),
            semantic_sig: format!("{}|{}|{}", m.verb, m.kind, m.surface),
            wording_hint: m.wording_hint.clone(),
            order_pos: mi,
        });
    }
    out
}

/// Classify differences between a previous published [`Declarations`] snapshot and the current one.
#[must_use]
pub fn classify_diff(prev: &Declarations, curr: &Declarations) -> ChangeSet {
    let prev_entries = flatten(prev);
    let curr_entries = flatten(curr);

    let mut prev_by_mk: BTreeMap<String, SnapshotEntry> = BTreeMap::new();
    let mut prev_by_id: BTreeMap<String, SnapshotEntry> = BTreeMap::new();
    for e in prev_entries {
        prev_by_mk
            .entry(e.meaning_key.clone())
            .or_insert_with(|| e.clone());
        prev_by_id.entry(e.local_id.clone()).or_insert(e);
    }

    let mut curr_by_mk: BTreeMap<String, SnapshotEntry> = BTreeMap::new();
    let mut curr_by_id: BTreeMap<String, SnapshotEntry> = BTreeMap::new();
    for e in &curr_entries {
        curr_by_mk
            .entry(e.meaning_key.clone())
            .or_insert_with(|| e.clone());
        curr_by_id
            .entry(e.local_id.clone())
            .or_insert_with(|| e.clone());
    }

    let mut items = Vec::new();
    let mut handled_prev_mk: BTreeSet<String> = BTreeSet::new();
    let mut handled_curr_mk: BTreeSet<String> = BTreeSet::new();

    // Pass 1: exact meaning_key match (catches renames, reordered args, semantic shifts on same key, removals)
    for (mk, curr_e) in &curr_by_mk {
        if let Some(prev_e) = prev_by_mk.get(mk) {
            handled_prev_mk.insert(mk.clone());
            handled_curr_mk.insert(mk.clone());
            if prev_e.live && !curr_e.live {
                items.push(ChangeItem {
                    scope: curr_e.scope.clone(),
                    meaning_key: mk.clone(),
                    prev_name: Some(prev_e.name.clone()),
                    curr_name: Some(curr_e.name.clone()),
                    kind: ChangeKind::Removed,
                    detail: format!("{} `{}` is no longer live", curr_e.scope, curr_e.name),
                });
            } else if prev_e.semantic_sig != curr_e.semantic_sig {
                items.push(ChangeItem {
                    scope: curr_e.scope.clone(),
                    meaning_key: mk.clone(),
                    prev_name: Some(prev_e.name.clone()),
                    curr_name: Some(curr_e.name.clone()),
                    kind: ChangeKind::ChangedMeaning,
                    detail: format!(
                        "{} `{}` changed semantic definition",
                        curr_e.scope, curr_e.name
                    ),
                });
            } else if prev_e.name != curr_e.name
                || prev_e.order_pos != curr_e.order_pos
                || prev_e.wording_hint != curr_e.wording_hint
            {
                items.push(ChangeItem {
                    scope: curr_e.scope.clone(),
                    meaning_key: mk.clone(),
                    prev_name: Some(prev_e.name.clone()),
                    curr_name: Some(curr_e.name.clone()),
                    kind: ChangeKind::Rename,
                    detail: format!(
                        "{} `{}` -> `{}` (rename/reformat/reorder; 0 writer tokens)",
                        curr_e.scope, prev_e.name, curr_e.name
                    ),
                });
            }
        }
    }

    // Pass 2: same local_id (e.g. same kind.field name) whose meaning_key changed -> ChangedMeaning!
    for (mk, curr_e) in &curr_by_mk {
        if handled_curr_mk.contains(mk) {
            continue;
        }
        if let Some(prev_e) = prev_by_id.get(&curr_e.local_id)
            && !handled_prev_mk.contains(&prev_e.meaning_key)
        {
            handled_prev_mk.insert(prev_e.meaning_key.clone());
            handled_curr_mk.insert(mk.clone());
            items.push(ChangeItem {
                scope: curr_e.scope.clone(),
                meaning_key: prev_e.meaning_key.clone(),
                prev_name: Some(prev_e.name.clone()),
                curr_name: Some(curr_e.name.clone()),
                kind: ChangeKind::ChangedMeaning,
                detail: format!(
                    "{} `{}` changed meaning (`{}` -> `{}`)",
                    curr_e.scope, curr_e.name, prev_e.meaning_key, mk
                ),
            });
        }
    }

    // Pass 3: genuinely Added live entries
    for (mk, curr_e) in &curr_by_mk {
        if handled_curr_mk.contains(mk) || !curr_e.live {
            continue;
        }
        items.push(ChangeItem {
            scope: curr_e.scope.clone(),
            meaning_key: mk.clone(),
            prev_name: None,
            curr_name: Some(curr_e.name.clone()),
            kind: ChangeKind::Added,
            detail: format!("new live {} `{}`", curr_e.scope, curr_e.name),
        });
    }

    // Pass 4: Removed entries
    for (mk, prev_e) in &prev_by_mk {
        if handled_prev_mk.contains(mk) || !prev_e.live {
            continue;
        }
        items.push(ChangeItem {
            scope: prev_e.scope.clone(),
            meaning_key: mk.clone(),
            prev_name: Some(prev_e.name.clone()),
            curr_name: None,
            kind: ChangeKind::Removed,
            detail: format!("removed {} `{}`", prev_e.scope, prev_e.name),
        });
    }

    ChangeSet { items }
}
