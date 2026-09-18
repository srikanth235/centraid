//! ONE PERSON'S SHEET — and the three reads that deny independently of it
//! (D-1020-PE1).
//!
//! `queries/person.ts` is 542 lines and the largest handler in the app. Its
//! doctrine, in its own words: *"One person's full profile, gathered from the
//! vault: the party, its people_profile, the party's contact identifiers and
//! every child record. Nothing is stored by the app; it is all a read of the
//! owner's vault. The sharing questions (./_shared.ts) deny independently of
//! the profile … and a denial leaves those three fields null instead of
//! blanking the person."*
//!
//! ## The three denials, re-judged rather than transcribed
//!
//! v0 makes ONE of the three independent. `readPersonShareLinks` catches and
//! answers `null` (`_shared.ts:51`-`:75`); everything else in the sheet sits in
//! one `Promise.all` under one `try`, so a denial anywhere in it answers
//! `{person: null, vaultDenied}` — the whole person gone. The census's
//! sentence ("three sharing questions deny independently") describes an
//! intention the code has one third of.
//!
//! What the manifest actually declares is **three `read` scopes over three
//! different schemas**, each revocable on its own and each behind a read this
//! sheet makes:
//!
//! | Reading | Scopes | What it carries | v0 |
//! |---|---|---|---|
//! | [`Person::sharing`] | `share.party_vault_binding` (+ `share.authority*`) | the vaults this person is linked to | **denies alone** |
//! | [`Person::links`] | `core.link`, `core.activity`, `schedule.task` | relationships, tasks, gift ideas, interaction history | blanks the sheet |
//! | [`Person::obligations`] | `tally.obligation` — **another app's table** | the open debts | blanks the sheet |
//!
//! The share scopes are newer than the app, so on an existing vault they wait
//! for the owner (`person.ts:6`-`:9`). `tally.obligation` is the only cross-app
//! domain read in the tree (census §A seam 4) and it is Tally's lane's table:
//! a member who has not installed Tally, or who has revoked it, should see
//! their grandfather's birthday and not an "ask the owner" wall. And the linked
//! plane is where a person's *relationships* live — revoking `core.link` should
//! cost the relationship rail, not the person.
//!
//! So the port makes all three readings and the profile stands whatever they
//! say. [`a_denied_read_leaves_the_profile_standing`] is the test, and
//! `linked` is unrepresentable on a denied sharing read because the field lives
//! inside the reading.
//!
//! **The fourth candidate is named rather than modelled.**
//! `social.contact_channel` is also a scope of its own and its denial also
//! blanks the sheet in v0 and here. It is kept inside [`Profile`] on the
//! argument that how to reach a person is part of who the sheet is about, and
//! the question goes to the owner in this lane's receipt rather than being
//! decided quietly.
//!
//! ## Finding PE-F2 — `shared_with_them` has never existed
//!
//! The manifest's `person` description names `shared_with_them` beside `vaults`
//! and says both are null when the sharing reads are denied. No handler returns
//! it, and `_shared.ts:1`-`:3` says why: what is shared WITH a person goes
//! through the live grant plane (`GET /centraid/_vault/grants?partyId=`) and
//! "there is no second, vault-side invitation plane to read". The sentence
//! describes a field that was never built — the `auth_session` class of dead
//! declaration, one app over (census §A seam 2).

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::money::Money;
use centraid_apps_kit::reads::{PageDoor, read_pages, read_window};
use centraid_apps_kit::row::{Cell, Row, text_of};

use crate::queries::{
    ACTIVITY_TARGET_TYPE, DEFAULT_RELATION_NOTATION, GIFT_RELATION_NOTATION, HISTORY_ROWS,
    PEOPLE_RELATION_PREFIX, PERSON_JOIN_BOUND, RELATIONS_SCHEME_URI, Reminder, TASK_TARGET_TYPE,
    Taxonomy, UNKNOWN_NAME, Walked, activities_statement, annotations_statement,
    duplicate_channels_statement, fold_party_tags, history_statement, important_dates_statement,
    incoming_links_statement, names_by_party, obligations_statement, outgoing_links_statement,
    parties_statement, person_channels_statement, person_links_statement, person_notes_statement,
    person_profile_statement, person_tags_statement, read_taxonomy, reminder_on, tasks_statement,
    vault_statement, walk, walked,
};
use crate::{Denial, ReadState};

