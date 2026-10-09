//! THE SYSTEM PROMPT (SPEC §6.0): today and me, the tools as JSON schemas in
//! Qwen3.5's native `<tools>` block, the kind card, the vault directory; and
//! the block that leads every user turn (SPEC §6.1): the `vault:`, `focus:`
//! and `dates:` lines, rendered here so training and inference read the same
//! text.

use std::collections::BTreeSet;

use serde_json::{Value, json};

use crate::native::dates::Unit;
use crate::native::identity::MODEL;
use crate::native::meta::{self, Kind, LOOKUP_CAP, VERBS};
use crate::native::render;
use crate::native::session::Session;

/// The nested schema of a date expression, as `find` carries it.
#[must_use]
pub fn date_expr_property(description: &str) -> Value {
    json!({
        "type": "object",
        "description": description,
        "properties": {
            "unit": {"type": "string", "enum": Unit::NAMES},
            "rel": {"type": "integer"},
            "name": {"type": "integer"},
            "weekday": {"type": "integer"},
            "time": {"type": "string"},
            "anchor": {"type": "string", "enum": ["today", "row"]},
            "date": {"type": "string"},
            "from": {"type": "object"},
            "to": {"type": "object"}
        }
    })
}

/// THE PROMPT'S BUDGET: the selector is ten parameters and four tools take
/// it. `find` carries it with its descriptions and the nested date schema;
/// `compute`, `answer` and `act` carry name and type only and point at
/// `find`. The interface is the same either way, so the parser and the
/// runtime do not change; `full` is the spelling `tools.full.json` exports.
fn selector_properties(described: bool) -> serde_json::Map<String, Value> {
    let text = |description: &str| {
        if described {
            json!({"type": "string", "description": description})
        } else {
            json!({"type": "string"})
        }
    };
    let mut map = serde_json::Map::new();
    map.insert("kind".into(), text("a kind or a comma list"));
    map.insert(
        "name".into(),
        text("words, any order; the only name filter"),
    );
    map.insert(
        "where".into(),
        text("field = value (!= < <= > >=), contains \"…\", in (\"a\", \"b\"), is empty, is set, <kind> count >= N; joined by and; one kind"),
    );
    map.insert(
        "when".into(),
        if described {
            date_expr_property(
                "the only date filter, on the kind's date. rel: offset in units, 0 = this; name: month 1..12; weekday: 1..7 Mon..Sun; time: HH:MM; date: YYYY-MM-DD; from, to: a span, one end may be open; anchor row: the target's own date (act)",
            )
        } else {
            json!({"type": "object", "description": "date expression, as in find"})
        },
    );
    map.insert("linked_to".into(), text("#n"));
    map.insert("within".into(), text("@n to narrow"));
    map.insert("exclude".into(), text("#n, #m"));
    map.insert("order".into(), text("field asc|desc; one kind only"));
    map.insert("limit".into(), json!({"type": "integer"}));
    map.insert(
        "trashed".into(),
        if described {
            json!({"type": "boolean", "description": "only trashed rows"})
        } else {
            json!({"type": "boolean"})
        },
    );
    map
}

fn tool(
    name: &str,
    description: &str,
    properties: serde_json::Map<String, Value>,
    required: &[&str],
) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": Value::Object(properties),
                "required": required,
            }
        }
    })
}

/// The eight tools (SPEC §4) as the prompt carries them: the selector
/// described once, in `find`.
#[must_use]
pub fn tools() -> Vec<Value> {
    tools_with(false)
}

/// The eight tools with the selector described in every tool that takes it
/// (`tools.full.json`, for docs).
#[must_use]
pub fn tools_full() -> Vec<Value> {
    tools_with(true)
}

