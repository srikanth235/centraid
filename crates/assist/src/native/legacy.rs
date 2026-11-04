//! THE TOOLS S2 WAS TRAINED ON (#1166). The model shipping today learned `search`, `open` and
//! `act`; the runtime now has `find` (text and rows included), `create`, `edit` and `do`. A call
//! in the old names is renamed here, at the one place a call enters (`Session::step`), so the
//! rest of the runtime knows eight tools only. The old `answer` with a selector or an `op` is not
//! renamed: `answer` still reads it (`Session::answer`), which keeps S2's way of ending a count
//! working until the data retrains the model on `compute` then `answer`.
//!
//! Nothing here is reachable from a model trained on the new tool set: it never writes these names.

use serde_json::{Map, Value, json};

use crate::native::meta;

/// The tool names S2 writes that no longer exist.
pub const RETIRED: [&str; 3] = ["search", "open", "act"];

/// The call as the eight tools state it, when `tool` is a retired name; `None` for any other call.
#[must_use]
pub fn modernize(tool: &str, args: &Value) -> Option<(&'static str, Value)> {
    let object = args.as_object().cloned();
    match tool {
        "search" => Some(("find", Value::Object(object?))),
        "open" => {
            let mut object = object?;
            if let Some(row) = object.remove("row") {
                object.insert("rows".to_owned(), row);
            }
            Some(("find", Value::Object(object)))
        }
        "act" => {
            let mut object: Map<String, Value> = object?;
            let verb = object
                .get("verb")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let new = verb.as_deref().map_or("do", meta::tool_of_verb);
            if new != "do" {
                object.remove("verb");
            }
            Some((new, json!(object)))
        }
        _ => None,
    }
}

/// A `create` or `edit` whose fields are parameters of their own (`create kind=task name=Pay rent date=…`, the
/// regrouped tools' shape, #1166) as the one call the runtime executes: the fields folded into `args`, in the order
/// written, a value read as a line's value is (`30` is a number). The parameters a tool takes itself stay where they
/// are, and so does a selector parameter an `edit` does not take (`kind`, `where`, …), which is refused by name
/// downstream. `None` when the call has no flat field. S2 never writes this shape.
#[must_use]
pub fn fold_fields(tool: &str, args: &Value) -> Option<Value> {
    let own: &[&str] = match tool {
        "create" => &["kind", "args", "more"],
        "edit" => &["rows", "args", "more"],
        _ => return None,
    };
    let object = args.as_object()?;
    let fields = meta::flat_field_names();
    let flat = |key: &str| {
        !own.contains(&key)
            && fields.contains(&key)
            && (tool == "create"
                || !meta::SELECTOR_PARAMS.contains(&key)
                // an edit's `name` renames the rows it is given; with none it is the by-name selector the tool refuses
                || (key == "name" && object.contains_key("rows")))
    };
    if !object.keys().any(|key| flat(key)) {
        return None;
    }
    let mut folded = Map::new();
    let mut fields_map = match object.get("args") {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::String(text)) => {
            crate::native::act::act_args(Some(&Value::String(text.clone()))).unwrap_or_default()
        }
        _ => Map::new(),
    };
    for (key, value) in object {
        if flat(key) {
            let value = match value {
                Value::String(text) => crate::native::act::arg_value(text),
                other => other.clone(),
            };
            fields_map.insert(key.clone(), value);
        } else if key != "args" {
            folded.insert(key.clone(), value.clone());
        }
    }
    folded.insert("args".to_owned(), Value::Object(fields_map));
    Some(Value::Object(folded))
}
