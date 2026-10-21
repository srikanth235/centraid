//! THE METADATA TABLE — the one source of truth (SPEC §1.7).
//!
//! Model-facing kinds, fields, enums, units, links and verbs, each mapped to
//! the vault table, column and typed command it stands for (the kind tables of
//! [#1135](https://github.com/srikanth235/centraid/issues/1135): an entity row
//! and its kind row, a flag or a container as the edge or the column that holds it). The tool schemas,
//! the kind card, the `where` parser's fields, the runtime's reads and writes
//! and the generator's vocabulary (through `nativetools export`) are all
//! generated from these rows. `tests/meta.rs` proves every mapped column exists in a
//! freshly founded vault, every mapped command is registered, and every enum
//! is exactly its column's CHECK list (the part the model leaves out is
//! declared in `UNEXPOSED`).
//!
//! Derived rather than restated where the vault states it: the Locker item
//! types are `centraid_vault::commands::locker::ITEM_TYPES` (built in a
//! `const` block, not copied), and the fields
//! `reveal` can open are the Locker columns the ontology registry marks
//! sealed.

use centraid_vault::commands::locker::ITEM_TYPES;
use serde::Serialize;

/// Rows shown per result; the rest are counted and reachable through `@n`.
pub const ROW_CAP: usize = 12;
/// Rows a lookup (`find`, `search`) shows when more than `ROW_CAP` match: a
/// long candidate list is counted and narrowed, not read. `answer` keeps
/// `ROW_CAP`. Set it to `ROW_CAP` or more to switch the rule off.
pub const LOOKUP_CAP: usize = 6;

/// Rows a lookup over `total` matches shows.
#[must_use]
pub const fn lookup_shown(total: usize) -> usize {
    if total > ROW_CAP { LOOKUP_CAP } else { total }
}
/// Model calls per turn, errors included (SPEC §6.3).
pub const STEP_CAP: usize = 6;
/// Containers listed per kind in the vault directory (SPEC §6.0.4, §14).
pub const DIRECTORY_CAP: usize = 8;
/// Rows in a pre-grounding block (SPEC §6.1). No kind takes more than half of
/// them while another kind has a hit (`search::preground`).
pub const PREGROUND_CAP: usize = 8;
/// Linked rows `open` names per linked kind.
pub const OPEN_LINK_CAP: usize = 8;

/// The model-facing kinds (SPEC §14: member folded into person).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Person,
    Event,
    Task,
    Note,
    Document,
    Photo,
    Album,
    LockerItem,
    Notebook,
    Folder,
    List,
    /// A Money transaction (#1099, R-1099-8): read-only in v0.
    Transaction,
}

impl Kind {
    pub const ALL: [Self; 12] = [
        Self::Person,
        Self::Event,
        Self::Task,
        Self::Note,
        Self::Document,
        Self::Photo,
        Self::Album,
        Self::LockerItem,
        Self::Notebook,
        Self::Folder,
        Self::List,
        Self::Transaction,
    ];

    #[must_use]
    pub fn spec(self) -> &'static KindSpec {
        KINDS
            .iter()
            .find(|spec| spec.kind == self)
            .expect("every kind has a row")
    }

    #[must_use]
    pub fn name(self) -> &'static str {
        self.spec().name
    }

    #[must_use]
    pub fn plural(self) -> &'static str {
        self.spec().plural
    }

    /// The model-facing spelling, case-insensitive; the plural is accepted.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let wanted = text.trim().to_lowercase().replace('_', " ");
        KINDS
            .iter()
            .find(|spec| spec.name == wanted || spec.plural == wanted)
            .map(|spec| spec.kind)
    }

    /// The count phrase: `1 task`, `3 tasks`.
    #[must_use]
    pub fn count(self, count: usize) -> String {
        if count == 1 {
            format!("1 {}", self.name())
        } else {
            format!("{count} {}", self.plural())
        }
    }

    /// The link a row of this kind holds its contents by: a list its tasks, a
    /// notebook its notes, an album its photos, a folder its documents, a task
    /// its subtasks. `None` for a kind that holds nothing.
    #[must_use]
    pub fn holds(self) -> Option<&'static Link> {
        let spec = self.spec();
        if spec.container {
            spec.links.first()
        } else {
            spec.links.iter().find(|link| link.via == Via::Subtask)
        }
    }
}

