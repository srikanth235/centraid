//! `nativetools export <dir>`: everything the Python side and the generator
//! read, generated from the metadata table.

use std::path::Path;

use serde_json::{Value, json};

use crate::dates::{EXAMPLES, Unit};
use crate::meta::{self, KINDS, Kind, VERBS};
use crate::phrases::PHRASES;
use crate::prompt;
use crate::render;
use crate::whr;

/// The strict JSON schema of a date expression.
#[must_use]
pub fn date_expr_schema() -> Value {
    let relative = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["unit", "rel"],
        "properties": {
            "unit": {"type": "string", "enum": Unit::NAMES},
            "rel": {"type": "integer"},
            "name": {"type": "integer", "minimum": 1, "maximum": 12},
            "weekday": {"type": "integer", "minimum": 1, "maximum": 7},
            "time": {"type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$"},
            "anchor": {"type": "string", "enum": ["today", "row"]}
        }
    });
    let absolute = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["date"],
        "properties": {
            "date": {"type": "string", "pattern": "^[0-9]{4}-[01][0-9]-[0-3][0-9]$"},
            "time": {"type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$"}
        }
    });
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "date expression (SPEC §4.4)",
        "description": "name only with unit month; weekday only with unit week; time only with unit day, a week with a weekday, or a date; anchor row only inside act",
        "definitions": {"relative": relative, "absolute": absolute},
        "anyOf": [
            {"$ref": "#/definitions/relative"},
            {"$ref": "#/definitions/absolute"},
            {
                "type": "object",
                "additionalProperties": false,
                "minProperties": 1,
                "properties": {
                    "from": {"anyOf": [{"$ref": "#/definitions/relative"}, {"$ref": "#/definitions/absolute"}]},
                    "to": {"anyOf": [{"$ref": "#/definitions/relative"}, {"$ref": "#/definitions/absolute"}]}
                }
            }
        ]
    })
}

/// The date grammar in Lark, embedding the JSON schema through llguidance's
/// `%json` directive.
#[must_use]
pub fn date_expr_lark() -> String {
    format!(
        "// A date expression (SPEC §4.4), for llguidance. The JSON schema carries\n\
         // the key rules; the co-occurrence rules (name with month, weekday with\n\
         // week, time with day/weekday/date) are the runtime's and its error\n\
         // quotes the examples.\n\
         start: date_expr\n\
         date_expr: %json {}\n",
        serde_json::to_string(&date_expr_schema()).unwrap_or_default()
    )
}

