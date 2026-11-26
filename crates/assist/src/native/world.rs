//! THE WORLD AS THE MODEL SEES IT — every model-facing row, read out of the
//! vault through the kit's paged reads and mapped by the metadata table.
//!
//! It is re-read after every write, so a row's fields are always the vault's.

use std::collections::{BTreeMap, BTreeSet};

use crate::native::dates::Stamp;
use crate::native::door::Door;
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
/// Where and when the person stands: their today, and the zone their days are in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Standing {
    pub today: jiff::civil::Date,
    /// An IANA zone name (`Etc/UTC`, `Pacific/Auckland`).
    pub tz: String,
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

/// `42.00 USD`.
#[must_use]
pub fn money(minor: i64, currency: &str) -> String {
    let digits = usize::from(centraid_domain::money::minor_units(currency));
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
    let digits = i32::from(centraid_domain::money::minor_units(currency));
    minor as f64 / 10_f64.powi(digits)
}

/// Currency units → minor units.
#[must_use]
pub fn minor_of(amount: f64, currency: &str) -> i64 {
    let digits = i32::from(centraid_domain::money::minor_units(currency));
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

impl World {
    #[must_use]
    pub fn row(&self, key: &Key) -> Option<&Row> {
        self.rows.get(key)
    }

    /// Every row of a kind, live or trashed.
    pub fn of_kind(&self, kind: Kind) -> impl Iterator<Item = &Row> {
        self.rows.values().filter(move |row| row.kind == kind)
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
        world.calendar = "calendar:default".to_owned();

        let held = entities_by_id(door, &pinned.iter().cloned().collect::<Vec<_>>())?;
        let mut scopes = Scopes::default();
        for vault_kind in WINDOWED {
            scopes
                .0
                .insert(*vault_kind, Scope::read(door, vault_kind, &held)?);
        }
        world.load_people(door, scopes.of("person"))?;
        world.load_events(door, scopes.of("event"))?;
        world.load_tasks(door, scopes.of("task"))?;
        world.load_photos(door, scopes.of("photo"))?;
        world.load_notes(door, scopes.of("note"))?;
        world.load_containers(door, &scopes)?;
        world.load_documents(door, scopes.of("document"))?;
        world.load_locker(door, scopes.of("locker_item"))?;
        world.load_transactions(door, at, &scopes)?;
        world.load_money_lists(door, &scopes)?;
        world.load_health(door, at)?;
        world.load_links(door)?;
        for (vault_kind, scope) in &scopes.0 {
            if scope.more {
                world.older.extend(model_kinds(vault_kind));
            }
        }
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

    fn load_people(&mut self, door: &dyn Door, scope: &Scope) -> Result<(), String> {
        let entities = &scope.entities;
        let ids = scope.ids();
        let people = by_ids(
            door,
            "person",
            "id, form, role, nickname, met, cadence_days",
            &ids,
        )?;
        let touched = last_contacts(door, &ids)?;
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
            fields.insert("starred", Val::Bool(is_flagged(entity, "starred_at")));
            let mut row = row_of(Kind::Person, &id, entity, fields);
            row.date = touched.get(&id).and_then(|at| Stamp::parse(at));
            self.insert(row);
        }
        Ok(())
    }

    fn load_events(&mut self, door: &dyn Door, scope: &Scope) -> Result<(), String> {
        let entities = &scope.entities;
        let ids = scope.ids();
        let events = by_ids(
            door,
            "event",
            "id, starts, ends, timing, zone, rule, status, place_id, description",
            &ids,
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
            let mut row = row_of(Kind::Event, &id, entity, fields);
            let starts = text(event, "starts").and_then(|value| Stamp::parse(&value));
            let ends = text(event, "ends").and_then(|value| Stamp::parse(&value));
            shape_event(&mut row, starts, ends);
            if let Some(timing) = text(event, "timing") {
                row.extra.insert("timing", timing);
            }
            if let Some(zone) = text(event, "zone") {
                row.extra.insert("zone", zone);
            }
            if let Some(rule) = text(event, "rule") {
                row.extra.insert("rrule", rule);
            }
            self.insert(row);
        }
        for chunk in ids.chunks(IN_CHUNK) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let guests = door.table_where(
                "event_guest",
                "id, event_id, person_id",
                "event_id",
                "id",
                &format!("event_id IN ({marks}) AND person_id IS NOT NULL"),
                chunk,
            )?;
            for guest in guests {
                if let (Some(event_id), Some(person_id)) =
                    (text(&guest, "event_id"), text(&guest, "person_id"))
                {
                    self.edge(
                        (Kind::Event, event_id),
                        (Kind::Person, person_id),
                        Via::Attendee,
                    );
                }
            }
        }
        Ok(())
    }

    fn load_tasks(&mut self, door: &dyn Door, scope: &Scope) -> Result<(), String> {
        let entities = &scope.entities;
        let ids = scope.ids();
        let tasks = by_ids(
            door,
            "task",
            "id, status, priority, due, done_at, rule, description",
            &ids,
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
                text(task, "done_at")
                    .and_then(|value| Stamp::parse(&value))
                    .map(Val::Date),
            );
            put(
                &mut fields,
                "description",
                nonempty(text(task, "description")),
            );
            fields.insert("starred", Val::Bool(is_flagged(entity, "starred_at")));
            let mut row = row_of(Kind::Task, &id, entity, fields);
            row.date = text(task, "due").and_then(|value| Stamp::parse(&value));
            if let Some(rule) = text(task, "rule") {
                row.extra.insert("rrule", rule);
            }
            self.insert(row);
            if let Some(parent) = text(entity, "parent_id") {
                match text(entity, "parent_kind").as_deref() {
                    Some("task") => {
                        self.edge((Kind::Task, parent), (Kind::Task, id), Via::Subtask);
                    }
                    Some("task_list") => {
                        self.edge((Kind::List, parent), (Kind::Task, id), Via::ListColumn);
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }

    fn load_notes(&mut self, door: &dyn Door, scope: &Scope) -> Result<(), String> {
        let entities = &scope.entities;
        let notes = by_ids(door, "note", "id, body", &scope.ids())?;
        for note in &notes {
            let id = text(note, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            let mut fields = BTreeMap::new();
            put(&mut fields, "body", nonempty(text(note, "body")));
            fields.insert("pinned", Val::Bool(is_flagged(entity, "pinned_at")));
            fields.insert("starred", Val::Bool(is_flagged(entity, "starred_at")));
            let created = text(entity, "created_at").unwrap_or_default();
            let mut row = row_of(Kind::Note, &id, entity, fields);
            row.date = local_created_stamp(&self.zone, &created);
            self.insert(row);
            if text(entity, "parent_kind").as_deref() == Some("notebook")
                && let Some(notebook) = text(entity, "parent_id")
            {
                self.edge((Kind::Notebook, notebook), (Kind::Note, id), Via::Entry);
            }
        }
        Ok(())
    }

    fn load_containers(&mut self, door: &dyn Door, scopes: &Scopes) -> Result<(), String> {
        for (vault_kind, kind) in [
            ("notebook", Kind::Notebook),
            ("album", Kind::Album),
            ("folder", Kind::Folder),
            ("task_list", Kind::List),
        ] {
            let entities = &scopes.of(vault_kind).entities;
            let containers = by_ids(door, "container", "id", &scopes.of(vault_kind).ids())?;
            for container in &containers {
                let id = text(container, "id").unwrap_or_default();
                let Some(entity) = entities.get(&id) else {
                    continue;
                };
                if text(entity, "deleted_at").is_some() {
                    continue;
                }
                self.insert(row_of(kind, &id, entity, BTreeMap::new()));
            }
        }
        let album_ids = scopes.of("album").ids();
        for (album, photo) in edges_from(door, "contains", &album_ids)? {
            self.edge((Kind::Album, album), (Kind::Photo, photo), Via::Entry);
        }
        Ok(())
    }

    fn load_documents(&mut self, door: &dyn Door, scope: &Scope) -> Result<(), String> {
        let entities = &scope.entities;
        let docs = by_ids(door, "document", "id", &scope.ids())?;
        for doc in &docs {
            let id = text(doc, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            let mut fields = BTreeMap::new();
            fields.insert("starred", Val::Bool(is_flagged(entity, "starred_at")));
            let created = text(entity, "created_at").unwrap_or_default();
            let mut row = row_of(Kind::Document, &id, entity, fields);
            row.date = local_created_stamp(&self.zone, &created);
            self.insert(row);
            if text(entity, "parent_kind").as_deref() == Some("folder")
                && let Some(folder) = text(entity, "parent_id")
            {
                self.edge(
                    (Kind::Folder, folder),
                    (Kind::Document, id),
                    Via::FolderColumn,
                );
            }
        }
        Ok(())
    }

    fn load_photos(&mut self, door: &dyn Door, scope: &Scope) -> Result<(), String> {
        let entities = &scope.entities;
        let photos = by_ids(door, "photo", "id, taken_at", &scope.ids())?;
        for photo in &photos {
            let id = text(photo, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            if text(entity, "parent_id").is_some() {
                continue;
            }
            let mut fields = BTreeMap::new();
            fields.insert("starred", Val::Bool(is_flagged(entity, "starred_at")));
            let mut row = row_of(Kind::Photo, &id, entity, fields);
            row.date = text(photo, "taken_at").and_then(|at| Stamp::parse(&at));
            self.insert(row);
        }
        Ok(())
    }

    fn load_locker(&mut self, door: &dyn Door, scope: &Scope) -> Result<(), String> {
        let entities = &scope.entities;
        let ids = scope.ids();
        let items = by_ids(door, "locker_item", "id, type", &ids)?;
        let mut field_rows = Vec::new();
        for chunk in ids.chunks(IN_CHUNK) {
            let marks = vec!["?"; chunk.len()].join(", ");
            field_rows.extend(door.table_where(
                "locker_item_field",
                "id, item_id, field_key, kind, value_text, key_id",
                "item_id",
                "id",
                &format!("item_id IN ({marks})"),
                chunk,
            )?);
        }
        let mut plain_by_item: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        let mut sealed_by_item: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let mut key_by_item: BTreeMap<String, String> = BTreeMap::new();
        for row in &field_rows {
            let (Some(item_id), Some(field_key)) = (text(row, "item_id"), text(row, "field_key"))
            else {
                continue;
            };
            if let Some(key) = text(row, "key_id") {
                key_by_item.entry(item_id.clone()).or_insert(key);
            }
            let field_kind = text(row, "kind").unwrap_or_default();
            if centraid_vault::commands::locker::schema::is_sealed_kind(&field_kind) {
                sealed_by_item.entry(item_id).or_default().insert(field_key);
            } else if let Some(val) = text(row, "value_text") {
                plain_by_item
                    .entry(item_id)
                    .or_default()
                    .insert(field_key, val);
            }
        }
        let spec = Kind::LockerItem.spec();
        for item in &items {
            let id = text(item, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            let plain = plain_by_item.get(&id);
            let sealed_set = sealed_by_item.get(&id);
            let plain_of =
                |column: &str| -> Option<String> { plain.and_then(|m| m.get(column)).cloned() };
            let held = |column: &str| -> Option<String> {
                sealed_set
                    .is_some_and(|keys| keys.contains(column))
                    .then(|| {
                        centraid_vault::commands::locker::schema::SEALED_PLACEHOLDER.to_owned()
                    })
            };
            let mut fields = BTreeMap::new();
            let kind = text(item, "type").unwrap_or_default();
            if let Some(value) = spec
                .field("type")
                .and_then(|field| field.model_value(&kind))
            {
                fields.insert("type", Val::Enum(value));
            }
            put(&mut fields, "username", nonempty(plain_of("username")));
            put(&mut fields, "url", nonempty(plain_of("url")));
            put(&mut fields, "notes", nonempty(plain_of("notes")));
            if kind == "note" && nonempty(held("content")).is_some() {
                fields.insert("notes", Val::Text(SEALED.to_owned()));
            }
            fields.insert("starred", Val::Bool(is_flagged(entity, "starred_at")));
            let mut row = row_of(Kind::LockerItem, &id, entity, fields);
            if let Some(key) = key_by_item.get(&id) {
                row.extra.insert("key_id", key.clone());
            }
            for (_, column) in crate::native::meta::REVEAL_FIELDS {
                if let Some(sealed) = held(column) {
                    row.extra.insert(column, sealed);
                }
            }
            self.insert(row);
        }
        Ok(())
    }

    fn load_transactions(
        &mut self,
        door: &dyn Door,
        at: Option<&Standing>,
        scopes: &Scopes,
    ) -> Result<(), String> {
        let floor = month_floor(today_of(door, at), TRANSACTION_MONTHS.saturating_sub(1));
        let txns = door.table_where(
            "txn",
            "id, account_id, posted_on, amount_minor, status",
            "posted_on",
            "id",
            "posted_on >= ?",
            &[floor],
        )?;
        let ids: Vec<String> = txns.iter().filter_map(|row| text(row, "id")).collect();
        let entities = entities_by_id(door, &ids)?;
        let account_entities = &scopes.of("account").entities;
        let account_rows = by_ids(door, "account", "id, currency", &scopes.of("account").ids())?;
        let currencies: BTreeMap<String, String> = account_rows
            .iter()
            .filter_map(|row| Some((text(row, "id")?, text(row, "currency")?)))
            .collect();
        let account_names: BTreeMap<String, String> = account_entities
            .iter()
            .filter_map(|(id, row)| Some((id.clone(), text(row, "title")?)))
            .collect();
        let category_names: BTreeMap<String, String> = scopes
            .of("category")
            .entities
            .iter()
            .filter_map(|(id, row)| Some((id.clone(), text(row, "title")?)))
            .collect();
        let mut splits: BTreeMap<String, String> = BTreeMap::new();
        for chunk in ids.chunks(IN_CHUNK) {
            let marks = vec!["?"; chunk.len()].join(", ");
            for split in door.table_where(
                "txn_split",
                "txn_id, position, category_id",
                "txn_id",
                "position",
                &format!("txn_id IN ({marks})"),
                chunk,
            )? {
                if let (Some(txn_id), Some(category_id)) =
                    (text(&split, "txn_id"), text(&split, "category_id"))
                {
                    splits.entry(txn_id).or_insert(category_id);
                }
            }
        }
        let mut transfers: BTreeMap<String, String> = BTreeMap::new();
        for row in door.table("transfer", "a, b", "a", "b")? {
            if let (Some(a), Some(b)) = (text(&row, "a"), text(&row, "b")) {
                transfers.insert(a.clone(), b.clone());
                transfers.insert(b, a);
            }
        }
        let spec = Kind::Transaction.spec();
        for txn in &txns {
            let id = text(txn, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            if text(entity, "deleted_at").is_some() {
                continue;
            }
            let account_id = text(txn, "account_id").unwrap_or_default();
            let currency = currencies
                .get(&account_id)
                .cloned()
                .unwrap_or_else(|| self.currency.clone());
            let mut fields = BTreeMap::new();
            fields.insert(
                "amount",
                Val::Money(int(txn, "amount_minor").unwrap_or_default(), currency),
            );
            put(
                &mut fields,
                "account",
                account_names.get(&account_id).cloned().map(Val::Text),
            );
            put(
                &mut fields,
                "category",
                splits
                    .get(&id)
                    .and_then(|cat| category_names.get(cat).cloned())
                    .map(Val::Text),
            );
            if let Some(other) = transfers.get(&id) {
                fields.insert("transfer", Val::Text(other.clone()));
            }
            let status = text(txn, "status").unwrap_or_default();
            if let Some(value) = spec
                .field("status")
                .and_then(|field| field.model_value(&status))
            {
                fields.insert("status", Val::Enum(value));
            }
            let mut row = row_of(Kind::Transaction, &id, entity, fields);
            row.date = text(txn, "posted_on")
                .and_then(|posted| Stamp::parse(&posted))
                .map(|posted| Stamp {
                    date: posted.date,
                    time: None,
                });
            row.extra.remove("purge_at");
            self.insert(row);
        }
        Ok(())
    }

    fn load_money_lists(&mut self, door: &dyn Door, scopes: &Scopes) -> Result<(), String> {
        let account_entities = &scopes.of("account").entities;
        for account in by_ids(
            door,
            "account",
            "id, type, currency, opening_minor, opening_on, on_budget",
            &scopes.of("account").ids(),
        )? {
            let id = text(&account, "id").unwrap_or_default();
            let Some(entity) = account_entities.get(&id) else {
                continue;
            };
            if text(entity, "deleted_at").is_some() {
                continue;
            }
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
            put(
                &mut fields,
                "opening_on",
                nonempty(text(&account, "opening_on")),
            );
            fields.insert(
                "on_budget",
                Val::Bool(int(&account, "on_budget") != Some(0)),
            );
            self.insert(row_of(Kind::Account, &id, entity, fields));
        }
        let category_entities = &scopes.of("category").entities;
        let titles: BTreeMap<String, String> = category_entities
            .iter()
            .filter_map(|(id, row)| Some((id.clone(), text(row, "title")?)))
            .collect();
        for concept in by_ids(door, "concept", "id, key", &scopes.of("category").ids())? {
            let id = text(&concept, "id").unwrap_or_default();
            let Some(entity) = category_entities.get(&id) else {
                continue;
            };
            if text(entity, "created_at").as_deref() == Some(STOCK_CATEGORIES_AT) {
                continue;
            }
            let mut fields = BTreeMap::new();
            put(&mut fields, "key", nonempty(text(&concept, "key")));
            put(
                &mut fields,
                "group",
                text(entity, "parent_id")
                    .and_then(|parent| titles.get(&parent).cloned())
                    .map(Val::Text),
            );
            self.insert(row_of(Kind::Category, &id, entity, fields));
        }
        let budgets = door.window(&WindowQuery {
            table: "budget",
            columns: "category_id, month, amount_minor, carry",
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
            let mut fields = BTreeMap::new();
            fields.insert(
                "amount",
                Val::Money(
                    int(&budget, "amount_minor").unwrap_or_default(),
                    self.currency.clone(),
                ),
            );
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
                date: text(&rule, "created_at").and_then(|at| Stamp::parse(&at)),
                fields,
                trashed: false,
                created: text(&rule, "created_at").unwrap_or_default(),
                updated: String::new(),
                extra: BTreeMap::new(),
            });
        }
        Ok(())
    }

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
        let spec = Kind::DailyFigure.spec();
        for figure in figures {
            let day = text(&figure, "day").unwrap_or_default();
            let metric = text(&figure, "metric").unwrap_or_default();
            let Some(metric_val) = spec
                .field("metric")
                .and_then(|field| field.model_value(&metric))
            else {
                continue;
            };
            let value = match figure.get("value") {
                Some(centraid_domain::row::Cell::Real(v)) => v.round() as i64,
                Some(centraid_domain::row::Cell::Integer(v)) => *v,
                _ => continue,
            };
            let mut fields = BTreeMap::new();
            fields.insert("metric", Val::Enum(metric_val));
            fields.insert("value", Val::Num(value));
            self.insert(Row {
                kind: Kind::DailyFigure,
                id: format!("{day}:{metric}"),
                name: metric_val.to_owned(),
                date: Stamp::parse(&day),
                fields,
                trashed: false,
                created: String::new(),
                updated: String::new(),
                extra: BTreeMap::new(),
            });
        }
        let readings = door.table_where(
            "reading",
            "id, metric, at, value",
            "at",
            "id",
            "person_id = ? AND metric = ? AND at >= ?",
            &[self.me.clone(), "weight_kg".to_owned(), floor.clone()],
        )?;
        for reading in readings {
            let at_str = text(&reading, "at").unwrap_or_default();
            let day = at_str.get(..10).unwrap_or_default().to_owned();
            if day.len() != 10 {
                continue;
            }
            let value = match reading.get("value") {
                Some(centraid_domain::row::Cell::Real(v)) => v.round() as i64,
                Some(centraid_domain::row::Cell::Integer(v)) => *v,
                _ => continue,
            };
            let mut fields = BTreeMap::new();
            fields.insert("metric", Val::Enum("weight_kg"));
            fields.insert("value", Val::Num(value));
            self.insert(Row {
                kind: Kind::DailyFigure,
                id: format!("{day}:weight_kg"),
                name: "weight_kg".to_owned(),
                date: Stamp::parse(&day),
                fields,
                trashed: false,
                created: String::new(),
                updated: String::new(),
                extra: BTreeMap::new(),
            });
        }
        let workouts = door.window(&WindowQuery {
            table: "workout",
            columns: "id, starts, moving_s, distance_m, energy_kcal, heart_bpm, climb_m",
            sort: "starts",
            pk: "id",
            predicate: "starts >= ?",
            binds: &[floor],
            limit: WINDOW_ROWS,
            newest_first: true,
        })?;
        let ids: Vec<String> = workouts
            .rows
            .iter()
            .filter_map(|row| text(row, "id"))
            .collect();
        let entities = entities_by_id(door, &ids)?;
        for workout in &workouts.rows {
            let id = text(workout, "id").unwrap_or_default();
            let Some(entity) = entities.get(&id) else {
                continue;
            };
            let mut fields = BTreeMap::new();
            put(
                &mut fields,
                "moving",
                int(workout, "moving_s").map(Val::Num),
            );
            put(
                &mut fields,
                "distance",
                int(workout, "distance_m").map(Val::Num),
            );
            put(
                &mut fields,
                "energy",
                int(workout, "energy_kcal").map(Val::Num),
            );
            put(
                &mut fields,
                "heart_rate",
                int(workout, "heart_bpm").map(Val::Num),
            );
            put(&mut fields, "climb", int(workout, "climb_m").map(Val::Num));
            let mut row = row_of(Kind::Workout, &id, entity, fields);
            row.date = text(workout, "starts").and_then(|s| local_stamp(&self.zone, &s));
            self.insert(row);
        }
        Ok(())
    }

    fn load_links(&mut self, door: &dyn Door) -> Result<(), String> {
        let kinds: BTreeMap<String, Kind> = self
            .rows
            .keys()
            .map(|(kind, id)| (id.clone(), *kind))
            .collect();
        let from_ids: Vec<String> = self
            .rows
            .keys()
            .filter(|(kind, _)| {
                matches!(
                    kind,
                    Kind::Note
                        | Kind::Task
                        | Kind::Event
                        | Kind::Document
                        | Kind::Photo
                        | Kind::Person
                        | Kind::Transaction
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
        for row in door.table("link", "a, b", "a", "b")? {
            let (Some(a), Some(b)) = (text(&row, "a"), text(&row, "b")) else {
                continue;
            };
            let (Some(ka), Some(kb)) = (kinds.get(&a), kinds.get(&b)) else {
                continue;
            };
            let via = if matches!(
                (ka, kb),
                (Kind::Event, Kind::Person) | (Kind::Person, Kind::Event)
            ) {
                Via::Attendee
            } else {
                Via::About
            };
            if *ka == Kind::Person && *kb != Kind::Person {
                self.edge((*kb, b), (*ka, a), via);
            } else {
                self.edge((*ka, a), (*kb, b), via);
            }
        }
        Ok(())
    }
}

use crate::native::door::{WindowQuery, int, text};
use centraid_domain::row::Row as VaultRow;

const ENTITY_COLUMNS: &str = "id, kind, title, parent_id, parent_kind, created_at, updated_at, deleted_at, purge_at, \
     starred_at, pinned_at, archived_at";
const IN_CHUNK: usize = 64;
const EDGES_PER_CHUNK: usize = IN_CHUNK * 8;
const STOCK_CATEGORIES_AT: &str = "2026-10-21T00:00:00.000Z";

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
    "task_list",
    "account",
    "category",
];

fn is_flagged(entity: &VaultRow, column: &str) -> bool {
    text(entity, column).is_some()
}

fn nonempty(value: Option<String>) -> Option<Val> {
    value.filter(|text| !text.is_empty()).map(Val::Text)
}

fn put(fields: &mut BTreeMap<&'static str, Val>, name: &'static str, value: Option<Val>) {
    if let Some(value) = value {
        fields.insert(name, value);
    }
}

fn row_of(kind: Kind, id: &str, entity: &VaultRow, fields: BTreeMap<&'static str, Val>) -> Row {
    let mut extra = BTreeMap::new();
    if let Some(purge) = text(entity, "purge_at") {
        extra.insert("purge_at", purge);
    }
    Row {
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

fn shape_event(row: &mut Row, starts: Option<Stamp>, ends: Option<Stamp>) {
    row.date = starts;
    if let (Some(start), Some(end)) = (starts, ends)
        && start.time.is_some()
        && end.time.is_some()
    {
        let mins = end.at().duration_since(start.at()).as_secs() / 60;
        if mins > 0 {
            row.fields.insert("duration", Val::Num(mins));
        }
    }
}

fn local_stamp(zone: &str, iso: &str) -> Option<Stamp> {
    let tz = jiff::tz::TimeZone::get(zone).unwrap_or(jiff::tz::TimeZone::UTC);
    let ts: jiff::Timestamp = iso.parse().ok()?;
    let dt = ts.to_zoned(tz).datetime();
    Some(Stamp {
        date: dt.date(),
        time: Some(dt.time()),
    })
}

fn local_created_stamp(zone: &str, iso: &str) -> Option<Stamp> {
    local_stamp(zone, iso).or_else(|| Stamp::parse(iso))
}

fn today_of(door: &dyn Door, at: Option<&Standing>) -> jiff::civil::Date {
    if let Some(standing) = at {
        return standing.today;
    }
    jiff::Timestamp::from_millisecond(door.now_ms())
        .map(|ts| ts.to_zoned(jiff::tz::TimeZone::UTC).date())
        .unwrap_or_else(|_| jiff::civil::date(2026, 1, 1))
}

fn month_floor(today: jiff::civil::Date, months: u32) -> String {
    let back = i32::try_from(months).unwrap_or(3);
    let total = i32::from(today.year()) * 12 + i32::from(today.month()) - 1 - back;
    let year = total.div_euclid(12);
    let month = total.rem_euclid(12) + 1;
    format!("{year:04}-{month:02}-01")
}

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
        "task_list" => vec![Kind::List],
        "account" => vec![Kind::Account],
        "category" => vec![Kind::Category],
        _ => Vec::new(),
    }
}

#[derive(Debug, Default)]
struct Scope {
    entities: BTreeMap<String, VaultRow>,
    more: bool,
}

impl Scope {
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

fn entities_by_id(door: &dyn Door, ids: &[String]) -> Result<BTreeMap<String, VaultRow>, String> {
    Ok(by_ids(door, "entity", ENTITY_COLUMNS, ids)?
        .into_iter()
        .filter_map(|row| Some((text(&row, "id")?, row)))
        .collect())
}

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

fn edges_from(door: &dyn Door, rel: &str, ids: &[String]) -> Result<Vec<(String, String)>, String> {
    edges_by(door, rel, "from_id", ids)
}

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

fn last_contacts(door: &dyn Door, people: &[String]) -> Result<BTreeMap<String, String>, String> {
    let with = edges_to(door, "with", people)?;
    if with.is_empty() {
        return Ok(BTreeMap::new());
    }
    let touch_ids: Vec<String> = with
        .iter()
        .map(|(touch, _)| touch.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let starts: BTreeMap<String, String> = by_ids(door, "touch", "id, starts", &touch_ids)?
        .iter()
        .filter_map(|row| Some((text(row, "id")?, text(row, "starts")?)))
        .collect();
    let live: BTreeSet<String> = entities_by_id(door, &touch_ids)?
        .into_iter()
        .filter(|(_, row)| text(row, "deleted_at").is_none())
        .map(|(id, _)| id)
        .collect();
    let mut last: BTreeMap<String, String> = BTreeMap::new();
    for (touch, person) in with {
        let Some(at) = starts.get(&touch).filter(|_| live.contains(&touch)) else {
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

/// The vault kind whose entities a model kind's rows are.
#[must_use]
pub fn vault_kind_of(kind: Kind) -> Option<&'static str> {
    Some(kind.spec().entity)
}
