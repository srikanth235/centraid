//! THE CHAT CATALOG, generated from the app manifests.
//!
//! The assistant's kind and verb tables used to be 1,200 lines of hand-written
//! rows that drifted from the apps. They are now derived here, at build time,
//! from the one catalog there is (#1135): each `crates/apps/<app>/manifest.json`
//! declares the model-facing `kinds` the app owns and classifies every action
//! (`verb`, `kind`, `also`, `inverse`, `sealed`, `bulk`, `command`, and the
//! `aliases` its input properties are said under), and `contracts/assist/verbs.json`
//! is the verb vocabulary (its argument line, its past tense) plus the few `unbacked`
//! rows no app action backs yet. Whether chat runs an action itself is not written
//! anywhere: the kit derives it (`ActionEntry::surface`) and this reads it.
//!
//! What this writes to `$OUT_DIR/catalog.rs` (included by `native/meta.rs`):
//!
//! * `Kind` and `Kind::ALL`: the kinds whose `live` is `write` or `read`, in
//!   their `order`. A kind that is `declared` has no variant, so no runtime
//!   code can reach it by accident; the app lane that makes it live flips the
//!   manifest and gets a compile error at every `match` that must learn it.
//! * `Verb`: A VERB IS LIVE WHEN AN ACTION BACKS IT: a direct action of a writable
//!   kind serves it, or an `unbacked` row does, or the runtime owns it (`builtin`:
//!   `undo`). Nothing is flagged live by hand.
//! * `ACTIONS`: ONE LOOKUP, `(verb, kind, qualifier)` to the manifest action chat
//!   runs: its app, its name, its command, the property that names the row, the
//!   names its input properties are said under. A direct action is one row per verb
//!   it serves (`verb` and each `also`).
//! * `KINDS` and `VERBS`: the rows of the live kinds and verbs. A verb row lists
//!   the kinds an unqualified action serves it on.
//! * `DECLARED_KINDS` and `DECLARED_VERBS`: everything the catalog declares
//!   that the runtime does not run yet, so the export shows the whole catalog
//!   and a lane can see exactly what it has left to wire.
//!
//! A catalog that contradicts itself fails the build with the sentence that
//! names the manifest: an `unbacked` row an action now backs (delete the row),
//! two direct actions that are one (verb, kind, qualifier), a link to a kind that
//! is not live.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use centraid_apps_kit::manifest::{ActionEntry, ChatSurface, Manifest, parse_manifest};
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

/// `field(…).unit(…).values(…)` for one declared field.
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

