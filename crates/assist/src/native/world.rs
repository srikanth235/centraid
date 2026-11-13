//! THE WORLD AS THE MODEL SEES IT — every model-facing row, read out of the
//! vault through the kit's paged reads and mapped by the metadata table.
//!
//! It is re-read after every write, so a row's fields are always the vault's.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::row::{Cell, Row as VaultRow};

use crate::native::dates::Stamp;
use crate::native::door::{Door, WindowQuery, int, text};
use crate::native::meta::{Field, FieldType, Kind, Via};

/// The days before today the runtime reads events in, in the person's zone, with every repeating
/// series expanded (R-1088-8). An event farther away is read as stored.
pub const EVENT_DAYS_BACK: i64 = 31;
/// The days after today (Agenda's own default horizon for an open-ended `upcoming`).
pub const EVENT_DAYS_AHEAD: i64 = 120;

/// The months of transactions the world holds, this month and the ones before it (#1099,
/// R-1099-8): the chat answers about what the member just spent, and a world is re-read after
/// every write, so the read is bounded by months and never walks a ledger's years. A question
/// about an older month finds nothing here and says so.
pub const TRANSACTION_MONTHS: u32 = 3;
/// The days of Health the world holds, today and the ones before it (#1135): the chat answers
/// about how the member slept and moved lately, and a world is re-read after every write, so the
/// read is bounded by days and never walks the years the store backfilled. A figure's `value` is
/// read to the nearest whole unit (a weight to the kilogram); Health's own Trends keep the
/// decimals.
pub const HEALTH_DAYS: i64 = 90;
/// Transactions read per chunk when the display names are fetched by id.
const DECORATION_CHUNK: usize = 200;
/// The newest entities of each kind the world holds (#1188, C3). A world is read before a turn and
/// after every write, so what it reads is bounded by this and by the days and months above, never
/// by what the vault holds. A row older than the window is reached by name (`Session::reach`) and
/// pinned into the world; a kind that left rows unread is in [`World::older`], so an answer over it
/// says it looked at the newest only.
pub const WINDOW_ROWS: usize = 500;
/// The rows reached by name that a session keeps in its world across reloads, oldest dropped first.
pub const PINNED_ROWS: usize = 1024;
/// The most rows a call's date range or kind may hold for the runtime to read them all in (see
/// `Session::store_reach`): past it the answer is not exact and a count says so.
pub const HYDRATE_ROWS: usize = 1000;
/// The ids one `IN (…)` read carries.
const IN_CHUNK: usize = DECORATION_CHUNK;
/// The columns of an entity the world reads.
const ENTITY_COLUMNS: &str = "id, kind, title, created_at, updated_at, deleted_at, purge_at";

/// Where and when the person stands: their today, and the zone their days are in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Standing {
    pub today: jiff::civil::Date,
    /// An IANA zone name (`Etc/UTC`, `Pacific/Auckland`).
    pub tz: String,
}

/// An event's `date` and `duration`, read from where it starts and where it ends: a day when it
/// starts at midnight and runs a whole number of days, else its start and its length in minutes.
pub(crate) fn shape_event(row: &mut Row, start: Option<Stamp>, end: Option<Stamp>) {
    row.fields.remove("duration");
    row.date = start;
    if let (Some(start), Some(end)) = (start, end) {
        let minutes = end.at().duration_since(start.at()).as_secs() / 60;
        let all_day = start.time == Some(jiff::civil::Time::midnight())
            && minutes > 0
            && minutes % (24 * 60) == 0;
        if all_day {
            row.date = Some(Stamp {
                date: start.date,
                time: None,
            });
        } else {
            row.fields.insert("duration", Val::Num(minutes));
        }
    }
}

/// A model-facing value.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Val {
    Text(String),
    Num(i64),
    /// Minor units and the ISO currency.
    Money(i64, String),
    Enum(&'static str),
    Bool(bool),
    Date(Stamp),
}

impl Val {
    /// How a row line and a diff spell it.
    #[must_use]
    pub fn show(&self, field: Option<&Field>) -> String {
        match self {
            Self::Text(value) => format!("\"{value}\""),
            Self::Num(value) => match field.and_then(|field| field.unit) {
                Some(unit) if unit != crate::native::meta::PRIORITY_SCALE => {
                    format!("{value} {unit}")
                }
                _ => value.to_string(),
            },
            Self::Money(minor, currency) => money(*minor, currency),
            Self::Enum(value) => (*value).to_owned(),
            Self::Bool(value) => if *value { "yes" } else { "no" }.to_owned(),
            Self::Date(stamp) => stamp.show(),
        }
    }

    /// The machine form the scorer reads.
    #[must_use]
    pub fn json(&self) -> serde_json::Value {
        match self {
            Self::Text(value) => serde_json::json!(value),
            Self::Num(value) => serde_json::json!(value),
            Self::Money(minor, currency) => {
                serde_json::json!({"amount": units(*minor, currency), "unit": currency})
            }
            Self::Enum(value) => serde_json::json!(value),
            Self::Bool(value) => serde_json::json!(value),
            Self::Date(stamp) => serde_json::json!(stamp.vault()),
        }
    }
}

/// What a sealed locker value shows as until it is revealed.
pub const SEALED: &str = "sealed";

/// The locker columns that are neither sealed nor a model field.
pub const LOCKER_PLAIN: [&str; 8] = [
    "cardholder",
    "expiry",
    "brand",
    "fullname",
    "email",
    "phone",
    "address",
    "network",
];

/// `42.00 USD`.
#[must_use]
pub fn money(minor: i64, currency: &str) -> String {
    let digits = usize::from(centraid_apps_kit::money::minor_units(currency));
    if digits == 0 {
        return format!("{minor} {currency}");
    }
    let scale = 10_i64.pow(u32::try_from(digits).unwrap_or(2));
    let sign = if minor < 0 { "-" } else { "" };
    let abs = minor.abs();
    format!(
        "{sign}{}.{:0digits$} {currency}",
        abs / scale,
        abs % scale,
        digits = digits
    )
}

/// Currency units as a float, for the machine-readable effect.
#[must_use]
pub fn units(minor: i64, currency: &str) -> f64 {
    let digits = i32::from(centraid_apps_kit::money::minor_units(currency));
    minor as f64 / 10_f64.powi(digits)
}

/// Currency units → minor units.
#[must_use]
pub fn minor_of(amount: f64, currency: &str) -> i64 {
    let digits = i32::from(centraid_apps_kit::money::minor_units(currency));
    (amount * 10_f64.powi(digits)).round() as i64
}

pub type Key = (Kind, String);

/// One model-facing row.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub kind: Kind,
    pub id: String,
    pub name: String,
    pub date: Option<Stamp>,
    pub fields: BTreeMap<&'static str, Val>,
    pub trashed: bool,
    pub created: String,
    pub updated: String,
    /// Vault facts a write needs (a content id, a key id, a currency).
    pub extra: BTreeMap<&'static str, String>,
}

impl Row {
    /// A row from its entity: the name, the stamps and the trash window are the entity's own.
    fn of(kind: Kind, id: &str, entity: &VaultRow, fields: BTreeMap<&'static str, Val>) -> Self {
        let mut extra = BTreeMap::new();
        if let Some(purge) = text(entity, "purge_at") {
            extra.insert("purge_at", purge);
        }
        Self {
            kind,
            id: id.to_owned(),
            name: text(entity, "title").unwrap_or_default(),
            date: None,
            fields,
            trashed: text(entity, "deleted_at").is_some(),
            created: text(entity, "created_at").unwrap_or_default(),
            updated: text(entity, "updated_at").unwrap_or_default(),
            extra,
        }
    }

    #[must_use]
    pub fn key(&self) -> Key {
        (self.kind, self.id.clone())
    }

