//! STAGE 4, THE BRIEF: a typed turn put into plain English for the writer.
//!
//! The writer is told what a turn is for in the vocabulary of the vault (never a tool call), which
//! words it must say verbatim (the free-text spans the reference calls copy: names, titles, notes)
//! and how the turn points at what it is about (the reference axis and the dependency on an
//! earlier turn). Nothing here reads a world value that is sealed: a world is presence-only.

use jiff::civil::Date;
use serde_json::Value;

use crate::catalog::Catalog;
use crate::intent::{
    Change, Dep, Filter, Intent, Link, Measure, Outcome, Period, Reference, Selector, Target,
    TurnIntent, Val, VerbArg, number,
};
use crate::plan::NOT_FOUND_NAME;

/// What the writer is told about one turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnBrief {
    /// What the turn asks of the app.
    pub ask: String,
    /// Words the message must contain, as written (compared without case).
    pub spans: Vec<String>,
    /// How the turn points at its rows and which earlier turn it leans on.
    pub how: String,
    /// The secrets the member types in the turn (a password, a card number, the text of a secret note): made-up values the
    /// writer must say as given, each also one of `spans`. Never a value a vault stores.
    pub typed: Vec<String>,
}

pub struct Briefer<'a> {
    pub catalog: &'a Catalog,
    pub today: Date,
}

fn when_phrase(period: &Period, today: Date) -> String {
    let dates = |from: Date, to: Date| {
        if from == to {
            format!("{} {}", from.strftime("%a"), from.strftime("%b %-d"))
        } else {
            format!("{} to {}", from.strftime("%b %-d"), to.strftime("%b %-d"))
        }
    };
    let range = period.range(today);
    match (period, range) {
        (Period::Day { rel: 0 }, _) => "today".to_owned(),
        (Period::Day { rel: -1 }, _) => "yesterday".to_owned(),
        (Period::Day { rel: 1 }, _) => "tomorrow".to_owned(),
        (Period::Day { rel }, Some((d, _))) => {
            format!(
                "{} days {} ({})",
                rel.abs(),
                if *rel < 0 { "ago" } else { "from today" },
                dates(d, d)
            )
        }
        (Period::Week { rel: 0 }, _) => "this week".to_owned(),
        (Period::Week { rel: -1 }, _) => "last week".to_owned(),
        (Period::Week { rel: 1 }, _) => "next week".to_owned(),
        (Period::Week { rel }, Some((a, b))) => format!(
            "the week {} weeks {} ({})",
            rel.abs(),
            if *rel < 0 { "ago" } else { "ahead" },
            dates(a, b)
        ),
        (Period::Month { rel: 0 }, _) => "this month".to_owned(),
        (Period::Month { rel: -1 }, _) => "last month".to_owned(),
        (Period::Month { rel: 1 }, _) => "next month".to_owned(),
        (Period::Month { rel }, Some((a, _))) => format!(
            "{} months {} ({})",
            rel.abs(),
            if *rel < 0 { "ago" } else { "ahead" },
            a.strftime("%B %Y")
        ),
        (Period::Weekday { rel, .. }, Some((d, _))) => {
            let day = d.strftime("%A");
            match rel {
                0 => format!("{day} this week"),
                -1 => format!("{day} last week"),
                1 => format!("{day} next week"),
                _ => format!(
                    "{day} of the week {} weeks {} ({})",
                    rel.abs(),
                    if *rel < 0 { "ago" } else { "ahead" },
                    dates(d, d)
                ),
            }
        }
        (Period::NamedMonth { rel, .. }, Some((a, _))) => {
            let month = a.strftime("%B");
            let year = a.strftime("%B %Y");
            match rel {
                0 => format!("{month} of this year ({year})"),
                -1 => format!("last {month} ({year})"),
                1 => format!("next {month} ({year})"),
                _ => format!("{month} ({year})"),
            }
        }
        (Period::Clock { rel, time }, _) => {
            format!(
                "{} at {time}",
                when_phrase(&Period::Day { rel: *rel }, today)
            )
        }
        (Period::Date { .. }, Some((d, _))) => d.strftime("%B %-d, %Y").to_string(),
        (Period::Open { from, to }, _) => {
            let end = |p: &Option<Box<Period>>| p.as_ref().map(|p| when_phrase(p, today));
            match (end(from), end(to)) {
                (Some(from), None) => format!("on or after {from} (no end date)"),
                (None, Some(to)) => format!("on or before {to} (no start date)"),
                (Some(from), Some(to)) => format!("from {from} to {to}"),
                (None, None) => "a period".to_owned(),
            }
        }
        (Period::Between { .. }, Some((a, b))) => {
            format!(
                "from {} through {}",
                a.strftime("%B %-d"),
                b.strftime("%B %-d")
            )
        }
        _ => "a period".to_owned(),
    }
}

