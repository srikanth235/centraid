//! The words the code interprets: kinds, relations, flags, and the one fold
//! that turns a member's label into a key.
//!
//! A word the code interprets is a `CHECK` in `contracts/migrations/001_baseline.sql`
//! and an enum here, held equal by `tests/commitments.rs`; a word the member
//! names is a `concept` row ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//! No app roster appears in either.

use unicode_normalization::UnicodeNormalization;

/// Which host table holds a kind's own row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KindGroup {
    /// Its own table, named by [`KindSpec::name`].
    Own,
    /// Hosted in `concept`.
    Concept,
    /// Hosted in `container`.
    Container,
}

/// Declarative ontology metadata for one entity [`Kind`].
///
/// Stated ONCE in [`KIND_SPECS`]; [`Kind::ALL`], [`Kind::LINK_ENDS`],
/// [`Kind::MEMBER_ITEMS`], [`Kind::CONCEPTS`], [`Kind::CONTAINERS`],
/// [`Kind::SEARCHABLE`], [`HOST_TABLES`], and every [`Kind`] predicate are
/// derived from this single table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KindSpec {
    pub kind: Kind,
    pub name: &'static str,
    pub group: KindGroup,
    /// Whether a member can add/import an item of this kind (`first_item`).
    pub member_item: bool,
    /// Whether a general link (`links`) may end at this kind.
    pub link_end: bool,
    /// Whether a member's delete goes through the trash rather than purging outright.
    pub has_trash: bool,
    /// Whether [`crate::index::text::text_of`] indexes this kind as its own row in `search`.
    pub searchable: bool,
}

impl KindSpec {
    #[must_use]
    pub const fn host_table(&self) -> &'static str {
        match self.group {
            KindGroup::Own => self.name,
            KindGroup::Concept => "concept",
            KindGroup::Container => "container",
        }
    }
}

/// What an entity is: the rows of the `entity_kind` lookup, in the same order (`tests/lookups.rs`
/// holds the two equal, attribute by attribute).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(usize)]
pub enum Kind {
    Person,
    Place,
    Event,
    Task,
    Workout,
    Touch,
    Reading,
    Note,
    Document,
    Photo,
    Account,
    Txn,
    Thread,
    LockerItem,
    Tag,
    Category,
    WorkoutKind,
    TouchKind,
    Relation,
    Notebook,
    Folder,
    Album,
    List,
    TaskList,
    Calendar,
}

const fn spec(
    kind: Kind,
    name: &'static str,
    group: KindGroup,
    member_item: bool,
    link_end: bool,
    has_trash: bool,
    searchable: bool,
) -> KindSpec {
    KindSpec {
        kind,
        name,
        group,
        member_item,
        link_end,
        has_trash,
        searchable,
    }
}

/// The single declarative registry for all 25 entity kinds, in `entity_kind` order.
/// `link_end` is `entity_kind.linkable`: a kind a hand-made link, a `[[title]]` and a wildcard edge
/// may end at (a reading, a chat, a container and a label are not).
pub const KIND_SPECS: [KindSpec; 25] = [
    // Own host tables (items & threads).
    spec(
        Kind::Person,
        "person",
        KindGroup::Own,
        true,
        true,
        true,
        true,
    ),
    spec(Kind::Place, "place", KindGroup::Own, true, true, true, true),
    spec(Kind::Event, "event", KindGroup::Own, true, true, true, true),
    spec(Kind::Task, "task", KindGroup::Own, true, true, true, true),
    spec(
        Kind::Workout,
        "workout",
        KindGroup::Own,
        true,
        true,
        true,
        true,
    ),
    spec(Kind::Touch, "touch", KindGroup::Own, true, true, true, true),
    // A reading is an item with a trash and nothing else (F1): not a link end, not in search.
    spec(
        Kind::Reading,
        "reading",
        KindGroup::Own,
        true,
        false,
        true,
        false,
    ),
    spec(Kind::Note, "note", KindGroup::Own, true, true, true, true),
    spec(
        Kind::Document,
        "document",
        KindGroup::Own,
        true,
        true,
        true,
        true,
    ),
    spec(Kind::Photo, "photo", KindGroup::Own, true, true, true, true),
    spec(
        Kind::Account,
        "account",
        KindGroup::Own,
        true,
        true,
        true,
        false,
    ),
    spec(Kind::Txn, "txn", KindGroup::Own, true, true, true, true),
    // A chat has the same trash as every kind (L5).
    spec(
        Kind::Thread,
        "thread",
        KindGroup::Own,
        true,
        false,
        true,
        true,
    ),
    // A Locker item is an item like any other (K1): a link end.
    spec(
        Kind::LockerItem,
        "locker_item",
        KindGroup::Own,
        true,
        true,
        true,
        true,
    ),
    // Hosted in `concept`.
    spec(
        Kind::Tag,
        "tag",
        KindGroup::Concept,
        false,
        false,
        false,
        false,
    ),
    spec(
        Kind::Category,
        "category",
        KindGroup::Concept,
        false,
        false,
        false,
        false,
    ),
    spec(
        Kind::WorkoutKind,
        "workout_kind",
        KindGroup::Concept,
        false,
        false,
        false,
        false,
    ),
    spec(
        Kind::TouchKind,
        "touch_kind",
        KindGroup::Concept,
        false,
        false,
        false,
        false,
    ),
    spec(
        Kind::Relation,
        "relation",
        KindGroup::Concept,
        false,
        false,
        false,
        false,
    ),
    // Hosted in `container`.
    spec(
        Kind::Notebook,
        "notebook",
        KindGroup::Container,
        true,
        false,
        true,
        true,
    ),
    spec(
        Kind::Folder,
        "folder",
        KindGroup::Container,
        true,
        false,
        true,
        true,
    ),
    spec(
        Kind::Album,
        "album",
        KindGroup::Container,
        true,
        false,
        true,
        true,
    ),
    spec(
        Kind::List,
        "list",
        KindGroup::Container,
        true,
        false,
        true,
        false,
    ),
    spec(
        Kind::TaskList,
        "task_list",
        KindGroup::Container,
        true,
        false,
        true,
        true,
    ),
    spec(
        Kind::Calendar,
        "calendar",
        KindGroup::Container,
        true,
        false,
        true,
        false,
    ),
];

