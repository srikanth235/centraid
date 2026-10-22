//! THE CHAT CATALOG, generated from the app manifests.
//!
//! The assistant's kind and verb tables used to be 1,200 lines of hand-written
//! rows that drifted from the apps. They are now derived here, at build time,
//! from the one catalog there is (#1135): each `crates/apps/<app>/manifest.json`
//! declares the model-facing `kinds` the app owns and classifies every action
//! (`verb`, `kind`, `also`, `chat`, `command`), and `contracts/assist/verbs.json`
//! is the verb vocabulary (its argument line, its past tense, whether the
//! runtime executes it yet) plus the few `unbacked` rows no app action backs.
//!
//! What this writes to `$OUT_DIR/catalog.rs` (included by `native/meta.rs`):
//!
//! * `Kind` and `Kind::ALL`: the kinds whose `live` is `write` or `read`, in
//!   their `order`. A kind that is `declared` has no variant, so no runtime
//!   code can reach it by accident; the app lane that makes it live flips the
//!   manifest and gets a compile error at every `match` that must learn it.
//! * `Verb`: the verbs of `verbs.json` marked `live`.
//! * `KINDS` and `VERBS`: the rows of the live kinds and verbs. A verb row is
//!   a `direct` action of a kind whose `live` is `write`, by its `verb` and
//!   each verb in its `also`; one (verb, kind) is one command.
//! * `DECLARED_KINDS` and `DECLARED_VERBS`: everything the catalog declares
//!   that the runtime does not run yet, so the export shows the whole catalog
//!   and a lane can see exactly what it has left to wire.
//!
//! A catalog that contradicts itself fails the build with the sentence that
//! names the manifest: an `unbacked` row an action now backs (delete the row),
//! two actions that are one (verb, kind), a link to a kind that is not live.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::Value;

fn camel(snake: &str) -> String {
    snake
        .split('_')
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("catalog: `{key}` is not a string in {value}"))
}

fn source(value: &Value) -> String {
    format!(
        "at({:?}, {:?})",
        value[0].as_str().expect("source table"),
        value[1].as_str().expect("source column")
    )
}

fn field_type(name: &str) -> &'static str {
    match name {
        "text" => "FieldType::Text",
        "number" => "FieldType::Number",
        "money" => "FieldType::Money",
        "enum" => "FieldType::Enum",
        "bool" => "FieldType::Bool",
        "date" => "FieldType::Date",
        other => panic!("catalog: unknown field type {other}"),
    }
}

fn via(name: &str) -> &'static str {
    match name {
        "attendee" => "Via::Attendee",
        "about" => "Via::About",
        "subtask" => "Via::Subtask",
        "list_column" => "Via::ListColumn",
        "entry" => "Via::Entry",
        "folder_column" => "Via::FolderColumn",
        other => panic!("catalog: unknown link via {other}"),
    }
}

/// `field(…).unit(…).values(…).edit(…).create()` for one declared field.
fn field_expr(field: &Value) -> String {
    let mut out = format!(
        "field({:?}, {}, {})",
        text(field, "name"),
        field_type(text(field, "type")),
        source(&field["source"])
    );
    if let Some(unit) = field["unit"].as_str() {
        match unit {
            "$priority_scale" => out.push_str(".unit(PRIORITY_SCALE)"),
            unit => {
                let _ = write!(out, ".unit({unit:?})");
            }
        }
    }
    match &field["values"] {
        Value::Null => {}
        Value::String(token) if token == "$locker_item_types" => {
            out.push_str(".values(&LOCKER_TYPES)");
        }
        Value::String(token) => panic!("catalog: unknown values token {token}"),
        Value::Array(pairs) => {
            out.push_str(".values(&[");
            for pair in pairs {
                let _ = write!(
                    out,
                    "({:?}, {:?}), ",
                    pair[0].as_str().expect("model value"),
                    pair[1].as_str().expect("vault value")
                );
            }
            out.push_str("])");
        }
        other => panic!("catalog: values is {other}"),
    }
    if let Some(command) = field["edit"].as_str() {
        let _ = write!(out, ".edit({command:?})");
    }
    if field["create"].as_bool().unwrap_or(false) {
        out.push_str(".create()");
    }
    out
}