fn cmp_words(filter: &Filter) -> &'static str {
    use crate::intent::Cmp;
    match filter.cmp {
        Cmp::Eq => "is",
        Cmp::Ne => "is not",
        Cmp::Lt => "is below",
        Cmp::Le => "is at most",
        Cmp::Gt => "is above",
        Cmp::Ge => "is at least",
        Cmp::In => "is one of",
        Cmp::IsEmpty => "is empty",
        Cmp::IsSet => "is set",
    }
}

impl Briefer<'_> {
    fn plural(&self, kind: &str) -> String {
        self.catalog
            .kinds
            .iter()
            .find(|k| k.name == kind)
            .map_or_else(|| format!("{kind}s"), |k| k.plural.clone())
    }

    fn unit(&self, kind: &str, field: &str) -> String {
        self.catalog
            .kinds
            .iter()
            .find(|k| k.name == kind)
            .and_then(|k| k.fields.iter().find(|f| f.name == field))
            .and_then(|f| f.unit.clone())
            .map(|u| format!(" ({u})"))
            .unwrap_or_default()
    }

    fn filter(&self, kind: &str, filter: &Filter) -> String {
        use crate::intent::Cmp;
        let field = filter.field.replace('_', " ");
        match filter.cmp {
            Cmp::IsEmpty => return format!("{field} is empty (left blank)"),
            Cmp::IsSet => return format!("{field} is filled in (not blank)"),
            Cmp::In => {
                let crate::intent::Lit::List(values) = &filter.value else {
                    return format!("{field} is one of the listed values");
                };
                let values: Vec<String> = values.iter().map(|v| format!("\"{v}\"")).collect();
                return format!("{field} is {} (any one of them)", values.join(" or "));
            }
            _ => {}
        }
        let value = match &filter.value {
            crate::intent::Lit::Text(t) => format!("\"{t}\""),
            other => other.render(),
        };
        let money = self
            .catalog
            .kinds
            .iter()
            .find(|k| k.name == kind)
            .and_then(|k| k.fields.iter().find(|f| f.name == filter.field))
            .is_some_and(|f| f.ty == "money");
        let note = if money {
            " (money; negative is money out, spending)".to_owned()
        } else {
            self.unit(kind, &filter.field)
        };
        format!(
            "{}{} {} {value}",
            filter.field.replace('_', " "),
            note,
            cmp_words(filter)
        )
    }

    fn link(link: &Link, spans: &mut Vec<String>) -> String {
        spans.push(link.name.clone());
        format!("linked to the {} \"{}\"", link.kind, link.name)
    }

    /// A selector in words; its free text goes into `spans`.
    fn selector(&self, sel: &Selector, spans: &mut Vec<String>, depth_hint: bool) -> String {
        let mut text = format!("the {}", self.plural(&sel.kind));
        for kind in &sel.also {
            text += &format!(" and the {}", self.plural(kind));
        }
        if let Some(name) = &sel.name {
            spans.push(name.clone());
            text += &format!(" named \"{name}\"");
        }
        let mut parts: Vec<String> = sel
            .filters
            .iter()
            .map(|f| self.filter(&sel.kind, f))
            .collect();
        if let Some(text) = &sel.text {
            spans.push(text.clone());
            parts.push(format!(
                "found by searching for the word \"{text}\" (say the word; it is part of a name, so do not say the whole name)"
            ));
        }
        if sel.trashed {
            parts.push("only the ones in the trash (deleted ones)".to_owned());
        }
        if let Some(link) = &sel.link {
            parts.push(Self::link(link, spans));
        }
        if let Some(anchor) = &sel.anchor {
            spans.push(anchor.name.clone());
            parts.push(format!(
                "from the days of the {} \"{}\" (say that {}, not dates)",
                anchor.kind, anchor.name, anchor.kind
            ));
        } else if let Some(period) = &sel.period {
            let date = self
                .catalog
                .kinds
                .iter()
                .find(|k| k.name == sel.kind)
                .and_then(|k| k.date.clone())
                .unwrap_or_else(|| "date".to_owned());
            parts.push(format!(
                "whose {date} falls {}",
                when_phrase(period, self.today)
            ));
        }
        if let Some((field, desc)) = &sel.order {
            parts.push(format!(
                "sorted by {field}, {}",
                if *desc {
                    "highest first"
                } else {
                    "lowest first"
                }
            ));
        }
        if let Some(n) = sel.limit {
            parts.push(format!("only the first {n}"));
        }
        if sel.within.is_some() && depth_hint {
            parts.push("narrowed to the rows of an earlier turn".to_owned());
        }
        if sel.exclude.is_some() && depth_hint {
            parts.push(
                "leaving out the rows the earlier turn showed (the other ones, what else)"
                    .to_owned(),
            );
        }
        if !parts.is_empty() {
            text += &format!(" ({})", parts.join("; "));
        }
        text
    }

    fn measure(&self, m: &Measure, spans: &mut Vec<String>) -> String {
        let op = match m.op.as_str() {
            "sum" => "the total",
            "avg" => "the average",
            "min" => "the lowest",
            "max" => "the highest",
            other => other,
        };
        let by = m.group.as_ref().map_or(String::new(), |g| {
            format!(", broken down by {}", g.replace('_', " "))
        });
        format!(
            "{op} {}{} over {}{by}",
            m.field.replace('_', " "),
            self.unit(&m.sel.kind, &m.field),
            self.selector(&m.sel, spans, true)
        )
    }

    fn target(&self, target: &Target, spans: &mut Vec<String>) -> String {
        match target {
            Target::Name {
                kind,
                name,
                trashed,
                ..
            } => {
                spans.push(name.clone());
                format!(
                    "the {kind} called \"{name}\"{}",
                    if *trashed {
                        " (it is in the trash)"
                    } else {
                        ""
                    }
                )
            }
            Target::Select { sel } => self.selector(sel, spans, true),
            Target::Turn { turn, .. } => {
                format!(
                    "what turn {} showed or made (the thing it was about)",
                    turn + 1
                )
            }
        }
    }

    /// One field set to a value, in words. `typed` collects the values the member types as secrets.
    fn change(
        &self,
        kind: &str,
        item_type: Option<&str>,
        change: &Change,
        spans: &mut Vec<String>,
        typed: &mut Vec<String>,
    ) -> String {
        let value = match &change.value {
            Val::Text(t) => {
                spans.push(t.clone());
                if self.catalog.typed_secret(kind, &change.field, item_type) {
                    typed.push(t.clone());
                    format!(
                        "\"{t}\" (a made-up secret the person types in on purpose; say it exactly)"
                    )
                } else {
                    format!("\"{t}\"")
                }
            }
            Val::Num(n) => format!("{}{}", number(*n), self.unit(kind, &change.field)),
            Val::Flag(b) => if *b { "yes" } else { "no" }.to_owned(),
            Val::When(json) => self.when_json(json),
        };
        format!("{} to {value}", change.field.replace('_', " "))
    }

    fn when_json(&self, json: &str) -> String {
        let parsed: Option<Value> = serde_json::from_str(json).ok();
        let time = parsed
            .as_ref()
            .and_then(|v| v["time"].as_str())
            .map(|t| format!(" at {t}"))
            .unwrap_or_default();
        match serde_json::from_str::<Period>(json) {
            Ok(period) => format!("{}{time}", when_phrase(&period, self.today)),
            Err(_) => json.to_owned(),
        }
    }

    /// The brief of turn `index` of a scenario.
    #[must_use]
    pub fn turn(&self, turn: &TurnIntent, index: usize) -> TurnBrief {
        let mut spans = Vec::new();
        let mut typed = Vec::new();
        let ask = self.ask(&turn.intent, turn, &mut spans, &mut typed);
        TurnBrief {
            ask,
            spans: unique(spans),
            how: how_of(turn, index),
            typed: unique(typed),
        }
    }

    fn ask(
        &self,
        intent: &Intent,
        turn: &TurnIntent,
        spans: &mut Vec<String>,
        typed: &mut Vec<String>,
    ) -> String {
        match intent {
            Intent::Read { sel } if sel.open => {
                format!(
                    "Ask for everything about {}: all its details and everything it is linked to, not a line in a list.",
                    self.selector(sel, spans, true)
                )
            }
            Intent::Read { sel } => {
                format!("Show me {}.", self.selector(sel, spans, true))
            }
            Intent::Count { sel } => {
                format!(
                    "Ask HOW MANY there are of {}.",
                    self.selector(sel, spans, true)
                )
            }
            Intent::Measure { measure } => {
                format!("Ask for {}.", self.measure(measure, spans))
            }
            Intent::Compare { a, b } => format!(
                "Ask to compare two figures side by side: (1) {}; (2) {}.",
                self.measure(a, spans),
                self.measure(b, spans)
            ),
            Intent::Write { target, verb, arg } => {
                let what = self.target(target, spans);
                let extra = match arg {
                    VerbArg::None => String::new(),
                    VerbArg::When(json) => format!(" to {}", self.when_json(json)),
                    VerbArg::Container(link) => {
                        spans.push(link.name.clone());
                        format!(" {} the {} \"{}\"", prep(verb), link.kind, link.name)
                    }
                    VerbArg::Choice(c) => format!(" as a {c}"),
                };
                format!("{} {what}{extra}.", verb_phrase(verb))
            }
            Intent::Edit { target, changes } => {
                let what = self.target(target, spans);
                let kind = target_kind(target);
                let changes: Vec<String> = changes
                    .iter()
                    .map(|c| self.change(kind, None, c, spans, typed))
                    .collect();
                format!("Change {what}: set {}.", changes.join(", "))
            }
            Intent::Create { kind, fields } => {
                let item_type = fields.iter().find_map(|c| match &c.value {
                    Val::Text(t) if c.field == "type" => Some(t.as_str()),
                    _ => None,
                });
                let fields: Vec<String> = fields
                    .iter()
                    .map(|c| self.change(kind, item_type, c, spans, typed))
                    .collect();
                format!("Make a new {kind} with {}.", fields.join(", "))
            }
            Intent::Recall { turn: from, value } => format!(
                "Ask to see {} from turn {} AGAIN. It is not a new question and it adds nothing new: no \"how many\", no new condition (like \"show me that again\" or \"what was the {} again?\").",
                if *value {
                    "the number answered"
                } else {
                    "the list answered"
                },
                from + 1,
                if *value { "number" } else { "list" }
            ),
            Intent::Ask { kind, name, verb } => {
                spans.push(name.clone());
                let doing = verb.as_ref().map_or_else(
                    || "refer to it (look it up)".to_owned(),
                    |v| verb_phrase(v).to_lowercase(),
                );
                format!(
                    "{doing} the {kind} called \"{name}\" (several {} answer to that name; just say the name plainly, do not mention that).",
                    self.plural(kind)
                )
            }
            Intent::Decline { reason } => decline_phrase(reason, spans, turn),
        }
    }
}

