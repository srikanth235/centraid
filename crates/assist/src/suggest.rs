//! SUGGESTED PROMPTS: three questions this vault can answer.
//!
//! An empty thread would be a blank wall, so the chat offers three starting
//! points — and they are real: the names and titles in them are read from the
//! vault by the same tools the model uses, so a tap on one runs a question the
//! plane can answer from data that exists. Opened from an app, all three come
//! from that app.
//!
//! Deterministic: the same vault gives the same three, in the same order. A
//! suggestion is a [`ToolCall`] and the sentence a member would say to get it,
//! so the eval harness can hold each one to its call, and so a suggestion can
//! never name a question no tool answers.

use crate::call::ToolCall;
use crate::tool::App;
use crate::turn::{ReadContext, Reader};

/// How many suggestions the chat offers.
pub const SUGGESTIONS: usize = 3;

/// A question to offer, and the call a correct model answers it with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestion {
    pub text: String,
    pub call: ToolCall,
}

fn call(name: &str, args: &[(&str, &str)]) -> ToolCall {
    ToolCall::new(name, args.iter().copied())
        .expect("a built-in suggestion names a registered call")
}

fn say(text: impl Into<String>, name: &str, args: &[(&str, &str)]) -> Suggestion {
    Suggestion {
        text: text.into(),
        call: call(name, args),
    }
}

/// The first `count` words of a title, without the punctuation around them:
/// enough to find it again, short enough to say.
fn lead_words(title: &str, count: usize) -> String {
    title
        .split_whitespace()
        .map(|word| word.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|word| !word.is_empty())
        .take(count)
        .collect::<Vec<_>>()
        .join(" ")
}

/// A title's first row from `tool`, when the vault holds one.
fn first_title(
    reader: &dyn Reader,
    context: &ReadContext<'_>,
    name: &str,
    args: &[(&str, &str)],
) -> Option<String> {
    reader
        .read(&call(name, args), context)
        .ok()?
        .rows
        .into_iter()
        .map(|card| card.title)
        .find(|title| !lead_words(title, 1).is_empty())
}

/// Whether `name` finds something to show: rows, or facts such as a month's
/// totals, which have no row to draw.
fn has_rows(
    reader: &dyn Reader,
    context: &ReadContext<'_>,
    name: &str,
    args: &[(&str, &str)],
) -> bool {
    reader
        .read(&call(name, args), context)
        .is_ok_and(|output| !output.rows.is_empty() || !output.facts.is_empty())
}

