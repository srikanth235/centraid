//! WHAT A WORLD HOLDS, read straight off its seed document: the rows, their fields and dates, the
//! links between them. This is the sampler's side of "solvable": it picks a target first and
//! derives constraints the target satisfies, and the planner keeps an intent only when the
//! runtime's answer is the set this index says the constraints select.
//!
//! The index is deliberately a second, simpler reading of the world than the runtime's. When the
//! two disagree the intent is dropped and counted (`overmatch` / `undermatch`), which is how a
//! misreading on either side shows up.

use std::collections::{BTreeMap, BTreeSet};

use jiff::civil::Date;
use serde_json::Value;

use crate::catalog::Catalog;
use crate::intent::{Cmp, Filter, Lit, Selector};
use crate::world::World;

#[derive(Debug, Clone, PartialEq)]
pub enum F {
    N(f64),
    T(String),
    B(bool),
}

#[derive(Debug, Clone)]
pub struct Row {
    pub kind: String,
    /// The world key; budgets and daily figures have none, so they get an internal identity.
    pub key: String,
    /// Whether the seed document gives the row a key an eval can name.
    pub keyed: bool,
    pub name: String,
    pub date: Option<Date>,
    pub fields: BTreeMap<String, F>,
    pub trashed: bool,
}

impl Row {
    #[must_use]
    pub fn num(&self, field: &str) -> Option<f64> {
        match self.fields.get(field)? {
            F::N(n) => Some(*n),
            _ => None,
        }
    }

