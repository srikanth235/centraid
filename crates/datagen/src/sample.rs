//! STAGE 2, THE INTENT SAMPLER: a pure function of a seed and a world, drawing typed intents from
//! the coverage grid ([`crate::grid`]).
//!
//! Sampling is target-first. The sampler picks a row the world holds, reads constraints off it
//! (its status, a threshold it clears, the period it falls in, the container it sits in) and
//! only then writes the selector, so a selector always selects at least its target. The planner
//! checks that the runtime selects exactly what [`crate::facts`] says it does.

use crate::catalog::Catalog;
use crate::facts::{F, Facts, Row, fold};
use crate::grid::{Cell, Grid, cell_of, draws, measurable};
use crate::intent::{
    Change, Cmp, Dep, Filter, Intent, Link, Lit, Measure, Outcome, Period, Reference, Scenario,
    Selector, Span, Target, TurnIntent, Val, VerbArg,
};
use crate::rng::Rng;
use crate::world::World;

/// Constraint counts, weighted toward three and more (the issue's finding: argument errors rise
/// with the number of constraints a call carries).
const CONSTRAINTS: &[(usize, u32)] = &[(0, 4), (1, 14), (2, 24), (3, 30), (4, 18), (5, 10)];

/// Log choices (`Catalog.verbs[log].choices`).
const LOG_CHOICES: &[&str] = &["call", "message", "visit", "coffee"];

const CREATE_NAMES: &[&str] = &[
    "Pick up the parcel",
    "Renew the passport",
    "Plan the weekend",
    "Water the plants",
    "Book the car service",
    "Call the landlord",
    "Order a birthday cake",
    "Fix the bike light",
    "Backup the laptop",
    "Return the library books",
    "Sort the receipts",
    "Email the school",
];
const RENAME_TAILS: &[&str] = &["follow-up", "draft", "final", "old", "new", "revised"];
const ROLES: &[&str] = &[
    "neighbour",
    "colleague",
    "cousin",
    "coach",
    "tutor",
    "dentist",
];

#[derive(Debug, Clone)]
enum Facet {
    Name(String),
    Filter(Filter),
    Period(Period),
    Link(Link),
}

impl Facet {
    fn dim(&self) -> String {
        match self {
            Self::Name(_) => "name".to_owned(),
            Self::Filter(f) => format!("f:{}", f.field),
            Self::Period(_) => "period".to_owned(),
            Self::Link(_) => "link".to_owned(),
        }
    }
}

pub struct Sampler<'a> {
    pub facts: &'a Facts,
    pub catalog: &'a Catalog,
    pub grid: &'a Grid,
    world: &'a World,
    /// Whether a read that finds nothing can be ended with `answer rows=@k` (see
    /// `WorldRun::empty_reads`); when it cannot, no empty read is drawn.
    pub empty_reads: bool,
}

fn nice_down(v: f64) -> f64 {
    if v < 10.0 {
        return v.floor().max(1.0);
    }
    let mag = 10f64.powf(v.log10().floor());
    let step = if mag >= 100.0 { mag / 2.0 } else { mag };
    ((v / step).floor() * step).max(1.0)
}

fn nice_up(v: f64) -> f64 {
    let down = nice_down(v);
    if down >= v {
        return down;
    }
    let mag = 10f64.powf(v.log10().floor().max(0.0));
    let step = if v >= 100.0 { mag / 2.0 } else { mag.max(1.0) };
    ((v / step).ceil() * step).max(1.0)
}

fn months_between(a: jiff::civil::Date, b: jiff::civil::Date) -> i64 {
    i64::from(b.year() - a.year()) * 12 + i64::from(b.month()) - i64::from(a.month())
}

impl<'a> Sampler<'a> {
    #[must_use]
    pub fn new(world: &'a World, facts: &'a Facts, catalog: &'a Catalog, grid: &'a Grid) -> Self {
        Self {
            facts,
            catalog,
            grid,
            world,
            empty_reads: true,
        }
    }

    #[must_use]
    pub fn with_empty_reads(mut self, on: bool) -> Self {
        self.empty_reads = on;
        self
    }

    fn app_of(&self, kind: &str) -> String {
        self.catalog
            .kind(kind)
            .map_or_else(String::new, |k| k.app.clone())
    }

    fn apps(&self, kinds: &[&str]) -> Vec<String> {
        let mut apps: Vec<String> = kinds.iter().map(|k| self.app_of(k)).collect();
        apps.sort();
        apps.dedup();
        apps
    }

    fn selector_apps(&self, sel: &Selector) -> Vec<String> {
        let mut kinds = vec![sel.kind.as_str()];
        for l in [&sel.link, &sel.anchor].into_iter().flatten() {
            kinds.push(l.kind.as_str());
        }
        self.apps(&kinds)
    }

    // ------------------------------------------------------------------ facets

    /// A container, person or event name the runtime can find a single row by.
    fn link_of(&self, key: &str) -> Option<Link> {
        let row = self.facts.row(key)?;
        if row.trashed
            || !matches!(
                row.kind.as_str(),
                "list" | "notebook" | "folder" | "album" | "person"
            )
        {
            return None;
        }
        (self.facts.named(&row.kind, &row.name).len() == 1).then(|| Link {
            kind: row.kind.clone(),
            key: row.key.clone(),
            name: row.name.clone(),
        })
    }

    fn period_for(&self, row: &Row, rng: &mut Rng) -> Option<Period> {
        let d = row.date?;
        let today = self.facts.today;
        let days = i64::from(d.since(today).ok()?.get_days());
        let mut options = Vec::new();
        if days.abs() <= 14 {
            options.push(Period::Day { rel: days });
        }
        let monday = |date: jiff::civil::Date| {
            date.checked_sub(
                jiff::Span::new().days(i64::from(date.weekday().to_monday_zero_offset())),
            )
            .ok()
        };
        if let (Some(a), Some(b)) = (monday(d), monday(today)) {
            let weeks = i64::from(a.since(b).ok()?.get_days()) / 7;
            if weeks.abs() <= 12 {
                options.push(Period::Week { rel: weeks });
            }
        }
        let months = months_between(today, d);
        if months.abs() <= 4 {
            options.push(Period::Month { rel: months });
        }
        let pad = rng.range(1, 6);
        let from = d.checked_sub(jiff::Span::new().days(pad)).ok()?;
        let to = d.checked_add(jiff::Span::new().days(pad)).ok()?;
        options.push(Period::Between {
            from: from.to_string(),
            to: to.to_string(),
        });
        Some(options[rng.below(options.len())].clone())
    }

