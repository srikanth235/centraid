//! WHERE A DOCUMENT CAME FROM (#903, #929; paged since #996 wave 4, R8).
//!
//! Split out of the share fold on the v0 side when the reads became paged
//! walks, and split here for the same reason: **the shares half and this one
//! are two independent denials over two independent planes**, and folding them
//! into one `Reading` would make a document whose sender this vault cannot name
//! look like a document whose audience it cannot see.
//!
//! ## It is NOT bounded by the caller's window, and that is the point
//!
//! This is what DISCOVERS rows. A delivered copy carries no folders-scheme tag
//! of its own, so the drive's tag window cannot see it — which is why the
//! subscription read takes a **page of its own, sized by the caller**, and
//! everything after it joins over what that page returned.
//!
//! ## SHAPE-KEYED, NOT ROW-KEYED
//!
//! A document arrives because a SHAPE placed it, so the subscription this vault
//! holds is what names the sender and the moment. `share_subscription` has no
//! foreign key to `share_authority` on purpose — the audience never holds the
//! origin's answer — so the lineage is the only join back to a document id.
//!
//! ## Its denial is survivable at BOTH levels
//!
//! The whole read answers [`Reading::Denied`] — "we cannot see", never "nothing
//! arrived". [`read_sender_names`] answers empty maps, because **a lost NAME is
//! not a lost ARRIVAL**: an unnamed sender still belongs on the shelf.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::reads::{PageDoor, in_list, read_pages};
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::shares::{DOCUMENT_TARGET_TYPE, SHARE_FAN_OUT};
use crate::{Denial, Reading};

/// ONE INBOUND PLACEMENT: which vault delivered a document, and when.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedFromEntry {
    pub vault_id: String,
    /// `None` is "cannot say who", never "nobody": no live binding names them.
    pub party_id: Option<String>,
    pub name: Option<String>,
    /// Landed here — the subscription's own instant, as text.
    ///
    /// **Text and not epoch milliseconds.** v0 carries `Date.parse(…) || 0`,
    /// which turns an unparseable instant into the Unix epoch and therefore
    /// into "arrived in 1970" on the shelf. A port that reproduced the `0`
    /// would reproduce the wrong sentence; the absence is modelled instead, and
    /// the divergence is a finding in this lane's receipt.
    pub at: Option<String>,
}

/// `docs.origins.subscriptions` — THE DISCOVERY READ, and it is a PAGE.
///
/// Its keyset's second axis is `authority_id`: `share_subscription` is keyed on
/// `(authority_id, audience_vault_id)`, and in this vault's own copy the
/// audience is always this vault — so the grant is what separates two rows that
/// arrived in the same instant.
pub fn subscriptions_statement() -> PageQuery {
    PageQuery::new(
        "docs.origins.subscriptions",
        "authority_id, origin_vault_id, subscribed_at",
        "share_subscription",
        PageOrder::desc("subscribed_at", "authority_id"),
    )
    .filter(
        "state = ?",
        vec![PageBindValue::Text("subscribed".to_owned())],
    )
}

/// `docs.origins.lineage` — which documents a subscription placed.
///
/// Bounded by the subscriptions just read; `target_id` is the keyset's second
/// axis because the lineage's key is `(authority_id, target_type, target_id)`
/// and the type is pinned here.
pub fn lineage_statement(authority_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("authority_id", authority_ids)?;
    let mut bind = vec![PageBindValue::Text(DOCUMENT_TARGET_TYPE.to_owned())];
    bind.extend(fragment.bind);
    Ok(PageQuery::new(
        "docs.origins.lineage",
        "authority_id, target_type, target_id",
        "share_subscription_lineage",
        PageOrder::asc("authority_id", "target_id"),
    )
    .filter(&format!("target_type = ? AND {}", fragment.sql), bind))
}

/// `docs.origins.bindings` — whose vault delivered this.
///
/// A REVOKED BINDING NO LONGER SAYS WHOSE VAULT THAT IS.
pub fn origin_bindings_statement(vault_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("vault_id", vault_ids)?;
    Ok(PageQuery::new(
        "docs.origins.bindings",
        "binding_id, party_id, vault_id",
        "share_party_vault_binding",
        PageOrder::asc("binding_id", "binding_id"),
    )
    .filter(
        &format!("{} AND revoked_at IS NULL", fragment.sql),
        fragment.bind,
    ))
}

