//! THE WORLD AS THE MODEL SEES IT — every model-facing row, read out of the
//! vault through the kit's paged reads and mapped by the metadata table.
//!
//! It is re-read after every write, so a row's fields are always the vault's.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::row::Row as VaultRow;
use centraid_apps_tally::queries::TallyData;

use crate::native::dates::Stamp;
use crate::native::door::{Door, int, text};
use crate::native::meta::{Field, FieldType, Kind, Via};

pub const FLAGS_SCHEME: &str = "https://centraid.dev/schemes/flags";
pub const FOLDER_SCHEME: &str = "https://centraid.dev/schemes/folders";
pub const STARRED: &str = "starred";
pub const ROOT_FOLDER: &str = "root";

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
    /// The `core_link` row behind an `About` edge.
    pub link_id: Option<String>,
}

/// Everything the tools read.
#[derive(Debug, Clone, Default)]
pub struct World {
    pub rows: BTreeMap<Key, Row>,
    pub edges: Vec<Edge>,
    pub me: String,
    pub currency: String,
    pub calendar: String,
    pub root_folder: Option<String>,
    pub locker_key: Option<String>,
    pub tally: TallyData,
    /// Invocations in the journal, for the seed that numbers a session.
    pub entity_count: usize,
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

    /// Load everything, the Locker included.
    pub fn load(door: &dyn Door) -> Result<Self, String> {
        Self::load_with(door, true)
    }

    /// Load everything. With `locker` false (`Flags::locker`) no Locker table and no sealed
    /// column is read, and the world holds no Locker item.
    pub fn load_with(door: &dyn Door, locker: bool) -> Result<Self, String> {
        let mut world = Self::default();
        let vault = door.table(
            "core_vault",
            "vault_id, self_party_id, base_currency, created_at",
            "created_at",
            "vault_id",
        )?;
        let vault = vault.first().ok_or("the vault has not been founded")?;
        world.me = text(vault, "self_party_id").unwrap_or_default();
        world.currency = text(vault, "base_currency").unwrap_or_else(|| "USD".to_owned());
        world.calendar = door
            .table(
                "schedule_calendar",
                "calendar_id, created_at",
                "created_at",
                "calendar_id",
            )?
            .first()
            .and_then(|row| text(row, "calendar_id"))
            .unwrap_or_default();
        world.entity_count = door
            .table(
                "agent_command_invocation",
                "invocation_id, requested_at",
                "requested_at",
                "invocation_id",
            )?
            .len();

        let concepts = Concepts::load(door)?;
        world.root_folder = concepts.root_folder.clone();
        world.load_people(door, &concepts)?;
        world.load_groups(door)?;
        world.load_events(door)?;
        world.load_tasks(door)?;
        // Photos before collections: an album's entries are edges to them.
        world.load_photos(door, &concepts)?;
        world.load_notes_and_collections(door)?;
        world.load_documents(door, &concepts)?;
        world.load_debts(door)?;
        if locker {
            world.load_locker(door, &concepts)?;
        }
        world.load_links(door)?;
        world.tally = door.tally()?;
        world.edges.sort();
        world.edges.dedup();
        Ok(world)
    }

    fn insert(&mut self, row: Row) {
        self.rows.insert(row.key(), row);
    }

    fn edge(&mut self, from: Key, to: Key, via: Via, link_id: Option<String>) {
        if self.rows.contains_key(&from) && self.rows.contains_key(&to) {
            self.edges.push(Edge {
                from,
                to,
                via,
                link_id,
            });
        }
    }

