//! The words the code interprets: kinds, relations, flags, and the one fold
//! that turns a member's label into a key.
//!
//! A word the code interprets is a `CHECK` in `contracts/migrations/001_baseline.sql`
//! and an enum here, held equal by `tests/commitments.rs`; a word the member
//! names is a `concept` row ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//! No app roster appears in either.

use unicode_normalization::UnicodeNormalization;

/// What an entity is. The `entity.kind` CHECK, in the same order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Kind {
    Person,
    Place,
    Event,
    Task,
    Activity,
    Note,
    Document,
    Photo,
    Account,
    Txn,
    Thread,
    Tag,
    Flag,
    Category,
    WorkoutKind,
    ActivityKind,
    Relation,
    Notebook,
    Folder,
    Album,
    List,
    Project,
    Section,
    Area,
    Calendar,
}

impl Kind {
    /// Every kind, in the CHECK's order.
    pub const ALL: [Self; 25] = [
        Self::Person,
        Self::Place,
        Self::Event,
        Self::Task,
        Self::Activity,
        Self::Note,
        Self::Document,
        Self::Photo,
        Self::Account,
        Self::Txn,
        Self::Thread,
        Self::Tag,
        Self::Flag,
        Self::Category,
        Self::WorkoutKind,
        Self::ActivityKind,
        Self::Relation,
        Self::Notebook,
        Self::Folder,
        Self::Album,
        Self::List,
        Self::Project,
        Self::Section,
        Self::Area,
        Self::Calendar,
    ];

    /// The kinds `concept` hosts: the `concept.kind` CHECK.
    pub const CONCEPTS: [Self; 6] = [
        Self::Tag,
        Self::Flag,
        Self::Category,
        Self::WorkoutKind,
        Self::ActivityKind,
        Self::Relation,
    ];

    /// The kinds `container` hosts: the `container.kind` CHECK.
    pub const CONTAINERS: [Self; 8] = [
        Self::Notebook,
        Self::Folder,
        Self::Album,
        Self::List,
        Self::Project,
        Self::Section,
        Self::Area,
        Self::Calendar,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Place => "place",
            Self::Event => "event",
            Self::Task => "task",
            Self::Activity => "activity",
            Self::Note => "note",
            Self::Document => "document",
            Self::Photo => "photo",
            Self::Account => "account",
            Self::Txn => "txn",
            Self::Thread => "thread",
            Self::Tag => "tag",
            Self::Flag => "flag",
            Self::Category => "category",
            Self::WorkoutKind => "workout_kind",
            Self::ActivityKind => "activity_kind",
            Self::Relation => "relation",
            Self::Notebook => "notebook",
            Self::Folder => "folder",
            Self::Album => "album",
            Self::List => "list",
            Self::Project => "project",
            Self::Section => "section",
            Self::Area => "area",
            Self::Calendar => "calendar",
        }
    }

    #[must_use]
    pub fn parse(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == word)
    }

    #[must_use]
    pub fn is_concept(self) -> bool {
        Self::CONCEPTS.contains(&self)
    }

    #[must_use]
    pub fn is_container(self) -> bool {
        Self::CONTAINERS.contains(&self)
    }

    /// The table whose row is this kind's own: the kind's name, or `concept`
    /// or `container` for the kinds those two tables host.
    #[must_use]
    pub fn host(self) -> &'static str {
        if self.is_concept() {
            "concept"
        } else if self.is_container() {
            "container"
        } else {
            self.as_str()
        }
    }

    /// Whether a member's delete of this kind goes through the trash. The rest
    /// are deleted outright: a tag, a category or a calendar is not something
    /// a member wants back after thirty days, and a chat is deleted when the member says so
    /// (R-CHAT-8).
    #[must_use]
    pub const fn has_trash(self) -> bool {
        !matches!(
            self,
            Self::Tag
                | Self::Flag
                | Self::Category
                | Self::WorkoutKind
                | Self::ActivityKind
                | Self::Relation
                | Self::Calendar
                | Self::Thread
        )
    }

    /// A short noun for a sentence about the kind ("a workout kind").
    #[must_use]
    pub fn noun(self) -> String {
        self.as_str().replace('_', " ")
    }
}

/// How two entities are joined. The `edge.rel` CHECK, in the same order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Rel {
    Contains,
    Tagged,
    About,
    Links,
    Attached,
    Attendee,
    With,
    Related,
}

impl Rel {
    pub const ALL: [Self; 8] = [
        Self::Contains,
        Self::Tagged,
        Self::About,
        Self::Links,
        Self::Attached,
        Self::Attendee,
        Self::With,
        Self::Related,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Contains => "contains",
            Self::Tagged => "tagged",
            Self::About => "about",
            Self::Links => "links",
            Self::Attached => "attached",
            Self::Attendee => "attendee",
            Self::With => "with",
            Self::Related => "related",
        }
    }

    #[must_use]
    pub fn parse(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|rel| rel.as_str() == word)
    }

    /// Whether the note at the edge's start is the one whose text the edge is
    /// part of (`about` and `links`): adding or removing one touches the note.
    #[must_use]
    pub const fn belongs_to_note(self) -> bool {
        matches!(self, Self::About | Self::Links)
    }
}

/// The three flags the vault is founded with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flag {
    Starred,
    Pinned,
    Archived,
}

impl Flag {
    pub const ALL: [Self; 3] = [Self::Starred, Self::Pinned, Self::Archived];

    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::Starred => "starred",
            Self::Pinned => "pinned",
            Self::Archived => "archived",
        }
    }

    /// The seeded entity id, `flag:<key>`.
    #[must_use]
    pub fn id(self) -> String {
        concept_id(Kind::Flag, self.key())
    }

    #[must_use]
    pub fn parse(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|flag| flag.key() == word)
    }
}

/// The id of a seeded concept, or of a member's tag: `<kind>:<key>`.
#[must_use]
pub fn concept_id(kind: Kind, key: &str) -> String {
    format!("{}:{key}", kind.as_str())
}

/// The id of the calendar every vault is founded with.
pub const DEFAULT_CALENDAR_ID: &str = "calendar:default";

/// A member's label as a key: NFKC, lowercased, whitespace collapsed.
///
/// The one function. A tag named "Road  Trip" and one named "road trip" are
/// the same tag, and `concept(kind, key)` is unique on this.
#[must_use]
pub fn fold_label(label: &str) -> String {
    let folded: String = label.nfkc().collect::<String>().to_lowercase();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_folds_to_one_key() {
        assert_eq!(fold_label("  Road \t Trip "), "road trip");
        assert_eq!(fold_label("ROAD TRIP"), fold_label("road   trip"));
        // NFKC: a full-width letter and a ligature fold to their plain forms.
        assert_eq!(fold_label("ＡＢＣ"), "abc");
        assert_eq!(fold_label("ﬁle"), "file");
    }

    #[test]
    fn every_kind_round_trips_and_has_one_host() {
        for kind in Kind::ALL {
            assert_eq!(Kind::parse(kind.as_str()), Some(kind));
            assert!(!(kind.is_concept() && kind.is_container()));
            assert!(["concept", "container", kind.as_str()].contains(&kind.host()));
        }
        for rel in Rel::ALL {
            assert_eq!(Rel::parse(rel.as_str()), Some(rel));
        }
    }
}
