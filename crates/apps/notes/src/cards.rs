//! REFERENCE CARDS — how a note renders the far end of a link it points at.
//!
//! Ported from `packages/vault/src/gateway/cards.ts` (#272). A `[[wikilink]]`
//! compiles to a `core.link`, and the shelf has to draw the thing it points at:
//! a person's name, an event's start, a document's title. **Resolvable-if-linked
//! is the consent rule**: a LIVE link touching the ref authorises rendering the
//! far end even when the caller has no read scope on that entity, and a ref with
//! neither is `denied` per ref rather than a failed screen.
//!
//! ## Why the fold is here and the decision is not (#1020, D-1020-N9)
//!
//! Everything below is a projection over rows bounded by ids already in hand —
//! statements-as-data, which is what an app crate may hold. The **decision**
//! (direct read consent, else `linkedAndVisible`, else `denied`) is the
//! gateway's: it evaluates access per entity and receipts the batch. So this
//! module takes a [`CardDoor`] for the consent half and does the drawing, and
//! the two halves compose without either one guessing at the other.
//!
//! [`OwnerCards`] is the owner's view — no row filter, no field mask, every ref
//! resolvable — which is the identity v0's parity fixtures are generated under
//! and therefore the identity that makes them comparable.
//!
//! ## Two v0 behaviours reproduced on purpose, one of them a finding
//!
//! * `core.party`, `core.place`, `core.event`, `schedule.task`,
//!   `knowledge.note`, `core.collection` and `social.thread` all hardcode
//!   `0 AS trashed` (`cards.ts:42`-`:78`) — so **a trashed note's card reads
//!   `live`**, even though `knowledge_note` carries the trash pair and the
//!   library's own trash shelf reads it. Reproduced here for parity and filed
//!   as a finding: a link to a note a member deleted draws as if it were still
//!   there.
//! * An **uncurated** entity — one with no card projection, `tally.expense`
//!   among them — answers existence and status only, with a null title. A
//!   powerbox that offers expenses as link targets therefore draws them
//!   titleless once linked. Also a finding, not a fix inside this lane.

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{JOIN_FAN_OUT, PageDoor, in_list, read_pages};
use centraid_apps_kit::representations::{RepresentationIndex, read_representations};
use centraid_apps_kit::row::{Row, integer_or_zero, text_of};
use centraid_apps_kit::statement::{PageOrder, PageQuery};

/// Refs render in lists, not bulk exports (`cards.ts:35`).
pub const MAX_REFS: usize = 100;

/// A `(type, id)` pair a link points at.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Ref {
    pub entity: String,
    pub id: String,
}

impl Ref {
    #[must_use]
    pub fn new(entity: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            entity: entity.into(),
            id: id.into(),
        }
    }
}

/// What a card says about the row it names.
///
/// `missing` is a tombstone, `denied` a consent gap, `unknown` a bad type — and
/// the three are different sentences on a shelf (`cards.ts:20`-`:22`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardStatus {
    Live,
    Trashed,
    Missing,
    Denied,
    Unknown,
}

impl CardStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Trashed => "trashed",
            Self::Missing => "missing",
            Self::Denied => "denied",
            Self::Unknown => "unknown",
        }
    }
}

/// One renderable card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefCard {
    pub entity: String,
    pub id: String,
    pub status: CardStatus,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    /// A `core.content_item` id renderable as a thumbnail, if any.
    pub thumbnail_content_id: Option<String>,
}

impl RefCard {
    /// The shape a ref with no card takes. v0's own fallback, and the one the
    /// library's fold uses when a batch came back short
    /// (`queries/library.ts:392`-`:398`).
    #[must_use]
    pub fn unresolved(entity: &str, id: &str, status: CardStatus) -> Self {
        Self {
            entity: entity.to_owned(),
            id: id.to_owned(),
            status,
            title: None,
            subtitle: None,
            thumbnail_content_id: None,
        }
    }
}

/// The consent half. One batch, one answer per ref, in the order asked.
pub trait CardDoor {
    /// Resolve up to [`MAX_REFS`] refs. **Never an `Err` for a refusal**: a
    /// denied ref is a `denied` CARD, because the shelf draws it.
    fn resolve(&self, refs: &[Ref]) -> KitResult<Vec<RefCard>>;
}

/// THE OWNER'S VIEW: every ref resolvable, nothing masked.
pub struct OwnerCards<'door> {
    door: &'door dyn PageDoor,
}