    fn facets(&self, row: &Row, rng: &mut Rng) -> Vec<Facet> {
        let mut out = Vec::new();
        let eq = |field: &str, v: &str| {
            Facet::Filter(Filter {
                field: field.to_owned(),
                cmp: Cmp::Eq,
                value: Lit::Text(v.to_owned()),
            })
        };
        let flag = |field: &str| {
            Facet::Filter(Filter {
                field: field.to_owned(),
                cmp: Cmp::Eq,
                value: Lit::Flag(true),
            })
        };
        let kind = row.kind.as_str();
        // number thresholds the row clears
        for field in measurable(kind) {
            if kind == "budget" {
                break;
            }
            let Some(v) = row.num(field) else { continue };
            let (cmp, bound) = if v < 0.0 {
                (Cmp::Le, -nice_down(-v))
            } else if rng.chance(0.5) {
                (Cmp::Ge, nice_down(v))
            } else {
                (Cmp::Le, nice_up(v))
            };
            out.push(Facet::Filter(Filter {
                field: (*field).to_owned(),
                cmp,
                value: Lit::Num(bound),
            }));
        }
        match kind {
            "person" => {
                if let Some(role) = row.text("role") {
                    out.push(eq("role", role));
                }
                if row.fields.get("starred") == Some(&F::B(true)) {
                    out.push(flag("starred"));
                }
            }
            "task" => {
                if let Some(status) = row.text("status") {
                    out.push(eq("status", status));
                }
            }
            "note" | "document" | "photo" | "locker item" => {
                if row.fields.get("starred") == Some(&F::B(true)) {
                    out.push(flag("starred"));
                }
                if kind == "note" && row.fields.get("pinned") == Some(&F::B(true)) {
                    out.push(flag("pinned"));
                }
                if let Some(t) = row.text("type") {
                    out.push(eq("type", t));
                }
            }
            "transaction" => {
                for field in ["category", "account", "status"] {
                    if let Some(v) = row.text(field) {
                        out.push(eq(field, v));
                    }
                }
                out.push(Facet::Name(row.name.clone()));
            }
            "workout" => out.push(Facet::Name(row.name.clone())),
            "daily figure" => {
                if let Some(m) = row.text("metric") {
                    out.push(eq("metric", m));
                }
            }
            "account" => {
                if let Some(t) = row.text("type") {
                    out.push(eq("type", t));
                }
            }
            "list" => {
                if let Some(a) = row.text("area") {
                    out.push(eq("area", a));
                }
            }
            _ => {}
        }
        // a budget's month is not a date `when` can read, so no period selects one
        if row.kind != "budget"
            && let Some(p) = self.period_for(row, rng)
        {
            out.push(Facet::Period(p));
        }
        if let Some(related) = self.facts.related.get(&row.key) {
            for other in related {
                if let Some(link) = self.link_of(other) {
                    out.push(Facet::Link(link));
                }
            }
        }
        out
    }

    /// `n` facets of distinct dimensions.
    fn pick(&self, mut facets: Vec<Facet>, n: usize, rng: &mut Rng) -> Vec<Facet> {
        let mut out: Vec<Facet> = Vec::new();
        while out.len() < n && !facets.is_empty() {
            let f = facets.swap_remove(rng.below(facets.len()));
            if out.iter().all(|o| o.dim() != f.dim()) {
                out.push(f);
            }
        }
        out
    }

    fn selector(&self, kind: &str, facets: Vec<Facet>) -> Selector {
        let mut sel = Selector::of(kind);
        for f in facets {
            match f {
                Facet::Name(n) => sel.name = Some(n),
                Facet::Filter(f) => sel.filters.push(f),
                Facet::Period(p) => sel.period = Some(p),
                Facet::Link(l) => sel.link = Some(l),
            }
        }
        sel
    }

    fn live_rows(&self, kind: &str) -> Vec<&Row> {
        self.facts.of_kind(kind).collect()
    }

    fn constraints(&self, rng: &mut Rng) -> usize {
        *rng.weighted(CONSTRAINTS)
    }

    /// A target row of `kind`, and a selector of `c` facets that selects it. A row that cannot
    /// carry `c` facets is not accepted while another attempt might: the grid is weighted toward
    /// three constraints and more, and a world's richer rows are where those live.
    fn target_selector(
        &self,
        kind: &str,
        c: usize,
        rng: &mut Rng,
        max_rows: usize,
    ) -> Option<(Selector, Vec<String>)> {
        let rows = self.live_rows(kind);
        if rows.is_empty() {
            return None;
        }
        let mut best: Option<(Selector, Vec<String>, usize)> = None;
        for attempt in 0..24 {
            let row = rows[rng.below(rows.len())];
            let facets = if c == 0 {
                Vec::new()
            } else {
                self.facets(row, rng)
            };
            let mut n = c;
            for _ in 0..4 {
                let chosen = self.pick(facets.clone(), n, rng);
                let got = chosen.len();
                let sel = self.selector(kind, chosen);
                let set = self.facts.select(&sel, None);
                if !set.is_empty() && set.len() <= max_rows {
                    let keys: Vec<String> = set.iter().map(|r| r.key.clone()).collect();
                    if got >= c || attempt >= 16 {
                        return Some((sel, keys));
                    }
                    if best.as_ref().is_none_or(|(_, _, g)| got > *g) {
                        best = Some((sel, keys, got));
                    }
                    break;
                }
                n += 1;
            }
        }
        best.map(|(sel, keys, _)| (sel, keys))
    }

    /// A top-n ordering over a number field, only where the nth and (n+1)th rows differ.
    fn with_top(&self, mut sel: Selector, rng: &mut Rng) -> Option<Selector> {
        let fields = measurable(&sel.kind);
        if fields.is_empty() || sel.kind == "budget" {
            return None;
        }
        let field = fields[rng.below(fields.len())];
        let desc = rng.chance(0.6);
        let n = rng.range(1, 3) as usize;
        let mut probe = sel.clone();
        probe.order = Some((field.to_owned(), desc));
        let all = self.facts.select(&probe, None);
        if all.len() <= n || all.iter().any(|r| r.num(field).is_none()) {
            return None;
        }
        let (a, b) = (all[n - 1].num(field)?, all[n].num(field)?);
        if (a - b).abs() < 1e-9 {
            return None;
        }
        sel.order = Some((field.to_owned(), desc));
        sel.limit = Some(n);
        Some(sel)
    }

    // ------------------------------------------------------------------ one turn

    fn turn(
        &self,
        intent: Intent,
        reference: Reference,
        outcome: Outcome,
        dep: Option<(usize, Dep)>,
    ) -> TurnIntent {
        let apps = match &intent {
            Intent::Read { sel } | Intent::Count { sel } => self.selector_apps(sel),
            Intent::Measure { measure } => self.selector_apps(&measure.sel),
            Intent::Compare { a, b } => {
                let mut v = self.selector_apps(&a.sel);
                v.extend(self.selector_apps(&b.sel));
                v.sort();
                v.dedup();
                v
            }
            Intent::Write { target, arg, .. } => {
                let mut kinds = vec![target_kind(target)];
                if let VerbArg::Container(l) = arg {
                    kinds.push(l.kind.as_str());
                }
                self.apps(&kinds.into_iter().filter(|k| *k != "-").collect::<Vec<_>>())
            }
            Intent::Edit { target, .. } => self.apps(&[target_kind(target)]),
            Intent::Create { kind, .. } | Intent::Ask { kind, .. } => self.apps(&[kind]),
            Intent::Recall { .. } | Intent::Decline { .. } => Vec::new(),
        };
        TurnIntent {
            intent,
            reference,
            outcome,
            dep,
            apps,
        }
    }

