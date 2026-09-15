//! THE STATEMENTS, AND WHAT EVERY QUERY SHARES.
//!
//! People's seven queries are `people` (the roster), `person`, `dashboard`,
//! `journal`, `search`, `trash` and `history`. `queries/_shared.ts` and
//! `queries/person-contacts.ts` are helpers beside the handlers rather than
//! queries of their own — the dispatcher resolves `queries/<name>.ts` and never
//! scans the directory (`person-contacts.ts:17`-`:18`).
//!
//! ## The reads that DISCOVER rows, and everything that decorates them
//!
//! | Read | What it is |
//! |---|---|
//! | [`roster_profiles_statement`] | **the roster's window is a PAGE** of `people_profile`, newest-created first, caller-sized. The whole app's other reads are `IN`-bounded by what it returned |
//! | [`taxonomy_concepts_statement`] + [`taxonomy_schemes_statement`] | a vault's vocabulary, which is what bounds lists, the star, relations and the journal marker. Owner-curated and small, so the walk is honest |
//! | `ctx.vault.search` | `search`'s three FTS reads, which are `crates/search`'s and not [`PageQuery`] values — the hits arrive in RANK ORDER and the fold keeps it |
//!
//! ## Three windows, three different ceilings, and one of them is a fold
//!
//! * `RECENT_ACTIVITY_ROWS` 30 — the dashboard's recent rail (`dashboard.ts:37`).
//! * [`HISTORY_ROWS`] 100 — "the rail shows a hundred; the read is the rail"
//!   (`history.ts:1`).
//! * [`TRASH_ROWS`] 500 — the trash shelf (`trash.ts:15`).
//! * [`ROSTER_MAX`] 10,000 — the roster, **the widest window of any app**, and
//!   [`DASHBOARD_WINDOW`] 9,999 for the dashboard, which declares no window at
//!   all in its input schema and hard-codes one (`dashboard.ts:103`).
//!
//! The dashboard's is the one that is a FOLD rather than a list: `counts.all`
//! is `profileRows.length` over that window. v0 asks for it as ONE page and
//! takes `.rows`, and `MAX_PAGE_ROWS` clamps a page to 500 — so **a vault with
//! more than 500 live people reports `all: 500`**, and `reconnect`, `upcoming`
//! and `starred` are folded over the same 500 (finding PE-F3, the
//! D-1020-D3-12 class). The port walks the stated window with
//! [`centraid_apps_kit::read_window`] and reports whether it filled.
//!
//! ## `people.limit` is 20–10,000 and the handler clamps to 9,999
//!
//! `ROSTER_MAX = 9_999` with the comment *"Gateway read max is 10_000;
//! look-ahead needs one spare row"* (`people.ts:88`-`:89`) — a look-ahead the
//! same file removed when the probe became the host's, four lines below
//! (`:100`-`:104`: "It used to ask for `window + 1` and slice the extra off").
//! So a caller passing the schema's own maximum is silently given 9,999 and
//! told `window: 9999`. The port honours the declared 10,000 (D-1020-PE4), and
//! **nothing in the manifest explains why the number is 10,000 at all** —
//! every other app's widest window is 2,000.
//!
//! ## The one nullable sort column (D-1020-PE5)
//!
//! Of the thirty statements below, exactly one orders by a column the DDL
//! declares without `NOT NULL`: [`trash_profiles_statement`], on
//! `people_profile.deleted_at`. Every other sort key is either a `STRICT`
//! table's primary key (implicitly `NOT NULL`) or a declared-`NOT NULL`
//! instant — `created_at`, `tagged_at`, `recorded_at`, `started_at`. See that
//! statement's own note for what the port does about it.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::{FanOutBound, PageDoor, in_list, read_pages};
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::Denial;

// ---------------------------------------------------------------------------
// Schemes, notations and the polymorphic type names.
// ---------------------------------------------------------------------------

/// The flags scheme, which is where the canonical favourite star lives (#274).
pub const FLAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/flags";
/// The lists scheme — People's lists, the same mechanism Docs' folders use.
pub const LIST_SCHEME_URI: &str = "https://centraid.dev/schemes/lists";
/// The relations scheme. **A `urn:`, and the spelling is v0's own**
/// (`concept-scheme-kit.ts:21`); it is never interpolated into condition SQL,
/// so the colon-literal trap does not apply to it.
pub const RELATIONS_SCHEME_URI: &str = "urn:duaility:relations";
/// The People-journal scheme: the marker concept a journal note is tagged with.
pub const JOURNAL_SCHEME_URI: &str = "https://centraid.dev/schemes/people-journal";
pub const STARRED_NOTATION: &str = "starred";
pub const JOURNAL_ENTRY_NOTATION: &str = "entry";
/// The notation a gift task's relation carries.
pub const GIFT_RELATION_NOTATION: &str = "gift-for";
/// A relation concept People draws is one whose notation starts here.
pub const PEOPLE_RELATION_PREFIX: &str = "people-";
/// The relation a concept with no readable notation falls back to.
pub const DEFAULT_RELATION_NOTATION: &str = "people-related";