/// What a field holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    Text,
    Number,
    /// Currency units in the row's currency; stored as minor units.
    Money,
    Enum,
    Bool,
    /// A date that is not the kind's `date`: only `is set` / `is empty` in
    /// `where` (SPEC §4.1: `when` is the only date filter).
    Date,
}

/// Where a value lives in the vault.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Source {
    pub table: &'static str,
    pub column: &'static str,
}

const fn at(table: &'static str, column: &'static str) -> Source {
    Source { table, column }
}

/// One model-facing field.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Field {
    pub name: &'static str,
    #[serde(rename = "type")]
    pub ty: FieldType,
    pub unit: Option<&'static str>,
    /// `(model value, vault value)` for an enum.
    pub values: &'static [(&'static str, &'static str)],
    pub source: Source,
    /// The command an `edit` of this field runs, `None` when it is read-only.
    pub edit: Option<&'static str>,
    /// Whether `create` accepts it.
    pub create: bool,
}

const fn field(name: &'static str, ty: FieldType, source: Source) -> Field {
    Field {
        name,
        ty,
        unit: None,
        values: &[],
        source,
        edit: None,
        create: false,
    }
}

impl Field {
    const fn unit(mut self, unit: &'static str) -> Self {
        self.unit = Some(unit);
        self
    }
    const fn values(mut self, values: &'static [(&'static str, &'static str)]) -> Self {
        self.values = values;
        self
    }
    const fn edit(mut self, command: &'static str) -> Self {
        self.edit = Some(command);
        self
    }
    const fn create(mut self) -> Self {
        self.create = true;
        self
    }

    /// The vault spelling of a model enum value.
    #[must_use]
    pub fn vault_value(&self, model: &str) -> Option<&'static str> {
        self.values
            .iter()
            .find(|(name, _)| *name == model)
            .map(|(_, vault)| *vault)
    }

    /// The model spelling of a vault enum value.
    #[must_use]
    pub fn model_value(&self, vault: &str) -> Option<&'static str> {
        self.values
            .iter()
            .find(|(_, value)| *value == vault)
            .map(|(name, _)| *name)
    }

    /// `status (open|completed)`, `effort (min)`, `amount (USD)`.
    #[must_use]
    pub fn card(&self, currency: &str) -> String {
        match self.ty {
            FieldType::Enum => {
                let names: Vec<&str> = self.values.iter().map(|(name, _)| *name).collect();
                format!("{} ({})", self.name, names.join("|"))
            }
            FieldType::Money => format!("{} ({currency})", self.name),
            FieldType::Bool => format!("{} (yes|no)", self.name),
            FieldType::Date => format!("{} (date)", self.name),
            _ => match self.unit {
                Some(unit) => format!("{} ({unit})", self.name),
                None => self.name.to_owned(),
            },
        }
    }
}

/// The kind's one `date`, the only thing `when` filters on.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct DateSpec {
    pub label: &'static str,
    pub source: Source,
}

/// One edge a kind has to another kind, and how the vault holds it.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Link {
    pub kind: Kind,
    pub label: &'static str,
    pub via: Via,
}

/// The vault mechanism behind a link.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    /// An `attendee` edge, event to person.
    Attendee,
    /// An `about` edge: a note, a task or an event about what it names.
    About,
    /// `task.parent_id` — parent to subtask.
    Subtask,
    /// `task.project_id`.
    ListColumn,
    /// A `contains` edge (photo in album) or `note.notebook_id` (note in notebook).
    Entry,
    /// `document.folder_id`.
    FolderColumn,
}

/// What an `act` can do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verb {
    Create,
    Edit,
    Reschedule,
    Complete,
    Reopen,
    Cancel,
    Delete,
    Restore,
    Star,
    Unstar,
    AddTo,
    RemoveFrom,
    Log,
    Reveal,
    Undo,
}

/// One verb's row.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct VerbSpec {
    pub verb: Verb,
    pub name: &'static str,
    /// The args, as the model writes them.
    pub args: &'static str,
    /// Past tense for the write echo.
    pub done: &'static str,
    /// `(kind, typed command)`; a verb applies to exactly these kinds.
    pub commands: &'static [(Kind, &'static str)],
}