    /// A first turn drawn from `cell`.
    #[must_use]
    pub fn opener(&self, cell: &Cell, rng: &mut Rng) -> Option<TurnIntent> {
        let c = self.constraints(rng);
        let kind = cell.kind.as_str();
        let outcome_roll = rng.below(100);
        match (cell.tool.as_str(), cell.verb.as_str()) {
            ("find", _) => {
                let (mut sel, _) = self.target_selector(kind, c, rng, ROW_CAP)?;
                let mut empty = outcome_roll < 10 && self.empty_reads;
                if empty {
                    match self.emptied(sel.clone(), rng) {
                        Some(none) => sel = none,
                        None => empty = false,
                    }
                } else if rng.chance(0.12)
                    && let Some(top) = self.with_top(sel.clone(), rng)
                {
                    sel = top;
                }
                let repair = !empty && outcome_roll >= 92;
                Some(self.turn(
                    Intent::Read { sel },
                    Reference::Select,
                    if empty {
                        Outcome::Empty
                    } else if repair {
                        Outcome::Repair
                    } else {
                        Outcome::Done
                    },
                    None,
                ))
            }
            ("compute", "count") => {
                let (mut sel, _) = self.target_selector(kind, c.saturating_sub(1), rng, 10_000)?;
                let mut empty = outcome_roll < 8;
                if empty {
                    match self.emptied(sel.clone(), rng) {
                        Some(none) => sel = none,
                        None => empty = false,
                    }
                }
                let repair = !empty && outcome_roll >= 93;
                Some(self.turn(
                    Intent::Count { sel },
                    Reference::Select,
                    if empty {
                        Outcome::Empty
                    } else if repair {
                        Outcome::Repair
                    } else {
                        Outcome::Done
                    },
                    None,
                ))
            }
            ("compute", "compare") => self.compare(kind, rng),
            ("compute", op) => {
                let grouped = op == "group";
                let fields = measurable(kind);
                let field = fields[rng.below(fields.len())];
                let op = if grouped {
                    *rng.pick(&["sum", "avg"])
                } else {
                    op
                };
                let (mut sel, _) = self.target_selector(kind, c.saturating_sub(1), rng, 10_000)?;
                let group = if grouped {
                    Some(self.group_for(&sel, rng)?)
                } else {
                    None
                };
                // the field must exist on the rows folded
                let rows = self.facts.select(&sel, None);
                if rows.iter().all(|r| r.num(field).is_none()) {
                    return None;
                }
                if sel.kind == "budget" {
                    sel.period = None;
                }
                let repair = outcome_roll >= 93;
                Some(self.turn(
                    Intent::Measure {
                        measure: Measure {
                            sel,
                            op: op.to_owned(),
                            field: field.to_owned(),
                            group,
                        },
                    },
                    Reference::Select,
                    if repair {
                        Outcome::Repair
                    } else {
                        Outcome::Done
                    },
                    None,
                ))
            }
            ("do", "undo") => None,
            ("do", verb) => self.write(kind, verb, rng, outcome_roll),
            ("edit", _) => self.edit(kind, rng, outcome_roll),
            ("create", _) => self.create(kind, rng, outcome_roll),
            ("ask", _) => self.ask(kind, rng),
            ("decline", reason) => Some(self.turn(
                Intent::Decline {
                    reason: reason.to_owned(),
                },
                Reference::Select,
                Outcome::Decline,
                None,
            )),
            _ => None,
        }
    }

    /// A selector that selects nothing: the same constraints under a period nothing falls in, or
    /// a threshold nothing clears.
    fn emptied(&self, mut sel: Selector, rng: &mut Rng) -> Option<Selector> {
        let dated =
            sel.kind != "budget" && self.live_rows(&sel.kind).iter().any(|r| r.date.is_some());
        if dated && sel.name.is_none() {
            for _ in 0..30 {
                let rel = rng.range(-14, 14);
                let day = self
                    .facts
                    .today
                    .checked_add(jiff::Span::new().days(rel * 7))
                    .ok()?;
                let to = day.checked_add(jiff::Span::new().days(2)).ok()?;
                let mut probe = sel.clone();
                probe.period = Some(Period::Between {
                    from: day.to_string(),
                    to: to.to_string(),
                });
                if self.facts.select(&probe, None).is_empty() {
                    return Some(probe);
                }
            }
        }
        if let Some(field) = measurable(&sel.kind).first().copied()
            && sel.kind != "budget"
        {
            let max = self
                .live_rows(&sel.kind)
                .iter()
                .filter_map(|r| r.num(field))
                .fold(0.0_f64, |a, b| a.max(b.abs()));
            let mut probe = sel.clone();
            probe.filters.retain(|f| f.field != field);
            probe.filters.push(Filter {
                field: field.to_owned(),
                cmp: Cmp::Gt,
                value: Lit::Num((max * 10.0).max(10.0).round()),
            });
            if self.facts.select(&probe, None).is_empty() {
                return Some(probe);
            }
        }
        // a name nothing is called
        sel.name = Some("Quillfeather".to_owned());
        self.facts.select(&sel, None).is_empty().then_some(sel)
    }

    fn group_for(&self, sel: &Selector, rng: &mut Rng) -> Option<String> {
        let rows = self.facts.select(sel, None);
        let mut options: Vec<&str> = Vec::new();
        match sel.kind.as_str() {
            "transaction" => options.extend(["category", "account"]),
            "daily figure" => options.extend(["metric"]),
            "task" => options.extend(["status"]),
            "person" => options.extend(["role"]),
            _ => {}
        }
        if rows.iter().any(|r| r.date.is_some()) {
            options.extend(["week", "month"]);
            if sel.kind == "transaction" {
                options.push("month");
            }
        }
        if options.is_empty() || rows.is_empty() {
            return None;
        }
        Some((*rng.pick(&options)).to_owned())
    }

    // ------------------------------------------------------------------ compare

    fn compare(&self, kind: &str, rng: &mut Rng) -> Option<TurnIntent> {
        let today = self.facts.today;
        let two = |a: Measure, b: Measure, this: &Self| {
            this.turn(
                Intent::Compare { a, b },
                Reference::Select,
                Outcome::Done,
                None,
            )
        };
        match kind {
            "transaction" => {
                // budget against spent: a month a budget exists for and the spend landed in
                let budgets: Vec<&Row> = self.live_rows("budget");
                if budgets.is_empty() {
                    return None;
                }
                for _ in 0..10 {
                    let b = budgets[rng.below(budgets.len())];
                    let F::T(cat) = b.fields.get("category")?.clone() else {
                        continue;
                    };
                    let month = b.date?;
                    let rel = months_between(today, month);
                    if !(-3..=0).contains(&rel) {
                        continue;
                    }
                    let mut spent = Selector::of("transaction");
                    spent.filters.push(Filter {
                        field: "category".to_owned(),
                        cmp: Cmp::Eq,
                        value: Lit::Text(cat),
                    });
                    spent.period = Some(Period::Month { rel });
                    // a budget is in the vault's currency, so the spend compared with it must be
                    // too (the runtime compares figures of one unit)
                    let rows = self.facts.select(&spent, None);
                    if rows.is_empty()
                        || rows
                            .iter()
                            .any(|r| r.text("currency") != Some(self.facts.base.as_str()))
                    {
                        continue;
                    }
                    let mut budget = Selector::of("budget");
                    budget.name = Some(b.name.clone());
                    let a = Measure {
                        sel: budget,
                        op: "sum".into(),
                        field: "amount".into(),
                        group: None,
                    };
                    let s = Measure {
                        sel: spent,
                        op: "sum".into(),
                        field: "amount".into(),
                        group: None,
                    };
                    return Some(two(a, s, self));
                }
                None
            }
            "workout" | "daily figure" => {
                // this period against the one before
                let (field, base) = if kind == "workout" {
                    let f = *rng.pick(measurable("workout"));
                    (f, Selector::of("workout"))
                } else {
                    let mut sel = Selector::of("daily figure");
                    sel.filters.push(Filter {
                        field: "metric".to_owned(),
                        cmp: Cmp::Eq,
                        value: Lit::Text(
                            rng.pick(&["steps", "sleep_min", "active_energy_kcal"])
                                .to_string(),
                        ),
                    });
                    ("value", sel)
                };
                let op = if kind == "workout" { "sum" } else { "avg" };
                let period = |rel| Period::Week { rel };
                for _ in 0..8 {
                    let r = -rng.range(0, 4);
                    let (mut a, mut b) = (base.clone(), base.clone());
                    if kind == "workout" && rng.chance(0.5) {
                        // two kinds of workout over one period
                        let kinds: Vec<String> = self
                            .live_rows("workout")
                            .iter()
                            .map(|w| w.name.clone())
                            .collect();
                        let (x, y) = (
                            kinds[rng.below(kinds.len())].clone(),
                            kinds[rng.below(kinds.len())].clone(),
                        );
                        if x == y {
                            continue;
                        }
                        a.name = Some(x);
                        b.name = Some(y);
                        a.period = Some(Period::Month { rel: -1 });
                        b.period = Some(Period::Month { rel: -1 });
                    } else {
                        a.period = Some(period(r));
                        b.period = Some(period(r - 1));
                    }
                    let m = |sel: Selector| Measure {
                        sel,
                        op: op.to_owned(),
                        field: field.to_owned(),
                        group: None,
                    };
                    let (ma, mb) = (m(a), m(b));
                    let ok = |x: &Measure| {
                        !self
                            .facts
                            .select(&x.sel, None)
                            .iter()
                            .all(|r| r.num(&x.field).is_none())
                            && !self.facts.select(&x.sel, None).is_empty()
                    };
                    if ok(&ma) && ok(&mb) {
                        return Some(two(ma, mb, self));
                    }
                }
                None
            }
            _ => None,
        }
    }

