//! The world builder: one section at a time, each from its own fork of the world's stream so a
//! change to one section never moves another's draws.

use centraid_assist::native::world::{HEALTH_DAYS, TRANSACTION_MONTHS};
use jiff::ToSpan;
use jiff::civil::Date;
use serde_json::{Map, Value, json};

use crate::persona::{Persona, Profile};
use crate::pools;
use crate::rng::Rng;
use crate::settings::Settings;
use crate::text::{normalize, twin};
use crate::world::{World, WorldSpec};

/// The base day sessions run on: late September, a Sunday in 2026, moved by up to a month.
const BASE_TODAY: &str = "2026-09-27";

struct Ctx {
    rng: Rng,
    settings: Settings,
    profile: Profile,
    today: Date,
    history: i64,
}

impl Ctx {
    fn ago(&self, days: i64) -> Date {
        self.today.checked_sub(days.days()).unwrap_or(self.today)
    }

    /// A day `low..=high` days back.
    fn past(&mut self, low: i64, high: i64) -> Date {
        let back = self.rng.range(low, high);
        self.ago(back)
    }

    /// A day `low..=high` days ahead.
    fn future(&mut self, low: i64, high: i64) -> Date {
        let ahead = self.rng.range(low, high);
        self.ahead(ahead)
    }

    fn ahead(&self, days: i64) -> Date {
        self.today.checked_add(days.days()).unwrap_or(self.today)
    }

    /// A random time `days_ago_low..=days_ago_high` days back, as `YYYY-MM-DDTHH:MM`.
    fn when_ago(&mut self, low: i64, high: i64) -> String {
        let back = self.rng.range(low, high);
        let day = self.ago(back);
        let (h, m) = (self.rng.range(7, 21), *self.rng.pick(&[0, 15, 30, 45]));
        format!("{day}T{h:02}:{m:02}")
    }

    /// A count scaled by a profile factor, with jitter.
    fn count(&mut self, low: i64, high: i64, factor: f64) -> usize {
        let base = self.rng.range(low, high) as f64 * factor;
        (base.round() as usize).max(1)
    }

    /// When a trashable row was trashed, if it was: inside the last month.
    fn trashed(&mut self) -> Option<String> {
        self.rng
            .chance(self.settings.trashed)
            .then(|| self.when_ago(1, 25))
    }
}

/// Titles already used in one kind; makes the next one, shared or twinned on the settings' say.
#[derive(Default)]
struct Titles(Vec<String>);

impl Titles {
    fn make(&mut self, ctx: &mut Ctx, mut draw: impl FnMut(&mut Rng) -> String) -> String {
        let title = if !self.0.is_empty() && ctx.rng.chance(ctx.settings.shared_names) {
            ctx.rng.pick(&self.0).clone()
        } else if !self.0.is_empty() && ctx.rng.chance(ctx.settings.near_duplicates) {
            let base = ctx.rng.pick(&self.0).clone();
            twin(&mut ctx.rng, &base)
        } else {
            // a fresh title: redraw while it repeats or sits near one in use, so the settings,
            // not the template pool, decide how ambiguous a world is
            let mut fresh = draw(&mut ctx.rng);
            for _ in 0..12 {
                let taken = self.0.iter().any(|used| {
                    normalize(used) == normalize(&fresh)
                        || crate::text::near_duplicates(used, &fresh)
                });
                if !taken {
                    break;
                }
                fresh = draw(&mut ctx.rng);
            }
            fresh
        };
        self.0.push(title.clone());
        title
    }
}

fn put(row: &mut Map<String, Value>, key: &str, value: impl Into<Value>) {
    row.insert(key.to_owned(), value.into());
}

fn fill(template: &str, person: &str, city: &str) -> String {
    template.replace("{p}", person).replace("{c}", city)
}

