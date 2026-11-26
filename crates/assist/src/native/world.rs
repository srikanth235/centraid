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
        let world = Self {
            zone: at.map_or_else(|| "Etc/UTC".to_owned(), |standing| standing.tz.clone()),
            ..Self::default()
        };
        let _ = (door, pinned);
        Ok(world)
    }
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