/// One kind's row.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct KindSpec {
    pub kind: Kind,
    pub name: &'static str,
    pub plural: &'static str,
    /// The vault kind the row is an entity of (`person`, `txn`, `project`), the word search and a
    /// card name it by.
    pub entity: &'static str,
    /// The table of the kind's own row; its key is `pk`, and its `entity` row carries the name.
    pub table: &'static str,
    pub pk: &'static str,
    /// Where the row's name lives.
    pub name_source: Source,
    pub date: Option<DateSpec>,
    pub fields: &'static [Field],
    pub links: &'static [Link],
    /// `true` when rows can be trashed and restored.
    pub trash: bool,
    /// A container the vault directory lists (SPEC §6.0.4).
    pub container: bool,
}

impl KindSpec {
    #[must_use]
    pub fn field(&self, name: &str) -> Option<&'static Field> {
        self.fields.iter().find(|field| field.name == name)
    }

    #[must_use]
    pub fn link_to(&self, other: Kind) -> Option<&'static Link> {
        self.links.iter().find(|link| link.kind == other)
    }

    #[must_use]
    pub fn verbs(&self) -> Vec<Verb> {
        VERBS
            .iter()
            .filter(|spec| spec.commands.iter().any(|(kind, _)| *kind == self.kind))
            .map(|spec| spec.verb)
            .collect()
    }

    /// Field names valid in `where` for this kind.
    #[must_use]
    pub fn where_fields(&self) -> Vec<&'static str> {
        self.fields.iter().map(|field| field.name).collect()
    }
}

const TASK_STATUS: &[(&str, &str)] = &[
    ("open", "open"),
    ("completed", "done"),
    ("cancelled", "cancelled"),
];
const EVENT_STATUS: &[(&str, &str)] = &[
    ("confirmed", "confirmed"),
    ("tentative", "tentative"),
    ("cancelled", "cancelled"),
];
/// A transaction's status. `pending` is the one CHECK value left out (`UNEXPOSED`).
const TXN_STATUS: &[(&str, &str)] = &[("posted", "posted"), ("void", "void")];
/// Locker item types: the vault's own list, derived from
/// `centraid_vault::commands::locker::ITEM_TYPES` and spelled identically.
static LOCKER_TYPES: [(&str, &str); ITEM_TYPES.len()] = {
    let mut types = [("", ""); ITEM_TYPES.len()];
    let mut index = 0;
    while index < ITEM_TYPES.len() {
        types[index] = (ITEM_TYPES[index], ITEM_TYPES[index]);
        index += 1;
    }
    types
};

/// A value of a CHECK-constrained enum column that the model deliberately
/// cannot say. `tests/meta.rs` proves, for every enum field, that the vault
/// values the model can say plus these are exactly the CHECK's list: no
/// silent subset. The reason must say why the model does not get the value.
#[derive(Debug, Clone, Copy)]
pub struct Unexposed {
    pub table: &'static str,
    pub column: &'static str,
    pub value: &'static str,
    pub reason: &'static str,
}

/// The CHECK values the model's enums leave out: only a transaction's `pending`.
pub const UNEXPOSED: &[Unexposed] = &[Unexposed {
    table: "txn",
    column: "status",
    value: "pending",
    reason: "Money's import writes only posted rows and the member voids one; a pending row is a provider state no member action makes",
}];

/// `log kind:` values, stored as the activity kind notation.
pub const LOG_KINDS: &[&str] = &["call", "message", "visit", "coffee"];

/// A flag (starred, pinned) is a `tagged` edge to a `flag` entity, for every kind that takes one.
const STAR: Source = at("edge", "to_id");

use FieldType::{Bool, Date, Enum, Money, Number, Text};