/// Every field the `person` payload carries, by the name it carries it under.
///
/// Enumerated so the manifest test can ask whether `shared_with_them` is one of
/// them (finding PE-F2) without reaching into a serialiser. A field added here
/// and nowhere else is a field the test will notice.
pub const PERSON_FIELDS: &[&str] = &[
    "party_id",
    "name",
    "role",
    "nickname",
    "avatar_color",
    "cadence_days",
    "last_contacted_at",
    "created_at",
    "met",
    "list_id",
    "starred",
    "contact",
    "relationships",
    "dates",
    "notes",
    "tasks",
    "gifts",
    "debts",
    "interactions",
    "vaults",
];

/// One way to reach a person, and who else holds the same value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactEntry {
    pub channel_id: String,
    /// `phone`, `email`, `address` or `handle` — the DDL's own CHECK.
    pub kind: String,
    pub label: Option<String>,
    pub value: String,
    pub normalized_value: String,
    pub preferred: bool,
    /// The provenance blob, parsed. **An unreadable blob is a fact about the
    /// blob, not about the address**, so the address still renders and the
    /// provenance says it could not be read (`person-contacts.ts:140`-`:143`).
    pub provenance: Option<serde_json::Value>,
    pub duplicate_party_ids: Vec<String>,
    pub duplicate_names: Vec<String>,
}

/// What a provenance blob says when it does not parse.
pub const UNREADABLE_PROVENANCE: &str = "unreadable provenance";

/// One important date, with whether its reminder is on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportantDate {
    pub date_id: String,
    pub label: String,
    pub month_day: String,
    pub reminder_on: bool,
}

/// One of the owner's own notes on this person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteEntry {
    pub annotation_id: String,
    pub text: String,
    pub created_at: String,
}

/// One typed relationship, drawn from a live `core_link`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relationship {
    pub relationship_id: String,
    pub related_party_id: String,
    pub name: String,
    /// The notation with its `people-` prefix stripped and its hyphens turned
    /// into spaces — `people-college-friend` reads as "college friend".
    pub kind: String,
    /// The species, where the related party is an animal. **The last token of
    /// the notation**, so `people-pet-dog` is a "pet" who is a "dog"
    /// (`person.ts:486`).
    pub pet: Option<String>,
}

/// One task on this person's sheet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskEntry {
    pub task_id: String,
    pub text: String,
    pub done: bool,
}

/// One gift idea. The same `schedule_task` row as a task, told apart by the
/// relation its link carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GiftEntry {
    pub gift_id: String,
    pub text: String,
    /// `given` or `idea`.
    pub state: String,
}

/// One logged interaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Interaction {
    pub interaction_id: String,
    /// The kind concept's notation, or `interaction` where it resolves to none.
    pub kind: String,
    pub text: String,
    pub occurred_at: String,
}

/// Which way an open obligation points.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// The owner owes this person.
    Owe,
    /// This person owes the owner.
    Owed,
}

impl Direction {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Owe => "owe",
            Self::Owed => "owed",
        }
    }
}

/// One open debt. **The amount keeps its currency** ([`Money`]): a sheet that
/// carried minor units alone would be one fold away from the ONT-23 addition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Debt {
    pub debt_id: String,
    pub direction: Direction,
    pub amount: Money,
    pub reason: String,
}

/// One vault this person is linked to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultBinding {
    pub binding_id: String,
    pub vault_id: String,
    pub linked_at: String,
}

/// THE PROFILE, which stands whatever the three readings say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub party_id: String,
    pub name: String,
    pub role: String,
    pub nickname: String,
    pub avatar_color: Option<String>,
    pub cadence_days: i64,
    pub last_contacted_at: Option<String>,
    pub created_at: String,
    /// How you met. An empty string where the column is NULL, as v0 emits it.
    pub met: String,
    pub list_id: Option<String>,
    pub starred: bool,
    pub contact: Vec<ContactEntry>,
    pub dates: Vec<ImportantDate>,
    pub notes: Vec<NoteEntry>,
}

/// The linked-entity plane: everything reached through a live `core_link`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Links {
    pub relationships: Vec<Relationship>,
    pub tasks: Vec<TaskEntry>,
    pub gifts: Vec<GiftEntry>,
    pub interactions: Vec<Interaction>,
}

/// Tally's obligations, read cross-app.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Obligations {
    pub debts: Vec<Debt>,
}

/// The share plane's answer for one person.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Sharing {
    pub vaults: Vec<VaultBinding>,
}

/// One person, as the sheet renders them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Person {
    pub profile: Profile,
    pub sharing: ReadState<Sharing>,
    pub links: ReadState<Links>,
    pub obligations: ReadState<Obligations>,
}

