//! `@[…]` anchors: the grammar, and the consent scope they collapse to
//! (#541; #1020, D-1020-AU6).
//!
//! ## What an anchor is for
//!
//! An automation's instructions may point at a specific passage in a specific
//! row — *"when the invoice at `@[…]` is paid, close the task"*. The token is
//! the **minimisation boundary**: the compiler derives the automation's read
//! grant from the trusted `core_link_anchor` row, **never from the token
//! text**, so an instruction cannot widen its own access by naming a table.
//!
//! This module is the pure half of that: the token grammar, the selector's
//! shape, and [`collapse_scopes`] — the algebra that turns a set of resolved
//! anchors into the narrowest set of scopes the vault can express. Resolution
//! itself is a read through the consent gateway with the owner credential, so
//! it lives where the gateway does; what lives here is everything that can be
//! got wrong without a database.
//!
//! ## The collapse, and the widening it refuses
//!
//! Vault row filters are AND clauses, so two separate same-table scopes would
//! make evaluation match only the first row. One `in` filter expresses the
//! intended bounded union instead.
//!
//! But the scope algebra applies **one field mask to every row in a filter**.
//! So `row A / title` plus `row B / description` cannot be represented without
//! also granting `A/description` and `B/title` — two pairs nobody asked for.
//! [`collapse_scopes`] **refuses** that rather than silently broadening
//! consent, which is the one behaviour in this file worth a test of its own.

use std::collections::{BTreeMap, BTreeSet};

/// The entity an anchor is stored in.
pub const ANCHOR_ENTITY: &str = "core.link_anchor";

/// Where in the source text an anchor points.
///
/// A `TextQuoteSelector` with a position: `exact` is the passage, `prefix` and
/// `suffix` are its neighbourhood, and `start` is where it was. All four are
/// checked, because text moves — the position finds it fast and the
/// neighbourhood proves it is the same passage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selector {
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
    pub start: usize,
}

/// Why a selector or a token was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AnchorError {
    #[error("anchor {anchor_id} has an invalid selector")]
    InvalidSelector { anchor_id: String },
    #[error("anchor {anchor_id} is missing or no longer live")]
    NotLive { anchor_id: String },
    #[error("anchor {anchor_id} no longer matches its source text")]
    NoLongerMatches { anchor_id: String },
    #[error("anchor {anchor_id} matches more than one source field")]
    Ambiguous { anchor_id: String },
    #[error("anchor {anchor_id} did not derive a narrow scope")]
    NotNarrow { anchor_id: String },
    #[error("anchors for {entity} disagree on their row key")]
    KeyDisagreement { entity: String },
    #[error(
        "anchors for {entity} cannot be combined without widening row/field access — the vault's \
         scope algebra applies one field mask to every row in a filter, so a non-rectangular set \
         would grant the cross pairs nobody asked for"
    )]
    WouldWiden { entity: String },
}

/// Parse a selector from its stored JSON.
///
/// Every field is checked: an `exact` of `""` would match everywhere, and a
/// negative `start` is not a position.
pub fn parse_selector(raw: &str, anchor_id: &str) -> Result<Selector, AnchorError> {
    let invalid = || AnchorError::InvalidSelector {
        anchor_id: anchor_id.to_owned(),
    };
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| invalid())?;
    let object = value.as_object().ok_or_else(invalid)?;
    let exact = object
        .get("exact")
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(invalid)?;
    let prefix = object
        .get("prefix")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    let suffix = object
        .get("suffix")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    let start = object
        .get("start")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(invalid)?;
    Ok(Selector {
        exact: exact.to_owned(),
        prefix: prefix.to_owned(),
        suffix: suffix.to_owned(),
        start: usize::try_from(start).map_err(|_| invalid())?,
    })
}

/// Does this selector still point at this text?
///
/// The position first, then the neighbourhood. Both, because the position
/// alone would match a passage that merely happens to sit at the same offset
/// after an edit, and the neighbourhood alone would match a repeated phrase.
#[must_use]
pub fn selector_matches(text: &str, selector: &Selector) -> bool {
    let at = selector.start;
    if !text.is_char_boundary(at) {
        return false;
    }
    let tail = &text[at..];
    if !tail.starts_with(&selector.exact) {
        return false;
    }
    let before = &text[..at];
    let after = &tail[selector.exact.len()..];
    (selector.prefix.is_empty() || before.ends_with(&selector.prefix))
        && (selector.suffix.is_empty() || after.starts_with(&selector.suffix))
}

