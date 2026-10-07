//! `nativetools export <dir>`: everything the Python side and the generator
//! read, generated from the metadata table and, for `errors.json`, from the runtime's own
//! messages.

use std::path::Path;

use serde_json::{Value, json};

use crate::dates::{EXAMPLES, Unit};
use crate::meta::{self, KINDS, VERBS};
use crate::phrases::PHRASES;
use crate::prompt;
use crate::render;

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

// ---------------------------------------------------------------------------------------------
// THE ERROR TABLE (`errors.json`)
//
// Every message the runtime answers a mistaken call with is a literal in the source that starts
// `error: ` (or `already: `, `ambiguous: `, `refused: `, the replies that refuse or do nothing). The
// table is read out of those sources at export time (`SOURCES` are the files themselves, embedded
// at build), so a new message is a new family without a line anywhere else; the example calls
// (`EXAMPLES_BY_FAMILY`) are the one hand-written part, and a test refuses a family that has
// neither an example nor an entry saying why it has none.
// ---------------------------------------------------------------------------------------------

/// The sources the messages are read from.
const SOURCES: [(&str, &str); 8] = [
    ("act.rs", include_str!("act.rs")),
    ("session.rs", include_str!("session.rs")),
    ("whr.rs", include_str!("whr.rs")),
    ("values.rs", include_str!("values.rs")),
    ("search.rs", include_str!("search.rs")),
    ("trace.rs", include_str!("trace.rs")),
    ("parse.rs", include_str!("parse.rs")),
    ("dates.rs", include_str!("dates.rs")),
];
/// What a message literal starts with.
const MESSAGE_PREFIXES: [&str; 4] = ["error: ", "already: ", "ambiguous: ", "refused: "];

/// One call of an example, run in order on the fixture world.
#[derive(Debug, Clone)]
pub struct ExampleCall {
    /// The user message that opens a new turn; `None` for a call in the turn before it (the
    /// first call of an example always opens one).
    pub user: Option<String>,
    /// A tool, or `call_text`: `args` is then `{"text": <raw model message>}`.
    pub tool: String,
    pub args: Value,
    /// The think block the call is written under (the trace guard reads it).
    pub think: Option<String>,
}

/// An error family: one message template of the runtime.
#[derive(Debug, Clone)]
pub struct ErrorFamily {
    pub id: String,
    /// `schema`, `cardinality`, `applicability`, `vault`, `trace`, `repeat`, `step` or `value`.
    pub family: &'static str,
    pub source: &'static str,
    /// The message with its `{}` / `{name}` placeholders.
    pub template: String,
    /// The tool and the argument that trigger it (`""` when no one argument does).
    pub tool: String,
    pub argument: String,
    /// The calls that end in this message on the fixture world; the last one produces it.
    pub example: Option<Vec<ExampleCall>>,
    /// Why there is no example.
    pub why_none: String,
}

impl ErrorFamily {
    /// Whether `text` holds this family's message: the template's literal parts, in order, with
    /// anything in the places of the placeholders (a cap note or a restated row may follow it).
    #[must_use]
    pub fn matches(&self, text: &str) -> bool {
        let parts = literal_parts(&self.template);
        let mut rest = text;
        for part in &parts {
            if part.is_empty() {
                continue;
            }
            match rest.find(part.as_str()) {
                Some(at) => rest = &rest[at + part.len()..],
                None => return false,
            }
        }
        true
    }
}

/// The literal stretches of a template, split at its placeholders.
fn literal_parts(template: &str) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut depth = 0;
    for ch in template.chars() {
        match ch {
            '{' => {
                depth += 1;
                if depth == 1 {
                    parts.push(String::new());
                }
            }
            '}' if depth > 0 => depth -= 1,
            _ if depth == 0 => parts.last_mut().expect("a part").push(ch),
            _ => {}
        }
    }
    parts
}

