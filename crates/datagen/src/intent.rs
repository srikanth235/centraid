//! STAGE 2, THE TYPES: what a turn of a session is for, before any words are written.
//!
//! An [`Intent`] is the meaning of one user turn in the vocabulary of the vault: which rows, by
//! which constraints, to read, count, measure, compare or change. A [`Scenario`] is a session's
//! turns, each saying which earlier turn it leans on. Nothing here is text; M3 writes the user's
//! message from it, and the planner (`plan`) writes the reference calls from it.

use jiff::civil::Date;
use serde::{Deserialize, Serialize};

/// How a turn points at the rows it is about (a grid axis).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reference {
    /// No row is named: filters select.
    Select,
    Name,
    Nickname,
    /// "it", "that", "them": the rows of the turn before.
    Pronoun,
    /// An earlier result by its `@k`, not the turn before's.
    Handle,
    Misspelling,
}

impl Reference {
    pub const ALL: [Self; 6] = [
        Self::Select,
        Self::Name,
        Self::Nickname,
        Self::Pronoun,
        Self::Handle,
        Self::Misspelling,
    ];

    #[must_use]
    pub const fn word(self) -> &'static str {
        match self {
            Self::Select => "select",
            Self::Name => "name",
            Self::Nickname => "nickname",
            Self::Pronoun => "pronoun",
            Self::Handle => "handle",
            Self::Misspelling => "misspelling",
        }
    }
}

/// What the turn comes to (a grid axis).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Done,
    /// A well-formed request that finds nothing.
    Empty,
    Ask,
    Decline,
    /// A first call the runtime refuses and the repair that follows it.
    Repair,
}

impl Outcome {
    pub const ALL: [Self; 5] = [
        Self::Done,
        Self::Empty,
        Self::Ask,
        Self::Decline,
        Self::Repair,
    ];

    #[must_use]
    pub const fn word(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Empty => "empty",
            Self::Ask => "ask",
            Self::Decline => "decline",
            Self::Repair => "repair",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Span {
    Single,
    Across,
}

impl Span {
    #[must_use]
    pub const fn word(self) -> &'static str {
        match self {
            Self::Single => "single",
            Self::Across => "across",
        }
    }
}

/// How a later turn leans on an earlier one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Dep {
    /// Acts on the rows the turn before showed ("complete it").
    Pronoun,
    /// Acts on, or narrows to, an earlier result by its handle.
    Handle,
    /// Narrows the turn before's rows with more constraints ("only the open ones").
    Narrow,
    /// Asks the same thing of the turn before's subject over another period ("and last month?").
    Carry,
    /// Undoes the turn before's write.
    Undo,
}

/// A period relative to today, or an explicit span. Weeks run Monday to Sunday.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "unit", rename_all = "snake_case")]
pub enum Period {
    Day { rel: i64 },
    Week { rel: i64 },
    Month { rel: i64 },
    Between { from: String, to: String },
}

