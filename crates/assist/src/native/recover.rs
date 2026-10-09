//! REPLIES THAT LET THE MODEL RECOVER (nt10, #1044; SPEC §4.8 and §5): what an empty read, an
//! `error:` or a resend says so the next call can be the right one. Every line here prints only
//! when its rule triggers, is one line, and names rows as `#n kind "name"`.
//!
//! - G3 `without_part`: a read with two or more conditions that reached nothing names each
//!   condition whose removal gives rows, unless the message itself states that condition.

use crate::native::render;
use crate::native::session::{Selector, Session, words};
use crate::native::whr::Cond;
use crate::native::world::Key;

/// The most rows an empty read's hint names in all (`compose::HINT_ROWS`).
pub(crate) const WITHOUT_ROWS: usize = 4;

/// Words that say a time span, for the messages the `dates:` line does not read ("overdue").
const TIME_WORDS: [&str; 24] = [
    "overdue",
    "late",
    "upcoming",
    "soon",
    "recent",
    "recently",
    "past",
    "next",
    "last",
    "this",
    "today",
    "tonight",
    "tomorrow",
    "yesterday",
    "week",
    "weeks",
    "month",
    "months",
    "year",
    "weekend",
    "morning",
    "evening",
    "ago",
    "due",
];
/// Words that point at the list shown before: a `within` they explain is the person's.
const ANAPHORA: [&str; 19] = [
    "those", "these", "them", "they", "it", "its", "one", "ones", "that", "list", "above",
    "earlier", "previous", "same", "among", "within", "which", "other", "others",
];
/// Words that ask for the trash.
const TRASH_WORDS: [&str; 12] = [
    "trash", "trashed", "deleted", "delete", "removed", "bin", "recycle", "gone", "archive",
    "archived", "restore", "recover",
];
const FIRST_PERSON: [&str; 6] = ["i", "my", "me", "mine", "our", "we"];
const PRONOUNS: [&str; 10] = [
    "he", "she", "they", "him", "her", "his", "hers", "their", "them", "theirs",
];

/// Whether two words are one by their first four letters (a plural, a tense, a near spelling).
fn same_stem(a: &str, b: &str) -> bool {
    a == b
        || (a.chars().count() >= 4 && b.chars().count() >= 4 && {
            let common = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
            common >= 4
        })
}

impl Session {
    /// Whether the message says a word of `literal` (a literal of three letters or more; one
    /// made only of shorter words counts as said, nothing can be told from it).
    fn message_says(&self, literal: &str) -> bool {
        let spoken = words(&self.message);
        let long: Vec<String> = words(literal)
            .into_iter()
            .filter(|word| word.chars().count() >= 3)
            .collect();
        long.is_empty()
            || long
                .iter()
                .any(|word| spoken.iter().any(|said| same_stem(said, word)))
    }

    /// The same for the message before it: a follow-up carries what that one said.
    fn before_says(&self, literal: &str) -> bool {
        let spoken = words(&self.prev_message);
        words(literal)
            .iter()
            .filter(|word| word.chars().count() >= 3)
            .any(|word| spoken.iter().any(|said| same_stem(said, word)))
    }

    /// Whether a condition is the person's, said in this message or the one before it (a
    /// follow-up carries what the last message said: "and in january", "the next one").
    fn stated(&self, literal: &str) -> bool {
        self.message_says(literal) || self.before_says(literal)
    }

    fn message_has(&self, list: &[&str]) -> bool {
        words(&self.message)
            .iter()
            .any(|word| list.contains(&word.as_str()))
    }

