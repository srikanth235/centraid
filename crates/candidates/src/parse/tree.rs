//! The canonical tree this parser emits, and its rendering to the CANONICAL
//! STRING of `crates/evalsuite/grammar/GRAMMAR.md` §1.
//!
//! The string is the join point with the rest of the candidate crate and with
//! `grammar/check.py`, which is the authority on whether a canonical is legal.
//! Rendering is deliberately over-parenthesised where the grammar allows both:
//! `check.py` parses either, and the map's trees — not its spelling — are what
//! a score is computed against.

use std::fmt;

#[derive(Clone, Debug, PartialEq)]
pub enum Window {
    /// A named phrase (`this week`, `before now`, `recently`).
    Phrase(String),
    /// A literal date, month, datetime or range, rendered bare.
    Date(String),
    /// `next N days|weeks|months`.
    Rolling(u32, String),
    /// `from (Value) to (Value)` — the anchored window (GRAMMAR.md §2.6).
    Anchored(Box<Value>, Box<Value>),
}

impl fmt::Display for Window {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Window::Phrase(p) => write!(f, "{p}"),
            Window::Date(d) => write!(f, "{d}"),
            Window::Rolling(n, unit) => write!(f, "next {n} {unit}"),
            Window::Anchored(a, b) => write!(f, "from ({a}) to ({b})"),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Operand {
    /// Already rendered: a quoted literal, a number, a date, or a keyword.
    Lit(String),
    Set(Box<Set>),
    Field(String),
}

impl fmt::Display for Operand {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Operand::Lit(raw) => write!(f, "{raw}"),
            Operand::Set(set) => write!(f, "({set})"),
            Operand::Field(field) => write!(f, "{field}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Pred {
    Cmp(String, String, Operand),
    Contains(String, String),
    OneOf(String, Vec<String>),
    During(String, Window),
    Band(String, f64),
    Is {
        field: String,
        what: String,
        negated: bool,
    },
    Member(Box<Set>),
    And(Box<Pred>, Box<Pred>),
    Or(Box<Pred>, Box<Pred>),
    Not(Box<Pred>),
}

impl fmt::Display for Pred {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Pred::Cmp(field, op, rhs) => write!(f, "{field} {op} {rhs}"),
            Pred::Contains(field, lit) => write!(f, "{field} contains {}", quote(lit)),
            Pred::OneOf(field, lits) => {
                let items: Vec<String> = lits.iter().map(|l| quote(l)).collect();
                write!(f, "{field} in ({})", items.join(", "))
            }
            Pred::During(field, window) => write!(f, "{field} during {window}"),
            Pred::Band(field, centre) => write!(f, "{field} around {centre}"),
            Pred::Is {
                field,
                what,
                negated,
            } => {
                write!(f, "{field} is {}{what}", if *negated { "not " } else { "" })
            }
            Pred::Member(set) => write!(f, "member of ({set})"),
            Pred::And(l, r) => write!(f, "{l} and {r}"),
            Pred::Or(l, r) => write!(f, "{l} or {r}"),
            Pred::Not(p) => write!(f, "not {p}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Set {
    Kind(String),
    Walk {
        kind: String,
        from: Box<Set>,
    },
    Called(Box<Set>, String),
    Filter(Box<Set>, Pred),
    During(Box<Set>, Window),
    Order {
        set: Box<Set>,
        field: String,
        desc: bool,
    },
    Union(Box<Set>, Box<Set>),
    Except(Box<Set>, Box<Set>),
    First(u32, Box<Set>),
    Ref(String),
}

impl fmt::Display for Set {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Set::Kind(kind) => write!(f, "{kind}"),
            Set::Walk { kind, from } => write!(f, "{kind} of ({from})"),
            Set::Called(set, lit) => write!(f, "{set} called {}", quote(lit)),
            Set::Filter(set, pred) => write!(f, "{set} that ({pred})"),
            Set::During(set, window) => write!(f, "{set} during {window}"),
            Set::Order { set, field, desc } => {
                write!(
                    f,
                    "{set} ordered by {field} {}",
                    if *desc { "desc" } else { "asc" }
                )
            }
            Set::Union(l, r) => write!(f, "({l}) and ({r})"),
            Set::Except(l, r) => write!(f, "({l}) except ({r})"),
            Set::First(n, set) => write!(f, "first {n} of ({set})"),
            Set::Ref(name) => write!(f, "{name}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Count(Box<Set>),
    Fold {
        agg: String,
        field: String,
        set: Box<Set>,
    },
    Project {
        field: String,
        set: Box<Set>,
    },
    Balance {
        of: Box<Set>,
        in_group: Box<Set>,
    },
}

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Value::Count(set) => write!(f, "count of ({set})"),
            Value::Fold { agg, field, set } => write!(f, "{agg} {field} of ({set})"),
            Value::Project { field, set } => write!(f, "{field} of ({set})"),
            Value::Balance { of, in_group } => write!(f, "balance of ({of}) in ({in_group})"),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ArgVal {
    /// Already rendered: a quoted literal, a date, a number, a duration, a keyword.
    Lit(String),
    Set(Set),
    Value(Value),
}

impl fmt::Display for ArgVal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ArgVal::Lit(raw) => write!(f, "{raw}"),
            ArgVal::Set(set) => write!(f, "({set})"),
            ArgVal::Value(value) => write!(f, "{value}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Turn {
    Show(Set),
    Same(Set, Set),
    Value(Value),
    Cmd {
        verb: String,
        args: Vec<(String, ArgVal)>,
        on: Option<Set>,
    },
    Nothing,
    Refuse(String),
}

impl fmt::Display for Turn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Turn::Show(set) => write!(f, "show ({set})"),
            Turn::Same(l, r) => write!(f, "same? ({l}) ({r})"),
            Turn::Value(value) => write!(f, "{value}"),
            Turn::Nothing => write!(f, "nothing"),
            Turn::Refuse(reason) => write!(f, "refuse: {reason}"),
            Turn::Cmd { verb, args, on } => {
                let body: Vec<String> = args.iter().map(|(k, v)| format!("{k}: {v}")).collect();
                write!(f, "{verb}{{{}}}", body.join(", "))?;
                if let Some(set) = on {
                    write!(f, " on ({set})")?;
                }
                Ok(())
            }
        }
    }
}

/// The canonical STRING — the only thing this lane promises to other lanes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Canonical(pub String);

impl From<&Turn> for Canonical {
    fn from(turn: &Turn) -> Self {
        Canonical(turn.to_string())
    }
}

impl fmt::Display for Canonical {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Why a sentence produced nothing. An abstention is a first-class answer:
/// a guessed canonical is worse than none (brief, (d)).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unparsed {
    pub reason: String,
}

impl Unparsed {
    pub fn new(reason: impl Into<String>) -> Self {
        Unparsed {
            reason: reason.into(),
        }
    }
}

pub fn quote(literal: &str) -> String {
    format!("\"{}\"", literal.replace('\\', "\\\\").replace('"', "\\\""))
}

impl Set {
    /// Replace the literal of the OUTERMOST `called` node — the edit a
    /// `substitute` move makes (GRAMMAR.md §3).
    pub fn substitute_label(&mut self, replacement: &str) -> bool {
        match self {
            Set::Called(_, lit) => {
                *lit = replacement.to_string();
                true
            }
            Set::Walk { from, .. } => from.substitute_label(replacement),
            Set::Filter(set, _)
            | Set::During(set, _)
            | Set::Order { set, .. }
            | Set::First(_, set) => set.substitute_label(replacement),
            Set::Union(l, r) | Set::Except(l, r) => {
                l.substitute_label(replacement) || r.substitute_label(replacement)
            }
            Set::Kind(_) | Set::Ref(_) => false,
        }
    }

    /// The Kind this set is ultimately OF — what a follow-up inherits when it
    /// names no noun of its own (DEFECTS.md, the `s06`/t2 ruling).
    pub fn head_kind(&self) -> Option<&str> {
        match self {
            Set::Kind(kind) | Set::Walk { kind, .. } => Some(kind),
            Set::Called(set, _)
            | Set::Filter(set, _)
            | Set::During(set, _)
            | Set::Order { set, .. }
            | Set::First(_, set) => set.head_kind(),
            Set::Union(l, _) | Set::Except(l, _) => l.head_kind(),
            Set::Ref(_) => None,
        }
    }
}

impl Turn {
    /// The set a follow-up refers back to.
    pub fn held_set(&self) -> Option<&Set> {
        match self {
            Turn::Show(set) => Some(set),
            Turn::Value(Value::Count(set))
            | Turn::Value(Value::Fold { set, .. })
            | Turn::Value(Value::Project { set, .. }) => Some(set),
            Turn::Value(Value::Balance { of, .. }) => Some(of),
            Turn::Cmd { on: Some(set), .. } => Some(set),
            _ => None,
        }
    }
}
