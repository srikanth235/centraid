//! FREE UP SPACE, RUN (#1080 A19, A20). Rust asks the core what is safe to free
//! and tells it what went; the shell only deletes, behind the platform's own
//! confirmation (`LibraryDelete` -> `LibraryDeleted`). The row's sentences are
//! made from the [`wire::FreeUpFacts`] this assembles
//! (`keep_originals::FreeUpRow`).
//!
//! ```text
//!   count:  census + releasable(LIMIT)                      (off the lock) -> facts
//!   free:   releasable(LIMIT) -> LibraryDelete(items with an os_ref) -> LibraryDeleted
//!           -> released(only the hashes the platform said went) -> count, with the outcome
//! ```
//!
//! A census lists the whole content store, so every core call here runs on a
//! worker thread ([`Ctx::off_thread`]), bound to the vault in front when it was
//! asked. A phone whose platform cannot delete behind a confirmation
//! (`Environment.library_deletes` false) is offered nothing and asks nothing.

use centraid_api_proto::core_v1 as wire;
use centraid_core::Handle;
use prost::Message;
use wire::free_up_facts::Outcome;

use crate::screen::Ctx;

/// One tap frees at most this many originals, oldest first; the next tap frees
/// more.
pub const LIMIT: u64 = 1_000;

/// The off-thread tag of a count (its answer is an encoded [`wire::FreeUpFacts`]).
const COUNT: &str = "photos.free-up.count";
/// The off-thread tag of the list a tap frees from (an encoded
/// [`wire::ReleasableResponse`], or nothing when the core could not say).
const LIST: &str = "photos.free-up.list";

/// What the last free-up came to, said on the next count.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Last {
    pub outcome: Outcome,
    pub freed_bytes: u64,
    pub platform_error: String,
}

impl Last {
    fn of(outcome: Outcome) -> Self {
        Self {
            outcome,
            ..Self::default()
        }
    }
}

/// What a job that belongs to the flow came back with.
pub enum Answered {
    /// A count: the row's facts.
    Counted(wire::FreeUpFacts),
    /// The list a tap frees from, or `None` when the core could not say.
    Listed(Option<Vec<wire::Releasable>>),
}

/// Read an `OffThreadDone`; `None` when it is not the flow's.
#[must_use]
pub fn answered(done: &wire::OffThreadDone) -> Option<Answered> {
    match done.tag.as_str() {
        COUNT => Some(Answered::Counted(
            wire::FreeUpFacts::decode(done.bytes.as_slice()).unwrap_or_default(),
        )),
        LIST => Some(Answered::Listed(
            (!done.bytes.is_empty())
                .then(|| wire::ReleasableResponse::decode(done.bytes.as_slice()).ok())
                .flatten()
                .map(|list| list.items),
        )),
        _ => None,
    }
}

/// Count the row, saying `last` on it. A platform that cannot delete is answered
/// at once (no row); otherwise the count runs off the lock and comes back as
/// [`Answered::Counted`].
#[must_use]
pub fn count(ctx: &Ctx, last: Last) -> Option<wire::FreeUpFacts> {
    if !ctx.library_deletes() {
        return Some(wire::FreeUpFacts::default());
    }
    let bound = bound(ctx);
    ctx.off_thread(COUNT, move |front| {
        facts(bound.as_ref().unwrap_or(front), &last).encode_to_vec()
    });
    None
}

/// Ask for the list a tap frees from, off the lock ([`Answered::Listed`]).
pub fn list(ctx: &Ctx) {
    let bound = bound(ctx);
    ctx.off_thread(LIST, move |front| {
        releasable(bound.as_ref().unwrap_or(front))
            .map(|list| list.encode_to_vec())
            .unwrap_or_default()
    });
}

/// What a tap does with the list: the items the platform can delete by (an
/// `os_ref`), or the outcome to count with when there is nothing to delete.
///
/// # Errors
/// The outcome when nothing is handed to the platform.
pub fn deletable(listed: Option<Vec<wire::Releasable>>) -> Result<Vec<wire::Releasable>, Last> {
    let Some(items) = listed else {
        return Err(Last::of(Outcome::NotChecked));
    };
    let items: Vec<wire::Releasable> = items
        .into_iter()
        .filter(|item| !item.os_ref.is_empty())
        .collect();
    if items.is_empty() {
        return Err(Last::of(Outcome::NothingRemoved));
    }
    Ok(items)
}

