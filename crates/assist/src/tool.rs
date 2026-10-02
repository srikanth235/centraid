//! THE TOOL REGISTRY: what the model may ask the vault, and nothing else.
//!
//! One row per **read** an app already answers. A tool is a name, the app it
//! reads, and a short argument list the grammar can express — which is why an
//! argument is either a bounded piece of text or one of a closed set of words,
//! and never a date, an id or a number the model would have to compute.
//! "Tomorrow" is `range: "tomorrow"`; the executor turns it into a day.
//!
//! # THE NAMES ARE THE FINE-TUNE'S TRAINING TARGET
//!
//! A tool is spelled `<app>.<verb>`, and renaming one retrains a model. The
//! list is therefore pinned by `tests::the_tool_names_are_the_fine_tunes_targets`:
//! a change there is a change to `contracts/assist/eval-cases.json`'s export.
//!
//! # LOCKER IS NOT HERE, BY CONSTRUCTION
//!
//! [`App`] has no `Locker` variant, so no tool can name it and no scope can
//! select it. A secret that was never in a prompt cannot be in an answer.
//!
//! # READS ONLY
//!
//! A write proposal arrives later as a second kind of [`crate::call::Route`] —
//! one that parks behind a confirm card — and not as a flag on a tool here. A
//! `ToolSpec` has no `writes` field because there is nothing for it to hold.

/// An app the assistant can read. Locker is deliberately absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum App {
    Agenda,
    Docs,
    Notes,
    People,
    Photos,
    Tally,
    Tasks,
}

impl App {
    /// Every app, in registry order.
    pub const ALL: [Self; 7] = [
        Self::Agenda,
        Self::Docs,
        Self::Notes,
        Self::People,
        Self::Photos,
        Self::Tally,
        Self::Tasks,
    ];

    /// The id a shell routes by — the same word `AppRegistry` uses.
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            Self::Agenda => "agenda",
            Self::Docs => "docs",
            Self::Notes => "notes",
            Self::People => "people",
            Self::Photos => "photos",
            Self::Tally => "tally",
            Self::Tasks => "tasks",
        }
    }

    /// The app's name as a member reads it ("Looking in Tally").
    #[must_use]
    pub const fn display(self) -> &'static str {
        match self {
            Self::Agenda => "Agenda",
            Self::Docs => "Docs",
            Self::Notes => "Notes",
            Self::People => "People",
            Self::Photos => "Photos",
            Self::Tally => "Tally",
            Self::Tasks => "Tasks",
        }
    }

    /// The app a shell named, or `None` — which includes `locker`.
    #[must_use]
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|app| app.id() == id)
    }
}

/// What an argument's value may be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArgKind {
    /// A bounded piece of the member's own words: a search term, a project or
    /// notebook name. One line, at most [`TEXT_MAX`] characters.
    Text,
    /// One of a closed set. The grammar makes any other word unsayable.
    Choice(&'static [&'static str]),
}

/// The longest text argument, in characters. The grammar states the same
/// number, so a longer one cannot be generated and is refused if it is parsed.
pub const TEXT_MAX: usize = 80;

/// One argument of one tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArgSpec {
    pub name: &'static str,
    pub kind: ArgKind,
    pub required: bool,
}

/// One tool: a read the model may name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolSpec {
    pub name: &'static str,
    pub app: App,
    /// What it answers, in the words the prompt's tool list uses.
    pub doc: &'static str,
    /// A longer description for a stock model, which reads nothing but the
    /// prompt: it says what the tool is *for* in the member's words (a
    /// calendar's "events, appointments and meetings", a task view's meaning)
    /// where `doc` is a label. A fine-tuned model has learned the tool and is
    /// shown `doc` alone ([`crate::prompt::PromptStyle`]).
    pub hint: &'static str,
    /// Required arguments first, then optional ones — the canonical order the
    /// grammar and [`crate::call::ToolCall::to_json`] both follow.
    pub args: &'static [ArgSpec],
}