    fn load_people(&mut self, door: &dyn Door, concepts: &Concepts) -> Result<(), String> {
        let parties = door.table(
            "core_party",
            "party_id, kind, display_name, created_at, updated_at",
            "created_at",
            "party_id",
        )?;
        let profiles = door.table(
            "people_profile",
            "profile_id, party_id, role, nickname, cadence_days, last_contacted_at, met, \
             created_at, updated_at, deleted_at, purge_at",
            "created_at",
            "profile_id",
        )?;
        let by_party: BTreeMap<String, &VaultRow> = profiles
            .iter()
            .filter_map(|row| text(row, "party_id").map(|id| (id, row)))
            .collect();
        for party in &parties {
            if text(party, "kind").as_deref() != Some("person") {
                continue;
            }
            let id = text(party, "party_id").unwrap_or_default();
            let profile = by_party.get(&id).copied();
            let mut fields = BTreeMap::new();
            let mut date = None;
            let mut trashed = false;
            let mut updated = text(party, "updated_at").unwrap_or_default();
            if let Some(profile) = profile {
                put(&mut fields, "role", nonempty(text(profile, "role")));
                put(&mut fields, "nickname", nonempty(text(profile, "nickname")));
                put(&mut fields, "met", nonempty(text(profile, "met")));
                put(
                    &mut fields,
                    "cadence",
                    int(profile, "cadence_days")
                        .filter(|days| *days > 0)
                        .map(Val::Num),
                );
                date = stamp(text(profile, "last_contacted_at"));
                trashed = text(profile, "deleted_at").is_some();
                updated = updated.max(text(profile, "updated_at").unwrap_or_default());
            }
            fields.insert("starred", Val::Bool(concepts.starred("core.party", &id)));
            let mut extra = BTreeMap::new();
            if profile.is_some() {
                extra.insert("profile", "yes".to_owned());
            }
            if let Some(purge) = profile.and_then(|profile| text(profile, "purge_at")) {
                extra.insert("purge_at", purge);
            }
            self.insert(Row {
                kind: Kind::Person,
                name: text(party, "display_name").unwrap_or_default(),
                id,
                date,
                fields,
                trashed,
                created: text(party, "created_at").unwrap_or_default(),
                updated,
                extra,
            });
        }
        Ok(())
    }

    fn load_groups(&mut self, door: &dyn Door) -> Result<(), String> {
        let groups = door.table(
            "tally_group",
            "group_id, circle_id, currency, archived_at, created_at, updated_at",
            "created_at",
            "group_id",
        )?;
        let circles = door.table(
            "social_circle",
            "circle_id, name, created_at",
            "created_at",
            "circle_id",
        )?;
        let members = door.table(
            "social_circle_member",
            "member_id, circle_id, party_id, added_at",
            "added_at",
            "member_id",
        )?;
        let names: BTreeMap<String, String> = circles
            .iter()
            .filter_map(|row| Some((text(row, "circle_id")?, text(row, "name")?)))
            .collect();
        let mut circle_group = BTreeMap::new();
        for group in &groups {
            let id = text(group, "group_id").unwrap_or_default();
            let circle = text(group, "circle_id").unwrap_or_default();
            circle_group.insert(circle.clone(), id.clone());
            let mut fields = BTreeMap::new();
            let currency = text(group, "currency").unwrap_or_default();
            fields.insert("currency", Val::Text(currency.clone()));
            let mut extra = BTreeMap::new();
            extra.insert("currency", currency);
            self.insert(Row {
                kind: Kind::Group,
                name: names.get(&circle).cloned().unwrap_or_default(),
                id,
                date: None,
                fields,
                trashed: false,
                created: text(group, "created_at").unwrap_or_default(),
                updated: text(group, "updated_at").unwrap_or_default(),
                extra,
            });
        }
        for member in &members {
            let (Some(circle), Some(party)) = (text(member, "circle_id"), text(member, "party_id"))
            else {
                continue;
            };
            if let Some(group) = circle_group.get(&circle) {
                self.edge(
                    (Kind::Group, group.clone()),
                    (Kind::Person, party),
                    Via::Membership,
                    None,
                );
            }
        }
        Ok(())
    }