    /// Each single condition of an empty read whose removal gives rows, with the rows (live,
    /// the selector's order): `(label, rows)`. Needs two conditions or more (one must remain), and
    /// leaves out every condition the message states itself (SPEC §4.8, nt10 G3): the name or a
    /// `where` literal it says, the time span it says, a link to a row it names, a narrowing it
    /// points back at with those/them, the trash it asks for. A `where` clause that is no free
    /// text (an enum, a number, a yes or no, a presence, a count) is a condition the vault
    /// checked, never one the model invented, so it is never offered.
    pub(crate) fn without_rows(&mut self, selector: &Selector) -> Vec<(String, Vec<Key>)> {
        let total = usize::from(selector.name.is_some())
            + usize::from(selector.when.is_some())
            + selector.conds.len()
            + selector.linked_to.len()
            + usize::from(selector.within.is_some())
            + usize::from(selector.trashed);
        if total < 2 {
            return Vec::new();
        }
        let mut out: Vec<(String, Vec<Key>)> = Vec::new();
        let mut offer = |session: &mut Self, label: String, relaxed: Selector| {
            let rows = session.select(&relaxed);
            if !rows.is_empty() {
                out.push((label, rows));
            }
        };
        if let Some(name) = &selector.name
            && !self.stated(name)
            && !self.message_has(&ANAPHORA)
        {
            offer(
                self,
                format!("name \"{name}\""),
                Selector {
                    name: None,
                    ..selector.clone()
                },
            );
        }
        for (index, cond) in selector.conds.iter().enumerate() {
            let literal = match cond {
                Cond::Text { value, .. } => value.clone(),
                Cond::Contains { text, .. } => text.clone(),
                Cond::In { values, .. } => values.join(" "),
                _ => continue,
            };
            if self.stated(&literal) {
                continue;
            }
            let mut conds = selector.conds.clone();
            let mut texts = selector.cond_text.clone();
            let label = texts
                .get(index)
                .map_or_else(|| "where".to_owned(), |text| format!("where {text}"));
            conds.remove(index);
            if index < texts.len() {
                texts.remove(index);
            }
            offer(
                self,
                label,
                Selector {
                    conds,
                    cond_text: texts,
                    ..selector.clone()
                },
            );
        }
        if let Some(when) = selector.when
            && self.date_readings(&self.message.clone()).is_empty()
            && self.date_readings(&self.prev_message.clone()).is_empty()
            && !self.message_has(&TIME_WORDS)
            && !words(&self.prev_message)
                .iter()
                .any(|word| TIME_WORDS.contains(&word.as_str()))
        {
            offer(
                self,
                format!("when {}", when.echo()),
                Selector {
                    when: None,
                    ..selector.clone()
                },
            );
        }
        for target in &selector.linked_to {
            let named = self.world.row(target).map(|row| row.name.clone());
            let in_focus = crate::native::block::focus_sets(self)
                .iter()
                .any(|set| set.keys.contains(target) || set.container.contains(target));
            let said = named.is_some_and(|name| self.stated(&name))
                || in_focus
                || (*target == self.world.me_key() && self.message_has(&FIRST_PERSON))
                || (target.0 == crate::native::meta::Kind::Person && self.message_has(&PRONOUNS));
            if said {
                continue;
            }
            let number = self.number(target);
            let rest: Vec<Key> = selector
                .linked_to
                .iter()
                .filter(|other| *other != target)
                .cloned()
                .collect();
            offer(
                self,
                format!("linked_to #{number}"),
                Selector {
                    linked_to: rest,
                    ..selector.clone()
                },
            );
        }
        if let Some(handle) = selector.within
            && !self.message_has(&ANAPHORA)
        {
            offer(
                self,
                format!("within @{handle}"),
                Selector {
                    within: None,
                    ..selector.clone()
                },
            );
        }
        if selector.trashed && !self.message_has(&TRASH_WORDS) {
            offer(
                self,
                "trashed".to_owned(),
                Selector {
                    trashed: false,
                    ..selector.clone()
                },
            );
        }
        out
    }

    /// The `without …` parts of an empty read's hint, `budget` rows in all shared out over the
    /// conditions: `without where description contains "x": #4 task "Pay rent" · without …`.
    /// The numbers of the rows named are pushed to `numbers`.
    pub(crate) fn without_parts(
        &mut self,
        selector: &Selector,
        mut budget: usize,
        numbers: &mut Vec<usize>,
    ) -> Vec<String> {
        let offers = self.without_rows(selector);
        let mut parts = Vec::new();
        let mut left = offers.len();
        for (label, rows) in offers {
            if budget == 0 {
                break;
            }
            let take = budget.div_ceil(left).min(rows.len()).min(budget);
            left -= 1;
            budget -= take;
            let shown: Vec<String> = rows
                .iter()
                .take(take)
                .map(|key| {
                    let n = self.number(key);
                    numbers.push(n);
                    render::named(&self.world, n, key)
                })
                .collect();
            let mut part = format!("without {label}: {}", shown.join(", "));
            if rows.len() > take {
                part.push_str(&format!(" and {} more", rows.len() - take));
            }
            parts.push(part);
        }
        parts
    }