/// The effect that asks the platform to delete `items` behind its own
/// confirmation.
#[must_use]
pub fn delete_effect(items: &[wire::Releasable]) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::LibraryDelete(wire::LibraryDelete {
            items: items
                .iter()
                .map(|item| wire::LibraryDeleteItem {
                    os_ref: item.os_ref.clone(),
                    content_hash: hex(&item.content_hash),
                    media_type: item.media_type.clone(),
                    size: item.size,
                })
                .collect(),
        })),
    }
}

/// The platform's answer, against what it was asked to delete: the items whose
/// asset went (ONLY those the platform named, by hash), and the outcome when
/// none did. A refusal of the effect is the platform's error, a dismissed
/// confirmation nothing removed.
#[must_use]
pub fn gone(
    items: &[wire::Releasable],
    answer: &wire::effect_result::Outcome,
) -> (Vec<wire::Releasable>, Last) {
    use wire::effect_result::Outcome as O;
    let deleted = match answer {
        O::LibraryDeleted(deleted) => deleted,
        O::Failed(failed) if failed.cancelled => {
            return (Vec::new(), Last::of(Outcome::NothingRemoved));
        }
        O::Failed(failed) => {
            return (
                Vec::new(),
                Last {
                    outcome: Outcome::PlatformError,
                    freed_bytes: 0,
                    platform_error: failed.reason.clone(),
                },
            );
        }
        _ => return (Vec::new(), Last::of(Outcome::NothingRemoved)),
    };
    let freed: Vec<wire::Releasable> = items
        .iter()
        .filter(|item| {
            let hash = hex(&item.content_hash);
            deleted.deleted_hashes.iter().any(|gone| gone == &hash)
        })
        .cloned()
        .collect();
    let last = if !freed.is_empty() {
        Last {
            outcome: Outcome::Freed,
            freed_bytes: freed.iter().map(|item| item.size).sum(),
            platform_error: String::new(),
        }
    } else if !deleted.error.is_empty() {
        Last {
            outcome: Outcome::PlatformError,
            freed_bytes: 0,
            platform_error: deleted.error.clone(),
        }
    } else {
        Last::of(Outcome::NothingRemoved)
    };
    (freed, last)
}

/// Tell the core what went, then count again saying so. Nothing freed is a count
/// with `last` as it stands.
#[must_use]
pub fn released(ctx: &Ctx, freed: Vec<wire::Releasable>, last: Last) -> Option<wire::FreeUpFacts> {
    if freed.is_empty() {
        return count(ctx, last);
    }
    let bound = bound(ctx);
    ctx.off_thread(COUNT, move |front| {
        let handle = bound.as_ref().unwrap_or(front);
        let request = wire::Request {
            kind: Some(wire::request::Kind::Released(wire::ReleasedRequest {
                content_hash: freed.into_iter().map(|item| item.content_hash).collect(),
            })),
        };
        let recorded = matches!(
            handle
                .call(&request)
                .ok()
                .and_then(|response| response.kind),
            Some(wire::response::Kind::Released(_))
        );
        let last = if recorded {
            last
        } else {
            Last::of(Outcome::NotRecorded)
        };
        facts(handle, &last).encode_to_vec()
    });
    None
}

