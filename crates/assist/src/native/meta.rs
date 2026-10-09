//! THE METADATA TABLE — the one source of truth (SPEC §1.7).
//!
//! Model-facing kinds, fields, enums, units, links and verbs, each mapped to
//! the vault table, column and typed command it stands for. The tool schemas,
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
    Group,
    Event,
    Task,
    Note,
    Document,
    Photo,
    Album,
    Debt,
    LockerItem,
    Notebook,
    Folder,
    List,
}

impl Kind {
    pub const ALL: [Self; 13] = [
        Self::Person,
        Self::Group,
        Self::Event,
        Self::Task,
        Self::Note,
        Self::Document,
        Self::Photo,
        Self::Album,
        Self::Debt,
        Self::LockerItem,
        Self::Notebook,
        Self::Folder,
        Self::List,
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
    /// notebook its notes, an album its photos, a folder its documents, a group
    /// its members, a task its subtasks. `None` for a kind that holds nothing.
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
    /// `social_circle_member` under a Tally group's circle.
    Membership,
    /// `schedule_attendee`.
    Attendee,
    /// `core_link` with the `about` relation (`core.link_entities`).
    About,
    /// `schedule_task.parent_task_id` — parent to subtask.
    Subtask,
    /// `schedule_task.project_id`.
    ListColumn,
    /// `core_collection_entry` (photo in album, note in notebook).
    Entry,
    /// A folder concept tag on a document (`core.move_document`).
    FolderTag,
    /// `tally_obligation` — the counterpart party.
    Counterparty,
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
    SettleUp,
    SettleDebt,
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
    /// The vault's logical entity name (`core.party`).
    pub entity: &'static str,
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
    /// Which `balance` this kind answers, when it answers one (SPEC §4.3).
    pub balance: Option<&'static str>,
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
    ("open", "needs-action"),
    ("in_progress", "in-process"),
    ("completed", "completed"),
    ("cancelled", "cancelled"),
];
const EVENT_STATUS: &[(&str, &str)] = &[
    ("confirmed", "confirmed"),
    ("tentative", "tentative"),
    ("cancelled", "cancelled"),
];
const DEBT_DIRECTION: &[(&str, &str)] = &[("owes_me", "owed"), ("i_owe", "owe")];
const DEBT_STATUS: &[(&str, &str)] = &[("open", "open"), ("settled", "settled")];
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

/// The CHECK values the model's enums leave out. Empty: every enum the model
/// speaks is the whole of its column's list.
pub const UNEXPOSED: &[Unexposed] = &[];

/// `log kind:` values, stored as the activity kind notation.
pub const LOG_KINDS: &[&str] = &["call", "message", "visit", "coffee"];

/// The starred flag lives in `core_tag` under the flags scheme for every kind.
const STAR: Source = at("core_tag", "concept_id");

use FieldType::{Bool, Date, Enum, Money, Number, Text};

pub static KINDS: &[KindSpec] = &[
    KindSpec {
        kind: Kind::Person,
        name: "person",
        plural: "people",
        entity: "core.party",
        table: "core_party",
        pk: "party_id",
        name_source: at("core_party", "display_name"),
        date: Some(DateSpec {
            label: "last contacted",
            source: at("people_profile", "last_contacted_at"),
        }),
        fields: &[
            field("role", Text, at("people_profile", "role"))
                .edit("people.edit_person")
                .create(),
            field("nickname", Text, at("people_profile", "nickname"))
                .edit("people.edit_person")
                .create(),
            field("met", Text, at("people_profile", "met")).edit("people.edit_person"),
            field("cadence", Number, at("people_profile", "cadence_days"))
                .unit("days")
                .edit("people.set_cadence")
                .create(),
            field("starred", Bool, STAR),
        ],
        links: &[
            Link {
                kind: Kind::Group,
                label: "groups",
                via: Via::Membership,
            },
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
            Link {
                kind: Kind::Photo,
                label: "photos",
                via: Via::About,
            },
            Link {
                kind: Kind::Debt,
                label: "debts",
                via: Via::Counterparty,
            },
        ],
        trash: true,
        container: false,
        balance: Some("me versus that person; positive = they owe me"),
    },
    KindSpec {
        kind: Kind::Group,
        name: "group",
        plural: "groups",
        entity: "tally.group",
        table: "tally_group",
        pk: "group_id",
        name_source: at("social_circle", "name"),
        date: None,
        fields: &[field("currency", Text, at("tally_group", "currency")).create()],
        links: &[Link {
            kind: Kind::Person,
            label: "members",
            via: Via::Membership,
        }],
        trash: false,
        container: true,
        balance: Some(
            "with linked_to a person: that person's net position in the group; positive = the group owes them",
        ),
    },
    KindSpec {
        kind: Kind::Event,
        name: "event",
        plural: "events",
        entity: "core.event",
        table: "core_event",
        pk: "event_id",
        name_source: at("core_event", "summary"),
        date: Some(DateSpec {
            label: "start",
            source: at("core_event", "dtstart"),
        }),
        fields: &[
            field("status", Enum, at("core_event", "status")).values(EVENT_STATUS),
            field("duration", Number, at("core_event", "dtend"))
                .unit("min")
                .edit("schedule.edit_event")
                .create(),
            field("description", Text, at("core_event", "description"))
                .edit("schedule.edit_event")
                .create(),
        ],
        links: &[Link {
            kind: Kind::Person,
            label: "people",
            via: Via::Attendee,
        }],
        trash: true,
        container: false,
        balance: None,
    },
    KindSpec {
        kind: Kind::Task,
        name: "task",
        plural: "tasks",
        entity: "schedule.task",
        table: "schedule_task",
        pk: "task_id",
        name_source: at("schedule_task", "title"),
        date: Some(DateSpec {
            label: "due",
            source: at("schedule_task", "due_at"),
        }),
        fields: &[
            field("status", Enum, at("schedule_task", "status"))
                .values(TASK_STATUS)
                .edit("schedule.set_task_status"),
            field("effort", Number, at("schedule_task", "effort_min"))
                .unit("min")
                .edit("schedule.edit_task")
                .create(),
            field("priority", Number, at("schedule_task", "priority"))
                .unit(PRIORITY_SCALE)
                .edit("schedule.edit_task")
                .create(),
            field("completed", Date, at("schedule_task", "completed_at")),
            field("description", Text, at("schedule_task", "description"))
                .edit("schedule.edit_task")
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
        balance: None,
    },
    KindSpec {
        kind: Kind::Note,
        name: "note",
        plural: "notes",
        entity: "knowledge.note",
        table: "knowledge_note",
        pk: "note_id",
        name_source: at("knowledge_note", "title"),
        date: Some(DateSpec {
            label: "created",
            source: at("knowledge_note", "created_at"),
        }),
        fields: &[
            field("body", Text, at("core_content_text", "body_text"))
                .edit("knowledge.edit_note")
                .create(),
            field("pinned", Bool, at("knowledge_note", "pinned")).edit("knowledge.edit_note"),
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
        balance: None,
    },
    KindSpec {
        kind: Kind::Document,
        name: "document",
        plural: "documents",
        entity: "core.document",
        table: "core_document",
        pk: "document_id",
        name_source: at("core_document", "title"),
        date: Some(DateSpec {
            label: "created",
            source: at("core_document", "created_at"),
        }),
        fields: &[field("starred", Bool, STAR)],
        links: &[Link {
            kind: Kind::Folder,
            label: "folder",
            via: Via::FolderTag,
        }],
        trash: true,
        container: false,
        balance: None,
    },
    KindSpec {
        kind: Kind::Photo,
        name: "photo",
        plural: "photos",
        entity: "media.asset",
        table: "media_asset",
        pk: "asset_id",
        name_source: at("media_asset", "title"),
        date: Some(DateSpec {
            label: "taken",
            source: at("media_asset", "captured_at"),
        }),
        fields: &[field("starred", Bool, STAR)],
        links: &[
            Link {
                kind: Kind::Album,
                label: "albums",
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
        balance: None,
    },
    KindSpec {
        kind: Kind::Album,
        name: "album",
        plural: "albums",
        entity: "core.collection",
        table: "core_collection",
        pk: "collection_id",
        name_source: at("core_collection", "name"),
        date: None,
        fields: &[],
        links: &[Link {
            kind: Kind::Photo,
            label: "photos",
            via: Via::Entry,
        }],
        trash: false,
        container: true,
        balance: None,
    },
    KindSpec {
        kind: Kind::Debt,
        name: "debt",
        plural: "debts",
        entity: "tally.obligation",
        table: "tally_obligation",
        pk: "obligation_id",
        name_source: at("tally_obligation", "reason"),
        date: Some(DateSpec {
            label: "incurred",
            source: at("tally_obligation", "incurred_on"),
        }),
        fields: &[
            field("amount", Money, at("tally_obligation", "amount_minor")).create(),
            field("direction", Enum, at("tally_obligation", "from_party"))
                .values(DEBT_DIRECTION)
                .create(),
            field("status", Enum, at("tally_obligation", "settled_at")).values(DEBT_STATUS),
        ],
        links: &[Link {
            kind: Kind::Person,
            label: "person",
            via: Via::Counterparty,
        }],
        trash: false,
        container: false,
        balance: None,
    },
    KindSpec {
        kind: Kind::LockerItem,
        name: "locker item",
        plural: "locker items",
        entity: "locker.item",
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
            field("starred", Bool, STAR),
        ],
        links: &[],
        trash: true,
        container: false,
        balance: None,
    },
    KindSpec {
        kind: Kind::Notebook,
        name: "notebook",
        plural: "notebooks",
        entity: "core.collection",
        table: "core_collection",
        pk: "collection_id",
        name_source: at("core_collection", "name"),
        date: None,
        fields: &[],
        links: &[Link {
            kind: Kind::Note,
            label: "notes",
            via: Via::Entry,
        }],
        trash: false,
        container: true,
        balance: None,
    },
    KindSpec {
        kind: Kind::Folder,
        name: "folder",
        plural: "folders",
        entity: "core.concept",
        table: "core_concept",
        pk: "concept_id",
        name_source: at("core_concept", "pref_label"),
        date: None,
        fields: &[],
        links: &[Link {
            kind: Kind::Document,
            label: "documents",
            via: Via::FolderTag,
        }],
        trash: false,
        container: true,
        balance: None,
    },
    KindSpec {
        kind: Kind::List,
        name: "list",
        plural: "lists",
        entity: "schedule.project",
        table: "schedule_project",
        pk: "project_id",
        name_source: at("schedule_project", "name"),
        date: None,
        fields: &[field("area", Text, at("schedule_project", "area"))
            .edit("schedule.save_project")
            .create()],
        links: &[Link {
            kind: Kind::Task,
            label: "tasks",
            via: Via::ListColumn,
        }],
        trash: false,
        container: true,
        balance: None,
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
            (Kind::Person, "people.add_person"),
            (Kind::Group, "tally.create_group"),
            (Kind::Event, "schedule.propose_event"),
            (Kind::Task, "schedule.add_task"),
            (Kind::Note, "knowledge.create_note"),
            (Kind::Document, "core.add_document"),
            (Kind::Album, "media.create_album"),
            (Kind::Debt, "people.add_debt"),
            (Kind::LockerItem, "locker.add_item"),
            (Kind::Notebook, "knowledge.create_notebook"),
            (Kind::Folder, "core.create_folder"),
            (Kind::List, "schedule.save_project"),
        ],
    },
    VerbSpec {
        verb: Verb::Edit,
        name: "edit",
        args: "field: value lines (name, or any editable field; body+: or description+: adds text)",
        done: "edited",
        commands: &[
            (Kind::Person, "people.edit_person"),
            (Kind::Group, "tally.rename_group"),
            (Kind::Event, "schedule.edit_event"),
            (Kind::Task, "schedule.edit_task"),
            (Kind::Note, "knowledge.edit_note"),
            (Kind::Document, "core.rename_document"),
            (Kind::Photo, "media.update_asset"),
            (Kind::Album, "media.rename_album"),
            (Kind::LockerItem, "locker.edit_item"),
            (Kind::Notebook, "knowledge.rename_notebook"),
            (Kind::Folder, "core.rename_folder"),
            (Kind::List, "schedule.save_project"),
        ],
    },
    VerbSpec {
        verb: Verb::Reschedule,
        name: "reschedule",
        args: "to: <date expression>",
        done: "rescheduled",
        commands: &[
            (Kind::Task, "schedule.edit_task"),
            (Kind::Event, "schedule.reschedule_event"),
        ],
    },
    VerbSpec {
        verb: Verb::Complete,
        name: "complete",
        args: "",
        done: "completed",
        commands: &[(Kind::Task, "schedule.set_task_status")],
    },
    VerbSpec {
        verb: Verb::Reopen,
        name: "reopen",
        args: "",
        done: "reopened",
        commands: &[(Kind::Task, "schedule.set_task_status")],
    },
    VerbSpec {
        verb: Verb::Cancel,
        name: "cancel",
        args: "",
        done: "cancelled",
        commands: &[(Kind::Event, "schedule.cancel_event")],
    },
    VerbSpec {
        verb: Verb::Delete,
        name: "delete",
        args: "",
        done: "deleted",
        commands: &[
            (Kind::Person, "people.trash_person"),
            (Kind::Group, "tally.delete_group"),
            (Kind::Event, "schedule.delete_event"),
            (Kind::Task, "schedule.delete_task"),
            (Kind::Note, "knowledge.delete_note"),
            (Kind::Document, "core.trash_document"),
            (Kind::Photo, "media.delete_asset"),
            (Kind::Album, "media.delete_album"),
            (Kind::LockerItem, "locker.trash_item"),
            (Kind::Notebook, "knowledge.delete_notebook"),
            (Kind::Folder, "core.delete_folder"),
        ],
    },
    VerbSpec {
        verb: Verb::Restore,
        name: "restore",
        args: "",
        done: "restored",
        commands: &[
            (Kind::Person, "people.restore_person"),
            (Kind::Event, "schedule.restore_event"),
            (Kind::Task, "schedule.restore_task"),
            (Kind::Note, "knowledge.restore_note"),
            (Kind::Document, "core.restore_document"),
            (Kind::Photo, "media.restore_asset"),
            (Kind::LockerItem, "locker.restore_item"),
        ],
    },
    VerbSpec {
        verb: Verb::Star,
        name: "star",
        args: "",
        done: "starred",
        commands: &[
            (Kind::Person, "people.star_person"),
            (Kind::Document, "core.star_document"),
            (Kind::Photo, "media.set_favorite"),
            (Kind::LockerItem, "locker.star_item"),
        ],
    },
    VerbSpec {
        verb: Verb::Unstar,
        name: "unstar",
        args: "",
        done: "unstarred",
        commands: &[
            (Kind::Person, "people.unstar_person"),
            (Kind::Document, "core.unstar_document"),
            (Kind::Photo, "media.set_favorite"),
            (Kind::LockerItem, "locker.unstar_item"),
        ],
    },
    VerbSpec {
        verb: Verb::AddTo,
        name: "add_to",
        args: "to: #n (the group, album, notebook, folder or list)",
        done: "added",
        commands: &[
            (Kind::Person, "tally.add_group_member"),
            (Kind::Photo, "media.add_to_album"),
            (Kind::Note, "knowledge.move_note"),
            (Kind::Document, "core.move_document"),
            (Kind::Task, "schedule.organize_task"),
        ],
    },
    VerbSpec {
        verb: Verb::RemoveFrom,
        name: "remove_from",
        args: "from: #n",
        done: "removed",
        commands: &[
            (Kind::Person, "tally.remove_group_member"),
            (Kind::Photo, "media.remove_from_album"),
            (Kind::Note, "knowledge.move_note"),
            (Kind::Document, "core.move_document"),
            (Kind::Task, "schedule.organize_task"),
        ],
    },
    VerbSpec {
        verb: Verb::Log,
        name: "log",
        args: "kind: call|message|visit|coffee",
        done: "logged",
        commands: &[(Kind::Person, "people.log_interaction")],
    },
    VerbSpec {
        verb: Verb::SettleUp,
        name: "settle_up",
        args: "group: #n (amount = their balance unless given as amount: N)",
        done: "settled up",
        commands: &[(Kind::Person, "tally.settle_up")],
    },
    VerbSpec {
        verb: Verb::SettleDebt,
        name: "settle_debt",
        args: "",
        done: "settled",
        commands: &[(Kind::Debt, "people.settle_debt")],
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

/// Whether a word is a kind of the vault or another word for one (`debt`, `IOU`, `doc`, `pic`,
/// `login`, `contact`, `bill`): a noun that says what a row is, not a word of its name. A closed
/// table over `Kind::parse` (nt15 R4: it is no content word of a name).
#[must_use]
pub fn kind_word(word: &str) -> bool {
    const OTHER: &[&str] = &[
        "iou",
        "ious",
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
        "group",
        "groups",
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

/// Task priority as the vault reads it (RFC 5545): 1 is the highest, 9 the
/// lowest, 0 unset.
pub const PRIORITY_SCALE: &str = "1 highest..9 lowest, 0 none";

/// Value operations (SPEC §4.3).
pub const OPS: &[&str] = &["count", "sum", "min", "max", "balance"];

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
        "core.link_entities",
        "core.unlink_entities",
        "media.add_asset",
        "tally.add_expense",
        "schedule.edit_event",
    ]);
    out.sort_unstable();
    out.dedup();
    out
}