/// One direct action as one verb it serves.
struct Row<'a> {
    app: String,
    verb: String,
    action: &'a ActionEntry,
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let verbs_path = root.join("contracts/assist/verbs.json");
    println!("cargo:rerun-if-changed={}", verbs_path.display());
    let verbs: Value =
        serde_json::from_str(&std::fs::read_to_string(&verbs_path).expect("verbs.json"))
            .expect("verbs.json is JSON");
    let manifests = manifests(&root);
    // The typed read, the one the core and the apps use: what chat does with an action is
    // derived there (`ActionEntry::surface`), so it is read here and not restated.
    let parsed: Vec<(String, Manifest)> = manifests
        .iter()
        .map(|(app, raw)| {
            let manifest = parse_manifest(&raw.to_string())
                .unwrap_or_else(|error| panic!("{app}'s manifest does not parse: {error}"));
            (app.clone(), manifest)
        })
        .collect();

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
    let unbacked_rows = verbs["unbacked"].as_array().expect("unbacked");

    // every direct action, once per verb it serves
    let mut rows: Vec<Row> = Vec::new();
    for (app, manifest) in &parsed {
        for action in &manifest.actions {
            if action.surface() != ChatSurface::Direct {
                continue;
            }
            for verb in std::iter::once(&action.verb).chain(&action.also) {
                rows.push(Row {
                    app: app.clone(),
                    verb: verb.clone(),
                    action,
                });
            }
        }
    }

    // A VERB IS LIVE WHEN AN ACTION BACKS IT (a direct action of a writable kind, or an unbacked
    // row), or when the runtime owns it (`builtin`).
    let backs = |name: &str| {
        rows.iter()
            .any(|row| row.verb == name && writable.contains(&row.action.kind.as_str()))
            || unbacked_rows
                .iter()
                .any(|row| text(row, "verb") == name && writable.contains(&text(row, "kind")))
    };
    let live_verbs: Vec<&Value> = vocabulary
        .iter()
        .filter(|verb| verb["builtin"].as_bool().unwrap_or(false) || backs(text(verb, "name")))
        .collect();
    let live_verb_names: Vec<&str> = live_verbs.iter().map(|verb| text(verb, "name")).collect();

    out.push_str(
        "/// What an `act` can do: the verbs of `contracts/assist/verbs.json` some action backs.\n",
    );
    out.push_str(
        "#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]\n",
    );
    out.push_str("#[serde(rename_all = \"snake_case\")]\npub enum Verb {\n");
    for name in &live_verb_names {
        let _ = writeln!(out, "    {},", camel(name));
    }
    out.push_str("}\n\n");

    let kind_order = |id: &str| {
        kinds
            .iter()
            .position(|(_, kind)| text(kind, "id") == id)
            .unwrap_or(usize::MAX)
    };
    let mut commands: BTreeMap<&str, Vec<(usize, &str, String)>> = BTreeMap::new();
    let mut declared_verbs = Vec::new();
    let mut runnable: Vec<&Row> = Vec::new();
    let mut seen: Vec<(&str, &str, Option<&str>)> = Vec::new();
    for row in &rows {
        let reason = if !live_verb_names.contains(&row.verb.as_str()) {
            Some("the assistant's runtime does not run this verb yet")
        } else if !writable.contains(&row.action.kind.as_str()) {
            Some("the assistant's runtime does not write this kind yet")
        } else {
            None
        };
        match reason {
            None => {
                let key = (
                    row.verb.as_str(),
                    row.action.kind.as_str(),
                    row.action.qualifier.as_deref(),
                );
                assert!(
                    !seen.contains(&key),
                    "catalog: `{} {}{}` is backed twice (second: {}/{})",
                    row.verb,
                    row.action.kind,
                    row.action
                        .qualifier
                        .as_ref()
                        .map(|q| format!(":{q}"))
                        .unwrap_or_default(),
                    row.app,
                    row.action.name
                );
                seen.push(key);
                runnable.push(row);
                if row.action.qualifier.is_none() {
                    commands.entry(row.verb.as_str()).or_default().push((
                        kind_order(&row.action.kind),
                        row.action.kind.as_str(),
                        row.action.command.clone(),
                    ));
                }
            }
            Some(reason) => declared_verbs.push((row, reason)),
        }
    }
    for unbacked in unbacked_rows {
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

    // ---- the one lookup: (verb, kind, qualifier) -> action ---------------------------------
    out.push_str("/// THE ONE LOOKUP: `(verb, kind, qualifier)` to the manifest action chat runs. A direct action\n/// is a row per verb it serves; an `unbacked` row has no action (`action` is empty) and runs\n/// as its bare command until an app declares one.\n");
    out.push_str("pub static ACTIONS: &[ActionSpec] = &[\n");
    let list = |names: Vec<String>| {
        format!(
            "&[{}]",
            names
                .iter()
                .map(|name| format!("{name:?}"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    for row in &runnable {
        let action = row.action;
        let properties: Vec<String> = action
            .input
            .get("properties")
            .and_then(Value::as_object)
            .map(|properties| properties.keys().cloned().collect())
            .unwrap_or_default();
        let required: Vec<String> = action
            .input
            .get("required")
            .and_then(Value::as_array)
            .map(|names| {
                names
                    .iter()
                    .filter_map(|name| name.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let aliases: Vec<String> = properties
            .iter()
            .filter(|property| !action.aliases_of(property).is_empty())
            .map(|property| {
                format!(
                    "({property:?}, {})",
                    list(
                        action
                            .aliases_of(property)
                            .into_iter()
                            .map(str::to_owned)
                            .collect()
                    )
                )
            })
            .collect();
        let consts: Vec<String> = properties
            .iter()
            .filter_map(|property| {
                action
                    .constant_of(property)
                    .map(|value| format!("({property:?}, {:?})", value.to_string()))
            })
            .collect();
        let defaults: Vec<String> = properties
            .iter()
            .filter_map(|property| {
                action
                    .default_of(property)
                    .map(|value| format!("({property:?}, {:?})", value.to_string()))
            })
            .collect();
        // the action that takes it back: the manifest's `inverse`, with the command it runs and the
        // property that names the row for it
        let inverse = action
            .inverse
            .as_ref()
            .and_then(|name| {
                parsed
                    .iter()
                    .find(|(app, _)| *app == row.app)
                    .and_then(|(_, manifest)| manifest.action(name))
            })
            .map_or("None".to_owned(), |back| {
                format!(
                    "Some(InverseSpec {{ app: {:?}, action: {:?}, command: {:?}, id_param: {:?} }})",
                    row.app,
                    back.name,
                    back.command,
                    back.id_property().unwrap_or("id")
                )
            });
        let _ = writeln!(
            out,
            "    ActionSpec {{ app: {:?}, action: {:?}, command: {:?}, verb: Verb::{}, qualifier: {}, kind: Kind::{}, id_param: {:?}, inverse: {inverse}, properties: {}, required: {}, aliases: &[{}], consts: &[{}], defaults: &[{}], minted: {} }},",
            row.app,
            action.name,
            action.command,
            camel(&row.verb),
            action
                .qualifier
                .as_ref()
                .map_or("None".to_owned(), |q| format!("Some({q:?})")),
            camel(&action.kind),
            action.id_property().unwrap_or("id"),
            list(properties.clone()),
            list(required),
            aliases.join(", "),
            consts.join(", "),
            defaults.join(", "),
            list(action.minted.clone()),
        );
    }
    for unbacked in unbacked_rows {
        let command = text(unbacked, "command");
        let id_param = if command.starts_with("locker.") {
            "item_id"
        } else {
            "id"
        };
        let inverse = unbacked["inverse"].as_str().map_or("None".to_owned(), |back| {
            format!(
                "Some(InverseSpec {{ app: {:?}, action: \"\", command: {back:?}, id_param: \"id\" }})",
                text(unbacked, "app")
            )
        });
        let _ = writeln!(
            out,
            "    ActionSpec {{ app: {:?}, action: \"\", command: {command:?}, verb: Verb::{}, qualifier: None, kind: Kind::{}, id_param: {id_param:?}, inverse: {inverse}, properties: &[], required: &[], aliases: &[], consts: &[], defaults: &[], minted: &[] }},",
            text(unbacked, "app"),
            camel(text(unbacked, "verb")),
            camel(text(unbacked, "kind")),
        );
    }
    out.push_str("];\n\n");

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
        let _ = writeln!(
            out,
            "        flag: {},",
            verb["flag"]
                .as_str()
                .map_or("None".to_owned(), |flag| format!("Some({flag:?})"))
        );
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
            row.app, row.action.name, row.verb, row.action.kind, row.action.command, reason
        );
    }
    out.push_str("];\n");

    let target = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("catalog.rs");
    std::fs::write(target, out).expect("write catalog.rs");
}
