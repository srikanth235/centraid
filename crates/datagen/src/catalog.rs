//! STAGE 0, THE CATALOG: the compact schema view derived from [`crate::declarations::Declarations`].
//!
//! Nothing here duplicates the runtime's tables. All kinds, fields, enums, links, verbs, tools,
//! compute ops, stock lists, and sealed fields come from [`crate::declarations::Declarations::build`].
//! [`Catalog::hash`] is a BLAKE3 over the catalog's canonical JSON, recorded in manifests and read by
//! `cargo xtask rules` (`data-pin`).

use std::collections::BTreeMap;

use serde::Serialize;

pub use crate::declarations::ArgClass;
use crate::declarations::{Declarations, DeclarationsError};

#[derive(Debug, Clone, Serialize)]
pub struct Field {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub unit: Option<String>,
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

/// The schema derived from [`Declarations`].
#[derive(Debug, Clone, Serialize)]
pub struct Catalog {
    pub apps: Vec<String>,
    pub kinds: Vec<Kind>,
    pub verbs: Vec<Verb>,
    pub ops: Vec<Op>,
    pub tools: Vec<Tool>,
    pub lists: BTreeMap<String, Vec<String>>,
    pub titles: BTreeMap<String, String>,
    pub sealed: Vec<String>,
}

pub type CatalogError = DeclarationsError;

impl Catalog {
    /// Build the catalog from the runtime's declarations.
    ///
    /// # Errors
    ///
    /// If declarations cannot be built from `centraid_assist::native::meta`.
    pub fn build() -> Result<Self, CatalogError> {
        let decls = Declarations::build()?;
        Ok(Self::from_declarations(&decls))
    }

    /// Derive the compact catalog view from a [`Declarations`] snapshot.
    #[must_use]
    pub fn from_declarations(decls: &Declarations) -> Self {
        let kinds = decls
            .kinds
            .iter()
            .map(|k| Kind {
                name: k.name.clone(),
                plural: k.plural.clone(),
                app: k.app.clone(),
                date: k.date.clone(),
                fields: k
                    .fields
                    .iter()
                    .map(|f| Field {
                        name: f.name.clone(),
                        ty: f.ty.clone(),
                        unit: f.unit.clone(),
                        values: f.values.clone(),
                    })
                    .collect(),
                links: k
                    .links
                    .iter()
                    .map(|l| Link {
                        kind: l.kind.clone(),
                        label: l.label.clone(),
                    })
                    .collect(),
                verbs: k.verbs.clone(),
                trash: k.trash,
                container: k.container,
            })
            .collect();

        let verbs = decls
            .verbs
            .iter()
            .map(|v| Verb {
                name: v.name.clone(),
                arg: v.arg,
                choices: v.choices.clone(),
                kinds: v.kinds.clone(),
            })
            .collect();

        let ops = decls
            .ops
            .iter()
            .map(|o| Op {
                name: o.name.clone(),
                live: o.live,
            })
            .collect();

        let tools = decls
            .tools
            .iter()
            .map(|t| Tool {
                name: t.name.clone(),
                args: t
                    .args
                    .iter()
                    .map(|a| a.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
                live: t.live,
            })
            .collect();

        Self {
            apps: decls.apps.clone(),
            kinds,
            verbs,
            ops,
            tools,
            lists: decls.lists.clone(),
            titles: decls.titles.clone(),
            sealed: decls.sealed.clone(),
        }
    }

    /// Canonical JSON covered by [`Self::hash`].
    ///
    /// # Panics
    ///
    /// Never: the catalog is plain data.
    #[must_use]
    pub fn canonical(&self) -> String {
        serde_json::to_string(self).expect("the catalog is plain data")
    }

    /// BLAKE3 hex of [`Self::canonical`].
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

    pub fn kinds_of<'a>(&'a self, app: &'a str) -> impl Iterator<Item = &'a Kind> {
        self.kinds.iter().filter(move |kind| kind.app == app)
    }

    /// `(kinds, verbs, fields)`.
    #[must_use]
    pub fn counts(&self) -> (usize, usize, usize) {
        (
            self.kinds.len(),
            self.verbs.len(),
            self.kinds.iter().map(|kind| kind.fields.len()).sum(),
        )
    }
}