fn tools_with(full: bool) -> Vec<Value> {
    let shared = |text: &str| {
        if full {
            text.replace("; selector params as in find", "")
        } else {
            text.to_owned()
        }
    };
    let rows = json!({"type": "string", "description": "#n, @n list"});
    let op = json!({"type": "string", "enum": meta::OPS});
    let field = json!({"type": "string"});
    let mut search = serde_json::Map::new();
    search.insert("text".into(), json!({"type": "string"}));
    search.insert(
        "kind".into(),
        json!({"type": "string", "description": "any, a kind or a comma list"}),
    );
    let find = selector_properties(true);
    let mut open = serde_json::Map::new();
    open.insert("row".into(), json!({"type": "string", "description": "#n"}));
    let mut compute = serde_json::Map::new();
    compute.insert("op".into(), op.clone());
    compute.insert("field".into(), field.clone());
    compute.insert(
        "group".into(),
        json!({"type": "string", "description": "field to group by"}),
    );
    compute.insert("rows".into(), rows.clone());
    compute.extend(selector_properties(full));
    let verbs: Vec<&str> = VERBS.iter().map(|spec| spec.name).collect();
    let mut act = serde_json::Map::new();
    act.insert("verb".into(), json!({"type": "string", "enum": verbs}));
    act.insert("rows".into(), rows.clone());
    act.insert(
        "args".into(),
        json!({"type": "string", "description": "field: value lines, dates as date expressions (create: name and fields, kind as the kind param · edit: field: value, or body+: / description+: text to add · reschedule, add_to: to · remove_from: from · log: kind · settle_up: group · reveal: field)"}),
    );
    act.insert(
        "more".into(),
        json!({"type": "boolean", "description": "another call follows"}),
    );
    act.extend(selector_properties(full));
    let mut answer = serde_json::Map::new();
    answer.insert("rows".into(), rows);
    answer.insert("op".into(), op);
    answer.insert("field".into(), field);
    answer.insert(
        "value".into(),
        json!({"type": "string", "description": "@n"}),
    );
    answer.extend(selector_properties(full));
    let mut ask = serde_json::Map::new();
    ask.insert("question".into(), json!({"type": "string"}));
    ask.insert(
        "options".into(),
        json!({"type": "string", "description": "#n choices"}),
    );
    let mut decline = serde_json::Map::new();
    decline.insert(
        "reason".into(),
        json!({"type": "string", "enum": meta::DECLINE_REASONS}),
    );
    vec![
        tool(
            "search",
            "Fuzzy name search across the vault, any kind.",
            search,
            &["text"],
        ),
        tool(
            "find",
            "Rows a selector matches, numbered #n, as result @n.",
            find,
            &["kind"],
        ),
        tool("open", "Every fact and link of one row.", open, &["row"]),
        tool(
            "compute",
            &shared(
                "A value for a later step, or one per group value; selector params as in find.",
            ),
            compute,
            &["op"],
        ),
        tool(
            "act",
            &shared("Change the vault. Ends the turn unless more; selector params as in find."),
            act,
            &["verb"],
        ),
        tool(
            "answer",
            &shared(
                "Answer with rows, a value (op) or value=@n. Ends the turn; selector params as in find.",
            ),
            answer,
            &[],
        ),
        tool(
            "ask",
            "Ask the person to choose or clarify. Ends the turn.",
            ask,
            &["question"],
        ),
        tool("decline", "Decline. Ends the turn.", decline, &["reason"]),
    ]
}

/// Which spelling of the eight tools the prompt carries (`--tools`; `sig`
/// unless asked).
///
/// THE TOOLS BLOCK IS THE SAME IN EVERY EXAMPLE, so for a model fine-tuned on
/// these prompts it carries no information while costing most of each
/// example. `Sig` keeps Qwen's native `<tools>` block but gives each tool a
/// one-line signature and no parameter schema; `Compact` is the described
/// JSON schema (`tools.json`); `Full` repeats the described selector in every
/// tool (`tools.full.json`). The call format, the parser and the runtime are
/// the same in all three.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ToolsMode {
    #[default]
    Sig,
    Compact,
    Full,
}