pub(crate) fn build(spec: WorldSpec, settings: Settings) -> World {
    let root = Rng::new(spec.seed);
    let persona = Persona::draw(spec.split, &mut root.fork("persona"));
    let profile = persona.archetype.profile();
    let today = BASE_TODAY
        .parse::<Date>()
        .ok()
        .and_then(|day| {
            day.checked_add(i64::from(root.fork("today").next_u64() as u8 % 30).days())
                .ok()
        })
        .unwrap_or_default();
    let mut ctx = Ctx {
        rng: root.fork("sections"),
        settings,
        profile,
        today,
        history: i64::from(settings.history_days),
    };
    let epoch = format!("{}T09:00", ctx.ago(ctx.history + 2));

    let mut doc = Map::new();
    put(&mut doc, "me", persona.me.clone());
    put(&mut doc, "epoch", epoch);
    put(&mut doc, "seed", spec.id());
    put(&mut doc, "currency", persona.currency.clone());
    put(&mut doc, "today", today.to_string());

    let people = people(&mut ctx, &root);
    // Trashing a person trashes the rows about them with it, so rows refer to the living only.
    let person_names: Vec<(String, String)> = people
        .iter()
        .filter(|p| p.get("trashed").is_none())
        .map(|p| {
            (
                p["key"].as_str().unwrap_or_default().to_owned(),
                p["name"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    put(&mut doc, "people", people);

    let lists = lists(&mut ctx, &root);
    let list_keys: Vec<String> = keys_of(&lists);
    put(&mut doc, "lists", lists);
    let events = events(&mut ctx, &root, &person_names);
    let event_keys = keys_of(&events);
    put(&mut doc, "events", events);
    let tasks = tasks(&mut ctx, &root, &person_names, &list_keys);
    let task_keys = keys_of(&tasks);
    put(&mut doc, "tasks", tasks);
    let (notebooks, notes) = notes(&mut ctx, &root);
    let note_keys = keys_of(&notes);
    put(&mut doc, "notebooks", notebooks);
    put(&mut doc, "notes", notes);
    let (folders, documents) = documents(&mut ctx, &root);
    put(&mut doc, "folders", folders);
    put(&mut doc, "documents", documents);
    let (albums, photos) = photos(&mut ctx, &root);
    put(&mut doc, "albums", albums);
    put(&mut doc, "photos", photos);
    put(&mut doc, "locker", locker(&mut ctx, &root));
    let money = money(&mut ctx, &root, &persona);
    for (key, value) in money {
        put(&mut doc, &key, value);
    }
    put(&mut doc, "health_days", health_days(&mut ctx, &root));
    put(&mut doc, "workouts", workouts(&mut ctx, &root));
    put(
        &mut doc,
        "links",
        links(
            &mut ctx,
            &root,
            &person_names,
            &task_keys,
            &note_keys,
            &event_keys,
        ),
    );

    World {
        spec,
        persona,
        settings,
        today: today.to_string(),
        doc: Value::Object(doc),
    }
}

fn keys_of(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .filter_map(|row| row["key"].as_str().map(str::to_owned))
        .collect()
}

fn people(ctx: &mut Ctx, root: &Rng) -> Vec<Value> {
    ctx.rng = root.fork("people");
    let count = ctx.count(14, 26, ctx.profile.social);
    let mut rows = Vec::new();
    let mut names: Vec<(String, String)> = Vec::new();
    for index in 0..count {
        let (first, last) = if !names.is_empty() && ctx.rng.chance(ctx.settings.shared_names) {
            // a spoken "Neha" now reaches two people
            let first = ctx.rng.pick(&names).0.clone();
            let mut last = ctx.rng.pick(pools::LAST).to_string();
            while names.iter().any(|(f, l)| *f == first && *l == last) {
                last = ctx.rng.pick(pools::LAST).to_string();
            }
            (first, last)
        } else if !names.is_empty() && ctx.rng.chance(ctx.settings.near_duplicates) {
            let (first, last) = ctx.rng.pick(&names).clone();
            let full = twin(&mut ctx.rng, &format!("{first} {last}"));
            let (f, l) = full
                .split_once(' ')
                .map_or((full.clone(), String::new()), |(f, l)| {
                    (f.to_owned(), l.to_owned())
                });
            (f, l)
        } else {
            let mut pair;
            loop {
                pair = (
                    ctx.rng.pick(pools::FIRST).to_string(),
                    ctx.rng.pick(pools::LAST).to_string(),
                );
                let firsts_taken = names.iter().any(|(f, _)| *f == pair.0);
                let near = names.iter().any(|(f, l)| {
                    crate::text::near_duplicates(
                        &format!("{f} {l}"),
                        &format!("{} {}", pair.0, pair.1),
                    )
                });
                if !firsts_taken && !near {
                    break;
                }
            }
            pair
        };
        names.push((first.clone(), last.clone()));
        let mut row = Map::new();
        put(&mut row, "key", format!("p{index}"));
        put(&mut row, "name", format!("{first} {last}"));
        if ctx.rng.chance(0.7) {
            put(&mut row, "role", *ctx.rng.pick(pools::ROLES));
        }
        if ctx.rng.chance(0.25) {
            put(&mut row, "nickname", twin_nick(&mut ctx.rng, &first));
        }
        if ctx.rng.chance(0.3) {
            put(&mut row, "met", *ctx.rng.pick(pools::MET));
        }
        if ctx.rng.chance(0.4) {
            put(&mut row, "cadence", *ctx.rng.pick(&[7, 14, 30, 60, 90]));
        }
        if ctx.rng.chance(0.15) {
            put(&mut row, "starred", true);
        }
        if ctx.rng.chance(0.4) {
            let lookback = ctx.history.min(120);
            put(&mut row, "last_contacted", ctx.when_ago(1, lookback));
            put(
                &mut row,
                "last_contacted_kind",
                *ctx.rng.pick(&["call", "message", "visit"]),
            );
        }
        if let Some(when) = ctx.trashed() {
            put(&mut row, "trashed", when);
        }
        rows.push(Value::Object(row));
    }
    rows
}

/// A nickname: a short form of the first name.
fn twin_nick(rng: &mut Rng, first: &str) -> String {
    let cut = first
        .chars()
        .take(rng.range(2, 3) as usize)
        .collect::<String>();
    if cut.chars().count() < 2 {
        first.to_owned()
    } else {
        cut
    }
}

fn lists(ctx: &mut Ctx, root: &Rng) -> Vec<Value> {
    ctx.rng = root.fork("lists");
    let count = ctx.count(4, 6, 1.0).min(pools::LIST_NAMES.len());
    ctx.rng
        .sample(pools::LIST_NAMES.len(), count)
        .into_iter()
        .enumerate()
        .map(|(index, pick)| {
            let (name, area) = pools::LIST_NAMES[pick];
            json!({"key": format!("l{index}"), "name": name, "area": area})
        })
        .collect()
}

fn events(ctx: &mut Ctx, root: &Rng, people: &[(String, String)]) -> Vec<Value> {
    ctx.rng = root.fork("events");
    let count = ctx.count(22, 40, ctx.profile.busy);
    let mut titles = Titles::default();
    let mut booked: Vec<(Date, i64, i64)> = Vec::new();
    let mut rows = Vec::new();
    for index in 0..count {
        let person = ctx.rng.pick(people).clone();
        let first = person.1.split(' ').next().unwrap_or_default().to_owned();
        let city = ctx.rng.pick(pools::CITIES).to_string();
        let name = titles.make(ctx, |rng| {
            let template = rng.pick(pools::EVENT_TEMPLATES);
            fill(template, &first, &city)
        });
        let day = if ctx.rng.chance(0.75) {
            ctx.past(0, ctx.history)
        } else {
            ctx.future(1, 60)
        };
        let mut row = Map::new();
        put(&mut row, "key", format!("e{index}"));
        put(&mut row, "name", name.clone());
        // The calendar refuses two busy events that overlap, so a timed event takes a free slot
        // of its day (held an hour longer than it runs, for the default length of an event with
        // no end) or, when it finds none, becomes an all-day event.
        let slot = (0..12).find_map(|_| {
            let hour = ctx.rng.range(7, 20);
            let length = ctx.rng.range(1, 2);
            let free = !booked
                .iter()
                .any(|(d, from, to)| *d == day && hour < *to && *from < hour + length + 1);
            free.then_some((hour, length))
        });
        match slot {
            Some((hour, length)) if ctx.rng.chance(0.9) => {
                booked.push((day, hour, hour + length + 1));
                let minute = *ctx.rng.pick(&[0, 15, 30, 45]);
                put(&mut row, "start", format!("{day}T{hour:02}:{minute:02}"));
                if ctx.rng.chance(0.6) {
                    put(
                        &mut row,
                        "end",
                        format!("{day}T{:02}:{minute:02}", hour + length),
                    );
                }
            }
            _ => put(&mut row, "start", day.to_string()),
        }
        if name.contains(&first) || ctx.rng.chance(0.3) {
            put(&mut row, "attendees", json!([person.0]));
        }
        if ctx.rng.chance(0.2) {
            put(&mut row, "description", *ctx.rng.pick(pools::NOTE_BODIES));
        }
        if day < ctx.today && ctx.rng.chance(0.06) {
            put(&mut row, "cancelled", true);
        }
        if let Some(when) = ctx.trashed() {
            put(&mut row, "trashed", when);
        }
        rows.push(Value::Object(row));
    }
    rows
}

fn tasks(ctx: &mut Ctx, root: &Rng, people: &[(String, String)], lists: &[String]) -> Vec<Value> {
    ctx.rng = root.fork("tasks");
    let count = ctx.count(30, 55, ctx.profile.busy);
    let mut titles = Titles::default();
    let mut top_level: Vec<String> = Vec::new();
    let mut rows: Vec<Value> = Vec::new();
    for index in 0..count {
        let person = ctx.rng.pick(people).clone();
        let first = person.1.split(' ').next().unwrap_or_default().to_owned();
        let city = ctx.rng.pick(pools::CITIES).to_string();
        let name = titles.make(ctx, |rng| {
            let template = rng.pick(pools::TASK_TEMPLATES);
            fill(template, &first, &city)
        });
        let mut row = Map::new();
        put(&mut row, "key", format!("t{index}"));
        put(&mut row, "name", name);
        let due = if ctx.rng.chance(0.65) {
            let day = if ctx.rng.chance(0.5) {
                ctx.past(0, ctx.history)
            } else {
                ctx.future(1, 45)
            };
            put(&mut row, "due", format!("{day}T09:00"));
            Some(day)
        } else {
            None
        };
        if ctx.rng.chance(0.4) {
            put(
                &mut row,
                "effort",
                *ctx.rng.pick(&[10, 15, 30, 45, 60, 90, 120]),
            );
        }
        if ctx.rng.chance(0.5) {
            put(&mut row, "priority", ctx.rng.range(1, 9));
        }
        if ctx.rng.chance(0.2) {
            put(&mut row, "description", *ctx.rng.pick(pools::NOTE_BODIES));
        }
        if !lists.is_empty() && ctx.rng.chance(0.7) {
            put(&mut row, "list", ctx.rng.pick(lists).clone());
        }
        if top_level.len() > 3 && ctx.rng.chance(0.12) {
            // a subtask of an earlier top-level task (a subtask has no subtasks)
            let parent = ctx.rng.pick(&top_level).clone();
            put(&mut row, "parent", parent);
        } else {
            top_level.push(format!("t{index}"));
        }
        // A parent's trash, completion or cancellation reaches its subtasks, so a subtask of a
        // parent that was touched is left alone: the vault would refuse the second command.
        let parent_touched = row
            .get("parent")
            .and_then(Value::as_str)
            .is_some_and(|parent| {
                rows.iter().any(|r| {
                    r["key"] == parent && (r.get("trashed").is_some() || r.get("status").is_some())
                })
            });
        let past = due.is_some_and(|d| d < ctx.today);
        if !parent_touched {
            if ctx.rng.chance(if past { 0.7 } else { 0.15 }) {
                put(&mut row, "status", "completed");
                put(&mut row, "completed", ctx.when_ago(0, ctx.history.min(60)));
            } else if ctx.rng.chance(0.05) {
                put(&mut row, "status", "cancelled");
            }
        }
        let parent_trashed = parent_touched;
        if let Some(when) = ctx.trashed().filter(|_| !parent_trashed) {
            put(&mut row, "trashed", when);
        }
        rows.push(Value::Object(row));
    }
    rows
}

fn containers(ctx: &mut Ctx, prefix: &str, pool: &[&str], low: i64, high: i64) -> Vec<Value> {
    let count = (ctx.count(low, high, 1.0)).min(pool.len());
    ctx.rng
        .sample(pool.len(), count)
        .into_iter()
        .enumerate()
        .map(|(index, pick)| json!({"key": format!("{prefix}{index}"), "name": pool[pick]}))
        .collect()
}

fn notes(ctx: &mut Ctx, root: &Rng) -> (Vec<Value>, Vec<Value>) {
    ctx.rng = root.fork("notes");
    let notebooks = containers(ctx, "nb", pools::NOTEBOOKS, 3, 6);
    let keys = keys_of(&notebooks);
    let count = ctx.count(20, 40, ctx.profile.paper);
    let mut titles = Titles::default();
    let mut rows = Vec::new();
    for index in 0..count {
        let name = titles.make(ctx, |rng| rng.pick(pools::NOTE_TITLES).to_string());
        let mut row = Map::new();
        put(&mut row, "key", format!("n{index}"));
        put(&mut row, "name", name);
        put(&mut row, "body", *ctx.rng.pick(pools::NOTE_BODIES));
        put(&mut row, "created", ctx.when_ago(0, ctx.history));
        if ctx.rng.chance(0.75) {
            put(&mut row, "notebook", ctx.rng.pick(&keys).clone());
        }
        if ctx.rng.chance(0.12) {
            put(&mut row, "pinned", true);
        }
        if ctx.rng.chance(0.12) {
            put(&mut row, "starred", true);
        }
        if let Some(when) = ctx.trashed() {
            put(&mut row, "trashed", when);
        }
        rows.push(Value::Object(row));
    }
    (notebooks, rows)
}

fn documents(ctx: &mut Ctx, root: &Rng) -> (Vec<Value>, Vec<Value>) {
    ctx.rng = root.fork("documents");
    let folders = containers(ctx, "f", pools::FOLDERS, 3, 6);
    let keys = keys_of(&folders);
    let count = ctx.count(10, 22, ctx.profile.paper);
    let mut titles = Titles::default();
    let mut rows = Vec::new();
    for index in 0..count {
        let year = ctx.today.year() - i16::try_from(ctx.rng.range(0, 3)).unwrap_or(0);
        let name = titles.make(ctx, |rng| format!("{} {year}", rng.pick(pools::DOC_TITLES)));
        let mut row = Map::new();
        put(&mut row, "key", format!("d{index}"));
        put(&mut row, "name", name);
        put(&mut row, "text", *ctx.rng.pick(pools::NOTE_BODIES));
        put(&mut row, "created", ctx.when_ago(0, ctx.history));
        if ctx.rng.chance(0.8) {
            put(&mut row, "folder", ctx.rng.pick(&keys).clone());
        }
        if ctx.rng.chance(0.1) {
            put(&mut row, "starred", true);
        }
        if let Some(when) = ctx.trashed() {
            put(&mut row, "trashed", when);
        }
        rows.push(Value::Object(row));
    }
    (folders, rows)
}

fn photos(ctx: &mut Ctx, root: &Rng) -> (Vec<Value>, Vec<Value>) {
    ctx.rng = root.fork("photos");
    let albums = containers(ctx, "a", pools::ALBUMS, 3, 6);
    let keys = keys_of(&albums);
    let count = ctx.count(18, 45, ctx.profile.social);
    let mut titles = Titles::default();
    let mut rows = Vec::new();
    for index in 0..count {
        let name = titles.make(ctx, |rng| {
            format!(
                "{} {}",
                rng.pick(pools::PHOTO_TITLES),
                rng.pick(pools::CITIES)
            )
        });
        let taken = ctx.when_ago(0, ctx.history);
        let mut row = Map::new();
        put(&mut row, "key", format!("ph{index}"));
        put(&mut row, "name", name);
        put(&mut row, "taken", taken.clone());
        put(&mut row, "created", taken);
        if ctx.rng.chance(0.7) {
            let mut albums = vec![ctx.rng.pick(&keys).clone()];
            if ctx.rng.chance(0.2) {
                albums.push(ctx.rng.pick(&keys).clone());
                albums.dedup();
            }
            put(&mut row, "albums", albums);
        }
        if ctx.rng.chance(0.12) {
            put(&mut row, "starred", true);
        }
        if let Some(when) = ctx.trashed() {
            put(&mut row, "trashed", when);
        }
        rows.push(Value::Object(row));
    }
    (albums, rows)
}

/// Locker rows are PRESENCE ONLY: a name, a type, the plain fields the type keeps and a `sealed`
/// list naming which secrets exist. No secret value is ever generated.
fn locker(ctx: &mut Ctx, root: &Rng) -> Vec<Value> {
    ctx.rng = root.fork("locker");
    let count = ctx
        .count(8, 14, ctx.profile.paper)
        .min(pools::LOCKER_ITEMS.len());
    let mut titles = Titles::default();
    let mut rows = Vec::new();
    let picks = ctx.rng.sample(pools::LOCKER_ITEMS.len(), count);
    for (index, pick) in picks.into_iter().enumerate() {
        let (base, kind) = pools::LOCKER_ITEMS[pick];
        let name = titles.make(ctx, |_| base.to_owned());
        let mut row = Map::new();
        put(&mut row, "key", format!("k{index}"));
        put(&mut row, "name", name);
        put(&mut row, "type", kind);
        let sealed: &[&str] = match kind {
            "login" => &["password"],
            "wifi" | "password" => &["password"],
            "card" => &["card_number", "cvv"],
            "note" => &["content"],
            _ => &[],
        };
        put(&mut row, "sealed", sealed.to_vec());
        if kind == "login" {
            let user = ctx.rng.pick(pools::FIRST).to_lowercase();
            put(&mut row, "username", user.clone());
            put(&mut row, "url", format!("https://{}.example", user));
        }
        if ctx.rng.chance(0.2) {
            put(&mut row, "starred", true);
        }
        if let Some(when) = ctx.trashed() {
            put(&mut row, "trashed", when);
        }
        rows.push(Value::Object(row));
    }
    rows
}

fn first_of_window(ctx: &Ctx) -> Date {
    let months = i64::from(TRANSACTION_MONTHS) - 1;
    ctx.today
        .first_of_month()
        .checked_sub(months.months())
        .unwrap_or(ctx.today)
}

struct Account {
    key: String,
    name: String,
    kind: String,
    currency: String,
}

struct Line<'a> {
    account: &'a str,
    day: Date,
    merchant: &'a str,
    description: &'a str,
    category: Option<&'a str>,
    amount: f64,
}

#[derive(Default)]
struct Ledger {
    rows: Vec<Value>,
    /// Outflow per `(month, category)`, what the budgets are sized from.
    spent: std::collections::BTreeMap<(String, String), f64>,
    /// A merchant's one alternative spelling, so a near twin recurs the way a statement's does.
    spellings: Vec<(String, String)>,
}

impl Ledger {
    /// Add a line and return its key.
    fn push(&mut self, ctx: &mut Ctx, month: &str, line: &Line<'_>) -> String {
        let key = format!("x{}", self.rows.len());
        let mut name = line.merchant.to_owned();
        if ctx.rng.chance(ctx.settings.near_duplicates * 0.5) {
            name = if let Some((_, spelt)) = self.spellings.iter().find(|(m, _)| m == line.merchant)
            {
                spelt.clone()
            } else {
                let spelt = twin(&mut ctx.rng, line.merchant);
                self.spellings
                    .push((line.merchant.to_owned(), spelt.clone()));
                spelt
            };
        }
        let mut row = json!({
            "key": key, "account": line.account, "date": line.day.to_string(),
            "amount": (line.amount * 100.0).round() / 100.0, "name": name,
            "description": line.description,
        });
        if let Some(category) = line.category.filter(|_| ctx.rng.chance(0.88)) {
            row["category"] = json!(category);
            if line.amount < 0.0 {
                *self
                    .spent
                    .entry((month.to_owned(), category.to_owned()))
                    .or_default() -= line.amount;
            }
        }
        // a removed transaction cannot be part of a transfer, and transfers carry no category
        if line.category.is_some() && ctx.rng.chance(0.02) {
            row["void"] = json!(true);
        }
        self.rows.push(row);
        key
    }
}

/// Accounts, transactions, transfers, categories, rules and budgets, over the months the runtime
/// reads (`TRANSACTION_MONTHS`), shortened to the world's history if that is shorter.
fn money(ctx: &mut Ctx, root: &Rng, persona: &Persona) -> Vec<(String, Value)> {
    ctx.rng = root.fork("money");
    let mut wanted: Vec<usize> = vec![0, 1];
    if ctx.rng.chance(0.7) {
        wanted.push(2);
    }
    if ctx.rng.chance(0.4) {
        wanted.push(3);
    }
    let mut accounts: Vec<Account> = Vec::new();
    for (index, pick) in wanted.into_iter().enumerate() {
        let (name, kind) = pools::ACCOUNTS[pick];
        let currency = if kind == "credit_card" && ctx.rng.chance(0.25) {
            if persona.currency == "EUR" {
                "GBP"
            } else {
                "EUR"
            }
            .to_owned()
        } else {
            persona.currency.clone()
        };
        accounts.push(Account {
            key: format!("acc{index}"),
            name: name.to_owned(),
            kind: kind.to_owned(),
            currency,
        });
    }
    let account_rows: Vec<Value> = accounts
        .iter()
        .map(|account| {
            let mut row = json!({"key": account.key, "name": account.name, "kind": account.kind});
            if account.currency != persona.currency {
                row["currency"] = json!(account.currency);
            }
            row
        })
        .collect();
    let spending: Vec<usize> = accounts
        .iter()
        .enumerate()
        .filter(|(_, a)| a.kind != "savings")
        .map(|(i, _)| i)
        .collect();
    let window_start = first_of_window(ctx).max(ctx.ago(ctx.history));
    let profile = ctx.profile;
    let mut ledger = Ledger::default();
    let mut transfers: Vec<Value> = Vec::new();
    let mut month = window_start.first_of_month();
    while month <= ctx.today {
        let last = month.last_of_month().min(ctx.today);
        let first = month.max(window_start);
        let span = i64::from((last - first).get_days()) + 1;
        let ym = format!("{:04}-{:02}", month.year(), month.month());
        let checking = accounts[0].key.clone();
        let employer = *ctx.rng.pick(pools::EMPLOYERS);
        let pay = (2400.0 * profile.income * (0.95 + 0.1 * ctx.rng.unit())).round();
        let description = format!("{} CORP PAYROLL", employer.to_uppercase());
        let merchant = format!("{employer} payroll");
        ledger.push(
            ctx,
            &ym,
            &Line {
                account: &checking,
                day: first,
                merchant: &merchant,
                description: &description,
                category: Some("income.pay"),
                amount: pay,
            },
        );
        let rent = -(1100.0 * profile.rent).round();
        ledger.push(
            ctx,
            &ym,
            &Line {
                account: &checking,
                day: first,
                merchant: "Landlord",
                description: "RENT PAYMENT",
                category: Some("housing.rent"),
                amount: rent,
            },
        );
        for _ in 0..ctx.count(28, 48, profile.money) {
            let &(merchant, description, category, typical) = ctx.rng.pick(pools::MERCHANTS);
            if category == "housing.rent" {
                continue;
            }
            let account = accounts[*ctx.rng.pick(&spending)].key.clone();
            let amount = typical * (0.5 + ctx.rng.unit());
            let day = first
                .checked_add(ctx.rng.range(0, span - 1).days())
                .unwrap_or(first);
            ledger.push(
                ctx,
                &ym,
                &Line {
                    account: &account,
                    day,
                    merchant,
                    description,
                    category: Some(category),
                    amount: -amount,
                },
            );
        }
        if ctx.rng.chance(0.4) {
            let day = first
                .checked_add(ctx.rng.range(0, span - 1).days())
                .unwrap_or(first);
            let amount = 10.0 + 60.0 * ctx.rng.unit();
            ledger.push(
                ctx,
                &ym,
                &Line {
                    account: &checking,
                    day,
                    merchant: "Refund",
                    description: "REFUND AMZN",
                    category: Some("shopping.general"),
                    amount,
                },
            );
        }
        // a transfer to savings: out of checking, in to savings, the same day and amount
        if let Some(savings) = accounts
            .iter()
            .find(|a| a.kind == "savings" && a.currency == accounts[0].currency)
        {
            let day = first
                .checked_add(ctx.rng.range(0, span - 1).days())
                .unwrap_or(first);
            let amount = (100.0 + 400.0 * ctx.rng.unit()).round();
            let out = ledger.push(
                ctx,
                &ym,
                &Line {
                    account: &checking,
                    day,
                    merchant: "Transfer to savings",
                    description: "TRANSFER TO SAVINGS",
                    category: None,
                    amount: -amount,
                },
            );
            let into = ledger.push(
                ctx,
                &ym,
                &Line {
                    account: &savings.key.clone(),
                    day,
                    merchant: "Transfer from checking",
                    description: "TRANSFER FROM CHECKING",
                    category: None,
                    amount,
                },
            );
            transfers.push(json!({"a": out, "b": into}));
        }
        let Ok(next) = month.checked_add(1.month()) else {
            break;
        };
        month = next;
    }
    let mut categories = Vec::new();
    let custom = ctx.rng.range(1, 2) as usize;
    for (index, pick) in ctx
        .rng
        .sample(pools::CUSTOM_CATEGORIES.len(), custom)
        .into_iter()
        .enumerate()
    {
        categories
            .push(json!({"key": format!("c{index}"), "name": pools::CUSTOM_CATEGORIES[pick]}));
    }
    let mut rules = Vec::new();
    let wanted_rules = ctx.rng.range(2, 4) as usize;
    for (index, pick) in ctx
        .rng
        .sample(pools::MERCHANTS.len(), wanted_rules)
        .into_iter()
        .enumerate()
    {
        let (_, description, category, _) = pools::MERCHANTS[pick];
        if category == "fees" || category == "transport" {
            continue;
        }
        rules.push(json!({
            "key": format!("r{index}"), "match": "contains",
            "text": description.split(' ').next().unwrap_or(description), "category": category,
        }));
    }
    // a plan for each of the six categories spent in most, in every month the ledger holds
    let mut by_category: std::collections::BTreeMap<&str, f64> = std::collections::BTreeMap::new();
    for ((_, category), amount) in &ledger.spent {
        *by_category.entry(category.as_str()).or_default() += amount;
    }
    let mut ranked: Vec<(&str, f64)> = by_category.into_iter().collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(b.0)));
    let mut months: Vec<&String> = ledger.spent.keys().map(|(m, _)| m).collect();
    months.dedup();
    let mut budgets = Vec::new();
    for (category, total) in ranked.iter().take(6) {
        let monthly = total / months.len().max(1) as f64;
        let carry = ctx.rng.chance(0.3);
        for month in &months {
            let amount = ((monthly * (0.8 + 0.5 * ctx.rng.unit())) / 10.0).round() * 10.0;
            if amount > 0.0 {
                budgets.push(
                    json!({"month": month, "category": category, "amount": amount, "carry": carry}),
                );
            }
        }
    }
    vec![
        ("accounts".to_owned(), Value::Array(account_rows)),
        ("transactions".to_owned(), Value::Array(ledger.rows)),
        ("transfers".to_owned(), Value::Array(transfers)),
        ("categories".to_owned(), Value::Array(categories)),
        ("rules".to_owned(), Value::Array(rules)),
        ("budgets".to_owned(), Value::Array(budgets)),
    ]
}

fn health_days(ctx: &mut Ctx, root: &Rng) -> Vec<Value> {
    ctx.rng = root.fork("health_days");
    let span = ctx.history.min(HEALTH_DAYS - 1);
    let profile = ctx.profile;
    let base_steps = 7000.0 * profile.steps;
    let mut weight = 60.0 + 30.0 * ctx.rng.unit();
    let resting = 52.0 + 18.0 * ctx.rng.unit();
    let mut days = Vec::new();
    for back in (1..=span).rev() {
        let day = ctx.ago(back).to_string();
        let weekend = ctx.ago(back).weekday().to_monday_zero_offset() >= 5;
        let mut add = |metric: &str, value: Value| {
            days.push(json!({"day": day, "metric": metric, "value": value}))
        };
        if ctx.rng.chance(0.93) {
            let steps =
                base_steps * (0.45 + 1.1 * ctx.rng.unit()) * if weekend { 0.85 } else { 1.0 };
            add("steps", json!(steps.round() as i64));
        }
        if ctx.rng.chance(0.9) {
            add("sleep_min", json!(ctx.rng.range(330, 520)));
        }
        if ctx.rng.chance(0.65) {
            add(
                "exercise_min",
                json!((ctx.rng.range(5, 80) as f64 * profile.steps) as i64),
            );
        }
        if ctx.rng.chance(0.7) {
            add("active_energy_kcal", json!(ctx.rng.range(180, 780)));
        }
        if ctx.rng.chance(0.55) {
            add(
                "resting_hr_bpm",
                json!((resting + ctx.rng.range(-4, 4) as f64) as i64),
            );
        }
        if ctx.rng.chance(0.3) {
            weight += (ctx.rng.unit() - 0.5) * 0.4;
            add("weight_kg", json!((weight * 10.0).round() / 10.0));
        }
    }
    days
}

fn workouts(ctx: &mut Ctx, root: &Rng) -> Vec<Value> {
    ctx.rng = root.fork("workouts");
    let span = ctx.history.min(HEALTH_DAYS - 1);
    let weeks = span as f64 / 7.0;
    let count = ((weeks * ctx.profile.workouts_per_week) * (0.7 + 0.6 * ctx.rng.unit()))
        .round()
        .max(4.0) as usize;
    let kinds: Vec<(&str, u32)> = vec![
        ("run", 5),
        ("walk", 4),
        ("cycle", 3),
        ("strength", 3),
        ("swim", 1),
        ("hike", 1),
        ("yoga", 2),
        ("other", 1),
    ];
    let mut rows = Vec::new();
    for index in 0..count {
        let kind = *ctx.rng.weighted(&kinds);
        let back = ctx.rng.range(1, span);
        let day = ctx.ago(back);
        let hour = ctx.rng.range(6, 19);
        let minutes = match kind {
            "run" => ctx.rng.range(20, 65),
            "walk" => ctx.rng.range(25, 90),
            "cycle" => ctx.rng.range(30, 120),
            "hike" => ctx.rng.range(90, 240),
            "swim" => ctx.rng.range(25, 60),
            _ => ctx.rng.range(25, 75),
        };
        let (eh, em) = (hour + minutes / 60, minutes % 60);
        let mut row = Map::new();
        put(&mut row, "key", format!("w{index}"));
        put(&mut row, "kind", kind);
        put(&mut row, "starts", format!("{day}T{hour:02}:00:00Z"));
        put(
            &mut row,
            "ends",
            format!("{day}T{:02}:{em:02}:00Z", eh.min(23)),
        );
        let mut measured = Map::new();
        if ctx.rng.chance(0.85) {
            put(
                &mut measured,
                "recorded_by",
                *ctx.rng.pick(&["Apple Watch", "Phone", "Garmin"]),
            );
            put(&mut measured, "moving_s", (minutes * 60 * 9 / 10).max(60));
            let speed = match kind {
                "run" => 2.9,
                "walk" => 1.4,
                "cycle" => 6.0,
                "hike" => 1.2,
                "swim" => 0.5,
                _ => 0.0,
            };
            if speed > 0.0 {
                put(
                    &mut measured,
                    "distance_m",
                    ((minutes * 60) as f64 * speed * (0.8 + 0.4 * ctx.rng.unit())).round(),
                );
            }
            put(
                &mut measured,
                "energy_kcal",
                (minutes as f64 * (5.0 + 6.0 * ctx.rng.unit())).round(),
            );
            put(&mut measured, "heart_bpm", ctx.rng.range(95, 175));
            if matches!(kind, "hike" | "cycle" | "run") && ctx.rng.chance(0.6) {
                put(&mut measured, "climb_m", (ctx.rng.unit() * 400.0).round());
            }
            put(&mut row, "workout", measured);
        }
        rows.push(Value::Object(row));
    }
    rows
}

fn links(
    ctx: &mut Ctx,
    root: &Rng,
    people: &[(String, String)],
    tasks: &[String],
    notes: &[String],
    events: &[String],
) -> Vec<Value> {
    ctx.rng = root.fork("links");
    let mut rows: Vec<Value> = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let sources: Vec<&String> = tasks.iter().chain(notes).chain(events).collect();
    let count = ctx.count(10, 22, 1.0).min(sources.len());
    for pick in ctx.rng.sample(sources.len(), count) {
        let from = sources[pick].clone();
        let to = ctx.rng.pick(people).0.clone();
        if seen.insert((from.clone(), to.clone())) {
            rows.push(json!({"from": from, "to": to}));
        }
    }
    rows
}