impl<'door> OwnerCards<'door> {
    #[must_use]
    pub const fn new(door: &'door dyn PageDoor) -> Self {
        Self { door }
    }
}

/// One carded entity: where its row lives and which columns the card reads.
struct CardSpec {
    entity: &'static str,
    table: &'static str,
    pk: &'static str,
    select: &'static str,
    /// `true` where v0's projection reads the trash pair. See the module note:
    /// six of the eleven hardcode `0`.
    reads_trash: bool,
}

/// v0's `CARD_SQL`, as projections. The order is v0's own file order.
const CARDS: &[CardSpec] = &[
    CardSpec {
        entity: "core.party",
        table: "core_party",
        pk: "party_id",
        select: "party_id, display_name, kind, avatar_content_id",
        reads_trash: false,
    },
    CardSpec {
        entity: "core.place",
        table: "core_place",
        pk: "place_id",
        select: "place_id, name, kind",
        reads_trash: false,
    },
    CardSpec {
        entity: "core.event",
        table: "core_event",
        pk: "event_id",
        select: "event_id, summary, dtstart",
        reads_trash: false,
    },
    CardSpec {
        entity: "core.transaction",
        table: "core_transaction",
        pk: "txn_id",
        select: "txn_id, description, currency, amount_minor",
        reads_trash: false,
    },
    CardSpec {
        entity: "core.content_item",
        table: "core_content_item",
        pk: "content_id",
        select: "content_id, deleted_at",
        reads_trash: true,
    },
    CardSpec {
        entity: "core.document",
        table: "core_document",
        pk: "document_id",
        select: "document_id, title, current_content_id, deleted_at",
        reads_trash: true,
    },
    CardSpec {
        entity: "schedule.task",
        table: "schedule_task",
        pk: "task_id",
        select: "task_id, title, status",
        reads_trash: false,
    },
    CardSpec {
        entity: "knowledge.note",
        table: "knowledge_note",
        pk: "note_id",
        select: "note_id, title",
        reads_trash: false,
    },
    CardSpec {
        entity: "core.collection",
        table: "core_collection",
        pk: "collection_id",
        select: "collection_id, name, cover_content_id",
        reads_trash: false,
    },
    CardSpec {
        entity: "social.thread",
        table: "social_thread",
        pk: "thread_id",
        select: "thread_id, subject, channel",
        reads_trash: false,
    },
    CardSpec {
        entity: "media.asset",
        table: "media_asset",
        pk: "asset_id",
        select: "asset_id, title, kind, captured_at, content_id, deleted_at",
        reads_trash: true,
    },
];

/// Entity types with a curated card: the picker's default kinds
/// (`cards.ts:85`).
#[must_use]
pub fn carded_entities() -> Vec<&'static str> {
    CARDS.iter().map(|spec| spec.entity).collect()
}

/// An UNCURATED entity, by the physical table its logical name underscores.
///
/// v0 asks the registry for the physical name and the pk; the port carries the
/// two it can actually be asked for. `tally.expense` is the live one — the
/// powerbox offers expenses as link targets and they have no card projection.
const UNCURATED: &[(&str, &str, &str)] = &[("tally.expense", "tally_expense", "expense_id")];

impl CardDoor for OwnerCards<'_> {
    fn resolve(&self, refs: &[Ref]) -> KitResult<Vec<RefCard>> {
        let asked: Vec<&Ref> = refs.iter().take(MAX_REFS).collect();
        let mut resolved: BTreeMap<Ref, RefCard> = BTreeMap::new();

        for spec in CARDS {
            let ids = ids_of(&asked, spec.entity);
            if ids.is_empty() {
                continue;
            }
            for row in read_rows(
                self.door,
                spec.entity,
                spec.table,
                spec.pk,
                spec.select,
                &ids,
            )? {
                let Some(id) = text_of(&row, spec.pk) else {
                    continue;
                };
                resolved.insert(
                    Ref::new(spec.entity, &id),
                    RefCard {
                        entity: spec.entity.to_owned(),
                        id,
                        status: if spec.reads_trash && text_of(&row, "deleted_at").is_some() {
                            CardStatus::Trashed
                        } else {
                            CardStatus::Live
                        },
                        title: None,
                        subtitle: None,
                        thumbnail_content_id: None,
                    },
                );
            }
            decorate(spec.entity, &mut resolved, self.door, &ids)?;
        }

        for (entity, table, pk) in UNCURATED {
            let ids = ids_of(&asked, entity);
            if ids.is_empty() {
                continue;
            }
            for row in read_rows(self.door, entity, table, pk, pk, &ids)? {
                if let Some(id) = text_of(&row, pk) {
                    // EXISTENCE AND STATUS ONLY, with a null title — v0's
                    // uncurated answer (`cards.ts:185`-`:194`).
                    resolved.insert(
                        Ref::new(*entity, &id),
                        RefCard::unresolved(entity, &id, CardStatus::Live),
                    );
                }
            }
        }

        Ok(asked
            .into_iter()
            .map(|reference| {
                resolved.get(reference).cloned().unwrap_or_else(|| {
                    RefCard::unresolved(
                        &reference.entity,
                        &reference.id,
                        if known(&reference.entity) {
                            // The type resolves and the row does not: a
                            // tombstone, which is a different sentence from a
                            // bad type.
                            CardStatus::Missing
                        } else {
                            CardStatus::Unknown
                        },
                    )
                })
            })
            .collect())
    }
}