    // ------------------------------------------------------------------ writes

    /// How a row is named in a request: `(name to say, reference kind)`.
    fn say(&self, row: &Row, rng: &mut Rng) -> Option<(String, Reference)> {
        let roll = rng.below(100);
        if row.kind == "person" {
            if roll < 20
                && let Some(nick) = row.text("nickname")
            {
                let n = self
                    .facts
                    .of_kind("person")
                    .filter(|p| p.text("nickname").is_some_and(|x| fold(x) == fold(nick)))
                    .count();
                if n == 1 {
                    return Some((nick.to_owned(), Reference::Nickname));
                }
            }
            if roll < 45 {
                let first = row.name.split_whitespace().next()?;
                let n = self
                    .facts
                    .of_kind("person")
                    .filter(|p| {
                        p.name
                            .split_whitespace()
                            .next()
                            .is_some_and(|f| fold(f) == fold(first))
                    })
                    .count();
                if n == 1 {
                    return Some((first.to_owned(), Reference::Name));
                }
            }
        }
        if self.facts.named(&row.kind, &row.name).len() != 1 {
            return None;
        }
        if roll >= 88
            && let Some(typo) = misspell(&row.name, rng)
        {
            return Some((typo, Reference::Misspelling));
        }
        Some((row.name.clone(), Reference::Name))
    }

    fn write(&self, kind: &str, verb: &str, rng: &mut Rng, roll: usize) -> Option<TurnIntent> {
        if !draws(kind, verb) {
            return None;
        }
        let rows = self.live_rows(kind);
        let want_trashed = verb == "restore";
        let pool: Vec<&Row> = if want_trashed {
            self.facts
                .rows
                .iter()
                .filter(|r| r.kind == kind && r.trashed)
                .collect()
        } else {
            rows
        };
        let ok = |r: &&Row| -> bool {
            match verb {
                "complete" | "cancel" if kind == "task" => r.text("status") == Some("open"),
                "reopen" => r.text("status") == Some("completed"),
                "cancel" => true,
                "star" => r.fields.get("starred") == Some(&F::B(false)),
                "unstar" => r.fields.get("starred") == Some(&F::B(true)),
                "unlink" => self.transfer_leg(&r.key),
                _ => true,
            }
        };
        let pool: Vec<&Row> = pool.into_iter().filter(|r| ok(r)).collect();
        if pool.is_empty() {
            return None;
        }
        let row = pool[rng.below(pool.len())];
        let (target, reference) = if want_trashed {
            let same = self
                .facts
                .rows
                .iter()
                .filter(|r| r.kind == kind && fold(&r.name) == fold(&row.name))
                .count();
            if same != 1 {
                return None;
            }
            (
                Target::Name {
                    kind: kind.to_owned(),
                    name: row.name.clone(),
                    key: row.key.clone(),
                    trashed: true,
                },
                Reference::Name,
            )
        } else {
            self.target_for(row, rng)?
        };
        let arg = match verb {
            "reschedule" => {
                let rel = rng.range(1, 21);
                VerbArg::When(Period::Day { rel }.when())
            }
            "log" => VerbArg::Choice((*rng.pick(LOG_CHOICES)).to_owned()),
            "add_to" | "remove_from" => {
                let linked = self.facts.related.get(&row.key);
                let want_kind = match kind {
                    "task" => "list",
                    "note" => "notebook",
                    "document" => "folder",
                    _ => "album",
                };
                let options: Vec<Link> = if verb == "remove_from" {
                    linked
                        .into_iter()
                        .flatten()
                        .filter_map(|k| self.link_of(k))
                        .filter(|l| l.kind == want_kind)
                        .collect()
                } else {
                    self.live_rows(want_kind)
                        .iter()
                        .filter(|c| !linked.is_some_and(|l| l.contains(&c.key)))
                        .filter_map(|c| self.link_of(&c.key))
                        .collect()
                };
                if options.is_empty() {
                    return None;
                }
                VerbArg::Container(options[rng.below(options.len())].clone())
            }
            _ => VerbArg::None,
        };
        let repair = roll >= 92;
        Some(self.turn(
            Intent::Write {
                target,
                verb: verb.to_owned(),
                arg,
            },
            reference,
            if repair {
                Outcome::Repair
            } else {
                Outcome::Done
            },
            None,
        ))
    }

    /// How a request names `row` so that it picks that row alone: by name (or nickname, or a
    /// misspelling) when the name is its own, otherwise by constraints that select only it.
    fn target_for(&self, row: &Row, rng: &mut Rng) -> Option<(Target, Reference)> {
        let kind = row.kind.as_str();
        let by_name = |this: &Self, rng: &mut Rng| {
            let (name, reference) = this.say(row, rng)?;
            Some((
                Target::Name {
                    kind: kind.to_owned(),
                    name,
                    key: row.key.clone(),
                    trashed: false,
                },
                reference,
            ))
        };
        let by_select = |this: &Self, rng: &mut Rng| {
            let facets = this.facets(row, rng);
            let c = this.constraints(rng).max(1);
            (c..c + 3).find_map(|n| {
                let sel = this.selector(kind, this.pick(facets.clone(), n, rng));
                (this.facts.select(&sel, None).len() == 1)
                    .then_some((Target::Select { sel }, Reference::Select))
            })
        };
        if rng.chance(0.3) {
            by_select(self, rng).or_else(|| by_name(self, rng))
        } else {
            by_name(self, rng).or_else(|| by_select(self, rng))
        }
    }

    fn transfer_leg(&self, key: &str) -> bool {
        self.world
            .doc
            .get("transfers")
            .and_then(|t| t.as_array())
            .into_iter()
            .flatten()
            .any(|p| p["a"] == key || p["b"] == key)
    }

    fn edit(&self, kind: &str, rng: &mut Rng, roll: usize) -> Option<TurnIntent> {
        let rows: Vec<&Row> = self.live_rows(kind);
        if rows.is_empty() {
            return None;
        }
        let row = rows[rng.below(rows.len())];
        let (target, reference) = self.target_for(row, rng)?;
        let mut changes = Vec::new();
        let rename = |rng: &mut Rng| Change {
            field: "name".into(),
            value: Val::Text(format!("{} {}", row.name, rng.pick(RENAME_TAILS))),
        };
        match kind {
            "task" => match rng.below(3) {
                0 => changes.push(Change {
                    field: "priority".into(),
                    value: Val::Num(rng.range(1, 9) as f64),
                }),
                1 => {
                    changes.push(Change {
                        field: "effort".into(),
                        value: Val::Num((rng.range(1, 8) * 15) as f64),
                    });
                    if rng.chance(0.5) {
                        changes.push(Change {
                            field: "priority".into(),
                            value: Val::Num(rng.range(1, 9) as f64),
                        });
                    }
                }
                _ => changes.push(rename(rng)),
            },
            "person" => match rng.below(3) {
                0 => changes.push(Change {
                    field: "role".into(),
                    value: Val::Text((*rng.pick(ROLES)).into()),
                }),
                1 => changes.push(Change {
                    field: "cadence".into(),
                    value: Val::Num((rng.range(1, 12) * 7) as f64),
                }),
                _ => changes.push(rename(rng)),
            },
            "event" => match rng.below(2) {
                0 => changes.push(Change {
                    field: "duration".into(),
                    value: Val::Num((rng.range(1, 8) * 15) as f64),
                }),
                _ => changes.push(rename(rng)),
            },
            _ => changes.push(rename(rng)),
        }
        let repair = roll >= 92;
        Some(self.turn(
            Intent::Edit { target, changes },
            reference,
            if repair {
                Outcome::Repair
            } else {
                Outcome::Done
            },
            None,
        ))
    }

