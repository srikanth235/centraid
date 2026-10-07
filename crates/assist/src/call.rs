//! WHAT THE MODEL SAID: a tool call, a direct answer, or "nothing fits".
//!
//! The grammar makes every other output unsayable, so a parse failure here is
//! an engine that ignored its grammar (or a fake that was scripted wrongly) and
//! is answered as a typed refusal rather than guessed at.
//!
//! The call's JSON has ONE canonical spelling — compact, arguments in the
//! spec's order — which is what the prompt shows for earlier turns, what the
//! eval fixture's expected completion is, and what the grammar accepts. Three
//! spellings of one call would be three things the fine-tune could learn.

use serde_json::Value;

use crate::tool::{ArgKind, TEXT_MAX, ToolSet, ToolSpec, tool};

/// The longest direct answer, in characters.
pub const ANSWER_MAX: usize = 200;

/// One argument's value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgValue {
    Text(String),
    Choice(&'static str),
}

impl ArgValue {
    /// The value as the word it is.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Text(text) => text,
            Self::Choice(word) => word,
        }
    }
}

/// Why an argument list was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ArgError {
    #[error("`{0}` is not a tool")]
    UnknownTool(String),
    #[error("`{tool}` takes no argument `{arg}`")]
    UnknownArg { tool: &'static str, arg: String },
    #[error("`{tool}` needs `{arg}`")]
    Missing {
        tool: &'static str,
        arg: &'static str,
    },
    #[error("`{tool}`'s `{arg}` is not valid: {why}")]
    Invalid {
        tool: &'static str,
        arg: &'static str,
        why: &'static str,
    },
}

/// A validated call: a registered tool and arguments that satisfy its spec.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    spec: &'static ToolSpec,
    /// In the spec's order, so serialising needs no sort.
    args: Vec<(&'static str, ArgValue)>,
}

impl ToolCall {
    /// Build a call from names and words, validating every one.
    ///
    /// # Errors
    /// [`ArgError`] for an unknown tool or argument, a missing required one, or
    /// a value the spec does not allow.
    pub fn new<'a>(
        name: &str,
        args: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Result<Self, ArgError> {
        let spec = tool(name).ok_or_else(|| ArgError::UnknownTool(name.to_owned()))?;
        let given: Vec<(&str, &str)> = args.into_iter().collect();
        Self::validated(spec, &given)
    }

    fn validated(spec: &'static ToolSpec, given: &[(&str, &str)]) -> Result<Self, ArgError> {
        if let Some((arg, _)) = given.iter().find(|(arg, _)| spec.arg(arg).is_none()) {
            return Err(ArgError::UnknownArg {
                tool: spec.name,
                arg: (*arg).to_owned(),
            });
        }
        let mut args = Vec::new();
        for declared in spec.args {
            let Some((_, raw)) = given.iter().find(|(arg, _)| *arg == declared.name) else {
                if declared.required {
                    return Err(ArgError::Missing {
                        tool: spec.name,
                        arg: declared.name,
                    });
                }
                continue;
            };
            let value = match declared.kind {
                ArgKind::Text => {
                    let text = normalize(raw);
                    if text.is_empty() {
                        return Err(invalid(spec, declared.name, "it is empty"));
                    }
                    if text.chars().count() > TEXT_MAX {
                        return Err(invalid(spec, declared.name, "it is too long"));
                    }
                    ArgValue::Text(text)
                }
                ArgKind::Choice(words) => {
                    let Some(word) = words.iter().find(|word| **word == *raw) else {
                        return Err(invalid(spec, declared.name, "it is not one of the choices"));
                    };
                    ArgValue::Choice(word)
                }
            };
            args.push((declared.name, value));
        }
        Ok(Self { spec, args })
    }

    /// The tool.
    #[must_use]
    pub const fn spec(&self) -> &'static ToolSpec {
        self.spec
    }

    /// The tool's name.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        self.spec.name
    }

    /// An argument's value, when it was given.
    #[must_use]
    pub fn arg(&self, name: &str) -> Option<&str> {
        self.args
            .iter()
            .find(|(arg, _)| *arg == name)
            .map(|(_, value)| value.as_str())
    }

    /// The arguments given, in the spec's order.
    pub fn args(&self) -> impl Iterator<Item = (&'static str, &str)> + '_ {
        self.args
            .iter()
            .map(|(name, value)| (*name, value.as_str()))
    }

    /// THE CANONICAL JSON: `{"tool":"tasks.list","args":{"view":"today"}}`.
    #[must_use]
    pub fn to_json(&self) -> String {
        let args = self
            .args
            .iter()
            .map(|(name, value)| format!("\"{name}\":{}", json_string(value.as_str())))
            .collect::<Vec<_>>()
            .join(",");
        format!("{{\"tool\":\"{}\",\"args\":{{{args}}}}}", self.spec.name)
    }
}

