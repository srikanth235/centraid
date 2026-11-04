//! STAGE 0, THE CATALOG: the only schema the pipeline reads.
//!
//! Nothing here is a second copy of what the runtime knows. Kinds, fields, fixed-list values,
//! links and verbs come from `centraid_assist::native::meta` (itself generated from the app
//! manifests, `crates/assist/build.rs`); the app that owns a kind comes from the manifest that
//! declares it; the stock category and workout-kind lists are read out of the founding schema,
//! `contracts/migrations/001_baseline.sql`. What this file adds is what the runtime does not
//! state: each `do` verb's argument class (the #1166 table), the new eight-tool surface and the
//! compute ops the pipeline will plan, each marked `live` while the runtime does not run it yet.
//! [`Catalog::hash`] is a BLAKE3 over the catalog's canonical JSON, recorded in every manifest.

use std::collections::BTreeMap;

use centraid_assist::native::meta::{self, FieldType, KINDS, VERBS};
use centraid_nativetools::export::manifests;
use serde::Serialize;

/// The founding schema, whose concept rows state the stock category and workout-kind lists.
const BASELINE: &str = include_str!("../../../contracts/migrations/001_baseline.sql");

/// What a `do` verb takes besides its rows (#1166, "Verbs under `do`").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArgClass {
    None,
    Date,
    Row,
    Label,
    Choice,
}

/// The verb table of #1166. A runtime verb missing from it, or a row of it the runtime lacks,
/// fails [`Catalog::build`] so the two cannot drift apart unseen.
const VERB_CLASSES: &[(&str, ArgClass)] = &[
    ("complete", ArgClass::None),
    ("reopen", ArgClass::None),
    ("cancel", ArgClass::None),
    ("delete", ArgClass::None),
    ("restore", ArgClass::None),
    ("star", ArgClass::None),
    ("unstar", ArgClass::None),
    ("archive", ArgClass::None),
    ("unarchive", ArgClass::None),
    ("unlink", ArgClass::None),
    ("undo", ArgClass::None),
    ("reschedule", ArgClass::Date),
    ("add_to", ArgClass::Row),
    ("remove_from", ArgClass::Row),
    ("tag", ArgClass::Label),
    ("untag", ArgClass::Label),
    ("log", ArgClass::Choice),
    ("reveal", ArgClass::Choice),
];

/// Verbs that are tools of their own (`create`, `edit`), not `do` verbs.
const TOOL_VERBS: &[&str] = &["create", "edit"];

/// The eight tools of #1166 and the arguments each takes. `live` is whether the runtime runs a
/// tool of that name today; the regroup flips the rest.
const TOOLS: &[(&str, &str)] = &[
    ("find", "kind + filters, `text`, or `rows`"),
    ("compute", "kind + filters + op"),
    ("create", "kind + its fields"),
    ("edit", "rows + only the fields that change"),
    ("do", "rows + verb + at most one argument"),
    ("answer", "`@k` or a value"),
    ("ask", "question + options"),
    ("decline", "reason"),
];

/// The compute ops of #1166. `live` as for tools.
const OPS: &[&str] = &["count", "sum", "avg", "min", "max", "group", "compare"];