    fn create(&self, kind: &str, rng: &mut Rng, roll: usize) -> Option<TurnIntent> {
        let name = format!("{} {}", rng.pick(CREATE_NAMES), rng.range(2, 98));
        let mut fields = vec![Change {
            field: "name".into(),
            value: Val::Text(name),
        }];
        match kind {
            "task" => {
                fields.push(Change {
                    field: "due".into(),
                    value: Val::When(
                        Period::Day {
                            rel: rng.range(1, 30),
                        }
                        .when(),
                    ),
                });
                if rng.chance(0.6) {
                    fields.push(Change {
                        field: "priority".into(),
                        value: Val::Num(rng.range(1, 9) as f64),
                    });
                }
                if rng.chance(0.4) {
                    fields.push(Change {
                        field: "effort".into(),
                        value: Val::Num((rng.range(1, 8) * 15) as f64),
                    });
                }
            }
            "event" => {
                let day = rng.range(1, 30);
                fields.push(Change {
                    field: "start".into(),
                    value: Val::When(format!(
                        r#"{{"unit":"day","rel":{day},"time":"{:02}:00"}}"#,
                        rng.range(8, 18)
                    )),
                });
                fields.push(Change {
                    field: "duration".into(),
                    value: Val::Num((rng.range(1, 6) * 30) as f64),
                });
            }
            "person" => {
                if rng.chance(0.6) {
                    fields.push(Change {
                        field: "role".into(),
                        value: Val::Text((*rng.pick(ROLES)).into()),
                    });
                }
            }
            "note" => fields.push(Change {
                field: "body".into(),
                value: Val::Text("Remember to follow up on this.".into()),
            }),
            "list" => fields.push(Change {
                field: "area".into(),
                value: Val::Text("Household".into()),
            }),
            "locker item" => {
                fields.push(Change {
                    field: "type".into(),
                    value: Val::Text((*rng.pick(&["login", "wifi", "card"])).into()),
                });
            }
            "account" => fields.push(Change {
                field: "type".into(),
                value: Val::Text((*rng.pick(&["checking", "savings", "cash"])).into()),
            }),
            _ => {}
        }
        let repair = roll >= 92;
        Some(self.turn(
            Intent::Create {
                kind: kind.to_owned(),
                fields,
            },
            Reference::Select,
            if repair {
                Outcome::Repair
            } else {
                Outcome::Done
            },
            None,
        ))
    }

    fn ask(&self, kind: &str, rng: &mut Rng) -> Option<TurnIntent> {
        // names more than one live row answers to
        let mut groups: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();
        for r in self.live_rows(kind) {
            let name = if kind == "person" {
                r.name
                    .split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .to_owned()
            } else {
                r.name.clone()
            };
            *groups.entry(fold(&name)).or_default() += 1;
        }
        let shared: Vec<&String> = groups
            .iter()
            .filter(|(_, n)| **n > 1)
            .map(|(k, _)| k)
            .collect();
        if shared.is_empty() {
            return None;
        }
        let pick = shared[rng.below(shared.len())].clone();
        let original = self
            .live_rows(kind)
            .into_iter()
            .map(|r| {
                if kind == "person" {
                    r.name
                        .split_whitespace()
                        .next()
                        .unwrap_or_default()
                        .to_owned()
                } else {
                    r.name.clone()
                }
            })
            .find(|n| fold(n) == pick)?;
        let verb = ["complete", "star", "delete", "reschedule"][rng.below(4)];
        let verb = (draws(kind, verb) && rng.chance(0.5)).then(|| verb.to_owned());
        Some(self.turn(
            Intent::Ask {
                kind: kind.to_owned(),
                name: original,
                verb,
            },
            Reference::Name,
            Outcome::Ask,
            None,
        ))
    }

    // ------------------------------------------------------------------ cross-app

    /// A read, count or measure of `cell` whose period is the days around an event: the Money,
    /// Health or Photos rows of "the week of the dentist". `None` when the cell is not one a
    /// period can be put on.
    #[must_use]
    pub fn across(&self, cell: &Cell, rng: &mut Rng) -> Option<TurnIntent> {
        let kind = cell.kind.as_str();
        if matches!(kind, "event" | "budget" | "-")
            || cell.verb == "compare"
            || cell.verb == "group"
        {
            return None;
        }
        if self.live_rows(kind).iter().all(|r| r.date.is_none()) {
            return None;
        }
        let events: Vec<&Row> = self
            .live_rows("event")
            .into_iter()
            .filter(|e| e.date.is_some() && self.facts.named("event", &e.name).len() == 1)
            .collect();
        if events.is_empty() {
            return None;
        }
        for _ in 0..24 {
            let e = events[rng.below(events.len())];
            let d = e.date?;
            let pad = rng.range(0, 3);
            let from = d.checked_sub(jiff::Span::new().days(pad)).ok()?;
            let to = d.checked_add(jiff::Span::new().days(pad)).ok()?;
            let mut sel = Selector::of(kind);
            sel.period = Some(Period::Between {
                from: from.to_string(),
                to: to.to_string(),
            });
            sel.anchor = Some(Link {
                kind: "event".into(),
                key: e.key.clone(),
                name: e.name.clone(),
            });
            if kind == "daily figure" {
                sel.filters.push(Filter {
                    field: "metric".into(),
                    cmp: Cmp::Eq,
                    value: Lit::Text("steps".into()),
                });
            }
            let set = self.facts.select(&sel, None);
            if set.is_empty() {
                continue;
            }
            sel = self.enriched(sel, self.constraints(rng).saturating_sub(2), rng);
            let set = self.facts.select(&sel, None);
            let intent = match (cell.tool.as_str(), cell.verb.as_str()) {
                ("find", _) if set.len() <= ROW_CAP => Intent::Read { sel },
                ("compute", "count") => Intent::Count { sel },
                ("compute", op) => {
                    let fields = measurable(kind);
                    if fields.is_empty() {
                        return None;
                    }
                    let field = fields[rng.below(fields.len())];
                    if set.iter().all(|r| r.num(field).is_none()) {
                        continue;
                    }
                    Intent::Measure {
                        measure: Measure {
                            sel,
                            op: op.into(),
                            field: field.into(),
                            group: None,
                        },
                    }
                }
                _ => continue,
            };
            return Some(self.turn(intent, Reference::Select, Outcome::Done, None));
        }
        None
    }

    /// `sel` with up to `extra` more constraints, read off one of the rows it selects, so it still
    /// selects that row.
    fn enriched(&self, sel: Selector, extra: usize, rng: &mut Rng) -> Selector {
        let set = self.facts.select(&sel, None);
        if extra == 0 || set.is_empty() {
            return sel;
        }
        let row = set[rng.below(set.len())];
        let more: Vec<Facet> = self
            .facets(row, rng)
            .into_iter()
            .filter(|f| matches!(f, Facet::Filter(_)))
            .collect();
        let mut richer = self.selector_into(sel.clone(), self.pick(more, extra, rng));
        richer.filters.dedup_by(|a, b| a.field == b.field);
        if self.facts.select(&richer, None).is_empty() {
            sel
        } else {
            richer
        }
    }