impl ToolSpec {
    /// The argument spec named `name`.
    #[must_use]
    pub fn arg(&self, name: &str) -> Option<&'static ArgSpec> {
        self.args.iter().find(|arg| arg.name == name)
    }

    /// `tasks.list(view?: today|upcoming, project?: text)` — one line of the
    /// prompt's tool list.
    #[must_use]
    pub fn signature(&self) -> String {
        let args = self
            .args
            .iter()
            .map(|arg| {
                let kind = match arg.kind {
                    ArgKind::Text => "text".to_owned(),
                    ArgKind::Choice(words) => words.join("|"),
                };
                format!(
                    "{}{}: {kind}",
                    arg.name,
                    if arg.required { "" } else { "?" }
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("{}({args})", self.name)
    }
}

const fn term() -> ArgSpec {
    ArgSpec {
        name: "term",
        kind: ArgKind::Text,
        required: true,
    }
}

const fn choice(name: &'static str, words: &'static [&'static str]) -> ArgSpec {
    ArgSpec {
        name,
        kind: ArgKind::Choice(words),
        required: false,
    }
}

const fn optional_text(name: &'static str) -> ArgSpec {
    ArgSpec {
        name,
        kind: ArgKind::Text,
        required: false,
    }
}

/// The doc types `docs.list` filters by, spelled as the Docs drive's filter.
pub const DOC_TYPES: &[&str] = &[
    "pdf",
    "image",
    "word",
    "spreadsheet",
    "markdown",
    "text",
    "audio",
    "video",
];

/// Every tool, in registry order (apps alphabetical, then verbs).
pub const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "agenda.upcoming",
        app: App::Agenda,
        doc: "calendar events for a day or the week",
        hint: "the calendar: events, appointments and meetings on a day or in the next seven days",
        args: &[choice("range", &["today", "tomorrow", "week"])],
    },
    ToolSpec {
        name: "agenda.search",
        app: App::Agenda,
        doc: "find calendar events by words",
        hint: "find an event by its name or topic",
        args: &[term()],
    },
    ToolSpec {
        name: "docs.list",
        app: App::Docs,
        doc: "documents, newest first",
        hint: "files and documents; shelf recent is the default, starred are favourites; type narrows to one kind of file",
        args: &[
            choice("shelf", &["recent", "starred", "all"]),
            choice("type", DOC_TYPES),
        ],
    },
    ToolSpec {
        name: "docs.search",
        app: App::Docs,
        doc: "find documents by words",
        hint: "find a document or file by name or topic",
        args: &[term()],
    },
    ToolSpec {
        name: "notes.list",
        app: App::Notes,
        doc: "recent notes, or one notebook's notes",
        hint: "recent notes, or the notes in one notebook",
        args: &[optional_text("notebook")],
    },
    ToolSpec {
        name: "notes.search",
        app: App::Notes,
        doc: "find notes by words",
        hint: "find a note by what it says",
        args: &[term()],
    },
    ToolSpec {
        name: "people.list",
        app: App::People,
        doc: "the people in the circle; due means overdue for a catch-up",
        hint: "the people in the circle (contacts, friends, family); due = a catch-up is due",
        args: &[choice("filter", &["all", "starred", "due"])],
    },
    ToolSpec {
        name: "people.search",
        app: App::People,
        doc: "find a person by name",
        hint: "look up one person by name",
        args: &[term()],
    },
    ToolSpec {
        name: "people.reconnect",
        app: App::People,
        doc: "who to get in touch with, and upcoming dates",
        hint: "who to get back in touch with, and upcoming birthdays and dates",
        args: &[],
    },
    ToolSpec {
        name: "photos.recent",
        app: App::Photos,
        doc: "the newest photographs",
        hint: "the newest photographs",
        args: &[],
    },
    ToolSpec {
        name: "photos.search",
        app: App::Photos,
        doc: "find photographs by title, label, album or place",
        hint: "find photographs by a person, place, album or label",
        args: &[term()],
    },
    ToolSpec {
        name: "tally.balances",
        app: App::Tally,
        doc: "who owes whom",
        hint: "who owes whom in the shared expenses",
        args: &[],
    },
    ToolSpec {
        name: "tally.recent",
        app: App::Tally,
        doc: "the latest expenses",
        hint: "the latest shared expenses",
        args: &[],
    },
    ToolSpec {
        name: "tally.search",
        app: App::Tally,
        doc: "find expenses by words",
        hint: "find expenses by what they were for",
        args: &[term()],
    },
    ToolSpec {
        name: "tally.spending",
        app: App::Tally,
        doc: "spending by category for a month",
        hint: "total spending by category for this month or last month",
        args: &[choice("month", &["this", "last"])],
    },
    ToolSpec {
        name: "tasks.list",
        app: App::Tasks,
        doc: "tasks by view or project",
        hint: "the to-do list: what is due today, overdue, upcoming, in the inbox, undated (anytime) or done; or one project's tasks",
        args: &[
            choice(
                "view",
                &["today", "upcoming", "overdue", "inbox", "anytime", "done"],
            ),
            optional_text("project"),
        ],
    },
    ToolSpec {
        name: "tasks.search",
        app: App::Tasks,
        doc: "find tasks by words",
        hint: "find a to-do by what it says",
        args: &[term()],
    },
    ToolSpec {
        name: "tasks.projects",
        app: App::Tasks,
        doc: "projects and how many tasks are open in each",
        hint: "the projects and how many tasks are open in each",
        args: &[],
    },
];

/// The tool named `name`.
#[must_use]
pub fn tool(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|spec| spec.name == name)
}