impl ToolsMode {
    pub const ALL: [Self; 3] = [Self::Sig, Self::Compact, Self::Full];

    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Sig => "sig",
            Self::Compact => "compact",
            Self::Full => "full",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| mode.name() == text)
    }
}

/// The tools in one mode.
#[must_use]
pub fn tools_for(mode: ToolsMode) -> Vec<Value> {
    match mode {
        ToolsMode::Sig => tools_sig(),
        ToolsMode::Compact => tools(),
        ToolsMode::Full => tools_full(),
    }
}

/// The selector's parameters, in the order a signature lists them.
pub const SELECTOR: [&str; 10] = [
    "kind",
    "name",
    "where",
    "when",
    "linked_to",
    "within",
    "exclude",
    "order",
    "limit",
    "trashed",
];

/// A date expression's fields, in the order `find`'s signature lists them.
const DATE_FIELDS: [&str; 9] = [
    "unit", "rel", "name", "weekday", "time", "date", "from", "to", "anchor",
];

/// Each tool's signature: its parameters in order (`rows|selector` for the
/// either-or, `selector` for the ten selector parameters spelled out as
/// optional names) and the one-line gloss after the dash.
const SIGNATURES: [(&str, &[&str], &str); 8] = [
    (
        "search",
        &["text", "kind"],
        "fuzzy name search; kind: any, a kind or a comma list",
    ),
    (
        "find",
        &["selector"],
        "rows a selector matches, numbered #n, as @n",
    ),
    ("open", &["row"], "every fact and link of one row"),
    (
        "compute",
        &["op", "field", "group", "rows|selector"],
        "a value as @n, or one per group value",
    ),
    (
        "act",
        &["verb", "rows|selector", "args", "more"],
        "change the vault; ends the turn unless more; edit body+: or description+: adds text",
    ),
    (
        "answer",
        &["rows|selector", "op", "field", "value"],
        "rows, a value or value=@n; ends the turn",
    ),
    ("ask", &["question", "options"], "ends the turn"),
    ("decline", &["reason"], "ends the turn"),
];

fn enum_list(schema: &Value) -> Option<String> {
    let items = schema["enum"].as_array()?;
    Some(
        items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("|"),
    )
}

fn sig_param(name: &str, properties: &Value, required: &[Value]) -> String {
    let optional = if required.iter().any(|value| value == name) {
        ""
    } else {
        "?"
    };
    match enum_list(&properties[name]) {
        Some(list) => format!("{name}{optional}: {list}"),
        None => format!("{name}{optional}"),
    }
}

/// One tool's one-line signature, generated from its compact schema.
#[must_use]
pub fn signature(tool: &Value) -> String {
    let function = &tool["function"];
    let name = function["name"].as_str().unwrap_or_default();
    let properties = &function["parameters"]["properties"];
    let required = function["parameters"]["required"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let Some((_, params, gloss)) = SIGNATURES.iter().find(|(tool, _, _)| *tool == name) else {
        return name.to_owned();
    };
    let mut parts = Vec::new();
    for param in *params {
        match *param {
            "selector" => parts.extend(
                SELECTOR
                    .iter()
                    .map(|field| sig_param(field, properties, &required)),
            ),
            "rows|selector" => parts.push("rows? | selector".to_owned()),
            other => parts.push(sig_param(other, properties, &required)),
        }
    }
    let mut line = format!("{name}({}) — {gloss}", parts.join(", "));
    if name == "find" {
        let date = &properties["when"]["properties"];
        let fields: Vec<String> = DATE_FIELDS
            .iter()
            .map(|field| match enum_list(&date[*field]) {
                Some(list) => format!("{field}: {list}"),
                None => (*field).to_owned(),
            })
            .collect();
        line.push_str(&format!("; when: {{{}}}", fields.join(", ")));
    }
    line
}

/// The eight tools as signatures: Qwen's function form, empty parameters.
#[must_use]
pub fn tools_sig() -> Vec<Value> {
    tools()
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool["function"]["name"],
                    "description": signature(tool),
                    "parameters": {"type": "object", "properties": {}},
                }
            })
        })
        .collect()
}