    /// Rows of another app over the days the rows of a turn fall in: "what did I spend that day".
    fn hop(
        &self,
        set: &std::collections::BTreeSet<String>,
        from_kind: &str,
        rng: &mut Rng,
    ) -> Option<Intent> {
        let dates: Vec<jiff::civil::Date> =
            set.iter().filter_map(|k| self.facts.row(k)?.date).collect();
        let (lo, hi) = (dates.iter().min()?, dates.iter().max()?);
        let from_app = self.app_of(from_kind);
        let options: Vec<&str> = [
            "transaction",
            "workout",
            "photo",
            "task",
            "note",
            "daily figure",
        ]
        .into_iter()
        .filter(|k| self.app_of(k) != from_app)
        .collect();
        for _ in 0..8 {
            let kind = options[rng.below(options.len())];
            let mut sel = Selector::of(kind);
            sel.period = Some(Period::Between {
                from: lo.to_string(),
                to: hi.to_string(),
            });
            if kind == "daily figure" {
                sel.filters.push(Filter {
                    field: "metric".into(),
                    cmp: Cmp::Eq,
                    value: Lit::Text("steps".into()),
                });
            }
            if self.facts.select(&sel, None).is_empty() {
                continue;
            }
            let sel = self.enriched(sel, self.constraints(rng).saturating_sub(2), rng);
            let found = self.facts.select(&sel, None);
            let fields = measurable(kind);
            if !fields.is_empty() && rng.chance(0.6) {
                let field = fields[rng.below(fields.len())];
                if found.iter().all(|r| r.num(field).is_none()) {
                    continue;
                }
                let op = if kind == "daily figure" { "avg" } else { "sum" };
                return Some(Intent::Measure {
                    measure: Measure {
                        sel,
                        op: op.into(),
                        field: field.into(),
                        group: None,
                    },
                });
            }
            return Some(if found.len() <= ROW_CAP && kind != "daily figure" {
                Intent::Read { sel }
            } else {
                Intent::Count { sel }
            });
        }
        None
    }

    // ------------------------------------------------------------------ minimal pairs

    /// A single-turn twin of `base`'s first turn that differs from it in exactly one argument (a
    /// threshold, a period, an op, a date), with an answer that differs too. Two messages that
    /// differ in one argument are an axis of the grid, not a corpus of their own.
    #[must_use]
    pub fn pair(&self, base: &Scenario, rng: &mut Rng) -> Option<Scenario> {
        let first = base.turns.first()?;
        if first.dep.is_some() || first.outcome != Outcome::Done {
            return None;
        }
        let shifted = |p: &Period| match p {
            Period::Week { rel } => Some(Period::Week { rel: rel - 1 }),
            Period::Month { rel } => Some(Period::Month { rel: rel - 1 }),
            Period::Day { rel } => Some(Period::Day { rel: rel - 1 }),
            Period::Between { .. } => None,
        };
        let mut twin = first.clone();
        let changed = match &mut twin.intent {
            Intent::Read { sel } | Intent::Count { sel } => {
                let before = self
                    .facts
                    .select(sel, None)
                    .iter()
                    .map(|r| r.key.clone())
                    .collect::<Vec<_>>();
                let mut done = false;
                if let Some(f) = sel
                    .filters
                    .iter_mut()
                    .find(|f| matches!(f.value, Lit::Num(_)))
                {
                    if let Lit::Num(n) = &mut f.value {
                        *n = if rng.chance(0.5) {
                            nice_up(*n * 1.6 + 1.0)
                        } else {
                            nice_down(*n / 1.6).max(1.0)
                        };
                        done = true;
                    }
                } else if let Some(p) = sel.period.as_ref().and_then(shifted) {
                    sel.period = Some(p);
                    done = true;
                }
                let after = self
                    .facts
                    .select(sel, None)
                    .iter()
                    .map(|r| r.key.clone())
                    .collect::<Vec<_>>();
                done && before != after
                    && !after.is_empty()
                    && (matches!(first.intent, Intent::Count { .. }) || after.len() <= ROW_CAP)
            }
            Intent::Measure { measure } => {
                let before = Facts::fold_units(
                    &measure.op,
                    &measure.field,
                    &self.facts.select(&measure.sel, None),
                );
                if measure.group.is_none() && rng.chance(0.5) {
                    measure.op = ["sum", "avg", "min", "max"]
                        .into_iter()
                        .filter(|o| *o != measure.op)
                        .nth(rng.below(3))
                        .unwrap_or("sum")
                        .to_owned();
                } else if let Some(p) = measure.sel.period.as_ref().and_then(shifted) {
                    measure.sel.period = Some(p);
                } else {
                    return None;
                }
                let rows = self.facts.select(&measure.sel, None);
                let after = Facts::fold_units(&measure.op, &measure.field, &rows);
                !rows.is_empty() && !after.is_empty() && before != after
            }
            Intent::Write {
                arg: VerbArg::When(when),
                verb,
                ..
            } if verb == "reschedule" => {
                let rel = rng.range(22, 40);
                *when = Period::Day { rel }.when();
                true
            }
            _ => false,
        };
        changed.then(|| Scenario {
            id: format!("{}p", base.id),
            world: base.world.clone(),
            span: base.span,
            turns: vec![twin],
            tags: vec![format!("pair:{}", base.id)],
        })
    }

    // ------------------------------------------------------------------ sessions

    /// A session whose first turn is drawn from `cell`, with `extra` follow-up turns that lean on
    /// the turns before them.
    #[must_use]
    pub fn session(&self, id: &str, cell: &Cell, extra: usize, rng: &mut Rng) -> Option<Scenario> {
        let mut turns: Vec<TurnIntent> = Vec::new();
        let mut extra = extra;
        match (cell.tool.as_str(), cell.verb.as_str()) {
            ("answer", _) => {
                // a result shown again: two questions, then the first one's answer once more
                let value = cell.verb == "value";
                let pool: Vec<Cell> = self
                    .grid
                    .live()
                    .into_iter()
                    .filter(|c| {
                        if value {
                            c.tool == "compute" && !matches!(c.verb.as_str(), "compare" | "group")
                        } else {
                            c.tool == "find"
                        }
                    })
                    .cloned()
                    .collect();
                for _ in 0..12 {
                    let a = self.opener(&pool[rng.below(pool.len())], rng)?;
                    if a.outcome == Outcome::Empty {
                        continue;
                    }
                    turns.push(a);
                    break;
                }
                turns.first()?;
                for _ in 0..8 {
                    if let Some(mut b) = self.opener(&pool[rng.below(pool.len())], rng)
                        && b.outcome != Outcome::Empty
                    {
                        b.dep = None;
                        turns.push(b);
                        break;
                    }
                }
                if turns.len() < 2 {
                    return None;
                }
                turns.push(self.turn(
                    Intent::Recall { turn: 0, value },
                    Reference::Handle,
                    Outcome::Done,
                    Some((0, Dep::Handle)),
                ));
                extra = extra.saturating_sub(1);
            }
            ("do", "undo") => {
                let writes: Vec<Cell> = self
                    .grid
                    .live()
                    .into_iter()
                    .filter(|c| {
                        c.tool == "do"
                            && !matches!(c.verb.as_str(), "undo" | "restore" | "delete" | "log")
                    })
                    .cloned()
                    .collect();
                let first =
                    (0..10).find_map(|_| self.opener(&writes[rng.below(writes.len())], rng))?;
                turns.push(first);
                turns.push(self.follow_undo(0));
                extra = 0;
            }
            _ => {
                let across = matches!(cell.tool.as_str(), "find" | "compute") && rng.chance(0.7);
                let first = across
                    .then(|| self.across(cell, rng))
                    .flatten()
                    .or_else(|| self.opener(cell, rng))?;
                turns.push(first);
            }
        }
        if !self.grid.is_live(&cell_of(&turns[0])) {
            return None;
        }
        for _ in 0..extra {
            let Some(next) = self.follow(&turns, rng) else {
                break;
            };
            turns.push(next);
        }
        // across apps only where one turn joins two (a selector linked to a row of another app,
        // a period read off a row of another app) or leans on a turn of another app; two
        // unrelated questions in two apps are not an intent that joins them
        let joins = turns.iter().enumerate().any(|(i, t)| {
            t.apps.len() > 1
                || t.dep.is_some_and(|(on, _)| {
                    on < i
                        && !t.apps.is_empty()
                        && !turns[on].apps.is_empty()
                        && t.apps != turns[on].apps
                })
        });
        let span = if joins { Span::Across } else { Span::Single };
        Some(Scenario {
            id: id.to_owned(),
            world: self.world.id(),
            span,
            turns,
            tags: Vec::new(),
        })
    }