pub static KINDS: &[KindSpec] = &[
    KindSpec {
        kind: Kind::Person,
        name: "person",
        plural: "people",
        entity: "person",
        table: "person",
        pk: "id",
        name_source: at("entity", "title"),
        // Computed at read: the latest touch (`activity` of an activity kind, `with` the person).
        date: Some(DateSpec {
            label: "last contacted",
            source: at("activity", "starts"),
        }),
        fields: &[
            field("role", Text, at("person", "role"))
                .edit("person.edit")
                .create(),
            field("nickname", Text, at("person", "nickname"))
                .edit("person.edit")
                .create(),
            field("met", Text, at("person", "met")).edit("person.edit"),
            field("cadence", Number, at("person", "cadence_days"))
                .unit("days")
                .edit("person.edit")
                .create(),
            field("starred", Bool, STAR),
        ],
        links: &[
            Link {
                kind: Kind::Event,
                label: "events",
                via: Via::Attendee,
            },
            Link {
                kind: Kind::Task,
                label: "tasks",
                via: Via::About,
            },
            Link {
                kind: Kind::Note,
                label: "notes",
                via: Via::About,
            },
        ],
        trash: true,
        container: false,
    },
    KindSpec {
        kind: Kind::Event,
        name: "event",
        plural: "events",
        entity: "event",
        table: "event",
        pk: "id",
        name_source: at("entity", "title"),
        date: Some(DateSpec {
            label: "start",
            source: at("event", "starts"),
        }),
        fields: &[
            field("status", Enum, at("event", "status")).values(EVENT_STATUS),
            field("duration", Number, at("event", "ends"))
                .unit("min")
                .edit("event.edit")
                .create(),
            field("description", Text, at("event", "description"))
                .edit("event.edit")
                .create(),
        ],
        links: &[Link {
            kind: Kind::Person,
            label: "people",
            via: Via::Attendee,
        }],
        trash: true,
        container: false,
    },
    KindSpec {
        kind: Kind::Task,
        name: "task",
        plural: "tasks",
        entity: "task",
        table: "task",
        pk: "id",
        name_source: at("entity", "title"),
        date: Some(DateSpec {
            label: "due",
            source: at("task", "due"),
        }),
        fields: &[
            // A status is three commands, one per word (`task_status_command`).
            field("status", Enum, at("task", "status"))
                .values(TASK_STATUS)
                .edit("task.complete"),
            field("effort", Number, at("task", "effort_min"))
                .unit("min")
                .edit("task.edit")
                .create(),
            field("priority", Number, at("task", "priority"))
                .unit(PRIORITY_SCALE)
                .edit("task.edit")
                .create(),
            field("completed", Date, at("task", "done_at")),
            field("description", Text, at("task", "description"))
                .edit("task.edit")
                .create(),
        ],
        links: &[
            Link {
                kind: Kind::Task,
                label: "subtasks",
                via: Via::Subtask,
            },
            Link {
                kind: Kind::Person,
                label: "people",
                via: Via::About,
            },
            Link {
                kind: Kind::List,
                label: "list",
                via: Via::ListColumn,
            },
        ],
        trash: true,
        container: false,
    },
    KindSpec {
        kind: Kind::Note,
        name: "note",
        plural: "notes",
        entity: "note",
        table: "note",
        pk: "id",
        name_source: at("entity", "title"),
        date: Some(DateSpec {
            label: "created",
            source: at("entity", "created_at"),
        }),
        fields: &[
            field("body", Text, at("note", "body"))
                .edit("note.edit")
                .create(),
            // Pinned is a flag: `flag.set` / `flag.clear` by value.
            field("pinned", Bool, STAR).edit("flag.set"),
        ],
        links: &[
            Link {
                kind: Kind::Notebook,
                label: "notebook",
                via: Via::Entry,
            },
            Link {
                kind: Kind::Person,
                label: "people",
                via: Via::About,
            },
        ],
        trash: true,
        container: false,
    },
    KindSpec {
        kind: Kind::Document,
        name: "document",
        plural: "documents",
        entity: "document",
        table: "document",
        pk: "id",
        name_source: at("entity", "title"),
        date: Some(DateSpec {
            label: "created",
            source: at("entity", "created_at"),
        }),
        fields: &[field("starred", Bool, STAR)],
        links: &[Link {
            kind: Kind::Folder,
            label: "folder",
            via: Via::FolderColumn,
        }],
        trash: true,
        container: false,
    },
    KindSpec {
        kind: Kind::Photo,
        name: "photo",
        plural: "photos",
        entity: "photo",
        table: "photo",
        pk: "id",
        name_source: at("entity", "title"),
        date: Some(DateSpec {
            label: "taken",
            source: at("photo", "taken_at"),
        }),
        fields: &[field("starred", Bool, STAR)],
        links: &[Link {
            kind: Kind::Album,
            label: "albums",
            via: Via::Entry,
        }],
        trash: true,
        container: false,
    },
    KindSpec {
        kind: Kind::Album,
        name: "album",
        plural: "albums",
        entity: "album",
        table: "container",
        pk: "id",
        name_source: at("entity", "title"),
        date: None,
        fields: &[],
        links: &[Link {
            kind: Kind::Photo,
            label: "photos",
            via: Via::Entry,
        }],
        trash: false,
        container: true,
    },
    KindSpec {
        kind: Kind::LockerItem,
        name: "locker item",
        plural: "locker items",
        entity: "locker_item",
        table: "locker_item",
        pk: "item_id",
        name_source: at("locker_item", "title"),
        date: None,
        fields: &[
            field("type", Enum, at("locker_item", "type"))
                .values(&LOCKER_TYPES)
                .create(),
            field("username", Text, at("locker_item", "username"))
                .edit("locker.edit_item")
                .create(),
            field("url", Text, at("locker_item", "url"))
                .edit("locker.edit_item")
                .create(),
            field("notes", Text, at("locker_item", "notes"))
                .edit("locker.edit_item")
                .create(),
            field("starred", Bool, at("locker_item", "starred")),
        ],
        links: &[],
        trash: true,
        container: false,
    },
    KindSpec {
        kind: Kind::Notebook,
        name: "notebook",
        plural: "notebooks",
        entity: "notebook",
        table: "container",
        pk: "id",
        name_source: at("entity", "title"),
        date: None,
        fields: &[],
        links: &[Link {
            kind: Kind::Note,
            label: "notes",
            via: Via::Entry,
        }],
        trash: false,
        container: true,
    },
    KindSpec {
        kind: Kind::Folder,
        name: "folder",
        plural: "folders",
        entity: "folder",
        table: "container",
        pk: "id",
        name_source: at("entity", "title"),
        date: None,
        fields: &[],
        links: &[Link {
            kind: Kind::Document,
            label: "documents",
            via: Via::FolderColumn,
        }],
        trash: false,
        container: true,
    },
    KindSpec {
        kind: Kind::List,
        name: "list",
        plural: "lists",
        // Agenda's project; the vault's own `list` kind is a People list, which the model has no
        // word for.
        entity: "project",
        table: "container",
        pk: "id",
        name_source: at("entity", "title"),
        date: None,
        // The area is the title of the `area` container the project sits in.
        fields: &[field("area", Text, at("container", "parent_id"))
            .edit("container.move")
            .create()],
        links: &[Link {
            kind: Kind::Task,
            label: "tasks",
            via: Via::ListColumn,
        }],
        trash: false,
        container: true,
    },
    KindSpec {
        kind: Kind::Transaction,
        name: "transaction",
        plural: "transactions",
        entity: "txn",
        table: "txn",
        pk: "id",
        // The name the member sees: Money's display name, which is the transaction's own title.
        name_source: at("entity", "title"),
        date: Some(DateSpec {
            label: "posted",
            source: at("txn", "posted_on"),
        }),
        // READS ONLY (#1099, R-1099-8): `amount` is signed (money out is negative) in the
        // account's currency; `account` and `category` are the titles of the entities the
        // transaction points at. `txn.categorize` takes an id in an array, which the
        // one-scalar-per-field `edit` path cannot carry, so no field is editable.
        fields: &[
            field("amount", Money, at("txn", "amount_minor")),
            field("account", Text, at("txn", "account_id")),
            field("category", Text, at("txn", "category_id")),
            field("status", Enum, at("txn", "status")).values(TXN_STATUS),
        ],
        links: &[],
        trash: false,
        container: false,
    },
];