/// Every candidate for one app: the ones the vault's data backs first, then
/// the ones that need no data. A read that fails simply offers fewer.
fn candidates(app: App, reader: &dyn Reader, context: &ReadContext<'_>) -> Vec<Suggestion> {
    let mut out = Vec::new();
    match app {
        App::Tasks => {
            if has_rows(reader, context, "tasks.list", &[("view", "today")]) {
                out.push(say(
                    "What is due today?",
                    "tasks.list",
                    &[("view", "today")],
                ));
            }
            if has_rows(reader, context, "tasks.list", &[("view", "overdue")]) {
                out.push(say(
                    "What is overdue?",
                    "tasks.list",
                    &[("view", "overdue")],
                ));
            }
            if let Some(project) = first_title(reader, context, "tasks.projects", &[]) {
                out.push(say(
                    format!("What is left in {project}?"),
                    "tasks.list",
                    &[("project", &project)],
                ));
            }
            out.push(say(
                "What is due today?",
                "tasks.list",
                &[("view", "today")],
            ));
            out.push(say(
                "What is coming up?",
                "tasks.list",
                &[("view", "upcoming")],
            ));
        }
        App::Agenda => {
            if has_rows(reader, context, "agenda.upcoming", &[("range", "week")]) {
                out.push(say(
                    "What is on my calendar this week?",
                    "agenda.upcoming",
                    &[("range", "week")],
                ));
            }
            if let Some(event) =
                first_title(reader, context, "agenda.upcoming", &[("range", "week")])
            {
                let words = lead_words(&event, 3);
                out.push(say(
                    format!("When is {words}?"),
                    "agenda.search",
                    &[("term", &words)],
                ));
            }
            out.push(say(
                "What is on my calendar this week?",
                "agenda.upcoming",
                &[("range", "week")],
            ));
            out.push(say(
                "What is on tomorrow?",
                "agenda.upcoming",
                &[("range", "tomorrow")],
            ));
        }
        App::People => {
            if has_rows(reader, context, "people.reconnect", &[]) {
                out.push(say(
                    "Who should I get in touch with?",
                    "people.reconnect",
                    &[],
                ));
            }
            if let Some(name) = first_title(reader, context, "people.list", &[("filter", "all")]) {
                out.push(say(
                    format!("What do I know about {name}?"),
                    "people.search",
                    &[("term", &name)],
                ));
            }
            out.push(say(
                "Who should I get in touch with?",
                "people.reconnect",
                &[],
            ));
            out.push(say(
                "Who is in my circle?",
                "people.list",
                &[("filter", "all")],
            ));
        }
        App::Tally => {
            if has_rows(reader, context, "tally.balances", &[]) {
                out.push(say("Who owes me money?", "tally.balances", &[]));
            }
            if let Some(expense) = first_title(reader, context, "tally.recent", &[]) {
                let words = lead_words(&expense, 3);
                out.push(say(
                    format!("What did {words} cost?"),
                    "tally.search",
                    &[("term", &words)],
                ));
            }
            // A month that holds no spending is not a question worth offering:
            // this month, else the last one, else neither.
            if has_rows(reader, context, "tally.spending", &[("month", "this")]) {
                out.push(say(
                    "What have we spent this month?",
                    "tally.spending",
                    &[("month", "this")],
                ));
            } else if has_rows(reader, context, "tally.spending", &[("month", "last")]) {
                out.push(say(
                    "What did we spend last month?",
                    "tally.spending",
                    &[("month", "last")],
                ));
            }
            out.push(say("Who owes me money?", "tally.balances", &[]));
        }
        App::Photos => {
            if let Some(photo) = first_title(reader, context, "photos.recent", &[]) {
                let words = lead_words(&photo, 2);
                out.push(say(
                    format!("Find photos of {words}"),
                    "photos.search",
                    &[("term", &words)],
                ));
            }
            out.push(say("Show my newest photos", "photos.recent", &[]));
        }
        App::Notes => {
            if let Some(note) = first_title(reader, context, "notes.list", &[]) {
                let words = lead_words(&note, 3);
                out.push(say(
                    format!("Find my note on {words}"),
                    "notes.search",
                    &[("term", &words)],
                ));
            }
            out.push(say("What notes did I write lately?", "notes.list", &[]));
        }
        App::Docs => {
            if let Some(doc) = first_title(reader, context, "docs.list", &[("shelf", "recent")]) {
                let words = lead_words(&doc, 3);
                out.push(say(
                    format!("Find the {words}"),
                    "docs.search",
                    &[("term", &words)],
                ));
            }
            out.push(say(
                "What documents changed lately?",
                "docs.list",
                &[("shelf", "recent")],
            ));
        }
    }
    out
}

/// The apps an unscoped chat draws from, in the order it tries them.
const OPENING_ORDER: [App; 7] = [
    App::Tasks,
    App::Agenda,
    App::Tally,
    App::People,
    App::Photos,
    App::Notes,
    App::Docs,
];

fn push_new(out: &mut Vec<Suggestion>, suggestion: Suggestion) {
    if out.len() < SUGGESTIONS && out.iter().all(|held| held.text != suggestion.text) {
        out.push(suggestion);
    }
}