    fn load_events(&mut self, door: &dyn Door) -> Result<(), String> {
        let events = door.table(
            "core_event",
            "event_id, summary, description, dtstart, dtend, status, created_at, updated_at, \
             deleted_at, purge_at",
            "created_at",
            "event_id",
        )?;
        for event in &events {
            let start = stamp(text(event, "dtstart"));
            let end = stamp(text(event, "dtend"));
            let mut fields = BTreeMap::new();
            let status = text(event, "status").unwrap_or_default();
            let spec = Kind::Event.spec();
            if let Some(value) = spec
                .field("status")
                .and_then(|field| field.model_value(&status))
            {
                fields.insert("status", Val::Enum(value));
            }
            let mut date = start;
            if let (Some(start), Some(end)) = (start, end) {
                let minutes = end.at().duration_since(start.at()).as_secs() / 60;
                let all_day = start.time == Some(jiff::civil::Time::midnight())
                    && minutes > 0
                    && minutes % (24 * 60) == 0;
                if all_day {
                    date = Some(Stamp {
                        date: start.date,
                        time: None,
                    });
                } else {
                    fields.insert("duration", Val::Num(minutes));
                }
            }
            put(
                &mut fields,
                "description",
                nonempty(text(event, "description")),
            );
            let mut extra = BTreeMap::new();
            // the stored spellings of the span and the trash window: what a write's checks read
            // (the clash of a new event, the restore window)
            for (name, column) in [
                ("dtstart", "dtstart"),
                ("dtend", "dtend"),
                ("purge_at", "purge_at"),
            ] {
                if let Some(value) = text(event, column) {
                    extra.insert(name, value);
                }
            }
            self.insert(Row {
                kind: Kind::Event,
                id: text(event, "event_id").unwrap_or_default(),
                name: text(event, "summary").unwrap_or_default(),
                date,
                fields,
                trashed: text(event, "deleted_at").is_some(),
                created: text(event, "created_at").unwrap_or_default(),
                updated: text(event, "updated_at").unwrap_or_default(),
                extra,
            });
        }
        let attendees = door.table(
            "schedule_attendee",
            "attendee_id, event_id, party_id, created_at",
            "created_at",
            "attendee_id",
        )?;
        for attendee in &attendees {
            if let (Some(event), Some(party)) =
                (text(attendee, "event_id"), text(attendee, "party_id"))
            {
                self.edge(
                    (Kind::Event, event),
                    (Kind::Person, party),
                    Via::Attendee,
                    None,
                );
            }
        }
        Ok(())
    }