/// The act verbs, one per effect (SPEC §4.2).
pub static VERBS: &[VerbSpec] = &[
    VerbSpec {
        verb: Verb::Create,
        name: "create",
        args: "kind: <kind>, name: <text>, then that kind's fields (dates as date expressions)",
        done: "created",
        commands: &[
            (Kind::Person, "person.add"),
            (Kind::Event, "event.propose"),
            (Kind::Task, "task.add"),
            (Kind::Note, "note.create"),
            (Kind::Document, "document.create_text"),
            (Kind::Album, "container.create"),
            (Kind::LockerItem, "locker.add_item"),
            (Kind::Notebook, "container.create"),
            (Kind::Folder, "container.create"),
            (Kind::List, "container.create"),
        ],
    },
    VerbSpec {
        verb: Verb::Edit,
        name: "edit",
        args: "field: value lines (name, or any editable field; body+: or description+: adds text)",
        done: "edited",
        commands: &[
            (Kind::Person, "person.edit"),
            (Kind::Event, "event.edit"),
            (Kind::Task, "task.edit"),
            (Kind::Note, "note.edit"),
            (Kind::Document, "entity.retitle"),
            (Kind::Photo, "entity.retitle"),
            (Kind::Album, "entity.retitle"),
            (Kind::LockerItem, "locker.edit_item"),
            (Kind::Notebook, "entity.retitle"),
            (Kind::Folder, "entity.retitle"),
            (Kind::List, "entity.retitle"),
        ],
    },
    VerbSpec {
        verb: Verb::Reschedule,
        name: "reschedule",
        args: "to: <date expression>",
        done: "rescheduled",
        commands: &[(Kind::Task, "task.edit"), (Kind::Event, "event.edit")],
    },
    VerbSpec {
        verb: Verb::Complete,
        name: "complete",
        args: "",
        done: "completed",
        commands: &[(Kind::Task, "task.complete")],
    },
    VerbSpec {
        verb: Verb::Reopen,
        name: "reopen",
        args: "",
        done: "reopened",
        commands: &[(Kind::Task, "task.reopen")],
    },
    VerbSpec {
        verb: Verb::Cancel,
        name: "cancel",
        args: "",
        done: "cancelled",
        commands: &[(Kind::Event, "event.cancel")],
    },
    VerbSpec {
        verb: Verb::Delete,
        name: "delete",
        args: "",
        done: "deleted",
        commands: &[
            (Kind::Person, "entity.trash"),
            (Kind::Event, "entity.trash"),
            (Kind::Task, "entity.trash"),
            (Kind::Note, "entity.trash"),
            (Kind::Document, "entity.trash"),
            (Kind::Photo, "entity.trash"),
            (Kind::Album, "entity.trash"),
            (Kind::LockerItem, "locker.trash_item"),
            (Kind::Notebook, "entity.trash"),
            (Kind::Folder, "entity.trash"),
        ],
    },
    VerbSpec {
        verb: Verb::Restore,
        name: "restore",
        args: "",
        done: "restored",
        commands: &[
            (Kind::Person, "entity.restore"),
            (Kind::Event, "entity.restore"),
            (Kind::Task, "entity.restore"),
            (Kind::Note, "entity.restore"),
            (Kind::Document, "entity.restore"),
            (Kind::Photo, "entity.restore"),
            (Kind::LockerItem, "locker.restore_item"),
        ],
    },
    VerbSpec {
        verb: Verb::Star,
        name: "star",
        args: "",
        done: "starred",
        commands: &[
            (Kind::Person, "flag.set"),
            (Kind::Document, "flag.set"),
            (Kind::Photo, "flag.set"),
            (Kind::LockerItem, "locker.star_item"),
        ],
    },
    VerbSpec {
        verb: Verb::Unstar,
        name: "unstar",
        args: "",
        done: "unstarred",
        commands: &[
            (Kind::Person, "flag.clear"),
            (Kind::Document, "flag.clear"),
            (Kind::Photo, "flag.clear"),
            (Kind::LockerItem, "locker.unstar_item"),
        ],
    },
    VerbSpec {
        verb: Verb::AddTo,
        name: "add_to",
        args: "to: #n (the album, notebook, folder or list)",
        done: "added",
        commands: &[
            (Kind::Photo, "edge.add"),
            (Kind::Note, "note.move"),
            (Kind::Document, "document.move"),
            (Kind::Task, "task.organize"),
        ],
    },
    VerbSpec {
        verb: Verb::RemoveFrom,
        name: "remove_from",
        args: "from: #n",
        done: "removed",
        commands: &[
            (Kind::Photo, "edge.remove"),
            (Kind::Note, "note.move"),
            (Kind::Document, "document.move"),
            (Kind::Task, "task.organize"),
        ],
    },
    VerbSpec {
        verb: Verb::Log,
        name: "log",
        args: "kind: call|message|visit|coffee",
        done: "logged",
        commands: &[(Kind::Person, "person.log_interaction")],
    },
    VerbSpec {
        verb: Verb::Reveal,
        name: "reveal",
        args: "field: password|code|card_number|cvv|content",
        done: "revealed",
        commands: &[(Kind::LockerItem, "locker.reveal_receipt")],
    },
    VerbSpec {
        verb: Verb::Undo,
        name: "undo",
        args: "",
        done: "undone",
        commands: &[],
    },
];

