//! THE SHARE FOLD: who a document is shared with, as one module with named
//! windows (#821, #929; D-1020-DC2).
//!
//! v0's `queries/_shared.ts` is 510 lines and it is the app's real cost. The
//! doctrine it carries, verbatim, because each line is a defect it closed:
//!
//! - **A SHARE IS A STANDING ANSWER, NOT A ROSTER** (#929). `share_authority`
//!   holds who may reach this document — one person, or one circle — and
//!   `share_fulfillment` holds whether it has actually reached them. Nothing
//!   here reads a membership plane of its own.
//! - **SHARES DECORATE THE WINDOW, THEY NEVER WIDEN IT.** Every read below is
//!   bounded by ids the caller already holds.
//! - **LIVE is granted AND not run out** (#916, review 6.1): `revoked_at` is
//!   filtered in the read and `expires_at` in the fold, because a time-boxed
//!   share that keeps answering yes is the same defect on the drive as it was
//!   in the resolver.
//! - **`via` is `document` or `folder`, never a guess.** Never tell a member
//!   the document itself was shared when it only sits in a shared folder.
//! - **DELIVERED IS THE DURABLE FACT, NOT THE LIVE STATE** (#846): an
//!   unreachable pass drops `delivered` back to `syncing`, and reading that as
//!   "invited" would tell the member a share they watched land had never
//!   arrived. So the set is built from `delivered_at IS NOT NULL` and nothing
//!   else.
//! - **A DENIAL IS `null`, NOT `[]`** (D-1020-DC2, census §A seam 5).
//!   "We cannot see" and "shared with nobody" are different facts and the
//!   second is the one a member acts on. The three states are
//!   [`crate::Reading`], and this module's answer is
//!   [`Reading::Denied`][crate::Reading::Denied] where v0's is `null`.
//!
//! ## The bound, and what it can actually reach (D-1020-D3-12)
//!
//! v0 declares `SHARE_FAN_OUT = { pageSize: 500, fanOutPages: 8 }` at
//! `queries/_shared.ts:206` and applies it at **six** call sites in that file
//! plus **three** in `queries/document-origins.ts` — nine bounded windows, not
//! the census's eight (`census-wave4.md:42` counts the declaration line as a
//! call site and then states eight). [`SHARE_WINDOWS`] names all nine, and
//! `the_nine_windows_are_the_ones_v0_bounds` is the count.
//!
//! Its page size is exactly `MAX_PAGE_ROWS`, so the bound reaches the 4,000
//! rows it names and errors at the 4,001st with the true cap — which is the
//! one arithmetic v0's own default gets right by accident, and the reason a
//! raised page size would silently halve it.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::{FanOutBound, PageDoor, in_list, read_pages};
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::{Denial, Reading};

/// Tags, shares and provenance all name a document by this type.
pub const DOCUMENT_TARGET_TYPE: &str = "core.document";

/// A share whose subject is a FOLDER names it by this type — a different
/// namespace from a document id, which is why the fold matches per subject TYPE
/// and never by id alone.
pub const FOLDER_CONTAINER_TYPE: &str = "docs.folder";

/// HOW FAR A SHARE JOIN MAY WALK (#996 wave 4, R8).
///
/// It replaced `shareLimit`, which sized a WINDOW off the caller's id count,
/// capped it at 2,000 rows, and then took whatever fell inside it without
/// saying so — which on the drive meant a document quietly losing an audience.
/// Every set below is `IN`-bounded by ids the caller already holds, so the walk
/// is finite; this states where finite stops, and errors there.
pub const SHARE_FAN_OUT: FanOutBound = FanOutBound::new(500, 8);

/// The nine bounded windows this fold and [`crate::origins`] walk, by the
/// statement name each one carries.
///
/// Named as data because "eight call sites" is the kind of claim that rots: a
/// tenth window added without a name here fails
/// `the_nine_windows_are_the_ones_v0_bounds`.
pub const SHARE_WINDOWS: [&str; 9] = [
    "docs.shares.answers.core.document",
    "docs.shares.answers.docs.folder",
    "docs.shares.circles",
    "docs.shares.circleMembers",
    "docs.shares.fulfillments",
    "docs.shares.parties",
    "docs.shares.bindings",
    "docs.origins.bindings",
    "docs.origins.parties",
];