fn invalid(spec: &'static ToolSpec, arg: &'static str, why: &'static str) -> ArgError {
    ArgError::Invalid {
        tool: spec.name,
        arg,
        why,
    }
}

fn json_string(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

/// One line, single spaces, trimmed: how every piece of member text is held.
#[must_use]
pub fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// What a route is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Read the vault with this call.
    Tool(ToolCall),
    /// No tool fits: say so, without guessing.
    NoTool,
    /// A direct reply that needs no data (a greeting, what the assistant does).
    Answer(String),
}

/// Why model output was not a route.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RouteError {
    #[error("the output holds no complete JSON object")]
    NotJson,
    #[error("the object names neither a tool nor an answer")]
    Shape,
    #[error("`{0}` is a tool, and not one this chat offers")]
    NotOffered(String),
    #[error(transparent)]
    Arg(#[from] ArgError),
}

/// Parse the model's routing output against the tools it was offered.
///
/// # Errors
/// [`RouteError`] when the output is not one of the three route shapes.
pub fn parse_route(output: &str, offered: &ToolSet) -> Result<Route, RouteError> {
    let object = first_object(output).ok_or(RouteError::NotJson)?;
    let value: Value = serde_json::from_str(object).map_err(|_| RouteError::NotJson)?;
    let Value::Object(fields) = &value else {
        return Err(RouteError::Shape);
    };
    if let Some(answer) = fields.get("answer") {
        let text = normalize(answer.as_str().ok_or(RouteError::Shape)?);
        if text.is_empty() {
            return Err(RouteError::Shape);
        }
        return Ok(Route::Answer(text.chars().take(ANSWER_MAX).collect()));
    }
    let name = fields
        .get("tool")
        .and_then(Value::as_str)
        .ok_or(RouteError::Shape)?;
    if name == "none" {
        return Ok(Route::NoTool);
    }
    let spec = tool(name).ok_or_else(|| ArgError::UnknownTool(name.to_owned()))?;
    if !offered.contains(name) {
        return Err(RouteError::NotOffered(name.to_owned()));
    }
    let empty = serde_json::Map::new();
    let args = match fields.get("args") {
        None => &empty,
        Some(Value::Object(args)) => args,
        Some(_) => return Err(RouteError::Shape),
    };
    let mut given = Vec::new();
    for (arg, value) in args {
        let Some(word) = value.as_str() else {
            return Err(ArgError::Invalid {
                tool: spec.name,
                arg: spec.arg(arg).map_or("", |declared| declared.name),
                why: "it is not a string",
            }
            .into());
        };
        given.push((arg.as_str(), word));
    }
    Ok(Route::Tool(ToolCall::validated(spec, &given)?))
}