    fn follow_undo(&self, last: usize) -> TurnIntent {
        self.turn(
            Intent::Write {
                target: Target::Turn {
                    turn: last,
                    kind: "-".into(),
                },
                verb: "undo".into(),
                arg: VerbArg::None,
            },
            Reference::Pronoun,
            Outcome::Done,
            Some((last, Dep::Undo)),
        )
    }

    /// A follow-up that leans on what the turns before it showed. The branches that fit the turn
    /// before are tried in a seeded order until one yields.
    fn follow(&self, turns: &[TurnIntent], rng: &mut Rng) -> Option<TurnIntent> {
        let last = turns.len() - 1;
        let prev = &turns[last];
        let sets = self.sets(turns);
        let mut branches: Vec<u8> = match &prev.intent {
            Intent::Read { .. } | Intent::Count { .. } if prev.outcome != Outcome::Empty => {
                vec![0, 1, 2, 3, 4, 4, 5]
            }
            Intent::Measure { measure } if measure.group.is_none() => vec![10, 11, 11, 12, 13],
            Intent::Measure { .. } | Intent::Compare { .. } => vec![12],
            Intent::Write { .. } | Intent::Edit { .. } if prev.outcome == Outcome::Done => {
                if matches!(verb_of(&prev.intent), "undo" | "log") {
                    vec![]
                } else {
                    vec![20, 21, 22, 22]
                }
            }
            Intent::Create { .. } if prev.outcome == Outcome::Done => vec![30],
            _ => vec![],
        };
        // a seeded shuffle
        for i in (1..branches.len()).rev() {
            branches.swap(i, rng.below(i + 1));
        }
        let set = &sets[last];
        let kind = match &prev.intent {
            Intent::Read { sel } | Intent::Count { sel } => sel.kind.clone(),
            Intent::Measure { measure } => measure.sel.kind.clone(),
            Intent::Write { target, .. } | Intent::Edit { target, .. } => {
                target_kind(target).to_owned()
            }
            Intent::Create { kind, .. } => kind.clone(),
            _ => String::new(),
        };
        for branch in branches {
            let made: Option<TurnIntent> = match branch {
                // narrow the rows just shown with another constraint or two
                0 if !set.is_empty() => {
                    let keys: Vec<&String> = set.iter().collect();
                    (0..8).find_map(|_| {
                        let row = self.facts.row(keys[rng.below(keys.len())])?;
                        let chosen: Vec<Facet> = self
                            .pick(
                                self.facets(row, rng),
                                if rng.chance(0.7) { 2 } else { 1 },
                                rng,
                            )
                            .into_iter()
                            .filter(|f| !matches!(f, Facet::Link(_) | Facet::Name(_)))
                            .collect();
                        let mut narrow = Selector::of(&kind);
                        narrow.within = Some(last);
                        let narrow = self.selector_into(narrow, chosen);
                        let got = self.facts.select(&narrow, Some(set));
                        (!got.is_empty() && got.len() < set.len()).then(|| {
                            let intent = if rng.chance(0.25)
                                || matches!(kind.as_str(), "budget" | "daily figure")
                            {
                                Intent::Count { sel: narrow }
                            } else {
                                Intent::Read { sel: narrow }
                            };
                            self.turn(
                                intent,
                                Reference::Select,
                                Outcome::Done,
                                Some((last, Dep::Narrow)),
                            )
                        })
                    })
                }
                // act on the one row: "complete it"
                1 if set.len() == 1 && matches!(prev.intent, Intent::Read { .. }) => {
                    let row = self.facts.row(set.iter().next()?)?;
                    let verbs: Vec<&str> = self
                        .catalog
                        .kind(&kind)?
                        .verbs
                        .iter()
                        .map(String::as_str)
                        .filter(|v| draws(&kind, v))
                        .filter(|v| {
                            !matches!(
                                *v,
                                "delete"
                                    | "restore"
                                    | "unlink"
                                    | "add_to"
                                    | "remove_from"
                                    | "archive"
                            )
                        })
                        .collect();
                    pick_verb(&verbs, row, rng).map(|verb| {
                        let arg = match verb.as_str() {
                            "reschedule" => VerbArg::When(
                                Period::Day {
                                    rel: rng.range(1, 21),
                                }
                                .when(),
                            ),
                            "log" => VerbArg::Choice((*rng.pick(LOG_CHOICES)).into()),
                            _ => VerbArg::None,
                        };
                        self.turn(
                            Intent::Write {
                                target: Target::Turn {
                                    turn: last,
                                    kind: kind.clone(),
                                },
                                verb,
                                arg,
                            },
                            Reference::Pronoun,
                            Outcome::Done,
                            Some((last, Dep::Pronoun)),
                        )
                    })
                }
                // a total over those rows
                2 if !set.is_empty() => {
                    let fields = measurable(&kind);
                    if fields.is_empty() || kind == "budget" {
                        None
                    } else {
                        let field = fields[rng.below(fields.len())];
                        let rows: Vec<&Row> =
                            set.iter().filter_map(|k| self.facts.row(k)).collect();
                        (!rows.iter().all(|r| r.num(field).is_none())).then(|| {
                            let mut over = Selector::of(&kind);
                            over.within = Some(last);
                            self.turn(
                                Intent::Measure {
                                    measure: Measure {
                                        sel: over,
                                        op: (*rng.pick(&["sum", "avg", "max", "min"])).into(),
                                        field: field.into(),
                                        group: None,
                                    },
                                },
                                Reference::Pronoun,
                                Outcome::Done,
                                Some((last, Dep::Pronoun)),
                            )
                        })
                    }
                }
                // an earlier result by its handle
                3 if last >= 1
                    && turns[last - 1].outcome != Outcome::Empty
                    && !matches!(
                        turns[last - 1].intent,
                        Intent::Decline { .. }
                            | Intent::Create { .. }
                            | Intent::Write { .. }
                            | Intent::Edit { .. }
                            | Intent::Ask { .. }
                    ) =>
                {
                    let value = !matches!(turns[last - 1].intent, Intent::Read { .. });
                    Some(self.turn(
                        Intent::Recall {
                            turn: last - 1,
                            value,
                        },
                        Reference::Handle,
                        Outcome::Done,
                        Some((last - 1, Dep::Handle)),
                    ))
                }
                // the same rows' days, asked of another app
                4 | 11 | 13 if !set.is_empty() => self.hop(set, &kind, rng).map(|intent| {
                    self.turn(
                        intent,
                        Reference::Select,
                        Outcome::Done,
                        Some((last, Dep::Carry)),
                    )
                }),
                5 if !set.is_empty()
                    && set.len() <= ROW_CAP
                    && !matches!(kind.as_str(), "budget" | "daily figure")
                    && matches!(prev.intent, Intent::Count { .. }) =>
                {
                    // "which ones": the rows behind a count
                    let mut over = Selector::of(&kind);
                    over.within = Some(last);
                    Some(self.turn(
                        Intent::Read { sel: over },
                        Reference::Pronoun,
                        Outcome::Done,
                        Some((last, Dep::Pronoun)),
                    ))
                }
                // the same question of another period
                10 => {
                    let Intent::Measure { measure } = &prev.intent else {
                        continue;
                    };
                    let mut m = measure.clone();
                    let moved = match m.sel.period.clone()? {
                        Period::Week { rel } => Period::Week { rel: rel - 1 },
                        Period::Month { rel } => Period::Month { rel: rel - 1 },
                        Period::Day { rel } => Period::Day { rel: rel - 1 },
                        Period::Between { .. } => continue,
                    };
                    m.sel.period = Some(moved);
                    let rows = self.facts.select(&m.sel, None);
                    (!rows.is_empty() && !rows.iter().all(|r| r.num(&m.field).is_none())).then(
                        || {
                            self.turn(
                                Intent::Measure { measure: m },
                                Reference::Select,
                                Outcome::Done,
                                Some((last, Dep::Carry)),
                            )
                        },
                    )
                }
                // the rows behind a value
                12 if matches!(prev.intent, Intent::Measure { .. })
                    && !set.is_empty()
                    && set.len() <= ROW_CAP
                    && !matches!(kind.as_str(), "budget" | "daily figure") =>
                {
                    let mut over = Selector::of(&kind);
                    over.within = Some(last);
                    Some(self.turn(
                        Intent::Read { sel: over },
                        Reference::Pronoun,
                        Outcome::Done,
                        Some((last, Dep::Pronoun)),
                    ))
                }
                12 => Some(self.turn(
                    Intent::Recall {
                        turn: last,
                        value: true,
                    },
                    Reference::Pronoun,
                    Outcome::Done,
                    Some((last, Dep::Pronoun)),
                )),
                // show the row just changed, or take the change back
                20 if verb_of(&prev.intent) != "undo" => Some(self.follow_undo(last)),
                21 if !set.is_empty()
                    && !set.iter().any(|k| k.starts_with('+'))
                    && !matches!(verb_of(&prev.intent), "delete" | "cancel")
                    && !matches!(kind.as_str(), "budget" | "daily figure") =>
                {
                    let mut over = Selector::of(&kind);
                    over.within = Some(last);
                    Some(self.turn(
                        Intent::Read { sel: over },
                        Reference::Pronoun,
                        Outcome::Done,
                        Some((last, Dep::Pronoun)),
                    ))
                }
                22 if !set.is_empty() => self.hop(set, &kind, rng).map(|intent| {
                    self.turn(
                        intent,
                        Reference::Select,
                        Outcome::Done,
                        Some((last, Dep::Carry)),
                    )
                }),
                // a row just made, changed
                30 => {
                    let changes = match kind.as_str() {
                        "task" => vec![Change {
                            field: "priority".into(),
                            value: Val::Num(rng.range(1, 9) as f64),
                        }],
                        "person" => vec![Change {
                            field: "role".into(),
                            value: Val::Text((*rng.pick(ROLES)).into()),
                        }],
                        _ => vec![Change {
                            field: "name".into(),
                            value: Val::Text(format!(
                                "{} {}",
                                rng.pick(CREATE_NAMES),
                                rng.range(2, 98)
                            )),
                        }],
                    };
                    Some(self.turn(
                        Intent::Edit {
                            target: Target::Turn {
                                turn: last,
                                kind: kind.clone(),
                            },
                            changes,
                        },
                        Reference::Pronoun,
                        Outcome::Done,
                        Some((last, Dep::Pronoun)),
                    ))
                }
                _ => None,
            };
            if let Some(turn) = made
                && self.grid.is_live(&cell_of(&turn))
            {
                return Some(turn);
            }
        }
        None
    }

