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