fn known(entity: &str) -> bool {
    CARDS.iter().any(|spec| spec.entity == entity)
        || UNCURATED.iter().any(|(name, _, _)| *name == entity)
}

fn ids_of(refs: &[&Ref], entity: &str) -> Vec<String> {
    let mut ids: Vec<String> = refs
        .iter()
        .filter(|reference| reference.entity == entity)
        .map(|reference| reference.id.clone())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn read_rows(
    door: &dyn PageDoor,
    entity: &str,
    table: &str,
    pk: &str,
    select: &str,
    ids: &[String],
) -> KitResult<Vec<Row>> {
    let fragment = in_list(pk, ids)?;
    read_pages(
        door,
        &PageQuery::new(
            &format!("notes.cards.{entity}"),
            select,
            table,
            PageOrder::asc(pk, pk),
        )
        .filter(&fragment.sql, fragment.bind),
        JOIN_FAN_OUT,
    )
}

/// The title, subtitle and thumbnail of one entity's cards.
///
/// Split out of the read because three of the eleven need a SECOND bounded
/// read — bytes have neither a title nor a media type of their own since #996
/// R20(b), so both come from whoever owns them.
fn decorate(
    entity: &str,
    resolved: &mut BTreeMap<Ref, RefCard>,
    door: &dyn PageDoor,
    ids: &[String],
) -> KitResult<()> {
    match entity {
        "core.party" => fill(
            &CardRead {
                door,
                ids,
                entity,
                table: "core_party",
                pk: "party_id",
                select: "party_id, display_name, kind, avatar_content_id",
            },
            resolved,
            |row| {
                (
                    text_of(row, "display_name"),
                    text_of(row, "kind"),
                    text_of(row, "avatar_content_id"),
                )
            },
        ),
        "core.place" => fill(
            &CardRead {
                door,
                ids,
                entity,
                table: "core_place",
                pk: "place_id",
                select: "place_id, name, kind",
            },
            resolved,
            |row| (text_of(row, "name"), text_of(row, "kind"), None),
        ),
        "core.event" => fill(
            &CardRead {
                door,
                ids,
                entity,
                table: "core_event",
                pk: "event_id",
                select: "event_id, summary, dtstart",
            },
            resolved,
            |row| (text_of(row, "summary"), text_of(row, "dtstart"), None),
        ),
        "core.transaction" => fill(
            &CardRead {
                door,
                ids,
                entity,
                table: "core_transaction",
                pk: "txn_id",
                select: "txn_id, description, currency, amount_minor",
            },
            resolved,
            |row| {
                // v0's `printf('%s %.2f', currency, amount_minor / 100.0)`.
                let currency = text_of(row, "currency").unwrap_or_default();
                let minor = integer_or_zero(row, "amount_minor");
                #[expect(
                    clippy::cast_precision_loss,
                    reason = "v0 divides the same integer by 100.0 in SQL; the port reproduces the same double"
                )]
                let major = minor as f64 / 100.0;
                (
                    text_of(row, "description"),
                    Some(format!("{currency} {major:.2}")),
                    None,
                )
            },
        ),
        "schedule.task" => fill(
            &CardRead {
                door,
                ids,
                entity,
                table: "schedule_task",
                pk: "task_id",
                select: "task_id, title, status",
            },
            resolved,
            |row| (text_of(row, "title"), text_of(row, "status"), None),
        ),
        "knowledge.note" => fill(
            &CardRead {
                door,
                ids,
                entity,
                table: "knowledge_note",
                pk: "note_id",
                select: "note_id, title",
            },
            resolved,
            |row| (text_of(row, "title"), None, None),
        ),
        "core.collection" => fill(
            &CardRead {
                door,
                ids,
                entity,
                table: "core_collection",
                pk: "collection_id",
                select: "collection_id, name, cover_content_id",
            },
            resolved,
            |row| (text_of(row, "name"), None, text_of(row, "cover_content_id")),
        ),
        "social.thread" => fill(
            &CardRead {
                door,
                ids,
                entity,
                table: "social_thread",
                pk: "thread_id",
                select: "thread_id, subject, channel",
            },
            resolved,
            |row| {
                (
                    text_of(row, "subject").or_else(|| text_of(row, "channel")),
                    text_of(row, "channel"),
                    None,
                )
            },
        ),
        "core.document" => decorate_documents(resolved, door, ids),
        "core.content_item" => decorate_content(resolved, door, ids),
        "media.asset" => decorate_assets(resolved, door, ids),
        _ => Ok(()),
    }
}