/// What `person` answers. `None` is "no such live person", which is not a
/// denial: v0 answers `{person: null}` with no `vaultDenied` for an absent
/// party and for an empty `party_id` (`person.ts:134`, `:166`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PersonData {
    pub person: Option<Person>,
}

/// One revision in the undo rail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revision {
    pub revision_id: String,
    pub operation: String,
    /// The pre-mutation snapshot, parsed. **`snapshot_json` is
    /// `CHECK (json_valid(...))` in the DDL**, so a row that reaches here
    /// always parses; `None` would be a corrupt vault and is reported as such
    /// rather than as an empty snapshot.
    pub snapshot: Option<serde_json::Value>,
    pub recorded_at: String,
    pub undo_until: String,
    /// Set once the one-shot undo has been used. **A snapshot applies once**
    /// (`actions/undo-person.ts:3`).
    pub undone_at: Option<String>,
}

/// What `history` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HistoryData {
    pub revisions: Vec<Revision>,
    /// The rail is longer than [`HISTORY_ROWS`]. v0 cannot say this: it takes
    /// one page and reports nothing.
    pub truncated: bool,
}

/// `history` — durable pre-mutation history for one profile.
pub fn load_history(
    door: &dyn PageDoor,
    party_id: &str,
) -> KitResult<(HistoryData, Option<Denial>)> {
    if party_id.is_empty() {
        return Ok((HistoryData::default(), None));
    }
    let window = match read_window(door, &history_statement(party_id), HISTORY_ROWS) {
        Ok(window) => window,
        Err(KitError::Door(message)) => {
            return Ok((
                HistoryData::default(),
                Some(Denial {
                    code: None,
                    message: Some(message),
                    revoked_at: None,
                }),
            ));
        }
        Err(other) => return Err(other),
    };
    let revisions = window
        .rows
        .iter()
        .filter_map(|row| {
            Some(Revision {
                revision_id: text_of(row, "revision_id")?,
                operation: text_of(row, "operation").unwrap_or_default(),
                snapshot: text_of(row, "snapshot_json")
                    .and_then(|text| serde_json::from_str(&text).ok()),
                recorded_at: text_of(row, "recorded_at").unwrap_or_default(),
                undo_until: text_of(row, "undo_until").unwrap_or_default(),
                undone_at: text_of(row, "undone_at"),
            })
        })
        .collect();
    Ok((
        HistoryData {
            revisions,
            truncated: window.filled,
        },
        None,
    ))
}