/// One Lark grammar for a whole native call: exactly one known tool, its own
/// parameter names, enums for kind/op/verb/reason, the where grammar and the
/// date grammar. `#n`/`@n` reach is the harness's to narrow per session.
#[must_use]
pub fn call_lark() -> String {
    let kinds: Vec<String> = Kind::ALL
        .iter()
        .map(|kind| format!("\"{}\"", kind.name()))
        .collect();
    let verbs: Vec<String> = VERBS
        .iter()
        .map(|verb| format!("\"{}\"", verb.name))
        .collect();
    let ops: Vec<String> = meta::OPS.iter().map(|op| format!("\"{op}\"")).collect();
    let reasons: Vec<String> = meta::DECLINE_REASONS
        .iter()
        .map(|r| format!("\"{r}\""))
        .collect();
    let wheres: Vec<String> = Kind::ALL
        .iter()
        .map(|kind| format!("where_{}", kind.name().replace(' ', "_")))
        .collect();
    let param = |name: &str, value: &str| {
        format!("\"<parameter={name}>\\n\" {value} \"\\n</parameter>\\n\"")
    };
    let selector = [
        ("kind", "kinds"),
        ("name", "TEXT"),
        ("where", "where_any"),
        ("when", "date_expr"),
        ("linked_to", "handles"),
        ("within", "RESULT"),
        ("exclude", "handles"),
        ("order", "ORDER"),
        ("limit", "INT"),
        ("trashed", "BOOL"),
    ];
    let mut out = String::from(
        "// One native Qwen3.5 tool call, generated from the metadata table.\n\
         // Self-contained: the where grammar and the date grammar follow.\n\
         start: \"<tool_call>\\n\" call \"</tool_call>\"\n\
         call: search | find | open | compute | act | answer | ask | decline\n",
    );
    let tool = |name: &str, params: &[String]| {
        format!(
            "{name}: \"<function={name}>\\n\" ({name}_param)* \"</function>\\n\"\n{name}_param: {}\n",
            params.join("\n    | ")
        )
    };
    let sel: Vec<String> = selector
        .iter()
        .map(|(name, value)| param(name, value))
        .collect();
    out.push_str(&tool(
        "search",
        &[param("text", "TEXT"), param("kind", "search_kinds")],
    ));
    out.push_str(&tool("find", &sel));
    out.push_str(&tool("open", &[param("row", "ROW")]));
    let mut compute = vec![
        param("op", "op"),
        param("field", "FIELD"),
        param("group", "FIELD"),
        param("rows", "handles"),
    ];
    compute.extend(sel.clone());
    out.push_str(&tool("compute", &compute));
    let mut act = vec![
        param("verb", "verb"),
        param("rows", "handles"),
        param("args", "ARGS"),
        param("more", "BOOL"),
    ];
    act.extend(sel.clone());
    out.push_str(&tool("act", &act));
    let mut answer = vec![
        param("rows", "handles"),
        param("op", "op"),
        param("field", "FIELD"),
        param("value", "RESULT"),
    ];
    answer.extend(sel);
    out.push_str(&tool("answer", &answer));
    out.push_str(&tool(
        "ask",
        &[param("question", "TEXT"), param("options", "handles")],
    ));
    out.push_str(&tool("decline", &[param("reason", "reason")]));
    out.push_str(&format!(
        "kind: {}\n\
         kinds: kind (\",\" kind)*\n\
         search_kinds: \"any\" | kinds\n\
         verb: {}\n\
         op: {}\n\
         reason: {}\n\
         where_any: {}\n\
         handles: HANDLE (\", \" HANDLE)*\n\
         HANDLE: /[#@][1-9][0-9]*/\n\
         ROW: /#[1-9][0-9]*/\n\
         RESULT: /@[1-9][0-9]*/\n\
         ORDER: /[a-z_]+ (asc|desc)/\n\
         FIELD: /[a-z_]+/\n\
         BOOL: \"true\" | \"false\"\n\
         TEXT: /[^<\\n][^<]*/\n\
         ARGS: /[^<]+/\n\
\n",
        kinds.join(" | "),
        verbs.join(" | "),
        ops.join(" | "),
        reasons.join(" | "),
        wheres.join(" | ")
    ));
    // Self-contained: the where rules and the date rule ride along, so one
    // file is one grammar.
    out.push('\n');
    out.push_str(&whr::lark());
    out.push_str(&format!(
        "\ndate_expr: %json {}\n",
        serde_json::to_string(&date_expr_schema()).unwrap_or_default()
    ));
    out
}

/// The phrase table with each expression as JSON, for the generator.
#[must_use]
pub fn phrases() -> Value {
    Value::Array(
        PHRASES
            .iter()
            .map(|phrase| {
                json!({
                    "phrase": phrase.phrase,
                    "today": phrase.today,
                    "row": phrase.row,
                    "expr": serde_json::from_str::<Value>(phrase.expr).unwrap_or(Value::Null),
                    "echo": phrase.echo,
                    "rule": phrase.rule,
                })
            })
            .collect(),
    )
}