fn manifests(root: &Path) -> Vec<(String, Value)> {
    let apps = root.join("crates/apps");
    let mut found = Vec::new();
    for entry in std::fs::read_dir(&apps).expect("crates/apps is readable") {
        let path: PathBuf = entry
            .expect("a directory entry")
            .path()
            .join("manifest.json");
        if path.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
            let text = std::fs::read_to_string(&path).expect("a readable manifest");
            let manifest: Value = serde_json::from_str(&text)
                .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()));
            found.push((text_of(&manifest, "id"), manifest));
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

fn text_of(value: &Value, key: &str) -> String {
    text(value, key).to_owned()
}

struct Row {
    app: String,
    action: String,
    verb: String,
    kind: String,
    command: String,
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let verbs_path = root.join("contracts/assist/verbs.json");
    println!("cargo:rerun-if-changed={}", verbs_path.display());
    let verbs: Value =
        serde_json::from_str(&std::fs::read_to_string(&verbs_path).expect("verbs.json"))
            .expect("verbs.json is JSON");
    let manifests = manifests(&root);

    // ---- kinds ----------------------------------------------------------------------------
    let mut kinds: Vec<(&str, &Value)> = manifests
        .iter()
        .flat_map(|(app, manifest)| {
            manifest["kinds"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .map(move |kind| (app.as_str(), kind))
        })
        .collect();
    kinds.sort_by_key(|(_, kind)| kind["order"].as_u64().expect("kind order"));
    let live: Vec<&(&str, &Value)> = kinds
        .iter()
        .filter(|(_, kind)| matches!(text(kind, "live"), "write" | "read"))
        .collect();
    let live_ids: Vec<&str> = live.iter().map(|(_, kind)| text(kind, "id")).collect();
    let writable: Vec<&str> = live
        .iter()
        .filter(|(_, kind)| text(kind, "live") == "write")
        .map(|(_, kind)| text(kind, "id"))
        .collect();

    let mut out = String::new();
    out.push_str(
        "// @generated by crates/assist/build.rs from the app manifests; do not edit.\n\n",
    );
    out.push_str("/// The model-facing kinds the runtime reads: generated from the manifests' `kinds` (`live` of `write` or `read`).\n");
    out.push_str(
        "#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]\n",
    );
    out.push_str("#[serde(rename_all = \"snake_case\")]\npub enum Kind {\n");
    for id in &live_ids {
        let _ = writeln!(out, "    {},", camel(id));
    }
    out.push_str("}\n\nimpl Kind {\n");
    let _ = writeln!(out, "    pub const ALL: [Self; {}] = [", live_ids.len());
    for id in &live_ids {
        let _ = writeln!(out, "        Self::{},", camel(id));
    }
    out.push_str("    ];\n}\n\n");

    out.push_str("pub static KINDS: &[KindSpec] = &[\n");
    for (_, kind) in &live {
        let id = text(kind, "id");
        let _ = writeln!(out, "    KindSpec {{");
        let _ = writeln!(out, "        kind: Kind::{},", camel(id));
        let _ = writeln!(out, "        name: {:?},", text(kind, "name"));
        let _ = writeln!(out, "        plural: {:?},", text(kind, "plural"));
        let _ = writeln!(out, "        entity: {:?},", text(kind, "entity"));
        let _ = writeln!(out, "        table: {:?},", text(kind, "table"));
        let _ = writeln!(out, "        pk: {:?},", text(kind, "pk"));
        let _ = writeln!(out, "        name_source: {},", source(&kind["nameSource"]));
        match kind["date"].as_object() {
            Some(date) => {
                let _ = writeln!(
                    out,
                    "        date: Some(DateSpec {{ label: {:?}, source: {} }}),",
                    date["label"].as_str().expect("date label"),
                    source(&date["source"])
                );
            }
            None => out.push_str("        date: None,\n"),
        }
        out.push_str("        fields: &[\n");
        for field in kind["fields"].as_array().expect("fields") {
            let _ = writeln!(out, "            {},", field_expr(field));
        }
        out.push_str("        ],\n        links: &[\n");
        for link in kind["links"].as_array().expect("links") {
            let target = text(link, "kind");
            assert!(
                live_ids.contains(&target),
                "catalog: {id} links to {target}, which is not a live kind"
            );
            let _ = writeln!(
                out,
                "            Link {{ kind: Kind::{}, label: {:?}, via: {} }},",
                camel(target),
                text(link, "label"),
                via(text(link, "via"))
            );
        }
        let _ = writeln!(
            out,
            "        ],\n        trash: {},\n        container: {},\n    }},",
            kind["trash"], kind["container"]
        );
    }
    out.push_str("];\n\n");

    out.push_str("pub static DECLARED_KINDS: &[DeclaredKind] = &[\n");
    for (app, kind) in kinds
        .iter()
        .filter(|(_, kind)| text(kind, "live") == "declared")
    {
        assert!(
            kind["links"].as_array().is_some_and(Vec::is_empty),
            "catalog: the declared kind {} declares links; a link needs a live kind on both ends",
            text(kind, "id")
        );
        let _ = writeln!(out, "    DeclaredKind {{");
        let _ = writeln!(out, "        app: {app:?},");
        let _ = writeln!(out, "        id: {:?},", text(kind, "id"));
        let _ = writeln!(out, "        name: {:?},", text(kind, "name"));
        let _ = writeln!(out, "        plural: {:?},", text(kind, "plural"));
        let _ = writeln!(out, "        entity: {:?},", text(kind, "entity"));
        let _ = writeln!(out, "        table: {:?},", text(kind, "table"));
        let _ = writeln!(out, "        pk: {:?},", text(kind, "pk"));
        let _ = writeln!(out, "        name_source: {},", source(&kind["nameSource"]));
        match kind["date"].as_object() {
            Some(date) => {
                let _ = writeln!(
                    out,
                    "        date: Some(DateSpec {{ label: {:?}, source: {} }}),",
                    date["label"].as_str().expect("date label"),
                    source(&date["source"])
                );
            }
            None => out.push_str("        date: None,\n"),
        }
        out.push_str("        fields: &[\n");
        for field in kind["fields"].as_array().expect("fields") {
            let _ = writeln!(out, "            {},", field_expr(field));
        }
        let _ = writeln!(
            out,
            "        ],\n        trash: {},\n        container: {},\n    }},",
            kind["trash"], kind["container"]
        );
    }
    out.push_str("];\n\n");

    // ---- verbs ----------------------------------------------------------------------------
    let vocabulary = verbs["verbs"].as_array().expect("verbs");
    let live_verbs: Vec<&Value> = vocabulary
        .iter()
        .filter(|verb| verb["live"].as_bool().unwrap_or(false))
        .collect();
    let live_verb_names: Vec<&str> = live_verbs.iter().map(|verb| text(verb, "name")).collect();

    out.push_str("/// What an `act` can do: the `live` verbs of `contracts/assist/verbs.json`.\n");
    out.push_str(
        "#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]\n",
    );
    out.push_str("#[serde(rename_all = \"snake_case\")]\npub enum Verb {\n");
    for name in &live_verb_names {
        let _ = writeln!(out, "    {},", camel(name));
    }
    out.push_str("}\n\n");

    // every direct action, once per verb it serves
    let mut rows: Vec<Row> = Vec::new();
    for (app, manifest) in &manifests {
        for action in manifest["actions"].as_array().expect("actions") {
            if text(action, "chat") != "direct" {
                continue;
            }
            let verbs_served = std::iter::once(text(action, "verb")).chain(
                action["also"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                    .iter()
                    .map(|verb| verb.as_str().expect("also verb")),
            );
            for verb in verbs_served {
                rows.push(Row {
                    app: app.clone(),
                    action: text_of(action, "name"),
                    verb: verb.to_owned(),
                    kind: text_of(action, "kind"),
                    command: text_of(action, "command"),
                });
            }
        }
    }
    let kind_order = |id: &str| {
        kinds
            .iter()
            .position(|(_, kind)| text(kind, "id") == id)
            .unwrap_or(usize::MAX)
    };
    let mut commands: BTreeMap<&str, Vec<(usize, &str, String)>> = BTreeMap::new();
    let mut declared_verbs = Vec::new();
    for row in &rows {
        let reason = if !live_verb_names.contains(&row.verb.as_str()) {
            Some("the assistant's runtime does not run this verb yet")
        } else if !writable.contains(&row.kind.as_str()) {
            Some("the assistant's runtime does not write this kind yet")
        } else {
            None
        };
        match reason {
            None => {
                let entry = commands.entry(row.verb.as_str()).or_default();
                assert!(
                    entry.iter().all(|(_, kind, _)| *kind != row.kind),
                    "catalog: `{} {}` is backed twice (second: {}/{})",
                    row.verb,
                    row.kind,
                    row.app,
                    row.action
                );
                entry.push((
                    kind_order(&row.kind),
                    row.kind.as_str(),
                    row.command.clone(),
                ));
            }
            Some(reason) => declared_verbs.push((row, reason)),
        }
    }
    for unbacked in verbs["unbacked"].as_array().expect("unbacked") {
        let (verb, kind) = (text(unbacked, "verb"), text(unbacked, "kind"));
        assert!(
            live_verb_names.contains(&verb) && writable.contains(&kind),
            "catalog: the unbacked row `{verb} {kind}` names a verb or kind the runtime does not run"
        );
        let entry = commands.entry(verb).or_default();
        assert!(
            entry.iter().all(|(_, existing, _)| *existing != kind),
            "catalog: `{verb} {kind}` is now backed by an app action; delete its `unbacked` row in contracts/assist/verbs.json"
        );
        entry.push((kind_order(kind), kind, text_of(unbacked, "command")));
    }

    out.push_str("pub static VERBS: &[VerbSpec] = &[\n");
    for verb in &live_verbs {
        let name = text(verb, "name");
        let mut rows = commands.remove(name).unwrap_or_default();
        // The order a verb's kinds are named in is part of what the model reads (an error says
        // `reschedule applies to: task, event`), so a verb may pin it with `kindOrder`; the rest
        // follow in kind order.
        let pinned: Vec<&str> = verb["kindOrder"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        rows.sort_by_key(|(order, kind, _)| {
            (
                pinned
                    .iter()
                    .position(|pin| pin == kind)
                    .unwrap_or(usize::MAX),
                *order,
            )
        });
        let _ = writeln!(out, "    VerbSpec {{");
        let _ = writeln!(out, "        verb: Verb::{},", camel(name));
        let _ = writeln!(out, "        name: {name:?},");
        let _ = writeln!(out, "        args: {:?},", text(verb, "args"));
        let _ = writeln!(out, "        done: {:?},", text(verb, "done"));
        out.push_str("        commands: &[\n");
        for (_, kind, command) in rows {
            let _ = writeln!(out, "            (Kind::{}, {command:?}),", camel(kind));
        }
        out.push_str("        ],\n    },\n");
    }
    out.push_str("];\n\n");

    out.push_str("pub static DECLARED_VERBS: &[DeclaredVerb] = &[\n");
    for (row, reason) in declared_verbs {
        let _ = writeln!(
            out,
            "    DeclaredVerb {{ app: {:?}, action: {:?}, verb: {:?}, kind: {:?}, command: {:?}, reason: {:?} }},",
            row.app, row.action, row.verb, row.kind, row.command, reason
        );
    }
    out.push_str("];\n");

    let target = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("catalog.rs");
    std::fs::write(target, out).expect("write catalog.rs");
}