/// `person` — the sheet.
///
/// The reads happen in the order v0 makes them, which is also the order that
/// bounds them: the profile and the party first (the screen is one person, so
/// both are one-row pages), then everything `IN`-bounded by ids those two and
/// the link reads produced.
pub fn load_person(door: &dyn PageDoor, party_id: &str) -> KitResult<(PersonData, Option<Denial>)> {
    if party_id.is_empty() {
        return Ok((PersonData::default(), None));
    }
    let empty = PersonData::default();

    let profile_rows = walked!(
        door,
        &person_profile_statement(party_id),
        PERSON_JOIN_BOUND,
        empty.clone()
    );
    let Some(profile_row) = profile_rows.first() else {
        // NO SUCH LIVE PERSON. Not a denial: the read succeeded and the answer
        // is that there is nobody there.
        return Ok((PersonData::default(), None));
    };
    let party_rows = walked!(
        door,
        &parties_statement("people.person.party", &[party_id.to_owned()])?,
        PERSON_JOIN_BOUND,
        empty.clone()
    );
    let Some(party_row) = party_rows.first() else {
        return Ok((PersonData::default(), None));
    };

    let taxonomy = match read_taxonomy(door) {
        Ok(taxonomy) => taxonomy,
        Err(KitError::Door(message)) => {
            return Ok((
                empty,
                Some(Denial {
                    code: None,
                    message: Some(message),
                    revoked_at: None,
                }),
            ));
        }
        Err(other) => return Err(other),
    };

    let tags = walked!(
        door,
        &person_tags_statement(party_id),
        PERSON_JOIN_BOUND,
        empty.clone()
    );
    let dates = walked!(
        door,
        &important_dates_statement("people.person.importantDates", &[party_id.to_owned()])?,
        PERSON_JOIN_BOUND,
        empty.clone()
    );
    let notes = walked!(
        door,
        &person_notes_statement(party_id),
        PERSON_JOIN_BOUND,
        empty.clone()
    );
    let channels = walked!(
        door,
        &person_channels_statement(party_id),
        PERSON_JOIN_BOUND,
        empty.clone()
    );
    let vault_rows = walked!(door, &vault_statement(), PERSON_JOIN_BOUND, empty.clone());
    let owner_party_id = vault_rows
        .first()
        .and_then(|row| text_of(row, "self_party_id"))
        .unwrap_or_default();

    // The contact rail, and the collision search bounded by the values THIS
    // person holds.
    let contact = match read_contact(door, party_id, &channels)? {
        Ok(contact) => contact,
        Err(denial) => return Ok((empty, Some(denial))),
    };

    let (list_by_party, starred) = fold_party_tags(&tags, &taxonomy);
    let profile = Profile {
        party_id: party_id.to_owned(),
        name: text_of(party_row, "display_name").unwrap_or_default(),
        role: text_of(profile_row, "role").unwrap_or_default(),
        nickname: text_of(profile_row, "nickname").unwrap_or_default(),
        avatar_color: text_of(profile_row, "avatar_color"),
        cadence_days: profile_row
            .get("cadence_days")
            .and_then(Cell::integer)
            .unwrap_or_default(),
        last_contacted_at: text_of(profile_row, "last_contacted_at"),
        created_at: text_of(profile_row, "created_at").unwrap_or_default(),
        met: text_of(profile_row, "met").unwrap_or_default(),
        list_id: list_by_party.get(party_id).cloned(),
        starred: starred.contains(party_id),
        contact,
        dates: dates
            .iter()
            .filter_map(|row| {
                Some(ImportantDate {
                    date_id: text_of(row, "date_id")?,
                    label: text_of(row, "label").unwrap_or_default(),
                    month_day: text_of(row, "month_day").unwrap_or_default(),
                    reminder_on: reminder_on(row),
                })
            })
            .collect(),
        notes: notes
            .iter()
            .filter_map(|row| {
                Some(NoteEntry {
                    annotation_id: text_of(row, "annotation_id")?,
                    text: text_of(row, "body_text").unwrap_or_default(),
                    created_at: text_of(row, "created_at").unwrap_or_default(),
                })
            })
            .collect(),
    };

    // THE THREE READINGS. Each one's failure is its own.
    let links = read_links(door, party_id, &taxonomy)?;
    let obligations = read_obligations(door, party_id, &owner_party_id)?;
    let sharing = read_sharing(door, party_id)?;

    Ok((
        PersonData {
            person: Some(Person {
                profile,
                sharing,
                links,
                obligations,
            }),
        },
        None,
    ))
}

/// The contact rail, ordered as the sheet draws it.
fn read_contact(
    door: &dyn PageDoor,
    party_id: &str,
    channels: &[Row],
) -> KitResult<Result<Vec<ContactEntry>, Denial>> {
    // THIS PERSON'S channels only. v0 filters the read's own rows by
    // `party_id` again (`person.ts:293`-`:295`) even though the statement
    // binds it; the port keeps the read narrow and does not re-filter.
    let normalized: Vec<String> = channels
        .iter()
        .filter_map(|row| text_of(row, "normalized_value"))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let others = if normalized.is_empty() {
        Vec::new()
    } else {
        match walk(
            door,
            &duplicate_channels_statement(party_id, &normalized)?,
            PERSON_JOIN_BOUND,
        )? {
            Walked::Rows(rows) => rows,
            Walked::Denied(denial) => return Ok(Err(denial)),
        }
    };
    let duplicate_ids: Vec<String> = others
        .iter()
        .filter_map(|row| text_of(row, "party_id"))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let duplicate_names = if duplicate_ids.is_empty() {
        BTreeMap::new()
    } else {
        match walk(
            door,
            &parties_statement("people.person.duplicateParties", &duplicate_ids)?,
            PERSON_JOIN_BOUND,
        )? {
            Walked::Rows(rows) => names_by_party(&rows),
            Walked::Denied(denial) => return Ok(Err(denial)),
        }
    };

    // A DUPLICATE IS THE SAME VALUE REACHED THE SAME WAY: a phone number and a
    // handle that happen to normalise alike are not one another
    // (`person-contacts.ts:102`-`:103`).
    let duplicates_of = |kind: &str, normalized_value: &str| -> Vec<String> {
        others
            .iter()
            .filter(|row| {
                text_of(row, "kind").as_deref() == Some(kind)
                    && text_of(row, "normalized_value").as_deref() == Some(normalized_value)
            })
            .filter_map(|row| text_of(row, "party_id"))
            .collect()
    };

    let mut entries: Vec<ContactEntry> = channels
        .iter()
        .filter_map(|row| {
            let kind = text_of(row, "kind")?;
            let normalized_value = text_of(row, "normalized_value").unwrap_or_default();
            let ids = duplicates_of(&kind, &normalized_value);
            Some(ContactEntry {
                channel_id: text_of(row, "channel_id")?,
                label: text_of(row, "label"),
                value: text_of(row, "value").unwrap_or_default(),
                preferred: row
                    .get("is_preferred")
                    .and_then(Cell::integer)
                    .is_some_and(|value| value != 0),
                provenance: parse_provenance(text_of(row, "provenance_json").as_deref()),
                duplicate_names: ids
                    .iter()
                    .map(|id| {
                        duplicate_names
                            .get(id)
                            .cloned()
                            .unwrap_or_else(|| id.clone())
                    })
                    .collect(),
                duplicate_party_ids: ids,
                kind,
                normalized_value,
            })
        })
        .collect();
    // PREFERRED FIRST, then by kind, then by channel id
    // (`person-contacts.ts:127`-`:132`).
    entries.sort_by(|left, right| {
        right
            .preferred
            .cmp(&left.preferred)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.channel_id.cmp(&right.channel_id))
    });
    Ok(Ok(entries))
}