    /// The keys each turn leaves for the next to lean on, read off the world.
    fn sets(&self, turns: &[TurnIntent]) -> Vec<std::collections::BTreeSet<String>> {
        let mut out: Vec<std::collections::BTreeSet<String>> = Vec::new();
        for t in turns {
            let pick = |sel: &Selector,
                        out: &[std::collections::BTreeSet<String>]|
             -> std::collections::BTreeSet<String> {
                let within = sel.within.and_then(|w| out.get(w));
                self.facts
                    .select(sel, within)
                    .iter()
                    .map(|r| r.key.clone())
                    .collect()
            };
            let keys = match &t.intent {
                Intent::Read { sel } | Intent::Count { sel } => pick(sel, &out),
                Intent::Measure { measure } => pick(&measure.sel, &out),
                Intent::Write { target, .. } | Intent::Edit { target, .. } => match target {
                    Target::Name { key, .. } => std::iter::once(key.clone()).collect(),
                    Target::Select { sel } => pick(sel, &out),
                    Target::Turn { turn, .. } => out.get(*turn).cloned().unwrap_or_default(),
                },
                Intent::Recall { turn, .. } => out.get(*turn).cloned().unwrap_or_default(),
                _ => std::collections::BTreeSet::new(),
            };
            out.push(keys);
        }
        out
    }

    fn selector_into(&self, mut sel: Selector, facets: Vec<Facet>) -> Selector {
        for f in facets {
            match f {
                Facet::Name(n) => sel.name = Some(n),
                Facet::Filter(f) => sel.filters.push(f),
                Facet::Period(p) => sel.period = Some(p),
                Facet::Link(l) => sel.link = Some(l),
            }
        }
        sel
    }
}

const ROW_CAP: usize = 12;

fn verb_of(intent: &Intent) -> &str {
    match intent {
        Intent::Write { verb, .. } => verb,
        _ => "",
    }
}

fn target_kind(target: &Target) -> &str {
    match target {
        Target::Name { kind, .. } | Target::Turn { kind, .. } => kind,
        Target::Select { sel } => &sel.kind,
    }
}

fn pick_verb(verbs: &[&str], row: &Row, rng: &mut Rng) -> Option<String> {
    let ok: Vec<&&str> = verbs
        .iter()
        .filter(|v| match **v {
            "complete" | "cancel" if row.kind == "task" => row.text("status") == Some("open"),
            "reopen" => row.text("status") == Some("completed"),
            "star" => row.fields.get("starred") == Some(&F::B(false)),
            "unstar" => row.fields.get("starred") == Some(&F::B(true)),
            _ => true,
        })
        .collect();
    (!ok.is_empty()).then(|| (**rng.pick(&ok)).to_owned())
}

/// A name with one letter dropped, doubled or swapped: the way a thumb misspells.
fn misspell(name: &str, rng: &mut Rng) -> Option<String> {
    let chars: Vec<char> = name.chars().collect();
    let letters: Vec<usize> = (1..chars.len().saturating_sub(1))
        .filter(|i| chars[*i].is_alphabetic() && chars[*i + 1].is_alphabetic())
        .collect();
    if letters.is_empty() || chars.len() < 6 {
        return None;
    }
    let i = letters[rng.below(letters.len())];
    let mut out = chars.clone();
    match rng.below(3) {
        0 => {
            out.remove(i);
        }
        1 => out.insert(i, chars[i]),
        _ => out.swap(i, i + 1),
    }
    let typo: String = out.into_iter().collect();
    (typo != name).then_some(typo)
}
