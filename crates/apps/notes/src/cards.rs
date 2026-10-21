//! REFERENCE CARDS — how a note draws the far end of a link, and the near end of
//! a backlink.
//!
//! Every thing a note can link to is an `entity`, so a card is one read of
//! `entity` (kind, title, trash) plus, for the few kinds that have something
//! more to say, one read of that kind's own table. A trashed thing's card says
//! it is trashed; a thing that is not there says it is missing. Nothing here is
//! a consent decision: the phone is the vault and the owner is the one reading
//! (#1029), so every id asked for is answered.

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{JOIN_FAN_OUT, PageDoor, in_list, read_pages};
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::statement::{PageOrder, PageQuery};

/// Refs render in lists, not bulk exports (`cards.ts:35`).
pub const MAX_REFS: usize = 100;

/// What a card says about the entity it names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardStatus {
    Live,
    Trashed,
    /// Nothing has this id: a tombstone the shelf draws as one.
    Missing,
}

impl CardStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Trashed => "trashed",
            Self::Missing => "missing",
        }
    }
}

/// One renderable card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefCard {
    /// The thing's kind (`person`, `event`, ...); empty when it is missing.
    pub kind: String,
    pub id: String,
    pub status: CardStatus,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    /// The blob a surface draws as a thumbnail, when the kind has one.
    pub thumbnail: Option<String>,
}

impl RefCard {
    /// The card of an id nothing has.
    #[must_use]
    pub fn missing(id: &str) -> Self {
        Self {
            kind: String::new(),
            id: id.to_owned(),
            status: CardStatus::Missing,
            title: None,
            subtitle: None,
            thumbnail: None,
        }
    }
}

/// What a kind adds to its card: its table, the columns to read and which of
/// them are the subtitle and the thumbnail.
struct Extra {
    kind: &'static str,
    table: &'static str,
    select: &'static str,
    subtitle: &'static str,
    thumbnail: Option<&'static str>,
}

const EXTRAS: &[Extra] = &[
    Extra {
        kind: "person",
        table: "person",
        select: "id, form, avatar",
        subtitle: "form",
        thumbnail: Some("avatar"),
    },
    Extra {
        kind: "event",
        table: "event",
        select: "id, starts",
        subtitle: "starts",
        thumbnail: None,
    },
    Extra {
        kind: "task",
        table: "task",
        select: "id, status",
        subtitle: "status",
        thumbnail: None,
    },
    Extra {
        kind: "document",
        table: "document",
        select: "id, media_type",
        subtitle: "media_type",
        thumbnail: None,
    },
    Extra {
        kind: "photo",
        table: "photo",
        select: "id, form, blob",
        subtitle: "form",
        thumbnail: Some("blob"),
    },
];

fn read_by_ids(
    door: &dyn PageDoor,
    name: &str,
    table: &str,
    select: &str,
    ids: &[String],
) -> KitResult<Vec<Row>> {
    let fragment = in_list("id", ids)?;
    read_pages(
        door,
        &PageQuery::new(name, select, table, PageOrder::asc("id", "id"))
            .filter(&fragment.sql, fragment.bind),
        JOIN_FAN_OUT,
    )
}

/// Resolve up to [`MAX_REFS`] ids, one card each, keyed by id. An id nothing
/// has is a [`RefCard::missing`], never an absence: the shelf draws it.
///
/// # Errors
///
/// The kit's own refusals.
pub fn resolve(door: &dyn PageDoor, ids: &[String]) -> KitResult<BTreeMap<String, RefCard>> {
    let mut asked: Vec<String> = ids.iter().take(MAX_REFS).cloned().collect();
    asked.sort_unstable();
    asked.dedup();
    if asked.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut cards: BTreeMap<String, RefCard> = asked
        .iter()
        .map(|id| (id.clone(), RefCard::missing(id)))
        .collect();
    for row in read_by_ids(
        door,
        "notes.cards.entity",
        "entity",
        "id, kind, title, deleted_at",
        &asked,
    )? {
        let Some(id) = text_of(&row, "id") else {
            continue;
        };
        cards.insert(
            id.clone(),
            RefCard {
                kind: text_of(&row, "kind").unwrap_or_default(),
                status: if text_of(&row, "deleted_at").is_some() {
                    CardStatus::Trashed
                } else {
                    CardStatus::Live
                },
                title: text_of(&row, "title").filter(|title| !title.is_empty()),
                subtitle: None,
                thumbnail: None,
                id,
            },
        );
    }
    for extra in EXTRAS {
        let of_kind: Vec<String> = cards
            .values()
            .filter(|card| card.kind == extra.kind)
            .map(|card| card.id.clone())
            .collect();
        if of_kind.is_empty() {
            continue;
        }
        let name = format!("notes.cards.{}", extra.kind);
        for row in read_by_ids(door, &name, extra.table, extra.select, &of_kind)? {
            if let Some(card) = text_of(&row, "id").and_then(|id| cards.get_mut(&id)) {
                card.subtitle = text_of(&row, extra.subtitle);
                card.thumbnail = extra.thumbnail.and_then(|column| text_of(&row, column));
            }
        }
    }
    Ok(cards)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_card_says_so_and_carries_no_kind() {
        let card = RefCard::missing("gone");
        assert_eq!(card.status, CardStatus::Missing);
        assert!(card.kind.is_empty() && card.title.is_none());
        assert_eq!(CardStatus::Missing.as_str(), "missing");
    }

    #[test]
    fn every_extra_selects_its_subtitle_and_thumbnail_columns() {
        for extra in EXTRAS {
            assert!(extra.select.contains(extra.subtitle), "{}", extra.kind);
            if let Some(thumbnail) = extra.thumbnail {
                assert!(extra.select.contains(thumbnail), "{}", extra.kind);
            }
        }
    }
}