    #[must_use]
    pub fn text(&self, field: &str) -> Option<&str> {
        match self.fields.get(field)? {
            F::T(t) => Some(t),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Facts {
    pub today: Date,
    pub rows: Vec<Row>,
    /// Row key to the keys of the rows it is linked to, both directions.
    pub related: BTreeMap<String, BTreeSet<String>>,
    pub titles: BTreeMap<String, String>,
    /// The vault's default currency: a money threshold in a `where` reads in it, so a row in
    /// another currency passes none.
    pub base: String,
}

fn s<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
}

fn day(text: &str) -> Option<Date> {
    text.get(..10)?.parse().ok()
}

fn minutes(start: &str, end: &str) -> Option<f64> {
    let parse = |t: &str| -> Option<jiff::civil::DateTime> {
        (t.len() >= 16).then(|| t.get(..16)?.parse().ok())?
    };
    let (a, b) = (parse(start)?, parse(end)?);
    let span = b.since(a).ok()?;
    Some(span.total(jiff::Unit::Minute).ok()?.round())
}

impl Facts {
    /// Index `world`'s seed document.
    ///
    /// # Panics
    ///
    /// If the world's `today` is not a date; a generated world always has one.
    #[must_use]
    pub fn of(world: &World, catalog: &Catalog) -> Self {
        let doc = &world.doc;
        let today: Date = world.today.parse().expect("a world's today is a date");
        let titles = catalog.titles.clone();
        let mut rows: Vec<Row> = Vec::new();
        let mut related: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let mut relate = |a: &str, b: &str| {
            related
                .entry(a.to_owned())
                .or_default()
                .insert(b.to_owned());
            related
                .entry(b.to_owned())
                .or_default()
                .insert(a.to_owned());
        };
        let list = |name: &str| -> Vec<&Value> {
            doc.get(name)
                .and_then(Value::as_array)
                .map(|a| a.iter().collect())
                .unwrap_or_default()
        };
        let account_currency = |key: &str| -> String {
            list("accounts")
                .into_iter()
                .find(|a| s(a, "key") == Some(key))
                .and_then(|a| s(a, "currency"))
                .or_else(|| s(doc, "currency"))
                .unwrap_or("USD")
                .to_uppercase()
        };
        let account_name = |key: &str| -> Option<String> {
            list("accounts")
                .into_iter()
                .find(|a| s(a, "key") == Some(key))
                .and_then(|a| s(a, "name").map(str::to_owned))
        };
        let put = |kind: &str,
                   row: &Value,
                   date: Option<Date>,
                   fields: Vec<(&str, F)>,
                   name: Option<String>|
         -> Row {
            let key = s(row, "key").unwrap_or_default().to_owned();
            Row {
                kind: kind.to_owned(),
                keyed: !key.is_empty(),
                key,
                name: name.unwrap_or_else(|| s(row, "name").unwrap_or_default().to_owned()),
                date,
                fields: fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
                trashed: row
                    .get("trashed")
                    .is_some_and(|t| !t.is_null() && t != false),
            }
        };
        let t = |v: Option<&str>| v.map(|v| F::T(v.to_owned()));
        let n = |v: Option<f64>| v.map(F::N);
        let add = |fields: Vec<(&'static str, Option<F>)>| -> Vec<(&'static str, F)> {
            fields
                .into_iter()
                .filter_map(|(k, v)| Some((k, v?)))
                .collect()
        };
        // the owner is a person row too, keyed `me`
        rows.push(Row {
            kind: "person".to_owned(),
            key: "me".to_owned(),
            keyed: true,
            name: world.persona.me.clone(),
            date: None,
            fields: BTreeMap::from([("starred".to_owned(), F::B(false))]),
            trashed: false,
        });
        for r in list("people") {
            let fields = add(vec![
                ("role", t(s(r, "role"))),
                ("nickname", t(s(r, "nickname"))),
                ("met", t(s(r, "met"))),
                ("cadence", n(r.get("cadence").and_then(Value::as_f64))),
                (
                    "starred",
                    Some(F::B(r.get("starred") == Some(&Value::Bool(true)))),
                ),
            ]);
            rows.push(put("person", r, None, fields, None));
        }
        for r in list("lists") {
            let fields = add(vec![("area", t(s(r, "area")))]);
            rows.push(put("list", r, None, fields, None));
        }
        for r in list("events") {
            let start = s(r, "start").unwrap_or_default();
            // a timed event with no end runs an hour; an all-day one has no duration
            let duration = match s(r, "end") {
                Some(end) => minutes(start, end),
                None => (start.len() > 10).then_some(60.0),
            };
            let fields = add(vec![("duration", n(duration))]);
            rows.push(put("event", r, day(start), fields, None));
            for a in r
                .get("attendees")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                relate(s(r, "key").unwrap_or_default(), a);
            }
        }
        for r in list("tasks") {
            let status = s(r, "status").unwrap_or("open");
            let fields = add(vec![
                ("status", Some(F::T(status.to_owned()))),
                ("effort", n(r.get("effort").and_then(Value::as_f64))),
                // priority 0 is "none": the runtime shows and folds no priority for it
                (
                    "priority",
                    n(r.get("priority")
                        .and_then(Value::as_f64)
                        .filter(|p| *p > 0.0)),
                ),
            ]);
            rows.push(put("task", r, s(r, "due").and_then(day), fields, None));
            let key = s(r, "key").unwrap_or_default();
            for link in ["list", "parent"] {
                if let Some(other) = s(r, link) {
                    relate(key, other);
                }
            }
        }
        for r in list("notebooks") {
            rows.push(put("notebook", r, None, vec![], None));
        }
        for r in list("notes") {
            let fields = add(vec![
                (
                    "pinned",
                    Some(F::B(r.get("pinned") == Some(&Value::Bool(true)))),
                ),
                (
                    "starred",
                    Some(F::B(r.get("starred") == Some(&Value::Bool(true)))),
                ),
            ]);
            rows.push(put("note", r, s(r, "created").and_then(day), fields, None));
            if let Some(nb) = s(r, "notebook") {
                relate(s(r, "key").unwrap_or_default(), nb);
            }
        }
        for r in list("folders") {
            rows.push(put("folder", r, None, vec![], None));
        }
        for r in list("documents") {
            let fields = add(vec![(
                "starred",
                Some(F::B(r.get("starred") == Some(&Value::Bool(true)))),
            )]);
            rows.push(put(
                "document",
                r,
                s(r, "created").and_then(day),
                fields,
                None,
            ));
            if let Some(f) = s(r, "folder") {
                relate(s(r, "key").unwrap_or_default(), f);
            }
        }
        for r in list("albums") {
            rows.push(put("album", r, None, vec![], None));
        }
        for r in list("photos") {
            let fields = add(vec![(
                "starred",
                Some(F::B(r.get("starred") == Some(&Value::Bool(true)))),
            )]);
            let date = s(r, "taken").or(s(r, "created")).and_then(day);
            rows.push(put("photo", r, date, fields, None));
            let key = s(r, "key").unwrap_or_default();
            for album in r
                .get("albums")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                relate(key, album);
            }
        }
        for r in list("locker") {
            let fields = add(vec![
                ("type", t(s(r, "type"))),
                ("username", t(s(r, "username"))),
                (
                    "starred",
                    Some(F::B(r.get("starred") == Some(&Value::Bool(true)))),
                ),
            ]);
            rows.push(put("locker item", r, None, fields, None));
        }
        for r in list("accounts") {
            let fields = add(vec![("type", t(s(r, "kind")))]);
            rows.push(put("account", r, None, fields, None));
        }
        for r in list("transactions") {
            let status = if r.get("void") == Some(&Value::Bool(true)) {
                "void"
            } else {
                "posted"
            };
            let fields = add(vec![
                ("amount", n(r.get("amount").and_then(Value::as_f64))),
                (
                    "account",
                    t(s(r, "account").and_then(&account_name).as_deref()),
                ),
                ("category", t(s(r, "category"))),
                ("status", Some(F::T(status.to_owned()))),
                (
                    "currency",
                    Some(F::T(account_currency(s(r, "account").unwrap_or_default()))),
                ),
            ]);
            rows.push(put(
                "transaction",
                r,
                s(r, "date").and_then(day),
                fields,
                None,
            ));
        }
        for r in list("categories") {
            rows.push(put("category", r, None, vec![], None));
        }
        for r in list("rules") {
            let fields = add(vec![("category", t(s(r, "category")))]);
            let name = s(r, "text").map(str::to_owned);
            rows.push(put("rule", r, None, fields, name));
        }
        for r in list("workouts") {
            let w = r.get("workout").unwrap_or(&Value::Null);
            let kind = s(r, "kind").unwrap_or("other");
            let g = |k: &str| w.get(k).and_then(Value::as_f64);
            let fields = add(vec![
                ("moving", n(g("moving_s"))),
                ("distance", n(g("distance_m"))),
                ("energy", n(g("energy_kcal"))),
                ("heart_rate", n(g("heart_bpm"))),
                ("climb", n(g("climb_m"))),
                ("workout_kind", Some(F::T(kind.to_owned()))),
            ]);
            let name = titles.get(kind).cloned().unwrap_or_else(|| kind.to_owned());
            rows.push(put(
                "workout",
                r,
                s(r, "starts").and_then(day),
                fields,
                Some(name),
            ));
        }
        for r in list("health_days") {
            let metric = s(r, "metric").unwrap_or_default();
            let when = s(r, "day").unwrap_or_default();
            let fields = add(vec![
                ("metric", Some(F::T(metric.to_owned()))),
                ("value", n(r.get("value").and_then(Value::as_f64))),
            ]);
            let mut row = put(
                "daily figure",
                r,
                day(when),
                fields,
                Some(metric.to_owned()),
            );
            row.key = format!("health:{when}:{metric}");
            rows.push(row);
        }
        for r in list("budgets") {
            let (cat, month) = (
                s(r, "category").unwrap_or_default(),
                s(r, "month").unwrap_or_default(),
            );
            let fields = add(vec![
                ("amount", n(r.get("amount").and_then(Value::as_f64))),
                (
                    "currency",
                    Some(F::T(s(doc, "currency").unwrap_or("USD").to_uppercase())),
                ),
            ]);
            let title = titles.get(cat).cloned().unwrap_or_else(|| cat.to_owned());
            let mut row = put(
                "budget",
                r,
                day(&format!("{month}-01")),
                fields,
                Some(format!("{title} {month}")),
            );
            row.key = format!("budget:{cat}:{month}");
            row.fields
                .insert("category".to_owned(), F::T(cat.to_owned()));
            rows.push(row);
        }
        for r in list("links") {
            if let (Some(a), Some(b)) = (s(r, "from"), s(r, "to")) {
                relate(a, b);
            }
        }
        // a parent's trash reaches its subtasks (its completion, seeded after them, does not)
        let trashed_parents: BTreeSet<String> = rows
            .iter()
            .filter(|r| r.kind == "task" && r.trashed)
            .map(|r| r.key.clone())
            .collect();
        for task in list("tasks") {
            if s(task, "parent").is_some_and(|p| trashed_parents.contains(p))
                && let Some(row) = rows
                    .iter_mut()
                    .find(|r| r.kind == "task" && Some(r.key.as_str()) == s(task, "key"))
            {
                row.trashed = true;
            }
        }
        Self {
            today,
            rows,
            related,
            titles,
            base: s(doc, "currency").unwrap_or("USD").to_uppercase(),
        }
    }