#[derive(Clone, Copy)]
enum KindFilter {
    All,
    LinkEnd,
    MemberItem,
    Concept,
    Container,
    Searchable,
}

impl KindFilter {
    const fn matches(self, s: &KindSpec) -> bool {
        match self {
            Self::All => true,
            Self::LinkEnd => s.link_end,
            Self::MemberItem => s.member_item,
            Self::Concept => matches!(s.group, KindGroup::Concept),
            Self::Container => matches!(s.group, KindGroup::Container),
            Self::Searchable => s.searchable,
        }
    }
}

const fn collect_kinds<const N: usize>(filter: KindFilter) -> [Kind; N] {
    let mut out = [Kind::Person; N];
    let mut write = 0;
    let mut i = 0;
    while i < KIND_SPECS.len() {
        if filter.matches(&KIND_SPECS[i]) {
            out[write] = KIND_SPECS[i].kind;
            write += 1;
        }
        i += 1;
    }
    assert!(write == N, "KIND_SPECS filter count mismatch");
    out
}

const fn const_str_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

const fn collect_host_tables() -> [&'static str; 16] {
    let mut out = [""; 16];
    let mut write = 0;
    let mut i = 0;
    while i < KIND_SPECS.len() {
        let table = KIND_SPECS[i].host_table();
        let mut seen = false;
        let mut j = 0;
        while j < write {
            if const_str_eq(out[j], table) {
                seen = true;
                break;
            }
            j += 1;
        }
        if !seen {
            out[write] = table;
            write += 1;
        }
        i += 1;
    }
    assert!(write == 16, "distinct host table count mismatch");
    out
}

/// The 16 distinct host tables across [`KIND_SPECS`], matching `history::shape::TABLES`'s `Role::Host` entries.
pub const HOST_TABLES: [&str; 16] = collect_host_tables();

impl Kind {
    /// Every kind, in the CHECK's order.
    pub const ALL: [Self; 25] = collect_kinds(KindFilter::All);

    /// The kinds a general link (`links`) may END at: the items of the nine apps and the three
    /// things items are about (#1185). A Locker item is never here: it may start a link and can
    /// never be the target of one (owner ruling D11).
    pub const LINK_ENDS: [Self; 12] = collect_kinds(KindFilter::LinkEnd);

    /// THE KINDS A MEMBER CAN ADD OR IMPORT, one definition for "the member holds something": every
    /// app's items and the containers they make (a workout, a place, an assistant thread, a notebook,
    /// folder, album, list, task list or calendar included). Not the concepts (a tag, a flag, a
    /// category, a kind of workout or activity, a relation). `person` and `calendar` are here, but the founding person and the default Calendar the
    /// vault is founded with never count (see [`crate::first_item`]).
    pub const MEMBER_ITEMS: [Self; 20] = collect_kinds(KindFilter::MemberItem);

