//! STAGE 2, THE INTENT SAMPLER: a pure function of a seed and a world, drawing typed intents from
//! the coverage grid ([`crate::grid`]).
//!
//! Sampling is target-first. The sampler picks a row the world holds, reads constraints off it
//! (its status, a threshold it clears, the period it falls in, the container it sits in) and
//! only then writes the selector, so a selector always selects at least its target. The planner
//! checks that the runtime selects exactly what [`crate::facts`] says it does.

use centraid_assist::native::meta;

use crate::catalog::Catalog;
use crate::facts::{F, Facts, Row, fold};
use crate::fields;
use crate::grid::{Cell, Grid, cell_of, draws, measurable};
use crate::intent::{
    Change, Cmp, Dep, Filter, Intent, Link, Lit, Measure, Outcome, Period, Reference, Scenario,
    Selector, Span, Target, TurnIntent, Val, VerbArg,
};
use crate::pools;
use crate::rng::Rng;
use crate::world::World;

/// Constraint counts, weighted toward three and more (the issue's finding: argument errors rise
/// with the number of constraints a call carries).
const CONSTRAINTS: &[(usize, u32)] = &[(0, 4), (1, 14), (2, 24), (3, 30), (4, 18), (5, 10)];

/// Log choices (`Catalog.verbs[log].choices`).
const LOG_CHOICES: &[&str] = &["call", "message", "visit", "coffee"];

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

/// An opener whose draw of 0..100 is at least this is a repair: the runtime refuses its first call and the model repairs it.
const REPAIR_FROM: usize = 84;

/// A follow-up that can be a repair is one with this chance (percent).
const REPAIR_FOLLOW_UP: usize = 14;

/// An option of `find` that a plain draw of a read cell never uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Search {
    /// `text=`: a fuzzy name search across the vault, the kind narrowing it.
    Text,
    /// `trashed=true`: only rows in the trash.
    Trashed,
    /// `where field != value`.
    Not,
    /// `where field in ("a", "b")`.
    In,
    /// `where field is empty`.
    Empty,
    /// `where field is set`.
    Set,
    /// `rows=#n`: the one row found is opened, every fact and link of it.
    Rows,
    /// `exclude=@k`: "what else", the rows the turn before did not show. A turn of its own after one that reads.
    Exclude,
    /// `kind` as a comma list, with a period.
    Kinds,
    /// `when` with a weekday: `{"unit":"week","rel":r,"weekday":d}`.
    Weekday,
    /// `when` with a month by name: `{"unit":"month","name":n,"rel":r}`.
    MonthName,
    /// `when` with a time of day: `{"unit":"day","rel":r,"time":"HH:MM"}`.
    Clock,
    /// `when` with an end left open: since or until a day.
    Open,
    /// `order` and `limit`: the top few rows by a number field ("my three highest priorities"). A read of them, or
    /// (`compute`) the total or average over them.
    Top,
}

/// Kinds with a field whose values are a fixed list the world's rows hold, for `in`.
const ENUM_KINDS: [&str; 5] = ["task", "transaction", "account", "locker item", "workout"];

/// Kinds with a field some rows hold and some do not (a role, an effort, a username, a distance, a duration).
const PRESENCE_KINDS: [&str; 5] = ["person", "task", "locker item", "workout", "event"];

impl Search {
    pub const ALL: [Self; 14] = [
        Self::Text,
        Self::Trashed,
        Self::Not,
        Self::In,
        Self::Empty,
        Self::Set,
        Self::Rows,
        Self::Exclude,
        Self::Kinds,
        Self::Weekday,
        Self::MonthName,
        Self::Clock,
        Self::Open,
        Self::Top,
    ];

    /// Can the option be drawn for `kind` at all? A draw that no world of the kind can serve is not scheduled.
    #[must_use]
    pub fn serves(self, catalog: &Catalog, kind: &str) -> bool {
        let dated = catalog
            .kind(kind)
            .is_some_and(|k| k.date.is_some() && kind != "budget");
        match self {
            Self::Text | Self::Trashed | Self::Rows | Self::Exclude => true,
            Self::Not => matches!(kind, "task" | "transaction" | "account" | "locker item"),
            Self::In => ENUM_KINDS.contains(&kind),
            Self::Empty | Self::Set => PRESENCE_KINDS.contains(&kind),
            Self::Kinds | Self::Weekday | Self::MonthName | Self::Open => dated,
            Self::Clock => kind == "event",
            Self::Top => !measurable(kind).is_empty() && kind != "budget",
        }
    }
}

/// What a draw is aimed at beyond its cell: the supply the mix balances is made here, target first.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Aim {
    /// The field of a (kind, field) pair of `create` or `edit` the turn must set (the pair's canonical name).
    pub field: Option<String>,
    /// The turn finds nothing.
    pub empty: bool,
    /// The row is said by a nickname or a misspelling.
    pub nickname: bool,
    /// The read goes through an option of `find` a plain draw never uses.
    pub search: Option<Search>,
    /// The cell is a rare outcome (an ask, a decline, a read that finds nothing) drawn as the last turn of a session
    /// that starts with an ordinary turn of the same kind, not alone.
    pub tail: bool,
    /// A restore is drawn as a session of its own: the row is deleted, then restored by its name.
    pub trash: bool,
    /// The write of the cell is said together with a create in one message: two calls, the first saying `more`.
    pub more: bool,
}

/// What the run still has room for: a share the run has filled stops being drawn (pronoun and handle references of the
/// turns that point at rows, undo turns).
#[derive(Debug, Clone, Copy)]
pub struct Room {
    /// Room for the pronoun references that are not a recall (acting on "it", the rows behind a count).
    pub pronoun: bool,
    /// Room for a recall: an earlier answer shown again. It has the whole pronoun ceiling, the other pronoun turns only
    /// part of it, so the recall share can reach its target under the one ceiling.
    pub recall: bool,
    pub undo: bool,
}

impl Default for Room {
    fn default() -> Self {
        Self {
            pronoun: true,
            recall: true,
            undo: true,
        }
    }
}

/// An opener whose draw of 0..100 is below this finds nothing, when it can (a read).
const EMPTY_FIND: usize = 28;

/// The same for a count.
const EMPTY_COUNT: usize = 22;

/// A person said by nickname when the draw (0..100) is below this and the person has a unique one.
const NICKNAME_BELOW: usize = 35;

/// A row said with a misspelling of its name when the draw (0..100) is at least this.
const MISSPELL_FROM: usize = 72;