    #[must_use]
    pub fn field(&self, name: &str) -> Option<&Val> {
        self.fields.get(name)
    }

    #[must_use]
    pub fn starred(&self) -> bool {
        self.fields.get("starred") == Some(&Val::Bool(true))
    }
}

/// One edge between two model rows.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Edge {
    pub from: Key,
    pub to: Key,
    pub via: Via,
}

/// Everything the tools read.
#[derive(Debug, Clone, Default)]
pub struct World {
    pub rows: BTreeMap<Key, Row>,
    pub edges: Vec<Edge>,
    pub me: String,
    pub currency: String,
    pub calendar: String,
    pub locker_key: Option<String>,
    /// The areas lists sit in, `(id, title)`: containers the model has no kind for.
    pub areas: Vec<(String, String)>,
    /// The health store the vault follows, as its origin labels it ("Apple Health"): it states
    /// the daily figures at each read, so the member does not write them. A followed workout
    /// carries the same label in its row's `extra` as `followed_by`.
    pub health_store: Option<String>,
    /// The IANA zone the person's days are in: an instant the vault keeps in UTC (a workout's
    /// start) is shown on their clock, and a time they say is kept as the instant it is.
    pub zone: String,
    /// The kinds whose rows older than the window were left unread (see [`WINDOW_ROWS`]).
    pub older: BTreeSet<Kind>,
}

/// Today in the person's zone, else the door's clock read in UTC.
fn today_of(door: &dyn Door, at: Option<&Standing>) -> jiff::civil::Date {
    match at {
        Some(standing) => standing.today,
        None => jiff::Timestamp::from_millisecond(door.now_ms())
            .unwrap_or_default()
            .to_zoned(jiff::tz::TimeZone::UTC)
            .date(),
    }
}

/// A numeric cell to the nearest whole number (0 when absent).
fn rounded(row: &VaultRow, column: &str) -> i64 {
    match row.get(column) {
        Some(Cell::Integer(value)) => *value,
        Some(Cell::Real(value)) => value.round() as i64,
        _ => int(row, column).unwrap_or_default(),
    }
}

/// An instant the vault keeps (`2026-03-04T07:00:00.000Z`) on the clock of `zone`.
pub(crate) fn local_stamp(zone: &str, instant: &str) -> Option<Stamp> {
    let zoned = instant
        .parse::<jiff::Timestamp>()
        .ok()
        .and_then(|at| jiff::tz::TimeZone::get(zone).ok().map(|tz| at.to_zoned(tz)));
    match zoned {
        Some(zoned) => {
            let civil = zoned.datetime();
            Some(Stamp {
                date: civil.date(),
                time: Some(civil.time()),
            })
        }
        None => Stamp::parse(instant),
    }
}

/// Creation dates use the same minute precision as `Stamp::parse` and parked writes.
/// Convert the zone first so the date and minute are both the member's.
fn local_created_stamp(zone: &str, instant: &str) -> Option<Stamp> {
    let stamp = local_stamp(zone, instant)?;
    Stamp::parse(&stamp.vault())
}

/// The instant a wall-clock time of `zone` is, as the vault keeps one (`2026-03-04T12:00:00Z`).
pub(crate) fn utc_instant(zone: &str, civil: jiff::civil::DateTime) -> Option<String> {
    let tz = jiff::tz::TimeZone::get(zone).ok()?;
    let at = civil.to_zoned(tz).ok()?.timestamp();
    Some(at.strftime("%Y-%m-%dT%H:%M:%SZ").to_string())
}

fn stamp(value: Option<String>) -> Option<Stamp> {
    value.as_deref().and_then(Stamp::parse)
}

fn put(fields: &mut BTreeMap<&'static str, Val>, name: &'static str, value: Option<Val>) {
    if let Some(value) = value {
        fields.insert(name, value);
    }
}

fn nonempty(value: Option<String>) -> Option<Val> {
    value.filter(|text| !text.is_empty()).map(Val::Text)
}

/// The instant the baseline migration seeds Money's stock categories
/// (`contracts/migrations/001_baseline.sql`): a category created then is vocabulary, not a row.
const STOCK_CATEGORIES_AT: &str = "2026-10-21T00:00:00.000Z";

impl World {
    #[must_use]
    pub fn row(&self, key: &Key) -> Option<&Row> {
        self.rows.get(key)
    }

    /// Every row of a kind, live or trashed.
    pub fn of_kind(&self, kind: Kind) -> impl Iterator<Item = &Row> {
        self.rows.values().filter(move |row| row.kind == kind)
    }

    /// The row of the person who owns the vault.
    #[must_use]
    pub fn me_key(&self) -> Key {
        (Kind::Person, self.me.clone())
    }

    /// Whether `row` is linked to `target` under the metadata's link table.
    /// A same-kind link (subtasks) reads one way: the target's children.
    #[must_use]
    pub fn linked(&self, row: &Key, target: &Key) -> bool {
        if row.0.spec().link_to(target.0).is_none() {
            return false;
        }
        self.edges.iter().any(|edge| {
            (edge.from == *target && edge.to == *row)
                || (row.0 != target.0 && edge.from == *row && edge.to == *target)
        })
    }

    /// Every row linked to `key`, by kind.
    #[must_use]
    pub fn neighbours(&self, key: &Key) -> BTreeMap<Kind, Vec<Key>> {
        let mut out: BTreeMap<Kind, BTreeSet<Key>> = BTreeMap::new();
        for edge in &self.edges {
            let other = if edge.from == *key {
                &edge.to
            } else if edge.to == *key && !(edge.from.0 == key.0 && edge.via == Via::Subtask) {
                &edge.from
            } else {
                continue;
            };
            if key.0.spec().link_to(other.0).is_none() {
                continue;
            }
            out.entry(other.0).or_default().insert(other.clone());
        }
        out.into_iter()
            .map(|(kind, keys)| (kind, keys.into_iter().collect()))
            .collect()
    }

    /// The parent of a subtask.
    #[must_use]
    pub fn parent_of(&self, key: &Key) -> Option<Key> {
        self.edges
            .iter()
            .find(|edge| edge.via == Via::Subtask && edge.to == *key)
            .map(|edge| edge.from.clone())
    }

    /// Take the rows and edges of `other` that this world lacks, as a session does with rows it
    /// reached by name (`Session::reach`): a row this world already holds keeps its own fields,
    /// which a parked write may have patched.
    pub fn absorb(&mut self, other: &Self) {
        for (key, row) in &other.rows {
            self.rows.entry(key.clone()).or_insert_with(|| row.clone());
        }
        self.edges.extend(other.edges.iter().cloned());
        let rows = &self.rows;
        self.edges
            .retain(|edge| rows.contains_key(&edge.from) && rows.contains_key(&edge.to));
        self.edges.sort();
        self.edges.dedup();
    }

    /// Load everything, the Locker and the recent transactions included.
    pub fn load(door: &dyn Door) -> Result<Self, String> {
        Self::load_in(door, None)
    }

    /// Load everything, the events of the days around `at.today` read in the zone `at.tz` with
    /// every repeating series expanded (R-1088-8, [`Door::events`]). The transactions of the last
    /// [`TRANSACTION_MONTHS`] months are read too. No sealed Locker column is ever read: a Locker
    /// item is in the world by its plain rows, and each sealed cell it holds is a presence bit.
    ///
    /// **The vault's tables, read as an app reads them** (#1135): an entity row (its title, its
    /// trash) beside its kind row, and the relations as edges or as the column that holds them.
    /// A container's kind is the container's own.
    pub fn load_in(door: &dyn Door, at: Option<&Standing>) -> Result<Self, String> {
        Self::load_pinned(door, at, &BTreeSet::new())
    }