    fn load_tasks(&mut self, door: &dyn Door) -> Result<(), String> {
        let projects = door.table(
            "schedule_project",
            "project_id, name, area, archived_at, created_at, updated_at",
            "created_at",
            "project_id",
        )?;
        for project in &projects {
            let mut fields = BTreeMap::new();
            put(&mut fields, "area", nonempty(text(project, "area")));
            self.insert(Row {
                kind: Kind::List,
                id: text(project, "project_id").unwrap_or_default(),
                name: text(project, "name").unwrap_or_default(),
                date: None,
                fields,
                trashed: false,
                created: text(project, "created_at").unwrap_or_default(),
                updated: text(project, "updated_at").unwrap_or_default(),
                extra: BTreeMap::new(),
            });
        }
        let tasks = door.table(
            "schedule_task",
            "task_id, title, description, status, priority, due_at, completed_at, effort_min, \
             parent_task_id, project_id, created_at, updated_at, deleted_at, purge_at, rrule",
            "created_at",
            "task_id",
        )?;
        let spec = Kind::Task.spec();
        for task in &tasks {
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
                stamp(text(task, "completed_at")).map(Val::Date),
            );
            put(
                &mut fields,
                "description",
                nonempty(text(task, "description")),
            );
            let mut extra = BTreeMap::new();
            for column in ["purge_at", "rrule"] {
                if let Some(value) = text(task, column) {
                    extra.insert(column, value);
                }
            }
            self.insert(Row {
                kind: Kind::Task,
                id: text(task, "task_id").unwrap_or_default(),
                name: text(task, "title").unwrap_or_default(),
                date: stamp(text(task, "due_at")),
                fields,
                trashed: text(task, "deleted_at").is_some(),
                created: text(task, "created_at").unwrap_or_default(),
                updated: text(task, "updated_at").unwrap_or_default(),
                extra,
            });
        }
        for task in &tasks {
            let id = text(task, "task_id").unwrap_or_default();
            if let Some(parent) = text(task, "parent_task_id") {
                self.edge(
                    (Kind::Task, parent),
                    (Kind::Task, id.clone()),
                    Via::Subtask,
                    None,
                );
            }
            if let Some(project) = text(task, "project_id") {
                self.edge(
                    (Kind::List, project),
                    (Kind::Task, id),
                    Via::ListColumn,
                    None,
                );
            }
        }
        Ok(())
    }

    fn load_notes_and_collections(&mut self, door: &dyn Door) -> Result<(), String> {
        let texts = door.table(
            "core_content_text",
            "content_id, body_text, created_at",
            "created_at",
            "content_id",
        )?;
        let bodies: BTreeMap<String, String> = texts
            .iter()
            .filter_map(|row| Some((text(row, "content_id")?, text(row, "body_text")?)))
            .collect();
        let notes = door.table(
            "knowledge_note",
            "note_id, title, body_content_id, pinned, created_at, updated_at, deleted_at, purge_at",
            "created_at",
            "note_id",
        )?;
        for note in &notes {
            let mut fields = BTreeMap::new();
            let body = text(note, "body_content_id").and_then(|id| bodies.get(&id).cloned());
            put(&mut fields, "body", nonempty(body));
            fields.insert("pinned", Val::Bool(int(note, "pinned") == Some(1)));
            let created = text(note, "created_at").unwrap_or_default();
            let mut extra = BTreeMap::new();
            if let Some(purge) = text(note, "purge_at") {
                extra.insert("purge_at", purge);
            }
            self.insert(Row {
                kind: Kind::Note,
                id: text(note, "note_id").unwrap_or_default(),
                name: text(note, "title").unwrap_or_default(),
                date: Stamp::parse(&created),
                fields,
                trashed: text(note, "deleted_at").is_some(),
                created,
                updated: text(note, "updated_at").unwrap_or_default(),
                extra,
            });
        }
        // ALBUM OR NOTEBOOK. Both are `core_collection` rows and the table
        // does not say which. The journal does: every collection this
        // runtime or its seeder makes is created with an explicit id, so the
        // executed `media.create_album` / `knowledge.create_notebook`
        // invocation naming that id is the answer. Failing that, what the
        // collection holds; failing that, a notebook.
        let invocations = door.table(
            "agent_command_invocation",
            "invocation_id, command_id, input_json, status, requested_at",
            "requested_at",
            "invocation_id",
        )?;
        let mut roles: BTreeMap<String, Kind> = BTreeMap::new();
        for invocation in &invocations {
            if text(invocation, "status").as_deref() != Some("executed") {
                continue;
            }
            let command = text(invocation, "command_id").unwrap_or_default();
            let input: serde_json::Value =
                serde_json::from_str(&text(invocation, "input_json").unwrap_or_default())
                    .unwrap_or_default();
            let (kind, key) = match command.as_str() {
                "media.create_album" => (Kind::Album, "album_id"),
                "knowledge.create_notebook" => (Kind::Notebook, "notebook_id"),
                _ => continue,
            };
            if let Some(id) = input.get(key).and_then(serde_json::Value::as_str) {
                roles.insert(id.to_owned(), kind);
            }
        }
        let entries = door.table(
            "core_collection_entry",
            "entry_id, collection_id, target_type, target_id, added_at",
            "added_at",
            "entry_id",
        )?;
        for entry in &entries {
            let (Some(collection), Some(target_type)) =
                (text(entry, "collection_id"), text(entry, "target_type"))
            else {
                continue;
            };
            let role = match target_type.as_str() {
                "media.asset" => Kind::Album,
                "knowledge.note" => Kind::Notebook,
                _ => continue,
            };
            roles.entry(collection).or_insert(role);
        }
        let collections = door.table(
            "core_collection",
            "collection_id, name, parent_collection_id, created_at, updated_at",
            "created_at",
            "collection_id",
        )?;
        for collection in &collections {
            let id = text(collection, "collection_id").unwrap_or_default();
            let kind = roles.get(&id).copied().unwrap_or(Kind::Notebook);
            let mut extra = BTreeMap::new();
            if let Some(parent) = text(collection, "parent_collection_id") {
                extra.insert("parent", parent);
            }
            self.insert(Row {
                kind,
                name: text(collection, "name").unwrap_or_default(),
                id,
                date: None,
                fields: BTreeMap::new(),
                trashed: false,
                created: text(collection, "created_at").unwrap_or_default(),
                updated: text(collection, "updated_at").unwrap_or_default(),
                extra,
            });
        }
        for entry in &entries {
            let (Some(collection), Some(target_type), Some(target)) = (
                text(entry, "collection_id"),
                text(entry, "target_type"),
                text(entry, "target_id"),
            ) else {
                continue;
            };
            match target_type.as_str() {
                "media.asset" => self.edge(
                    (Kind::Album, collection),
                    (Kind::Photo, target),
                    Via::Entry,
                    None,
                ),
                "knowledge.note" => self.edge(
                    (Kind::Notebook, collection),
                    (Kind::Note, target),
                    Via::Entry,
                    None,
                ),
                _ => {}
            }
        }
        Ok(())
    }

    fn load_documents(&mut self, door: &dyn Door, concepts: &Concepts) -> Result<(), String> {
        for (id, label, created, updated, parent) in &concepts.folders {
            let mut extra = BTreeMap::new();
            if let Some(parent) = parent {
                extra.insert("parent", parent.clone());
            }
            self.insert(Row {
                kind: Kind::Folder,
                id: id.clone(),
                name: label.clone(),
                date: None,
                fields: BTreeMap::new(),
                trashed: false,
                created: created.clone(),
                updated: updated.clone(),
                extra,
            });
        }
        let documents = door.table(
            "core_document",
            "document_id, title, created_at, updated_at, deleted_at, purge_at",
            "created_at",
            "document_id",
        )?;
        for document in &documents {
            let id = text(document, "document_id").unwrap_or_default();
            let mut fields = BTreeMap::new();
            fields.insert("starred", Val::Bool(concepts.starred("core.document", &id)));
            let created = text(document, "created_at").unwrap_or_default();
            let mut extra = BTreeMap::new();
            if let Some(purge) = text(document, "purge_at") {
                extra.insert("purge_at", purge);
            }
            self.insert(Row {
                kind: Kind::Document,
                name: text(document, "title").unwrap_or_default(),
                id,
                date: Stamp::parse(&created),
                fields,
                trashed: text(document, "deleted_at").is_some(),
                created,
                updated: text(document, "updated_at").unwrap_or_default(),
                extra,
            });
        }
        for (document, folder) in &concepts.filed {
            self.edge(
                (Kind::Folder, folder.clone()),
                (Kind::Document, document.clone()),
                Via::FolderTag,
                None,
            );
        }
        Ok(())
    }

    fn load_photos(&mut self, door: &dyn Door, concepts: &Concepts) -> Result<(), String> {
        let assets = door.table(
            "media_asset",
            "asset_id, kind, title, captured_at, created_at, updated_at, deleted_at, purge_at",
            "created_at",
            "asset_id",
        )?;
        for asset in &assets {
            if text(asset, "kind").as_deref() != Some("photo") {
                continue;
            }
            let id = text(asset, "asset_id").unwrap_or_default();
            let mut fields = BTreeMap::new();
            fields.insert("starred", Val::Bool(concepts.starred("media.asset", &id)));
            let mut extra = BTreeMap::new();
            if let Some(purge) = text(asset, "purge_at") {
                extra.insert("purge_at", purge);
            }
            self.insert(Row {
                kind: Kind::Photo,
                name: text(asset, "title")
                    .filter(|title| !title.is_empty())
                    .unwrap_or_else(|| "untitled".to_owned()),
                id,
                date: stamp(text(asset, "captured_at")),
                fields,
                trashed: text(asset, "deleted_at").is_some(),
                created: text(asset, "created_at").unwrap_or_default(),
                updated: text(asset, "updated_at").unwrap_or_default(),
                extra,
            });
        }
        Ok(())
    }

    fn load_debts(&mut self, door: &dyn Door) -> Result<(), String> {
        let debts = door.table(
            "tally_obligation",
            "obligation_id, from_party, to_party, amount_minor, currency, reason, incurred_on, \
             settled_at, created_at, updated_at, deleted_at",
            "created_at",
            "obligation_id",
        )?;
        for debt in &debts {
            let id = text(debt, "obligation_id").unwrap_or_default();
            let from = text(debt, "from_party").unwrap_or_default();
            let to = text(debt, "to_party").unwrap_or_default();
            let (direction, other) = if from == self.me {
                ("i_owe", to)
            } else {
                ("owes_me", from)
            };
            let mut fields = BTreeMap::new();
            let currency = text(debt, "currency").unwrap_or_else(|| self.currency.clone());
            fields.insert(
                "amount",
                Val::Money(int(debt, "amount_minor").unwrap_or_default(), currency),
            );
            fields.insert("direction", Val::Enum(direction));
            let settled = text(debt, "settled_at").is_some();
            fields.insert(
                "status",
                Val::Enum(if settled { "settled" } else { "open" }),
            );
            self.insert(Row {
                kind: Kind::Debt,
                id: id.clone(),
                name: text(debt, "reason").unwrap_or_else(|| "debt".to_owned()),
                date: stamp(text(debt, "incurred_on")),
                fields,
                trashed: text(debt, "deleted_at").is_some(),
                created: text(debt, "created_at").unwrap_or_default(),
                updated: text(debt, "updated_at").unwrap_or_default(),
                extra: BTreeMap::new(),
            });
            self.edge(
                (Kind::Debt, id),
                (Kind::Person, other),
                Via::Counterparty,
                None,
            );
        }
        Ok(())
    }

    fn load_locker(&mut self, door: &dyn Door, concepts: &Concepts) -> Result<(), String> {
        let items = door.table(
            "locker_item",
            "item_id, type, title, username, url, notes, created_at, updated_at, deleted_at, \
             purge_at, key_id, password, otp_seed, card_number, cvv, content, cardholder, expiry, brand, \
             fullname, email, phone, address, network",
            "created_at",
            "item_id",
        )?;
        let spec = Kind::LockerItem.spec();
        for item in &items {
            let id = text(item, "item_id").unwrap_or_default();
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
            fields.insert("starred", Val::Bool(concepts.starred("locker.item", &id)));
            let mut extra = BTreeMap::new();
            if let Some(key) = text(item, "key_id") {
                extra.insert("key_id", key);
            }
            if let Some(purge) = text(item, "purge_at") {
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
                name: text(item, "title").unwrap_or_default(),
                id,
                date: None,
                fields,
                trashed: text(item, "deleted_at").is_some(),
                created: text(item, "created_at").unwrap_or_default(),
                updated: text(item, "updated_at").unwrap_or_default(),
                extra,
            });
        }
        Ok(())
    }

    fn load_links(&mut self, door: &dyn Door) -> Result<(), String> {
        let links = door.table(
            "core_link",
            "link_id, from_type, from_id, to_type, to_id, valid_from, valid_to",
            "valid_from",
            "link_id",
        )?;
        for link in &links {
            if text(link, "valid_to").is_some() {
                continue;
            }
            let (Some(from_type), Some(from), Some(to_type), Some(to)) = (
                text(link, "from_type"),
                text(link, "from_id"),
                text(link, "to_type"),
                text(link, "to_id"),
            ) else {
                continue;
            };
            let (Some(from_kind), Some(to_kind)) =
                (self.kind_of(&from_type, &from), self.kind_of(&to_type, &to))
            else {
                continue;
            };
            self.edge(
                (from_kind, from),
                (to_kind, to),
                Via::About,
                text(link, "link_id"),
            );
        }
        Ok(())
    }

    /// Which model kind a vault entity row is, if it is one.
    #[must_use]
    pub fn kind_of(&self, entity: &str, id: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|kind| {
            kind.spec().entity == entity && self.rows.contains_key(&(*kind, id.to_owned()))
        })
    }
}