    /// The hint line of an empty read that is no dead end (its name, if any, reaches rows): the
    /// `without` parts alone, and the numbers of the rows they name.
    pub(crate) fn empty_read_hint(&mut self, selector: &Selector) -> Option<(String, Vec<usize>)> {
        let mut numbers = Vec::new();
        let parts = self.without_parts(selector, WITHOUT_ROWS, &mut numbers);
        (!parts.is_empty()).then(|| (format!("hint: {}", parts.join(" · ")), numbers))
    }

    /// Whether an empty read has a `without` row to name (the open rule of an `answer`).
    pub(crate) fn has_without(&mut self, selector: &Selector) -> bool {
        !self.without_rows(selector).is_empty()
    }
}

// ---------------------------------------------------------------------------------------------
// G2: an error ends in the call to send instead, with real handles, when every argument of it is
// decidable. No call when anything of it is a guess.

use serde_json::{Map, Value, json};

use crate::native::meta::Kind;
use crate::native::search;
use crate::native::session::{arg_str, tool_params};

/// A call in the model's own terms: `act verb: edit, rows: #3, args: description: x`. Parameters
/// in the tool's order; a name is quoted, a date expression is its compact JSON, the lines of
/// `args` are joined by `; `.
pub(crate) fn render_call(tool: &str, args: &Map<String, Value>) -> String {
    let mut keys: Vec<String> = tool_params(tool)
        .iter()
        .map(|key| (*key).to_owned())
        .collect();
    for key in args.keys() {
        if !keys.contains(key) {
            keys.push(key.clone());
        }
    }
    let mut parts: Vec<String> = Vec::new();
    for key in keys {
        let Some(value) = args.get(&key).filter(|value| !value.is_null()) else {
            continue;
        };
        let shown = match value {
            Value::String(text) if key == "name" => format!("\"{}\"", text.trim()),
            Value::String(text) => text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join("; "),
            Value::Array(items) if items.iter().all(Value::is_string) => items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", "),
            Value::Object(object) if key == "args" => object
                .iter()
                .map(|(field, value)| {
                    format!(
                        "{field}: {}",
                        value
                            .as_str()
                            .map_or_else(|| value.to_string(), str::to_owned)
                    )
                })
                .collect::<Vec<_>>()
                .join("; "),
            other => other.to_string(),
        };
        parts.push(format!("{key}: {shown}"));
    }
    format!("{tool} {}", parts.join(", "))
}

/// The selector parameters of a call, which a call on `rows` leaves out.
const SELECTOR_KEYS: [&str; 10] = [
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

/// `error` with ` Send <call>.` in place of its generic fix, or `error` unchanged.
fn sent(error: &str, drop_tail: &str, call: &str) -> String {
    let base = error.trim_end();
    let base = base.strip_suffix(drop_tail).map_or(base, str::trim_end);
    format!("{base} Send {call}.")
}

/// The word between `"` quotes after `lead` in `text`.
fn quoted_after<'a>(text: &'a str, lead: &str) -> Option<&'a str> {
    let rest = &text[text.find(lead)? + lead.len()..];
    let rest = rest.strip_prefix('"')?;
    rest.split('"').next()
}

/// The first token of a clause or an order, lowercased.
fn lead_token(text: &str) -> String {
    text.trim()
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect::<String>()
        .to_lowercase()
}

/// A call corrected without a guess (`Session::decidable_fix`).
pub(crate) struct Fix {
    /// The call with its fix: it is what runs.
    pub args: Map<String, Value>,
    /// `note: read notes as description` or `note: used find within: @1, …`.
    pub note: String,
    /// The error ending in ` Send <call>.`, for when the fixed call fails too.
    pub text: String,
}