impl Verb {
    #[must_use]
    pub fn spec(self) -> &'static VerbSpec {
        VERBS
            .iter()
            .find(|spec| spec.verb == self)
            .expect("every verb has a row")
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let wanted = text.trim().to_lowercase();
        VERBS
            .iter()
            .find(|spec| spec.name == wanted)
            .map(|spec| spec.verb)
    }

    /// The typed command this verb runs on this kind, if it applies.
    #[must_use]
    pub fn command(self, kind: Kind) -> Option<&'static str> {
        self.spec()
            .commands
            .iter()
            .find(|(applies, _)| *applies == kind)
            .map(|(_, command)| *command)
    }

    #[must_use]
    pub fn kinds(self) -> Vec<Kind> {
        self.spec().commands.iter().map(|(kind, _)| *kind).collect()
    }
}

/// The command that puts a task in a status, by the VAULT's word for it: closing, reopening and
/// cancelling are three commands, not one command with a status argument.
#[must_use]
pub fn task_status_command(vault_status: &str) -> Option<&'static str> {
    match vault_status {
        "done" => Some("task.complete"),
        "open" => Some("task.reopen"),
        "cancelled" => Some("task.cancel"),
        _ => None,
    }
}

/// `reveal` field names → the sealed Locker column each opens. The sealed set
/// is the ontology registry's; a name here whose column is not sealed there
/// fails `tests/meta.rs`.
/// WHERE A LOCKER ITEM KEEPS `username`, `url` AND `notes`, by type. The
/// vault gives each type its own columns and nulls the rest on every write
/// (`centraid_vault::commands::locker`, `type_fields`): a login keeps all
/// three, a note keeps its text in the SEALED `content`, the nine template
/// types keep only `notes`, and a card, identity, wifi or password item keeps
/// none of them. `None` means the type cannot hold the field. The table is
/// checked against the vault itself in `tests/meta.rs`.
#[must_use]
pub fn locker_column(item_type: &str, field: &str) -> Option<&'static str> {
    match (item_type, field) {
        ("login", "username") => Some("username"),
        ("login", "url") => Some("url"),
        ("note", "notes") => Some("content"),
        ("card" | "identity" | "wifi" | "password" | "note", _) | (_, "username" | "url") => None,
        (_, "notes") => Some("notes"),
        _ => None,
    }
}