/// Three suggestions: from `scope` when there is one, otherwise one each from
/// the first apps in [`OPENING_ORDER`] that hold something.
#[must_use]
pub fn suggest(
    reader: &dyn Reader,
    scope: Option<App>,
    context: &ReadContext<'_>,
) -> Vec<Suggestion> {
    let mut out = Vec::new();
    match scope {
        Some(app) => {
            for suggestion in candidates(app, reader, context) {
                push_new(&mut out, suggestion);
            }
        }
        None => {
            // One from each app first, so the three differ; then whatever is
            // left of each app's list fills any gap.
            let per_app: Vec<Vec<Suggestion>> = OPENING_ORDER
                .iter()
                .map(|app| candidates(*app, reader, context))
                .collect();
            for candidates in &per_app {
                if let Some(first) = candidates.first() {
                    push_new(&mut out, first.clone());
                }
            }
            for candidates in &per_app {
                for suggestion in candidates.iter().skip(1) {
                    push_new(&mut out, suggestion.clone());
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::result::{Card, ToolOutput};
    use crate::testing::StaticReader;

    const CTX: ReadContext<'static> = ReadContext {
        tz: "America/Los_Angeles",
    };

    fn rows(app: App, entity: &'static str, titles: &[&str]) -> ToolOutput {
        ToolOutput::of_rows(
            "rows",
            titles
                .iter()
                .enumerate()
                .map(|(n, title)| Card::new(app, entity, format!("id{n}"), *title))
                .collect(),
        )
    }

    fn texts(suggestions: &[Suggestion]) -> Vec<&str> {
        suggestions.iter().map(|s| s.text.as_str()).collect()
    }

    #[test]
    fn a_scoped_chat_offers_three_questions_from_that_app_using_its_own_rows() {
        let reader = StaticReader::new()
            .with(
                "tasks.list",
                rows(App::Tasks, "task", &["Pick up the dry cleaning"]),
            )
            .with(
                "tasks.projects",
                rows(App::Tasks, "project", &["Tahoe trip"]),
            );
        let got = suggest(&reader, Some(App::Tasks), &CTX);
        assert_eq!(
            texts(&got),
            [
                "What is due today?",
                "What is overdue?",
                "What is left in Tahoe trip?"
            ]
        );
        assert_eq!(
            got[2].call.to_json(),
            r#"{"tool":"tasks.list","args":{"project":"Tahoe trip"}}"#
        );
    }

    #[test]
    fn an_empty_app_still_offers_questions_that_need_no_data() {
        let reader = StaticReader::new();
        let got = suggest(&reader, Some(App::Tally), &CTX);
        assert_eq!(texts(&got), ["Who owes me money?"]);
    }

    #[test]
    fn spending_is_offered_for_the_month_that_has_some() {
        let spent = ToolOutput {
            headline: "Spending".to_owned(),
            facts: vec!["groceries: 1.00 USD".to_owned()],
            ..ToolOutput::default()
        };
        // The reader answers `tally.spending` the same for either month, so this
        // month is the one offered.
        let reader = StaticReader::new().with("tally.spending", spent);
        let got = suggest(&reader, Some(App::Tally), &CTX);
        assert_eq!(
            texts(&got),
            ["What have we spent this month?", "Who owes me money?"]
        );
    }

    #[test]
    fn an_unscoped_chat_takes_one_from_each_of_the_first_apps_that_have_data() {
        let reader = StaticReader::new()
            .with(
                "tasks.list",
                rows(App::Tasks, "task", &["Book dentist appointment"]),
            )
            .with(
                "agenda.upcoming",
                rows(App::Agenda, "event", &["Dinner with Maya"]),
            )
            .with("tally.balances", rows(App::Tally, "friend", &["Jake"]));
        let got = suggest(&reader, None, &CTX);
        assert_eq!(
            texts(&got),
            [
                "What is due today?",
                "What is on my calendar this week?",
                "Who owes me money?"
            ]
        );
    }

    #[test]
    fn an_empty_vault_is_offered_the_dataless_questions_without_repeats() {
        let got = suggest(&StaticReader::new(), None, &CTX);
        assert_eq!(got.len(), SUGGESTIONS);
        let mut seen: Vec<&str> = texts(&got);
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), SUGGESTIONS);
    }

    #[test]
    fn titles_become_search_terms_by_their_first_words() {
        assert_eq!(
            lead_words("Tahoe long weekend — shortlist", 3),
            "Tahoe long weekend"
        );
        assert_eq!(lead_words("  “Quoted” title!  ", 2), "Quoted title");
        assert_eq!(lead_words("—", 3), "");
        let reader = StaticReader::new().with(
            "notes.list",
            rows(App::Notes, "note", &["Tahoe long weekend — shortlist"]),
        );
        let got = suggest(&reader, Some(App::Notes), &CTX);
        assert_eq!(got[0].text, "Find my note on Tahoe long weekend");
        assert_eq!(got[0].call.arg("term"), Some("Tahoe long weekend"));
    }

    #[test]
    fn a_failing_read_offers_fewer_and_never_fails_the_chat() {
        let reader = StaticReader::new().failing("tasks.list", "the vault is closed");
        let got = suggest(&reader, Some(App::Tasks), &CTX);
        assert!(!got.is_empty());
    }

    #[test]
    fn every_suggestion_names_a_registered_call_for_every_app() {
        let reader = StaticReader::new();
        for app in App::ALL {
            for suggestion in suggest(&reader, Some(app), &CTX) {
                assert_eq!(suggestion.call.spec().app, app, "{}", suggestion.text);
            }
        }
    }

    #[test]
    fn the_same_vault_gives_the_same_suggestions() {
        let reader = StaticReader::new().with("tasks.list", rows(App::Tasks, "task", &["A"]));
        assert_eq!(suggest(&reader, None, &CTX), suggest(&reader, None, &CTX));
    }
}
