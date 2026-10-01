//! The metadata table against the real vault: every mapped column exists in
//! a freshly founded vault's schema, every mapped command is registered, and
//! the lists the vault states itself are the vault's (SPEC §1.7).

use centraid_nativetools::meta::{self, KINDS, Kind, VERBS};
use centraid_nativetools::{prompt, vaultio};

/// The ontology's rendered DDL, for the CHECK constraints an enum must meet.
const DDL: &str = include_str!("../../../contracts/schema/vault-ddl.sql");

fn create_sql(table: &str) -> String {
    // The table's block in the rendered DDL: from its name to its closing
    // parenthesis.
    let head = format!(" {table} (\n");
    let start = DDL
        .find(&head)
        .unwrap_or_else(|| panic!("the DDL has no {table}"));
    let rest = &DDL[start..];
    rest[..rest.find("\n);").unwrap_or(rest.len())].to_owned()
}

#[test]
fn every_mapped_column_exists_in_a_founded_vault() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vault.db");
    let handle = vaultio::Handle::create(&path, vaultio::SetClock::at(0), "meta", "Me").unwrap();
    for (table, column) in meta::mapped_columns() {
        let columns = handle
            .vault
            .read(|connection| centraid_vault::log::identifiers::table_columns(connection, table))
            .unwrap_or_else(|error| panic!("the vault has no table {table}: {error}"));
        assert!(
            columns.iter().any(|name| name == column),
            "{table} has no column {column}: {columns:?}"
        );
    }
}

#[test]
fn every_enum_vault_value_is_one_the_tables_check_accepts() {
    for spec in KINDS {
        for field in spec.fields.iter().filter(|field| !field.values.is_empty()) {
            if matches!(field.name, "direction" | "status") && spec.kind == Kind::Debt {
                continue; // derived from from_party / settled_at, not a CHECK
            }
            let sql = create_sql(field.source.table);
            for (_, vault) in field.values {
                assert!(
                    sql.contains(&format!("'{vault}'")),
                    "{}.{} lacks '{vault}'",
                    field.source.table,
                    field.source.column
                );
            }
        }
    }
}

#[test]
fn every_mapped_command_is_registered() {
    let registry = centraid_vault::Registry::with_system_commands().unwrap();
    for command in meta::mapped_commands() {
        assert!(
            registry.get(command).is_some(),
            "{command} is not a registered command"
        );
    }
    for field in KINDS.iter().flat_map(|spec| spec.fields) {
        if let Some(command) = field.edit {
            assert!(registry.get(command).is_some(), "{command}");
        }
    }
}

#[test]
fn the_lists_the_vault_states_are_the_vaults() {
    let types: Vec<&str> = Kind::LockerItem
        .spec()
        .field("type")
        .unwrap()
        .values
        .iter()
        .map(|(_, vault)| *vault)
        .collect();
    assert_eq!(types, centraid_vault::commands::locker::ITEM_TYPES.to_vec());
    let sealed = centraid_ontology::registries::sealed_physical_columns();
    for (_, column) in meta::REVEAL_FIELDS {
        assert!(
            sealed.contains(&("locker_item".to_owned(), (*column).to_owned())),
            "locker_item.{column} is not a sealed column"
        );
    }
}

#[test]
fn the_constants_and_the_card_come_from_the_table() {
    assert_eq!(meta::ROW_CAP, 12);
    assert_eq!(meta::STEP_CAP, 6);
    assert_eq!(meta::DIRECTORY_CAP, 8);
    let card = prompt::kind_card("USD");
    assert_eq!(card.len(), Kind::ALL.len());
    assert!(card.iter().any(|line| line.starts_with(
        "task: name, date (due), status (open|in_progress|completed|cancelled), effort (min), priority (1 highest..9 lowest, 0 none)"
    )));
    // §14: member is folded into person; the model-facing names are these.
    let names: Vec<&str> = Kind::ALL.iter().map(|kind| kind.name()).collect();
    for name in [
        "person",
        "group",
        "event",
        "task",
        "note",
        "document",
        "photo",
        "album",
        "debt",
        "locker item",
    ] {
        assert!(names.contains(&name), "{name}");
    }
    assert!(Kind::parse("member").is_none());
    // Every verb but undo applies to a kind, and every kind's verbs are real.
    for verb in VERBS {
        assert!(
            verb.name == "undo" || !verb.commands.is_empty(),
            "{}",
            verb.name
        );
    }
    for kind in Kind::ALL {
        for link in kind.spec().links {
            assert!(
                link.kind.spec().link_to(kind).is_some(),
                "{} links {} but not back",
                kind.name(),
                link.kind.name()
            );
        }
    }
    let balances: Vec<Kind> = Kind::ALL
        .into_iter()
        .filter(|kind| kind.spec().balance.is_some())
        .collect();
    assert_eq!(balances, vec![Kind::Person, Kind::Group]);
}

#[test]
fn the_tools_are_the_eight_in_qwen_function_form() {
    let tools = prompt::tools();
    let names: Vec<&str> = tools
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, meta::TOOLS);
    for tool in &tools {
        assert_eq!(tool["type"], "function");
        assert_eq!(tool["function"]["parameters"]["type"], "object");
    }
    let rendered = prompt::tools_block(&tools);
    assert!(rendered.starts_with(
        "# Tools\n\nYou have access to the following functions:\n\n<tools>\n{\"function\": {"
    ));
    assert!(rendered.contains("</tools>\n\nIf you choose to call a function ONLY reply"));
}