/// The two verbs a share answer carries, in the words both seats print.
#[must_use]
pub fn capability_of_verb(verb: &str) -> Capability {
    match verb {
        "edit" => Capability::ReadWrite,
        // Anything else — `view` included — is read. v0's lookup table has no
        // third entry and falls back to `read` (`_shared.ts:213`).
        _ => Capability::Read,
    }
}

/// What a share answer lets its audience do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Capability {
    Read,
    ReadWrite,
}

impl Capability {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::ReadWrite => "read+write",
        }
    }
}

/// Whether the subject has reached their own vault yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MemberStatus {
    /// The answer stands and nothing has landed.
    Invited,
    Current,
}

impl MemberStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Invited => "invited",
            Self::Current => "current",
        }
    }
}

/// Which kind of audience a standing answer names (#929).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Audience {
    Person,
    Circle,
}

impl Audience {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Circle => "circle",
        }
    }
}

/// THIS document, or a folder above it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Via {
    Document,
    Folder,
}

impl Via {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::Folder => "folder",
        }
    }
}

/// One member of a share's audience.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedMember {
    pub party_id: String,
    /// The person's name, or `"Someone"` — never an id. A party with no row is
    /// a party whose name this vault does not hold, and an id on a screen is
    /// not a name.
    pub label: String,
    pub capability: Capability,
    pub status: MemberStatus,
}

/// One standing answer, as a drive row carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedWithEntry {
    pub grant_id: String,
    /// The circle a `circle` audience names; `None` where one person is it.
    pub circle_id: Option<String>,
    pub audience: Audience,
    /// The circle's name, or the person's — whoever the answer is about.
    pub label: String,
    pub via: Via,
    pub container_id: String,
    pub members: Vec<SharedMember>,
    pub member_count: usize,
    pub pending_count: usize,
}

/// One `share_authority` row, as the fold reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Answer {
    authority_id: String,
    principal_kind: String,
    principal_id: String,
    subject_type: String,
    subject_id: String,
    verb: String,
    expires_at: Option<String>,
}

impl Answer {
    fn of(row: &Row) -> Option<Self> {
        Some(Self {
            authority_id: text_of(row, "authority_id")?,
            principal_kind: text_of(row, "principal_kind")?,
            principal_id: text_of(row, "principal_id")?,
            subject_type: text_of(row, "subject_type")?,
            subject_id: text_of(row, "subject_id")?,
            verb: text_of(row, "verb").unwrap_or_default(),
            expires_at: text_of(row, "expires_at"),
        })
    }

    /// LIVE is granted AND not run out. `revoked_at` is filtered in the read;
    /// this is the `expires_at` half, and `now` is the VAULT's instant.
    fn live_at(&self, now: &str) -> bool {
        self.expires_at
            .as_deref()
            .is_none_or(|expires| expires > now)
    }
}

/// The statement for one side of the answer walk.
///
/// Two subject types, two windows, and they are two statements because the two
/// id sets are two namespaces: a document id and a folder concept id are never
/// interchangeable, and one `IN` over both would match a folder whose concept
/// id happened to equal a document id.
pub fn answers_statement(subject_type: &str, ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("subject_id", ids)?;
    let mut bind = vec![PageBindValue::Text(subject_type.to_owned())];
    bind.extend(fragment.bind);
    bind.push(PageBindValue::Text("granted".to_owned()));
    Ok(PageQuery::new(
        &format!("docs.shares.answers.{subject_type}"),
        "authority_id, principal_kind, principal_id, subject_type, subject_id, verb, expires_at",
        "share_authority",
        PageOrder::asc("authority_id", "authority_id"),
    )
    .filter(
        &format!(
            "subject_type = ? AND {} AND decision = ? AND revoked_at IS NULL",
            fragment.sql
        ),
        bind,
    ))
}