/// The messages of one source: every string literal that starts with a message prefix. Test code
/// (from `#[cfg(test)]` on), comments, and the prefix tests of a `starts_with("error: …")` are not
/// messages.
fn scan(source: &str) -> Vec<String> {
    let code = source.split("\n#[cfg(test)]").next().unwrap_or(source);
    let bytes = code.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'/' if bytes.get(at + 1) == Some(&b'/') => {
                at = code[at..].find('\n').map_or(code.len(), |end| at + end);
            }
            b'/' if bytes.get(at + 1) == Some(&b'*') => {
                at = code[at..].find("*/").map_or(code.len(), |end| at + end + 2);
            }
            b'\'' => {
                // a char literal ('"', '\'', '\n') or a lifetime
                at += if bytes.get(at + 1) == Some(&b'\\') {
                    code[at + 2..]
                        .find('\'')
                        .map_or(code.len() - at, |end| end + 3)
                } else if bytes.get(at + 2) == Some(&b'\'') {
                    3
                } else {
                    1
                };
            }
            b'r' if matches!(bytes.get(at + 1), Some(b'"' | b'#'))
                && at
                    .checked_sub(1)
                    .is_none_or(|prev| !bytes[prev].is_ascii_alphanumeric()) =>
            {
                let hashes = code[at + 1..].chars().take_while(|c| *c == '#').count();
                let open = at + 1 + hashes;
                if bytes.get(open) == Some(&b'"') {
                    let close = format!("\"{}", "#".repeat(hashes));
                    at = code[open + 1..]
                        .find(&close)
                        .map_or(code.len(), |end| open + 1 + end + close.len());
                } else {
                    at += 1;
                }
            }
            b'"' => {
                let line_start = code[..at].rfind('\n').map_or(0, |line| line + 1);
                let before = &code[line_start..at];
                let (text, end) = read_literal(code, at + 1);
                at = end;
                let prefix_test = before.ends_with("starts_with(") || before.ends_with("contains(");
                if !prefix_test
                    && MESSAGE_PREFIXES
                        .iter()
                        .any(|prefix| text.starts_with(prefix))
                {
                    out.push(text);
                }
            }
            _ => at += 1,
        }
    }
    out
}

/// A string literal's text from just after its opening quote, and the index after its close.
fn read_literal(code: &str, start: usize) -> (String, usize) {
    let mut text = String::new();
    let mut chars = code[start..].char_indices();
    while let Some((offset, ch)) = chars.next() {
        match ch {
            '"' => return (text, start + offset + 1),
            '\\' => match chars.next() {
                Some((_, 'n')) => text.push('\n'),
                Some((_, 't')) => text.push('\t'),
                Some((_, '\n')) => {
                    // a line continuation swallows the next line's indentation
                    let mut clone = chars.clone();
                    while let Some((_, next)) = clone.next() {
                        if next.is_whitespace() {
                            chars = clone.clone();
                        } else {
                            break;
                        }
                    }
                }
                Some((_, other)) => text.push(other),
                None => break,
            },
            other => text.push(other),
        }
    }
    (text, code.len())
}

/// A short stable name for a template: its first words, a placeholder standing as its name
/// (`{key}` as `key`, `{}` as `x`).
fn slug(template: &str) -> String {
    let body = MESSAGE_PREFIXES
        .iter()
        .find_map(|prefix| template.strip_prefix(prefix))
        .unwrap_or(template);
    let mut text = String::new();
    let mut name = String::new();
    let mut inside = false;
    for ch in body.chars() {
        match ch {
            '{' => {
                inside = true;
                name.clear();
            }
            '}' if inside => {
                inside = false;
                text.push(' ');
                text.push_str(
                    if name.is_empty() || name.chars().all(|c| c.is_ascii_digit()) {
                        "x"
                    } else {
                        &name
                    },
                );
                text.push(' ');
            }
            other if inside => name.push(other),
            other => text.push(other),
        }
    }
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|word| !word.is_empty())
        .take(6)
        .map(str::to_lowercase)
        .collect();
    if words.is_empty() {
        MESSAGE_PREFIXES
            .iter()
            .find(|prefix| template.starts_with(**prefix))
            .map_or("message", |prefix| prefix.trim_end_matches(": "))
            .to_owned()
    } else {
        words.join("_")
    }
}