/// An unreadable provenance blob is a fact about the blob.
fn parse_provenance(text: Option<&str>) -> Option<serde_json::Value> {
    let text = text?;
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) => Some(value),
        Err(_) => Some(serde_json::json!({ "source": UNREADABLE_PROVENANCE })),
    }
}

/// THE LINKED-ENTITY PLANE: relationships, tasks, gift ideas, interactions.
fn read_links(
    door: &dyn PageDoor,
    party_id: &str,
    taxonomy: &Taxonomy,
) -> KitResult<ReadState<Links>> {
    let outgoing = match walk(door, &outgoing_links_statement(party_id), PERSON_JOIN_BOUND)? {
        Walked::Rows(rows) => rows,
        Walked::Denied(denial) => return Ok(ReadState::Denied(denial)),
    };
    let incoming = match walk(door, &incoming_links_statement(party_id), PERSON_JOIN_BOUND)? {
        Walked::Rows(rows) => rows,
        Walked::Denied(denial) => return Ok(ReadState::Denied(denial)),
    };

    // A RELATION PEOPLE DRAWS is an edge onto another PARTY whose concept's
    // notation starts `people-`. The prefix test is the whole filter in v0
    // (`person.ts:309`-`:317`) — it does not require the concept to be in the
    // relations scheme, which the gift test below does.
    let relation_links: Vec<&Row> = outgoing
        .iter()
        .filter(|row| {
            text_of(row, "to_type").as_deref() == Some(crate::queries::PARTY_TARGET_TYPE)
                && text_of(row, "relation_concept_id").is_some_and(|concept_id| {
                    taxonomy
                        .notation_of(&concept_id)
                        .is_some_and(|notation| notation.starts_with(PEOPLE_RELATION_PREFIX))
                })
        })
        .collect();

    let relation_scheme = taxonomy.scheme_id(RELATIONS_SCHEME_URI);
    let gift_task_ids: BTreeSet<String> = incoming
        .iter()
        .filter(|row| {
            text_of(row, "from_type").as_deref() == Some(TASK_TARGET_TYPE)
                && text_of(row, "relation_concept_id").is_some_and(|concept_id| {
                    is_gift_relation(taxonomy, relation_scheme.as_deref(), &concept_id)
                })
        })
        .filter_map(|row| text_of(row, "from_id"))
        .collect();
    let task_ids: Vec<String> = incoming
        .iter()
        .filter(|row| text_of(row, "from_type").as_deref() == Some(TASK_TARGET_TYPE))
        .filter_map(|row| text_of(row, "from_id"))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let activity_ids: Vec<String> = incoming
        .iter()
        .filter(|row| text_of(row, "from_type").as_deref() == Some(ACTIVITY_TARGET_TYPE))
        .filter_map(|row| text_of(row, "from_id"))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();

    let related_ids: Vec<String> = relation_links
        .iter()
        .filter_map(|row| text_of(row, "to_id"))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let related = if related_ids.is_empty() {
        Vec::new()
    } else {
        match walk(
            door,
            &parties_statement("people.person.relatedParties", &related_ids)?,
            PERSON_JOIN_BOUND,
        )? {
            Walked::Rows(rows) => rows,
            Walked::Denied(denial) => return Ok(ReadState::Denied(denial)),
        }
    };
    let related_by_id: BTreeMap<String, &Row> = related
        .iter()
        .filter_map(|row| Some((text_of(row, "party_id")?, row)))
        .collect();

    let tasks_rows = if task_ids.is_empty() {
        Vec::new()
    } else {
        match walk(door, &tasks_statement(&task_ids)?, PERSON_JOIN_BOUND)? {
            Walked::Rows(rows) => rows,
            Walked::Denied(denial) => return Ok(ReadState::Denied(denial)),
        }
    };
    let (activities, interaction_text) = if activity_ids.is_empty() {
        (Vec::new(), BTreeMap::new())
    } else {
        let activities = match walk(
            door,
            &activities_statement("people.person.interactions", &activity_ids)?,
            PERSON_JOIN_BOUND,
        )? {
            Walked::Rows(rows) => rows,
            Walked::Denied(denial) => return Ok(ReadState::Denied(denial)),
        };
        let notes = match walk(
            door,
            &annotations_statement(
                "people.person.interactionNotes",
                ACTIVITY_TARGET_TYPE,
                &activity_ids,
                centraid_apps_kit::statement::PageOrder::asc("annotation_id", "annotation_id"),
            )?,
            PERSON_JOIN_BOUND,
        )? {
            Walked::Rows(rows) => rows,
            Walked::Denied(denial) => return Ok(ReadState::Denied(denial)),
        };
        let text_by_activity = notes
            .iter()
            .filter_map(|row| Some((text_of(row, "target_id")?, text_of(row, "body_text")?)))
            .collect();
        (activities, text_by_activity)
    };

    Ok(ReadState::Ready(Links {
        relationships: relation_links
            .iter()
            .filter_map(|row| {
                let to_id = text_of(row, "to_id")?;
                let related = related_by_id.get(&to_id);
                let notation = text_of(row, "relation_concept_id")
                    .and_then(|concept_id| taxonomy.notation_of(&concept_id))
                    .unwrap_or_else(|| DEFAULT_RELATION_NOTATION.to_owned());
                let (kind, pet) = relation_kind(
                    &notation,
                    related.and_then(|row| text_of(row, "kind")).as_deref(),
                );
                Some(Relationship {
                    relationship_id: text_of(row, "link_id")?,
                    name: related
                        .and_then(|row| text_of(row, "display_name"))
                        .unwrap_or_else(|| UNKNOWN_NAME.to_owned()),
                    related_party_id: to_id,
                    kind,
                    pet,
                })
            })
            .collect(),
        tasks: tasks_rows
            .iter()
            .filter(|row| {
                text_of(row, "task_id").is_some_and(|task_id| !gift_task_ids.contains(&task_id))
            })
            .filter_map(|row| {
                Some(TaskEntry {
                    task_id: text_of(row, "task_id")?,
                    text: text_of(row, "title").unwrap_or_default(),
                    done: text_of(row, "status").as_deref() == Some("completed"),
                })
            })
            .collect(),
        gifts: tasks_rows
            .iter()
            .filter(|row| {
                text_of(row, "task_id").is_some_and(|task_id| gift_task_ids.contains(&task_id))
            })
            .filter_map(|row| {
                let done = text_of(row, "status").as_deref() == Some("completed");
                Some(GiftEntry {
                    gift_id: text_of(row, "task_id")?,
                    text: text_of(row, "title").unwrap_or_default(),
                    state: if done { "given" } else { "idea" }.to_owned(),
                })
            })
            .collect(),
        interactions: activities
            .iter()
            .filter_map(|row| {
                let activity_id = text_of(row, "activity_id")?;
                Some(Interaction {
                    kind: text_of(row, "kind_concept_id")
                        .and_then(|concept_id| taxonomy.notation_of(&concept_id))
                        .unwrap_or_else(|| "interaction".to_owned()),
                    text: interaction_text
                        .get(&activity_id)
                        .cloned()
                        .unwrap_or_default(),
                    occurred_at: text_of(row, "started_at").unwrap_or_default(),
                    interaction_id: activity_id,
                })
            })
            .collect(),
    }))
}

