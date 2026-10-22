//! THE WORLD AS THE MODEL SEES IT — every model-facing row, read out of the
//! vault through the kit's paged reads and mapped by the metadata table.
//!
//! It is re-read after every write, so a row's fields are always the vault's.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::row::Row as VaultRow;

use crate::native::dates::Stamp;
use crate::native::door::{Door, int, text};
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
/// Transactions read per chunk when the display names are fetched by id.
const DECORATION_CHUNK: usize = 200;

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

    /// Load everything, the Locker and the recent transactions included.
    pub fn load(door: &dyn Door) -> Result<Self, String> {
        Self::load_with(door, true)
    }

    /// Load everything. With `locker` false (`Flags::locker`) no Locker table and no sealed
    /// column is read, and the world holds no Locker item. Events are read as stored. The recent
    /// transactions are read (`Flags::money`, on).
    pub fn load_with(door: &dyn Door, locker: bool) -> Result<Self, String> {
        Self::load_in(door, locker, true, None)
    }

    /// Load everything, the events of the days around `at.today` read in the zone `at.tz` with
    /// every repeating series expanded (R-1088-8, [`Door::events`]). With `money` false
    /// (`Flags::money`) no Money table is read and the world holds no transaction; with it on,
    /// the transactions of the last [`TRANSACTION_MONTHS`] months are.
    ///
    /// **The vault's tables, read as an app reads them** (#1135): an entity row (its title, its
    /// trash) beside its kind row, and the relations as edges or as the column that holds them.
    /// Nothing is read from the journal, and a container's kind is the container's own.
    pub fn load_in(
        door: &dyn Door,
        locker: bool,
        money: bool,
        at: Option<&Standing>,
    ) -> Result<Self, String> {
        let mut world = Self::default();
        let vault = door.table("vault", "id, self_id, currency", "id", "id")?;
        let vault = vault.first().ok_or("the vault has not been founded")?;
        world.me = text(vault, "self_id").unwrap_or_default();
        world.currency = text(vault, "currency").unwrap_or_else(|| "USD".to_owned());
        world.calendar = centraid_vault::model::DEFAULT_CALENDAR_ID.to_owned();

        let flags = Flags::load(door)?;
        world.load_people(door, &flags)?;
        world.load_events(door, at)?;
        world.load_tasks(door)?;
        world.load_photos(door, &flags)?;
        world.load_notes(door, &flags)?;
        world.load_containers(door)?;
        world.load_documents(door, &flags)?;
        if locker {
            world.load_locker(door, &flags)?;
        }
        if money {
            world.load_transactions(door, at)?;
        }
        world.load_links(door)?;
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

    fn load_people(&mut self, door: &dyn Door, flags: &Flags) -> Result<(), String> {
        let entities = entities(door, "person")?;
        let people = door.table(
            "person",
            "id, form, role, nickname, met, cadence_days",
            "id",
            "id",
        )?;
        let touched = last_contacts(door)?;
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
            self.insert(Row {
                kind: Kind::Person,
                date: touched.get(&id).and_then(|at| Stamp::parse(at)),
                ..Row::of(Kind::Person, &id, entity, fields)
            });
        }
        Ok(())
    }

    fn load_events(&mut self, door: &dyn Door, at: Option<&Standing>) -> Result<(), String> {
        let entities = entities(door, "event")?;
        let events = door.table(
            "event",
            "id, starts, ends, timing, zone, rule, status, description",
            "id",
            "id",
        )?;
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
        for (event, guest) in pairs(door, "attendee")? {
            self.edge((Kind::Event, event), (Kind::Person, guest), Via::Attendee);
        }
        if let Some(at) = at {
            self.read_event_window(door, at);
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
    fn read_event_window(&mut self, door: &dyn Door, at: &Standing) {
        let span = |days: i64| jiff::Span::new().days(days);
        let (Ok(from), Ok(to)) = (
            at.today.checked_sub(span(EVENT_DAYS_BACK)),
            at.today.checked_add(span(EVENT_DAYS_AHEAD)),
        ) else {
            return;
        };
        let Ok(occurrences) = door.events(&from.to_string(), &to.to_string(), &at.tz) else {
            return;
        };
        let mut by_event: BTreeMap<String, Vec<&crate::native::door::Occurrence>> = BTreeMap::new();
        for occurrence in &occurrences {
            by_event
                .entry(occurrence.event_id.clone())
                .or_default()
                .push(occurrence);
        }
        let mut removed = false;
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

    fn load_tasks(&mut self, door: &dyn Door) -> Result<(), String> {
        let entities = entities(door, "task")?;
        let tasks = door.table(
            "task",
            "id, status, priority, due, done_at, rule, effort_min, parent_id, project_id, \
             description",
            "id",
            "id",
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

    fn load_notes(&mut self, door: &dyn Door, flags: &Flags) -> Result<(), String> {
        let entities = entities(door, "note")?;
        let notes = door.table("note", "id, body, notebook_id", "id", "id")?;
        for note in &notes {
            let id = text(note, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            let mut fields = BTreeMap::new();
            put(&mut fields, "body", nonempty(text(note, "body")));
            fields.insert("pinned", Val::Bool(flags.pinned.contains(&id)));
            let created = text(entity, "created_at").unwrap_or_default();
            self.insert(Row {
                date: Stamp::parse(&created),
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
    fn load_containers(&mut self, door: &dyn Door) -> Result<(), String> {
        let areas = entities(door, "area")?;
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
            let entities = entities(door, vault_kind)?;
            let containers = door.table_where(
                "container",
                "id, parent_id",
                "id",
                "id",
                "kind = ?",
                &[vault_kind.to_owned()],
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
        for (album, photo) in pairs(door, "contains")? {
            self.edge((Kind::Album, album), (Kind::Photo, photo), Via::Entry);
        }
        Ok(())
    }

    fn load_documents(&mut self, door: &dyn Door, flags: &Flags) -> Result<(), String> {
        let entities = entities(door, "document")?;
        let documents = door.table("document", "id, folder_id", "id", "id")?;
        for document in &documents {
            let id = text(document, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            let mut fields = BTreeMap::new();
            fields.insert("starred", Val::Bool(flags.starred.contains(&id)));
            let created = text(entity, "created_at").unwrap_or_default();
            self.insert(Row {
                date: Stamp::parse(&created),
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

    fn load_photos(&mut self, door: &dyn Door, flags: &Flags) -> Result<(), String> {
        let entities = entities(door, "photo")?;
        let photos = door.table("photo", "id, form, taken_at", "id", "id")?;
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
            Ok(entities(door, kind)?
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

    /// The Locker items, read as the harness's Locker-on mode reads them (`Flags::locker`; the
    /// chat on the phone holds no Locker, R-1088-3): the item's entity row (its title, stamps and
    /// trash) beside its kind row, with its sealed cells for `reveal`, and its star from the
    /// flags every kind shares.
    fn load_locker(&mut self, door: &dyn Door, flags: &Flags) -> Result<(), String> {
        let entities = entities(door, "locker_item")?;
        let items = door.table(
            "locker_item",
            "id, type, username, url, notes, key_id, password, otp_seed, card_number, cvv, \
             content, cardholder, expiry, brand, fullname, email, phone, address, network",
            "id",
            "id",
        )?;
        let spec = Kind::LockerItem.spec();
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
            if kind == "note" && nonempty(text(item, "content")).is_some() {
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
                if let Some(sealed) = text(item, column) {
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
        for (from, to) in pairs(door, "about")? {
            let (Some(from_kind), Some(to_kind)) = (kinds.get(&from), kinds.get(&to)) else {
                continue;
            };
            self.edge((*from_kind, from), (*to_kind, to), Via::About);
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
    fn load(door: &dyn Door) -> Result<Self, String> {
        let of = |flag: centraid_vault::model::Flag| -> Result<BTreeSet<String>, String> {
            Ok(door
                .table_where(
                    "edge",
                    "from_id, to_id",
                    "from_id",
                    "to_id",
                    "rel = ? AND to_id = ?",
                    &["tagged".to_owned(), flag.id()],
                )?
                .iter()
                .filter_map(|row| text(row, "from_id"))
                .collect())
        };
        Ok(Self {
            starred: of(centraid_vault::model::Flag::Starred)?,
            pinned: of(centraid_vault::model::Flag::Pinned)?,
        })
    }
}

/// Every entity of one kind, live or in the trash, by id.
fn entities(door: &dyn Door, kind: &str) -> Result<BTreeMap<String, VaultRow>, String> {
    Ok(door
        .table_where(
            "entity",
            "id, title, created_at, updated_at, deleted_at, purge_at",
            "created_at",
            "id",
            "kind = ?",
            &[kind.to_owned()],
        )?
        .into_iter()
        .filter_map(|row| Some((text(&row, "id")?, row)))
        .collect())
}

/// The `(from, to)` ends of every edge of one relation.
fn pairs(door: &dyn Door, rel: &str) -> Result<Vec<(String, String)>, String> {
    Ok(door
        .table_where(
            "edge",
            "from_id, to_id",
            "from_id",
            "to_id",
            "rel = ?",
            &[rel.to_owned()],
        )?
        .iter()
        .filter_map(|row| Some((text(row, "from_id")?, text(row, "to_id")?)))
        .collect())
}

/// When each person was last touched: the latest `starts` of an activity of an activity kind
/// (a call, a visit; a workout is not a touch) that is `with` them. Computed at read, as
/// People computes it (`last_contacted` is stored nowhere).
fn last_contacts(door: &dyn Door) -> Result<BTreeMap<String, String>, String> {
    let with = pairs(door, "with")?;
    if with.is_empty() {
        return Ok(BTreeMap::new());
    }
    let starts: BTreeMap<String, String> = door
        .table_where(
            "activity",
            "id, starts",
            "id",
            "id",
            "type_kind = ?",
            &["activity_kind".to_owned()],
        )?
        .iter()
        .filter_map(|row| Some((text(row, "id")?, text(row, "starts")?)))
        .collect();
    let live: BTreeSet<String> = entities(door, "activity")?
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

/// A field's type, for the where-language and `compute`.
#[must_use]
pub fn field_type(kind: Kind, name: &str) -> Option<FieldType> {
    kind.spec().field(name).map(|field| field.ty)
}