/// `docs.origins.parties` — the sender's name, when this vault holds one.
pub fn origin_parties_statement(party_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("party_id", party_ids)?;
    Ok(PageQuery::new(
        "docs.origins.parties",
        "party_id, display_name",
        "core_party",
        PageOrder::asc("party_id", "party_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// The two maps a sender's name needs. Empty where the read refused: **a lost
/// name is not a lost arrival.**
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SenderNames {
    pub party_by_vault: BTreeMap<String, String>,
    pub name_by_party: BTreeMap<String, String>,
}

/// Resolve the senders' names, surviving its own denial.
pub fn read_sender_names(door: &dyn PageDoor, vault_ids: &[String]) -> SenderNames {
    if vault_ids.is_empty() {
        return SenderNames::default();
    }
    let Ok(statement) = origin_bindings_statement(vault_ids) else {
        return SenderNames::default();
    };
    let Ok(bindings) = read_pages(door, &statement, SHARE_FAN_OUT) else {
        return SenderNames::default();
    };
    let party_by_vault: BTreeMap<String, String> = bindings
        .iter()
        .filter_map(|row| Some((text_of(row, "vault_id")?, text_of(row, "party_id")?)))
        .collect();
    let party_ids: Vec<String> = party_by_vault
        .values()
        .cloned()
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    if party_ids.is_empty() {
        return SenderNames {
            party_by_vault,
            name_by_party: BTreeMap::new(),
        };
    }
    let Ok(statement) = origin_parties_statement(&party_ids) else {
        return SenderNames {
            party_by_vault,
            name_by_party: BTreeMap::new(),
        };
    };
    let Ok(parties) = read_pages(door, &statement, SHARE_FAN_OUT) else {
        return SenderNames {
            party_by_vault,
            name_by_party: BTreeMap::new(),
        };
    };
    let name_by_party = parties
        .iter()
        .filter_map(|row| {
            let party_id = text_of(row, "party_id")?;
            // A BLANK NAME IS NOT A NAME: v0 trims and drops the empty result,
            // so a party row whose display name is whitespace reads as unnamed
            // rather than as a document from "  ".
            let name = text_of(row, "display_name")?;
            let name = name.trim();
            (!name.is_empty()).then(|| (party_id, name.to_owned()))
        })
        .collect();
    SenderNames {
        party_by_vault,
        name_by_party,
    }
}

/// The whole read: `document_id -> ` the placement that brought it here.
pub fn read_origins_by_document(
    door: &dyn PageDoor,
    limit: usize,
) -> KitResult<Reading<BTreeMap<String, SharedFromEntry>>> {
    let subscriptions = match door.page(&subscriptions_statement(), &PageRequest::first(limit)) {
        Ok(page) => page.rows,
        Err(KitError::Door(message)) => {
            return Ok(Reading::Denied(Denial {
                code: None,
                message: Some(message),
                revoked_at: None,
            }));
        }
        Err(other) => return Err(other),
    };
    if subscriptions.is_empty() {
        return Ok(Reading::Data(BTreeMap::new()));
    }
    let authority_ids: Vec<String> = subscriptions
        .iter()
        .filter_map(|row| text_of(row, "authority_id"))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    if authority_ids.is_empty() {
        return Ok(Reading::Data(BTreeMap::new()));
    }
    let lineage = match read_pages(door, &lineage_statement(&authority_ids)?, SHARE_FAN_OUT) {
        Ok(rows) => rows,
        Err(KitError::Door(message)) => {
            return Ok(Reading::Denied(Denial {
                code: None,
                message: Some(message),
                revoked_at: None,
            }));
        }
        Err(other) => return Err(other),
    };
    if lineage.is_empty() {
        return Ok(Reading::Data(BTreeMap::new()));
    }
    let origin_vault_ids: Vec<String> = subscriptions
        .iter()
        .filter_map(|row| text_of(row, "origin_vault_id"))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let senders = read_sender_names(door, &origin_vault_ids);
    Ok(Reading::Data(fold_origins(
        &subscriptions,
        &lineage,
        &senders,
    )))
}

/// THE PURE FOLD: subscriptions × lineage × senders, keyed by document.
#[must_use]
pub fn fold_origins(
    subscriptions: &[Row],
    lineage: &[Row],
    senders: &SenderNames,
) -> BTreeMap<String, SharedFromEntry> {
    let by_grant: BTreeMap<String, (String, Option<String>)> = subscriptions
        .iter()
        .filter_map(|row| {
            Some((
                text_of(row, "authority_id")?,
                (
                    text_of(row, "origin_vault_id")?,
                    text_of(row, "subscribed_at"),
                ),
            ))
        })
        .collect();
    lineage
        .iter()
        .filter_map(|row| {
            let authority_id = text_of(row, "authority_id")?;
            let target_id = text_of(row, "target_id")?;
            let (origin_vault_id, subscribed_at) = by_grant.get(&authority_id)?.clone();
            let party_id = senders.party_by_vault.get(&origin_vault_id).cloned();
            let name = party_id
                .as_ref()
                .and_then(|party_id| senders.name_by_party.get(party_id))
                .cloned();
            Some((
                target_id,
                SharedFromEntry {
                    vault_id: origin_vault_id,
                    party_id,
                    name,
                    at: subscribed_at,
                },
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::row::Cell;

    fn row(pairs: &[(&str, &str)]) -> Row {
        let mut row = Row::new();
        for (column, value) in pairs {
            row.insert((*column).to_owned(), Cell::Text((*value).to_owned()));
        }
        row
    }

    /// A LOST NAME IS NOT A LOST ARRIVAL. The placement still lands on the
    /// shelf with `party_id: None` — which is "cannot say who", never "nobody".
    #[test]
    fn an_unnamed_sender_still_places_the_document() {
        let folded = fold_origins(
            &[row(&[
                ("authority_id", "g1"),
                ("origin_vault_id", "v-far-away"),
                ("subscribed_at", "2099-06-01T09:00:00.000Z"),
            ])],
            &[row(&[
                ("authority_id", "g1"),
                ("target_type", DOCUMENT_TARGET_TYPE),
                ("target_id", "d1"),
            ])],
            &SenderNames::default(),
        );
        let entry = folded.get("d1").expect("the document arrived");
        assert_eq!(entry.vault_id, "v-far-away");
        assert_eq!(entry.party_id, None);
        assert_eq!(entry.name, None);
        assert_eq!(entry.at.as_deref(), Some("2099-06-01T09:00:00.000Z"));
    }

    /// A named sender, end to end through both maps.
    #[test]
    fn a_bound_vault_names_its_sender() {
        let senders = SenderNames {
            party_by_vault: [("v2".to_owned(), "p2".to_owned())].into_iter().collect(),
            name_by_party: [("p2".to_owned(), "Ana".to_owned())].into_iter().collect(),
        };
        let folded = fold_origins(
            &[row(&[
                ("authority_id", "g1"),
                ("origin_vault_id", "v2"),
                ("subscribed_at", "2099-06-01T09:00:00.000Z"),
            ])],
            &[
                row(&[("authority_id", "g1"), ("target_id", "d1")]),
                row(&[("authority_id", "g1"), ("target_id", "d2")]),
            ],
            &senders,
        );
        assert_eq!(folded.len(), 2, "one shape can place several documents");
        assert_eq!(folded["d1"].name.as_deref(), Some("Ana"));
        assert_eq!(folded["d2"].party_id.as_deref(), Some("p2"));
    }

    /// A LINEAGE ROW WHOSE SUBSCRIPTION IS NOT IN THE PAGE IS SKIPPED, not
    /// invented: the discovery read is a window, and a placement outside it is
    /// a placement this answer does not carry.
    #[test]
    fn a_lineage_row_with_no_subscription_in_the_page_is_dropped() {
        let folded = fold_origins(
            &[row(&[
                ("authority_id", "g1"),
                ("origin_vault_id", "v2"),
                ("subscribed_at", "2099-06-01T09:00:00.000Z"),
            ])],
            &[
                row(&[("authority_id", "g1"), ("target_id", "d1")]),
                row(&[("authority_id", "g-outside-the-page"), ("target_id", "d9")]),
            ],
            &SenderNames::default(),
        );
        assert!(folded.contains_key("d1"));
        assert!(!folded.contains_key("d9"));
    }

    /// AN UNPARSEABLE OR ABSENT INSTANT IS ABSENT, not 1970.
    ///
    /// v0's `Date.parse(subscription.subscribed_at ?? "") || 0` yields `0` for
    /// both, and `0` renders as "arrived on 1 January 1970" on the shelf. The
    /// column is `NOT NULL`, so this is a defence rather than a live bug — and
    /// it is a finding in the receipt rather than a silent divergence.
    #[test]
    fn an_absent_arrival_instant_is_absent_and_not_the_epoch() {
        let mut undated = row(&[("authority_id", "g1"), ("origin_vault_id", "v2")]);
        undated.insert("subscribed_at".to_owned(), Cell::Null);
        let folded = fold_origins(
            &[undated],
            &[row(&[("authority_id", "g1"), ("target_id", "d1")])],
            &SenderNames::default(),
        );
        assert_eq!(folded["d1"].at, None);
    }

    /// The discovery read is NEWEST-FIRST over a `NOT NULL` sort column, so the
    /// page is continuable and its window is the caller's.
    #[test]
    fn the_discovery_read_is_a_newest_first_page_over_its_own_key() {
        let statement = subscriptions_statement();
        assert!(statement.order.descending);
        assert_eq!(statement.order.sort_column, "subscribed_at");
        assert_eq!(
            statement.order.pk_column, "authority_id",
            "the grant separates two rows that arrived in the same instant"
        );
        assert_eq!(
            statement.r#where.as_deref(),
            Some("state = ?"),
            "a removed subscription is not an arrival"
        );
    }

    /// A blank display name reads as unnamed rather than as a sender called
    /// "  ".
    #[test]
    fn a_blank_display_name_is_no_name() {
        let senders = SenderNames {
            party_by_vault: [("v2".to_owned(), "p2".to_owned())].into_iter().collect(),
            name_by_party: BTreeMap::new(),
        };
        let folded = fold_origins(
            &[row(&[
                ("authority_id", "g1"),
                ("origin_vault_id", "v2"),
                ("subscribed_at", "2099-06-01T09:00:00.000Z"),
            ])],
            &[row(&[("authority_id", "g1"), ("target_id", "d1")])],
            &senders,
        );
        assert_eq!(folded["d1"].party_id.as_deref(), Some("p2"));
        assert_eq!(folded["d1"].name, None);
    }
}