/// A gift relation is a concept IN THE RELATIONS SCHEME whose notation is
/// `gift-for` (`person.ts:326`-`:333`). The scheme test is what stops a
/// like-named concept from another vocabulary turning a task into a gift.
fn is_gift_relation(taxonomy: &Taxonomy, relation_scheme: Option<&str>, concept_id: &str) -> bool {
    let Some(scheme_id) = relation_scheme else {
        return false;
    };
    taxonomy.concepts.iter().any(|row| {
        text_of(row, "concept_id").as_deref() == Some(concept_id)
            && text_of(row, "scheme_id").as_deref() == Some(scheme_id)
            && text_of(row, "notation").as_deref() == Some(GIFT_RELATION_NOTATION)
    })
}

/// A relation notation, as the sheet renders it.
///
/// `people-college-friend` reads as "college friend". Where the related party
/// is an ANIMAL the last token is the species and the rest is the relation, so
/// `people-pet-dog` is a "pet" who is a "dog" — and a notation of just
/// `people-` with nothing after it reads as "related" rather than as an empty
/// chip.
#[must_use]
pub fn relation_kind(notation: &str, related_kind: Option<&str>) -> (String, Option<String>) {
    let stripped = notation
        .strip_prefix(PEOPLE_RELATION_PREFIX)
        .unwrap_or(notation);
    let mut tokens: Vec<&str> = stripped
        .split('-')
        .filter(|token| !token.is_empty())
        .collect();
    let pet = if related_kind == Some("animal") {
        tokens.pop().map(str::to_owned)
    } else {
        None
    };
    let kind = tokens.join(" ");
    (
        if kind.is_empty() {
            "related".to_owned()
        } else {
            kind
        },
        pet,
    )
}