/// The first balanced `{ … }` in `text`, honouring strings and escapes.
fn first_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, character) in text[start..].char_indices() {
        if in_string {
            match character {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[start..=start + offset]);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::App;

    fn all() -> ToolSet {
        ToolSet::for_scope(None)
    }

    #[test]
    fn a_call_serialises_compactly_in_the_specs_order() {
        let call =
            ToolCall::new("tasks.list", [("project", "Tahoe trip"), ("view", "today")]).unwrap();
        assert_eq!(
            call.to_json(),
            r#"{"tool":"tasks.list","args":{"view":"today","project":"Tahoe trip"}}"#
        );
        let none = ToolCall::new("people.reconnect", []).unwrap();
        assert_eq!(none.to_json(), r#"{"tool":"people.reconnect","args":{}}"#);
    }

    #[test]
    fn the_canonical_json_parses_back_to_the_same_call() {
        for spec in crate::tool::TOOLS {
            let given: Vec<(&str, &str)> = spec
                .args
                .iter()
                .map(|arg| {
                    (
                        arg.name,
                        match arg.kind {
                            ArgKind::Text => "tahoe",
                            ArgKind::Choice(words) => words[0],
                        },
                    )
                })
                .collect();
            let call = ToolCall::new(spec.name, given).unwrap();
            assert_eq!(parse_route(&call.to_json(), &all()), Ok(Route::Tool(call)));
        }
    }

    #[test]
    fn an_argument_the_spec_does_not_have_is_refused() {
        assert!(matches!(
            ToolCall::new("tasks.list", [("limit", "5")]),
            Err(ArgError::UnknownArg { .. })
        ));
    }

    #[test]
    fn a_required_argument_must_be_given_and_non_empty() {
        assert!(matches!(
            ToolCall::new("tasks.search", []),
            Err(ArgError::Missing { arg: "term", .. })
        ));
        assert!(matches!(
            ToolCall::new("tasks.search", [("term", "   ")]),
            Err(ArgError::Invalid { arg: "term", .. })
        ));
    }

    #[test]
    fn a_choice_outside_the_set_and_a_text_past_the_cap_are_refused() {
        assert!(matches!(
            ToolCall::new("tasks.list", [("view", "someday")]),
            Err(ArgError::Invalid { arg: "view", .. })
        ));
        let long = "x".repeat(TEXT_MAX + 1);
        assert!(matches!(
            ToolCall::new("tasks.search", [("term", long.as_str())]),
            Err(ArgError::Invalid { arg: "term", .. })
        ));
    }

    #[test]
    fn text_is_held_as_one_trimmed_line() {
        let call = ToolCall::new("notes.search", [("term", "  drive\n  vs   fly ")]).unwrap();
        assert_eq!(call.arg("term"), Some("drive vs fly"));
    }

    #[test]
    fn the_three_route_shapes_parse() {
        assert_eq!(parse_route(r#"{"tool":"none"}"#, &all()), Ok(Route::NoTool));
        assert_eq!(
            parse_route(r#"{"answer":"I read your tasks, notes and more."}"#, &all()),
            Ok(Route::Answer(
                "I read your tasks, notes and more.".to_owned()
            ))
        );
        assert!(matches!(
            parse_route(r#"{"tool":"agenda.search","args":{"term":"dentist"}}"#, &all()),
            Ok(Route::Tool(call)) if call.name() == "agenda.search"
        ));
    }

    #[test]
    fn a_tool_outside_the_offered_set_is_not_taken() {
        let mut set = ToolSet::for_scope(Some(App::Agenda));
        while set.drop_last(2) {}
        assert_eq!(set.len(), 2);
        assert_eq!(
            parse_route(r#"{"tool":"tally.balances","args":{}}"#, &set),
            Err(RouteError::NotOffered("tally.balances".to_owned()))
        );
    }

    #[test]
    fn locker_is_not_a_tool_even_when_the_model_says_it() {
        assert!(matches!(
            parse_route(r#"{"tool":"locker.items","args":{}}"#, &all()),
            Err(RouteError::Arg(ArgError::UnknownTool(_)))
        ));
    }

    #[test]
    fn prose_around_the_object_is_ignored_and_no_object_is_refused() {
        assert!(matches!(
            parse_route("<tool_call>\n{\"tool\":\"none\"}\n</tool_call>", &all()),
            Ok(Route::NoTool)
        ));
        assert_eq!(parse_route("I will look", &all()), Err(RouteError::NotJson));
        assert_eq!(
            parse_route(r#"{"tool":"none""#, &all()),
            Err(RouteError::NotJson)
        );
        assert_eq!(parse_route(r#"{"x":1}"#, &all()), Err(RouteError::Shape));
        assert_eq!(
            parse_route(r#"{"answer":"  "}"#, &all()),
            Err(RouteError::Shape)
        );
    }

    #[test]
    fn a_brace_inside_a_string_does_not_end_the_object() {
        let route = parse_route(r#"{"tool":"notes.search","args":{"term":"a } b"}}"#, &all());
        assert!(matches!(route, Ok(Route::Tool(call)) if call.arg("term") == Some("a } b")));
    }

    #[test]
    fn a_non_string_argument_is_refused() {
        assert!(matches!(
            parse_route(r#"{"tool":"notes.search","args":{"term":5}}"#, &all()),
            Err(RouteError::Arg(ArgError::Invalid { .. }))
        ));
    }

    #[test]
    fn a_long_direct_answer_is_cut_to_the_cap() {
        let long = "word ".repeat(100);
        let route = parse_route(&format!("{{\"answer\":\"{long}\"}}"), &all()).unwrap();
        match route {
            Route::Answer(text) => assert_eq!(text.chars().count(), ANSWER_MAX),
            other => panic!("{other:?}"),
        }
    }
}