fn target_kind(target: &Target) -> &str {
    match target {
        Target::Name { kind, .. } | Target::Turn { kind, .. } => kind,
        Target::Select { sel } => &sel.kind,
    }
}

fn prep(verb: &str) -> &'static str {
    if verb == "remove_from" { "from" } else { "to" }
}

fn verb_phrase(verb: &str) -> String {
    match verb {
        "complete" => "Mark as done".to_owned(),
        "reopen" => "Reopen".to_owned(),
        "cancel" => "Cancel".to_owned(),
        "delete" => "Delete (move to the trash)".to_owned(),
        "restore" => "Restore from the trash".to_owned(),
        "star" => "Star (favourite)".to_owned(),
        "unstar" => "Unstar".to_owned(),
        "reschedule" => "Reschedule".to_owned(),
        "add_to" => "Add".to_owned(),
        "remove_from" => "Take out".to_owned(),
        "log" => "Log a contact with".to_owned(),
        "undo" => "UNDO the change the turn before made (say undo, revert or take that back; not restore, which means something else)".to_owned(),
        "unlink" => "Unlink the two halves of".to_owned(),
        "archive" => "Archive".to_owned(),
        "unarchive" => "Bring back from the archive".to_owned(),
        other => other.replace('_', " "),
    }
}