/// TALLY'S OBLIGATIONS, read cross-app. Open debts only: **a settled debt is
/// closed, not deleted** (`actions/settle-debt.ts:3`), so it stays as history
/// and off this rail.
fn read_obligations(
    door: &dyn PageDoor,
    party_id: &str,
    owner_party_id: &str,
) -> KitResult<ReadState<Obligations>> {
    let mut rows = Vec::new();
    for (name, column) in [
        ("people.person.debtsFrom", "from_party"),
        ("people.person.debtsTo", "to_party"),
    ] {
        match read_pages(
            door,
            &obligations_statement(name, column, party_id),
            PERSON_JOIN_BOUND,
        ) {
            Ok(found) => rows.extend(found),
            Err(KitError::Door(message)) => {
                return Ok(ReadState::Denied(Denial {
                    code: None,
                    message: Some(message),
                    revoked_at: None,
                }));
            }
            Err(other) => return Err(other),
        }
    }
    // ONE OBLIGATION CAN MATCH BOTH READS — a debt from a person to themselves
    // is refused by the DDL's CHECK, but a merge that folded the two ends
    // together used to produce exactly that (see `core.merge_party`'s
    // degenerate-row policy). v0 dedupes by `obligation_id` and so does this.
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let debts = rows
        .iter()
        .filter_map(|row| {
            let debt_id = text_of(row, "obligation_id")?;
            if !seen.insert(debt_id.clone()) {
                return None;
            }
            if text_of(row, "settled_at").is_some() {
                return None;
            }
            let direction = if text_of(row, "from_party").as_deref() == Some(owner_party_id) {
                Direction::Owe
            } else {
                Direction::Owed
            };
            Some(Debt {
                debt_id,
                direction,
                amount: centraid_apps_kit::money::money(
                    row.get("amount_minor")
                        .and_then(Cell::integer)
                        .unwrap_or_default(),
                    &text_of(row, "currency").unwrap_or_default(),
                ),
                reason: text_of(row, "reason").unwrap_or_default(),
            })
        })
        .collect();
    Ok(ReadState::Ready(Obligations { debts }))
}

/// THE SHARE PLANE, for one person. The one reading v0 already keeps apart.
fn read_sharing(door: &dyn PageDoor, party_id: &str) -> KitResult<ReadState<Sharing>> {
    Ok(
        match walk(door, &person_links_statement(party_id), PERSON_JOIN_BOUND)? {
            Walked::Denied(denial) => ReadState::Denied(denial),
            Walked::Rows(rows) => ReadState::Ready(Sharing {
                vaults: rows
                    .iter()
                    .filter_map(|row| {
                        Some(VaultBinding {
                            binding_id: text_of(row, "binding_id")?,
                            vault_id: text_of(row, "vault_id").unwrap_or_default(),
                            linked_at: text_of(row, "linked_at").unwrap_or_default(),
                        })
                    })
                    .collect(),
            }),
        },
    )
}