/// The concept plane: stars and folders.
struct Concepts {
    starred: BTreeSet<(String, String)>,
    /// `(id, label, created, updated, parent)`.
    folders: Vec<(String, String, String, String, Option<String>)>,
    /// `(document, folder)` — not the root.
    filed: Vec<(String, String)>,
    root_folder: Option<String>,
}

impl Concepts {
    fn load(door: &dyn Door) -> Result<Self, String> {
        let schemes = door.table(
            "core_concept_scheme",
            "scheme_id, uri, created_at",
            "created_at",
            "scheme_id",
        )?;
        let scheme_of = |uri: &str| -> Option<String> {
            schemes
                .iter()
                .find(|row| text(row, "uri").as_deref() == Some(uri))
                .and_then(|row| text(row, "scheme_id"))
        };
        let flags = scheme_of(FLAGS_SCHEME);
        let folders_scheme = scheme_of(FOLDER_SCHEME);
        let concepts = door.table(
            "core_concept",
            "concept_id, scheme_id, notation, pref_label, broader_concept_id, created_at, updated_at",
            "created_at",
            "concept_id",
        )?;
        let mut starred_concepts = BTreeSet::new();
        let mut folders = Vec::new();
        let mut folder_ids = BTreeSet::new();
        let mut root_folder = None;
        for concept in &concepts {
            let scheme = text(concept, "scheme_id");
            let id = text(concept, "concept_id").unwrap_or_default();
            let notation = text(concept, "notation").unwrap_or_default();
            if scheme.is_some() && scheme == flags && notation == STARRED {
                starred_concepts.insert(id.clone());
            }
            if scheme.is_some() && scheme == folders_scheme {
                if notation == ROOT_FOLDER {
                    root_folder = Some(id.clone());
                } else {
                    folder_ids.insert(id.clone());
                    folders.push((
                        id,
                        text(concept, "pref_label").unwrap_or_default(),
                        text(concept, "created_at").unwrap_or_default(),
                        text(concept, "updated_at").unwrap_or_default(),
                        text(concept, "broader_concept_id"),
                    ));
                }
            }
        }
        let tags = door.table(
            "core_tag",
            "tag_id, target_type, target_id, concept_id, tagged_at",
            "tagged_at",
            "tag_id",
        )?;
        let mut starred = BTreeSet::new();
        let mut filed = Vec::new();
        for tag in &tags {
            let (Some(target_type), Some(target), Some(concept)) = (
                text(tag, "target_type"),
                text(tag, "target_id"),
                text(tag, "concept_id"),
            ) else {
                continue;
            };
            if starred_concepts.contains(&concept) {
                starred.insert((target_type.clone(), target.clone()));
            }
            if target_type == "core.document" && folder_ids.contains(&concept) {
                filed.push((target, concept));
            }
        }
        Ok(Self {
            starred,
            folders,
            filed,
            root_folder,
        })
    }

    fn starred(&self, entity: &str, id: &str) -> bool {
        self.starred.contains(&(entity.to_owned(), id.to_owned()))
    }
}

/// A field's type, for the where-language and `compute`.
#[must_use]
pub fn field_type(kind: Kind, name: &str) -> Option<FieldType> {
    kind.spec().field(name).map(|field| field.ty)
}