impl Session {
    /// An `error:` of a call, ending in the call to send instead when it is decidable.
    pub(crate) fn error_with_call(
        &mut self,
        tool: &str,
        args: &Map<String, Value>,
        error: String,
    ) -> String {
        if !error.starts_with("error:") {
            return error;
        }
        let fixed = self
            .decidable_fix(tool, args, &error)
            .map(|fix| fix.text)
            .or_else(|| self.reveal_call(args, &error))
            .or_else(|| self.did_you_mean_call(tool, args, &error));
        fixed.unwrap_or(error)
    }

    /// THE CALL THE RUNTIME CAN FIX WITHOUT A GUESS (nt12 R1, R2): a field the kind names
    /// otherwise, a balance whose person the message names, a selector whose list is the one on
    /// screen. The corrected args, the note that says what was used, and the error with the
    /// call to send (what the model reads when the fixed call fails too). A reveal is egress and
    /// a `Did you mean` changes the rows: those stay a `Send` on the error, never a run.
    pub(crate) fn decidable_fix(
        &mut self,
        tool: &str,
        args: &Map<String, Value>,
        error: &str,
    ) -> Option<Fix> {
        if !error.starts_with("error:") {
            return None;
        }
        self.field_swap(tool, args, error)
            .or_else(|| self.balance_call(tool, args, error))
            .or_else(|| self.within_call(tool, args, error))
    }

    /// `For that use M.` of a field the kind names otherwise: the call with the field swapped.
    fn field_swap(&self, tool: &str, args: &Map<String, Value>, error: &str) -> Option<Fix> {
        let fix = error.rsplit_once(" For that use ")?;
        let meant = fix.1.strip_suffix('.')?;
        // a date is no field of a condition; an `order` reads it (`order: due` is `date`), and an
        // edit or a create of one is the reschedule or the date arg (`act.rs`)
        if meant.contains(' ') || (meant == "date" && tool == "act") {
            return None;
        }
        let wrong = quoted_after(error, "have no field ")
            .or_else(|| quoted_after(error, " by "))
            .or_else(|| quoted_after(error, "not "))?
            .to_lowercase()
            .replace([' ', '-'], "_");
        let swap = |text: &str| -> Option<String> {
            (lead_token(text).replace([' ', '-'], "_") == wrong)
                .then(|| format!("{meant}{}", &text.trim_start()[lead_token(text).len()..]))
        };
        let in_where = meant != "date";
        let mut call = args.clone();
        let mut changed = false;
        match tool {
            "find" | "answer" | "compute" => {
                if let Some(text) = arg_str(args, "where").filter(|_| in_where) {
                    let clauses = crate::native::whr::split_and(&text);
                    let swapped: Vec<String> = clauses
                        .iter()
                        .map(|clause| {
                            let new = swap(clause);
                            changed |= new.is_some();
                            new.unwrap_or_else(|| clause.clone())
                        })
                        .collect();
                    call.insert("where".to_owned(), json!(swapped.join(" and ")));
                }
                for key in ["order", "field", "group"] {
                    if let Some(text) = arg_str(args, key).filter(|_| in_where || key == "order")
                        && let Some(new) = swap(&text)
                    {
                        call.insert(key.to_owned(), json!(new));
                        changed = true;
                    }
                }
            }
            "act" => {
                let lines: Vec<String> = match args.get("args")? {
                    Value::String(text) => text.lines().map(str::to_owned).collect(),
                    Value::Object(object) => object
                        .iter()
                        .map(|(key, value)| {
                            format!(
                                "{key}: {}",
                                value
                                    .as_str()
                                    .map_or_else(|| value.to_string(), str::to_owned)
                            )
                        })
                        .collect(),
                    _ => return None,
                };
                let swapped: Vec<String> = lines
                    .iter()
                    .map(|line| {
                        let new = swap(line);
                        changed |= new.is_some();
                        new.unwrap_or_else(|| line.clone())
                    })
                    .collect();
                call.insert("args".to_owned(), json!(swapped.join("\n")));
            }
            _ => return None,
        }
        changed.then(|| Fix {
            text: sent(
                error,
                &format!("For that use {meant}."),
                &render_call(tool, &call),
            ),
            note: format!("note: read {wrong} as {meant}"),
            args: call,
        })
    }