/// The reminders of one person's sheet, for the surfaces that draw the roster's
/// chip on a detail screen.
#[must_use]
pub fn active_reminders(profile: &Profile) -> Vec<Reminder> {
    profile
        .dates
        .iter()
        .filter(|date| date.reminder_on)
        .map(|date| Reminder {
            date_id: date.date_id.clone(),
            label: date.label.clone(),
            month_day: date.month_day.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relation_notation_reads_as_a_phrase_and_an_animal_keeps_its_species() {
        assert_eq!(
            relation_kind("people-college-friend", Some("person")),
            ("college friend".to_owned(), None)
        );
        assert_eq!(
            relation_kind("people-pet-dog", Some("animal")),
            ("pet".to_owned(), Some("dog".to_owned()))
        );
        // A bare prefix is "related", never an empty chip.
        assert_eq!(relation_kind("people-", None), ("related".to_owned(), None));
        assert_eq!(
            relation_kind(DEFAULT_RELATION_NOTATION, None),
            ("related".to_owned(), None)
        );
        // A notation with no prefix is taken whole.
        assert_eq!(
            relation_kind("colleague", None),
            ("colleague".to_owned(), None)
        );
    }

    #[test]
    fn an_unreadable_provenance_blob_is_a_fact_about_the_blob() {
        assert_eq!(parse_provenance(None), None);
        assert_eq!(
            parse_provenance(Some(r#"{"source":"import"}"#)),
            Some(serde_json::json!({ "source": "import" }))
        );
        assert_eq!(
            parse_provenance(Some("{not json")),
            Some(serde_json::json!({ "source": UNREADABLE_PROVENANCE })),
            "the address still renders"
        );
    }

    /// THE THREE-STATE TEST (D-1020-PE1): a denied read leaves the profile
    /// standing, and `linked` is unrepresentable on the denial.
    ///
    /// This is the pure half — the fixture half is
    /// `crates/apps/people/tests/three_state.rs`, which runs it through a real
    /// door over a vault whose share plane is not there.
    #[test]
    fn a_denied_read_leaves_the_profile_standing() {
        let person = Person {
            profile: Profile {
                party_id: "p1".to_owned(),
                name: "Grandpa Ray".to_owned(),
                role: "Grandfather".to_owned(),
                nickname: String::new(),
                avatar_color: None,
                cadence_days: 7,
                last_contacted_at: None,
                created_at: "2099-01-01T00:00:00.000Z".to_owned(),
                met: String::new(),
                list_id: None,
                starred: false,
                contact: Vec::new(),
                dates: Vec::new(),
                notes: Vec::new(),
            },
            sharing: ReadState::Denied(Denial {
                code: Some("VAULT_DENIED".to_owned()),
                message: Some("ask the owner".to_owned()),
                revoked_at: None,
            }),
            links: ReadState::Ready(Links::default()),
            obligations: ReadState::Denied(Denial::default()),
        };
        // THE PROFILE IS INTACT.
        assert_eq!(person.profile.name, "Grandpa Ray");
        assert_eq!(person.profile.cadence_days, 7);
        // AND THE DENIED READS CARRY NO DATA. There is no `vaults: []` to
        // mistake for "linked to nothing" and no `debts: []` to mistake for
        // "owes nothing".
        assert!(person.sharing.ready().is_none());
        assert!(person.obligations.ready().is_none());
        assert!(person.sharing.denied());
        // The one that DID answer says so, and its empty list is a fact.
        assert!(person.links.known());
        assert_eq!(person.links.ready().map(|links| links.tasks.len()), Some(0));
    }

    #[test]
    fn the_payload_names_no_shared_with_them_field() {
        assert!(PERSON_FIELDS.contains(&"vaults"));
        assert!(!PERSON_FIELDS.contains(&"shared_with_them"));
    }

    #[test]
    fn active_reminders_are_the_dates_the_member_asked_to_be_reminded_of() {
        let date = |id: &str, on: bool| ImportantDate {
            date_id: id.to_owned(),
            label: "Birthday".to_owned(),
            month_day: "08-14".to_owned(),
            reminder_on: on,
        };
        let profile = Profile {
            party_id: "p1".to_owned(),
            name: String::new(),
            role: String::new(),
            nickname: String::new(),
            avatar_color: None,
            cadence_days: 0,
            last_contacted_at: None,
            created_at: String::new(),
            met: String::new(),
            list_id: None,
            starred: false,
            contact: Vec::new(),
            dates: vec![date("d1", true), date("d2", false)],
            notes: Vec::new(),
        };
        assert_eq!(
            active_reminders(&profile)
                .into_iter()
                .map(|reminder| reminder.date_id)
                .collect::<Vec<_>>(),
            ["d1"]
        );
    }

    #[test]
    fn a_direction_is_the_owners_own_side_of_the_debt() {
        assert_eq!(Direction::Owe.as_str(), "owe");
        assert_eq!(Direction::Owed.as_str(), "owed");
    }
}