/// The locker types that keep a model field, for an error that names them.
#[must_use]
pub fn locker_types_holding(field: &str) -> Vec<&'static str> {
    centraid_vault::commands::locker::ITEM_TYPES
        .iter()
        .copied()
        .filter(|item_type| locker_column(item_type, field).is_some())
        .collect()
}

/// The sealed column a locker type keeps for a secret field, when it keeps it:
/// `password` on a login, wifi or password item, `code` (the one-time seed) on a
/// login, `card_number` and `cvv` on a card. `create` seals the value under the
/// locker key; any other type would null it without a word, so a create that
/// carries one is normalised first (`normalize.rs`).
#[must_use]
pub fn locker_secret_column(item_type: &str, field: &str) -> Option<&'static str> {
    let column = REVEAL_FIELDS
        .iter()
        .find(|(name, column)| *name == field && *column != "content")
        .map(|(_, column)| *column)?;
    let keeps: &[&str] = match item_type {
        "login" => &["password", "otp_seed"],
        "card" => &["card_number", "cvv"],
        "wifi" | "password" => &["password"],
        _ => &[],
    };
    keeps.contains(&column).then_some(column)
}

pub const REVEAL_FIELDS: &[(&str, &str)] = &[
    ("password", "password"),
    ("code", "otp_seed"),
    ("card_number", "card_number"),
    ("cvv", "cvv"),
    ("content", "content"),
];

/// Other names for the secrets a locker item keeps (nt14 N4), a closed table: the word as folded
/// (lowercase, hyphen and underscore a space) and the field of `REVEAL_FIELDS` it asks for.
/// `pin` and every word not here stay the error that names the fields.
const REVEAL_SYNONYMS: &[(&str, &str)] = &[
    ("2fa", "code"),
    ("otp", "code"),
    ("totp", "code"),
    ("authenticator", "code"),
    ("auth code", "code"),
    ("cvc", "cvv"),
    ("cvv2", "cvv"),
    ("security code", "cvv"),
    ("card", "card_number"),
    ("card no", "card_number"),
    ("card num", "card_number"),
    ("pass", "password"),
    ("pw", "password"),
];