/// The anchor ids an instruction names, in first-appearance order, deduped.
///
/// The grammar is `@[core.link_anchor/<anchorId>]` and it is deliberately
/// narrow: the entity is a LITERAL, so a token cannot name another table. An
/// id may not contain `]`, which is what ends it.
#[must_use]
pub fn anchor_ids(instructions: &str) -> Vec<String> {
    let opener = format!("@[{ANCHOR_ENTITY}/");
    let mut out: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    let mut rest = instructions;
    while let Some(at) = rest.find(&opener) {
        let after = &rest[at + opener.len()..];
        match after.find(']') {
            Some(end) if end > 0 => {
                let id = &after[..end];
                if !id.contains('[') && seen.insert(id.to_owned()) {
                    out.push(id.to_owned());
                }
                rest = &after[end + 1..];
            }
            // An unterminated token is not a token; skip past the opener so the
            // scan cannot loop.
            _ => rest = after,
        }
    }
    out
}

/// The token form of one id, for a round trip.
#[must_use]
pub fn anchor_token(anchor_id: &str) -> String {
    format!("@[{ANCHOR_ENTITY}/{anchor_id}]")
}

/// One scope the vault can express.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    pub schema: String,
    pub table: String,
    /// `read`. An anchor NEVER derives a write.
    pub verbs: &'static str,
    pub id_column: String,
    /// One id, or the bounded union.
    pub ids: Vec<String>,
    pub field_mask: Vec<String>,
}

/// One anchor, resolved against live rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAnchor {
    pub anchor_id: String,
    pub link_id: String,
    pub source_type: String,
    pub source_id: String,
    pub source_field: String,
    pub target_type: String,
    pub target_id: String,
    pub selector: Selector,
    /// The row key of the source table.
    pub id_column: String,
}

impl ResolvedAnchor {
    /// The `@[…]` token this anchor answers to.
    #[must_use]
    pub fn token(&self) -> String {
        anchor_token(&self.anchor_id)
    }

    /// `(schema, table)` of the source type.
    pub fn source_parts(&self) -> Result<(&str, &str), AnchorError> {
        self.source_type
            .split_once('.')
            .filter(|(schema, table)| !schema.is_empty() && !table.is_empty())
            .ok_or_else(|| AnchorError::NotNarrow {
                anchor_id: self.anchor_id.clone(),
            })
    }
}