#[derive(Debug, Clone, Serialize)]
pub struct Field {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub unit: Option<String>,
    /// The fixed list of an enum field, as the model says them.
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Link {
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Kind {
    pub name: String,
    pub plural: String,
    pub app: String,
    /// The one date `when` filters on.
    pub date: Option<String>,
    pub fields: Vec<Field>,
    pub links: Vec<Link>,
    pub verbs: Vec<String>,
    pub trash: bool,
    pub container: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Verb {
    pub name: String,
    pub arg: ArgClass,
    /// The fixed list of a `choice` argument.
    pub choices: Vec<String>,
    pub kinds: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Tool {
    pub name: String,
    pub args: String,
    pub live: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Op {
    pub name: String,
    pub live: bool,
}

/// The whole schema.
#[derive(Debug, Clone, Serialize)]
pub struct Catalog {
    pub apps: Vec<String>,
    pub kinds: Vec<Kind>,
    pub verbs: Vec<Verb>,
    pub ops: Vec<Op>,
    pub tools: Vec<Tool>,
    /// Stock lists the vault founds: `category` notations and `workout_kind` keys.
    pub lists: BTreeMap<String, Vec<String>>,
    /// The Locker fields `reveal` opens. They are sealed: no world, prompt or record carries one.
    pub sealed: Vec<String>,
}

/// Why a catalog could not be built.
#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("the runtime has verb `{0}` and the #1166 verb table does not classify it")]
    UnclassifiedVerb(String),
    #[error("the #1166 verb table has `{0}` and the runtime has no such verb")]
    UnknownVerb(String),
    #[error("kind `{0}` is declared by no app manifest")]
    UnownedKind(String),
}

fn stock_list(prefix: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in BASELINE.lines() {
        // Concept rows read `('category:food.dining', 'category', 'food.dining', 'category:food')`;
        // the title rows beside them carry a display title and two stamps instead.
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

impl Catalog {
    /// Build the catalog from the runtime's tables.
    ///
    /// # Errors
    ///
    /// If the verb table and the runtime disagree, or a kind has no owning app.
    pub fn build() -> Result<Self, CatalogError> {
        let manifests = manifests();
        let apps: Vec<String> = manifests.iter().map(|(app, _)| (*app).to_owned()).collect();
        let mut kinds = Vec::new();
        for spec in KINDS {
            let owner = manifests
                .iter()
                .find(|(_, manifest)| manifest.kinds.iter().any(|k| k.name == spec.name))
                .map(|(app, _)| (*app).to_owned())
                .ok_or_else(|| CatalogError::UnownedKind(spec.name.to_owned()))?;
            kinds.push(Kind {
                name: spec.name.to_owned(),
                plural: spec.plural.to_owned(),
                app: owner,
                date: spec.date.map(|date| date.label.to_owned()),
                fields: spec
                    .fields
                    .iter()
                    .map(|field| Field {
                        name: field.name.to_owned(),
                        ty: match field.ty {
                            FieldType::Text => "text",
                            FieldType::Number => "number",
                            FieldType::Money => "money",
                            FieldType::Enum => "enum",
                            FieldType::Bool => "bool",
                            FieldType::Date => "date",
                        }
                        .to_owned(),
                        unit: field.unit.map(str::to_owned),
                        values: field
                            .values
                            .iter()
                            .map(|(name, _)| (*name).to_owned())
                            .collect(),
                    })
                    .collect(),
                links: spec
                    .links
                    .iter()
                    .map(|link| Link {
                        kind: link.kind.name().to_owned(),
                        label: link.label.to_owned(),
                    })
                    .collect(),
                verbs: spec
                    .verbs()
                    .iter()
                    .map(|verb| verb.spec().name.to_owned())
                    .collect(),
                trash: spec.trash,
                container: spec.container,
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
            let arg = VERB_CLASSES
                .iter()
                .find(|(name, _)| *name == spec.name)
                .map(|(_, class)| *class)
                .ok_or_else(|| CatalogError::UnclassifiedVerb(spec.name.to_owned()))?;
            let choices = match spec.name {
                "log" => meta::LOG_KINDS.iter().map(|c| (*c).to_owned()).collect(),
                "reveal" => sealed.clone(),
                _ => Vec::new(),
            };
            verbs.push(Verb {
                name: spec.name.to_owned(),
                arg,
                choices,
                // `undo` is the runtime's own: no kind backs it, every row can be undone
                kinds: spec
                    .commands
                    .iter()
                    .map(|(kind, _)| kind.name().to_owned())
                    .collect(),
            });
        }
        for (name, _) in VERB_CLASSES {
            if !verbs.iter().any(|verb| verb.name == *name) {
                return Err(CatalogError::UnknownVerb((*name).to_owned()));
            }
        }
        let mut lists = BTreeMap::new();
        lists.insert("category".to_owned(), stock_list("category:"));
        lists.insert("workout_kind".to_owned(), stock_list("workout_kind:"));
        Ok(Self {
            apps,
            kinds,
            verbs,
            ops: OPS
                .iter()
                .map(|name| Op {
                    name: (*name).to_owned(),
                    live: meta::OPS.contains(name),
                })
                .collect(),
            tools: TOOLS
                .iter()
                .map(|(name, args)| Tool {
                    name: (*name).to_owned(),
                    args: (*args).to_owned(),
                    live: meta::TOOLS.contains(name),
                })
                .collect(),
            lists,
            sealed,
        })
    }

    /// The canonical text the hash covers: struct fields in declaration order, lists in their
    /// table order, maps by key.
    ///
    /// # Panics
    ///
    /// Never: the catalog is plain data.
    #[must_use]
    pub fn canonical(&self) -> String {
        serde_json::to_string(self).expect("the catalog is plain data")
    }

    /// A stable content hash: BLAKE3 hex of [`Catalog::canonical`].
    #[must_use]
    pub fn hash(&self) -> String {
        blake3::hash(self.canonical().as_bytes())
            .to_hex()
            .to_string()
    }

    #[must_use]
    pub fn kind(&self, name: &str) -> Option<&Kind> {
        self.kinds.iter().find(|kind| kind.name == name)
    }

    #[must_use]
    pub fn verb(&self, name: &str) -> Option<&Verb> {
        self.verbs.iter().find(|verb| verb.name == name)
    }

    /// The kinds an app owns.
    pub fn kinds_of<'a>(&'a self, app: &'a str) -> impl Iterator<Item = &'a Kind> {
        self.kinds.iter().filter(move |kind| kind.app == app)
    }

    /// Counts for the report: `(kinds, verbs, fields)`.
    #[must_use]
    pub fn counts(&self) -> (usize, usize, usize) {
        (
            self.kinds.len(),
            self.verbs.len(),
            self.kinds.iter().map(|kind| kind.fields.len()).sum(),
        )
    }
}