/// Whether a word is a kind of the vault or another word for one (`doc`, `pic`,
/// `login`, `contact`, `bill`): a noun that says what a row is, not a word of its name. A closed
/// table over `Kind::parse` (nt15 R4: it is no content word of a name).
#[must_use]
pub fn kind_word(word: &str) -> bool {
    const OTHER: &[&str] = &[
        "bill",
        "bills",
        "doc",
        "docs",
        "pic",
        "pics",
        "picture",
        "pictures",
        "image",
        "images",
        "contact",
        "contacts",
        "persons",
        "login",
        "logins",
        "memo",
        "memos",
        "todo",
        "todos",
        "appointment",
        "appointments",
        "item",
        "items",
    ];
    let folded = word.trim().to_lowercase();
    Kind::parse(&folded).is_some() || OTHER.contains(&folded.as_str())
}

/// Every way a person names the secret `field` of `REVEAL_FIELDS` (nt15 R1s): its own name (with
/// a space for an underscore, `card number`), the synonyms of `REVEAL_SYNONYMS` and, for the
/// sealed content of a note item, `notes`. A word of the message that is one of these asks for it.
#[must_use]
pub fn reveal_names(field: &str) -> Vec<String> {
    let mut names = vec![field.replace('_', " ")];
    names.extend(
        REVEAL_SYNONYMS
            .iter()
            .filter(|(_, meant)| *meant == field)
            .map(|(name, _)| (*name).to_owned()),
    );
    if field == "content" {
        names.push("notes".to_owned());
    }
    names
}

/// The field of `REVEAL_FIELDS` a word asks for by another name (nt14 N4).
#[must_use]
pub fn reveal_synonym(word: &str) -> Option<&'static str> {
    let folded: Vec<String> = word
        .trim()
        .trim_matches('"')
        .to_lowercase()
        .split(|c: char| c.is_whitespace() || c == '-' || c == '_' || c == '.')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    let folded = folded.join(" ");
    REVEAL_SYNONYMS
        .iter()
        .find(|(name, _)| *name == folded)
        .map(|(_, field)| *field)
}

/// Task priority as the vault stores it: Todoist's scale, 0 unset and 1..9 with
/// HIGHER MORE URGENT — NOT RFC 5545's 1-is-highest. The Tasks board sorts
/// "priority desc" (D-1020-S5), `tasks.proto` says the same, and the phone's
/// Soon / Next / Now chips are 1 / 2 / 3, so a model told "1 highest" would file
/// its most urgent task as the app's least (Q-1047-10).
pub const PRIORITY_SCALE: &str = "9 highest..1 lowest, 0 none";

/// Value operations (SPEC §4.3).
pub const OPS: &[&str] = &["count", "sum", "min", "max"];

/// Decline reasons (SPEC §4).
pub const DECLINE_REASONS: &[&str] = &[
    "out_of_scope",
    "unbounded_destruction",
    "sealed_egress",
    "fabricated_secret",
    "never_mind",
    "not_found",
];

/// The eight tools, in the order the prompt lists them.
pub const TOOLS: &[&str] = &[
    "search", "find", "open", "compute", "act", "answer", "ask", "decline",
];

/// Parameters of the selector (SPEC §4.1).
pub const SELECTOR_PARAMS: &[&str] = &[
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

/// Selector parameters a multi-kind selector may use.
pub const MULTI_KIND_PARAMS: &[&str] = &[
    "kind",
    "name",
    "when",
    "linked_to",
    "within",
    "exclude",
    "limit",
    "trashed",
];

/// Every (table, column) the table maps, for the schema test and the export.
#[must_use]
pub fn mapped_columns() -> Vec<(&'static str, &'static str)> {
    let mut out = Vec::new();
    for spec in KINDS {
        out.push((spec.table, spec.pk));
        out.push((spec.name_source.table, spec.name_source.column));
        if let Some(date) = spec.date {
            out.push((date.source.table, date.source.column));
        }
        for field in spec.fields {
            out.push((field.source.table, field.source.column));
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// Every typed command the table names.
#[must_use]
pub fn mapped_commands() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = VERBS
        .iter()
        .flat_map(|spec| spec.commands.iter().map(|(_, command)| *command))
        .collect();
    for spec in KINDS {
        for field in spec.fields {
            if let Some(command) = field.edit {
                out.push(command);
            }
        }
    }
    out.extend([
        "edge.add",
        "edge.remove",
        "flag.set",
        "flag.clear",
        "task.cancel",
        "task.reopen",
    ]);
    out.sort_unstable();
    out.dedup();
    out
}