#[test]
fn the_prompt_describes_the_selector_once_and_the_full_schemas_match_its_interface() {
    let compact = prompt::tools();
    let full = prompt::tools_full();
    let props = |tool: &serde_json::Value| tool["function"]["parameters"]["properties"].clone();
    for (short, long) in compact.iter().zip(&full) {
        let name = short["function"]["name"].as_str().unwrap();
        let (a, b) = (props(short), props(long));
        let keys = |value: &serde_json::Value| {
            value
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(keys(&a), keys(&b), "{name}: the interface differs");
        assert_eq!(
            short["function"]["parameters"]["required"], long["function"]["parameters"]["required"],
            "{name}"
        );
        for (param, schema) in a.as_object().unwrap() {
            assert_eq!(schema["type"], b[param]["type"], "{name}.{param}");
            assert_eq!(schema["enum"], b[param]["enum"], "{name}.{param}");
        }
        if ["compute", "act", "answer"].contains(&name) {
            assert!(
                short["function"]["description"]
                    .as_str()
                    .unwrap()
                    .ends_with("selector params as in find."),
                "{name}"
            );
            assert_eq!(a["where"], serde_json::json!({"type": "string"}), "{name}");
            assert_eq!(
                a["when"],
                serde_json::json!({"type": "object", "description": "date expression, as in find"}),
                "{name}"
            );
            assert_eq!(b["when"], props(&full[1])["when"], "{name}");
        }
    }
    let find = props(&compact[1]);
    assert!(find["where"]["description"].is_string());
    assert!(find["when"]["properties"]["unit"]["enum"].is_array());
}

#[test]
fn a_signature_names_every_parameter_its_schema_has() {
    let compact = prompt::tools();
    let sig = prompt::tools_sig();
    assert_eq!(
        centraid_nativetools::Flags::default().tools,
        prompt::ToolsMode::Sig,
        "sig is the default"
    );
    for (schema, short) in compact.iter().zip(&sig) {
        let name = schema["function"]["name"].as_str().unwrap();
        assert_eq!(short["function"]["name"], name);
        assert_eq!(
            short["function"]["parameters"],
            serde_json::json!({"type": "object", "properties": {}}),
            "{name}"
        );
        let line = short["function"]["description"].as_str().unwrap();
        let head = line.split(" — ").next().unwrap();
        let (tool, params) = head.split_once('(').unwrap();
        assert_eq!(tool, name);
        let params = params.trim_end_matches(')');
        let properties = schema["function"]["parameters"]["properties"]
            .as_object()
            .unwrap();
        let required = schema["function"]["parameters"]["required"]
            .as_array()
            .unwrap();
        let mut named = Vec::new();
        for part in params.split(", ") {
            if part == "rows? | selector" {
                named.push("rows".to_owned());
                named.extend(prompt::SELECTOR.iter().map(|field| (*field).to_owned()));
                continue;
            }
            let (param, list) = part.split_once(": ").unwrap_or((part, ""));
            let bare = param.trim_end_matches('?');
            assert_eq!(
                param.ends_with('?'),
                !required.iter().any(|value| value == bare),
                "{name}.{bare}: optionality"
            );
            let schema_list = properties[bare]["enum"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|item| item.as_str().unwrap())
                        .collect::<Vec<_>>()
                        .join("|")
                })
                .unwrap_or_default();
            assert_eq!(list, schema_list, "{name}.{bare}: enum");
            named.push(bare.to_owned());
        }
        let mut named_sorted = named.clone();
        named_sorted.sort();
        named_sorted.dedup();
        assert_eq!(named_sorted.len(), named.len(), "{name}: a param twice");
        let keys: Vec<String> = properties.keys().cloned().collect();
        assert_eq!(
            named_sorted, keys,
            "{name}: the signature and the schema differ"
        );
    }
    let find = sig[1]["function"]["description"].as_str().unwrap();
    assert!(
        find.contains("when: {unit: minute|hour|day|week|month|year, rel,"),
        "{find}"
    );
}

#[test]
fn the_locker_column_table_is_the_vaults() {
    use centraid_nativetools::world::{Val, World};
    let dir = tempfile::tempdir().unwrap();
    let handle = vaultio::Handle::create(
        &dir.path().join("vault.db"),
        vaultio::SetClock::at(1_767_600_000_000),
        "locker-table",
        "Me",
    )
    .unwrap();
    for (index, item_type) in centraid_vault::commands::locker::ITEM_TYPES
        .iter()
        .enumerate()
    {
        let ran = handle
            .step(
                "locker.add_item",
                serde_json::json!({
                    "item_id": format!("item-{index}"),
                    "type": item_type,
                    "title": item_type,
                    "username": "u",
                    "url": "https://x.example",
                    "notes": "n",
                }),
            )
            .unwrap();
        assert!(ran.ok, "{item_type}: {:?}", ran.reason);
    }
    let world = World::load(&handle).unwrap();
    for (index, item_type) in centraid_vault::commands::locker::ITEM_TYPES
        .iter()
        .enumerate()
    {
        let row = world
            .row(&(Kind::LockerItem, format!("item-{index}")))
            .unwrap();
        for field in ["username", "url", "notes"] {
            let kept = matches!(row.field(field), Some(Val::Text(_)));
            // A note's notes live in its sealed content, which a plain
            // `notes` write does not reach.
            let expected = meta::locker_column(item_type, field) == Some(field);
            assert_eq!(kept, expected, "{item_type}.{field}");
        }
    }
}