type CardFields = (Option<String>, Option<String>, Option<String>);

/// Where one entity's card rows come from, so the eight simple decorations take
/// one parameter instead of five.
struct CardRead<'read> {
    door: &'read dyn PageDoor,
    ids: &'read [String],
    entity: &'read str,
    table: &'static str,
    pk: &'static str,
    select: &'static str,
}

fn fill(
    read: &CardRead<'_>,
    resolved: &mut BTreeMap<Ref, RefCard>,
    project: impl Fn(&Row) -> CardFields,
) -> KitResult<()> {
    for row in read_rows(
        read.door,
        read.entity,
        read.table,
        read.pk,
        read.select,
        read.ids,
    )? {
        let Some(id) = text_of(&row, read.pk) else {
            continue;
        };
        if let Some(card) = resolved.get_mut(&Ref::new(read.entity, &id)) {
            let (title, subtitle, thumbnail) = project(&row);
            card.title = title;
            card.subtitle = subtitle;
            card.thumbnail_content_id = thumbnail;
        }
    }
    Ok(())
}

/// A document's subtitle is what IT reads its bytes as, and its thumbnail is
/// those bytes when they are an image (#996 R20(b)).
fn decorate_documents(
    resolved: &mut BTreeMap<Ref, RefCard>,
    door: &dyn PageDoor,
    ids: &[String],
) -> KitResult<()> {
    let rows = read_rows(
        door,
        "core.document",
        "core_document",
        "document_id",
        "document_id, title, current_content_id, deleted_at",
        ids,
    )?;
    let content_ids: Vec<String> = rows
        .iter()
        .filter_map(|row| text_of(row, "current_content_id"))
        .collect();
    let representations = read_representations(door, &content_ids, JOIN_FAN_OUT)?;
    for row in &rows {
        let Some(id) = text_of(row, "document_id") else {
            continue;
        };
        let media_type = representations
            .by_owner
            .get(&("core.document".to_owned(), id.clone()));
        if let Some(card) = resolved.get_mut(&Ref::new("core.document", &id)) {
            card.title = text_of(row, "title");
            card.subtitle = media_type.cloned();
            card.thumbnail_content_id = media_type
                .filter(|kind| kind.starts_with("image/"))
                .and_then(|_| text_of(row, "current_content_id"));
        }
    }
    Ok(())
}

/// BYTES HAVE NO TITLE OF THEIR OWN. The card takes the owning document's, then
/// the owning asset's, then the media type — v0's three-step `coalesce`
/// (`cards.ts:56`-`:63`).
fn decorate_content(
    resolved: &mut BTreeMap<Ref, RefCard>,
    door: &dyn PageDoor,
    ids: &[String],
) -> KitResult<()> {
    let representations = read_representations(door, ids, JOIN_FAN_OUT)?;
    let fragment = in_list("current_content_id", ids)?;
    let documents = read_pages(
        door,
        &PageQuery::new(
            "notes.cards.content.document",
            "document_id, title, current_content_id",
            "core_document",
            PageOrder::asc("document_id", "document_id"),
        )
        .filter(&fragment.sql, fragment.bind),
        JOIN_FAN_OUT,
    )?;
    let asset_fragment = in_list("content_id", ids)?;
    let assets = read_pages(
        door,
        &PageQuery::new(
            "notes.cards.content.asset",
            "asset_id, title, content_id",
            "media_asset",
            PageOrder::asc("asset_id", "asset_id"),
        )
        .filter(&asset_fragment.sql, asset_fragment.bind),
        JOIN_FAN_OUT,
    )?;
    for id in ids {
        let Some(card) = resolved.get_mut(&Ref::new("core.content_item", id)) else {
            continue;
        };
        let media_type = media_type_of(&representations, id);
        let by_document = documents
            .iter()
            .find(|row| text_of(row, "current_content_id").as_deref() == Some(id.as_str()))
            .and_then(|row| text_of(row, "title"));
        let by_asset = assets
            .iter()
            .find(|row| text_of(row, "content_id").as_deref() == Some(id.as_str()))
            .and_then(|row| text_of(row, "title"));
        card.title = by_document.or(by_asset).or_else(|| media_type.clone());
        card.subtitle = media_type.clone();
        card.thumbnail_content_id = media_type
            .filter(|kind| kind.starts_with("image/"))
            .map(|_| id.clone());
    }
    Ok(())
}