    /// [`load_in`](Self::load_in), and the rows of `pinned` as well, wherever they sit: the rows a
    /// session reached by name that are older than each kind's window (#1188, C3). Every read is
    /// bounded: a kind's newest [`WINDOW_ROWS`] entities, then its rows, edges and flags by chunks
    /// of those ids. Nothing reads a table whole, so the cost follows the windows and not the vault.
    pub fn load_pinned(
        door: &dyn Door,
        at: Option<&Standing>,
        pinned: &BTreeSet<String>,
    ) -> Result<Self, String> {
        let mut world = Self {
            zone: at.map_or_else(|| "Etc/UTC".to_owned(), |standing| standing.tz.clone()),
            ..Self::default()
        };
        let vault = door.table("vault", "id, self_id, currency", "id", "id")?;
        let vault = vault.first().ok_or("the vault has not been founded")?;
        world.me = text(vault, "self_id").unwrap_or_default();
        world.currency = text(vault, "currency").unwrap_or_else(|| "USD".to_owned());
        world.calendar = centraid_vault::model::DEFAULT_CALENDAR_ID.to_owned();

        // The occurrences of the days around today are read first: a series made years ago that
        // sounds today is outside the newest events, and its occurrences pin it in.
        let occurrences = at.and_then(|at| event_occurrences(door, at));
        let mut pinned = pinned.clone();
        pinned.extend(
            occurrences
                .iter()
                .flatten()
                .map(|occurrence| occurrence.event_id.clone()),
        );
        let held = entities_by_id(door, &pinned.iter().cloned().collect::<Vec<_>>())?;
        let mut scopes = Scopes::default();
        for vault_kind in WINDOWED {
            scopes
                .0
                .insert(*vault_kind, Scope::read(door, vault_kind, &held)?);
        }
        let every_id: Vec<String> = scopes
            .0
            .values()
            .flat_map(|scope| scope.entities.keys().cloned())
            .collect();
        let flags = Flags::load(door, &every_id)?;
        world.load_people(door, &flags, scopes.of("person"))?;
        world.load_events(door, scopes.of("event"), occurrences.as_deref())?;
        world.load_tasks(door, &flags, scopes.of("task"))?;
        world.load_photos(door, &flags, scopes.of("photo"))?;
        world.load_notes(door, &flags, scopes.of("note"))?;
        world.load_containers(door, &scopes)?;
        world.load_documents(door, &flags, scopes.of("document"))?;
        world.load_locker(door, &flags, scopes.of("locker_item"))?;
        world.load_transactions(door, at)?;
        world.load_money_lists(door, &scopes)?;
        world.load_health(door, at)?;
        world.load_links(door)?;
        for (vault_kind, scope) in &scopes.0 {
            if scope.more {
                world.older.extend(model_kinds(vault_kind));
            }
        }
        // an edge is kept when both of its ends are rows the model talks about
        let rows = &world.rows;
        world
            .edges
            .retain(|edge| rows.contains_key(&edge.from) && rows.contains_key(&edge.to));
        world.edges.sort();
        world.edges.dedup();
        Ok(world)
    }

    fn insert(&mut self, row: Row) {
        self.rows.insert(row.key(), row);
    }

    fn edge(&mut self, from: Key, to: Key, via: Via) {
        self.edges.push(Edge { from, to, via });
    }

