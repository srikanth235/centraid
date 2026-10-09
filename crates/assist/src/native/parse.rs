//! Reading a raw Qwen3.5 tool call:
//! `<tool_call><function=NAME><parameter=P>VALUE</parameter>…</function></tool_call>`.

use serde_json::{Map, Value, json};

use crate::native::identity::MODEL;
use crate::native::meta;
use crate::native::session::handle_list;

/// Parameters whose value is a list of `#n` / `@n`.
const HANDLE_LISTS: &[&str] = &["rows", "options", "exclude", "linked_to"];
/// Parameters whose value is a whole number.
const INTEGERS: &[&str] = &["limit"];
/// Parameters whose value is a boolean.
const BOOLEANS: &[&str] = &["more", "trashed"];
/// Parameters whose value is a date expression.
const DATES: &[&str] = &["when"];

/// The line a message with more than one call ends its reply with (the first call ran).
pub const ONLY_FIRST: &str = "note: only the first call ran";

/// The observation a call that cannot be read gets.
#[must_use]
pub fn unreadable(why: &str) -> String {
    format!(
        "error: could not read the call ({why}). tools: {}.",
        meta::TOOLS.join(", ")
    )
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<(&'a str, &'a str)> {
    let start = text.find(open)? + open.len();
    let rest = &text[start..];
    let end = rest.find(close)?;
    Some((&rest[..end], &rest[end + close.len()..]))
}

fn trim_one_newline(value: &str) -> &str {
    let value = value.strip_prefix('\n').unwrap_or(value);
    value.strip_suffix('\n').unwrap_or(value)
}

/// Parse a model message into `{"tool", "args"}`. Anything before the
/// `<tool_call>` (thinking) is ignored.
pub fn parse_call(text: &str) -> Result<Value, String> {
    // ONE CALL PER MESSAGE (nt12 R5): a second call is not queued; the first runs and the reply
    // says so (`ONLY_FIRST`, `extra_calls`). The model could not have meant the second to run
    // first, and the reply tells it the second did not run.
    let calls = text.matches(MODEL.tool_call_open).count();
    let functions = text.matches(MODEL.function_open).count();
    let extra = calls.max(functions).saturating_sub(1);
    let body = match text.find(MODEL.tool_call_open) {
        Some(start) => {
            let rest = &text[start + MODEL.tool_call_open.len()..];
            rest.find(MODEL.tool_call_close)
                .map_or(rest, |end| &rest[..end])
        }
        None => {
            return Err(unreadable(&format!("no {}", MODEL.tool_call_open)));
        }
    };
    let (name, rest) = between(body, MODEL.function_open, ">")
        .ok_or_else(|| unreadable(&format!("no {}…>", MODEL.function_open)))?;
    let name = name.trim();
    if !meta::TOOLS.contains(&name) {
        return Err(unreadable(&format!("no tool \"{name}\"")));
    }
    let inner = rest
        .find(MODEL.function_close)
        .map_or(rest, |end| &rest[..end]);
    let mut args = Map::new();
    let mut cursor = inner;
    while let Some(start) = cursor.find(MODEL.parameter_open) {
        let after = &cursor[start + MODEL.parameter_open.len()..];
        let close = after
            .find('>')
            .ok_or_else(|| unreadable(&format!("an unclosed {}…>", MODEL.parameter_open)))?;
        let key = after[..close].trim().to_owned();
        let value_start = &after[close + 1..];
        // A LEAKED OPENER: `<parameter=within>` straight followed by another
        // `<parameter=…>` has no value of its own; the inner one is the
        // parameter the model meant.
        if value_start.trim_start().starts_with(MODEL.parameter_open) {
            cursor = value_start;
            continue;
        }
        let end = value_start.find(MODEL.parameter_close).ok_or_else(|| {
            unreadable(&format!("parameter {key} has no {}", MODEL.parameter_close))
        })?;
        let raw = trim_one_newline(&value_start[..end]);
        let (key, value) = salvage(name, &key, raw).unwrap_or_else(|| {
            let value = typed(&key, raw);
            (key.clone(), value)
        });
        args.entry(key).or_insert(value);
        cursor = &value_start[end + MODEL.parameter_close.len()..];
    }
    let mut call = json!({"tool": name, "args": Value::Object(args)});
    if extra > 0 {
        call["extra_calls"] = json!(extra);
    }
    Ok(call)
}

/// A parameter the model invented for what a real one carries: `result` (the
/// thing it means to select from) with `#n` is `rows`, with `@n` is `within`,
/// and with a kind name is `kind`. Only when the value says which. A key the
/// tool really takes is never renamed: `open`'s own parameter is `row`.
fn salvage(tool: &str, key: &str, raw: &str) -> Option<(String, Value)> {
    if (key != "result" && key != "row") || crate::native::session::tool_params(tool).contains(&key)
    {
        return None;
    }
    let value = raw.trim();
    let first = value.chars().next()?;
    if first == '@' && !value.contains([',', ' ']) {
        return Some(("within".to_owned(), Value::String(value.to_owned())));
    }
    if first == '#' {
        return Some(("rows".to_owned(), typed("rows", value)));
    }
    let word = value.to_lowercase();
    let word = if word == "people" {
        "person".to_owned()
    } else {
        word.strip_suffix('s').unwrap_or(&word).to_owned()
    };
    crate::native::meta::Kind::ALL
        .iter()
        .find(|kind| kind.name() == word)
        .map(|kind| ("kind".to_owned(), Value::String(kind.name().to_owned())))
}

fn typed(key: &str, raw: &str) -> Value {
    let trimmed = raw.trim();
    if HANDLE_LISTS.contains(&key) {
        return Value::Array(
            handle_list(&Value::String(trimmed.to_owned()))
                .into_iter()
                .map(Value::String)
                .collect(),
        );
    }
    if INTEGERS.contains(&key)
        && let Ok(number) = trimmed.parse::<i64>()
    {
        return json!(number);
    }
    if BOOLEANS.contains(&key) {
        match trimmed.to_lowercase().as_str() {
            "true" => return json!(true),
            "false" => return json!(false),
            _ => {}
        }
    }
    if (DATES.contains(&key) || trimmed.starts_with('{'))
        && let Ok(value) = serde_json::from_str::<Value>(trimmed)
        && value.is_object()
    {
        return value;
    }
    Value::String(raw.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_native_call_parses_with_typed_values() {
        let text = "<think>\nintent: read\n</think>\n<tool_call>\n<function=find>\n<parameter=kind>\ntask\n</parameter>\n<parameter=when>\n{\"unit\":\"day\",\"rel\":1}\n</parameter>\n<parameter=limit>\n3\n</parameter>\n</function>\n</tool_call>";
        let call = parse_call(text).unwrap();
        assert_eq!(call["tool"], "find");
        assert_eq!(call["args"]["kind"], "task");
        assert_eq!(call["args"]["when"]["rel"], 1);
        assert_eq!(call["args"]["limit"], 3);
    }

    #[test]
    fn rows_become_a_list_and_args_stay_lines() {
        let text = "<tool_call>\n<function=act>\n<parameter=verb>\nedit\n</parameter>\n<parameter=rows>\n#3, #4\n</parameter>\n<parameter=args>\nname: Dal\neffort: 30\n</parameter>\n<parameter=more>\ntrue\n</parameter>\n</function>\n</tool_call>";
        let call = parse_call(text).unwrap();
        assert_eq!(call["args"]["rows"], json!(["#3", "#4"]));
        assert_eq!(call["args"]["args"], "name: Dal\neffort: 30");
        assert_eq!(call["args"]["more"], true);
    }

    #[test]
    fn leaked_parameter_syntax_is_salvaged() {
        let text = "<tool_call>\n<function=answer>\n<parameter=within>\n<parameter=rows>\n#34\n</parameter>\n</function>\n</tool_call>";
        let call = parse_call(text).unwrap();
        assert_eq!(call["args"], json!({"rows": ["#34"]}));
        let text = "<tool_call>\n<function=answer>\n<parameter=within>\n<parameter=result>\ntasks\n</parameter>\n<parameter=linked_to>\n#31\n</parameter>\n</function>\n</tool_call>";
        let call = parse_call(text).unwrap();
        assert_eq!(call["args"], json!({"kind": "task", "linked_to": ["#31"]}));
        let text = "<tool_call>\n<function=answer>\n<parameter=within>\n<parameter=result>\n<parameter=order>\namount asc\n</parameter>\n</function>\n</tool_call>";
        let call = parse_call(text).unwrap();
        assert_eq!(call["args"], json!({"order": "amount asc"}));
    }

    #[test]
    fn open_keeps_its_own_row_parameter() {
        // `row` is open's real parameter: salvaging it into `rows` made every
        // `open` of a handle fail with `open has no parameter "rows"`.
        let text = "<tool_call>\n<function=open>\n<parameter=row>\n#7\n</parameter>\n</function>\n</tool_call>";
        let call = parse_call(text).unwrap();
        assert_eq!(call["args"], json!({"row": "#7"}));
        // a tool without a `row` parameter still gets the salvage
        let text = "<tool_call>\n<function=act>\n<parameter=row>\n#7\n</parameter>\n</function>\n</tool_call>";
        assert_eq!(parse_call(text).unwrap()["args"], json!({"rows": ["#7"]}));
    }

    #[test]
    fn an_unreadable_call_names_the_tools() {
        let error = parse_call("I will look.").unwrap_err();
        assert!(error.starts_with("error: could not read the call"));
        assert!(error.contains("search, find, open"));
        assert!(parse_call("<tool_call><function=delete_all></function></tool_call>").is_err());
    }
}