/// The metadata table as JSON.
#[must_use]
pub fn metadata() -> Value {
    let kinds: Vec<Value> = KINDS
        .iter()
        .map(|spec| {
            let verbs: Vec<&str> = spec.verbs().iter().map(|verb| verb.spec().name).collect();
            let mut value = serde_json::to_value(spec).unwrap_or_default();
            value["verbs"] = json!(verbs);
            value["card"] = json!(render::card_line(spec.kind, "USD"));
            value["where_fields"] = json!(spec.where_fields());
            value
        })
        .collect();
    json!({
        "constants": {
            "ROW_CAP": meta::ROW_CAP,
            "STEP_CAP": meta::STEP_CAP,
            "DIRECTORY_CAP": meta::DIRECTORY_CAP,
            "PREGROUND_CAP": meta::PREGROUND_CAP,
            "OPEN_LINK_CAP": meta::OPEN_LINK_CAP,
        },
        "tools": meta::TOOLS,
        "selector_params": meta::SELECTOR_PARAMS,
        "multi_kind_params": meta::MULTI_KIND_PARAMS,
        "ops": meta::OPS,
        "decline_reasons": meta::DECLINE_REASONS,
        "log_kinds": meta::LOG_KINDS,
        "reveal_fields": meta::REVEAL_FIELDS.iter().map(|(name, column)| json!({"name": name, "column": column})).collect::<Vec<_>>(),
        "kinds": kinds,
        "verbs": VERBS,
        "date_units": Unit::NAMES,
        "date_examples": EXAMPLES.iter().map(|(expr, gloss)| json!({"expr": expr, "reads": gloss})).collect::<Vec<_>>(),
        "mapped_columns": meta::mapped_columns().iter().map(|(t, c)| format!("{t}.{c}")).collect::<Vec<_>>(),
        "mapped_commands": meta::mapped_commands(),
    })
}

fn write(dir: &Path, name: &str, body: &str) -> Result<(), String> {
    std::fs::write(dir.join(name), body).map_err(|error| format!("writing {name}: {error}"))
}

fn pretty(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_default();
    text.push('\n');
    text
}

/// The fixture world every rendered prompt is shown over.
const FIXTURE: &str = include_str!("../tests/fixtures/world.json");
/// The fixture's "today", a Sunday.
const FIXTURE_TODAY: &str = "2026-09-27";

/// The rendered system turn for the fixture world, once per tools mode:
/// `prompt.<mode>.txt`. The world is seeded into a scratch directory under
/// `dir` that is removed afterwards.
fn rendered_prompts(dir: &Path) -> Result<(), String> {
    let scratch = dir.join(".fixture-vault");
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|error| error.to_string())?;
    let result = (|| {
        let world: Value = serde_json::from_str(FIXTURE).map_err(|error| error.to_string())?;
        let path = scratch.join("vault.db");
        crate::seed::seed(&world, &path)?;
        let now = crate::dates::parse_now(FIXTURE_TODAY)?;
        for mode in prompt::ToolsMode::ALL {
            let flags = crate::Flags {
                tools: mode,
                ..crate::Flags::default()
            };
            let mut session = crate::Session::open(&path, now, "", flags)?;
            let prompt = prompt::prompt(&mut session);
            write(
                dir,
                &format!("prompt.{}.txt", mode.name()),
                prompt["rendered"].as_str().unwrap_or_default(),
            )?;
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

/// Write every export file; returns their names.
pub fn export(dir: &Path) -> Result<Vec<&'static str>, String> {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    write(dir, "tools.json", &pretty(&Value::Array(prompt::tools())))?;
    write(
        dir,
        "tools.full.json",
        &pretty(&Value::Array(prompt::tools_full())),
    )?;
    write(
        dir,
        "kind_card.txt",
        &(prompt::kind_card("USD").join("\n") + "\n"),
    )?;
    write(dir, "where.lark", &whr::lark())?;
    write(dir, "date_expr.schema.json", &pretty(&date_expr_schema()))?;
    write(dir, "date_expr.lark", &date_expr_lark())?;
    write(dir, "call.lark", &call_lark())?;
    write(dir, "phrases.json", &pretty(&phrases()))?;
    write(dir, "metadata.json", &pretty(&metadata()))?;
    rendered_prompts(dir)?;
    Ok(vec![
        "tools.json",
        "tools.full.json",
        "kind_card.txt",
        "where.lark",
        "date_expr.schema.json",
        "date_expr.lark",
        "call.lark",
        "phrases.json",
        "metadata.json",
        "prompt.sig.txt",
        "prompt.compact.txt",
        "prompt.full.txt",
    ])
}