/// The oldest reading of these bytes, which is the vault's own deterministic
/// answer for a surface with no owner in hand.
fn media_type_of(representations: &RepresentationIndex, content_id: &str) -> Option<String> {
    representations.by_content.get(content_id).cloned()
}

/// An asset's subtitle is its capture instant, falling back to the bytes'
/// `created_at` — v0's `coalesce(a.captured_at, ci.created_at)` over the join.
fn decorate_assets(
    resolved: &mut BTreeMap<Ref, RefCard>,
    door: &dyn PageDoor,
    ids: &[String],
) -> KitResult<()> {
    let rows = read_rows(
        door,
        "media.asset",
        "media_asset",
        "asset_id",
        "asset_id, title, kind, captured_at, content_id, deleted_at",
        ids,
    )?;
    let content_ids: Vec<String> = rows
        .iter()
        .filter_map(|row| text_of(row, "content_id"))
        .collect();
    let created: Vec<Row> = if content_ids.is_empty() {
        Vec::new()
    } else {
        let fragment = in_list("content_id", &content_ids)?;
        read_pages(
            door,
            &PageQuery::new(
                "notes.cards.asset.content",
                "content_id, created_at",
                "core_content_item",
                PageOrder::asc("content_id", "content_id"),
            )
            .filter(&fragment.sql, fragment.bind),
            JOIN_FAN_OUT,
        )?
    };
    for row in &rows {
        let Some(id) = text_of(row, "asset_id") else {
            continue;
        };
        let content_id = text_of(row, "content_id");
        let born = content_id.as_deref().and_then(|content| {
            created
                .iter()
                .find(|candidate| text_of(candidate, "content_id").as_deref() == Some(content))
                .and_then(|candidate| text_of(candidate, "created_at"))
        });
        if let Some(card) = resolved.get_mut(&Ref::new("media.asset", &id)) {
            card.title = text_of(row, "title").or_else(|| text_of(row, "kind"));
            card.subtitle = text_of(row, "captured_at").or(born);
            card.thumbnail_content_id = content_id;
        }
    }
    Ok(())
}

/// A DOOR THAT RESOLVES NOTHING. Every ref comes back `denied`.
///
/// Not a stub that reads green: `denied` is the honest answer for a caller with
/// no card door, and it is a state the shelf draws — "this link points
/// somewhere you cannot see" rather than a blank row.
pub struct NoCards;

impl CardDoor for NoCards {
    fn resolve(&self, refs: &[Ref]) -> KitResult<Vec<RefCard>> {
        Ok(refs
            .iter()
            .take(MAX_REFS)
            .map(|reference| {
                RefCard::unresolved(&reference.entity, &reference.id, CardStatus::Denied)
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_carded_entities_are_v0s_eleven_and_an_expense_is_not_one() {
        assert_eq!(carded_entities().len(), 11);
        assert!(!carded_entities().contains(&"tally.expense"));
        // …and it is still a KNOWN type, so a missing expense is a tombstone
        // rather than a bad type.
        assert!(known("tally.expense"));
        assert!(!known("locker.item"));
    }

    #[test]
    fn a_door_with_no_cards_denies_every_ref_rather_than_blanking_it() {
        let cards = NoCards
            .resolve(&[Ref::new("knowledge.note", "note-1")])
            .expect("no door refuses nothing");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].status, CardStatus::Denied);
        assert_eq!(cards[0].title, None);
    }

    #[test]
    fn a_batch_is_capped_at_v0s_hundred() {
        let refs: Vec<Ref> = (0..150)
            .map(|index| Ref::new("knowledge.note", format!("note-{index}")))
            .collect();
        assert_eq!(NoCards.resolve(&refs).expect("capped").len(), MAX_REFS);
    }
}