/// The polymorphic type names People reads. `core_tag`, `core_link` and
/// `knowledge_annotation` are all `(type, id)` pairs into the entity supertype.
pub const PARTY_TARGET_TYPE: &str = "core.party";
pub const ACTIVITY_TARGET_TYPE: &str = "core.activity";
pub const TASK_TARGET_TYPE: &str = "schedule.task";
pub const NOTE_TARGET_TYPE: &str = "knowledge.note";
/// The entity type People's own revisions are recorded under, and the value the
/// manifest's `core.entity_revision` scope row-filters on.
pub const PERSON_ENTITY_TYPE: &str = "people.person";

// ---------------------------------------------------------------------------
// Windows.
// ---------------------------------------------------------------------------

/// The roster's declared window, from the manifest's input schema.
pub const ROSTER_MIN: usize = 20;
pub const ROSTER_MAX: usize = 10_000;
/// v0's own clamp, one below the declared maximum. Named so the divergence is
/// a stated fact rather than an off-by-one somebody has to re-derive.
pub const V0_ROSTER_MAX: usize = 9_999;
/// The dashboard's window, which its input schema does not declare at all.
pub const DASHBOARD_WINDOW: usize = 9_999;
/// The dashboard's recent-touch rail (`dashboard.ts:37`).
pub const RECENT_ACTIVITY_ROWS: usize = 30;
/// "The rail shows a hundred; the read is the rail" (`history.ts:1`).
pub const HISTORY_ROWS: usize = 100;
/// The trash shelf's own size (`trash.ts:15`).
pub const TRASH_ROWS: usize = 500;
/// Each of `search`'s three FTS reads asks the index for this many matches
/// (`search.ts:69`-`:83`), so a term can rank up to 150 parties before the
/// profile filter.
pub const SEARCH_LIMIT: usize = 50;

/// A join per windowed person: 500 × 8 = 4,000 rows, the kit's default.
pub const PERSON_JOIN_BOUND: FanOutBound = FanOutBound::new(500, 8);

/// `(party, concept)` pairs over a roster window: a person carries at most one
/// list tag, maybe a star and any number of free labels, so 500 × 32 = 16,000
/// rows, stated.
pub const PARTY_PAIR_BOUND: FanOutBound = FanOutBound::new(500, 32);

/// The roster's own decorations — parties, important dates, bindings — over a
/// window that may be 10,000 people wide. 500 × 64 = 32,000 rows.
///
/// **Stated because the roster's window is five times wider than any other
/// app's**: at the declared 10,000 the parties read alone is 10,000 rows, and a
/// bound of 4,000 would refuse a roster the manifest says is legal.
pub const ROSTER_FAN_OUT: FanOutBound = FanOutBound::new(500, 64);

// ---------------------------------------------------------------------------
// The taxonomy pair.
// ---------------------------------------------------------------------------

/// `_shared/taxonomy.concepts` — a vault's vocabulary.
///
/// `broader_concept_id` is in the projection because the pair is shared with
/// Docs and Notes and two of their readers walk it (R-1020-35, finding 1 of
/// slot 4b). People itself has no concept tree, and selecting a column it does
/// not read is the price of ONE taxonomy read across three apps.
#[must_use]
pub fn taxonomy_concepts_statement() -> PageQuery {
    PageQuery::new(
        "_shared/taxonomy.concepts",
        "concept_id, scheme_id, pref_label, notation, broader_concept_id",
        "core_concept",
        PageOrder::asc("concept_id", "concept_id"),
    )
}

/// `_shared/taxonomy.schemes` — the other half of the pair. Two reads, not one:
/// they are different tables, and each is walked to the end of itself.
#[must_use]
pub fn taxonomy_schemes_statement() -> PageQuery {
    PageQuery::new(
        "_shared/taxonomy.schemes",
        "scheme_id, uri, title",
        "core_concept_scheme",
        PageOrder::asc("scheme_id", "scheme_id"),
    )
}

/// A vault's vocabulary, read once per query and folded many times.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Taxonomy {
    pub concepts: Vec<Row>,
    pub schemes: Vec<Row>,
}

impl Taxonomy {
    /// The scheme id of a URI, or `None`.
    #[must_use]
    pub fn scheme_id(&self, uri: &str) -> Option<String> {
        self.schemes
            .iter()
            .find(|row| text_of(row, "uri").as_deref() == Some(uri))
            .and_then(|row| text_of(row, "scheme_id"))
    }

    /// Every concept in a scheme, in the read's own order.
    #[must_use]
    pub fn concepts_in(&self, uri: &str) -> Vec<&Row> {
        let Some(scheme_id) = self.scheme_id(uri) else {
            return Vec::new();
        };
        self.concepts
            .iter()
            .filter(|row| text_of(row, "scheme_id").as_deref() == Some(scheme_id.as_str()))
            .collect()
    }

    /// One concept of a scheme, by notation.
    #[must_use]
    pub fn concept_in(&self, uri: &str, notation: &str) -> Option<&Row> {
        self.concepts_in(uri)
            .into_iter()
            .find(|row| text_of(row, "notation").as_deref() == Some(notation))
    }

    /// The concept id of the favourite star, or `None` where the vault has no
    /// flags scheme yet. `None` is "nobody is starred", which is honest: the
    /// star is a tag and a vault with no star concept carries no such tag.
    #[must_use]
    pub fn starred_concept_id(&self) -> Option<String> {
        self.concept_in(FLAGS_SCHEME_URI, STARRED_NOTATION)
            .and_then(|row| text_of(row, "concept_id"))
    }