impl Period {
    /// The `when` argument as the model writes it.
    #[must_use]
    pub fn when(&self) -> String {
        match self {
            Self::Day { rel } => format!(r#"{{"unit":"day","rel":{rel}}}"#),
            Self::Week { rel } => format!(r#"{{"unit":"week","rel":{rel}}}"#),
            Self::Month { rel } => format!(r#"{{"unit":"month","rel":{rel}}}"#),
            Self::Between { from, to } => {
                format!(r#"{{"from":{{"date":"{from}"}},"to":{{"date":"{to}"}}}}"#)
            }
        }
    }

    /// The days it covers, both ends included.
    #[must_use]
    pub fn range(&self, today: Date) -> Option<(Date, Date)> {
        match self {
            Self::Day { rel } => {
                let day = today.checked_add(jiff::Span::new().days(*rel)).ok()?;
                Some((day, day))
            }
            Self::Week { rel } => {
                let monday = today
                    .checked_sub(
                        jiff::Span::new().days(i64::from(today.weekday().to_monday_zero_offset())),
                    )
                    .ok()?;
                let start = monday.checked_add(jiff::Span::new().weeks(*rel)).ok()?;
                Some((start, start.checked_add(jiff::Span::new().days(6)).ok()?))
            }
            Self::Month { rel } => {
                let first = today.first_of_month();
                let start = first.checked_add(jiff::Span::new().months(*rel)).ok()?;
                Some((start, start.last_of_month()))
            }
            Self::Between { from, to } => Some((from.parse().ok()?, to.parse().ok()?)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cmp {
    Eq,
    Lt,
    Le,
    Gt,
    Ge,
}

impl Cmp {
    #[must_use]
    pub const fn symbol(self) -> &'static str {
        match self {
            Self::Eq => "=",
            Self::Lt => "<",
            Self::Le => "<=",
            Self::Gt => ">",
            Self::Ge => ">=",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lit {
    Text(String),
    Num(f64),
    Flag(bool),
}

impl Lit {
    /// The value as the `where` and `args` lines write it.
    #[must_use]
    pub fn render(&self) -> String {
        match self {
            Self::Text(text) => format!("\"{text}\""),
            Self::Num(n) => number(*n),
            Self::Flag(true) => "yes".to_owned(),
            Self::Flag(false) => "no".to_owned(),
        }
    }
}

/// `5` for 5.0, `-12.5` for -12.5.
#[must_use]
pub fn number(n: f64) -> String {
    if (n - n.round()).abs() < 1e-9 {
        format!("{}", n.round() as i64)
    } else {
        format!("{n}")
    }
}

/// One `where` clause: `field op value`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Filter {
    pub field: String,
    pub cmp: Cmp,
    pub value: Lit,
}

impl Filter {
    #[must_use]
    pub fn clause(&self) -> String {
        format!(
            "{} {} {}",
            self.field,
            self.cmp.symbol(),
            self.value.render()
        )
    }
}

/// A container or person a selector is linked to (`linked_to`), found by name first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Link {
    pub kind: String,
    pub key: String,
    pub name: String,
}

/// Which rows: a kind, its constraints, and optionally the earlier result it narrows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Selector {
    pub kind: String,
    /// The row's exact name (`name=`): a workout called "Run", a budget "Groceries 2026-09".
    pub name: Option<String>,
    pub filters: Vec<Filter>,
    pub period: Option<Period>,
    /// A row (found by name first) the period is read off: "during the Lisbon trip". Its days are
    /// written into `period` as an explicit span; the user's words name the row instead.
    pub anchor: Option<Link>,
    pub link: Option<Link>,
    /// `(field, descending)`.
    pub order: Option<(String, bool)>,
    pub limit: Option<usize>,
    /// The earlier turn whose result this narrows (`within=@k`).
    pub within: Option<usize>,
}

impl Selector {
    #[must_use]
    pub fn of(kind: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            name: None,
            filters: Vec::new(),
            period: None,
            anchor: None,
            link: None,
            order: None,
            limit: None,
            within: None,
        }
    }
}

/// A sum, average, minimum or maximum of a number field over a selection, optionally grouped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Measure {
    pub sel: Selector,
    /// `sum` | `avg` | `min` | `max`.
    pub op: String,
    pub field: String,
    /// A field, or a period of the date: `day` | `week` | `month` | `year`.
    pub group: Option<String>,
}

/// Which row a write is about.
// A scenario holds a handful of these, so the size of its largest variant costs nothing.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "by", rename_all = "snake_case")]
pub enum Target {
    /// A row said by its name (or nickname, or a misspelling of it): `find` then act.
    Name {
        kind: String,
        name: String,
        key: String,
        trashed: bool,
    },
    /// Rows a selection picks.
    Select { sel: Selector },
    /// The rows of an earlier turn's result.
    Turn { turn: usize, kind: String },
}

/// A value for a field of a row being made or changed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "as", content = "value", rename_all = "snake_case")]
pub enum Val {
    Text(String),
    Num(f64),
    Flag(bool),
    /// A date expression, as `when` writes it.
    When(String),
}

impl Val {
    #[must_use]
    pub fn render(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Num(n) => number(*n),
            Self::Flag(true) => "yes".to_owned(),
            Self::Flag(false) => "no".to_owned(),
            Self::When(json) => json.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub field: String,
    pub value: Val,
}

/// The one argument a `do` verb takes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "as", content = "value", rename_all = "snake_case")]
pub enum VerbArg {
    None,
    /// `reschedule`: a date expression.
    When(String),
    /// `add_to`, `remove_from`: a container, found by name first.
    Container(Link),
    /// `log`: one of the fixed choices.
    Choice(String),
}

// As for `Target`: a handful per scenario.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "intent", rename_all = "snake_case")]
pub enum Intent {
    /// `find` then `answer rows=@k`.
    Read { sel: Selector },
    /// `compute count` then `answer value=@k`.
    Count { sel: Selector },
    /// `compute sum|avg|min|max` (optionally `group`) then `answer value=@k`.
    Measure { measure: Measure },
    /// Two values already computed, set side by side: `compute` twice, `compute op=compare`, then
    /// `answer value=@k`.
    Compare { a: Measure, b: Measure },
    /// `find` then `do verb rows=@k`.
    Write {
        target: Target,
        verb: String,
        arg: VerbArg,
    },
    /// `find` then `edit rows=@k`.
    Edit {
        target: Target,
        changes: Vec<Change>,
    },
    /// `create kind args`.
    Create { kind: String, fields: Vec<Change> },
    /// `answer rows=@k` or `answer value=@k` of an earlier turn's result.
    Recall { turn: usize, value: bool },
    /// A name that more than one row answers to: `find`, then `ask`.
    Ask {
        kind: String,
        name: String,
        /// The verb the user wanted done, if it was a write.
        verb: Option<String>,
    },
    /// `decline`.
    Decline { reason: String },
}

/// One turn: what it is for, how it points at rows, how it ends, what it leans on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnIntent {
    pub intent: Intent,
    pub reference: Reference,
    pub outcome: Outcome,
    pub dep: Option<(usize, Dep)>,
    /// The apps this turn reads or changes, sorted.
    pub apps: Vec<String>,
}

/// A session's intents, before any words.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Scenario {
    pub id: String,
    pub world: String,
    pub span: Span,
    pub turns: Vec<TurnIntent>,
    /// `pair:<id>` on the two scenarios of a minimal pair.
    #[serde(default)]
    pub tags: Vec<String>,
}