    #[must_use]
    pub fn row(&self, key: &str) -> Option<&Row> {
        self.rows.iter().find(|r| r.key == key)
    }

    /// Live rows of `kind`.
    pub fn of_kind(&self, kind: &str) -> impl Iterator<Item = &Row> + '_ {
        let kind = kind.to_owned();
        self.rows
            .iter()
            .filter(move |r| r.kind == kind && !r.trashed)
    }

    /// Does `row` satisfy `filter`?
    #[must_use]
    pub fn passes(&self, row: &Row, filter: &Filter) -> bool {
        if filter.field == "amount" && row.text("currency").is_some_and(|c| c != self.base) {
            return false;
        }
        let Some(have) = row.fields.get(&filter.field) else {
            return false;
        };
        match (have, &filter.value) {
            (F::N(a), Lit::Num(b)) => match filter.cmp {
                Cmp::Eq => (a - b).abs() < 1e-9,
                Cmp::Lt => a < b,
                Cmp::Le => a <= b,
                Cmp::Gt => a > b,
                Cmp::Ge => a >= b,
            },
            // `=` with a plain word on a free-text field reads as contains (the runtime says so)
            (F::T(a), Lit::Text(b))
                if matches!(
                    filter.field.as_str(),
                    "role" | "met" | "description" | "body"
                ) =>
            {
                filter.cmp == Cmp::Eq && a.to_lowercase().contains(&b.to_lowercase())
            }
            (F::T(a), Lit::Text(b)) => filter.cmp == Cmp::Eq && a.eq_ignore_ascii_case(b),
            (F::B(a), Lit::Flag(b)) => filter.cmp == Cmp::Eq && a == b,
            _ => false,
        }
    }

    /// The live rows a selector picks, in the runtime's default order (date, then name).
    /// `within` is the keys of the earlier result it narrows.
    #[must_use]
    pub fn select(&self, sel: &Selector, within: Option<&BTreeSet<String>>) -> Vec<&Row> {
        let range = sel.period.as_ref().and_then(|p| p.range(self.today));
        let mut out: Vec<&Row> = self
            .of_kind(&sel.kind)
            .filter(|r| sel.name.as_ref().is_none_or(|n| fold(&r.name) == fold(n)))
            .filter(|r| sel.filters.iter().all(|f| self.passes(r, f)))
            .filter(|r| match (&sel.period, range) {
                (None, _) => true,
                (Some(_), Some((a, b))) => r.date.is_some_and(|d| d >= a && d <= b),
                (Some(_), None) => false,
            })
            .filter(|r| {
                sel.link.as_ref().is_none_or(|l| {
                    self.related
                        .get(&l.key)
                        .is_some_and(|set| set.contains(&r.key))
                })
            })
            .filter(|r| within.is_none_or(|set| set.contains(&r.key)))
            .collect();
        out.sort_by(|a, b| {
            (a.date, a.name.to_lowercase(), &a.key).cmp(&(b.date, b.name.to_lowercase(), &b.key))
        });
        if let Some((field, desc)) = &sel.order {
            out.sort_by(|a, b| {
                let (x, y) = (a.num(field), b.num(field));
                let ord = x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal);
                if *desc { ord.reverse() } else { ord }
            });
            if let Some(limit) = sel.limit {
                out.truncate(limit);
            }
        }
        out
    }

    /// `op` of `field` over `rows`, one figure per currency for money (the runtime keeps the
    /// currencies apart) and one under `""` for anything else.
    #[must_use]
    pub fn fold_units(op: &str, field: &str, rows: &[&Row]) -> BTreeMap<String, f64> {
        let mut by: BTreeMap<String, Vec<&Row>> = BTreeMap::new();
        for r in rows {
            let unit = if field == "amount" {
                r.text("currency").unwrap_or_default().to_owned()
            } else {
                String::new()
            };
            by.entry(unit).or_default().push(r);
        }
        by.into_iter()
            .filter_map(|(unit, rs)| Some((unit, Self::fold(op, field, &rs)?)))
            .collect()
    }

    /// `op` of `field` over `rows`: `None` for no rows (a sum is 0, the rest undefined).
    #[must_use]
    pub fn fold(op: &str, field: &str, rows: &[&Row]) -> Option<f64> {
        let values: Vec<f64> = rows.iter().filter_map(|r| r.num(field)).collect();
        match op {
            "sum" => Some(values.iter().sum()),
            "avg" if !values.is_empty() => Some(values.iter().sum::<f64>() / values.len() as f64),
            "min" => values.iter().copied().reduce(f64::min),
            "max" => values.iter().copied().reduce(f64::max),
            _ => None,
        }
    }

    /// Live rows a name can mean: the name itself, a person's first name or nickname.
    #[must_use]
    pub fn matching(&self, kind: &str, name: &str) -> Vec<&Row> {
        let want = fold(name);
        self.of_kind(kind)
            .filter(|r| {
                fold(&r.name) == want
                    || (kind == "person"
                        && (r
                            .name
                            .split_whitespace()
                            .next()
                            .is_some_and(|f| fold(f) == want)
                            || r.text("nickname").is_some_and(|n| fold(n) == want)))
            })
            .collect()
    }

    /// Live rows of `kind` called `name` (case and spacing folded).
    #[must_use]
    pub fn named(&self, kind: &str, name: &str) -> Vec<&Row> {
        let want = fold(name);
        self.of_kind(kind)
            .filter(|r| fold(&r.name) == want)
            .collect()
    }
}

/// A name as the runtime compares it: lower case, single spaces.
#[must_use]
pub fn fold(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