    /// A secret the item lacks: the whole reveal call for the one it holds.
    fn reveal_call(&self, args: &Map<String, Value>, error: &str) -> Option<String> {
        let (_, tail) = error.rsplit_once(" Send reveal field: ")?;
        let field = tail.strip_suffix('.')?;
        let mut call = args.clone();
        call.insert("args".to_owned(), json!(format!("field: {field}")));
        Some(sent(
            error,
            &format!("Send reveal field: {field}."),
            &render_call("act", &call),
        ))
        .map(|text| text.replacen(" Send Send ", " Send ", 1))
    }

    /// `Did you mean #7 task "…"?` over one row: the call on that row.
    fn did_you_mean_call(
        &self,
        tool: &str,
        args: &Map<String, Value>,
        error: &str,
    ) -> Option<String> {
        if tool != "act" {
            return None;
        }
        let at = error.find(" Did you mean ")?;
        let (head, mean) = (&error[..at], &error[at + " Did you mean ".len()..]);
        let numbers = |text: &str| -> Vec<String> {
            text.split(|c: char| !c.is_alphanumeric() && c != '#')
                .filter(|token| {
                    token.starts_with('#')
                        && token.len() > 1
                        && token[1..].chars().all(|c| c.is_ascii_digit())
                })
                .map(str::to_owned)
                .collect()
        };
        let rights = numbers(mean);
        let [right] = rights.as_slice() else {
            return None;
        };
        let right = right.clone();
        let mut call = args.clone();
        let wrong = numbers(head);
        let mut changed = false;
        if head.contains(" does not apply to ") {
            for key in SELECTOR_KEYS {
                call.remove(key);
            }
            call.insert("rows".to_owned(), json!(right));
            changed = true;
        } else {
            for key in ["args", "rows"] {
                if let Some(text) = arg_str(args, key) {
                    let mut new = text.clone();
                    for token in &wrong {
                        let replaced = replace_token(&new, token, &right);
                        changed |= replaced != new;
                        new = replaced;
                    }
                    call.insert(key.to_owned(), json!(new));
                }
            }
        }
        changed.then(|| format!("{} Send {}.", error.trim_end(), render_call(tool, &call)))
    }

    /// The groups a balance call reaches: its rows, its `linked_to`, its `within` result, and the
    /// groups a selector of kind group selects.
    fn groups_in_reach(&mut self, args: &Map<String, Value>) -> Vec<Key> {
        let mut keys: Vec<Key> = Vec::new();
        for key in ["rows", "linked_to"] {
            if let Some(value) = args.get(key).filter(|value| !value.is_null())
                && let Ok(found) = self.resolve_rows(value)
            {
                keys.extend(found);
            }
        }
        if let Some(within) = arg_str(args, "within")
            && let Ok(handle) = self.resolve_result(&within)
        {
            keys.extend(self.results[handle - 1].keys.clone());
        }
        if args.get("rows").is_none()
            && arg_str(args, "kind")
                .is_some_and(|kind| Kind::parse(kind.trim()) == Some(Kind::Group))
            && let Ok(selector) = self.selector(args)
        {
            keys.extend(self.select(&selector));
        }
        let mut groups: Vec<Key> = Vec::new();
        for key in keys {
            if key.0 == Kind::Group && !groups.contains(&key) {
                groups.push(key);
            }
        }
        groups
    }

    /// Whose balance the message means: the one other person it names, or the user when it
    /// names no one and nobody else is in play; `None` when that is a guess.
    pub(crate) fn balance_person(&mut self) -> Option<Key> {
        let others = search::persons_named(self, &self.message.clone());
        match others.as_slice() {
            [only] => Some(only.clone()),
            [] if !self.names_someone_else() && self.world.row(&self.world.me_key()).is_some() => {
                Some(self.world.me_key())
            }
            _ => None,
        }
    }