    /// The lists, as the roster ships them: `{list_id, name}` sorted by name.
    ///
    /// **`localeCompare`, not byte order** in v0 (`people.ts:131`-`:133`). The
    /// port sorts by the same key and the divergence for non-ASCII names is
    /// the one named in apps seam 4; the parity fixture's list names are ASCII,
    /// where the two orders agree.
    #[must_use]
    pub fn lists(&self) -> Vec<ListEntry> {
        let mut lists: Vec<ListEntry> = self
            .concepts_in(LIST_SCHEME_URI)
            .into_iter()
            .filter_map(|row| {
                Some(ListEntry {
                    list_id: text_of(row, "concept_id")?,
                    name: text_of(row, "pref_label").unwrap_or_default(),
                })
            })
            .collect();
        lists.sort_by(|left, right| left.name.cmp(&right.name));
        lists
    }

    /// The concept ids of every list, for "is this tag a list tag".
    #[must_use]
    pub fn list_concept_ids(&self) -> BTreeSet<String> {
        self.concepts_in(LIST_SCHEME_URI)
            .into_iter()
            .filter_map(|row| text_of(row, "concept_id"))
            .collect()
    }

    /// A concept's `notation`, by id.
    #[must_use]
    pub fn notation_of(&self, concept_id: &str) -> Option<String> {
        self.concepts
            .iter()
            .find(|row| text_of(row, "concept_id").as_deref() == Some(concept_id))
            .and_then(|row| text_of(row, "notation"))
    }

    /// A concept's `pref_label`, by id.
    #[must_use]
    pub fn label_of(&self, concept_id: &str) -> Option<String> {
        self.concepts
            .iter()
            .find(|row| text_of(row, "concept_id").as_deref() == Some(concept_id))
            .and_then(|row| text_of(row, "pref_label"))
    }
}

/// One of the owner's lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListEntry {
    pub list_id: String,
    pub name: String,
}

/// Read the taxonomy pair.
pub fn read_taxonomy(door: &dyn PageDoor) -> KitResult<Taxonomy> {
    Ok(Taxonomy {
        concepts: read_pages(door, &taxonomy_concepts_statement(), PARTY_PAIR_BOUND)?,
        schemes: read_pages(door, &taxonomy_schemes_statement(), PERSON_JOIN_BOUND)?,
    })
}

// ---------------------------------------------------------------------------
// The roster's reads.
// ---------------------------------------------------------------------------

/// `people.roster.profiles` — THE ROSTER'S WINDOW, as a page.
///
/// Newest-created first by `created_at`, which is `NOT NULL` on
/// `people_profile`, so the page is continuable and `truncated` is its cursor.
#[must_use]
pub fn roster_profiles_statement() -> PageQuery {
    PageQuery::new(
        "people.roster.profiles",
        "party_id, created_at, cadence_days, role, avatar_color, last_contacted_at, deleted_at",
        "people_profile",
        PageOrder::desc("created_at", "party_id"),
    )
    .filter("deleted_at IS NULL", Vec::new())
}

/// `people.dashboard.profiles` — the same window under a different name, so the
/// two plans are told apart in `app-query-plans.snapshot.md`.
#[must_use]
pub fn dashboard_profiles_statement() -> PageQuery {
    PageQuery::new(
        "people.dashboard.profiles",
        "party_id, created_at, last_contacted_at, cadence_days, avatar_color, role, deleted_at",
        "people_profile",
        PageOrder::desc("created_at", "party_id"),
    )
    .filter("deleted_at IS NULL", Vec::new())
}

