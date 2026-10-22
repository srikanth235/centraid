//! The catalog the chat tables are generated from (#1135): the manifests are the one list of what
//! an app can do, `native/meta.rs` holds no kind or verb row of its own, the declared rows name
//! columns and values the vault has, and `contracts/assist/catalog-census.csv` says, per action,
//! what the catalog and the first five columns of the census can be checked against.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use centraid_apps_kit::manifest::ChatSurface;
use centraid_nativetools::export::{catalog, manifests};
use centraid_nativetools::meta::{self, DECLARED_KINDS, DECLARED_VERBS, KINDS, Kind, VERBS};

/// The ontology's rendered DDL, for the CHECK lists the declared enums must equal.
const DDL: &str = include_str!("../../../contracts/schema/vault-ddl.sql");
const META_SOURCE: &str = include_str!("../../assist/src/native/meta.rs");

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn meta_rs_holds_no_kind_or_verb_row() {
    // The tables are `include!`d from the build script's output; a row written back by hand would
    // be a second copy that drifts.
    for marker in [
        "KindSpec {\n        kind:",
        "VerbSpec {\n        verb:",
        "enum Verb",
        "enum Kind",
    ] {
        assert!(
            !META_SOURCE.contains(marker),
            "meta.rs holds a hand-written `{marker}`; it belongs to the manifests (crates/assist/build.rs)"
        );
    }
    assert!(META_SOURCE.contains("catalog.rs"));
}