/// The row's facts, from the core's census and its list of what is safe.
fn facts(handle: &Handle, last: &Last) -> wire::FreeUpFacts {
    let census = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Originals(wire::OriginalsRequest {
                op: Some(wire::originals_request::Op::Census(
                    wire::OriginalsCensusRead {},
                )),
            })),
        })
        .ok()
        .and_then(|response| match response.kind {
            Some(wire::response::Kind::Originals(originals)) => originals.census,
            _ => None,
        });
    let list = releasable(handle);
    let items = list.map(|list| list.items);
    let on_phone = census.as_ref().and_then(|found| found.on_phone);
    let kept = census.as_ref().and_then(|found| found.kept);
    wire::FreeUpFacts {
        offered: true,
        counted: census.is_some(),
        on_phone_count: on_phone
            .map_or(0, |totals| u32::try_from(totals.count).unwrap_or(u32::MAX)),
        on_phone_bytes: on_phone.map_or(0, |totals| totals.bytes),
        kept_count: kept.map_or(0, |totals| u32::try_from(totals.count).unwrap_or(u32::MAX)),
        checked: items.is_some(),
        releasable_count: items
            .as_ref()
            .map_or(0, |items| u32::try_from(items.len()).unwrap_or(u32::MAX)),
        releasable_bytes: items
            .as_ref()
            .map_or(0, |items| items.iter().map(|item| item.size).sum()),
        outcome: last.outcome as i32,
        freed_bytes: last.freed_bytes,
        platform_error: last.platform_error.clone(),
    }
}

fn releasable(handle: &Handle) -> Option<wire::ReleasableResponse> {
    let response = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Releasable(wire::ReleasableRequest {
                limit: LIMIT,
            })),
        })
        .ok()?;
    match response.kind {
        Some(wire::response::Kind::Releasable(list)) => Some(list),
        _ => None,
    }
}

/// The core of the vault in front when asked, so a count started on one vault
/// is that vault's; a core that holds one vault is its own.
fn bound(ctx: &Ctx) -> Option<Handle> {
    ctx.vaults().and_then(|vaults| vaults.foreground_core())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(byte: u8, os_ref: &str, size: u64) -> wire::Releasable {
        wire::Releasable {
            content_hash: vec![byte; 32],
            os_ref: os_ref.to_owned(),
            size,
            media_type: "image/heic".to_owned(),
        }
    }

    #[test]
    fn a_tap_hands_the_platform_only_items_it_can_delete_by() {
        assert_eq!(deletable(None), Err(Last::of(Outcome::NotChecked)));
        assert_eq!(
            deletable(Some(vec![item(1, "", 5)])),
            Err(Last::of(Outcome::NothingRemoved))
        );
        let items = deletable(Some(vec![item(1, "", 5), item(2, "asset-2", 7)])).expect("one");
        assert_eq!(items, vec![item(2, "asset-2", 7)]);
        let Some(wire::effect::Kind::LibraryDelete(asked)) = delete_effect(&items).kind else {
            panic!("a delete");
        };
        assert_eq!(asked.items.len(), 1);
        assert_eq!(asked.items[0].os_ref, "asset-2");
        assert_eq!(asked.items[0].content_hash, "02".repeat(32));
        assert_eq!(asked.items[0].size, 7);
    }

    #[test]
    fn only_what_the_platform_says_went_is_released_and_counted() {
        use wire::effect_result::Outcome as O;
        let items = vec![item(1, "a", 3), item(2, "b", 4)];
        let (freed, last) = gone(
            &items,
            &O::LibraryDeleted(wire::LibraryDeleted {
                deleted_hashes: vec!["02".repeat(32), "ff".repeat(32)],
                declined: false,
                error: String::new(),
            }),
        );
        assert_eq!(freed, vec![item(2, "b", 4)]);
        assert_eq!((last.outcome, last.freed_bytes), (Outcome::Freed, 4));
        let (freed, last) = gone(
            &items,
            &O::LibraryDeleted(wire::LibraryDeleted {
                deleted_hashes: Vec::new(),
                declined: true,
                error: String::new(),
            }),
        );
        assert!(freed.is_empty());
        assert_eq!(last.outcome, Outcome::NothingRemoved);
        let (_, last) = gone(
            &items,
            &O::LibraryDeleted(wire::LibraryDeleted {
                deleted_hashes: Vec::new(),
                declined: false,
                error: "Photos access is limited.".to_owned(),
            }),
        );
        assert_eq!(last.outcome, Outcome::PlatformError);
        assert_eq!(last.platform_error, "Photos access is limited.");
        let (_, last) = gone(
            &items,
            &O::Failed(wire::EffectFailed {
                reason: String::new(),
                denied: false,
                cancelled: true,
            }),
        );
        assert_eq!(last.outcome, Outcome::NothingRemoved);
    }
}