fn decline_phrase(reason: &str, spans: &mut Vec<String>, _turn: &TurnIntent) -> String {
    match reason {
        "out_of_scope" => "Ask for something this personal-records app cannot do at all (the weather, sending an email, booking a table, a web search). Not about the member's records.".to_owned(),
        "unbounded_destruction" => "Ask to wipe out everything at once: delete all of an app's records, or empty the whole vault.".to_owned(),
        "fabricated_secret" => "Ask the app to make up or tell a secret it was never given (a password, a PIN, a card number the member never stored). The member wants it invented or guessed.".to_owned(),
        "not_found" => {
            spans.push(NOT_FOUND_NAME.to_owned());
            format!("Ask about a person called \"{NOT_FOUND_NAME}\" (nobody by that name is in the vault): look them up or show what is about them.")
        }
        other => format!("A request the app turns down ({other})."),
    }
}

fn how_of(turn: &TurnIntent, index: usize) -> String {
    let mut out = Vec::new();
    match turn.reference {
        Reference::Select => {
            out.push("Pick rows by what they are (no name said) unless the ask names one.".to_owned());
        }
        Reference::Name => out.push(
            "Say the row by its name exactly as given in quotes (a first name alone is fine if that is what is quoted).".to_owned(),
        ),
        Reference::Nickname => out.push(
            "The quoted name is a nickname: say it exactly as quoted, the way a friend would.".to_owned(),
        ),
        Reference::Misspelling => out.push(
            "The quoted name is MISSPELT on purpose: copy that misspelling exactly, do not fix it.".to_owned(),
        ),
        Reference::Pronoun => out.push(
            "Do NOT name the row again. Refer to it with a pronoun or a short phrase (it, that, them, those, the same ones).".to_owned(),
        ),
        Reference::Handle => out.push(
            "Refer back to an EARLIER answer (not the one just before) by position or description, like \"the first list\" or \"the earlier numbers\"; do not repeat the original question.".to_owned(),
        ),
    }
    if let Some((from, dep)) = turn.dep {
        let word = match dep {
            Dep::Pronoun => "acts on what that turn showed",
            Dep::Handle => "points back at that turn's result",
            Dep::Narrow => "narrows that turn's result with the extra condition",
            Dep::Carry => {
                "carries the earlier question over: it keeps the same kind of ask and changes only what is new (a period, a figure, or the subject)"
            }
            Dep::Undo => "takes back what that turn changed",
            Dep::Else => {
                "asks for the others: the same kind of rows that turn did not show (like \"what else is there?\" or \"the other ones\")"
            }
        };
        out.push(format!(
            "This turn leans on turn {}: it {word}. It must be a very short follow-up that cannot be understood without turn {}: start with \"and\", \"what about\", \"same for\", \"now\" or use it/that/those/the same; say only what is new.",
            from + 1,
            from + 1
        ));
    } else if index > 0 {
        out.push("It is a fresh request, not leaning on an earlier turn.".to_owned());
    }
    match turn.outcome {
        Outcome::Done | Outcome::Decline | Outcome::Ask => {}
        Outcome::Empty => {
            out.push("(It may well find nothing; that is fine. Do not say so.)".to_owned())
        }
        Outcome::Repair => out.push("Write it as an ordinary request.".to_owned()),
    }
    out.join(" ")
}

fn unique(spans: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    for s in spans {
        if !s.trim().is_empty() && !seen.contains(&s) {
            seen.push(s);
        }
    }
    seen
}