#[test]
fn every_live_verb_row_is_a_direct_action_or_an_unbacked_row() {
    let all = manifests();
    let unbacked: BTreeSet<(String, String, String)> = {
        let verbs: serde_json::Value =
            serde_json::from_str(centraid_apps_kit::manifest::CHAT_VERBS_JSON).unwrap();
        verbs["unbacked"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    row["verb"].as_str().unwrap().to_owned(),
                    row["kind"].as_str().unwrap().to_owned(),
                    row["command"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    };
    let mut backed = 0;
    let mut loose = 0;
    for spec in VERBS {
        for (kind, command) in spec.commands {
            let kind = serde_json::to_value(kind).unwrap();
            let kind = kind.as_str().unwrap();
            let by_action = all.iter().flat_map(|(_, m)| &m.actions).any(|action| {
                action.chat == ChatSurface::Direct
                    && action.kind == kind
                    && action.command == *command
                    && (action.verb == spec.name || action.also.iter().any(|v| v == spec.name))
            });
            let by_row =
                unbacked.contains(&(spec.name.to_owned(), kind.to_owned(), (*command).to_owned()));
            assert!(
                by_action ^ by_row,
                "`{} {kind}` ({command}) must be backed by exactly one of a direct action or an unbacked row",
                spec.name
            );
            backed += usize::from(by_action);
            loose += usize::from(by_row);
        }
    }
    assert_eq!(
        loose,
        unbacked.len(),
        "an unbacked row names no live verb row"
    );
    assert!(backed > 40, "{backed} rows backed by actions");
}

#[test]
fn a_declared_kind_has_no_variant_and_a_declared_verb_names_a_catalog_action() {
    let live: BTreeSet<&str> = KINDS.iter().map(|spec| spec.name).collect();
    for declared in DECLARED_KINDS {
        assert!(!live.contains(declared.name), "{} is live", declared.name);
        assert!(
            Kind::parse(declared.name).is_none(),
            "{} parses",
            declared.name
        );
    }
    let ids: BTreeSet<&str> = DECLARED_KINDS.iter().map(|kind| kind.id).collect();
    for expected in [
        "daily_figure",
        "workout",
        "account",
        "category",
        "budget",
        "rule",
    ] {
        assert!(ids.contains(expected), "no declared kind {expected}");
    }
    let all = manifests();
    for row in DECLARED_VERBS {
        let found = all.iter().filter(|(app, _)| *app == row.app).any(|(_, m)| {
            m.action(row.action)
                .is_some_and(|a| a.command == row.command)
        });
        assert!(
            found,
            "{}/{} is not an action of the catalog",
            row.app, row.action
        );
    }
    // Transaction is writable in the table, and not yet by the runtime.
    let writes: BTreeSet<&str> = DECLARED_VERBS
        .iter()
        .filter(|row| row.kind == "transaction")
        .map(|row| row.verb)
        .collect();
    for verb in ["edit", "categorize", "link", "unlink"] {
        assert!(writes.contains(verb), "no declared `{verb} transaction`");
    }
}

/// The values of `column`'s `CHECK (column IN (...))` in `table`'s block of the rendered DDL.
fn check_values(table: &str, column: &str) -> Vec<String> {
    let head = format!(" {table} (\n");
    let start = DDL
        .find(&head)
        .unwrap_or_else(|| panic!("the DDL has no {table}"));
    let rest = &DDL[start..];
    let sql = &rest[..rest.find("\n);").unwrap_or(rest.len())];
    let marker = format!("CHECK ({column} IN (");
    let at = sql
        .find(&marker)
        .unwrap_or_else(|| panic!("{table}.{column} has no CHECK list"));
    let rest = &sql[at + marker.len()..];
    rest[..rest.find("))").unwrap()]
        .split(',')
        .map(|value| value.trim().trim_matches('\'').to_owned())
        .collect()
}

#[test]
fn every_declared_enum_is_exactly_its_columns_check_list() {
    let mut seen = 0;
    for kind in DECLARED_KINDS {
        for field in kind.fields.iter().filter(|field| !field.values.is_empty()) {
            let mut said: Vec<&str> = field.values.iter().map(|(_, vault)| *vault).collect();
            let mut check = check_values(field.source.table, field.source.column);
            said.sort_unstable();
            check.sort_unstable();
            assert_eq!(said, check, "{}.{}", kind.id, field.name);
            seen += 1;
        }
    }
    assert_eq!(seen, 2, "daily_figure.metric and account.type");
    // and the live kinds' enums are still the live test's (`meta.rs`)
    assert!(!meta::mapped_columns().is_empty());
}

#[test]
fn the_census_lists_every_action_as_its_manifest_classifies_it() {
    let text = std::fs::read_to_string(repo().join("contracts/assist/catalog-census.csv"))
        .expect("contracts/assist/catalog-census.csv");
    let mut lines = text.lines();
    assert_eq!(
        lines.next().unwrap(),
        "app,action,verb,kind,chat_surface,reachable_from_screen_today,reachable_from_chat_today"
    );
    let mut expected = Vec::new();
    for (app, manifest) in manifests() {
        for action in &manifest.actions {
            expected.push((
                app.to_owned(),
                action.name.clone(),
                action.verb.clone(),
                action.kind.clone(),
                match action.chat {
                    ChatSurface::Direct => "direct",
                    ChatSurface::Card => "card",
                },
            ));
        }
    }
    let rows: Vec<Vec<&str>> = lines.map(|line| line.split(',').collect()).collect();
    assert_eq!(rows.len(), 145);
    assert_eq!(rows.len(), expected.len());
    for (row, want) in rows.iter().zip(&expected) {
        assert_eq!(row.len(), 7, "{row:?}");
        assert_eq!(
            (row[0], row[1], row[2], row[3], row[4]),
            (
                want.0.as_str(),
                want.1.as_str(),
                want.2.as_str(),
                want.3.as_str(),
                want.4
            ),
            "the census row for {}/{} drifted from its manifest",
            want.0,
            want.1
        );
        assert!(row[5] == "no" || row[5].starts_with("yes: "), "{row:?}");
        assert!(row[6] == "no" || row[6] == "yes", "{row:?}");
        // a screen claim cites files that exist
        if let Some(files) = row[5].strip_prefix("yes: ") {
            for file in files.split("; ") {
                let path = repo()
                    .join("mobile/shared/src/commonMain/kotlin/dev/centraid/shared")
                    .join(file);
                assert!(
                    path.is_file(),
                    "{} cites {file}, which does not exist",
                    row[1]
                );
            }
        }
    }
}

#[test]
fn the_exported_catalog_is_the_manifests() {
    let exported = catalog();
    assert_eq!(exported["actions"].as_array().unwrap().len(), 145);
    assert_eq!(exported["queries"].as_array().unwrap().len(), 46);
}