/// The (kind, field) pairs the sampler can draw a value for: [`crate::fields`] asks it, so a pair no draw can make is
/// listed as not live with the reason.
#[must_use]
pub fn draws_field(verb: &str, kind: &str, field: &str) -> bool {
    if field == "name" {
        return true;
    }
    match (verb, kind) {
        ("create", "person") => matches!(field, "cadence" | "nickname" | "role"),
        ("create", "event") => matches!(field, "description" | "duration" | "date"),
        ("create", "task") => matches!(field, "description" | "date" | "effort" | "priority"),
        ("create", "note") => field == "body",
        ("create", "document") => field == "text",
        ("create", "list") => field == "area",
        ("create", "locker item") => matches!(
            field,
            "card_number" | "cvv" | "notes" | "code" | "password" | "type" | "url" | "username"
        ),
        ("create", "workout") => matches!(
            field,
            "climb" | "distance" | "energy" | "heart_rate" | "moving" | "date"
        ),
        ("create", "account") => field == "type",
        ("edit", "person") => matches!(field, "cadence" | "met" | "nickname" | "role"),
        ("edit", "event") => matches!(field, "description" | "duration"),
        ("edit", "task") => matches!(field, "description" | "effort" | "priority" | "status"),
        ("edit", "note") => matches!(field, "body" | "pinned"),
        ("edit", "list") => field == "area",
        ("edit", "locker item") => matches!(
            field,
            "card_number" | "cvv" | "notes" | "code" | "password" | "url" | "username"
        ),
        ("edit", "workout") => matches!(
            field,
            "climb" | "distance" | "energy" | "heart_rate" | "moving"
        ),
        _ => false,
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
    /// How many names so far fell back on a numbered disambiguator ("Recipes 2") because every
    /// name in the kind's pool was taken.
    fallbacks: std::sync::atomic::AtomicUsize,
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
            fallbacks: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// How many names fell back on a numbered disambiguator so far.
    #[must_use]
    pub fn name_fallbacks(&self) -> usize {
        self.fallbacks.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Whether a row of `kind`, live or trashed, already answers to `name` (or, for a person, to
    /// its first name or nickname).
    fn taken(&self, kind: &str, name: &str) -> bool {
        let want = fold(name);
        let first = want.split(' ').next().unwrap_or_default().to_owned();
        self.facts.rows.iter().filter(|r| r.kind == kind).any(|r| {
            fold(&r.name) == want
                || (kind == "person"
                    && (r
                        .name
                        .split_whitespace()
                        .next()
                        .is_some_and(|f| fold(f) == first)
                        || r.text("nickname").is_some_and(|n| fold(n) == first)))
        })
    }

    /// A name for a row of `kind` that no row of the kind (live or trashed) has and that is not in
    /// `avoid`: drawn from the kind's pool (a person is `first last` from the split's pools).
    /// Only when the pool is spent does it add a number, and that is counted.
    fn fresh_name(&self, kind: &str, rng: &mut Rng, avoid: &[&str]) -> String {
        let free =
            |name: &str| !avoid.iter().any(|a| fold(a) == fold(name)) && !self.taken(kind, name);
        let pool = pools::new_names(kind);
        if kind == "person" {
            let (firsts, lasts) = pools::new_people(self.world.spec.split);
            for _ in 0..64 {
                let name = format!("{} {}", rng.pick(firsts), rng.pick(lasts));
                if free(&name) {
                    return name;
                }
            }
        } else if let Some(pool) = &pool {
            for _ in 0..pool.len() {
                let name = *rng.pick(pool);
                if free(name) {
                    return name.to_owned();
                }
            }
            let start = rng.below(pool.len());
            if let Some(name) = (0..pool.len())
                .map(|i| pool[(start + i) % pool.len()])
                .find(|n| free(n))
            {
                return name.to_owned();
            }
        }
        self.fallbacks
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let base = match &pool {
            Some(pool) => (*rng.pick(pool)).to_owned(),
            None if kind == "person" => {
                let (firsts, lasts) = pools::new_people(self.world.spec.split);
                format!("{} {}", rng.pick(firsts), rng.pick(lasts))
            }
            None => format!("New {kind}"),
        };
        (2..)
            .map(|n| format!("{base} {n}"))
            .find(|n| free(n))
            .unwrap_or(base)
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
        kinds.extend(sel.also.iter().map(String::as_str));
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
    fn with_top(&self, sel: Selector, rng: &mut Rng) -> Option<Selector> {
        let fields = measurable(&sel.kind);
        if fields.is_empty() || sel.kind == "budget" {
            return None;
        }
        let field = fields[rng.below(fields.len())];
        self.top_by(sel, field, false, rng)
    }

    /// [`Self::with_top`] by `field`. A field some rows lack cannot rank them, so with `ranked` the rows that have it are
    /// the ones ranked (`field is set`).
    fn top_by(
        &self,
        mut sel: Selector,
        field: &str,
        ranked: bool,
        rng: &mut Rng,
    ) -> Option<Selector> {
        if sel.kind == "budget" || (ranked && sel.filters.iter().any(|f| f.field == field)) {
            return None;
        }
        if ranked {
            sel.filters.push(Filter {
                field: field.to_owned(),
                cmp: Cmp::IsSet,
                value: Lit::List(Vec::new()),
            });
        }
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
            Intent::Both { first, second } => {
                let mut v = self.turn((**first).clone(), reference, outcome, None).apps;
                v.extend(self.turn((**second).clone(), reference, outcome, None).apps);
                v.sort();
                v.dedup();
                v
            }
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
        self.opener_aim(cell, &Aim::default(), rng)
    }

    /// A first turn drawn from `cell` and aimed as `aim` says; `None` when the world holds nothing to draw it from.
    #[must_use]
    pub fn opener_aim(&self, cell: &Cell, aim: &Aim, rng: &mut Rng) -> Option<TurnIntent> {
        if self.world.settings.is_empty() {
            return self.empty_opener(cell, aim, rng);
        }
        let c = self.constraints(rng);
        let kind = cell.kind.as_str();
        let outcome_roll = rng.below(100);
        match (cell.tool.as_str(), cell.verb.as_str()) {
            ("find", _) => {
                if let Some(search) = aim.search {
                    return self.search_read(kind, search, rng);
                }
                let (mut sel, _) = self.target_selector(kind, c, rng, ROW_CAP)?;
                let mut empty = (aim.empty || outcome_roll < EMPTY_FIND) && self.empty_reads;
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
                if aim.empty && !empty {
                    return None;
                }
                let repair = !empty && outcome_roll >= REPAIR_FROM;
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
            ("compute", "count") if aim.search == Some(Search::Trashed) => {
                // how many are in the trash
                self.facts
                    .rows
                    .iter()
                    .any(|r| r.kind == kind && r.trashed)
                    .then(|| {
                        let mut sel = Selector::of(kind);
                        sel.trashed = true;
                        self.turn(
                            Intent::Count { sel },
                            Reference::Select,
                            Outcome::Done,
                            None,
                        )
                    })
            }
            ("compute", "count") => {
                let (mut sel, _) = self.target_selector(kind, c.saturating_sub(1), rng, 10_000)?;
                let mut empty = aim.empty || outcome_roll < EMPTY_COUNT;
                if empty {
                    match self.emptied(sel.clone(), rng) {
                        Some(none) => sel = none,
                        None => empty = false,
                    }
                }
                if aim.empty && !empty {
                    return None;
                }
                let repair = !empty && outcome_roll >= REPAIR_FROM;
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
                if aim.search == Some(Search::Top) && !grouped && kind != "budget" {
                    // a total or an average over the few rows that rank highest or lowest on the field itself
                    let desc = rng.chance(0.6);
                    let n = rng.range(2, 4) as usize;
                    let mut probe = sel.clone();
                    probe.order = Some((field.to_owned(), desc));
                    let all = self.facts.select(&probe, None);
                    if all.len() <= n
                        || all.iter().any(|r| r.num(field).is_none())
                        || (all[n - 1].num(field)? - all[n].num(field)?).abs() < 1e-9
                    {
                        return None;
                    }
                    sel.order = Some((field.to_owned(), desc));
                    sel.limit = Some(n);
                    return Some(self.turn(
                        Intent::Measure {
                            measure: Measure {
                                sel,
                                op: op.to_owned(),
                                field: field.to_owned(),
                                group: None,
                            },
                        },
                        Reference::Select,
                        Outcome::Done,
                        None,
                    ));
                }
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
                let repair = outcome_roll >= REPAIR_FROM;
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
            ("do", verb) => self.write(kind, verb, rng, outcome_roll, aim.nickname),
            ("edit", _) => self.edit(kind, aim.field.as_deref(), aim.nickname, rng, outcome_roll),
            ("create", _) => self.create(kind, aim.field.as_deref(), rng, outcome_roll),
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

    /// The first turn in a new member's empty vault: nothing to draw a row from, so a read or a count finds nothing, a
    /// create makes the first row, and a decline is a decline. Every other cell has no turn here.
    fn empty_opener(&self, cell: &Cell, aim: &Aim, rng: &mut Rng) -> Option<TurnIntent> {
        let kind = cell.kind.as_str();
        match (cell.tool.as_str(), cell.verb.as_str()) {
            ("find", _) if self.empty_reads => Some(self.turn(
                Intent::Read {
                    sel: Selector::of(kind),
                },
                Reference::Select,
                Outcome::Empty,
                None,
            )),
            ("compute", "count") => Some(self.turn(
                Intent::Count {
                    sel: Selector::of(kind),
                },
                Reference::Select,
                Outcome::Empty,
                None,
            )),
            ("create", _) => self.create(kind, aim.field.as_deref(), rng, 0),
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

    /// `own` as the one condition of a selector narrowed by up to two other facets of `row`, until it selects between one
    /// row and a screenful.
    fn narrowed(&self, kind: &str, row: &Row, own: &Filter, rng: &mut Rng) -> Option<Selector> {
        for extra in 0..3 {
            let narrowing: Vec<Facet> = self
                .pick(self.facets(row, rng), extra, rng)
                .into_iter()
                .filter(|f| {
                    matches!(f, Facet::Filter(f) if f.field != own.field)
                        || matches!(f, Facet::Period(_))
                })
                .collect();
            let mut sel = self.selector(kind, narrowing);
            sel.filters.push(own.clone());
            let n = self.facts.select(&sel, None).len();
            if (1..=ROW_CAP).contains(&n) {
                return Some(sel);
            }
        }
        None
    }

    /// A read through an option of `find` that a plain draw never uses: a fuzzy search of the names (`text`), the rows in
    /// the trash (`trashed`), a fixed-list field that is not a value or is one of some (`!=`, `in`), a field that is
    /// empty or set, the one row found opened (`rows`), a read of two kinds at once, or a period said with a weekday, a
    /// month by name, a time of day or an open end. `None` when the world holds no such row. `exclude` is a turn after a
    /// read, drawn by [`Self::exclusion`].
    fn search_read(&self, kind: &str, search: Search, rng: &mut Rng) -> Option<TurnIntent> {
        let live = self.live_rows(kind);
        let mut reference = Reference::Select;
        let sel = match search {
            Search::Text => {
                let row = live.get(rng.below(live.len().max(1)))?;
                // the longest plain word of the name: what a person would search by
                let word = row
                    .name
                    .split_whitespace()
                    .filter(|w| w.chars().count() >= 4 && w.chars().all(char::is_alphabetic))
                    .max_by_key(|w| w.chars().count())?
                    .to_lowercase();
                let mut sel = Selector::of(kind);
                sel.text = Some(word);
                sel
            }
            Search::Trashed => {
                let mut sel = Selector::of(kind);
                sel.trashed = true;
                sel
            }
            Search::Not => {
                let field = match kind {
                    "task" | "transaction" => "status",
                    "account" | "locker item" => "type",
                    _ => return None,
                };
                let values: Vec<String> = self
                    .catalog
                    .kind(kind)?
                    .fields
                    .iter()
                    .find(|f| f.name == field)?
                    .values
                    .clone();
                let row = live.get(rng.below(live.len().max(1)))?;
                let have = row.text(field)?;
                let other: Vec<&String> = values.iter().filter(|v| *v != have).collect();
                let value = (*other.get(rng.below(other.len().max(1)))?).clone();
                let own = Filter {
                    field: field.to_owned(),
                    cmp: Cmp::Ne,
                    value: Lit::Text(value),
                };
                self.narrowed(kind, row, &own, rng)?
            }
            Search::In => {
                let fields: Vec<&crate::catalog::Field> = self
                    .catalog
                    .kind(kind)?
                    .fields
                    .iter()
                    .filter(|f| {
                        !f.values.is_empty() && live.iter().any(|r| r.text(&f.name).is_some())
                    })
                    .collect();
                let field = *fields.get(rng.below(fields.len().max(1)))?;
                // `open` also reads as the started ones on a status that has them, which the index does not: leave it out
                let usable: Vec<&String> = field
                    .values
                    .iter()
                    .filter(|v| !(field.name == "status" && *v == "open"))
                    .collect();
                let holders: Vec<&&Row> = live
                    .iter()
                    .filter(|r| {
                        r.text(&field.name)
                            .is_some_and(|v| usable.iter().any(|u| u.eq_ignore_ascii_case(v)))
                    })
                    .collect();
                let row = **holders.get(rng.below(holders.len().max(1)))?;
                let have = row.text(&field.name)?.to_owned();
                let mut others: Vec<&String> = usable
                    .into_iter()
                    .filter(|v| !v.eq_ignore_ascii_case(&have))
                    .collect();
                let mut list = vec![have];
                for _ in 0..rng.range(1, 2) {
                    if others.is_empty() {
                        break;
                    }
                    list.push(others.swap_remove(rng.below(others.len())).clone());
                }
                if list.len() < 2 {
                    return None;
                }
                for i in (1..list.len()).rev() {
                    list.swap(i, rng.below(i + 1));
                }
                let own = Filter {
                    field: field.name.clone(),
                    cmp: Cmp::In,
                    value: Lit::List(list),
                };
                self.narrowed(kind, row, &own, rng)?
            }
            Search::Empty | Search::Set => {
                let set = search == Search::Set;
                let presence = |field: &str, set: bool| Filter {
                    field: field.to_owned(),
                    cmp: if set { Cmp::IsSet } else { Cmp::IsEmpty },
                    value: Lit::List(Vec::new()),
                };
                // fields some of the world's rows hold and some do not
                let fields: Vec<&str> = self
                    .catalog
                    .kind(kind)?
                    .fields
                    .iter()
                    .map(|f| f.name.as_str())
                    .filter(|f| {
                        let n = live
                            .iter()
                            .filter(|r| self.facts.passes(r, &presence(f, true)))
                            .count();
                        n > 0 && n < live.len()
                    })
                    .collect();
                let field = *fields.get(rng.below(fields.len().max(1)))?;
                let own = presence(field, set);
                let holders: Vec<&&Row> =
                    live.iter().filter(|r| self.facts.passes(r, &own)).collect();
                let row = **holders.get(rng.below(holders.len().max(1)))?;
                self.narrowed(kind, row, &own, rng)?
            }
            Search::Rows => {
                let row = live.get(rng.below(live.len().max(1)))?;
                if row.name.is_empty() || self.facts.named(kind, &row.name).len() != 1 {
                    return None;
                }
                let mut sel = Selector::of(kind);
                sel.name = Some(row.name.clone());
                sel.open = true;
                reference = Reference::Name;
                sel
            }
            Search::Top => {
                // a few of the many: the selector is broad (up to one constraint) so there is a field to rank, and a field
                // some rows lack ranks the ones that have it
                let fields = measurable(kind);
                (0..16).find_map(|attempt| {
                    let field = fields[rng.below(fields.len())];
                    let base = if attempt % 2 == 0 {
                        self.target_selector(kind, rng.below(2), rng, 10_000)
                            .map_or_else(|| Selector::of(kind), |(sel, _)| sel)
                    } else {
                        Selector::of(kind)
                    };
                    self.top_by(base, field, attempt >= 4, rng)
                })?
            }
            Search::Exclude => return None,
            Search::Kinds => {
                let dated: Vec<&str> = self
                    .catalog
                    .kinds
                    .iter()
                    .filter(|k| k.date.is_some() && k.name != kind && k.name != "budget")
                    .map(|k| k.name.as_str())
                    .collect();
                let rows: Vec<&&Row> = live.iter().filter(|r| r.date.is_some()).collect();
                let mut found = None;
                for _ in 0..12 {
                    let other = *dated.get(rng.below(dated.len().max(1)))?;
                    let row = **rows.get(rng.below(rows.len().max(1)))?;
                    let Some(period) = self.period_for(row, rng) else {
                        continue;
                    };
                    let mut sel = Selector::of(kind);
                    sel.also = vec![other.to_owned()];
                    sel.period = Some(period);
                    let each = |k: &str| {
                        let mut one = sel.clone();
                        one.also.clear();
                        k.clone_into(&mut one.kind);
                        self.facts.select(&one, None).len()
                    };
                    if each(kind) > 0 && each(other) > 0 {
                        found = Some(sel);
                        break;
                    }
                }
                found?
            }
            Search::Weekday | Search::MonthName | Search::Clock => {
                let rows: Vec<&&Row> = live
                    .iter()
                    .filter(|r| r.date.is_some() && (search != Search::Clock || r.clock.is_some()))
                    .collect();
                let row = **rows.get(rng.below(rows.len().max(1)))?;
                let (day, today) = (row.date?, self.facts.today);
                let period = match search {
                    Search::Weekday => {
                        let monday = |d: jiff::civil::Date| {
                            d.checked_sub(
                                jiff::Span::new()
                                    .days(i64::from(d.weekday().to_monday_zero_offset())),
                            )
                            .ok()
                        };
                        let weeks =
                            i64::from(monday(day)?.since(monday(today)?).ok()?.get_days()) / 7;
                        Period::Weekday {
                            rel: weeks,
                            weekday: day.weekday().to_monday_one_offset(),
                        }
                    }
                    Search::MonthName => {
                        let name = day.month();
                        let rel = (-3..=3).find(|rel| {
                            Period::NamedMonth { rel: *rel, name }
                                .range(today)
                                .is_some_and(|(a, b)| a <= day && day <= b)
                        })?;
                        Period::NamedMonth { rel, name }
                    }
                    _ => Period::Clock {
                        rel: i64::from(day.since(today).ok()?.get_days()),
                        time: row.clock.clone()?,
                    },
                };
                let mut sel = Selector::of(kind);
                sel.period = Some(period);
                if search == Search::MonthName {
                    // a month holds more rows than a screenful: narrow it as a plain period is
                    let narrowing: Vec<Facet> = self
                        .pick(self.facets(row, rng), 1, rng)
                        .into_iter()
                        .filter(|f| matches!(f, Facet::Filter(_) | Facet::Link(_)))
                        .collect();
                    sel = self.selector_into(sel, narrowing);
                }
                sel
            }
            Search::Open => {
                let mut dated: Vec<jiff::civil::Date> =
                    live.iter().filter_map(|r| r.date).collect();
                dated.sort();
                if dated.len() < 2 {
                    return None;
                }
                let today = self.facts.today;
                let since = rng.chance(0.5);
                let take = rng.range(1, 6) as usize;
                let edge = if since {
                    dated[dated.len().saturating_sub(take)]
                } else {
                    dated[(take - 1).min(dated.len() - 1)]
                };
                let days = i64::from(edge.since(today).ok()?.get_days());
                let end = if days.abs() <= 45 {
                    Period::Day { rel: days }
                } else {
                    Period::Date {
                        date: edge.to_string(),
                    }
                };
                let mut sel = Selector::of(kind);
                sel.period = Some(if since {
                    Period::Open {
                        from: Some(Box::new(end)),
                        to: None,
                    }
                } else {
                    Period::Open {
                        from: None,
                        to: Some(Box::new(end)),
                    }
                });
                sel
            }
        };
        let n = self.facts.select(&sel, None).len();
        if !(1..=ROW_CAP).contains(&n) {
            return None;
        }
        Some(self.turn(Intent::Read { sel }, reference, Outcome::Done, None))
    }

    /// "What else": a read of the rows the turn before did not show, as two turns. The first reads rows by a few
    /// constraints and the second asks again with one constraint fewer and `exclude=@k`, so it holds what the first
    /// left out. `None` when the world holds no such pair of reads.
    fn exclusion(&self, kind: &str, count: bool, rng: &mut Rng) -> Option<Vec<TurnIntent>> {
        for _ in 0..8 {
            let c = 1 + rng.below(3);
            let (first, keys) = self.target_selector(kind, c, rng, ROW_CAP)?;
            let shown: std::collections::BTreeSet<String> = keys.into_iter().collect();
            let mut broad = first.clone();
            // the member drops one constraint: "what else is there?"
            let mut drops: Vec<u8> = Vec::new();
            if !broad.filters.is_empty() {
                drops.push(0);
            }
            if broad.period.is_some() {
                drops.push(1);
            }
            if broad.link.is_some() {
                drops.push(2);
            }
            match drops.get(rng.below(drops.len().max(1))) {
                Some(0) => {
                    let at = rng.below(broad.filters.len());
                    broad.filters.remove(at);
                }
                Some(1) => broad.period = None,
                Some(2) => broad.link = None,
                _ => {}
            }
            broad.name = None;
            broad.exclude = Some(0);
            let rest = self.facts.select_but(&broad, None, Some(&shown)).len();
            if (1..=if count { 10_000 } else { ROW_CAP }).contains(&rest) {
                return Some(vec![
                    self.turn(
                        Intent::Read { sel: first },
                        Reference::Select,
                        Outcome::Done,
                        None,
                    ),
                    self.turn(
                        if count {
                            Intent::Count { sel: broad }
                        } else {
                            Intent::Read { sel: broad }
                        },
                        Reference::Select,
                        Outcome::Done,
                        Some((0, Dep::Else)),
                    ),
                ]);
            }
        }
        None
    }

    /// A selector that selects nothing: the same constraints under a period nothing falls in, or
    /// a threshold nothing clears.
    fn emptied(&self, sel: Selector, rng: &mut Rng) -> Option<Selector> {
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
        // a name nothing is called ends a read without a `@k` (the runtime's by-name miss), so
        // there is no empty read to draw for a kind with no date and no number field
        None
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
                    let cat = self.facts.titles.get(&cat).cloned().unwrap_or(cat);
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
    fn say(&self, row: &Row, rng: &mut Rng, nick: bool) -> Option<(String, Reference)> {
        let roll = if nick { 0 } else { rng.below(100) };
        if row.kind == "person" {
            if roll < NICKNAME_BELOW
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
            if !nick && roll < 45 {
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
        if (nick || roll >= MISSPELL_FROM)
            && let Some(typo) = misspell(&row.name, rng)
        {
            return Some((typo, Reference::Misspelling));
        }
        if nick {
            return None;
        }
        Some((row.name.clone(), Reference::Name))
    }

    /// Can `verb` be done to `r` now (a task to complete is open, a person to star is not starred)?
    fn verb_fits(&self, kind: &str, verb: &str, r: &Row) -> bool {
        match verb {
            "complete" | "cancel" if kind == "task" => r.text("status") == Some("open"),
            "reopen" => r.text("status") == Some("completed"),
            "cancel" => true,
            "star" => r.fields.get("starred") == Some(&F::B(false)),
            "unstar" => r.fields.get("starred") == Some(&F::B(true)),
            "unlink" => self.transfer_leg(&r.key),
            _ => true,
        }
    }

    /// How many rows the sampler's world holds against a normal one (`Settings::scale`).
    #[must_use]
    pub fn world_scale(&self) -> f64 {
        self.world.settings.scale
    }

    /// The names a kind's live rows answer to as a person says them (a person by first name, anything else by its name),
    /// each with how many rows it reaches: the material of an ask-or-act pair.
    #[must_use]
    pub fn spoken_names(&self, kind: &str) -> std::collections::BTreeMap<String, (String, usize)> {
        let mut out: std::collections::BTreeMap<String, (String, usize)> =
            std::collections::BTreeMap::new();
        for r in self.live_rows(kind) {
            let said = if kind == "person" {
                r.name
                    .split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .to_owned()
            } else {
                r.name.clone()
            };
            out.entry(fold(&said)).or_insert((said, 0)).1 += 1;
        }
        out
    }

    /// The verbs an ask-or-act pair uses for `kind`: ones that take no argument and that the kind has.
    #[must_use]
    pub fn pair_verbs(kind: &str) -> Vec<&'static str> {
        ["complete", "star", "delete"]
            .into_iter()
            .filter(|v| draws(kind, v))
            .collect()
    }

    /// Ask side of an ask-or-act pair: `verb` said of a name more than one row answers to.
    #[must_use]
    pub fn ask_side(&self, kind: &str, name: &str, verb: &str) -> Option<TurnIntent> {
        let reached = self.spoken_names(kind).get(&fold(name)).map(|(_, n)| *n)?;
        (reached >= 2).then(|| {
            self.turn(
                Intent::Ask {
                    kind: kind.to_owned(),
                    name: name.to_owned(),
                    verb: Some(verb.to_owned()),
                },
                Reference::Name,
                Outcome::Ask,
                None,
            )
        })
    }

    /// Act side of an ask-or-act pair: the same words, said of a name exactly one row answers to, so the model acts.
    #[must_use]
    pub fn act_side(&self, kind: &str, name: &str, verb: &str) -> Option<TurnIntent> {
        let rows: Vec<&Row> = self
            .live_rows(kind)
            .into_iter()
            .filter(|r| {
                let said = if kind == "person" {
                    r.name.split_whitespace().next().unwrap_or_default()
                } else {
                    r.name.as_str()
                };
                fold(said) == fold(name)
            })
            .collect();
        let [row] = rows[..] else { return None };
        if !self.verb_fits(kind, verb, row) {
            return None;
        }
        Some(self.turn(
            Intent::Write {
                target: Target::Name {
                    kind: kind.to_owned(),
                    name: name.to_owned(),
                    key: row.key.clone(),
                    trashed: false,
                },
                verb: verb.to_owned(),
                arg: VerbArg::None,
            },
            Reference::Name,
            Outcome::Done,
            None,
        ))
    }

    fn write(
        &self,
        kind: &str,
        verb: &str,
        rng: &mut Rng,
        roll: usize,
        nickname: bool,
    ) -> Option<TurnIntent> {
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
        let pool: Vec<&Row> = pool
            .into_iter()
            .filter(|r| self.verb_fits(kind, verb, r))
            .collect();
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
            self.target_for(row, rng, nickname)?
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
        let repair = roll >= REPAIR_FROM;
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
    fn target_for(&self, row: &Row, rng: &mut Rng, nickname: bool) -> Option<(Target, Reference)> {
        let kind = row.kind.as_str();
        let by_name = |this: &Self, rng: &mut Rng| {
            let (name, reference) = this.say(row, rng, nickname)?;
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
        if nickname {
            by_name(self, rng).or_else(|| by_select(self, rng))
        } else if rng.chance(0.3) {
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

    /// Can `field` of `kind` be edited on `row`? A secret or a plain Locker field only on a type that keeps it.
    fn edit_fits(kind: &str, field: &str, ty: Option<&str>) -> bool {
        if kind != "locker item" {
            return true;
        }
        let ty = ty.unwrap_or("login");
        match field {
            "password" | "code" | "card_number" | "cvv" => {
                meta::locker_secret_column(ty, field).is_some()
            }
            "username" | "url" | "notes" => meta::locker_column(ty, field).is_some(),
            _ => true,
        }
    }

    /// A new value for `field` of `kind`: never the one the row has. `row` is `None` for a row the session just made
    /// (`made_type` is its Locker type), `avoid` the name it was made with.
    fn edit_value(
        &self,
        kind: &str,
        field: &str,
        row: Option<&Row>,
        made_type: Option<&str>,
        avoid: &str,
        rng: &mut Rng,
    ) -> Option<Val> {
        let typed = self.typed();
        let differs = |pool: &[&str], have: Option<&str>, rng: &mut Rng| -> Option<Val> {
            let options: Vec<&&str> = pool
                .iter()
                .filter(|p| have.is_none_or(|h| !h.eq_ignore_ascii_case(p)))
                .collect();
            (!options.is_empty()).then(|| Val::Text((**rng.pick(&options)).to_owned()))
        };
        let number = |lo: i64, hi: i64, step: i64, rng: &mut Rng| -> Val {
            let have = row.and_then(|r| r.num(field));
            loop {
                let n = (rng.range(lo, hi) * step) as f64;
                if have != Some(n) {
                    return Val::Num(n);
                }
            }
        };
        let text = |f: &str| row.and_then(|r| r.text(f));
        let ty = row.and_then(|r| r.text("type")).or(made_type);
        Some(match (kind, field) {
            (_, "name") => {
                let have = row.map_or(avoid, |r| r.name.as_str());
                Val::Text(self.fresh_name(kind, rng, &[have, avoid]))
            }
            ("person", "role") => differs(pools::ROLES, text("role"), rng)?,
            ("person", "nickname") => differs(pools::NICKNAMES, text("nickname"), rng)?,
            ("person", "met") => differs(pools::MET, text("met"), rng)?,
            ("person", "cadence") => number(1, 12, 7, rng),
            ("event", "duration") => number(1, 8, 15, rng),
            ("event" | "task", "description") => differs(pools::DESCRIPTIONS, None, rng)?,
            ("task", "effort") => number(1, 8, 15, rng),
            ("task", "priority") => number(1, 9, 1, rng),
            ("task", "status") => differs(
                &["open", "completed", "cancelled"],
                text("status").or(Some("open")),
                rng,
            )?,
            ("note", "body") => differs(pools::BODIES, None, rng)?,
            ("note", "pinned") => {
                Val::Flag(!row.is_some_and(|r| r.fields.get("pinned") == Some(&F::B(true))))
            }
            ("list", "area") => differs(pools::AREAS, text("area"), rng)?,
            ("locker item", "password") => differs(typed.passwords, None, rng)?,
            ("locker item", "code") => differs(typed.codes, None, rng)?,
            ("locker item", "card_number") => differs(typed.card_numbers, None, rng)?,
            ("locker item", "cvv") => differs(typed.cvvs, None, rng)?,
            ("locker item", "username") => differs(typed.usernames, text("username"), rng)?,
            ("locker item", "url") => differs(typed.urls, None, rng)?,
            ("locker item", "notes") => {
                if ty == Some("note") {
                    differs(typed.notes, None, rng)?
                } else {
                    differs(pools::BODIES, None, rng)?
                }
            }
            ("workout", "moving") => number(10, 150, 60, rng),
            ("workout", "distance") => number(1, 40, 500, rng),
            ("workout", "energy") => number(5, 120, 10, rng),
            ("workout", "heart_rate") => number(9, 18, 10, rng),
            ("workout", "climb") => number(1, 60, 10, rng),
            _ => return None,
        })
    }

    /// An edit of a workout or a daily figure of a world that follows a Health store: the runtime refuses it and names the
    /// store (the owner's ruling: refuse edits to synced rows and name the source), and the turn ends on that refusal.
    fn synced_edit(&self, kind: &str, rng: &mut Rng) -> Option<TurnIntent> {
        let rows: Vec<&Row> = self.live_rows(kind);
        if rows.is_empty() {
            return None;
        }
        let row = rows[rng.below(rows.len())];
        let (target, reference) = self.target_for(row, rng, false)?;
        let changes = if kind == "workout" {
            let (field, low, high, step) = *rng.pick(&[
                ("moving", 10, 150, 60),
                ("distance", 1, 40, 500),
                ("energy", 5, 120, 10),
                ("heart_rate", 9, 18, 10),
                ("climb", 1, 60, 10),
            ]);
            vec![Change {
                field: field.into(),
                value: Val::Num((rng.range(low, high) * step) as f64),
            }]
        } else {
            // the name of a figure is its metric: what an edit changes is the value
            vec![Change {
                field: "value".into(),
                value: Val::Num(rng.range(1, 200) as f64 * 10.0),
            }]
        };
        Some(self.turn(
            Intent::Edit { target, changes },
            reference,
            Outcome::Decline,
            None,
        ))
    }

    fn edit(
        &self,
        kind: &str,
        focus: Option<&str>,
        nickname: bool,
        rng: &mut Rng,
        roll: usize,
    ) -> Option<TurnIntent> {
        if matches!(kind, "workout" | "daily figure") {
            return self.synced_edit(kind, rng);
        }
        let live = fields::live_fields(self.catalog, self.grid, "edit", kind);
        let field = match focus {
            Some(f) => live.iter().find(|l| *l == f)?.clone(),
            None => live.get(rng.below(live.len().max(1)))?.clone(),
        };
        let rows: Vec<&Row> = self
            .live_rows(kind)
            .into_iter()
            .filter(|r| Self::edit_fits(kind, &field, r.text("type")))
            .collect();
        if rows.is_empty() {
            return None;
        }
        let row = rows[rng.below(rows.len())];
        let (target, reference) = self.target_for(row, rng, nickname)?;
        let mut changes = vec![Change {
            field: field.clone(),
            value: self.edit_value(kind, &field, Some(row), None, "", rng)?,
        }];
        // now and then a second plain field of the same row, as people say "make it 45 minutes and rename it"
        if focus.is_none() && rng.chance(0.25) {
            let plain: Vec<&String> = live
                .iter()
                .filter(|f| {
                    **f != field
                        && !matches!(f.as_str(), "status" | "pinned" | "area" | "name")
                        && kind != "locker item"
                        && Self::edit_fits(kind, f, row.text("type"))
                })
                .collect();
            if !plain.is_empty() {
                let second = plain[rng.below(plain.len())].clone();
                if let Some(value) = self.edit_value(kind, &second, Some(row), None, "", rng) {
                    changes.push(Change {
                        field: second,
                        value,
                    });
                }
            }
        }
        Some(self.turn(
            Intent::Edit { target, changes },
            reference,
            if roll >= REPAIR_FROM {
                Outcome::Repair
            } else {
                Outcome::Done
            },
            None,
        ))
    }

    /// A name for a new Locker item of type `ty`, from the names the pool gives that type.
    fn fresh_locker_name(&self, ty: &str, rng: &mut Rng) -> String {
        let names: Vec<&str> = pools::NEW_LOCKER
            .iter()
            .filter(|(_, t)| *t == ty)
            .map(|(n, _)| *n)
            .collect();
        let start = rng.below(names.len().max(1));
        if let Some(name) = (0..names.len())
            .map(|i| names[(start + i) % names.len()])
            .find(|n| !self.taken("locker item", n))
        {
            return name.to_owned();
        }
        self.fallbacks
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let base = names.get(start).copied().unwrap_or("Locker item");
        (2..)
            .map(|n| format!("{base} {n}"))
            .find(|n| !self.taken("locker item", n))
            .unwrap_or_else(|| base.to_owned())
    }

    fn typed(&self) -> pools::Typed {
        pools::typed(self.world.spec.split)
    }

    /// The Locker types a request that sets `field` can be made for.
    fn locker_types_for(field: Option<&str>) -> &'static [&'static str] {
        match field {
            Some("password") => &["login", "wifi", "password"],
            Some("code" | "username" | "url") => &["login"],
            Some("card_number" | "cvv") => &["card"],
            Some("notes") => &["login", "note"],
            _ => &["login", "wifi", "password", "card", "note"],
        }
    }

    fn create(
        &self,
        kind: &str,
        focus: Option<&str>,
        rng: &mut Rng,
        roll: usize,
    ) -> Option<TurnIntent> {
        let live = fields::live_fields(self.catalog, self.grid, "create", kind);
        if let Some(f) = focus
            && !live.iter().any(|l| l == f)
        {
            return None;
        }
        let typed = self.typed();
        let ty: Option<&str> =
            (kind == "locker item").then(|| *rng.pick(Self::locker_types_for(focus)));
        let name = match ty {
            Some(ty) => self.fresh_locker_name(ty, rng),
            None => self.fresh_name(kind, rng, &[]),
        };
        let made_type = pools::new_type(kind, &name);
        let mut fields = vec![Change {
            field: "name".into(),
            value: Val::Text(name),
        }];
        // a field is set when the draw is aimed at it, or by chance `p`
        let want = |field: &str, p: f64, rng: &mut Rng| focus == Some(field) || rng.chance(p);
        let day = |rel: i64| Val::When(Period::Day { rel }.when());
        let mut put = |field: &str, value: Val| {
            fields.push(Change {
                field: field.into(),
                value,
            });
        };
        let pick = |pool: &[&str], rng: &mut Rng| Val::Text((*rng.pick(pool)).to_owned());
        match kind {
            "task" => {
                if want("date", 0.6, rng) {
                    put("due", day(rng.range(1, 30)));
                }
                if want("priority", 0.5, rng) {
                    put("priority", Val::Num(rng.range(1, 9) as f64));
                }
                if want("effort", 0.4, rng) {
                    put("effort", Val::Num((rng.range(1, 8) * 15) as f64));
                }
                if want("description", 0.3, rng) {
                    put("description", pick(pools::DESCRIPTIONS, rng));
                }
            }
            "event" => {
                put(
                    "start",
                    Val::When(format!(
                        r#"{{"unit":"day","rel":{},"time":"{:02}:00"}}"#,
                        rng.range(1, 30),
                        rng.range(8, 18)
                    )),
                );
                if want("duration", 0.7, rng) {
                    put("duration", Val::Num((rng.range(1, 6) * 30) as f64));
                }
                if want("description", 0.3, rng) {
                    put("description", pick(pools::DESCRIPTIONS, rng));
                }
            }
            "person" => {
                if want("role", 0.6, rng) {
                    put("role", pick(pools::ROLES, rng));
                }
                if want("nickname", 0.4, rng) {
                    put("nickname", pick(pools::NICKNAMES, rng));
                }
                if want("cadence", 0.3, rng) {
                    put("cadence", Val::Num((rng.range(1, 12) * 7) as f64));
                }
            }
            "note" => {
                if want("body", 0.8, rng) {
                    put("body", pick(pools::BODIES, rng));
                }
            }
            "document" => {
                if want("text", 0.6, rng) {
                    put("text", pick(pools::DOC_TEXTS, rng));
                }
            }
            "list" => {
                if want("area", 0.7, rng) {
                    put("area", pick(pools::AREAS, rng));
                }
            }
            "locker item" => {
                let ty = ty.unwrap_or("login");
                put("type", Val::Text(ty.into()));
                match ty {
                    "login" => {
                        if want("username", 0.5, rng) {
                            put("username", pick(typed.usernames, rng));
                        }
                        if want("url", 0.4, rng) {
                            put("url", pick(typed.urls, rng));
                        }
                        if want("password", 0.6, rng) {
                            put("password", pick(typed.passwords, rng));
                        }
                        if want("code", 0.25, rng) {
                            put("code", pick(typed.codes, rng));
                        }
                        if want("notes", 0.25, rng) {
                            put("notes", pick(pools::BODIES, rng));
                        }
                    }
                    "wifi" | "password" => {
                        put("password", pick(typed.passwords, rng));
                    }
                    "card" => {
                        put("card_number", pick(typed.card_numbers, rng));
                        if want("cvv", 0.6, rng) {
                            put("cvv", pick(typed.cvvs, rng));
                        }
                    }
                    _ => put("notes", pick(typed.notes, rng)),
                }
            }
            "account" => put("type", Val::Text(made_type.unwrap_or("checking").into())),
            "workout" => {
                put(
                    "date",
                    Val::When(format!(
                        r#"{{"unit":"day","rel":-{},"time":"{:02}:30"}}"#,
                        rng.range(1, 14),
                        rng.range(6, 20)
                    )),
                );
                let figures: [(&str, i64, i64, i64); 5] = [
                    ("moving", 10, 150, 60),
                    ("distance", 1, 40, 500),
                    ("energy", 5, 120, 10),
                    ("heart_rate", 9, 18, 10),
                    ("climb", 1, 60, 10),
                ];
                for (field, low, high, step) in figures {
                    if want(field, 0.4, rng) {
                        put(field, Val::Num((rng.range(low, high) * step) as f64));
                    }
                }
            }
            _ => {}
        }
        let repair = roll >= REPAIR_FROM;
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
            Period::Between { .. }
            | Period::Weekday { .. }
            | Period::NamedMonth { .. }
            | Period::Clock { .. }
            | Period::Date { .. }
            | Period::Open { .. } => None,
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
        self.session_aim(id, cell, &Aim::default(), &Room::default(), extra, rng)
    }

    /// [`Self::session`] with the first turn aimed as `aim` says and the follow-ups drawn only where `room` says there is
    /// still room for them.
    #[must_use]
    pub fn session_aim(
        &self,
        id: &str,
        cell: &Cell,
        aim: &Aim,
        room: &Room,
        extra: usize,
        rng: &mut Rng,
    ) -> Option<Scenario> {
        if aim.tail {
            return self.tailed(id, cell, aim, room, extra, rng);
        }
        if aim.more {
            return self.both(id, cell, rng);
        }
        let mut turns: Vec<TurnIntent> = Vec::new();
        let mut extra = extra;
        match (cell.tool.as_str(), cell.verb.as_str()) {
            ("answer", _) => {
                if !room.recall {
                    return None;
                }
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
            ("edit", _) if cell.kind == "workout" && aim.field.is_some() => {
                // the only workouts a member can edit are ones they logged: a followed store states the rest
                // aimed at a pair the field floor needs
                let field = aim.field.clone()?;
                let first = self.create("workout", None, rng, 0)?;
                let Intent::Create { fields: made, .. } = &first.intent else {
                    return None;
                };
                let made_name = made
                    .iter()
                    .find_map(|c| (c.field == "name").then(|| c.value.render()))
                    .unwrap_or_default();
                let value = (0..8).find_map(|_| {
                    let v = self.edit_value("workout", &field, None, None, &made_name, rng)?;
                    (!made.iter().any(|c| c.field == field && c.value == v)).then_some(v)
                })?;
                // most are said by the name the member logged it under ("change my Morning run to 6 km"), which is no
                // pronoun and takes none of the ceiling; the rest lean on the turn before
                let by_name = !room.pronoun || rng.chance(0.7);
                let edit = if by_name {
                    self.turn(
                        Intent::Edit {
                            target: Target::Name {
                                kind: "workout".into(),
                                name: made_name.clone(),
                                key: "+1".into(),
                                trashed: false,
                            },
                            changes: vec![Change { field, value }],
                        },
                        Reference::Name,
                        Outcome::Done,
                        None,
                    )
                } else {
                    self.turn(
                        Intent::Edit {
                            target: Target::Turn {
                                turn: 0,
                                kind: "workout".into(),
                            },
                            changes: vec![Change { field, value }],
                        },
                        Reference::Pronoun,
                        Outcome::Done,
                        Some((0, Dep::Pronoun)),
                    )
                };
                turns.push(first);
                turns.push(edit);
                extra = 0;
            }
            ("find", "read")
                if aim.search == Some(Search::Exclude) && !self.world.settings.is_empty() =>
            {
                turns = self.exclusion(&cell.kind, false, rng)?;
                extra = extra.min(1);
            }
            ("compute", "count")
                if aim.search == Some(Search::Exclude) && !self.world.settings.is_empty() =>
            {
                // "how many others are there?": a count that leaves out the rows the turn before showed
                turns = self.exclusion(&cell.kind, true, rng)?;
                extra = extra.min(1);
            }
            ("do", "restore") if aim.trash => {
                turns = self.deleted_then_restored(&cell.kind, rng)?;
                extra = 0;
            }
            ("do", "undo") => {
                if !room.undo {
                    return None;
                }
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
                // an empty result is drawn by `opener`, so leave room for it before a window around an event
                let across = matches!(cell.tool.as_str(), "find" | "compute")
                    && *aim == Aim::default()
                    && !rng.chance(0.2)
                    && rng.chance(0.7);
                let first = across
                    .then(|| self.across(cell, rng))
                    .flatten()
                    .or_else(|| self.opener_aim(cell, aim, rng))?;
                turns.push(first);
            }
        }
        if !self.grid.is_live(&cell_of(&turns[0])) {
            return None;
        }
        for _ in 0..extra {
            let Some(next) = self.follow(&turns, room, rng) else {
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
        // a follow-up can be a repair too: its first call is one the runtime refuses
        for turn in turns.iter_mut().skip(1) {
            let repairable = match &turn.intent {
                Intent::Read { .. }
                | Intent::Count { .. }
                | Intent::Measure { .. }
                | Intent::Edit { .. }
                | Intent::Create { .. } => true,
                Intent::Write { verb, .. } => verb != "undo",
                _ => false,
            };
            if repairable && turn.outcome == Outcome::Done && rng.below(100) < REPAIR_FOLLOW_UP {
                turn.outcome = Outcome::Repair;
            }
        }
        let span = if joins { Span::Across } else { Span::Single };
        Some(Scenario {
            id: id.to_owned(),
            world: self.world.id(),
            span,
            turns,
            tags: Vec::new(),
        })
    }

    /// A rare turn (an ask, a decline, a read that finds nothing) as the last turn of a session that starts with an
    /// ordinary one of the same kind: "show my open tasks", then a name two tasks answer to. The rare turn leans on
    /// nothing, so it is a fresh request in a session that already has turns. `None` when the world cannot draw the rare
    /// turn or no ordinary session can lead to it.
    fn tailed(
        &self,
        id: &str,
        cell: &Cell,
        aim: &Aim,
        room: &Room,
        extra: usize,
        rng: &mut Rng,
    ) -> Option<Scenario> {
        let mut inner = aim.clone();
        inner.tail = false;
        let tail = self.opener_aim(cell, &inner, rng)?;
        let heads: Vec<Cell> = self
            .grid
            .live()
            .into_iter()
            .filter(|c| {
                matches!(
                    c.tool.as_str(),
                    "find" | "compute" | "do" | "edit" | "create"
                ) && !matches!(
                    (c.tool.as_str(), c.verb.as_str()),
                    ("do", "undo" | "restore") | ("compute", "compare" | "group")
                ) && (cell.kind == "-" || c.kind == cell.kind)
            })
            .cloned()
            .collect();
        if heads.is_empty() {
            return None;
        }
        for _ in 0..12 {
            let head = &heads[rng.below(heads.len())];
            let Some(mut scenario) =
                self.session_aim(id, head, &Aim::default(), room, extra.min(1), rng)
            else {
                continue;
            };
            if scenario
                .turns
                .iter()
                .any(|t| matches!(t.intent, Intent::Ask { .. } | Intent::Decline { .. }))
            {
                continue;
            }
            scenario.turns.push(tail);
            return Some(scenario);
        }
        None
    }

    /// Two writes in one message: a create, an edit or a verb on a named or selected row of `cell`, and a create. The call
    /// of the first says `more` (another call follows) and the call of the create ends the turn. `None` when the world
    /// cannot draw the first.
    fn both(&self, id: &str, cell: &Cell, rng: &mut Rng) -> Option<Scenario> {
        let first = self.opener_aim(cell, &Aim::default(), rng)?;
        if first.outcome != Outcome::Done {
            return None;
        }
        let creates = matches!(first.intent, Intent::Create { .. });
        let fits = match &first.intent {
            Intent::Create { .. } => true,
            Intent::Edit { target, .. } => !matches!(target, Target::Turn { .. }),
            Intent::Write { target, verb, .. } => {
                !matches!(target, Target::Turn { .. })
                    && !matches!(verb.as_str(), "undo" | "restore")
            }
            _ => false,
        };
        if !fits {
            return None;
        }
        // two creates of one kind could be given one name, so a create is followed by another kind
        let kinds: Vec<Cell> = self
            .grid
            .live()
            .into_iter()
            .filter(|c| c.tool == "create" && (!creates || c.kind != cell.kind))
            .cloned()
            .collect();
        if kinds.is_empty() {
            return None;
        }
        let second = self.create(&kinds[rng.below(kinds.len())].kind, None, rng, 0)?;
        if second.outcome != Outcome::Done {
            return None;
        }
        let reference = first.reference;
        let turn = self.turn(
            Intent::Both {
                first: Box::new(first.intent),
                second: Box::new(second.intent),
            },
            reference,
            Outcome::Done,
            None,
        );
        Some(Scenario {
            id: id.to_owned(),
            world: self.world.id(),
            span: Span::Single,
            turns: vec![turn],
            tags: Vec::new(),
        })
    }

    /// A row deleted and then restored by its name, which is how a trash is emptied of a mistake: the supply of the
    /// restores a world's own trash cannot give (few worlds trash a document or a Locker item).
    fn deleted_then_restored(&self, kind: &str, rng: &mut Rng) -> Option<Vec<TurnIntent>> {
        if !draws(kind, "delete") || !draws(kind, "restore") {
            return None;
        }
        let rows: Vec<&Row> = self
            .live_rows(kind)
            .into_iter()
            .filter(|r| self.verb_fits(kind, "delete", r))
            .filter(|r| {
                !r.name.is_empty()
                    && self
                        .facts
                        .rows
                        .iter()
                        .filter(|x| x.kind == kind && fold(&x.name) == fold(&r.name))
                        .count()
                        == 1
            })
            .collect();
        if rows.is_empty() {
            return None;
        }
        let row = rows[rng.below(rows.len())];
        let (target, reference) = self.target_for(row, rng, false)?;
        Some(vec![
            self.turn(
                Intent::Write {
                    target,
                    verb: "delete".into(),
                    arg: VerbArg::None,
                },
                reference,
                Outcome::Done,
                None,
            ),
            self.turn(
                Intent::Write {
                    target: Target::Name {
                        kind: kind.to_owned(),
                        name: row.name.clone(),
                        key: row.key.clone(),
                        trashed: true,
                    },
                    verb: "restore".into(),
                    arg: VerbArg::None,
                },
                Reference::Name,
                Outcome::Done,
                None,
            ),
        ])
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
    fn follow(&self, turns: &[TurnIntent], room: &Room, rng: &mut Rng) -> Option<TurnIntent> {
        let last = turns.len() - 1;
        let prev = &turns[last];
        let sets = self.sets(turns);
        let mut branches: Vec<u8> = match &prev.intent {
            Intent::Read { .. } | Intent::Count { .. } if prev.outcome != Outcome::Empty => {
                vec![0, 1, 2, 3, 3, 4, 4, 5]
            }
            Intent::Measure { measure } if measure.group.is_none() => {
                vec![10, 11, 11, 12, 12, 13]
            }
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
        // a share the run has filled is not drawn again: the pronoun and handle branches, the undo
        branches.retain(|b| {
            (room.pronoun || !matches!(b, 1 | 5 | 21 | 30))
                && (room.recall || *b != 3)
                && (room.pronoun || room.recall || *b != 12)
                && (room.undo || *b != 20)
        });
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
                        Period::Between { .. }
                        | Period::Weekday { .. }
                        | Period::NamedMonth { .. }
                        | Period::Clock { .. }
                        | Period::Date { .. }
                        | Period::Open { .. } => continue,
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
                12 if room.pronoun
                    && matches!(prev.intent, Intent::Measure { .. })
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
                12 if room.recall => Some(self.turn(
                    Intent::Recall {
                        turn: last,
                        value: true,
                    },
                    Reference::Pronoun,
                    Outcome::Done,
                    Some((last, Dep::Pronoun)),
                )),
                // show the row just changed, or take the change back
                20 if verb_of(&prev.intent) != "undo" && !self.seals(&prev.intent) => {
                    Some(self.follow_undo(last))
                }
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
                    let Intent::Create { fields: made, .. } = &prev.intent else {
                        continue;
                    };
                    let made_name = made
                        .iter()
                        .find_map(|c| (c.field == "name").then(|| c.value.render()))
                        .unwrap_or_default();
                    let made_type = made
                        .iter()
                        .find_map(|c| (c.field == "type").then(|| c.value.render()));
                    let live = fields::live_fields(self.catalog, self.grid, "edit", &kind);
                    let fits: Vec<&String> = live
                        .iter()
                        .filter(|f| Self::edit_fits(&kind, f, made_type.as_deref()))
                        .collect();
                    if fits.is_empty() {
                        None
                    } else {
                        let field = fits[rng.below(fits.len())].clone();
                        (0..8)
                            .find_map(|_| {
                                let v = self.edit_value(
                                    &kind,
                                    &field,
                                    None,
                                    made_type.as_deref(),
                                    &made_name,
                                    rng,
                                )?;
                                (!made.iter().any(|c| c.field == field && c.value == v))
                                    .then_some(v)
                            })
                            .map(|value| {
                                self.turn(
                                    Intent::Edit {
                                        target: Target::Turn {
                                            turn: last,
                                            kind: kind.clone(),
                                        },
                                        changes: vec![Change { field, value }],
                                    },
                                    Reference::Pronoun,
                                    Outcome::Done,
                                    Some((last, Dep::Pronoun)),
                                )
                            })
                    }
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

    /// Does the turn type a secret the vault seals? An undo cannot put an earlier sealed value back, so none follows it.
    fn seals(&self, intent: &Intent) -> bool {
        match intent {
            Intent::Edit { target, changes } => changes.iter().any(|c| {
                self.catalog
                    .typed_secret(target_kind(target), &c.field, None)
            }),
            _ => false,
        }
    }

    /// The keys each turn leaves for the next to lean on, read off the world.
    fn sets(&self, turns: &[TurnIntent]) -> Vec<std::collections::BTreeSet<String>> {
        let mut out: Vec<std::collections::BTreeSet<String>> = Vec::new();
        for t in turns {
            let pick = |sel: &Selector,
                        out: &[std::collections::BTreeSet<String>]|
             -> std::collections::BTreeSet<String> {
                let within = sel.within.and_then(|w| out.get(w));
                let exclude = sel.exclude.and_then(|w| out.get(w));
                self.facts
                    .select_but(sel, within, exclude)
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

#[cfg(test)]
mod name_tests {
    use super::*;
    use crate::settings::Split;
    use crate::world::WorldSpec;
    use std::collections::BTreeMap;

    fn setup(split: Split) -> (World, Catalog, Grid) {
        let catalog = Catalog::build().expect("catalog");
        let grid = Grid::build(&catalog);
        let world = World::generate(WorldSpec {
            split,
            index: 3,
            seed: 11,
        });
        (world, catalog, grid)
    }

    fn row(kind: &str, key: &str, name: &str, trashed: bool) -> Row {
        Row {
            clock: None,
            kind: kind.into(),
            key: key.into(),
            keyed: true,
            name: name.into(),
            date: None,
            fields: BTreeMap::new(),
            trashed,
        }
    }

    fn numbered(name: &str) -> bool {
        name.rsplit_once(' ')
            .is_some_and(|(_, tail)| !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()))
    }

    #[test]
    fn a_new_name_comes_from_its_kinds_pool_and_clashes_with_no_row() {
        for split in Split::ALL {
            let (world, catalog, grid) = setup(split);
            let facts = Facts::of(&world, &catalog);
            let sampler = Sampler::new(&world, &facts, &catalog, &grid);
            let (firsts, lasts) = pools::new_people(split);
            let mut rng = Rng::new(5);
            for kind in [
                "task",
                "event",
                "list",
                "note",
                "notebook",
                "album",
                "folder",
                "document",
                "category",
                "photo",
                "transaction",
                "locker item",
                "account",
                "person",
            ] {
                for _ in 0..200 {
                    let name = sampler.fresh_name(kind, &mut rng, &[]);
                    assert!(!numbered(&name), "{kind}: {name}");
                    assert!(!sampler.taken(kind, &name), "{kind}: {name} is taken");
                    if kind == "person" {
                        let (first, last) = name.split_once(' ').expect("first last");
                        assert!(firsts.contains(&first) && lasts.contains(&last), "{name}");
                    } else {
                        let pool = pools::new_names(kind).expect("pool");
                        assert!(pool.contains(&name.as_str()), "{kind}: {name}");
                    }
                }
            }
            assert_eq!(sampler.name_fallbacks(), 0);
        }
    }

    #[test]
    fn a_rename_differs_from_the_current_name_and_from_what_is_avoided() {
        let (world, catalog, grid) = setup(Split::Train);
        let facts = Facts::of(&world, &catalog);
        let sampler = Sampler::new(&world, &facts, &catalog, &grid);
        let mut rng = Rng::new(9);
        for row in facts.rows.iter().filter(|r| !r.trashed) {
            if pools::new_names(&row.kind).is_none() && row.kind != "person" {
                continue;
            }
            let renamed = sampler.fresh_name(&row.kind, &mut rng, &[&row.name]);
            assert_ne!(fold(&renamed), fold(&row.name), "{}", row.name);
            assert!(!numbered(&renamed), "{renamed}");
        }
        let made = sampler.fresh_name("task", &mut rng, &["Water the plants"]);
        assert_ne!(made, "Water the plants");
    }

    #[test]
    fn a_trashed_row_still_holds_its_name_and_a_spent_pool_numbers_the_name_and_counts_it() {
        let (world, catalog, grid) = setup(Split::Train);
        let mut facts = Facts::of(&world, &catalog);
        for (i, name) in pools::NEW_NOTEBOOKS.iter().enumerate() {
            facts
                .rows
                .push(row("notebook", &format!("nb{i}"), name, i % 2 == 0));
        }
        let sampler = Sampler::new(&world, &facts, &catalog, &grid);
        let mut rng = Rng::new(2);
        let name = sampler.fresh_name("notebook", &mut rng, &[]);
        assert!(numbered(&name), "{name}");
        let base = name.rsplit_once(' ').expect("base").0;
        assert!(pools::NEW_NOTEBOOKS.contains(&base), "{name}");
        assert_eq!(sampler.name_fallbacks(), 1);
    }

    #[test]
    fn a_new_person_never_shares_a_first_name_or_nickname_with_one_the_world_has() {
        let (world, catalog, grid) = setup(Split::Val);
        let mut facts = Facts::of(&world, &catalog);
        let mut taken = row("person", "px", "Alina Gallo", false);
        taken.fields.insert("nickname".into(), F::T("Bru".into()));
        facts.rows.push(taken);
        let sampler = Sampler::new(&world, &facts, &catalog, &grid);
        let mut rng = Rng::new(3);
        for _ in 0..300 {
            let name = sampler.fresh_name("person", &mut rng, &[]);
            assert!(!name.starts_with("Alina "), "{name}");
        }
        assert!(sampler.taken("person", "Alina Hartmann"));
        assert!(sampler.taken("person", "Bru Hartmann"));
    }
}
