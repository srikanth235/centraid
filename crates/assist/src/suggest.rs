//! SUGGESTED PROMPTS: three questions the assistant can answer.
//!
//! An empty thread would be a blank wall, so the chat offers three starting points. Opened from
//! an app, all three come from that app. Every suggestion is a question the native plane answers
//! by READING (`find`, `search`, `compute`), never one that would write; the date words in them
//! (`today`, `tomorrow`, `this week`) are ones the runtime resolves itself
//! (`native::phrases::dates_line`).
//!
//! Deterministic: the same scope gives the same three, in the same order.

use crate::app::App;
use crate::native::door::Door;

/// How many suggestions the chat offers.
pub const SUGGESTIONS: usize = 3;

/// A question to offer, and the app it is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestion {
    pub app: App,
    pub text: String,
}

fn say(app: App, text: &str) -> Suggestion {
    Suggestion {
        app,
        text: text.to_owned(),
    }
}

/// Every question an app offers, in the order it offers them.
fn candidates(app: App) -> Vec<Suggestion> {
    let questions: [&str; 3] = match app {
        App::Reminders => [
            "What is due today?",
            "What is coming up?",
            "What is overdue?",
        ],
        App::Calendar => [
            "What is on my calendar this week?",
            "What is on tomorrow?",
            "What is on today?",
        ],
        App::People => [
            "Who is in my circle?",
            "Who did I talk to lately?",
            "Who have I starred?",
        ],
        App::Photos => [
            "Show my newest photos",
            "What albums do I have?",
            "Which photos are starred?",
        ],
        App::Notes => [
            "What notes did I write lately?",
            "What notebooks do I have?",
            "Which notes are starred?",
        ],
        App::Money => [
            "What did I spend this month?",
            "What was my biggest expense this month?",
            "What came in this month?",
        ],
        App::Health => [
            "How did I sleep this week?",
            "How many steps did I take today?",
            "What workouts did I do lately?",
        ],
        App::Locker => [
            "What is in my Locker?",
            "Which logins do I have saved?",
            "Which Locker items are starred?",
        ],
        App::Docs => [
            "What documents changed lately?",
            "What folders do I have?",
            "Which documents are starred?",
        ],
    };
    questions
        .into_iter()
        .map(|question| say(app, question))
        .collect()
}

/// The apps an unscoped chat draws from, in the order it tries them.
const OPENING_ORDER: [App; 6] = [
    App::Reminders,
    App::Calendar,
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

/// Three suggestions: from `scope` when there is one, otherwise one each from the apps in
/// [`OPENING_ORDER`], then whatever is left of each app's list.
#[must_use]
pub fn suggest_in(scope: Option<App>) -> Vec<Suggestion> {
    let mut out = Vec::new();
    match scope {
        Some(app) => {
            for suggestion in candidates(app) {
                push_new(&mut out, suggestion);
            }
        }
        None => {
            let per_app: Vec<Vec<Suggestion>> =
                OPENING_ORDER.iter().map(|app| candidates(*app)).collect();
            for list in &per_app {
                if let Some(first) = list.first() {
                    push_new(&mut out, first.clone());
                }
            }
            for list in &per_app {
                for suggestion in list.iter().skip(1) {
                    push_new(&mut out, suggestion.clone());
                }
            }
        }
    }
    out
}

/// Three suggestions for a chat opened in `scope`. The door is not read: no suggestion names a
/// row.
#[must_use]
pub fn suggest(door: &dyn Door, tz: &str, scope: Option<App>) -> Vec<Suggestion> {
    let _ = (door, tz);
    suggest_in(scope)
}