/// Python's `json.dumps` spelling (`", "`, `": "`, non-ASCII kept), which is
/// what a chat template's `tojson` renders.
#[must_use]
pub fn py_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let parts: Vec<String> = map
                .iter()
                .map(|(key, value)| format!("{}: {}", Value::String(key.clone()), py_json(value)))
                .collect();
            format!("{{{}}}", parts.join(", "))
        }
        Value::Array(items) => {
            format!(
                "[{}]",
                items.iter().map(py_json).collect::<Vec<_>>().join(", ")
            )
        }
        other => other.to_string(),
    }
}

/// The kind card, one line per kind.
#[must_use]
pub fn kind_card(currency: &str) -> Vec<String> {
    Kind::ALL
        .iter()
        .map(|kind| render::card_line(*kind, currency))
        .collect()
}

/// Qwen's own sentence that tells the model how to call a function, written
/// from the model's identity so the markers are the ones the parser reads.
pub(crate) fn call_format() -> String {
    format!(
        "If you choose to call a function ONLY reply in the following format with NO suffix:\n\n\
{tc}\n{fo}example_function_name>\n{po}example_parameter_1>\nvalue_1\n{pc}\n{po}example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n{pc}\n{fc}\n{tcc}\n\n\
<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner {fo}...>{fc} block must be nested within {tc}{tcc} XML tags\n\
- Required parameters MUST be specified\n\
- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n\
- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n\
</IMPORTANT>",
        tc = MODEL.tool_call_open,
        tcc = MODEL.tool_call_close,
        fo = MODEL.function_open,
        fc = MODEL.function_close,
        po = MODEL.parameter_open,
        pc = MODEL.parameter_close,
    )
}

/// The Qwen3.5 tools block of the system turn.
#[must_use]
pub fn tools_block(tools: &[Value]) -> String {
    let mut out = format!(
        "# Tools\n\nYou have access to the following functions:\n\n{}",
        MODEL.tools_open
    );
    for tool in tools {
        out.push('\n');
        out.push_str(&py_json(tool));
    }
    out.push('\n');
    out.push_str(MODEL.tools_close);
    out.push_str("\n\n");
    out.push_str(&call_format());
    out
}

/// The prompt pieces.
pub fn prompt(session: &mut Session) -> Value {
    let today = session.today();
    let mut system = format!(
        "today: {} {today}\nme: {}\n\nkinds:\n{}",
        crate::native::dates::weekday_name(today),
        session.me_name,
        kind_card(&session.world.currency).join("\n")
    );
    if session.flags.directory {
        let mut lines = Vec::new();
        for (kind, keys, total) in session.directory_rows() {
            if keys.is_empty() {
                continue;
            }
            let names: Vec<String> = keys
                .iter()
                .map(|key| {
                    let number = session.number(key);
                    let name = session
                        .world
                        .row(key)
                        .map(|row| row.name.clone())
                        .unwrap_or_default();
                    format!("{name} (#{number})")
                })
                .collect();
            let mut line = format!("{}: {}", kind.plural(), names.join(", "));
            if total > keys.len() {
                line.push_str(&format!(" +{} more", total - keys.len()));
            }
            lines.push(line);
        }
        if !lines.is_empty() {
            system.push_str("\n\nvault directory:\n");
            system.push_str(&lines.join("\n"));
        }
    }
    let tools = tools_for(session.flags.tools);
    let rendered = format!(
        "{}system\n{}\n\n{system}{}\n",
        MODEL.im_start,
        tools_block(&tools),
        MODEL.im_end
    );
    json!({
        "system": system,
        "tools": tools,
        "rendered": rendered,
        "directory": session.directory,
    })
}