    /// A balance the call got wrong: the group's balance of the person, or the person's.
    fn balance_call(&mut self, tool: &str, args: &Map<String, Value>, error: &str) -> Option<Fix> {
        if !matches!(tool, "compute" | "answer")
            || arg_str(args, "op").as_deref() != Some("balance")
        {
            return None;
        }
        let one_person = error.starts_with("error: balance is for one person;")
            || error.starts_with("error: balance needs one person;");
        let you = error.starts_with("error: that is you;");
        let no_person = error.starts_with("error: a group's balance is one person's");
        if !(one_person || you || no_person) {
            return None;
        }
        let groups = self.groups_in_reach(args);
        let fixed = match groups.as_slice() {
            [group] => {
                let person = self.balance_person()?;
                let n = self.number(&person);
                let name = self.world.row(group)?.name.clone();
                let mut call = Map::new();
                call.insert("op".to_owned(), json!("balance"));
                call.insert("kind".to_owned(), json!("group"));
                call.insert("name".to_owned(), json!(name));
                call.insert("linked_to".to_owned(), json!(format!("#{n}")));
                call
            }
            [] if you => {
                let named = search::persons_named(self, &self.message.clone());
                let [other] = named.as_slice() else {
                    return None;
                };
                let n = self.number(other);
                let mut call = Map::new();
                call.insert("op".to_owned(), json!("balance"));
                call.insert("rows".to_owned(), json!(format!("#{n}")));
                call
            }
            _ => return None,
        };
        Some(fix_of(tool, error, fixed))
    }

    /// THE CALL FOR A LINK THE KINDS LACK, with real handles (` Send …`, a leading space): a
    /// group's money is the group's balance of the person the message means; the photos of a
    /// person or an album are the photos `linked_to` that row. `None` when it is a guess (the
    /// selector links to two rows, or whose balance it is is not decided).
    pub(crate) fn link_call(&mut self, kind: Kind, selector: &Selector) -> Option<String> {
        let [target] = selector.linked_to.as_slice() else {
            return None;
        };
        let mut call = Map::new();
        let (tool, shown) = match (kind, target.0) {
            (Kind::Debt, Kind::Group) => {
                let person = self.balance_person()?;
                let n = self.number(&person);
                let name = self.world.row(target)?.name.clone();
                call.insert("op".to_owned(), json!("balance"));
                call.insert("kind".to_owned(), json!("group"));
                call.insert("name".to_owned(), json!(name));
                call.insert("linked_to".to_owned(), json!(format!("#{n}")));
                ("compute", &call)
            }
            (Kind::Person, Kind::Album) | (Kind::Album, Kind::Person) => {
                let n = self.number(target);
                call.insert("kind".to_owned(), json!("photo"));
                call.insert("linked_to".to_owned(), json!(format!("#{n}")));
                ("find", &call)
            }
            _ => return None,
        };
        Some(format!(" Send {}.", render_call(tool, shown)))
    }

    /// `a selector needs kind (or within=@n)` from a narrowing follow-up: when one list of the
    /// last two turns is the one on screen, the call with `within` of it.
    fn within_call(&self, tool: &str, args: &Map<String, Value>, error: &str) -> Option<Fix> {
        if !error.starts_with("error: a selector needs kind (or within=@n).")
            || args.contains_key("kind")
            || args.contains_key("within")
            || !crate::native::session::Session::has_selector(args)
        {
            return None;
        }
        let from = self
            .turn_starts
            .get(self.turn.saturating_sub(2))
            .copied()
            .unwrap_or(0);
        let lists: Vec<usize> = (from..self.results.len())
            .filter(|index| {
                let set = &self.results[*index];
                set.value.is_none() && !set.keys.is_empty()
            })
            .map(|index| index + 1)
            .collect();
        let [handle] = lists.as_slice() else {
            return None;
        };
        let mut call = args.clone();
        call.insert("within".to_owned(), json!(format!("@{handle}")));
        Some(fix_of(tool, error, call))
    }
}

/// A fix that is a whole call: it runs with `note: used <call>`, and is the `Send` of the error
/// when it fails too.
fn fix_of(tool: &str, error: &str, call: Map<String, Value>) -> Fix {
    let shown = render_call(tool, &call);
    Fix {
        text: format!("{} Send {shown}.", error.trim_end()),
        note: format!("note: used {shown}"),
        args: call,
    }
}

/// `text` with the whole token `old` (`#9`) replaced by `new`.
fn replace_token(text: &str, old: &str, new: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(old) {
        let after = &rest[at + old.len()..];
        let boundary = after.chars().next().is_none_or(|c| !c.is_ascii_digit());
        out.push_str(&rest[..at]);
        out.push_str(if boundary { new } else { old });
        rest = after;
    }
    out.push_str(rest);
    out
}