/// The parties a window of profiles names. One statement, four call sites — the
/// name is the caller's so the plan snapshot keeps them apart.
pub fn parties_statement(name: &str, party_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("party_id", party_ids)?;
    Ok(PageQuery::new(
        name,
        "party_id, display_name, kind",
        "core_party",
        PageOrder::asc("party_id", "party_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// Every tag on a window of parties, so the list and the star are two readings
/// of one read.
pub fn party_tags_statement(name: &str, party_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("target_id", party_ids)?;
    let mut bind = vec![PageBindValue::Text(PARTY_TARGET_TYPE.to_owned())];
    bind.extend(fragment.bind);
    Ok(PageQuery::new(
        name,
        "tag_id, target_type, target_id, concept_id",
        "core_tag",
        PageOrder::asc("tag_id", "tag_id"),
    )
    .filter(&format!("target_type = ? AND {}", fragment.sql), bind))
}

/// The live important dates of a window of parties.
pub fn important_dates_statement(name: &str, party_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("party_id", party_ids)?;
    Ok(PageQuery::new(
        name,
        "date_id, party_id, label, month_day, reminder_on",
        "people_important_date",
        PageOrder::asc("date_id", "date_id"),
    )
    .filter(
        &format!("{} AND deleted_at IS NULL", fragment.sql),
        fragment.bind,
    ))
}

/// `people.shared.liveBindings` — THE SHARE PLANE, for a whole roster.
///
/// `revoked_at IS NULL` is the live half: a revoked binding is history, and a
/// person whose only binding was revoked is **not** linked. The read denies
/// independently of everything above it (see [`crate::ReadState`]).
pub fn live_bindings_statement(party_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("party_id", party_ids)?;
    Ok(PageQuery::new(
        "people.shared.liveBindings",
        "binding_id, party_id, vault_id, linked_at",
        "share_party_vault_binding",
        PageOrder::asc("binding_id", "binding_id"),
    )
    .filter(
        &format!("{} AND revoked_at IS NULL", fragment.sql),
        fragment.bind,
    ))
}

/// `people.shared.personLinks` — the same plane for one person.
#[must_use]
pub fn person_links_statement(party_id: &str) -> PageQuery {
    PageQuery::new(
        "people.shared.personLinks",
        "binding_id, party_id, vault_id, linked_at",
        "share_party_vault_binding",
        PageOrder::asc("binding_id", "binding_id"),
    )
    .filter(
        "party_id = ? AND revoked_at IS NULL",
        vec![PageBindValue::Text(party_id.to_owned())],
    )
}

// ---------------------------------------------------------------------------
// The trash shelf.
// ---------------------------------------------------------------------------

/// `people.trash.profiles` — THE ONE NULLABLE SORT COLUMN (D-1020-PE5).
///
/// `people_profile.deleted_at` is declared `TEXT` with no `NOT NULL`, so the
/// kit's door refuses to CONTINUE a page over it (`KitError::NullableSortKey`,
/// D-1020-D3-10): SQLite compares a row value with a NULL operand to NULL
/// rather than to true, so a continued page would silently drop rows.
///
/// **The predicate makes the column non-null and the door cannot see that.**
/// `deleted_at IS NOT NULL` is the shelf's own filter, so no row this statement
/// can return has a NULL sort key — but the check reads the DDL, not the
/// `where`, and "cannot prove" is deliberately not "is fine" for a check whose
/// failure mode is a short shelf.
///
/// What the port does, and why it is safe rather than lucky-looking:
/// [`TRASH_ROWS`] is 500, which is exactly `MAX_PAGE_ROWS`, so the shelf is one
/// page and is never continued. A window of 501 would refuse, and
/// `the_trash_shelf_refuses_a_window_it_cannot_continue` is that red. The
/// adopted order for a People sort column that genuinely must be continued
/// while nullable is **nulls last, then by primary key** (lane V's owner
/// hand-off 1); the kit change that would let this statement continue — reading
/// an `IS NOT NULL` conjunct off the `where` — is filed as a hand-off with its
/// red rather than made here, because the kit has no wave 4 owner.
#[must_use]
pub fn trash_profiles_statement() -> PageQuery {
    PageQuery::new(
        "people.trash.profiles",
        "party_id, role, deleted_at, purge_at",
        "people_profile",
        PageOrder::desc("deleted_at", "party_id"),
    )
    .filter("deleted_at IS NOT NULL", Vec::new())
}

// ---------------------------------------------------------------------------
// The person sheet's reads.
// ---------------------------------------------------------------------------

/// `people.person.profile` — one live profile. The screen is one person, so
/// this is a one-row page.
#[must_use]
pub fn person_profile_statement(party_id: &str) -> PageQuery {
    PageQuery::new(
        "people.person.profile",
        "party_id, role, nickname, avatar_color, cadence_days, last_contacted_at, \
         created_at, met, deleted_at",
        "people_profile",
        PageOrder::asc("party_id", "party_id"),
    )
    .filter(
        "party_id = ? AND deleted_at IS NULL",
        vec![PageBindValue::Text(party_id.to_owned())],
    )
}

/// `people.person.channels` — how this person can be reached.
#[must_use]
pub fn person_channels_statement(party_id: &str) -> PageQuery {
    PageQuery::new(
        "people.person.channels",
        CHANNEL_COLUMNS,
        "social_contact_channel",
        PageOrder::asc("channel_id", "channel_id"),
    )
    .filter(
        "party_id = ?",
        vec![PageBindValue::Text(party_id.to_owned())],
    )
}

/// The channel columns every contact read projects.
pub const CHANNEL_COLUMNS: &str = "channel_id, party_id, kind, label, value, \
     normalized_value, is_preferred, provenance_json";

/// `people.person.duplicateChannels` — WHO ELSE HOLDS THESE VALUES.
///
/// **A collision is only possible on a value THIS person holds**, so that set
/// is what bounds the search (`person-contacts.ts:10`-`:15`). The read it
/// replaced took `social_contact_channel` with no predicate and a window of
/// 2,000, filtered in memory: past that window both answers were wrong and
/// neither said so.
pub fn duplicate_channels_statement(
    party_id: &str,
    normalized_values: &[String],
) -> KitResult<PageQuery> {
    let fragment = in_list("normalized_value", normalized_values)?;
    let mut bind = fragment.bind;
    bind.push(PageBindValue::Text(party_id.to_owned()));
    Ok(PageQuery::new(
        "people.person.duplicateChannels",
        CHANNEL_COLUMNS,
        "social_contact_channel",
        PageOrder::asc("channel_id", "channel_id"),
    )
    .filter(&format!("{} AND party_id <> ?", fragment.sql), bind))
}

/// `people.person.outgoingLinks` — live edges FROM this party.
#[must_use]
pub fn outgoing_links_statement(party_id: &str) -> PageQuery {
    links_statement(
        "people.person.outgoingLinks",
        "from_type",
        "from_id",
        party_id,
    )
}

/// `people.person.incomingLinks` — live edges TO this party: the tasks, the
/// gifts and the logged interactions all hang off these.
#[must_use]
pub fn incoming_links_statement(party_id: &str) -> PageQuery {
    links_statement("people.person.incomingLinks", "to_type", "to_id", party_id)
}

fn links_statement(name: &str, type_column: &str, id_column: &str, party_id: &str) -> PageQuery {
    PageQuery::new(
        name,
        "link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_to",
        "core_link",
        PageOrder::asc("link_id", "link_id"),
    )
    .filter(
        // `valid_to IS NULL` is the live half. An ended relation is history
        // and is not drawn on the sheet.
        &format!("{type_column} = ? AND {id_column} = ? AND valid_to IS NULL"),
        vec![
            PageBindValue::Text(PARTY_TARGET_TYPE.to_owned()),
            PageBindValue::Text(party_id.to_owned()),
        ],
    )
}

/// `people.dashboard.activityLinks` — every live activity→party edge over a
/// roster window, which is what the recent rail is `IN`-bounded by.
pub fn activity_links_statement(party_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("to_id", party_ids)?;
    let mut bind = vec![
        PageBindValue::Text(ACTIVITY_TARGET_TYPE.to_owned()),
        PageBindValue::Text(PARTY_TARGET_TYPE.to_owned()),
    ];
    bind.extend(fragment.bind);
    Ok(PageQuery::new(
        "people.dashboard.activityLinks",
        "link_id, from_type, from_id, to_type, to_id",
        "core_link",
        PageOrder::asc("link_id", "link_id"),
    )
    .filter(
        &format!(
            "from_type = ? AND to_type = ? AND {} AND valid_to IS NULL",
            fragment.sql
        ),
        bind,
    ))
}

/// `people.journal.activityLinks` — the same edges with **no party bound at
/// all**, because the journal is the owner's whole feed rather than one
/// person's.
#[must_use]
pub fn journal_activity_links_statement() -> PageQuery {
    PageQuery::new(
        "people.journal.activityLinks",
        "link_id, from_type, from_id, to_type, to_id",
        "core_link",
        PageOrder::asc("link_id", "link_id"),
    )
    .filter(
        "from_type = ? AND to_type = ? AND valid_to IS NULL",
        vec![
            PageBindValue::Text(ACTIVITY_TARGET_TYPE.to_owned()),
            PageBindValue::Text(PARTY_TARGET_TYPE.to_owned()),
        ],
    )
}

/// Annotations ON a set of targets. The owner's notes on a party and the text
/// of a logged interaction are the same table read two ways.
pub fn annotations_statement(
    name: &str,
    target_type: &str,
    target_ids: &[String],
    order: PageOrder,
) -> KitResult<PageQuery> {
    let fragment = in_list("target_id", target_ids)?;
    let mut bind = vec![PageBindValue::Text(target_type.to_owned())];
    bind.extend(fragment.bind);
    Ok(PageQuery::new(
        name,
        "annotation_id, target_type, target_id, body_text, created_at",
        "knowledge_annotation",
        order,
    )
    .filter(&format!("target_type = ? AND {}", fragment.sql), bind))
}

/// `people.person.notes` — the owner's own notes on one person, newest first.
#[must_use]
pub fn person_notes_statement(party_id: &str) -> PageQuery {
    PageQuery::new(
        "people.person.notes",
        "annotation_id, target_type, target_id, body_text, created_at",
        "knowledge_annotation",
        PageOrder::desc("created_at", "annotation_id"),
    )
    .filter(
        "target_type = ? AND target_id = ?",
        vec![
            PageBindValue::Text(PARTY_TARGET_TYPE.to_owned()),
            PageBindValue::Text(party_id.to_owned()),
        ],
    )
}

/// `people.person.tags` — every tag on one party.
#[must_use]
pub fn person_tags_statement(party_id: &str) -> PageQuery {
    PageQuery::new(
        "people.person.tags",
        "tag_id, target_type, target_id, concept_id",
        "core_tag",
        PageOrder::asc("tag_id", "tag_id"),
    )
    .filter(
        "target_type = ? AND target_id = ?",
        vec![
            PageBindValue::Text(PARTY_TARGET_TYPE.to_owned()),
            PageBindValue::Text(party_id.to_owned()),
        ],
    )
}

/// `people.person.debtsFrom` / `people.person.debtsTo` — **TALLY'S TABLE, READ
/// CROSS-APP** (census §A seam 4).
///
/// People is the only app in the tree that reads another app's domain table for
/// a first-class surface. It reads only: `tally_obligation` is written by
/// `tally.*` and by `people.{add_debt,settle_debt}` through the vault, never by
/// a statement here.
pub fn obligations_statement(name: &str, column: &str, party_id: &str) -> PageQuery {
    PageQuery::new(
        name,
        "obligation_id, from_party, to_party, amount_minor, currency, reason, settled_at",
        "tally_obligation",
        PageOrder::asc("obligation_id", "obligation_id"),
    )
    .filter(
        &format!("{column} = ? AND deleted_at IS NULL"),
        vec![PageBindValue::Text(party_id.to_owned())],
    )
}

/// `people.person.tasks` — the tasks and gift ideas one person's incoming links
/// name. One read; which of the two a row is depends on its link's relation.
pub fn tasks_statement(task_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("task_id", task_ids)?;
    Ok(PageQuery::new(
        "people.person.tasks",
        "task_id, title, status",
        "schedule_task",
        PageOrder::asc("task_id", "task_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// Activities by id, newest first. The person sheet and the journal read the
/// same rows; the dashboard's read is windowed and is named separately.
pub fn activities_statement(name: &str, activity_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("activity_id", activity_ids)?;
    Ok(PageQuery::new(
        name,
        "activity_id, kind_concept_id, started_at",
        "core_activity",
        PageOrder::desc("started_at", "activity_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `people.person.vault` — the vault's own row, for `self_party_id`.
///
/// The owner's party id is what turns an obligation into "you owe" or "owed to
/// you"; a sheet that could not read it would have to guess a direction.
#[must_use]
pub fn vault_statement() -> PageQuery {
    PageQuery::new(
        "people.person.vault",
        "vault_id, self_party_id",
        "core_vault",
        PageOrder::asc("vault_id", "vault_id"),
    )
}

// ---------------------------------------------------------------------------
// The journal's reads.
// ---------------------------------------------------------------------------

/// `_shared/journal.scheme` — the journal scheme, by URI.
#[must_use]
pub fn journal_scheme_statement() -> PageQuery {
    PageQuery::new(
        "_shared/journal.scheme",
        "scheme_id, uri",
        "core_concept_scheme",
        PageOrder::asc("scheme_id", "scheme_id"),
    )
    .filter(
        "uri = ?",
        vec![PageBindValue::Text(JOURNAL_SCHEME_URI.to_owned())],
    )
}

/// `_shared/journal.concepts` — the marker concept lives in that scheme.
#[must_use]
pub fn journal_concepts_statement(scheme_id: &str) -> PageQuery {
    PageQuery::new(
        "_shared/journal.concepts",
        "concept_id, scheme_id, notation",
        "core_concept",
        PageOrder::asc("concept_id", "concept_id"),
    )
    .filter(
        "scheme_id = ?",
        vec![PageBindValue::Text(scheme_id.to_owned())],
    )
}

/// `_shared/journal.tags` — the notes carrying the marker.
#[must_use]
pub fn journal_tags_statement(concept_id: &str) -> PageQuery {
    PageQuery::new(
        "_shared/journal.tags",
        "tag_id, target_id, concept_id",
        "core_tag",
        PageOrder::asc("tag_id", "tag_id"),
    )
    .filter(
        "target_type = ? AND concept_id = ?",
        vec![
            PageBindValue::Text(NOTE_TARGET_TYPE.to_owned()),
            PageBindValue::Text(concept_id.to_owned()),
        ],
    )
}

/// `people.journal.notes` — the owner's entries, newest first.
pub fn journal_notes_statement(note_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("note_id", note_ids)?;
    Ok(PageQuery::new(
        "people.journal.notes",
        "note_id, title, body_content_id, created_at",
        "knowledge_note",
        PageOrder::desc("created_at", "note_id"),
    )
    .filter(
        &format!("{} AND deleted_at IS NULL", fragment.sql),
        fragment.bind,
    ))
}

/// `people.journal.bodies` — the content rows the entries' heads name.
pub fn contents_statement(content_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("content_id", content_ids)?;
    Ok(PageQuery::new(
        "people.journal.bodies",
        "content_id, content_uri",
        "core_content_item",
        PageOrder::asc("content_id", "content_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `people.journal.profiles` — just the colour, for a journal card's avatar.
pub fn journal_profiles_statement(party_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("party_id", party_ids)?;
    Ok(PageQuery::new(
        "people.journal.profiles",
        "party_id, avatar_color",
        "people_profile",
        PageOrder::asc("party_id", "party_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `people.journal.concepts` — the WHOLE concept table, with no scheme bound.
///
/// v0 reads it unfiltered (`journal.ts:64`-`:73`) because a logged
/// interaction's `kind_concept_id` can name a concept in any scheme, and the
/// journal only wants its notation. The taxonomy pair would answer the same
/// question; keeping v0's own statement means the plan snapshot still shows
/// the read the handler makes.
#[must_use]
pub fn journal_concepts_all_statement() -> PageQuery {
    PageQuery::new(
        "people.journal.concepts",
        "concept_id, notation",
        "core_concept",
        PageOrder::asc("concept_id", "concept_id"),
    )
}

// ---------------------------------------------------------------------------
// History.
// ---------------------------------------------------------------------------

/// `people.history.revisions` — durable pre-mutation history for one profile.
///
/// The manifest row-filters this scope to `entity_type = 'people.person'` and
/// masks the columns, so the statement's own `entity_type = ?` is belt AND
/// braces: the door narrows the rows whatever the handler asks for, and the
/// handler asks for the rows it means.
#[must_use]
pub fn history_statement(party_id: &str) -> PageQuery {
    PageQuery::new(
        "people.history.revisions",
        "revision_id, entity_type, entity_id, operation, snapshot_json, \
         recorded_at, undo_until, undone_at",
        "core_entity_revision",
        PageOrder::desc("recorded_at", "revision_id"),
    )
    .filter(
        "entity_type = ? AND entity_id = ?",
        vec![
            PageBindValue::Text(PERSON_ENTITY_TYPE.to_owned()),
            PageBindValue::Text(party_id.to_owned()),
        ],
    )
}

// ---------------------------------------------------------------------------
// Shared folds.
// ---------------------------------------------------------------------------

/// A walk that lowers a DOOR failure onto a denial and leaves every other kit
/// error an error.
///
/// A door failure is the vault refusing; a `FanOutExceeded` or an
/// `EmptyInList` is this crate having written the read wrong, and folding the
/// two together would render a bug as an "ask the owner" screen.
pub enum Walked {
    Rows(Vec<Row>),
    Denied(Denial),
}

/// Walk a bounded set, as a [`Walked`].
pub fn walk(door: &dyn PageDoor, statement: &PageQuery, bound: FanOutBound) -> KitResult<Walked> {
    match read_pages(door, statement, bound) {
        Ok(rows) => Ok(Walked::Rows(rows)),
        Err(KitError::Door(message)) => Ok(Walked::Denied(Denial {
            code: None,
            message: Some(message),
            revoked_at: None,
        })),
        Err(other) => Err(other),
    }
}

/// `?` for a walk: the rows, or an early return carrying the denial.
macro_rules! walked {
    ($door:expr, $statement:expr, $bound:expr, $empty:expr) => {
        match $crate::queries::walk($door, $statement, $bound)? {
            $crate::queries::Walked::Rows(rows) => rows,
            $crate::queries::Walked::Denied(denial) => return Ok(($empty, Some(denial))),
        }
    };
}
pub(crate) use walked;

/// One person's card, as every rail draws it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PersonCard {
    pub party_id: String,
    pub name: String,
    pub avatar_color: Option<String>,
    pub role: String,
}

/// The name a party has when the party read did not reach it.
///
/// **An em dash, not an empty string** (`people.ts:204`): a roster row with no
/// name is a row the party read could not resolve, and a blank cell reads as a
/// person with no name rather than as a gap.
pub const UNKNOWN_NAME: &str = "—";

/// An active reminder on a person's important date.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reminder {
    pub date_id: String,
    pub label: String,
    pub month_day: String,
}

/// `(list_id, starred)` for every party in a window, from one tag read.
#[must_use]
pub fn fold_party_tags(
    tags: &[Row],
    taxonomy: &Taxonomy,
) -> (BTreeMap<String, String>, BTreeSet<String>) {
    let list_concepts = taxonomy.list_concept_ids();
    let starred_concept = taxonomy.starred_concept_id();
    let mut list_by_party: BTreeMap<String, String> = BTreeMap::new();
    let mut starred: BTreeSet<String> = BTreeSet::new();
    for row in tags {
        let (Some(target_id), Some(concept_id)) =
            (text_of(row, "target_id"), text_of(row, "concept_id"))
        else {
            continue;
        };
        if list_concepts.contains(&concept_id) {
            // LAST TAG WINS, as v0's loop assigns rather than inserts: a person
            // filed into two lists shows the later one by `tag_id`.
            list_by_party.insert(target_id.clone(), concept_id.clone());
        }
        if starred_concept.as_deref() == Some(concept_id.as_str()) {
            starred.insert(target_id);
        }
    }
    (list_by_party, starred)
}

/// The ACTIVE reminders of a window of parties, by party.
///
/// A date with its reminder off is not a reminder: the sidebar's Upcoming shelf
/// is what the member asked to be reminded of.
#[must_use]
pub fn fold_reminders(dates: &[Row]) -> BTreeMap<String, Vec<Reminder>> {
    let mut by_party: BTreeMap<String, Vec<Reminder>> = BTreeMap::new();
    for row in dates {
        if !reminder_on(row) {
            continue;
        }
        let (Some(party_id), Some(date_id)) = (text_of(row, "party_id"), text_of(row, "date_id"))
        else {
            continue;
        };
        by_party.entry(party_id).or_default().push(Reminder {
            date_id,
            label: text_of(row, "label").unwrap_or_default(),
            month_day: text_of(row, "month_day").unwrap_or_default(),
        });
    }
    by_party
}

/// `reminder_on` is `INTEGER NOT NULL CHECK (reminder_on IN (0,1))`, and v0
/// reads it as JavaScript truthiness (`!d.reminder_on`). Zero is off.
#[must_use]
pub fn reminder_on(row: &Row) -> bool {
    row.get("reminder_on")
        .and_then(centraid_apps_kit::row::Cell::integer)
        .is_some_and(|value| value != 0)
}

/// Display names by party id, from a parties read.
#[must_use]
pub fn names_by_party(parties: &[Row]) -> BTreeMap<String, String> {
    parties
        .iter()
        .filter_map(|row| Some((text_of(row, "party_id")?, text_of(row, "display_name")?)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::row::Cell;

    fn concept(id: &str, scheme: &str, notation: &str, label: &str) -> Row {
        let mut row = Row::new();
        row.insert("concept_id".to_owned(), Cell::Text(id.to_owned()));
        row.insert("scheme_id".to_owned(), Cell::Text(scheme.to_owned()));
        row.insert("notation".to_owned(), Cell::Text(notation.to_owned()));
        row.insert("pref_label".to_owned(), Cell::Text(label.to_owned()));
        row
    }

    fn scheme(id: &str, uri: &str) -> Row {
        let mut row = Row::new();
        row.insert("scheme_id".to_owned(), Cell::Text(id.to_owned()));
        row.insert("uri".to_owned(), Cell::Text(uri.to_owned()));
        row
    }

    fn taxonomy() -> Taxonomy {
        Taxonomy {
            schemes: vec![
                scheme("s-flags", FLAGS_SCHEME_URI),
                scheme("s-lists", LIST_SCHEME_URI),
            ],
            concepts: vec![
                concept("c-star", "s-flags", STARRED_NOTATION, "Starred"),
                concept("c-work", "s-lists", "work", "Work"),
                concept("c-fam", "s-lists", "family", "Family"),
            ],
        }
    }

    #[test]
    fn the_taxonomy_resolves_schemes_lists_and_the_star() {
        let taxonomy = taxonomy();
        assert_eq!(
            taxonomy.scheme_id(LIST_SCHEME_URI).as_deref(),
            Some("s-lists")
        );
        assert_eq!(taxonomy.starred_concept_id().as_deref(), Some("c-star"));
        // Sorted BY NAME, not by id: Family before Work.
        assert_eq!(
            taxonomy
                .lists()
                .into_iter()
                .map(|entry| entry.name)
                .collect::<Vec<_>>(),
            ["Family", "Work"]
        );
        assert_eq!(taxonomy.concepts_in(RELATIONS_SCHEME_URI).len(), 0);
        // A VAULT WITH NO FLAGS SCHEME HAS NOBODY STARRED, which is a fact
        // rather than a failure.
        let bare = Taxonomy::default();
        assert_eq!(bare.starred_concept_id(), None);
        assert!(bare.lists().is_empty());
    }

    #[test]
    fn one_tag_read_answers_both_the_list_and_the_star() {
        let tag = |id: &str, target: &str, concept: &str| {
            let mut row = Row::new();
            row.insert("tag_id".to_owned(), Cell::Text(id.to_owned()));
            row.insert("target_id".to_owned(), Cell::Text(target.to_owned()));
            row.insert("concept_id".to_owned(), Cell::Text(concept.to_owned()));
            row
        };
        let (lists, starred) = fold_party_tags(
            &[
                tag("t1", "p1", "c-work"),
                tag("t2", "p1", "c-star"),
                tag("t3", "p2", "c-unknown"),
            ],
            &taxonomy(),
        );
        assert_eq!(lists.get("p1").map(String::as_str), Some("c-work"));
        assert!(starred.contains("p1"));
        // A tag in no scheme People reads is neither a list nor a star.
        assert!(!lists.contains_key("p2"));
        assert!(!starred.contains("p2"));
    }

    #[test]
    fn a_date_with_its_reminder_off_is_not_a_reminder() {
        let date = |id: &str, party: &str, on: i64| {
            let mut row = Row::new();
            row.insert("date_id".to_owned(), Cell::Text(id.to_owned()));
            row.insert("party_id".to_owned(), Cell::Text(party.to_owned()));
            row.insert("label".to_owned(), Cell::Text("Birthday".to_owned()));
            row.insert("month_day".to_owned(), Cell::Text("08-14".to_owned()));
            row.insert("reminder_on".to_owned(), Cell::Integer(on));
            row
        };
        let folded = fold_reminders(&[
            date("d1", "p1", 1),
            date("d2", "p1", 0),
            date("d3", "p2", 1),
        ]);
        assert_eq!(folded.get("p1").map(Vec::len), Some(1));
        assert_eq!(folded.get("p2").map(Vec::len), Some(1));
        assert_eq!(folded.get("p3"), None);
    }

    /// EVERY STATEMENT'S SORT COLUMN, enumerated (D-1020-PE5). The list is here
    /// rather than in prose so a new statement with a nullable sort key is a
    /// failing test rather than a paragraph nobody re-reads.
    #[test]
    fn the_trash_shelf_is_the_only_statement_ordered_by_a_nullable_column() {
        let statements = vec![
            taxonomy_concepts_statement(),
            taxonomy_schemes_statement(),
            roster_profiles_statement(),
            dashboard_profiles_statement(),
            person_profile_statement("p1"),
            person_channels_statement("p1"),
            outgoing_links_statement("p1"),
            incoming_links_statement("p1"),
            journal_activity_links_statement(),
            person_notes_statement("p1"),
            person_tags_statement("p1"),
            obligations_statement("people.person.debtsFrom", "from_party", "p1"),
            vault_statement(),
            journal_scheme_statement(),
            journal_concepts_statement("s1"),
            journal_tags_statement("c1"),
            journal_concepts_all_statement(),
            history_statement("p1"),
            person_links_statement("p1"),
            trash_profiles_statement(),
        ];
        // The DDL's nullable columns among these sort keys, by name.
        const NULLABLE: &[&str] = &["deleted_at"];
        let offenders: Vec<&str> = statements
            .iter()
            .filter(|statement| NULLABLE.contains(&statement.order.sort_column.as_str()))
            .map(|statement| statement.name.as_str())
            .collect();
        assert_eq!(offenders, ["people.trash.profiles"]);
    }

    /// The declared window, and the number v0 hands back instead.
    #[test]
    fn the_rosters_declared_maximum_is_one_above_v0s_clamp() {
        assert_eq!(ROSTER_MAX, 10_000);
        assert_eq!(V0_ROSTER_MAX, ROSTER_MAX - 1);
        assert_eq!(ROSTER_MIN, 20);
    }

    /// A DEMONSTRATED RED for the reads that are folds: the roster's fan-out
    /// has to REACH the window the manifest declares.
    #[test]
    fn the_roster_fan_out_reaches_the_declared_window() {
        assert!(
            ROSTER_FAN_OUT.cap() >= ROSTER_MAX,
            "a 10,000-person roster would refuse its own decorations at {}",
            ROSTER_FAN_OUT.cap()
        );
        // And the kit's default would not, which is why the bound is stated.
        assert!(centraid_apps_kit::JOIN_FAN_OUT.cap() < ROSTER_MAX);
    }
}