/// The numbers of `numbers` whose rows the vault still holds, in order.
pub(crate) fn live_numbers(session: &Session, numbers: &[usize]) -> Vec<usize> {
    numbers
        .iter()
        .copied()
        .filter(|number| {
            session
                .by_number
                .get(number.wrapping_sub(1))
                .is_some_and(|key| session.world.row(key).is_some())
        })
        .collect()
}

/// The rows `numbers` name, as `#n kind "name"`, one each. A row the vault no
/// longer holds is left out.
pub(crate) fn named_rows(session: &Session, numbers: &[usize]) -> Vec<String> {
    live_numbers(session, numbers)
        .into_iter()
        .map(|number| render::named(&session.world, number, &session.by_number[number - 1]))
        .collect()
}

/// THE FOCUS LINE of a user turn's block (SPEC §6.1): what the conversation
/// holds on to, so a follow-up ("put it in the new group", "the second one",
/// "the first Neha") points at rows the model reads again here instead of
/// finding them in a long transcript. Up to five parts, each only when the
/// session has something to say (`crate::native::block` renders all but the first):
///
/// - `created #52 group "Lisboa"`: the rows an `act` created, the last
///   `LOOKUP_CAP` of them (`+N earlier` for the rest);
/// - `@4: #44 task "Pay rent", #45 … · in #8 list "Home"`: the newest result
///   that holds rows, in the one-set form, naming the container its rows
///   share;
/// - `earlier: @3 (counted 10 documents in #39 folder "Taxes"), @2: #30 …`:
///   the other sets of the last `FOCUS_SETS`, newest first, a count or value
///   in brackets with its word first; at most `FOCUS_ROWS` rows in all across
///   the sets (`+N more` on the set that does not fit);
/// - `acted #12 event "Dentist", #13 task "Pay rent"`: the rows a write
///   changed, an already-so answer named or an undo touched in the last
///   `ACTED_TURNS` turns, that no part above names, the last `LOOKUP_CAP` of
///   them (`+N earlier` for the rest): a row a write reached by a selector or
///   off the `vault:` line is in no result set, so it is here;
/// - `asked: #41 person "Neha Rao" (designer · NK · Tahoe Trip), #39 …`: the
///   options of the `ask` that ended the previous turn, each with what tells
///   it apart, at most `ROW_CAP` (`+N more`); it is there for the one turn
///   that answers it.
///
/// Every row is one the session already numbered; the line never mints a
/// number (`Session::user` numbers the containers first). `None` when there is
/// nothing to say.
#[must_use]
pub fn focus_line(session: &Session) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    // the rows the parts name: a row is named once, and `acted` leaves out the
    // ones `created` and the result sets already name
    let mut named: BTreeSet<usize> = BTreeSet::new();
    let created = live_numbers(session, &session.created);
    if !created.is_empty() {
        let hidden = created.len().saturating_sub(LOOKUP_CAP);
        let mut part = format!(
            "created {}",
            named_rows(session, &created[hidden..]).join(", ")
        );
        if hidden > 0 {
            part.push_str(&format!(" +{hidden} earlier"));
        }
        named.extend(created[hidden..].iter().copied());
        parts.push(part);
    }
    let sets = crate::native::block::sets_parts(session);
    named.extend(sets.rows.iter().copied());
    parts.extend(sets.parts);
    parts.extend(crate::native::block::acted_part(session, &named));
    parts.extend(crate::native::block::asked_part(session));
    (!parts.is_empty()).then(|| format!("focus: {}", parts.join(" · ")))
}

/// The block that leads a user turn: the lines that exist (`vault:`,
/// `focus:`, `answer:`, `dates:`), one per line, in that order. The Python renderer puts
/// a blank line between it and the message (`render.user_content`).
#[must_use]
pub fn user_block(lines: &[&Option<String>]) -> Option<String> {
    let lines: Vec<&str> = lines.iter().filter_map(|line| line.as_deref()).collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}