    /// The kinds `concept` hosts: the `concept.kind` CHECK.
    pub const CONCEPTS: [Self; 5] = collect_kinds(KindFilter::Concept);

    /// The kinds `container` hosts: the `container.kind` CHECK.
    pub const CONTAINERS: [Self; 6] = collect_kinds(KindFilter::Container);

    /// The kinds [`crate::index::text::text_of`] indexes directly in `search`.
    pub const SEARCHABLE: [Self; 16] = collect_kinds(KindFilter::Searchable);

    /// This kind's declarative [`KindSpec`].
    #[must_use]
    pub const fn spec(self) -> &'static KindSpec {
        &KIND_SPECS[self as usize]
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        self.spec().name
    }

    #[must_use]
    pub fn parse(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == word)
    }

    /// Whether a general link (`links`) may END at this kind ([`Self::LINK_ENDS`]).
    #[must_use]
    pub const fn is_link_end(self) -> bool {
        self.spec().link_end
    }

    /// Whether a general link may START at this kind: a link has no direction, so the same ends (K1).
    #[must_use]
    pub const fn is_link_start(self) -> bool {
        self.is_link_end()
    }

    #[must_use]
    pub const fn is_concept(self) -> bool {
        matches!(self.spec().group, KindGroup::Concept)
    }

    #[must_use]
    pub const fn is_container(self) -> bool {
        matches!(self.spec().group, KindGroup::Container)
    }

    /// The table whose row is this kind's own: the kind's name, or `concept`
    /// or `container` for the kinds those two tables host.
    #[must_use]
    pub const fn host(self) -> &'static str {
        self.spec().host_table()
    }

    /// Whether a member's delete of this kind goes through the trash. The rest
    /// are deleted outright: a tag or a category is not something
    /// a member wants back after thirty days (a calendar is a holder: it takes its events to the
    /// trash with it and they come back with it), and a chat is deleted when the member says so
    /// (R-CHAT-8).
    #[must_use]
    pub const fn has_trash(self) -> bool {
        self.spec().has_trash
    }

    /// A short noun for a sentence about the kind ("a workout kind").
    #[must_use]
    pub fn noun(self) -> String {
        self.as_str().replace('_', " ")
    }
}

/// How two entities are joined by an `edge`: the relations `edge_shape` holds. A hand-made link is
/// the `link` table (A4), a note's `[[title]]` a `mention` (A5), an invitee an `event_guest` (A6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Rel {
    Contains,
    Tagged,
    About,
    Attached,
    With,
    Related,
    Depicts,
}

impl Rel {
    pub const ALL: [Self; 7] = [
        Self::Contains,
        Self::Tagged,
        Self::About,
        Self::Attached,
        Self::With,
        Self::Related,
        Self::Depicts,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Contains => "contains",
            Self::Tagged => "tagged",
            Self::About => "about",
            Self::Attached => "attached",
            Self::With => "with",
            Self::Related => "related",
            Self::Depicts => "depicts",
        }
    }

    #[must_use]
    pub fn parse(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|rel| rel.as_str() == word)
    }

    /// Whether the note at the edge's start is the one whose text the edge is part of (`about`):
    /// adding or removing one touches the note.
    #[must_use]
    pub const fn belongs_to_note(self) -> bool {
        matches!(self, Self::About)
    }
}

/// The id of a SEEDED concept: `<kind>:<key>`. A concept the member makes has a minted id and is
/// found by `concept(kind, key)`, never by this.
#[must_use]
pub fn concept_id(kind: Kind, key: &str) -> String {
    format!("{}:{key}", kind.as_str())
}

/// Whether `id` is a canonical lowercase UUIDv7: the id grammar of every row a command makes
/// (`entity.id`'s CHECK, A17). A seeded `kind:key` slug is founding's and is not one.
#[must_use]
pub fn is_minted_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, byte)| match at {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => *byte == b'7',
            19 => matches!(byte, b'8'..=b'b'),
            _ => matches!(byte, b'0'..=b'9' | b'a'..=b'f'),
        })
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

    #[test]
    fn kind_specs_align_with_discriminants_and_history_hosts() {
        for (idx, spec) in KIND_SPECS.iter().enumerate() {
            assert_eq!(spec.kind as usize, idx, "spec order drifted at {idx}");
            assert_eq!(spec.kind.spec(), spec);
        }
        let history_hosts: Vec<&str> = crate::history::TABLES
            .iter()
            .filter_map(|(table, role)| {
                matches!(role, crate::history::Role::Host).then_some(*table)
            })
            .collect();
        assert_eq!(history_hosts, HOST_TABLES);
    }
}
