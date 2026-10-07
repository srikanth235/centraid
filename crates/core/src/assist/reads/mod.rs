//! THE READS: each registered tool, run through the query path a screen uses.
//!
//! A tool is a read an app already answers. Seven of the eight app crates
//! answer through `crate::app_query::answer` — the very function
//! `Request::AppQuery` reaches — so a card here is built from the rows the
//! app's own tile is built from. Photos has no app query yet and reads through
//! its crate's loader over [`crate::app_query::VaultDoor`], the same page door.
//! Nothing here writes SQL, and nothing here reaches for a connection.
//!
//! **A table, not a `match`.** [`EXECUTORS`] is keyed by tool name, and
//! `tests::every_registered_tool_has_an_executor_and_no_other` holds it equal to
//! the registry: a tool added to `centraid_assist::TOOLS` without a reader is a
//! red test, not a refusal a member meets.
//!
//! **A read here is bounded by a number in this module**, never by what the
//! vault holds: every query asks for at most [`ROWS`] rows, and the one that
//! folds a window (`photos`) names its window.

use centraid_api_proto::core_v1 as wire;
use centraid_assist::{ReadError, ToolCall, ToolOutput};
use centraid_vault::Vault;

mod agenda;
mod civil;
mod docs;
mod notes;
mod people;
mod photos;
mod tally;
mod tasks;

type Answer = wire::app_query_response::Answer;
type Query = wire::app_query_request::Query;

/// The most rows one read asks an app for: two screenfuls of cards, which is
/// far more than a one-sentence answer will mention.
pub(super) const ROWS: u32 = 12;

/// What a read needs besides the call.
pub(super) struct Env<'a> {
    pub vault: &'a Vault,
    pub tz: &'a str,
}

impl Env<'_> {
    /// Ask an app query, the way a shell does.
    pub(super) fn ask(&self, query: Query) -> Result<Answer, ReadError> {
        let answered =
            crate::app_query::answer(self.vault, &wire::AppQueryRequest { query: Some(query) })
                .map_err(|error| ReadError(error.to_string()))?;
        match answered.answer {
            Some(Answer::Denied(denial)) => Err(ReadError(format!(
                "the vault refused the read: {}",
                denial.message.unwrap_or_default()
            ))),
            Some(answer) => Ok(answer),
            None => Err(ReadError("the app answered nothing".to_owned())),
        }
    }
}

/// One executor.
pub(super) type Executor = fn(&Env<'_>, &ToolCall) -> Result<ToolOutput, ReadError>;

/// Every executor, keyed by the tool it runs.
pub(super) const EXECUTORS: &[(&str, Executor)] = &[
    ("agenda.upcoming", agenda::upcoming),
    ("agenda.search", agenda::search),
    ("docs.list", docs::list),
    ("docs.search", docs::search),
    ("notes.list", notes::list),
    ("notes.search", notes::search),
    ("people.list", people::list),
    ("people.search", people::search),
    ("people.reconnect", people::reconnect),
    ("photos.recent", photos::recent),
    ("photos.search", photos::search),
    ("tally.balances", tally::balances),
    ("tally.recent", tally::recent),
    ("tally.search", tally::search),
    ("tally.spending", tally::spending),
    ("tasks.list", tasks::list),
    ("tasks.search", tasks::search),
    ("tasks.projects", tasks::projects),
];

/// Run `call` against `vault`, with civil words read in `tz`.
pub(super) fn run(vault: &Vault, call: &ToolCall, tz: &str) -> Result<ToolOutput, ReadError> {
    let Some((_, executor)) = EXECUTORS.iter().find(|(name, _)| *name == call.name()) else {
        return Err(ReadError(format!(
            "no reader is registered for {}",
            call.name()
        )));
    };
    executor(&Env { vault, tz }, call)
}

/// A read answered with a shape its tool does not ask for: the app crate and
/// this module disagree, which is a bug and not a vault state.
pub(super) fn unexpected(tool: &str) -> ReadError {
    ReadError(format!("{tool} was answered with a shape it does not read"))
}

/// `3 tasks`, `1 task`, `No tasks`.
pub(super) fn counted(n: usize, one: &str, many: &str) -> String {
    match n {
        0 => format!("No {many}"),
        1 => format!("1 {one}"),
        _ => format!("{n} {many}"),
    }
}

/// `text` cut to `max` characters with an ellipsis, for a card's title.
pub(super) fn clip(text: &str, max: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= max {
        return line;
    }
    let cut: String = line.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// A title, or the first words of `fallback` when the row has none.
pub(super) fn title_or(title: Option<&str>, fallback: &str, untitled: &str) -> String {
    match title.map(str::trim).filter(|title| !title.is_empty()) {
        Some(title) => clip(title, 80),
        None if !fallback.trim().is_empty() => clip(fallback, 60),
        None => untitled.to_owned(),
    }
}

/// An optional proto string as plain text.
pub(super) fn text(value: &Option<String>) -> &str {
    value.as_deref().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registered_tool_has_an_executor_and_no_other() {
        let mut registered: Vec<&str> = centraid_assist::TOOLS
            .iter()
            .map(|spec| spec.name)
            .collect();
        let mut executors: Vec<&str> = EXECUTORS.iter().map(|(name, _)| *name).collect();
        registered.sort_unstable();
        executors.sort_unstable();
        assert_eq!(registered, executors);
    }

    #[test]
    fn counts_read_as_a_sentence() {
        assert_eq!(counted(0, "task", "tasks"), "No tasks");
        assert_eq!(counted(1, "task", "tasks"), "1 task");
        assert_eq!(counted(4, "task", "tasks"), "4 tasks");
    }

    #[test]
    fn titles_are_clipped_on_one_line() {
        assert_eq!(clip("a\n b  c", 20), "a b c");
        assert_eq!(clip(&"x".repeat(100), 10).chars().count(), 10);
        assert_eq!(
            title_or(None, "Brown 2 lb chuck in batches", "Untitled note"),
            "Brown 2 lb chuck in batches"
        );
        assert_eq!(title_or(Some("  "), "", "Untitled note"), "Untitled note");
    }
}