/// The family a message belongs to, read off its words.
fn classify(source: &str, template: &str) -> &'static str {
    let has = |needles: &[&str]| needles.iter().any(|needle| template.contains(needle));
    if source == "trace.rs" {
        "trace"
    } else if template.starts_with("error: repeated call") {
        "repeat"
    } else if has(&["step cap", "turn has ended"]) {
        "step"
    } else if template.starts_with("refused:")
        || has(&["was refused", "this seat cannot", "past the vault"])
    {
        "vault"
    } else if template.starts_with("already:") {
        "applicability"
    } else if template.starts_with("ambiguous:") {
        "cardinality"
    } else if has(&[
        "does not apply",
        "nothing to undo",
        "is in the trash",
        "no longer exists",
        "was never shown",
        "was never issued",
        "is not a row",
        "is not a result",
        "stands alone",
    ]) {
        "applicability"
    } else if has(&[
        "exactly one",
        "needs one",
        "needs rows",
        "needs a selector",
        "not both",
        "holds none",
        "selection holds",
        "takes no ",
        "needs exactly",
    ]) {
        "cardinality"
    } else if has(&[
        "no kind",
        "no verb",
        "no parameter",
        "no field",
        "have no field",
        "no op",
        "no tool",
        "could not read",
        "takes kind",
        "takes {",
        "kinds:",
        "parameters:",
        "needs the kind",
        "no date",
    ]) {
        "schema"
    } else {
        "value"
    }
}

/// The hand-written part of a family: what triggers it and the calls that produce it, by family
/// id (`error_examples.json`). A family without calls says why in `why_none`.
const EXAMPLES_JSON: &str = include_str!("error_examples.json");

/// The calls of a family's example, from `error_examples.json`.
fn example_calls(entry: &Value) -> Option<Vec<ExampleCall>> {
    let calls = entry.get("calls")?.as_array()?;
    let text = |call: &Value, key: &str| call.get(key).and_then(Value::as_str).map(str::to_owned);
    let out: Vec<ExampleCall> = calls
        .iter()
        .map(|call| ExampleCall {
            user: text(call, "user"),
            tool: text(call, "tool").unwrap_or_default(),
            args: call.get("args").cloned().unwrap_or(Value::Null),
            think: text(call, "think"),
        })
        .collect();
    (!out.is_empty()).then_some(out)
}

/// Every error family of the runtime, in source order.
#[must_use]
pub fn error_families() -> Vec<ErrorFamily> {
    let examples: Value = serde_json::from_str(EXAMPLES_JSON).expect("error_examples.json is JSON");
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<ErrorFamily> = Vec::new();
    for (source, text) in SOURCES {
        for template in scan(text) {
            if seen.contains(&template) {
                continue;
            }
            seen.push(template.clone());
            let stem = source.trim_end_matches(".rs");
            let mut id = format!("{stem}.{}", slug(&template));
            let mut copy = 2;
            while out.iter().any(|family| family.id == id) {
                id = format!("{stem}.{}_{copy}", slug(&template));
                copy += 1;
            }
            let family = classify(source, &template);
            let known = examples.get(&id);
            let field = |key: &str| {
                known
                    .and_then(|entry| entry.get(key))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            };
            out.push(ErrorFamily {
                id,
                family,
                source,
                template,
                tool: field("tool"),
                argument: field("argument"),
                example: known.and_then(example_calls),
                why_none: if known.is_some() {
                    field("why_none")
                } else {
                    "no example written for this family".to_owned()
                },
            });
        }
    }
    out
}

/// `errors.json`: the families with their templates, triggers and one example call each.
#[must_use]
pub fn errors() -> Value {
    let families: Vec<Value> = error_families()
        .into_iter()
        .map(|family| {
            let example = family.example.as_ref().map(|calls| {
                Value::Array(
                    calls
                        .iter()
                        .map(|call| {
                            json!({
                                "user": call.user,
                                "tool": call.tool,
                                "args": call.args,
                                "think": call.think,
                            })
                        })
                        .collect(),
                )
            });
            json!({
                "id": family.id,
                "family": family.family,
                "source": family.source,
                "template": family.template,
                "tool": family.tool,
                "argument": family.argument,
                "example": example,
                "why_no_example": if family.example.is_some() { "" } else { family.why_none.as_str() },
            })
        })
        .collect();
    json!({"fixture": "tests/fixtures/world.json", "today": FIXTURE_TODAY, "families": families})
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
    write(dir, "date_expr.schema.json", &pretty(&date_expr_schema()))?;
    write(dir, "phrases.json", &pretty(&phrases()))?;
    write(dir, "metadata.json", &pretty(&metadata()))?;
    write(dir, "errors.json", &pretty(&errors()))?;
    write(dir, "identity.json", &pretty(&crate::identity::json()))?;
    rendered_prompts(dir)?;
    Ok(vec![
        "tools.json",
        "tools.full.json",
        "kind_card.txt",
        "date_expr.schema.json",
        "phrases.json",
        "metadata.json",
        "errors.json",
        "identity.json",
        "prompt.sig.txt",
        "prompt.compact.txt",
        "prompt.full.txt",
    ])
}