/// Collapse same-table anchors into one scope each.
pub fn collapse_scopes(anchors: &[ResolvedAnchor]) -> Result<Vec<Scope>, AnchorError> {
    struct Group {
        schema: String,
        table: String,
        id_column: String,
        ids: Vec<String>,
        fields: BTreeSet<String>,
        fields_by_id: BTreeMap<String, BTreeSet<String>>,
    }
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for anchor in anchors {
        let (schema, table) = anchor.source_parts()?;
        if anchor.source_field.is_empty() || anchor.id_column.is_empty() {
            return Err(AnchorError::NotNarrow {
                anchor_id: anchor.anchor_id.clone(),
            });
        }
        let key = format!("{schema}.{table}");
        let group = groups.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            Group {
                schema: schema.to_owned(),
                table: table.to_owned(),
                id_column: anchor.id_column.clone(),
                ids: Vec::new(),
                fields: BTreeSet::new(),
                fields_by_id: BTreeMap::new(),
            }
        });
        if group.id_column != anchor.id_column {
            return Err(AnchorError::KeyDisagreement { entity: key });
        }
        if !group.ids.contains(&anchor.source_id) {
            group.ids.push(anchor.source_id.clone());
        }
        let row_fields = group
            .fields_by_id
            .entry(anchor.source_id.clone())
            .or_default();
        group.fields.insert(anchor.id_column.clone());
        group.fields.insert(anchor.source_field.clone());
        row_fields.insert(anchor.source_field.clone());
    }
    let mut out = Vec::with_capacity(order.len());
    for key in order {
        let group = groups.remove(&key).expect("inserted above");
        let value_fields: Vec<&String> = group
            .fields
            .iter()
            .filter(|field| **field != group.id_column)
            .collect();
        // THE REFUSAL. A non-rectangular set cannot be represented, so it is
        // refused rather than rounded up.
        for id in &group.ids {
            let row_fields = group.fields_by_id.get(id).cloned().unwrap_or_default();
            if value_fields
                .iter()
                .any(|field| !row_fields.contains(field.as_str()))
            {
                return Err(AnchorError::WouldWiden { entity: key });
            }
        }
        out.push(Scope {
            schema: group.schema,
            table: group.table,
            verbs: "read",
            id_column: group.id_column,
            ids: group.ids,
            field_mask: group.fields.into_iter().collect(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selector(exact: &str, prefix: &str, suffix: &str, start: usize) -> Selector {
        Selector {
            exact: exact.to_owned(),
            prefix: prefix.to_owned(),
            suffix: suffix.to_owned(),
            start,
        }
    }

    fn anchor(id: &str, source_id: &str, field: &str) -> ResolvedAnchor {
        ResolvedAnchor {
            anchor_id: id.to_owned(),
            link_id: format!("link-{id}"),
            source_type: "core.document".to_owned(),
            source_id: source_id.to_owned(),
            source_field: field.to_owned(),
            target_type: "core.event".to_owned(),
            target_id: "event-1".to_owned(),
            selector: selector("x", "", "", 0),
            id_column: "document_id".to_owned(),
        }
    }

    /// THE CORPUS. Every shape the grammar must and must not accept.
    #[test]
    fn the_token_grammar_over_a_corpus() {
        let cases: [(&str, &[&str]); 12] = [
            ("no anchors here", &[]),
            ("@[core.link_anchor/a1]", &["a1"]),
            ("before @[core.link_anchor/a1] after", &["a1"]),
            (
                "@[core.link_anchor/a1] and @[core.link_anchor/a2]",
                &["a1", "a2"],
            ),
            // Deduped, in FIRST-APPEARANCE order.
            (
                "@[core.link_anchor/b] @[core.link_anchor/a] @[core.link_anchor/b]",
                &["b", "a"],
            ),
            // Another entity is not an anchor: the entity is a literal.
            ("@[core.party/p1]", &[]),
            ("@[media.link_anchor/a1]", &[]),
            // An unterminated token is not a token, and does not hang the scan.
            ("@[core.link_anchor/a1", &[]),
            ("@[core.link_anchor/]", &[]),
            // Nested brackets are refused rather than half-read.
            ("@[core.link_anchor/a[1]]", &[]),
            // A bare mention is not an anchor.
            ("core.link_anchor/a1", &[]),
            (
                "line one @[core.link_anchor/uuid-4f2a]\nline two @[core.link_anchor/uuid-9b1c]",
                &["uuid-4f2a", "uuid-9b1c"],
            ),
        ];
        for (instructions, expected) in cases {
            assert_eq!(
                anchor_ids(instructions),
                expected
                    .iter()
                    .map(|id| (*id).to_owned())
                    .collect::<Vec<_>>(),
                "{instructions:?}"
            );
        }
        assert_eq!(anchor_token("a1"), "@[core.link_anchor/a1]");
        assert_eq!(anchor_ids(&anchor_token("a1")), ["a1"]);
    }

    #[test]
    fn a_selector_is_checked_in_full() {
        let raw = r#"{"exact":"the invoice","prefix":"pay ","suffix":" today","start":4}"#;
        let parsed = parse_selector(raw, "a1").expect("a selector");
        assert_eq!(parsed, selector("the invoice", "pay ", " today", 4));
        assert!(selector_matches("pay the invoice today", &parsed));
        // The position moved: no match.
        assert!(!selector_matches("please pay the invoice today", &parsed));
        // The neighbourhood changed: no match.
        assert!(!selector_matches("owe the invoice later", &parsed));
        for bad in [
            r#"{"exact":"","prefix":"","suffix":"","start":0}"#,
            r#"{"exact":"x","suffix":"","start":0}"#,
            r#"{"exact":"x","prefix":"","suffix":"","start":-1}"#,
            r#"{"exact":"x","prefix":"","suffix":"","start":1.5}"#,
            "[]",
            "not json",
        ] {
            assert_eq!(
                parse_selector(bad, "a1"),
                Err(AnchorError::InvalidSelector {
                    anchor_id: "a1".to_owned()
                }),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_selector_over_multibyte_text_does_not_panic() {
        // "café au lait": `é` occupies bytes 3 and 4, so an offset of 4 is
        // INSIDE a character. A naive slice would panic here.
        let inside = selector("au", "", "", 4);
        assert!(!selector_matches("café au lait", &inside));
        let aligned = selector("au", "café ", " lait", 6);
        assert!(selector_matches("café au lait", &aligned));
        // And past the end.
        assert!(!selector_matches("un", &selector("x", "", "", 99)));
    }

    #[test]
    fn same_table_anchors_collapse_into_one_bounded_union() {
        let anchors = [
            anchor("a1", "doc-1", "title"),
            anchor("a2", "doc-2", "title"),
        ];
        let scopes = collapse_scopes(&anchors).expect("rectangular");
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].table, "document");
        assert_eq!(scopes[0].verbs, "read");
        assert_eq!(scopes[0].ids, ["doc-1", "doc-2"]);
        assert_eq!(scopes[0].field_mask, ["document_id", "title"]);
    }

    /// THE REFUSAL: row A / title plus row B / description would grant the two
    /// cross pairs.
    #[test]
    fn a_non_rectangular_set_is_refused_rather_than_widened() {
        let anchors = [
            anchor("a1", "doc-1", "title"),
            anchor("a2", "doc-2", "description"),
        ];
        assert_eq!(
            collapse_scopes(&anchors),
            Err(AnchorError::WouldWiden {
                entity: "core.document".to_owned()
            })
        );
        // Two fields of the SAME row is rectangular, and legal.
        let same_row = [
            anchor("a1", "doc-1", "title"),
            anchor("a2", "doc-1", "description"),
        ];
        let scopes = collapse_scopes(&same_row).expect("rectangular");
        assert_eq!(scopes[0].ids, ["doc-1"]);
        assert_eq!(
            scopes[0].field_mask,
            ["description", "document_id", "title"]
        );
        // And the full rectangle of two rows × two fields is legal too.
        let rectangle = [
            anchor("a1", "doc-1", "title"),
            anchor("a2", "doc-1", "description"),
            anchor("a3", "doc-2", "title"),
            anchor("a4", "doc-2", "description"),
        ];
        assert!(collapse_scopes(&rectangle).is_ok());
    }

    #[test]
    fn anchors_in_different_tables_are_different_scopes_in_first_seen_order() {
        let mut other = anchor("a2", "asset-1", "caption");
        other.source_type = "media.asset".to_owned();
        other.id_column = "asset_id".to_owned();
        let scopes = collapse_scopes(&[anchor("a1", "doc-1", "title"), other]).expect("two tables");
        assert_eq!(scopes.len(), 2);
        assert_eq!(scopes[0].table, "document");
        assert_eq!(scopes[1].table, "asset");
    }

    #[test]
    fn anchors_that_disagree_on_a_row_key_refuse() {
        let mut odd = anchor("a2", "doc-2", "title");
        odd.id_column = "id".to_owned();
        assert_eq!(
            collapse_scopes(&[anchor("a1", "doc-1", "title"), odd]),
            Err(AnchorError::KeyDisagreement {
                entity: "core.document".to_owned()
            })
        );
    }

    #[test]
    fn an_anchor_with_no_narrow_scope_refuses() {
        let mut unqualified = anchor("a1", "doc-1", "title");
        unqualified.source_type = "document".to_owned();
        assert_eq!(
            collapse_scopes(&[unqualified]),
            Err(AnchorError::NotNarrow {
                anchor_id: "a1".to_owned()
            })
        );
        let mut fieldless = anchor("a1", "doc-1", "");
        fieldless.source_field = String::new();
        assert!(matches!(
            collapse_scopes(&[fieldless]),
            Err(AnchorError::NotNarrow { .. })
        ));
        assert!(collapse_scopes(&[]).expect("no anchors").is_empty());
    }

    /// An anchor never derives a WRITE.
    #[test]
    fn every_derived_scope_is_read_only() {
        let scopes = collapse_scopes(&[anchor("a1", "doc-1", "title")]).expect("one");
        for scope in scopes {
            assert_eq!(scope.verbs, "read");
        }
    }
}