/// `docs.shares.circles` — the circle names an answer's audience needs.
pub fn circles_statement(circle_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("circle_id", circle_ids)?;
    Ok(PageQuery::new(
        "docs.shares.circles",
        "circle_id, name",
        "social_circle",
        PageOrder::asc("circle_id", "circle_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `docs.shares.circleMembers` — the roster a circle answer resolves to.
pub fn circle_members_statement(circle_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("circle_id", circle_ids)?;
    Ok(PageQuery::new(
        "docs.shares.circleMembers",
        "member_id, circle_id, party_id",
        "social_circle_member",
        PageOrder::asc("member_id", "member_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `docs.shares.fulfillments` — whether a standing answer has reached anyone.
///
/// **THE KEYSET IS THE TABLE'S OWN PRIMARY KEY.** `share_fulfillment` is keyed
/// on the PAIR `(grant_id, peer_vault_id)` — one grant reaches several peers —
/// so a cursor on `grant_id` alone would stop at the first peer and call the
/// delivery list finished.
pub fn fulfillments_statement(grant_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("grant_id", grant_ids)?;
    Ok(PageQuery::new(
        "docs.shares.fulfillments",
        "grant_id, peer_vault_id, delivered_at",
        "share_fulfillment",
        PageOrder::asc("grant_id", "peer_vault_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `docs.shares.parties` — the names of the roster the answers named.
pub fn parties_statement(party_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("party_id", party_ids)?;
    Ok(PageQuery::new(
        "docs.shares.parties",
        "party_id, display_name",
        "core_party",
        PageOrder::asc("party_id", "party_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `docs.shares.bindings` — which vault is a party's own.
///
/// A REVOKED BINDING NO LONGER SAYS WHICH VAULT IS THEIRS, so the read filters
/// it out rather than the fold: a revoked binding that still matched a
/// fulfillment would report a delivery to a vault the party has left.
pub fn bindings_statement(party_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("party_id", party_ids)?;
    Ok(PageQuery::new(
        "docs.shares.bindings",
        "binding_id, party_id, vault_id",
        "share_party_vault_binding",
        PageOrder::asc("binding_id", "binding_id"),
    )
    .filter(
        &format!("{} AND revoked_at IS NULL", fragment.sql),
        fragment.bind,
    ))
}

/// The concept chain above a document, root included.
///
/// An answer over ANY of them reaches the document, so this chain bounds the
/// folder-side read.
///
/// **GUARDED, NOT TRUSTED**: the vault does not forbid a `broader_concept_id`
/// cycle, and an unguarded walk hangs the drive rather than losing one share.
/// Sixty-four steps is v0's guard (`_shared.ts:228`), and a cycle terminates on
/// the visited set rather than on the depth.
#[must_use]
pub fn folder_chain(
    concept_id: Option<&str>,
    parent_of: &BTreeMap<String, Option<String>>,
) -> Vec<String> {
    const MAX_DEPTH: usize = 64;
    let mut chain: Vec<String> = Vec::new();
    let mut at = concept_id.map(str::to_owned);
    while let Some(concept) = at {
        if chain.contains(&concept) || chain.len() >= MAX_DEPTH {
            break;
        }
        chain.push(concept.clone());
        at = parent_of.get(&concept).cloned().flatten();
    }
    chain
}

/// What the fold needs from the caller's own window.
pub struct ShareWindow<'a> {
    /// The documents the caller's window returned.
    pub document_ids: &'a [String],
    /// Which folder each document is filed in, from the same tag read.
    pub folder_by_document: &'a BTreeMap<String, String>,
    /// `concept_id -> broader_concept_id`, from the taxonomy read the caller
    /// already made. Passed in rather than re-read: it is the SAME read.
    pub parent_of: &'a BTreeMap<String, Option<String>>,
    /// The vault's own instant. Not the host's: an `expires_at` compared
    /// against a host clock is a share that stays live on a slow phone.
    pub now: &'a str,
}

/// The whole fold: read the answers, resolve their audiences, and index by
/// document.
///
/// `Reading::Denied` where any of the seven reads refuses — which is what v0's
/// bare `catch { return null }` means, stated as a type instead of a `null`
/// that a caller can accidentally treat as empty.
///
/// A `FanOutExceeded` is **not** a denial and is not swallowed: it is the
/// bound reporting the size it reached, and the surface has to say so rather
/// than draw a document with fewer audiences than it has.
pub fn read_shares_by_document(
    door: &dyn PageDoor,
    window: &ShareWindow<'_>,
) -> KitResult<Reading<BTreeMap<String, Vec<SharedWithEntry>>>> {
    if window.document_ids.is_empty() {
        return Ok(Reading::Data(BTreeMap::new()));
    }
    let chain_by_document: BTreeMap<String, Vec<String>> = window
        .document_ids
        .iter()
        .map(|document_id| {
            (
                document_id.clone(),
                folder_chain(
                    window
                        .folder_by_document
                        .get(document_id)
                        .map(String::as_str),
                    window.parent_of,
                ),
            )
        })
        .collect();
    let folder_ids: Vec<String> = chain_by_document
        .values()
        .flatten()
        .cloned()
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();

    let mut document_ids: Vec<String> = window.document_ids.to_vec();
    document_ids.sort();
    document_ids.dedup();

    let document_answers = match walk(door, answers_statement(DOCUMENT_TARGET_TYPE, &document_ids))
    {
        Walked::Rows(rows) => rows,
        Walked::Denied(denial) => return Ok(Reading::Denied(denial)),
        Walked::Failed(error) => return Err(error),
    };
    let folder_answers = if folder_ids.is_empty() {
        Vec::new()
    } else {
        match walk(door, answers_statement(FOLDER_CONTAINER_TYPE, &folder_ids)) {
            Walked::Rows(rows) => rows,
            Walked::Denied(denial) => return Ok(Reading::Denied(denial)),
            Walked::Failed(error) => return Err(error),
        }
    };

    // DEDUPE BY `authority_id`: an answer arriving through both reads would
    // otherwise print the same audience twice on one row.
    let mut by_authority: BTreeMap<String, Answer> = BTreeMap::new();
    for row in document_answers.iter().chain(folder_answers.iter()) {
        if let Some(answer) = Answer::of(row) {
            by_authority.insert(answer.authority_id.clone(), answer);
        }
    }
    let answers: Vec<Answer> = by_authority
        .into_values()
        .filter(|answer| {
            (answer.principal_kind == "person" || answer.principal_kind == "circle")
                && answer.live_at(window.now)
        })
        .collect();
    if answers.is_empty() {
        return Ok(Reading::Data(BTreeMap::new()));
    }

    let circle_ids: Vec<String> = answers
        .iter()
        .filter(|answer| answer.principal_kind == "circle")
        .map(|answer| answer.principal_id.clone())
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let grant_ids: Vec<String> = answers
        .iter()
        .map(|answer| answer.authority_id.clone())
        .collect();

    let (circles, members) = if circle_ids.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let circles = match walk(door, circles_statement(&circle_ids)) {
            Walked::Rows(rows) => rows,
            Walked::Denied(denial) => return Ok(Reading::Denied(denial)),
            Walked::Failed(error) => return Err(error),
        };
        let members = match walk(door, circle_members_statement(&circle_ids)) {
            Walked::Rows(rows) => rows,
            Walked::Denied(denial) => return Ok(Reading::Denied(denial)),
            Walked::Failed(error) => return Err(error),
        };
        (circles, members)
    };
    let fulfillments = match walk(door, fulfillments_statement(&grant_ids)) {
        Walked::Rows(rows) => rows,
        Walked::Denied(denial) => return Ok(Reading::Denied(denial)),
        Walked::Failed(error) => return Err(error),
    };

    let mut members_by_circle: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in &members {
        if let (Some(circle_id), Some(party_id)) =
            (text_of(row, "circle_id"), text_of(row, "party_id"))
        {
            members_by_circle
                .entry(circle_id)
                .or_default()
                .push(party_id);
        }
    }
    let roster_of = |answer: &Answer| -> Vec<String> {
        if answer.principal_kind == "person" {
            vec![answer.principal_id.clone()]
        } else {
            members_by_circle
                .get(&answer.principal_id)
                .cloned()
                .unwrap_or_default()
        }
    };

    // Bounded by the roster the answers just named.
    let party_ids: Vec<String> = answers
        .iter()
        .flat_map(&roster_of)
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let (parties, bindings) = if party_ids.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let parties = match walk(door, parties_statement(&party_ids)) {
            Walked::Rows(rows) => rows,
            Walked::Denied(denial) => return Ok(Reading::Denied(denial)),
            Walked::Failed(error) => return Err(error),
        };
        let bindings = match walk(door, bindings_statement(&party_ids)) {
            Walked::Rows(rows) => rows,
            Walked::Denied(denial) => return Ok(Reading::Denied(denial)),
            Walked::Failed(error) => return Err(error),
        };
        (parties, bindings)
    };

    Ok(Reading::Data(fold_shares(
        &answers,
        &FoldInputs {
            circles: &circles,
            parties: &parties,
            bindings: &bindings,
            fulfillments: &fulfillments,
            members_by_circle: &members_by_circle,
        },
        &chain_by_document,
        window.document_ids,
    )))
}

/// The rows the pure fold needs, so the fold can be tested without a door.
pub struct FoldInputs<'a> {
    pub circles: &'a [Row],
    pub parties: &'a [Row],
    pub bindings: &'a [Row],
    pub fulfillments: &'a [Row],
    pub members_by_circle: &'a BTreeMap<String, Vec<String>>,
}

/// THE PURE FOLD over pages — no door, no clock, no I/O.
fn fold_shares(
    answers: &[Answer],
    inputs: &FoldInputs<'_>,
    chain_by_document: &BTreeMap<String, Vec<String>>,
    document_order: &[String],
) -> BTreeMap<String, Vec<SharedWithEntry>> {
    let name_by_party: BTreeMap<String, Option<String>> = inputs
        .parties
        .iter()
        .filter_map(|row| {
            text_of(row, "party_id").map(|party_id| (party_id, text_of(row, "display_name")))
        })
        .collect();
    let vault_by_party: BTreeMap<String, String> = inputs
        .bindings
        .iter()
        .filter_map(|row| Some((text_of(row, "party_id")?, text_of(row, "vault_id")?)))
        .collect();
    let circle_names: BTreeMap<String, Option<String>> = inputs
        .circles
        .iter()
        .filter_map(|row| text_of(row, "circle_id").map(|id| (id, text_of(row, "name"))))
        .collect();
    // DELIVERED IS THE DURABLE FACT (#846): the pair, and only where a
    // `delivered_at` is actually there.
    let delivered: BTreeSet<(String, String)> = inputs
        .fulfillments
        .iter()
        .filter(|row| text_of(row, "delivered_at").is_some())
        .filter_map(|row| Some((text_of(row, "grant_id")?, text_of(row, "peer_vault_id")?)))
        .collect();

    let mut entry_by_grant: BTreeMap<String, SharedWithEntry> = BTreeMap::new();
    for answer in answers {
        let capability = capability_of_verb(&answer.verb);
        let audience = if answer.principal_kind == "person" {
            Audience::Person
        } else {
            Audience::Circle
        };
        let roster_ids: Vec<String> = if audience == Audience::Person {
            vec![answer.principal_id.clone()]
        } else {
            inputs
                .members_by_circle
                .get(&answer.principal_id)
                .cloned()
                .unwrap_or_default()
        };
        let mut roster: Vec<SharedMember> = roster_ids
            .into_iter()
            .map(|party_id| {
                let landed = vault_by_party.get(&party_id).is_some_and(|vault_id| {
                    delivered.contains(&(answer.authority_id.clone(), vault_id.clone()))
                });
                let status = if landed {
                    MemberStatus::Current
                } else {
                    MemberStatus::Invited
                };
                SharedMember {
                    label: name_by_party
                        .get(&party_id)
                        .cloned()
                        .flatten()
                        // A party with no row is "Someone", never an id.
                        .unwrap_or_else(|| "Someone".to_owned()),
                    party_id,
                    capability,
                    status,
                }
            })
            .collect();
        // v0 sorts by `label.localeCompare`. For the ASCII display names in the
        // fixtures the two orders agree; the divergence for non-ASCII names is
        // the parity manifest's `order: "set"` marker (apps seam 4).
        roster.sort_by(|left, right| left.label.cmp(&right.label));
        let pending_count = roster
            .iter()
            .filter(|member| member.status == MemberStatus::Invited)
            .count();
        entry_by_grant.insert(
            answer.authority_id.clone(),
            SharedWithEntry {
                grant_id: answer.authority_id.clone(),
                circle_id: (audience == Audience::Circle).then(|| answer.principal_id.clone()),
                audience,
                label: if audience == Audience::Circle {
                    circle_names
                        .get(&answer.principal_id)
                        .cloned()
                        .flatten()
                        .unwrap_or_else(|| "a circle".to_owned())
                } else {
                    roster
                        .first()
                        .map_or_else(|| "Someone".to_owned(), |member| member.label.clone())
                },
                via: if answer.subject_type == DOCUMENT_TARGET_TYPE {
                    Via::Document
                } else {
                    Via::Folder
                },
                container_id: answer.subject_id.clone(),
                member_count: roster.len(),
                pending_count,
                members: roster,
            },
        );
    }

    let mut by_document: BTreeMap<String, Vec<SharedWithEntry>> = BTreeMap::new();
    for document_id in document_order {
        let chain = chain_by_document
            .get(document_id)
            .cloned()
            .unwrap_or_default();
        let mut entries: Vec<SharedWithEntry> = answers
            .iter()
            .filter(|answer| {
                // MATCH PER SUBJECT TYPE, never id alone: document ids and
                // folder concept ids are different namespaces.
                if answer.subject_type == DOCUMENT_TARGET_TYPE {
                    answer.subject_id == *document_id
                } else {
                    chain.contains(&answer.subject_id)
                }
            })
            .filter_map(|answer| entry_by_grant.get(&answer.authority_id).cloned())
            .collect();
        // The document's own answers first, then by label.
        entries.sort_by(|left, right| {
            left.via
                .cmp(&right.via)
                .then_with(|| left.label.cmp(&right.label))
        });
        if !entries.is_empty() {
            by_document.insert(document_id.clone(), entries);
        }
    }
    by_document
}

/// What a bounded walk came back as.
enum Walked {
    Rows(Vec<Row>),
    /// The door refused. A DENIAL IS A VALUE.
    Denied(Denial),
    /// The bound reported the size it reached, or the grammar refused the
    /// statement. Neither is a denial and neither is swallowed.
    Failed(KitError),
}

/// One bounded window, walked under [`SHARE_FAN_OUT`].
fn walk(door: &dyn PageDoor, statement: KitResult<PageQuery>) -> Walked {
    let statement = match statement {
        Ok(statement) => statement,
        Err(error) => return Walked::Failed(error),
    };
    match read_pages(door, &statement, SHARE_FAN_OUT) {
        Ok(rows) => Walked::Rows(rows),
        Err(KitError::Door(message)) => Walked::Denied(Denial {
            code: None,
            message: Some(message),
            revoked_at: None,
        }),
        Err(other) => Walked::Failed(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::page::MAX_PAGE_ROWS;
    use centraid_apps_kit::row::Cell;

    fn row(pairs: &[(&str, &str)]) -> Row {
        let mut row = Row::new();
        for (column, value) in pairs {
            row.insert((*column).to_owned(), Cell::Text((*value).to_owned()));
        }
        row
    }

    /// D-1020-D3-12: THE BOUND REACHES THE SIZE IT NAMES.
    ///
    /// `SHARE_FAN_OUT`'s page size is exactly `MAX_PAGE_ROWS`, so 500 × 8 is
    /// both the stated and the reachable cap. Tally's `LEDGER_FAN_OUT` states
    /// 8,000 and reaches 4,000; a Docs lane that "improved" this bound by
    /// raising its page size would halve it silently.
    #[test]
    fn the_share_bound_reaches_the_four_thousand_rows_it_names() {
        assert_eq!(SHARE_FAN_OUT.page_size, MAX_PAGE_ROWS);
        assert_eq!(SHARE_FAN_OUT.reachable_page_size(), MAX_PAGE_ROWS);
        assert_eq!(SHARE_FAN_OUT.cap(), 4_000);
    }

    /// The nine bounded windows, and the count the census reads as eight.
    #[test]
    fn the_nine_windows_are_the_ones_v0_bounds() {
        let mut named = SHARE_WINDOWS.to_vec();
        named.sort_unstable();
        named.dedup();
        assert_eq!(named.len(), 9, "every window is named exactly once");
        let ids = vec!["a".to_owned()];
        let built: Vec<String> = vec![
            answers_statement(DOCUMENT_TARGET_TYPE, &ids),
            answers_statement(FOLDER_CONTAINER_TYPE, &ids),
            circles_statement(&ids),
            circle_members_statement(&ids),
            fulfillments_statement(&ids),
            parties_statement(&ids),
            bindings_statement(&ids),
            crate::origins::origin_bindings_statement(&ids),
            crate::origins::origin_parties_statement(&ids),
        ]
        .into_iter()
        .map(|statement| statement.expect("a bounded statement").name)
        .collect();
        for name in &built {
            assert!(SHARE_WINDOWS.contains(&name.as_str()), "{name} is unnamed");
        }
        assert_eq!(built.len(), SHARE_WINDOWS.len());
    }

    /// A CYCLE IN THE FOLDER GRAPH DOES NOT HANG THE DRIVE. The vault does not
    /// forbid one, and losing one share beats a spinner.
    #[test]
    fn a_broader_concept_cycle_terminates() {
        let parent_of: BTreeMap<String, Option<String>> = [
            ("a".to_owned(), Some("b".to_owned())),
            ("b".to_owned(), Some("c".to_owned())),
            ("c".to_owned(), Some("a".to_owned())),
        ]
        .into_iter()
        .collect();
        assert_eq!(folder_chain(Some("a"), &parent_of), ["a", "b", "c"]);
        assert!(folder_chain(None, &parent_of).is_empty());
    }

    /// THE CHAIN IS WHAT MAKES A FOLDER SHARE REACH A DOCUMENT, and `via` says
    /// which it was — never "document" for a document that only sits in a
    /// shared folder.
    #[test]
    fn a_folder_answer_reaches_the_document_below_it_as_a_folder_share() {
        let parent_of: BTreeMap<String, Option<String>> =
            [("leases".to_owned(), Some("root".to_owned()))]
                .into_iter()
                .collect();
        let answers = vec![
            Answer {
                authority_id: "g-folder".to_owned(),
                principal_kind: "person".to_owned(),
                principal_id: "p1".to_owned(),
                subject_type: FOLDER_CONTAINER_TYPE.to_owned(),
                subject_id: "leases".to_owned(),
                verb: "view".to_owned(),
                expires_at: None,
            },
            Answer {
                authority_id: "g-doc".to_owned(),
                principal_kind: "person".to_owned(),
                principal_id: "p2".to_owned(),
                subject_type: DOCUMENT_TARGET_TYPE.to_owned(),
                subject_id: "d1".to_owned(),
                verb: "edit".to_owned(),
                expires_at: None,
            },
        ];
        let chain_by_document: BTreeMap<String, Vec<String>> =
            [("d1".to_owned(), folder_chain(Some("leases"), &parent_of))]
                .into_iter()
                .collect();
        let parties = vec![
            row(&[("party_id", "p1"), ("display_name", "Ana")]),
            row(&[("party_id", "p2"), ("display_name", "Bo")]),
        ];
        let folded = fold_shares(
            &answers,
            &FoldInputs {
                circles: &[],
                parties: &parties,
                bindings: &[],
                fulfillments: &[],
                members_by_circle: &BTreeMap::new(),
            },
            &chain_by_document,
            &["d1".to_owned()],
        );
        let entries = folded.get("d1").expect("both answers reach the document");
        assert_eq!(entries.len(), 2);
        // The document's own answer sorts FIRST.
        assert_eq!(entries[0].via, Via::Document);
        assert_eq!(entries[0].label, "Bo");
        assert_eq!(entries[0].members[0].capability, Capability::ReadWrite);
        assert_eq!(entries[1].via, Via::Folder);
        assert_eq!(entries[1].container_id, "leases");
        assert_eq!(entries[1].members[0].capability, Capability::Read);
        // Nothing has been delivered, so everyone is invited.
        assert_eq!(entries[0].pending_count, 1);
    }

    /// #846: DELIVERED IS THE DURABLE FACT. A fulfillment row with no
    /// `delivered_at` — a pass that went unreachable and dropped back to
    /// `syncing` — is not a delivery, and reading it as one would tell the
    /// member a share they watched land had never arrived.
    #[test]
    fn only_a_delivered_at_makes_a_member_current() {
        let answers = vec![Answer {
            authority_id: "g1".to_owned(),
            principal_kind: "circle".to_owned(),
            principal_id: "c1".to_owned(),
            subject_type: DOCUMENT_TARGET_TYPE.to_owned(),
            subject_id: "d1".to_owned(),
            verb: "view".to_owned(),
            expires_at: None,
        }];
        let members_by_circle: BTreeMap<String, Vec<String>> =
            [("c1".to_owned(), vec!["p1".to_owned(), "p2".to_owned()])]
                .into_iter()
                .collect();
        let mut syncing = row(&[("grant_id", "g1"), ("peer_vault_id", "v2")]);
        syncing.insert("delivered_at".to_owned(), Cell::Null);
        let folded = fold_shares(
            &answers,
            &FoldInputs {
                circles: &[row(&[("circle_id", "c1"), ("name", "Family")])],
                parties: &[
                    row(&[("party_id", "p1"), ("display_name", "Ana")]),
                    row(&[("party_id", "p2"), ("display_name", "Bo")]),
                ],
                bindings: &[
                    row(&[("binding_id", "b1"), ("party_id", "p1"), ("vault_id", "v1")]),
                    row(&[("binding_id", "b2"), ("party_id", "p2"), ("vault_id", "v2")]),
                ],
                fulfillments: &[
                    row(&[
                        ("grant_id", "g1"),
                        ("peer_vault_id", "v1"),
                        ("delivered_at", "2099-06-01T09:00:00.000Z"),
                    ]),
                    syncing,
                ],
                members_by_circle: &members_by_circle,
            },
            &BTreeMap::new(),
            &["d1".to_owned()],
        );
        let entry = &folded.get("d1").expect("the circle answer")[0];
        assert_eq!(entry.audience, Audience::Circle);
        assert_eq!(entry.label, "Family", "a circle answer is about the circle");
        assert_eq!(entry.circle_id.as_deref(), Some("c1"));
        assert_eq!(entry.member_count, 2);
        assert_eq!(entry.pending_count, 1, "Bo's pass has not landed");
        assert_eq!(entry.members[0].status, MemberStatus::Current);
        assert_eq!(entry.members[1].status, MemberStatus::Invited);
    }

    /// A PARTY WITH NO ROW IS "Someone", NEVER AN ID — and a circle with no row
    /// is "a circle".
    #[test]
    fn a_nameless_audience_is_a_word_and_not_an_id() {
        let answers = vec![
            Answer {
                authority_id: "g1".to_owned(),
                principal_kind: "person".to_owned(),
                principal_id: "party-nobody-knows".to_owned(),
                subject_type: DOCUMENT_TARGET_TYPE.to_owned(),
                subject_id: "d1".to_owned(),
                verb: "view".to_owned(),
                expires_at: None,
            },
            Answer {
                authority_id: "g2".to_owned(),
                principal_kind: "circle".to_owned(),
                principal_id: "circle-nobody-knows".to_owned(),
                subject_type: DOCUMENT_TARGET_TYPE.to_owned(),
                subject_id: "d1".to_owned(),
                verb: "view".to_owned(),
                expires_at: None,
            },
        ];
        let folded = fold_shares(
            &answers,
            &FoldInputs {
                circles: &[],
                parties: &[],
                bindings: &[],
                fulfillments: &[],
                members_by_circle: &BTreeMap::new(),
            },
            &BTreeMap::new(),
            &["d1".to_owned()],
        );
        let entries = folded.get("d1").expect("two answers");
        let labels: Vec<&str> = entries.iter().map(|entry| entry.label.as_str()).collect();
        assert_eq!(labels, ["Someone", "a circle"]);
        for entry in entries {
            assert!(
                !entry.label.contains("nobody-knows"),
                "an id is not a name: {}",
                entry.label
            );
        }
    }

    /// #916 review 6.1: A TIME-BOXED SHARE THAT RAN OUT IS NOT LIVE.
    #[test]
    fn an_expired_answer_is_not_a_live_one() {
        let answer = Answer {
            authority_id: "g1".to_owned(),
            principal_kind: "person".to_owned(),
            principal_id: "p1".to_owned(),
            subject_type: DOCUMENT_TARGET_TYPE.to_owned(),
            subject_id: "d1".to_owned(),
            verb: "view".to_owned(),
            expires_at: Some("2099-06-01T09:00:00.000Z".to_owned()),
        };
        assert!(answer.live_at("2099-05-31T00:00:00.000Z"));
        assert!(!answer.live_at("2099-06-02T00:00:00.000Z"));
        // No expiry is forever, which is not the same as expired-at-zero.
        let forever = Answer {
            expires_at: None,
            ..answer
        };
        assert!(forever.live_at("2999-01-01T00:00:00.000Z"));
    }

    /// The statement carries `decision = 'granted'` and `revoked_at IS NULL` in
    /// the READ, because a revoked answer must never reach the fold at all.
    #[test]
    fn the_answer_walk_filters_revoked_and_ungranted_in_the_read() {
        let statement = answers_statement(DOCUMENT_TARGET_TYPE, &["d1".to_owned()])
            .expect("a bounded statement");
        let predicate = statement.r#where.clone().unwrap_or_default();
        assert!(predicate.contains("decision = ?"));
        assert!(predicate.contains("revoked_at IS NULL"));
        assert!(predicate.contains("subject_type = ?"));
        assert_eq!(
            statement.bind.last(),
            Some(&PageBindValue::Text("granted".to_owned()))
        );
    }
}