/// The tools a prompt offers, in the order it lists them.
///
/// Order is meaning: a small model leans on what it reads first, so a chat
/// opened from an app lists that app's tools first. The grammar is generated
/// from the same list, so a tool the budget dropped is also unsayable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolSet {
    tools: Vec<&'static ToolSpec>,
}

impl ToolSet {
    /// Every tool, the scoped app's first.
    #[must_use]
    pub fn for_scope(scope: Option<App>) -> Self {
        let mut tools: Vec<&'static ToolSpec> = TOOLS.iter().collect();
        if let Some(app) = scope {
            // A stable partition: the scoped app's tools keep registry order and
            // so do the rest.
            tools.sort_by_key(|spec| spec.app != app);
        }
        Self { tools }
    }

    /// The tools, in prompt order.
    pub fn iter(&self) -> impl Iterator<Item = &'static ToolSpec> + '_ {
        self.tools.iter().copied()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.tools.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    /// Whether `name` is offered.
    #[must_use]
    pub fn contains(&self, name: &str) -> bool {
        self.tools.iter().any(|spec| spec.name == name)
    }

    /// Drop the last tool, if more than `floor` remain. The budget's lever.
    pub fn drop_last(&mut self, floor: usize) -> bool {
        if self.tools.len() > floor.max(1) {
            self.tools.pop();
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tool_names_are_the_fine_tunes_targets() {
        let names: Vec<&str> = TOOLS.iter().map(|spec| spec.name).collect();
        assert_eq!(
            names,
            [
                "agenda.upcoming",
                "agenda.search",
                "docs.list",
                "docs.search",
                "notes.list",
                "notes.search",
                "people.list",
                "people.search",
                "people.reconnect",
                "photos.recent",
                "photos.search",
                "tally.balances",
                "tally.recent",
                "tally.search",
                "tally.spending",
                "tasks.list",
                "tasks.search",
                "tasks.projects",
            ]
        );
    }

    #[test]
    fn locker_is_in_no_tool_and_in_no_scope() {
        assert!(App::from_id("locker").is_none());
        assert!(TOOLS.iter().all(|spec| !spec.name.contains("locker")));
        assert!(TOOLS.iter().all(|spec| spec.app.id() != "locker"));
    }

    #[test]
    fn a_tool_is_named_app_dot_verb_and_its_app_prefix_is_its_app() {
        for spec in TOOLS {
            let (app, verb) = spec.name.split_once('.').expect("app.verb");
            assert_eq!(app, spec.app.id(), "{}", spec.name);
            assert!(!verb.is_empty() && verb.chars().all(|c| c.is_ascii_lowercase()));
        }
    }

    #[test]
    fn required_arguments_come_before_optional_ones() {
        for spec in TOOLS {
            let first_optional = spec.args.iter().position(|arg| !arg.required);
            if let Some(at) = first_optional {
                assert!(
                    spec.args[at..].iter().all(|arg| !arg.required),
                    "{} lists a required argument after an optional one",
                    spec.name
                );
            }
        }
    }

    #[test]
    fn names_are_unique() {
        let mut names: Vec<&str> = TOOLS.iter().map(|spec| spec.name).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len());
    }

    #[test]
    fn a_scoped_set_lists_that_apps_tools_first_and_keeps_every_tool() {
        let set = ToolSet::for_scope(Some(App::Tally));
        let names: Vec<&str> = set.iter().map(|spec| spec.name).collect();
        assert_eq!(
            &names[..4],
            [
                "tally.balances",
                "tally.recent",
                "tally.search",
                "tally.spending"
            ]
        );
        assert_eq!(names.len(), TOOLS.len());
        assert_eq!(names[4], "agenda.upcoming", "the rest keep registry order");
    }

    #[test]
    fn a_signature_states_optional_arguments_with_a_question_mark() {
        assert_eq!(
            tool("tasks.list").unwrap().signature(),
            "tasks.list(view?: today|upcoming|overdue|inbox|anytime|done, project?: text)"
        );
        assert_eq!(
            tool("people.reconnect").unwrap().signature(),
            "people.reconnect()"
        );
        assert_eq!(
            tool("notes.search").unwrap().signature(),
            "notes.search(term: text)"
        );
    }
}