    fn load_people(&mut self, door: &dyn Door, flags: &Flags, scope: &Scope) -> Result<(), String> {
        let entities = &scope.entities;
        let people = by_ids(
            door,
            "person",
            "id, form, role, nickname, met, birthday, cadence_days",
            &scope.ids(),
        )?;
        let touched = last_contacts(door, &scope.ids())?;
        for person in &people {
            let id = text(person, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            if text(person, "form").as_deref() != Some("person") {
                continue;
            }
            let mut fields = BTreeMap::new();
            put(&mut fields, "role", nonempty(text(person, "role")));
            put(&mut fields, "nickname", nonempty(text(person, "nickname")));
            put(&mut fields, "met", nonempty(text(person, "met")));
            put(
                &mut fields,
                "cadence",
                int(person, "cadence_days")
                    .filter(|days| *days > 0)
                    .map(Val::Num),
            );
            fields.insert("starred", Val::Bool(flags.starred.contains(&id)));
            let mut row = Row {
                kind: Kind::Person,
                date: touched.get(&id).and_then(|at| Stamp::parse(at)),
                ..Row::of(Kind::Person, &id, entity, fields)
            };
            // the birthday is the card's second fact (`MM-DD` or a full date), never the model's
            if let Some(birthday) = text(person, "birthday").filter(|day| !day.is_empty()) {
                row.extra.insert("birthday", birthday);
            }
            self.insert(row);
        }
        Ok(())
    }

    fn load_events(
        &mut self,
        door: &dyn Door,
        scope: &Scope,
        occurrences: Option<&[crate::native::door::Occurrence]>,
    ) -> Result<(), String> {
        let entities = &scope.entities;
        let events = by_ids(
            door,
            "event",
            "id, starts, ends, timing, zone, rule, status, place_id, description",
            &scope.ids(),
        )?;
        // the place's name is the card's third part (`Café Lume`), never the model's
        let place_ids: Vec<String> = events
            .iter()
            .filter_map(|event| text(event, "place_id"))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let places = entities_by_id(door, &place_ids)?;
        let spec = Kind::Event.spec();
        for event in &events {
            let id = text(event, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            let mut fields = BTreeMap::new();
            let status = text(event, "status").unwrap_or_default();
            if let Some(value) = spec
                .field("status")
                .and_then(|field| field.model_value(&status))
            {
                fields.insert("status", Val::Enum(value));
            }
            put(
                &mut fields,
                "description",
                nonempty(text(event, "description")),
            );
            let mut row = Row::of(Kind::Event, &id, entity, fields);
            // the stored spellings of the span and the trash window: what a write's checks read
            // (the clash of a new event, the restore window)
            for (name, column) in [
                ("dtstart", "starts"),
                ("dtend", "ends"),
                ("rrule", "rule"),
                ("timing", "timing"),
                ("zone", "zone"),
            ] {
                if let Some(value) = text(event, column) {
                    row.extra.insert(name, value);
                }
            }
            if let Some(name) = text(event, "place_id")
                .and_then(|place| places.get(&place))
                .and_then(|place| text(place, "title"))
                .filter(|name| !name.trim().is_empty())
            {
                row.extra.insert("place", name);
            }
            let all_day = row.extra.get("timing").map(String::as_str) == Some("all-day");
            if all_day {
                // an all-day event is a day (or days) and never a clock time; its end is the LAST
                // day, inclusive
                row.date = stamp(text(event, "starts")).map(|start| Stamp {
                    date: start.date,
                    time: None,
                });
            } else {
                shape_event(
                    &mut row,
                    stamp(text(event, "starts")),
                    stamp(text(event, "ends")),
                );
            }
            self.insert(row);
        }
        for (event, guest) in edges_from(door, "attendee", &scope.ids())? {
            self.edge((Kind::Event, event), (Kind::Person, guest), Via::Attendee);
        }
        if let Some(occurrences) = occurrences {
            self.read_event_window(occurrences);
        }
        Ok(())
    }

    /// THE EVENTS OF THE DAYS AROUND TODAY, as Agenda reads them (R-1088-8): in the person's zone,
    /// and a repeating series as its occurrences. A one-off the zone does not move stays as stored
    /// (so a UTC person reads what the stored events say); one it moves is placed where Agenda
    /// places it. A series is replaced by one row per occurrence in the window, whose id is the
    /// occurrence's key (`extra["series"]` names the series): what a write to an occurrence
    /// cannot do yet is declined (`Session::write`). A door that cannot answer leaves every event
    /// as stored.
    fn read_event_window(&mut self, occurrences: &[crate::native::door::Occurrence]) {
        let mut by_event: BTreeMap<String, Vec<&crate::native::door::Occurrence>> = BTreeMap::new();
        for occurrence in occurrences {
            by_event
                .entry(occurrence.event_id.clone())
                .or_default()
                .push(occurrence);
        }
        let mut removed = false;
        // A live repeating event is expanded only inside the window: beyond it the series reads as
        // stored, once, and a read that reaches there is not whole (`Session::store_reach`).
        if self
            .rows
            .values()
            .any(|row| row.kind == Kind::Event && !row.trashed && row.extra.contains_key("rrule"))
        {
            self.older.insert(Kind::Event);
        }
        for (event_id, list) in &by_event {
            let key = (Kind::Event, event_id.clone());
            let Some(base) = self.rows.get(&key).cloned() else {
                continue;
            };
            if list.iter().all(|occurrence| !occurrence.is_instance) {
                let placement = &list[0].placement;
                let start = Stamp::parse(&placement.local_start);
                if start != base.date
                    && let Some(row) = self.rows.get_mut(&key)
                {
                    shape_event(row, start, Stamp::parse(&placement.local_end));
                }
                continue;
            }
            let guests: Vec<Key> = self
                .edges
                .iter()
                .filter(|edge| edge.via == Via::Attendee && edge.from == key)
                .map(|edge| edge.to.clone())
                .collect();
            self.rows.remove(&key);
            removed = true;
            for occurrence in list {
                let mut row = Row {
                    kind: Kind::Event,
                    id: occurrence.instance_key.clone(),
                    name: occurrence
                        .summary
                        .clone()
                        .unwrap_or_else(|| base.name.clone()),
                    date: None,
                    fields: BTreeMap::new(),
                    trashed: false,
                    created: base.created.clone(),
                    updated: base.updated.clone(),
                    extra: BTreeMap::new(),
                };
                if let Some(value) = occurrence.status.as_deref().and_then(|status| {
                    Kind::Event
                        .spec()
                        .field("status")
                        .and_then(|field| field.model_value(status))
                }) {
                    row.fields.insert("status", Val::Enum(value));
                }
                put(
                    &mut row.fields,
                    "description",
                    nonempty(occurrence.description.clone()),
                );
                row.extra.insert("series", event_id.clone());
                if let Some(rule) = base.extra.get("rrule") {
                    row.extra.insert("rrule", rule.clone());
                }
                shape_event(
                    &mut row,
                    Stamp::parse(&occurrence.placement.local_start),
                    Stamp::parse(&occurrence.placement.local_end),
                );
                let id = row.id.clone();
                self.insert(row);
                for guest in &guests {
                    self.edge((Kind::Event, id.clone()), guest.clone(), Via::Attendee);
                }
            }
        }
        // a live series with nothing in the window is on no day the person can ask about
        let idle: Vec<Key> = self
            .rows
            .values()
            .filter(|row| {
                row.kind == Kind::Event
                    && !row.trashed
                    && row.extra.contains_key("rrule")
                    && !row.extra.contains_key("series")
                    && row.field("status") != Some(&Val::Enum("cancelled"))
                    && !by_event.contains_key(&row.id)
            })
            .map(Row::key)
            .collect();
        for key in idle {
            self.rows.remove(&key);
            removed = true;
        }
        if removed {
            let rows = &self.rows;
            self.edges
                .retain(|edge| rows.contains_key(&edge.from) && rows.contains_key(&edge.to));
        }
    }

    fn load_tasks(&mut self, door: &dyn Door, flags: &Flags, scope: &Scope) -> Result<(), String> {
        let entities = &scope.entities;
        let tasks = by_ids(
            door,
            "task",
            "id, status, priority, due, done_at, rule, effort_min, parent_id, project_id, \
             description",
            &scope.ids(),
        )?;
        let spec = Kind::Task.spec();
        for task in &tasks {
            let id = text(task, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            let mut fields = BTreeMap::new();
            let status = text(task, "status").unwrap_or_default();
            if let Some(value) = spec
                .field("status")
                .and_then(|field| field.model_value(&status))
            {
                fields.insert("status", Val::Enum(value));
            }
            put(&mut fields, "effort", int(task, "effort_min").map(Val::Num));
            put(
                &mut fields,
                "priority",
                int(task, "priority")
                    .filter(|value| *value > 0)
                    .map(Val::Num),
            );
            put(
                &mut fields,
                "completed",
                stamp(text(task, "done_at")).map(Val::Date),
            );
            put(
                &mut fields,
                "description",
                nonempty(text(task, "description")),
            );
            fields.insert("starred", Val::Bool(flags.starred.contains(&id)));
            let mut row = Row::of(Kind::Task, &id, entity, fields);
            row.date = stamp(text(task, "due"));
            if let Some(rule) = text(task, "rule") {
                row.extra.insert("rrule", rule);
            }
            self.insert(row);
        }
        for task in &tasks {
            let id = text(task, "id").unwrap_or_default();
            if let Some(parent) = text(task, "parent_id") {
                self.edge((Kind::Task, parent), (Kind::Task, id.clone()), Via::Subtask);
            }
            if let Some(project) = text(task, "project_id") {
                self.edge((Kind::List, project), (Kind::Task, id), Via::ListColumn);
            }
        }
        Ok(())
    }

    fn load_notes(&mut self, door: &dyn Door, flags: &Flags, scope: &Scope) -> Result<(), String> {
        let entities = &scope.entities;
        let notes = by_ids(door, "note", "id, body, notebook_id", &scope.ids())?;
        for note in &notes {
            let id = text(note, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            let mut fields = BTreeMap::new();
            put(&mut fields, "body", nonempty(text(note, "body")));
            fields.insert("pinned", Val::Bool(flags.pinned.contains(&id)));
            fields.insert("starred", Val::Bool(flags.starred.contains(&id)));
            let created = text(entity, "created_at").unwrap_or_default();
            self.insert(Row {
                date: local_created_stamp(&self.zone, &created),
                ..Row::of(Kind::Note, &id, entity, fields)
            });
        }
        for note in &notes {
            if let (Some(id), Some(notebook)) = (text(note, "id"), text(note, "notebook_id")) {
                self.edge((Kind::Notebook, notebook), (Kind::Note, id), Via::Entry);
            }
        }
        Ok(())
    }

    /// THE CONTAINERS, each of the kind its own row states: an album and a notebook are both
    /// `container` rows, and the row says which. A trashed container is gone to the model (its
    /// members went to the trash with it and read as trashed).
    fn load_containers(&mut self, door: &dyn Door, scopes: &Scopes) -> Result<(), String> {
        let areas = &scopes.of("area").entities;
        self.areas = areas
            .iter()
            .filter(|(_, area)| text(area, "deleted_at").is_none())
            .filter_map(|(id, area)| Some((id.clone(), text(area, "title")?)))
            .collect();
        for (vault_kind, kind) in [
            ("notebook", Kind::Notebook),
            ("album", Kind::Album),
            ("folder", Kind::Folder),
            ("project", Kind::List),
        ] {
            let entities = &scopes.of(vault_kind).entities;
            let containers = by_ids(
                door,
                "container",
                "id, parent_id",
                &scopes.of(vault_kind).ids(),
            )?;
            for container in &containers {
                let id = text(container, "id").unwrap_or_default();
                let Some(entity) = entities.get(&id) else {
                    continue;
                };
                if text(entity, "deleted_at").is_some() {
                    continue;
                }
                let parent = text(container, "parent_id");
                let mut fields = BTreeMap::new();
                if kind == Kind::List {
                    put(
                        &mut fields,
                        "area",
                        parent
                            .as_ref()
                            .and_then(|area| areas.get(area))
                            .and_then(|area| nonempty(text(area, "title"))),
                    );
                }
                let mut row = Row::of(kind, &id, entity, fields);
                row.extra.remove("purge_at");
                if let Some(parent) = parent {
                    // a list's parent is the area it sits in; a notebook's or folder's, the one it
                    // is nested under
                    row.extra.insert(
                        if kind == Kind::List {
                            "area_id"
                        } else {
                            "parent"
                        },
                        parent,
                    );
                }
                self.insert(row);
            }
        }
        // an album's photos, by the photos in the world: an album of ninety thousand is not walked
        for (album, photo) in edges_to(door, "contains", &scopes.of("photo").ids())? {
            self.edge((Kind::Album, album), (Kind::Photo, photo), Via::Entry);
        }
        Ok(())
    }

    fn load_documents(
        &mut self,
        door: &dyn Door,
        flags: &Flags,
        scope: &Scope,
    ) -> Result<(), String> {
        let entities = &scope.entities;
        let documents = by_ids(door, "document", "id, folder_id", &scope.ids())?;
        for document in &documents {
            let id = text(document, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            let mut fields = BTreeMap::new();
            fields.insert("starred", Val::Bool(flags.starred.contains(&id)));
            let created = text(entity, "created_at").unwrap_or_default();
            self.insert(Row {
                date: local_created_stamp(&self.zone, &created),
                ..Row::of(Kind::Document, &id, entity, fields)
            });
            if let Some(folder) = text(document, "folder_id") {
                self.edge(
                    (Kind::Folder, folder),
                    (Kind::Document, id),
                    Via::FolderColumn,
                );
            }
        }
        Ok(())
    }

    fn load_photos(&mut self, door: &dyn Door, flags: &Flags, scope: &Scope) -> Result<(), String> {
        let entities = &scope.entities;
        let photos = by_ids(door, "photo", "id, form, taken_at", &scope.ids())?;
        for photo in &photos {
            let id = text(photo, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            // a video and a scan are not pictures the model talks about
            if text(photo, "form").as_deref() != Some("photo") {
                continue;
            }
            let mut fields = BTreeMap::new();
            fields.insert("starred", Val::Bool(flags.starred.contains(&id)));
            let mut row = Row::of(Kind::Photo, &id, entity, fields);
            row.date = stamp(text(photo, "taken_at"));
            if row.name.is_empty() {
                row.name = "untitled".to_owned();
            }
            self.insert(row);
        }
        Ok(())
    }

    /// The transactions posted in the last [`TRANSACTION_MONTHS`] months, with the account's name
    /// and the category's title (#1099, R-1099-8). `amount` is signed: money out of the account
    /// is negative, as the vault stores it. Nothing is written or derived beyond that; the rows
    /// are read as stored. A transaction's name is its own title (Money's display name).
    fn load_transactions(&mut self, door: &dyn Door, at: Option<&Standing>) -> Result<(), String> {
        let today = match at {
            Some(standing) => standing.today,
            None => jiff::Timestamp::from_millisecond(door.now_ms())
                .unwrap_or_default()
                .to_zoned(jiff::tz::TimeZone::UTC)
                .date(),
        };
        let first = today
            .first_of_month()
            .checked_sub(jiff::Span::new().months(i64::from(TRANSACTION_MONTHS) - 1))
            .map_err(|error| format!("the transaction window is out of range: {error}"))?;
        let floor = first.to_string();
        let rows = door.table_where(
            "txn",
            "id, account_id, currency, posted_on, amount_minor, status, category_id",
            "posted_on",
            "id",
            "posted_on >= ?",
            &[floor],
        )?;
        if rows.is_empty() {
            return Ok(());
        }
        let titles = |kind: &str| -> Result<BTreeMap<String, String>, String> {
            Ok(Scope::read(door, kind, &BTreeMap::new())?
                .entities
                .into_iter()
                .filter_map(|(id, row)| Some((id, text(&row, "title")?)))
                .collect())
        };
        let account_names = titles("account")?;
        let category_names = titles("category")?;
        let ids: Vec<String> = rows.iter().filter_map(|row| text(row, "id")).collect();
        let mut named: BTreeMap<String, VaultRow> = BTreeMap::new();
        for chunk in ids.chunks(DECORATION_CHUNK) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let found = door.table_where(
                "entity",
                "id, title, created_at, updated_at, deleted_at, purge_at",
                "id",
                "id",
                &format!("id IN ({marks})"),
                chunk,
            )?;
            for entity in found {
                if let Some(id) = text(&entity, "id") {
                    named.insert(id, entity);
                }
            }
        }
        // The other half of each transfer: one `transfer` row names the pair, the lower id first.
        let mut partners: BTreeMap<String, String> = BTreeMap::new();
        for chunk in ids.chunks(DECORATION_CHUNK) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let both: Vec<String> = chunk.iter().chain(chunk).cloned().collect();
            for pair in door.table_where(
                "transfer",
                "a, b",
                "a",
                "a",
                &format!("a IN ({marks}) OR b IN ({marks})"),
                &both,
            )? {
                if let (Some(a), Some(b)) = (text(&pair, "a"), text(&pair, "b")) {
                    partners.insert(a.clone(), b.clone());
                    partners.insert(b, a);
                }
            }
        }
        for transaction in &rows {
            let id = text(transaction, "id").unwrap_or_default();
            let Some(entity) = named.get(&id).filter(|e| text(e, "deleted_at").is_none()) else {
                continue;
            };
            let currency = text(transaction, "currency").unwrap_or_else(|| self.currency.clone());
            let mut fields = BTreeMap::new();
            fields.insert(
                "amount",
                Val::Money(
                    int(transaction, "amount_minor").unwrap_or_default(),
                    currency,
                ),
            );
            let account = text(transaction, "account_id").unwrap_or_default();
            put(
                &mut fields,
                "account",
                nonempty(account_names.get(&account).cloned()),
            );
            put(
                &mut fields,
                "category",
                text(transaction, "category_id")
                    .and_then(|category| category_names.get(&category).cloned())
                    .map(Val::Text),
            );
            // the other half of a transfer: an unlink is taken back by linking it again
            put(
                &mut fields,
                "transfer",
                nonempty(partners.get(&id).cloned()),
            );
            let status = match text(transaction, "status").as_deref() {
                Some("void") => "void",
                _ => "posted",
            };
            fields.insert("status", Val::Enum(status));
            let mut row = Row::of(Kind::Transaction, &id, entity, fields);
            // a printed civil day (R-1099-2): shown as the day
            row.date = stamp(text(transaction, "posted_on")).map(|posted| Stamp {
                date: posted.date,
                time: None,
            });
            row.extra.remove("purge_at");
            self.insert(row);
        }
        Ok(())
    }

    /// Money's lists (#1135): the accounts, the categories, the monthly targets and the rules,
    /// read as stored. A rule has no entity row: its name is the text it matches, and a budget
    /// row is the category's target for one month, so its id is `<category>:<month>`.
    fn load_money_lists(&mut self, door: &dyn Door, scopes: &Scopes) -> Result<(), String> {
        let account_entities = &scopes.of("account").entities;
        for account in by_ids(
            door,
            "account",
            "id, type, currency, opening_minor, on_budget",
            &scopes.of("account").ids(),
        )? {
            let id = text(&account, "id").unwrap_or_default();
            let Some(entity) = account_entities.get(&id) else {
                continue;
            };
            let currency = text(&account, "currency").unwrap_or_else(|| self.currency.clone());
            let mut fields = BTreeMap::new();
            if let Some(value) = Kind::Account
                .spec()
                .field("type")
                .and_then(|field| field.model_value(&text(&account, "type").unwrap_or_default()))
            {
                fields.insert("type", Val::Enum(value));
            }
            fields.insert("currency", Val::Text(currency.clone()));
            fields.insert(
                "opening",
                Val::Money(int(&account, "opening_minor").unwrap_or_default(), currency),
            );
            fields.insert(
                "on_budget",
                Val::Bool(int(&account, "on_budget") != Some(0)),
            );
            self.insert(Row::of(Kind::Account, &id, entity, fields));
        }
        let category_entities = &scopes.of("category").entities;
        let titles: BTreeMap<String, String> = category_entities
            .iter()
            .filter_map(|(id, row)| Some((id.clone(), text(row, "title")?)))
            .collect();
        for concept in by_ids(
            door,
            "concept",
            "id, key, parent_id",
            &scopes.of("category").ids(),
        )? {
            let id = text(&concept, "id").unwrap_or_default();
            let Some(entity) = category_entities.get(&id) else {
                continue;
            };
            // THE STOCK VOCABULARY IS NOT THE MEMBER'S ROWS: forty-odd names the baseline seeds
            // would answer every selector that shares a word with them ("rent" finds a category).
            // A transaction names its category as a field; a category the member made is a row.
            if text(entity, "created_at").as_deref() == Some(STOCK_CATEGORIES_AT) {
                continue;
            }
            let mut fields = BTreeMap::new();
            put(&mut fields, "key", nonempty(text(&concept, "key")));
            put(
                &mut fields,
                "group",
                text(&concept, "parent_id")
                    .and_then(|parent| titles.get(&parent).cloned())
                    .map(Val::Text),
            );
            self.insert(Row::of(Kind::Category, &id, entity, fields));
        }
        // THE NEWEST MONTHS' TARGETS: a window of rows, not the years of them
        let budgets = door.window(&WindowQuery {
            table: "budget",
            columns: "category_id, month, amount_minor, currency, carry",
            sort: "month",
            pk: "category_id",
            predicate: "",
            binds: &[],
            limit: WINDOW_ROWS * 4,
            newest_first: true,
        })?;
        if budgets.more {
            self.older.insert(Kind::Budget);
        }
        for budget in budgets.rows {
            let category = text(&budget, "category_id").unwrap_or_default();
            let month = text(&budget, "month").unwrap_or_default();
            let currency = text(&budget, "currency").unwrap_or_else(|| self.currency.clone());
            let mut fields = BTreeMap::new();
            fields.insert(
                "amount",
                Val::Money(
                    int(&budget, "amount_minor").unwrap_or_default(),
                    currency.clone(),
                ),
            );
            fields.insert("currency", Val::Text(currency));
            fields.insert("carry", Val::Bool(int(&budget, "carry") == Some(1)));
            let id = format!("{category}:{month}");
            self.insert(Row {
                kind: Kind::Budget,
                name: format!(
                    "{} {month}",
                    titles.get(&category).cloned().unwrap_or_default()
                ),
                id,
                date: None,
                fields,
                trashed: false,
                created: String::new(),
                updated: String::new(),
                extra: BTreeMap::new(),
            });
        }
        let rules = door.window(&WindowQuery {
            table: "rule",
            columns: "id, pattern, category_id, position, created_at",
            sort: "created_at",
            pk: "id",
            predicate: "",
            binds: &[],
            limit: WINDOW_ROWS,
            newest_first: true,
        })?;
        if rules.more {
            self.older.insert(Kind::Rule);
        }
        for rule in rules.rows {
            let id = text(&rule, "id").unwrap_or_default();
            let pattern: serde_json::Value =
                serde_json::from_str(&text(&rule, "pattern").unwrap_or_default())
                    .unwrap_or(serde_json::Value::Null);
            let matched = pattern["text"].as_str().unwrap_or_default().to_owned();
            let mut fields = BTreeMap::new();
            put(
                &mut fields,
                "category",
                text(&rule, "category_id")
                    .and_then(|category| titles.get(&category).cloned())
                    .map(Val::Text),
            );
            fields.insert(
                "position",
                Val::Num(int(&rule, "position").unwrap_or_default()),
            );
            self.insert(Row {
                kind: Kind::Rule,
                name: matched,
                id,
                date: stamp(text(&rule, "created_at")),
                fields,
                trashed: false,
                created: text(&rule, "created_at").unwrap_or_default(),
                updated: String::new(),
                extra: BTreeMap::new(),
            });
        }
        Ok(())
    }

    /// Health's daily figures and workouts of the last [`HEALTH_DAYS`] days (#1135). A figure has no
    /// entity of its own: it is the vault's `measurement` row of the member, named by its metric
    /// and identified by `<day>:<metric>`. A workout is an activity of a workout kind beside its
    /// `workout` row, named by the entity's title and dated by its start.
    fn load_health(&mut self, door: &dyn Door, at: Option<&Standing>) -> Result<(), String> {
        let floor = today_of(door, at)
            .checked_sub(jiff::Span::new().days(HEALTH_DAYS))
            .map_err(|error| format!("the health window is out of range: {error}"))?
            .to_string();
        let figures = door.table_where(
            "measurement",
            "day, metric, value",
            "day",
            "metric",
            "person_id = ? AND day >= ?",
            &[self.me.clone(), floor.clone()],
        )?;
        // WHAT THE STORE STATES: the health origin the vault follows, and the workouts it follows
        // (a `source` row of the health system names the entity). A member's edit of either would
        // be stated over at the next read, so the runtime refuses it with the store's name, before
        // anything parks (the vault's own precondition is the authority).
        let origins = door.table_where(
            "origin",
            "id, label, created_at",
            "created_at",
            "id",
            "system = ? AND retired_at IS NULL",
            &["health".to_owned()],
        )?;
        self.health_store = origins.iter().find_map(|origin| text(origin, "label"));
        let labels: BTreeMap<String, String> = origins
            .iter()
            .filter_map(|origin| Some((text(origin, "id")?, text(origin, "label")?)))
            .collect();
        let spec = Kind::DailyFigure.spec();
        for figure in &figures {
            let (Some(day), Some(metric)) = (text(figure, "day"), text(figure, "metric")) else {
                continue;
            };
            let mut fields = BTreeMap::new();
            if let Some(value) = spec
                .field("metric")
                .and_then(|field| field.model_value(&metric))
            {
                fields.insert("metric", Val::Enum(value));
            }
            fields.insert("value", Val::Num(rounded(figure, "value")));
            self.insert(Row {
                kind: Kind::DailyFigure,
                id: format!("{day}:{metric}"),
                name: metric,
                date: stamp(Some(day)),
                fields,
                trashed: false,
                created: String::new(),
                updated: String::new(),
                extra: BTreeMap::new(),
            });
        }

        let started = door.table_where(
            "activity",
            "id, starts",
            "starts",
            "id",
            "type_kind = ? AND starts >= ?",
            &["workout_kind".to_owned(), floor],
        )?;
        let ids: Vec<String> = started.iter().filter_map(|row| text(row, "id")).collect();
        for chunk in ids.chunks(DECORATION_CHUNK) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let measured = door.table_where(
                "workout",
                "id, moving_s, distance_m, energy_kcal, heart_bpm, climb_m",
                "id",
                "id",
                &format!("id IN ({marks})"),
                chunk,
            )?;
            let named = door.table_where(
                "entity",
                "id, title, created_at, updated_at, deleted_at, purge_at",
                "id",
                "id",
                &format!("id IN ({marks})"),
                chunk,
            )?;
            let named: BTreeMap<String, VaultRow> = named
                .into_iter()
                .filter_map(|entity| Some((text(&entity, "id")?, entity)))
                .collect();
            let mut followed: BTreeMap<String, String> = BTreeMap::new();
            if !labels.is_empty() {
                let mut binds = vec!["health".to_owned()];
                binds.extend(chunk.iter().cloned());
                for source in door.table_where(
                    "source",
                    "id, entity_id, origin_id",
                    "id",
                    "id",
                    &format!("system = ? AND entity_id IN ({marks})"),
                    &binds,
                )? {
                    if let (Some(entity), Some(label)) = (
                        text(&source, "entity_id"),
                        text(&source, "origin_id").and_then(|origin| labels.get(&origin).cloned()),
                    ) {
                        followed.insert(entity, label);
                    }
                }
            }
            for workout in &measured {
                let id = text(workout, "id").unwrap_or_default();
                // a trashed workout stays in the world, trashed: `restore` finds it there
                let Some(entity) = named.get(&id) else {
                    continue;
                };
                let mut fields = BTreeMap::new();
                for (field, column) in [
                    ("moving", "moving_s"),
                    ("distance", "distance_m"),
                    ("energy", "energy_kcal"),
                    ("heart_rate", "heart_bpm"),
                    ("climb", "climb_m"),
                ] {
                    if !matches!(workout.get(column), None | Some(Cell::Null)) {
                        fields.insert(field, Val::Num(rounded(workout, column)));
                    }
                }
                let mut row = Row::of(Kind::Workout, &id, entity, fields);
                if let Some(label) = followed.get(&id) {
                    row.extra.insert("followed_by", label.clone());
                }
                let zone = self.zone.clone();
                row.date = started
                    .iter()
                    .find(|activity| text(activity, "id").as_deref() == Some(id.as_str()))
                    .and_then(|activity| text(activity, "starts"))
                    .and_then(|starts| local_stamp(&zone, &starts));
                self.insert(row);
            }
        }
        Ok(())
    }

    /// The Locker items, read as the owner reads them but for their sealed values: the item's
    /// entity row (its title, stamps and trash) beside its kind row, and its star from the flags
    /// every kind shares. A sealed cell is `PRESENT` where the item holds one, read as
    /// `<cell> IS NOT NULL` and never as a value: a sealed plaintext is a channel the runtime keeps
    /// closed (#1135), on the phone and in the harness alike.
    fn load_locker(&mut self, door: &dyn Door, flags: &Flags, scope: &Scope) -> Result<(), String> {
        let entities = &scope.entities;
        let plain = "id, type, username, url, notes, key_id, cardholder, expiry, brand, fullname, \
                     email, phone, address, network";
        let sealed = "password IS NOT NULL AS has_password, otp_seed IS NOT NULL AS has_otp_seed, \
                      card_number IS NOT NULL AS has_card_number, cvv IS NOT NULL AS has_cvv, \
                      content IS NOT NULL AS has_content";
        let items = by_ids(
            door,
            "locker_item",
            &format!("{plain}, {sealed}"),
            &scope.ids(),
        )?;
        let spec = Kind::LockerItem.spec();
        // A sealed cell as the world holds it: the vault's placeholder ("a secret is here, leave it
        // alone") on the presence bit.
        let held = |item: &VaultRow, column: &str| -> Option<String> {
            (int(item, &format!("has_{column}")) == Some(1))
                .then(|| centraid_vault::commands::locker::SEALED_PLACEHOLDER.to_owned())
        };
        for item in &items {
            let id = text(item, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            let mut fields = BTreeMap::new();
            let kind = text(item, "type").unwrap_or_default();
            if let Some(value) = spec
                .field("type")
                .and_then(|field| field.model_value(&kind))
            {
                fields.insert("type", Val::Enum(value));
            }
            put(&mut fields, "username", nonempty(text(item, "username")));
            put(&mut fields, "url", nonempty(text(item, "url")));
            put(&mut fields, "notes", nonempty(text(item, "notes")));
            // A NOTE ITEM'S NOTES ARE ITS SEALED `content`: the row says it
            // has them, and `reveal field: notes` opens them.
            if kind == "note" && nonempty(held(item, "content")).is_some() {
                fields.insert("notes", Val::Text(SEALED.to_owned()));
            }
            fields.insert("starred", Val::Bool(flags.starred.contains(&id)));
            let mut extra = BTreeMap::new();
            if let Some(key) = text(item, "key_id") {
                extra.insert("key_id", key);
            }
            if let Some(purge) = text(entity, "purge_at") {
                extra.insert("purge_at", purge);
            }
            for (_, column) in crate::native::meta::REVEAL_FIELDS {
                if let Some(sealed) = held(item, column) {
                    extra.insert(column, sealed);
                }
            }
            // The type's other plain columns, which an edit must send back
            // unchanged (the vault rewrites every column of the type).
            for column in LOCKER_PLAIN {
                if let Some(value) = text(item, column).filter(|value| !value.is_empty()) {
                    extra.insert(column, value);
                }
            }
            self.insert(Row {
                kind: Kind::LockerItem,
                name: text(entity, "title").unwrap_or_default(),
                id,
                date: None,
                fields,
                trashed: text(entity, "deleted_at").is_some(),
                created: text(entity, "created_at").unwrap_or_default(),
                updated: text(entity, "updated_at").unwrap_or_default(),
                extra,
            });
        }
        Ok(())
    }

    /// What a note, a task or an event is `about`: an edge from it to the person (or the row)
    /// it names. A relation the model has no word for is not here.
    fn load_links(&mut self, door: &dyn Door) -> Result<(), String> {
        let kinds: BTreeMap<String, Kind> = self
            .rows
            .keys()
            .map(|(kind, id)| (id.clone(), *kind))
            .collect();
        // only a note, a task or an event is the start of a link the model reads
        let from_ids: Vec<String> = self
            .rows
            .keys()
            .filter(|(kind, _)| {
                matches!(
                    kind,
                    Kind::Note | Kind::Task | Kind::Event | Kind::Photo | Kind::Person
                )
            })
            .map(|(_, id)| id.clone())
            .collect();
        for (rel, via) in [
            ("about", Via::About),
            ("with", Via::With),
            ("depicts", Via::Depicts),
        ] {
            for (from, to) in edges_from(door, rel, &from_ids)? {
                let (Some(from_kind), Some(to_kind)) = (kinds.get(&from), kinds.get(&to)) else {
                    continue;
                };
                self.edge((*from_kind, from), (*to_kind, to), via);
            }
        }
        Ok(())
    }
}

/// The flags the world reads: who is starred and who is pinned, each a `tagged` edge to the
/// flag's own entity.
struct Flags {
    starred: BTreeSet<String>,
    pinned: BTreeSet<String>,
}

impl Flags {
    /// Who among `ids` is starred and who is pinned: the `tagged` edges to the two flags, read for
    /// a chunk of ids at a time.
    fn load(door: &dyn Door, ids: &[String]) -> Result<Self, String> {
        let starred_flag = centraid_vault::model::Flag::Starred.id();
        let pinned_flag = centraid_vault::model::Flag::Pinned.id();
        let mut flags = Self {
            starred: BTreeSet::new(),
            pinned: BTreeSet::new(),
        };
        for chunk in ids.chunks(IN_CHUNK) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let mut binds = vec![
                "tagged".to_owned(),
                starred_flag.clone(),
                pinned_flag.clone(),
            ];
            binds.extend(chunk.iter().cloned());
            for edge in door.table_where(
                "edge",
                "from_id, to_id",
                "from_id",
                "to_id",
                &format!("rel = ? AND to_id IN (?, ?) AND from_id IN ({marks})"),
                &binds,
            )? {
                let (Some(from), Some(to)) = (text(&edge, "from_id"), text(&edge, "to_id")) else {
                    continue;
                };
                if to == starred_flag {
                    flags.starred.insert(from);
                } else if to == pinned_flag {
                    flags.pinned.insert(from);
                }
            }
        }
        Ok(flags)
    }
}

/// The vault kinds the world holds a window of, and the model kinds each one is.
const WINDOWED: &[&str] = &[
    "person",
    "event",
    "task",
    "note",
    "document",
    "photo",
    "locker_item",
    "notebook",
    "album",
    "folder",
    "project",
    "area",
    "account",
    "category",
];

/// The vault kind whose entities a model kind's rows are, for the kinds the store can count.
#[must_use]
pub fn vault_kind_of(kind: Kind) -> Option<&'static str> {
    Some(match kind {
        Kind::Person => "person",
        Kind::Task => "task",
        Kind::Note => "note",
        Kind::Document => "document",
        Kind::Photo => "photo",
        Kind::LockerItem => "locker_item",
        Kind::Notebook => "notebook",
        Kind::Album => "album",
        Kind::Folder => "folder",
        Kind::List => "project",
        _ => return None,
    })
}

/// The model kinds a vault kind's rows become.
fn model_kinds(vault_kind: &str) -> Vec<Kind> {
    match vault_kind {
        "person" => vec![Kind::Person],
        "event" => vec![Kind::Event],
        "task" => vec![Kind::Task],
        "note" => vec![Kind::Note],
        "document" => vec![Kind::Document],
        "photo" => vec![Kind::Photo],
        "locker_item" => vec![Kind::LockerItem],
        "notebook" => vec![Kind::Notebook],
        "album" => vec![Kind::Album],
        "folder" => vec![Kind::Folder],
        "project" => vec![Kind::List],
        "account" => vec![Kind::Account],
        "category" => vec![Kind::Category],
        _ => Vec::new(),
    }
}

/// The entities of one vault kind the world holds: its newest [`WINDOW_ROWS`] (by creation, live or
/// in the trash) and every row pinned into the session, and whether older ones were left unread.
#[derive(Debug, Default)]
struct Scope {
    entities: BTreeMap<String, VaultRow>,
    more: bool,
}

impl Scope {
    /// One bounded read of the kind's newest entities (`entity_by_created` answers it), with the
    /// pinned entities of the kind from `held`.
    fn read(
        door: &dyn Door,
        kind: &str,
        held: &BTreeMap<String, VaultRow>,
    ) -> Result<Self, String> {
        let window = door.window(&WindowQuery {
            table: "entity",
            columns: ENTITY_COLUMNS,
            sort: "created_at",
            pk: "id",
            predicate: "kind = ?",
            binds: &[kind.to_owned()],
            limit: WINDOW_ROWS,
            newest_first: true,
        })?;
        let mut entities: BTreeMap<String, VaultRow> = window
            .rows
            .into_iter()
            .filter_map(|row| Some((text(&row, "id")?, row)))
            .collect();
        for (id, row) in held {
            if text(row, "kind").as_deref() == Some(kind) {
                entities.entry(id.clone()).or_insert_with(|| row.clone());
            }
        }
        Ok(Self {
            entities,
            more: window.more,
        })
    }

    fn ids(&self) -> Vec<String> {
        self.entities.keys().cloned().collect()
    }
}

/// Every kind's [`Scope`], by vault kind.
#[derive(Debug, Default)]
struct Scopes(BTreeMap<&'static str, Scope>);

impl Scopes {
    fn of(&self, kind: &str) -> &Scope {
        static NONE: Scope = Scope {
            entities: BTreeMap::new(),
            more: false,
        };
        self.0.get(kind).unwrap_or(&NONE)
    }
}

/// The entities of `ids`, live or in the trash, a chunk of ids at a time.
fn entities_by_id(door: &dyn Door, ids: &[String]) -> Result<BTreeMap<String, VaultRow>, String> {
    Ok(by_ids(door, "entity", ENTITY_COLUMNS, ids)?
        .into_iter()
        .filter_map(|row| Some((text(&row, "id")?, row)))
        .collect())
}

/// The rows of `table` whose `id` is among `ids`, a chunk of [`IN_CHUNK`] at a time: each read
/// returns at most a chunk's rows, so none can reach the door's ceiling.
fn by_ids(
    door: &dyn Door,
    table: &str,
    columns: &str,
    ids: &[String],
) -> Result<Vec<VaultRow>, String> {
    let mut out = Vec::new();
    for chunk in ids.chunks(IN_CHUNK) {
        let marks = vec!["?"; chunk.len()].join(", ");
        out.extend(door.table_where(
            table,
            columns,
            "id",
            "id",
            &format!("id IN ({marks})"),
            chunk,
        )?);
    }
    Ok(out)
}

/// The edges one chunk of ids may carry, newest first: a person with thousands of interactions
/// gives their newest, which is what "last contact" reads.
const EDGES_PER_CHUNK: usize = IN_CHUNK * 8;

/// The `(from, to)` ends of the edges of one relation that start at one of `ids`.
fn edges_from(door: &dyn Door, rel: &str, ids: &[String]) -> Result<Vec<(String, String)>, String> {
    edges_by(door, rel, "from_id", ids)
}

/// The `(from, to)` ends of the edges of one relation that end at one of `ids`.
fn edges_to(door: &dyn Door, rel: &str, ids: &[String]) -> Result<Vec<(String, String)>, String> {
    edges_by(door, rel, "to_id", ids)
}

fn edges_by(
    door: &dyn Door,
    rel: &str,
    column: &str,
    ids: &[String],
) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for chunk in ids.chunks(IN_CHUNK) {
        let marks = vec!["?"; chunk.len()].join(", ");
        let mut binds = vec![rel.to_owned()];
        binds.extend(chunk.iter().cloned());
        let found = door.window(&WindowQuery {
            table: "edge",
            columns: "from_id, to_id",
            sort: "from_id",
            pk: "to_id",
            predicate: &format!("rel = ? AND {column} IN ({marks})"),
            binds: &binds,
            limit: EDGES_PER_CHUNK,
            newest_first: true,
        })?;
        out.extend(
            found
                .rows
                .iter()
                .filter_map(|row| Some((text(row, "from_id")?, text(row, "to_id")?))),
        );
    }
    Ok(out)
}

/// When each of `people` was last touched: the latest `starts` of an activity of an activity kind
/// (a call, a visit; a workout is not a touch) that is `with` them. Computed at read, as
/// People computes it (`last_contacted` is stored nowhere).
fn last_contacts(door: &dyn Door, people: &[String]) -> Result<BTreeMap<String, String>, String> {
    let with = edges_to(door, "with", people)?;
    if with.is_empty() {
        return Ok(BTreeMap::new());
    }
    let activities: Vec<String> = with
        .iter()
        .map(|(activity, _)| activity.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let starts: BTreeMap<String, String> =
        by_ids(door, "activity", "id, starts, type_kind", &activities)?
            .iter()
            .filter(|row| text(row, "type_kind").as_deref() == Some("activity_kind"))
            .filter_map(|row| Some((text(row, "id")?, text(row, "starts")?)))
            .collect();
    let live: BTreeSet<String> = entities_by_id(door, &activities)?
        .into_iter()
        .filter(|(_, row)| text(row, "deleted_at").is_none())
        .map(|(id, _)| id)
        .collect();
    let mut last: BTreeMap<String, String> = BTreeMap::new();
    for (activity, person) in with {
        let Some(at) = starts.get(&activity).filter(|_| live.contains(&activity)) else {
            continue;
        };
        let held = last.entry(person).or_default();
        if at > held {
            held.clone_from(at);
        }
    }
    Ok(last)
}

/// The occurrences of the days around today as Agenda reads them (R-1088-8), or `None` when the
/// door cannot answer (every event then reads as stored).
fn event_occurrences(
    door: &dyn Door,
    at: &Standing,
) -> Option<Vec<crate::native::door::Occurrence>> {
    let span = |days: i64| jiff::Span::new().days(days);
    let from = at.today.checked_sub(span(EVENT_DAYS_BACK)).ok()?;
    let to = at.today.checked_add(span(EVENT_DAYS_AHEAD)).ok()?;
    door.events(&from.to_string(), &to.to_string(), &at.tz).ok()
}

/// A field's type, for the where-language and `compute`.
#[must_use]
pub fn field_type(kind: Kind, name: &str) -> Option<FieldType> {
    kind.spec().field(name).map(|field| field.ty)
}
